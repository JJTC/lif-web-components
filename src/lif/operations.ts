/**
 * Pure editing operations: every operation takes a document and
 * returns a new document via structuredClone, leaving the input untouched.
 * Operations address elements by their file-wide unique IDs.
 *
 * Operations throw on programmer errors (unknown IDs, duplicate IDs); they do
 * not validate domain rules — run `validateLif` on the result for diagnostics.
 */

import type {
  Layout,
  Lif,
  LifEdge,
  LifNode,
  MetaInformation,
  Station,
  VehicleTypeEdgeProperty,
  VehicleTypeNodeProperty,
} from "./types";
import { LIF_VERSION } from "./parse";

export interface NodeLookup {
  layout: Layout;
  node: LifNode;
}

export interface EdgeLookup {
  layout: Layout;
  edge: LifEdge;
}

export interface StationLookup {
  layout: Layout;
  station: Station;
}

export function findLayout(lif: Lif, layoutId: string): Layout | undefined {
  return lif.layouts.find((l) => l.layoutId === layoutId);
}

export function findNode(lif: Lif, nodeId: string): NodeLookup | undefined {
  for (const layout of lif.layouts) {
    const node = layout.nodes.find((n) => n.nodeId === nodeId);
    if (node) return { layout, node };
  }
  return undefined;
}

export function findEdge(lif: Lif, edgeId: string): EdgeLookup | undefined {
  for (const layout of lif.layouts) {
    const edge = layout.edges.find((e) => e.edgeId === edgeId);
    if (edge) return { layout, edge };
  }
  return undefined;
}

export function findStation(lif: Lif, stationId: string): StationLookup | undefined {
  for (const layout of lif.layouts) {
    const station = layout.stations.find((s) => s.stationId === stationId);
    if (station) return { layout, station };
  }
  return undefined;
}

function clone(lif: Lif): Lif {
  return structuredClone(lif);
}

function mustFindLayout(lif: Lif, layoutId: string): Layout {
  const layout = findLayout(lif, layoutId);
  if (!layout) throw new Error(`layout "${layoutId}" not found`);
  return layout;
}

/* ------------------------------- create ------------------------------- */

export function createEmptyLif(
  projectIdentification = "New project",
  creator = "lif-web-components",
  now: Date = new Date(),
): Lif {
  return {
    metaInformation: {
      projectIdentification,
      creator,
      exportTimestamp: now.toISOString(),
      lifVersion: LIF_VERSION,
    },
    layouts: [
      {
        layoutId: "layout-1",
        layoutName: "Layout 1",
        layoutVersion: "1",
        nodes: [],
        edges: [],
        stations: [],
      },
    ],
  };
}

/* ------------------------------- meta --------------------------------- */

export function updateMetaInformation(lif: Lif, patch: Partial<MetaInformation>): Lif {
  const next = clone(lif);
  Object.assign(next.metaInformation, patch);
  return next;
}

/** Set exportTimestamp (call before exporting a modified document). */
export function touchExportTimestamp(lif: Lif, now: Date = new Date()): Lif {
  return updateMetaInformation(lif, { exportTimestamp: now.toISOString() });
}

/* ------------------------------ layouts ------------------------------- */

export function addLayout(lif: Lif, layout: Layout): Lif {
  if (findLayout(lif, layout.layoutId)) {
    throw new Error(`layout "${layout.layoutId}" already exists`);
  }
  const next = clone(lif);
  next.layouts.push(structuredClone(layout));
  return next;
}

/** Removes a layout. Edges/stations of other layouts referencing its nodes are left for the validator to flag. */
export function removeLayout(lif: Lif, layoutId: string): Lif {
  mustFindLayout(lif, layoutId);
  const next = clone(lif);
  next.layouts = next.layouts.filter((l) => l.layoutId !== layoutId);
  return next;
}

/** Shallow-merge layout metadata (not its element collections or id). */
export function updateLayout(
  lif: Lif,
  layoutId: string,
  patch: Partial<Pick<Layout, "layoutName" | "layoutVersion" | "layoutLevelId" | "layoutDescription">>,
): Lif {
  mustFindLayout(lif, layoutId);
  const next = clone(lif);
  Object.assign(mustFindLayout(next, layoutId), structuredClone(patch));
  return next;
}

