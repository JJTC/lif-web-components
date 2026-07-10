/**
 * Semantic validation of a parsed LIF document.
 * Structural/type problems are the parser's job; this module checks the
 * rules that require looking across the document.
 */

import { DiagnosticCollector, type Diagnostic } from "./diagnostics";
import {
  combineRotationDirections,
  getDegree,
  getRotationAtEndNodeAllowed,
  getRotationAtStartNodeAllowed,
  getWeight,
  type Layout,
  type LifAction,
  type Lif,
  type LifEdge,
  type LifNode,
  type RotationDirection,
  type Trajectory,
} from "./types";

const PI = Math.PI;
/** Tolerance (metres) for trajectory endpoints vs node positions. */
const ENDPOINT_TOLERANCE = 1e-3;
/** Tolerance for angle range checks, so exactly ±π (with float noise) passes. */
const ANGLE_EPS = 1e-9;
/** ISO 8601 UTC, e.g. 2017-04-15T11:40:03.12Z (guideline 8.3.2). */
const ISO8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Semantic version [Major].[Minor].[Patch] (guideline 8.3.2). */
const SEMVER = /^\d+\.\d+\.\d+$/;

interface NodeRef {
  layoutIndex: number;
  layout: Layout;
  node: LifNode;
}

export function validateLif(lif: Lif): Diagnostic[] {
  const c = new DiagnosticCollector();

  // Meta-information formats (guideline 8.3.2). Non-conformance is a warning:
  // the field is present and a string, just not in the recommended shape.
  const meta = lif.metaInformation;
  if (typeof meta?.exportTimestamp === "string" && !ISO8601_UTC.test(meta.exportTimestamp)) {
    c.warning("LIF-V030", `exportTimestamp "${meta.exportTimestamp}" is not ISO 8601 UTC (YYYY-MM-DDTHH:mm:ss.ssZ)`, "metaInformation.exportTimestamp");
  }
  if (typeof meta?.lifVersion === "string" && !SEMVER.test(meta.lifVersion)) {
    c.warning("LIF-V031", `lifVersion "${meta.lifVersion}" is not semantic version [Major].[Minor].[Patch]`, "metaInformation.lifVersion");
  }

  const nodeById = new Map<string, NodeRef>();
  const layoutIds = new Map<string, number>();
  const nodeIds = new Map<string, string>(); // id -> first path
  const edgeIds = new Map<string, string>();
  const stationIds = new Map<string, string>();

  // Pass 1: uniqueness + node index.
  lif.layouts.forEach((layout, li) => {
    const lPath = `layouts[${li}]`;
    if (layoutIds.has(layout.layoutId)) {
      c.error("LIF-V001", `duplicate layoutId "${layout.layoutId}" (also layouts[${layoutIds.get(layout.layoutId)}])`, `${lPath}.layoutId`);
    } else {
      layoutIds.set(layout.layoutId, li);
    }

    layout.nodes.forEach((node, ni) => {
      const nPath = `${lPath}.nodes[${ni}]`;
      const seen = nodeIds.get(node.nodeId);
      if (seen !== undefined) {
        c.error("LIF-V002", `duplicate nodeId "${node.nodeId}" (also ${seen}); nodeIds must be unique across all layouts`, `${nPath}.nodeId`);
      } else {
        nodeIds.set(node.nodeId, nPath);
        nodeById.set(node.nodeId, { layoutIndex: li, layout, node });
      }
    });

    layout.edges.forEach((edge, ei) => {
      const ePath = `${lPath}.edges[${ei}]`;
      const seen = edgeIds.get(edge.edgeId);
      if (seen !== undefined) {
        c.error("LIF-V003", `duplicate edgeId "${edge.edgeId}" (also ${seen}); edgeIds must be unique across all layouts`, `${ePath}.edgeId`);
      } else {
        edgeIds.set(edge.edgeId, ePath);
      }
    });

    layout.stations.forEach((station, si) => {
      const sPath = `${lPath}.stations[${si}]`;
      const seen = stationIds.get(station.stationId);
      if (seen !== undefined) {
        c.error("LIF-V004", `duplicate stationId "${station.stationId}" (also ${seen}); stationIds must be unique across all layouts`, `${sPath}.stationId`);
      } else {
        stationIds.set(station.stationId, sPath);
      }
    });
  });

  // Pass 2: per-element rules.
  lif.layouts.forEach((layout, li) => {
    const lPath = `layouts[${li}]`;

    if (layout.nodes.length === 0) {
      c.warning("LIF-V022", `layout "${layout.layoutId}" has no nodes`, `${lPath}.nodes`);
    }

    layout.nodes.forEach((node, ni) => {
      const nPath = `${lPath}.nodes[${ni}]`;
      if (node.vehicleTypeNodeProperties.length === 0) {
        c.error("LIF-V008", "vehicleTypeNodeProperties must not be empty (one element per allowed vehicle type)", `${nPath}.vehicleTypeNodeProperties`);
      }
      checkVehicleTypeUniqueness(c, node.vehicleTypeNodeProperties, `${nPath}.vehicleTypeNodeProperties`);
      node.vehicleTypeNodeProperties.forEach((p, pi) => {
        const pPath = `${nPath}.vehicleTypeNodeProperties[${pi}]`;
        if (p.theta !== undefined) checkAngleRange(c, p.theta, `${pPath}.theta`);
        checkActions(c, p.actions, pPath);
      });
    });

    layout.edges.forEach((edge, ei) => {
      const ePath = `${lPath}.edges[${ei}]`;

      const start = nodeById.get(edge.startNodeId);
      if (!start) {
        c.error("LIF-V005", `startNodeId "${edge.startNodeId}" does not exist`, `${ePath}.startNodeId`);
      } else if (start.layoutIndex !== li) {
        c.error("LIF-V005", `startNodeId "${edge.startNodeId}" is in layout "${start.layout.layoutId}"; the start node must be part of the edge's own layout (guideline 8.3.8)`, `${ePath}.startNodeId`);
      }

      const end = nodeById.get(edge.endNodeId);
      if (!end) {
        c.error("LIF-V006", `endNodeId "${edge.endNodeId}" does not exist in any layout`, `${ePath}.endNodeId`);
      } else if (end.layoutIndex !== li) {
        c.info("LIF-V007", `edge "${edge.edgeId}" transitions to layout "${end.layout.layoutId}" (allowed; verify this is intentional)`, `${ePath}.endNodeId`);
      }

      if (edge.startNodeId === edge.endNodeId) {
        // Zero-length rotation edges use two distinct overlapping nodes
        // (guideline example 10.9), never a self-loop.
        c.info("LIF-V029", `edge "${edge.edgeId}" starts and ends at the same node "${edge.startNodeId}"`, `${ePath}.endNodeId`);
      }

      if (edge.vehicleTypeEdgeProperties.length === 0) {
        c.error("LIF-V009", "vehicleTypeEdgeProperties must not be empty (one element per allowed vehicle type)", `${ePath}.vehicleTypeEdgeProperties`);
      }
      checkVehicleTypeUniqueness(c, edge.vehicleTypeEdgeProperties, `${ePath}.vehicleTypeEdgeProperties`);

      edge.vehicleTypeEdgeProperties.forEach((p, pi) => {
        const pPath = `${ePath}.vehicleTypeEdgeProperties[${pi}]`;
        if (p.vehicleOrientation !== undefined) checkAngleRange(c, p.vehicleOrientation, `${pPath}.vehicleOrientation`);
        if (p.maxSpeed !== undefined && p.maxSpeed <= 0) {
          c.warning("LIF-V027", `maxSpeed ${p.maxSpeed} is not a positive speed`, `${pPath}.maxSpeed`);
        }
        if (p.maxRotationSpeed !== undefined && p.maxRotationSpeed <= 0) {
          c.warning("LIF-V027", `maxRotationSpeed ${p.maxRotationSpeed} is not a positive speed`, `${pPath}.maxRotationSpeed`);
        }
        if (p.minHeight !== undefined && p.maxHeight !== undefined && p.minHeight > p.maxHeight) {
          c.warning("LIF-V028", `minHeight ${p.minHeight} exceeds maxHeight ${p.maxHeight}`, pPath);
        }
        if (p.loadRestriction?.loadSetNames !== undefined && p.loadRestriction.loaded === false) {
          c.warning("LIF-V019", "loadSetNames is only evaluated when 'loaded' is true", `${pPath}.loadRestriction.loadSetNames`);
        }
        checkActions(c, p.actions, pPath);
        if (p.trajectory) {
          checkTrajectory(c, p.trajectory, `${pPath}.trajectory`, start?.node, end?.node);
        }
      });
    });

    layout.stations.forEach((station, si) => {
      const sPath = `${lPath}.stations[${si}]`;
      if (station.interactionNodeIds.length === 0) {
        c.error("LIF-V011", "interactionNodeIds must contain at least one nodeId", `${sPath}.interactionNodeIds`);
      }
      station.interactionNodeIds.forEach((id, ii) => {
        const ref = nodeById.get(id);
        if (!ref) {
          c.error("LIF-V012", `interaction node "${id}" does not exist`, `${sPath}.interactionNodeIds[${ii}]`);
        } else if (ref.layoutIndex !== li) {
          c.warning("LIF-V013", `interaction node "${id}" is in layout "${ref.layout.layoutId}", not in the station's layout`, `${sPath}.interactionNodeIds[${ii}]`);
        }
      });
      if (station.stationHeight !== undefined && station.stationHeight < 0) {
        c.error("LIF-V026", `stationHeight must be ≥ 0 (got ${station.stationHeight})`, `${sPath}.stationHeight`);
      }
      if (station.stationPosition?.theta !== undefined) {
        checkAngleRange(c, station.stationPosition.theta, `${sPath}.stationPosition.theta`);
      }
    });
  });

  checkRotationContradictions(c, lif);
  return c.diagnostics;
}

