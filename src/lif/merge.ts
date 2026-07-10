/**
 * Multi-document operations for the master-control workspace:
 * a facility receives one LIF per vehicle integrator, each in its own
 * coordinate frame with its own id conventions. Aligning is a rigid-body
 * transform (LIF is always metres — no scaling), collisions are resolved by
 * prefixing, and merging unions layouts by id while recording provenance.
 *
 * All operations are pure: input documents are never mutated.
 */

import type { Lif, Trajectory } from "./types";

/** Rigid-body transform: rotate about the origin, then translate. */
export interface LifTransform {
  /** Radians, counter-clockwise positive. */
  rotateRad?: number;
  dx?: number;
  dy?: number;
}

/** Wrap into [-π, π]. */
function normalizeAngle(a: number): number {
  const wrapped = ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return wrapped;
}

/**
 * Transform every position and absolute orientation in the document:
 * node/station positions, node θ, station θ, trajectory control points, and
 * edge `vehicleOrientation` only when its orientationType is GLOBAL
 * (TANGENTIAL orientations are path-relative and rotate with the geometry).
 */
export function transformLif(lif: Lif, transform: LifTransform): Lif {
  const rot = transform.rotateRad ?? 0;
  const dx = transform.dx ?? 0;
  const dy = transform.dy ?? 0;
  const next = structuredClone(lif);
  if (rot === 0 && dx === 0 && dy === 0) return next;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const movePoint = (p: { x: number; y: number }): void => {
    const { x, y } = p;
    p.x = x * cos - y * sin + dx;
    p.y = x * sin + y * cos + dy;
  };
  const moveTrajectory = (t: Trajectory | undefined): void => {
    for (const cp of t?.controlPoints ?? []) movePoint(cp);
  };
  for (const layout of next.layouts) {
    for (const n of layout.nodes) {
      movePoint(n.nodePosition);
      for (const p of n.vehicleTypeNodeProperties) {
        if (p.theta !== undefined) p.theta = normalizeAngle(p.theta + rot);
      }
    }
    for (const s of layout.stations) {
      if (s.stationPosition) {
        movePoint(s.stationPosition);
        if (s.stationPosition.theta !== undefined) {
          s.stationPosition.theta = normalizeAngle(s.stationPosition.theta + rot);
        }
      }
    }
    for (const e of layout.edges) {
      for (const p of e.vehicleTypeEdgeProperties) {
        moveTrajectory(p.trajectory);
        if (p.vehicleOrientation !== undefined && p.orientationType === "GLOBAL") {
          p.vehicleOrientation = normalizeAngle(p.vehicleOrientation + rot);
        }
      }
    }
  }
  return next;
}

/**
 * Prefix every element id (layouts, nodes, edges, stations) and every
 * internal reference (edge endpoints, station interaction nodes). Vehicle
 * type ids are deliberately untouched: they are shared vocabulary across
 * integrators, reconciled via the types manager instead.
 */
export function prefixLifIds(lif: Lif, prefix: string): Lif {
  const next = structuredClone(lif);
  for (const layout of next.layouts) {
    layout.layoutId = prefix + layout.layoutId;
    for (const n of layout.nodes) n.nodeId = prefix + n.nodeId;
    for (const e of layout.edges) {
      e.edgeId = prefix + e.edgeId;
      e.startNodeId = prefix + e.startNodeId;
      e.endNodeId = prefix + e.endNodeId;
    }
    for (const s of layout.stations) {
      s.stationId = prefix + s.stationId;
      s.interactionNodeIds = s.interactionNodeIds.map((id) => prefix + id);
    }
  }
  return next;
}

export interface IdCollisions {
  layouts: string[];
  nodes: string[];
  edges: string[];
  stations: string[];
}