/** Rename a layout (nothing in LIF references layouts by id, so only the id changes). */
export function renameLayout(lif: Lif, layoutId: string, newLayoutId: string): Lif {
  mustFindLayout(lif, layoutId);
  if (layoutId === newLayoutId) return clone(lif);
  if (findLayout(lif, newLayoutId)) throw new Error(`layout "${newLayoutId}" already exists`);
  const next = clone(lif);
  mustFindLayout(next, layoutId).layoutId = newLayoutId;
  return next;
}

export interface GridGeneratorOptions {
  /** Number of columns (x direction). */
  xCount: number;
  /** Number of rows (y direction). */
  yCount: number;
  /** Node spacing in metres (applies to both directions). */
  spacing: number;
  /** World position of the first node (lower-left corner of the grid). */
  startX: number;
  startY: number;
  /** Prefix for generated nodeIds/edgeIds. */
  idPrefix: string;
  mapId?: string;
  /** Vehicle type written into the generated properties. */
  vehicleTypeId: string;
  /** Edges between neighbours: none, one direction, or both directions. */
  connect: "NONE" | "SINGLE" | "DOUBLE";
  /** Extra defaults merged into every generated edge property (e.g. a vehicle profile's maxSpeed). */
  edgeDefaults?: Partial<Omit<VehicleTypeEdgeProperty, "vehicleTypeId">>;
}

/**
 * Bulk-generate a rectangular grid of nodes (row-major, ids `${prefix}1…`) and
 * optionally connect horizontal/vertical neighbours with edges
 * (`${prefix}e1…`). Throws if any generated id already exists.
 */
export function generateNodeGrid(lif: Lif, layoutId: string, opts: GridGeneratorOptions): Lif {
  mustFindLayout(lif, layoutId);
  if (!Number.isInteger(opts.xCount) || !Number.isInteger(opts.yCount) || opts.xCount < 1 || opts.yCount < 1) {
    throw new Error("xCount and yCount must be positive integers");
  }
  if (!(opts.spacing > 0)) throw new Error("spacing must be > 0");

  const nodes: LifNode[] = [];
  const nodeIdAt = (col: number, row: number) => `${opts.idPrefix}${row * opts.xCount + col + 1}`;
  for (let row = 0; row < opts.yCount; row++) {
    for (let col = 0; col < opts.xCount; col++) {
      nodes.push({
        nodeId: nodeIdAt(col, row),
        ...(opts.mapId !== undefined ? { mapId: opts.mapId } : {}),
        nodePosition: {
          x: opts.startX + col * opts.spacing,
          y: opts.startY + row * opts.spacing,
        },
        vehicleTypeNodeProperties: [{ vehicleTypeId: opts.vehicleTypeId }],
      });
    }
  }

  const edges: LifEdge[] = [];
  let edgeCounter = 0;
  const addPair = (fromId: string, toId: string) => {
    const directions = opts.connect === "DOUBLE" ? [[fromId, toId], [toId, fromId]] : [[fromId, toId]];
    for (const [a, b] of directions) {
      edges.push({
        edgeId: `${opts.idPrefix}e${++edgeCounter}`,
        startNodeId: a!,
        endNodeId: b!,
        vehicleTypeEdgeProperties: [
          {
            vehicleTypeId: opts.vehicleTypeId,
            rotationAllowed: false,
            ...structuredClone(opts.edgeDefaults ?? {}),
          },
        ],
      });
    }
  };
  if (opts.connect !== "NONE") {
    for (let row = 0; row < opts.yCount; row++) {
      for (let col = 0; col < opts.xCount; col++) {
        if (col + 1 < opts.xCount) addPair(nodeIdAt(col, row), nodeIdAt(col + 1, row));
        if (row + 1 < opts.yCount) addPair(nodeIdAt(col, row), nodeIdAt(col, row + 1));
      }
    }
  }

  for (const n of nodes) {
    if (findNode(lif, n.nodeId)) throw new Error(`generated nodeId "${n.nodeId}" already exists; choose another prefix`);
  }
  for (const e of edges) {
    if (findEdge(lif, e.edgeId)) throw new Error(`generated edgeId "${e.edgeId}" already exists; choose another prefix`);
  }

  const next = clone(lif);
  const layout = mustFindLayout(next, layoutId);
  layout.nodes.push(...nodes);
  layout.edges.push(...edges);
  return next;
}