interface RotationHalf {
  edgeId: string;
  edgeIndex: number;
  layoutIndex: number;
  direction: RotationDirection;
}

/**
 * Rotation combination at shared nodes (guideline 8.3.9.1): where one edge
 * terminates and another originates at the same node for the same vehicle
 * type, rotationAtEndNodeAllowed and rotationAtStartNodeAllowed combine as a
 * boolean AND. When two individually-rotatable edges combine to NONE (the
 * CW-vs-CCW misalignment), the node may be unnavigable — "which may or may
 * not be intentional", so this is info level. One diagnostic per
 * (node, vehicle type); intentional NONE on either side is not flagged.
 */
function checkRotationContradictions(c: DiagnosticCollector, lif: Lif): void {
  // node id → vehicle type → incoming / outgoing rotation permissions.
  const incoming = new Map<string, Map<string, RotationHalf[]>>();
  const outgoing = new Map<string, Map<string, RotationHalf[]>>();
  const record = (
    store: Map<string, Map<string, RotationHalf[]>>,
    nodeId: string,
    vehicleTypeId: string,
    half: RotationHalf,
  ): void => {
    let byType = store.get(nodeId);
    if (!byType) store.set(nodeId, (byType = new Map()));
    const list = byType.get(vehicleTypeId);
    if (list) list.push(half);
    else byType.set(vehicleTypeId, [half]);
  };

  lif.layouts.forEach((layout, li) => {
    layout.edges.forEach((edge: LifEdge, ei) => {
      for (const p of edge.vehicleTypeEdgeProperties) {
        record(incoming, edge.endNodeId, p.vehicleTypeId, {
          edgeId: edge.edgeId,
          edgeIndex: ei,
          layoutIndex: li,
          direction: getRotationAtEndNodeAllowed(p),
        });
        record(outgoing, edge.startNodeId, p.vehicleTypeId, {
          edgeId: edge.edgeId,
          edgeIndex: ei,
          layoutIndex: li,
          direction: getRotationAtStartNodeAllowed(p),
        });
      }
    });
  });

  const reported = new Set<string>();
  for (const [nodeId, byType] of incoming) {
    const outByType = outgoing.get(nodeId);
    if (!outByType) continue;
    for (const [vehicleTypeId, ins] of byType) {
      const outs = outByType.get(vehicleTypeId);
      if (!outs) continue;
      for (const inn of ins) {
        for (const out of outs) {
          if (inn.edgeId === out.edgeId) continue; // a single edge's own pair is not a transition
          if (inn.direction === "NONE" || out.direction === "NONE") continue; // intentional
          if (combineRotationDirections(inn.direction, out.direction) !== "NONE") continue;
          const key = `${nodeId} ${vehicleTypeId} ${inn.edgeId} ${out.edgeId}`;
          if (reported.has(key)) continue;
          reported.add(key);
          c.info(
            "LIF-V032",
            `rotation at node "${nodeId}" for vehicle type "${vehicleTypeId}" combines to NONE (${inn.direction} arriving via edge "${inn.edgeId}" vs ${out.direction} leaving via edge "${out.edgeId}"); the transition may be unnavigable (guideline 8.3.9.1)`,
            `layouts[${out.layoutIndex}].edges[${out.edgeIndex}]`,
          );
        }
      }
    }
  }
}