/** Ids present in both documents, per element kind (sorted). */
export function collectIdCollisions(a: Lif, b: Lif): IdCollisions {
  const gather = (lif: Lif) => {
    const layouts = new Set<string>();
    const nodes = new Set<string>();
    const edges = new Set<string>();
    const stations = new Set<string>();
    for (const layout of lif.layouts) {
      layouts.add(layout.layoutId);
      for (const n of layout.nodes) nodes.add(n.nodeId);
      for (const e of layout.edges) edges.add(e.edgeId);
      for (const s of layout.stations) stations.add(s.stationId);
    }
    return { layouts, nodes, edges, stations };
  };
  const idsA = gather(a);
  const idsB = gather(b);
  const intersect = (x: Set<string>, y: Set<string>) => [...x].filter((id) => y.has(id)).sort();
  return {
    layouts: intersect(idsA.layouts, idsB.layouts),
    nodes: intersect(idsA.nodes, idsB.nodes),
    edges: intersect(idsA.edges, idsB.edges),
    stations: intersect(idsA.stations, idsB.stations),
  };
}

/** Provenance entry appended to `metaInformation["x-mergedSources"]`. */
export interface MergeProvenance {
  projectIdentification?: string;
  creator?: string;
  exportTimestamp?: string;
  /**
   * Layouts whose elements were unioned into an existing base layout — the
   * base keeps its own layoutVersion/layoutName, so the source's values are
   * recorded here instead of being silently dropped.
   */
  unionedLayouts?: Array<{
    layoutId: string;
    layoutVersion?: string;
    layoutName?: string;
  }>;
}

/**
 * Merge `source` into `base`: same-id layouts union their elements (that is
 * how two integrators' descriptions of the same level combine — rename a
 * layout to the target id first), other layouts are appended. Colliding
 * element ids are a caller-level conflict and throw — resolve with
 * `prefixLifIds` (see `collectIdCollisions`). The merged document records
 * where it came from in the vendor-extension field
 * `metaInformation["x-mergedSources"]` (unknown fields round-trip losslessly
 * per; delete it via the meta editor if undesired).
 */
export function mergeLif(base: Lif, source: Lif): Lif {
  // Duplicate layout ids inside one source are invalid input and would make
  // the union below collapse them into each other — refuse loudly.
  const sourceLayoutIds = new Set<string>();
  for (const layout of source.layouts) {
    if (sourceLayoutIds.has(layout.layoutId)) {
      throw new Error(`source contains duplicate layout id "${layout.layoutId}"`);
    }
    sourceLayoutIds.add(layout.layoutId);
  }
  const collisions = collectIdCollisions(base, source);
  const conflicts = [
    ...collisions.nodes.map((id) => `node "${id}"`),
    ...collisions.edges.map((id) => `edge "${id}"`),
    ...collisions.stations.map((id) => `station "${id}"`),
  ];
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).join(", ");
    throw new Error(
      `cannot merge: ${conflicts.length} id collision${conflicts.length === 1 ? "" : "s"} ` +
        `(${shown}${conflicts.length > 5 ? ", …" : ""}) — prefix one document first`,
    );
  }
  const next = structuredClone(base);
  const unionedLayouts: NonNullable<MergeProvenance["unionedLayouts"]> = [];
  for (const layout of source.layouts) {
    const existing = next.layouts.find((l) => l.layoutId === layout.layoutId);
    if (existing) {
      existing.nodes.push(...structuredClone(layout.nodes));
      existing.edges.push(...structuredClone(layout.edges));
      existing.stations.push(...structuredClone(layout.stations));
      const record: (typeof unionedLayouts)[number] = { layoutId: layout.layoutId };
      if (layout.layoutVersion !== undefined) record.layoutVersion = layout.layoutVersion;
      if (layout.layoutName !== undefined) record.layoutName = layout.layoutName;
      unionedLayouts.push(record);
    } else {
      next.layouts.push(structuredClone(layout));
    }
  }
  const meta = next.metaInformation as unknown as Record<string, unknown>;
  const provenance: MergeProvenance[] = Array.isArray(meta["x-mergedSources"])
    ? (meta["x-mergedSources"] as MergeProvenance[])
    : [];
  const entry: MergeProvenance = {};
  if (unionedLayouts.length > 0) entry.unionedLayouts = unionedLayouts;
  if (source.metaInformation.projectIdentification !== undefined) {
    entry.projectIdentification = source.metaInformation.projectIdentification;
  }
  if (source.metaInformation.creator !== undefined) entry.creator = source.metaInformation.creator;
  if (source.metaInformation.exportTimestamp !== undefined) {
    entry.exportTimestamp = source.metaInformation.exportTimestamp;
  }
  meta["x-mergedSources"] = [...provenance, entry];
  return next;
}