/* ------------------------------- nodes -------------------------------- */

export function addNode(lif: Lif, layoutId: string, node: LifNode): Lif {
  mustFindLayout(lif, layoutId);
  if (findNode(lif, node.nodeId)) {
    throw new Error(`node "${node.nodeId}" already exists`);
  }
  const next = clone(lif);
  mustFindLayout(next, layoutId).nodes.push(structuredClone(node));
  return next;
}

/** Shallow-merge a patch onto a node (nodeId itself cannot be patched; use renameNode). */
export function updateNode(lif: Lif, nodeId: string, patch: Partial<Omit<LifNode, "nodeId">>): Lif {
  if (!findNode(lif, nodeId)) throw new Error(`node "${nodeId}" not found`);
  const next = clone(lif);
  Object.assign(findNode(next, nodeId)!.node, structuredClone(patch));
  return next;
}

export function moveNode(lif: Lif, nodeId: string, x: number, y: number): Lif {
  if (!findNode(lif, nodeId)) throw new Error(`node "${nodeId}" not found`);
  const next = clone(lif);
  const { node } = findNode(next, nodeId)!;
  node.nodePosition.x = x;
  node.nodePosition.y = y;
  return next;
}

/**
 * Remove a node and everything that references it: edges (in any layout)
 * using it as start or end node, its entries in station interactionNodeIds,
 * and stations left without any interaction node.
 */
export function removeNode(lif: Lif, nodeId: string): Lif {
  if (!findNode(lif, nodeId)) throw new Error(`node "${nodeId}" not found`);
  const next = clone(lif);
  for (const layout of next.layouts) {
    layout.nodes = layout.nodes.filter((n) => n.nodeId !== nodeId);
    layout.edges = layout.edges.filter(
      (e) => e.startNodeId !== nodeId && e.endNodeId !== nodeId,
    );
    // Prune only stations this removal emptied (see removeElements).
    layout.stations = layout.stations.filter((station) => {
      if (!station.interactionNodeIds.includes(nodeId)) return true;
      station.interactionNodeIds = station.interactionNodeIds.filter((id) => id !== nodeId);
      return station.interactionNodeIds.length > 0;
    });
  }
  return next;
}

/** Replace a node wholesale (the replacement must keep the same nodeId). */
export function replaceNode(lif: Lif, nodeId: string, node: LifNode): Lif {
  const found = findNode(lif, nodeId);
  if (!found) throw new Error(`node "${nodeId}" not found`);
  if (node.nodeId !== nodeId) {
    throw new Error(`replacement nodeId "${node.nodeId}" differs from "${nodeId}"; rename explicitly instead`);
  }
  const next = clone(lif);
  const layout = next.layouts.find((l) => l.layoutId === found.layout.layoutId)!;
  layout.nodes[layout.nodes.findIndex((n) => n.nodeId === nodeId)] = structuredClone(node);
  return next;
}

/** Rename a node, updating all edge and station references across the file. */
export function renameNode(lif: Lif, nodeId: string, newNodeId: string): Lif {
  if (!findNode(lif, nodeId)) throw new Error(`node "${nodeId}" not found`);
  if (nodeId === newNodeId) return clone(lif);
  if (findNode(lif, newNodeId)) throw new Error(`node "${newNodeId}" already exists`);
  const next = clone(lif);
  for (const layout of next.layouts) {
    for (const node of layout.nodes) {
      if (node.nodeId === nodeId) node.nodeId = newNodeId;
    }
    for (const edge of layout.edges) {
      if (edge.startNodeId === nodeId) edge.startNodeId = newNodeId;
      if (edge.endNodeId === nodeId) edge.endNodeId = newNodeId;
    }
    for (const station of layout.stations) {
      station.interactionNodeIds = station.interactionNodeIds.map((id) =>
        id === nodeId ? newNodeId : id,
      );
    }
  }
  return next;
}