function checkVehicleTypeUniqueness(
  c: DiagnosticCollector,
  props: readonly { vehicleTypeId: string }[],
  path: string,
): void {
  const seen = new Map<string, number>();
  props.forEach((p, i) => {
    const first = seen.get(p.vehicleTypeId);
    if (first !== undefined) {
      c.error("LIF-V010", `duplicate vehicleTypeId "${p.vehicleTypeId}" (also [${first}]); only one property set per vehicle type is allowed`, `${path}[${i}].vehicleTypeId`);
    } else {
      seen.set(p.vehicleTypeId, i);
    }
  });
}

function checkAngleRange(c: DiagnosticCollector, value: number, path: string): void {
  if (value < -PI - ANGLE_EPS || value > PI + ANGLE_EPS) {
    c.error("LIF-V018", `angle ${value} is outside [-π, π]`, path);
  }
}

function checkActions(c: DiagnosticCollector, actions: LifAction[] | undefined, path: string): void {
  if (!actions) return;
  let required = 0;
  actions.forEach((a, ai) => {
    if (a.requirementType === "REQUIRED") required++;
    const keys = new Map<string, number>();
    a.actionParameters?.forEach((p, pi) => {
      const first = keys.get(p.key);
      if (first !== undefined) {
        c.error("LIF-V021", `duplicate actionParameter key "${p.key}" (also [${first}])`, `${path}.actions[${ai}].actionParameters[${pi}].key`);
      } else {
        keys.set(p.key, pi);
      }
    });
  });
  if (required > 1) {
    c.warning("LIF-V020", `${required} actions are marked REQUIRED; the LIF does not define combination semantics for more than one (guideline 8.3.6)`, `${path}.actions`);
  }
}