/* ------------------------------- edges -------------------------------- */

export function addEdge(lif: Lif, layoutId: string, edge: LifEdge): Lif {
  mustFindLayout(lif, layoutId);
  if (findEdge(lif, edge.edgeId)) {
    throw new Error(`edge "${edge.edgeId}" already exists`);
  }
  const next = clone(lif);
  mustFindLayout(next, layoutId).edges.push(structuredClone(edge));
  return next;
}

export function updateEdge(lif: Lif, edgeId: string, patch: Partial<Omit<LifEdge, "edgeId">>): Lif {
  if (!findEdge(lif, edgeId)) throw new Error(`edge "${edgeId}" not found`);
  const next = clone(lif);
  Object.assign(findEdge(next, edgeId)!.edge, structuredClone(patch));
  return next;
}

/** Rename an edge (nothing references edges, so only the id changes). */
export function renameEdge(lif: Lif, edgeId: string, newEdgeId: string): Lif {
  if (!findEdge(lif, edgeId)) throw new Error(`edge "${edgeId}" not found`);
  if (edgeId === newEdgeId) return clone(lif);
  if (findEdge(lif, newEdgeId)) throw new Error(`edge "${newEdgeId}" already exists`);
  const next = clone(lif);
  findEdge(next, edgeId)!.edge.edgeId = newEdgeId;
  return next;
}

/** Replace an edge wholesale (the replacement must keep the same edgeId). */
export function replaceEdge(lif: Lif, edgeId: string, edge: LifEdge): Lif {
  const found = findEdge(lif, edgeId);
  if (!found) throw new Error(`edge "${edgeId}" not found`);
  if (edge.edgeId !== edgeId) {
    throw new Error(`replacement edgeId "${edge.edgeId}" differs from "${edgeId}"; rename explicitly instead`);
  }
  const next = clone(lif);
  const layout = next.layouts.find((l) => l.layoutId === found.layout.layoutId)!;
  layout.edges[layout.edges.findIndex((e) => e.edgeId === edgeId)] = structuredClone(edge);
  return next;
}

export function removeEdge(lif: Lif, edgeId: string): Lif {
  if (!findEdge(lif, edgeId)) throw new Error(`edge "${edgeId}" not found`);
  const next = clone(lif);
  for (const layout of next.layouts) {
    layout.edges = layout.edges.filter((e) => e.edgeId !== edgeId);
  }
  return next;
}

/* ------------------------------ stations ------------------------------ */

export function addStation(lif: Lif, layoutId: string, station: Station): Lif {
  mustFindLayout(lif, layoutId);
  if (findStation(lif, station.stationId)) {
    throw new Error(`station "${station.stationId}" already exists`);
  }
  const next = clone(lif);
  mustFindLayout(next, layoutId).stations.push(structuredClone(station));
  return next;
}

export function updateStation(
  lif: Lif,
  stationId: string,
  patch: Partial<Omit<Station, "stationId">>,
): Lif {
  if (!findStation(lif, stationId)) throw new Error(`station "${stationId}" not found`);
  const next = clone(lif);
  Object.assign(findStation(next, stationId)!.station, structuredClone(patch));
  return next;
}

/** Rename a station (nothing references stations, so only the id changes). */
export function renameStation(lif: Lif, stationId: string, newStationId: string): Lif {
  if (!findStation(lif, stationId)) throw new Error(`station "${stationId}" not found`);
  if (stationId === newStationId) return clone(lif);
  if (findStation(lif, newStationId)) throw new Error(`station "${newStationId}" already exists`);
  const next = clone(lif);
  findStation(next, stationId)!.station.stationId = newStationId;
  return next;
}

/** Replace a station wholesale (the replacement must keep the same stationId). */
export function replaceStation(lif: Lif, stationId: string, station: Station): Lif {
  const found = findStation(lif, stationId);
  if (!found) throw new Error(`station "${stationId}" not found`);
  if (station.stationId !== stationId) {
    throw new Error(`replacement stationId "${station.stationId}" differs from "${stationId}"; rename explicitly instead`);
  }
  const next = clone(lif);
  const layout = next.layouts.find((l) => l.layoutId === found.layout.layoutId)!;
  layout.stations[layout.stations.findIndex((s) => s.stationId === stationId)] =
    structuredClone(station);
  return next;
}

export function removeStation(lif: Lif, stationId: string): Lif {
  if (!findStation(lif, stationId)) throw new Error(`station "${stationId}" not found`);
  const next = clone(lif);
  for (const layout of next.layouts) {
    layout.stations = layout.stations.filter((s) => s.stationId !== stationId);
  }
  return next;
}

/* -------------------------- bulk operations ---------------------------- */
/* Marquee-selection sized edits: one operation, one undo step. */

export interface ElementIdSelection {
  nodeIds?: string[];
  edgeIds?: string[];
  stationIds?: string[];
}

function mustFindAll(lif: Lif, selection: ElementIdSelection): void {
  // One sweep builds the id indexes; per-id findNode/findEdge scans would be
  // O(selection × document) on facility-scale bulk edits.
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const stations = new Set<string>();
  for (const layout of lif.layouts) {
    for (const n of layout.nodes) nodes.add(n.nodeId);
    for (const e of layout.edges) edges.add(e.edgeId);
    for (const s of layout.stations) stations.add(s.stationId);
  }
  for (const id of selection.nodeIds ?? []) {
    if (!nodes.has(id)) throw new Error(`node "${id}" not found`);
  }
  for (const id of selection.edgeIds ?? []) {
    if (!edges.has(id)) throw new Error(`edge "${id}" not found`);
  }
  for (const id of selection.stationIds ?? []) {
    if (!stations.has(id)) throw new Error(`station "${id}" not found`);
  }
}

/** Add a property entry for the type to the listed elements that lack one. */
export function addVehicleTypeToElements(
  lif: Lif,
  selection: ElementIdSelection,
  vehicleTypeId: string,
  defaults?: {
    node?: Omit<VehicleTypeNodeProperty, "vehicleTypeId">;
    edge?: Omit<VehicleTypeEdgeProperty, "vehicleTypeId">;
  },
): Lif {
  if (!vehicleTypeId) throw new Error("vehicle type id must not be empty");
  mustFindAll(lif, selection);
  const next = clone(lif);
  const nodeIds = new Set(selection.nodeIds ?? []);
  const edgeIds = new Set(selection.edgeIds ?? []);
  for (const layout of next.layouts) {
    for (const n of layout.nodes) {
      if (!nodeIds.has(n.nodeId)) continue;
      if (!n.vehicleTypeNodeProperties.some((p) => p.vehicleTypeId === vehicleTypeId)) {
        n.vehicleTypeNodeProperties.push({ ...structuredClone(defaults?.node), vehicleTypeId });
      }
    }
    for (const e of layout.edges) {
      if (!edgeIds.has(e.edgeId)) continue;
      if (!e.vehicleTypeEdgeProperties.some((p) => p.vehicleTypeId === vehicleTypeId)) {
        e.vehicleTypeEdgeProperties.push({
          rotationAllowed: false,
          ...structuredClone(defaults?.edge),
          vehicleTypeId,
        });
      }
    }
  }
  return next;
}

/** Remove the type's property entries from the listed elements. */
export function removeVehicleTypeFromElements(
  lif: Lif,
  selection: ElementIdSelection,
  vehicleTypeId: string,
): Lif {
  mustFindAll(lif, selection);
  const next = clone(lif);
  const nodeIds = new Set(selection.nodeIds ?? []);
  const edgeIds = new Set(selection.edgeIds ?? []);
  for (const layout of next.layouts) {
    for (const n of layout.nodes) {
      if (!nodeIds.has(n.nodeId)) continue;
      n.vehicleTypeNodeProperties = n.vehicleTypeNodeProperties.filter(
        (p) => p.vehicleTypeId !== vehicleTypeId,
      );
    }
    for (const e of layout.edges) {
      if (!edgeIds.has(e.edgeId)) continue;
      e.vehicleTypeEdgeProperties = e.vehicleTypeEdgeProperties.filter(
        (p) => p.vehicleTypeId !== vehicleTypeId,
      );
    }
  }
  return next;
}