function checkTrajectory(
  c: DiagnosticCollector,
  t: Trajectory,
  path: string,
  startNode?: LifNode,
  endNode?: LifNode,
): void {
  const degree = getDegree(t);
  if (!Number.isInteger(degree) || degree < 1) {
    c.error("LIF-V024", `degree must be an integer ≥ 1 (got ${degree})`, `${path}.degree`);
    return;
  }
  const cp = t.controlPoints;
  if (cp.length < degree + 1) {
    c.error("LIF-V016", `a degree-${degree} NURBS needs at least ${degree + 1} control points (got ${cp.length})`, `${path}.controlPoints`);
  }
  const expectedKnots = cp.length + degree + 1;
  if (t.knotVector.length !== expectedKnots) {
    c.error("LIF-V014", `knotVector length must be controlPoints + degree + 1 = ${expectedKnots} (got ${t.knotVector.length})`, `${path}.knotVector`);
  }
  for (let i = 0; i < t.knotVector.length; i++) {
    const k = t.knotVector[i]!;
    if (k < 0 || k > 1) {
      c.error("LIF-V015", `knot values must lie in [0, 1] (knot[${i}] = ${k})`, `${path}.knotVector[${i}]`);
      break;
    }
    if (i > 0 && k < t.knotVector[i - 1]!) {
      c.error("LIF-V015", `knotVector must be non-decreasing (knot[${i}] = ${k} < knot[${i - 1}] = ${t.knotVector[i - 1]})`, `${path}.knotVector[${i}]`);
      break;
    }
  }
  cp.forEach((p, i) => {
    if (getWeight(p) < 0) {
      c.error("LIF-V025", `control point weight must be ≥ 0 (got ${p.weight})`, `${path}.controlPoints[${i}].weight`);
    }
  });

  // Guideline 8.3.12 defines control points in global coordinates, but its own
  // example 10.17 violates that — hence only a warning (EXTRA notes, erratum E5).
  const first = cp[0];
  const last = cp[cp.length - 1];
  if (startNode && first && distance(first, startNode.nodePosition) > ENDPOINT_TOLERANCE) {
    c.warning("LIF-V017", `trajectory start (${first.x}, ${first.y}) does not coincide with start node "${startNode.nodeId}" at (${startNode.nodePosition.x}, ${startNode.nodePosition.y})`, `${path}.controlPoints[0]`);
  }
  if (endNode && last && distance(last, endNode.nodePosition) > ENDPOINT_TOLERANCE) {
    c.warning("LIF-V017", `trajectory end (${last.x}, ${last.y}) does not coincide with end node "${endNode.nodeId}" at (${endNode.nodePosition.x}, ${endNode.nodePosition.y})`, `${path}.controlPoints[${cp.length - 1}]`);
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