/**
 * Merge a property patch into the type's entry on each listed edge. Edges
 * without an entry for the type are left untouched (use
 * `addVehicleTypeToElements` first to create entries).
 */
export function updateEdgePropertiesBulk(
  lif: Lif,
  edgeIds: string[],
  vehicleTypeId: string,
  patch: Partial<Omit<VehicleTypeEdgeProperty, "vehicleTypeId">>,
): Lif {
  mustFindAll(lif, { edgeIds });
  const next = clone(lif);
  const ids = new Set(edgeIds);
  for (const layout of next.layouts) {
    for (const e of layout.edges) {
      if (!ids.has(e.edgeId)) continue;
      const prop = e.vehicleTypeEdgeProperties.find((p) => p.vehicleTypeId === vehicleTypeId);
      if (!prop) continue;
      for (const [key, value] of Object.entries(patch)) {
        // Clone per edge: object-valued patch fields (trajectory, actions, …)
        // must not be shared between the caller and the patched entries.
        if (value !== undefined) {
          (prop as unknown as Record<string, unknown>)[key] = structuredClone(value);
        }
      }
    }
  }
  return next;
}

/**
 * Remove the listed elements in one step, with removeNode's cascade: edges
 * touching a removed node go too, and stations lose the removed interaction
 * nodes (a station left with none is removed).
 */
export function removeElements(lif: Lif, selection: ElementIdSelection): Lif {
  mustFindAll(lif, selection);
  const next = clone(lif);
  const nodeIds = new Set(selection.nodeIds ?? []);
  const edgeIds = new Set(selection.edgeIds ?? []);
  const stationIds = new Set(selection.stationIds ?? []);
  for (const layout of next.layouts) {
    layout.nodes = layout.nodes.filter((n) => !nodeIds.has(n.nodeId));
    layout.edges = layout.edges.filter(
      (e) => !edgeIds.has(e.edgeId) && !nodeIds.has(e.startNodeId) && !nodeIds.has(e.endNodeId),
    );
    layout.stations = layout.stations.filter((s) => !stationIds.has(s.stationId));
    // Prune only stations the cascade itself emptied — a station that was
    // already empty (invalid, but the validator's business) is not touched.
    layout.stations = layout.stations.filter((station) => {
      const hadRemoved = station.interactionNodeIds.some((id) => nodeIds.has(id));
      if (!hadRemoved) return true;
      station.interactionNodeIds = station.interactionNodeIds.filter((id) => !nodeIds.has(id));
      return station.interactionNodeIds.length > 0;
    });
  }
  return next;
}

/* ---------------------------- vehicle types ---------------------------- */
/* LIF has no global vehicle-type registry: types exist only as ids inside
 * per-element property arrays, so the roster is derived and every type
 * operation sweeps the whole document. */

/** Derived roster: every vehicleTypeId referenced by any node or edge, sorted. */
export function listVehicleTypes(lif: Lif): string[] {
  const ids = new Set<string>();
  for (const layout of lif.layouts) {
    for (const n of layout.nodes) for (const p of n.vehicleTypeNodeProperties) ids.add(p.vehicleTypeId);
    for (const e of layout.edges) for (const p of e.vehicleTypeEdgeProperties) ids.add(p.vehicleTypeId);
  }
  return [...ids].sort();
}

export interface VehicleTypeCoverage {
  vehicleTypeId: string;
  /** Nodes/edges carrying a property entry for this type, document-wide. */
  nodesWithType: number;
  edgesWithType: number;
  totalNodes: number;
  totalEdges: number;
}

/** Document-wide usage counts per derived vehicle type. */
export function vehicleTypeCoverage(lif: Lif): VehicleTypeCoverage[] {
  let totalNodes = 0;
  let totalEdges = 0;
  const nodes = new Map<string, number>();
  const edges = new Map<string, number>();
  for (const layout of lif.layouts) {
    totalNodes += layout.nodes.length;
    totalEdges += layout.edges.length;
    for (const n of layout.nodes)
      for (const p of n.vehicleTypeNodeProperties)
        nodes.set(p.vehicleTypeId, (nodes.get(p.vehicleTypeId) ?? 0) + 1);
    for (const e of layout.edges)
      for (const p of e.vehicleTypeEdgeProperties)
        edges.set(p.vehicleTypeId, (edges.get(p.vehicleTypeId) ?? 0) + 1);
  }
  return listVehicleTypes(lif).map((vehicleTypeId) => ({
    vehicleTypeId,
    nodesWithType: nodes.get(vehicleTypeId) ?? 0,
    edgesWithType: edges.get(vehicleTypeId) ?? 0,
    totalNodes,
    totalEdges,
  }));
}

/** Rename a vehicle type in every node/edge property entry across the document. */
export function renameVehicleType(lif: Lif, vehicleTypeId: string, newVehicleTypeId: string): Lif {
  if (!newVehicleTypeId) throw new Error("new vehicle type id must not be empty");
  const existing = listVehicleTypes(lif);
  if (!existing.includes(vehicleTypeId)) {
    throw new Error(`vehicle type "${vehicleTypeId}" not found`);
  }
  if (newVehicleTypeId !== vehicleTypeId && existing.includes(newVehicleTypeId)) {
    throw new Error(`vehicle type "${newVehicleTypeId}" already exists`);
  }
  const next = clone(lif);
  for (const layout of next.layouts) {
    for (const n of layout.nodes)
      for (const p of n.vehicleTypeNodeProperties)
        if (p.vehicleTypeId === vehicleTypeId) p.vehicleTypeId = newVehicleTypeId;
    for (const e of layout.edges)
      for (const p of e.vehicleTypeEdgeProperties)
        if (p.vehicleTypeId === vehicleTypeId) p.vehicleTypeId = newVehicleTypeId;
  }
  return next;
}

/**
 * Remove a vehicle type's property entries from every node/edge. May leave
 * empty property arrays — run `validateLif` on the result, as always.
 */
export function removeVehicleType(lif: Lif, vehicleTypeId: string): Lif {
  if (!listVehicleTypes(lif).includes(vehicleTypeId)) {
    throw new Error(`vehicle type "${vehicleTypeId}" not found`);
  }
  const next = clone(lif);
  for (const layout of next.layouts) {
    for (const n of layout.nodes)
      n.vehicleTypeNodeProperties = n.vehicleTypeNodeProperties.filter(
        (p) => p.vehicleTypeId !== vehicleTypeId,
      );
    for (const e of layout.edges)
      e.vehicleTypeEdgeProperties = e.vehicleTypeEdgeProperties.filter(
        (p) => p.vehicleTypeId !== vehicleTypeId,
      );
  }
  return next;
}

/**
 * Add a property entry for the type to every node and edge that lacks one
 * (existing entries are kept untouched) — "make the whole network usable by
 * this type". Also how a brand-new type enters a document.
 */
export function addVehicleTypeEverywhere(
  lif: Lif,
  vehicleTypeId: string,
  defaults?: {
    node?: Omit<VehicleTypeNodeProperty, "vehicleTypeId">;
    edge?: Omit<VehicleTypeEdgeProperty, "vehicleTypeId">;
  },
): Lif {
  if (!vehicleTypeId) throw new Error("vehicle type id must not be empty");
  const next = clone(lif);
  for (const layout of next.layouts) {
    for (const n of layout.nodes) {
      if (!n.vehicleTypeNodeProperties.some((p) => p.vehicleTypeId === vehicleTypeId)) {
        n.vehicleTypeNodeProperties.push({ ...structuredClone(defaults?.node), vehicleTypeId });
      }
    }
    for (const e of layout.edges) {
      if (!e.vehicleTypeEdgeProperties.some((p) => p.vehicleTypeId === vehicleTypeId)) {
        e.vehicleTypeEdgeProperties.push({
          rotationAllowed: false,
          ...structuredClone(defaults?.edge),
          vehicleTypeId,
        });
      }
    }
  }
  return next;
}
