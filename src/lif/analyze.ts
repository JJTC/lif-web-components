/**
 * Operational network analysis: per-vehicle-type coverage and
 * reachability advisories. Deliberately separate from validate.ts — these are
 * not spec-conformance rules but answers to "can this type actually operate
 * this network?", the master-control question when receiving a handover.
 *
 * Codes: LIF-A0xx. Severities are advisory (info for coverage gaps, which are
 * often intentional; warning for topology traps a vehicle cannot escape).
 */

import type { Diagnostic } from "./diagnostics";
import type { Lif } from "./types";
import { listVehicleTypes } from "./operations";

/** Cap example-id lists in messages. */
const LIST_LIMIT = 5;

function idList(ids: string[]): string {
  return ids.length > LIST_LIMIT ? `${ids.slice(0, LIST_LIMIT).join(", ")}, …` : ids.join(", ");
}

export function analyzeLif(lif: Lif): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const type of listVehicleTypes(lif)) {
    // Document-wide usability (transition edges end in another layout).
    const usableNodes = new Set<string>();
    for (const layout of lif.layouts)
      for (const n of layout.nodes)
        if (n.vehicleTypeNodeProperties.some((p) => p.vehicleTypeId === type))
          usableNodes.add(n.nodeId);

    // Directed degree over all usable edges (both endpoints usable), so a
    // usable transition edge counts as an exit from its start node. Self-loop
    // edges are excluded: they neither let a vehicle leave a node nor reach
    // it, and counting them would mask real traps (A004).
    const outDegree = new Map<string, number>();
    const inDegree = new Map<string, number>();
    for (const layout of lif.layouts) {
      for (const e of layout.edges) {
        if (e.startNodeId === e.endNodeId) continue;
        if (!e.vehicleTypeEdgeProperties.some((p) => p.vehicleTypeId === type)) continue;
        if (!usableNodes.has(e.startNodeId) || !usableNodes.has(e.endNodeId)) continue;
        outDegree.set(e.startNodeId, (outDegree.get(e.startNodeId) ?? 0) + 1);
        inDegree.set(e.endNodeId, (inDegree.get(e.endNodeId) ?? 0) + 1);
      }
    }

    lif.layouts.forEach((layout, li) => {
      const typeNodes = layout.nodes.filter((n) => usableNodes.has(n.nodeId));
      const layoutPath = `layouts[${li}]`;
      // The type not appearing in a layout at all is normal (it operates
      // elsewhere) — but edges carrying the type with NO usable node at all
      // mean nothing is traversable: exactly the failed-handover signal.
      if (typeNodes.length === 0) {
        const orphanEdges = layout.edges
          .filter((e) => e.vehicleTypeEdgeProperties.some((p) => p.vehicleTypeId === type))
          .map((e) => e.edgeId);
        if (orphanEdges.length > 0) {
          out.push({
            severity: "warning",
            code: "LIF-A005",
            path: layoutPath,
            message:
              `vehicle type "${type}" appears on ${orphanEdges.length} edge` +
              `${orphanEdges.length === 1 ? "" : "s"} in layout "${layout.layoutId}" but on ` +
              `none of its nodes — no edge is traversable: ${idList(orphanEdges)}`,
          });
        }
        return;
      }

      // A001/A002 — coverage gaps.
      const missingNodes = layout.nodes
        .filter((n) => !usableNodes.has(n.nodeId))
        .map((n) => n.nodeId);
      if (missingNodes.length > 0) {
        out.push({
          severity: "info",
          code: "LIF-A001",
          path: layoutPath,
          message:
            `vehicle type "${type}" cannot use ${missingNodes.length} of ` +
            `${layout.nodes.length} nodes in layout "${layout.layoutId}": ${idList(missingNodes)}`,
        });
      }
      const missingEdges = layout.edges
        .filter((e) => !e.vehicleTypeEdgeProperties.some((p) => p.vehicleTypeId === type))
        .map((e) => e.edgeId);
      if (missingEdges.length > 0) {
        out.push({
          severity: "info",
          code: "LIF-A002",
          path: layoutPath,
          message:
            `vehicle type "${type}" cannot use ${missingEdges.length} of ` +
            `${layout.edges.length} edges in layout "${layout.layoutId}": ${idList(missingEdges)}`,
        });
      }

      // A003 — the usable intra-layout network splits into islands
      // (undirected connectivity; one-way pairs still belong together).
      if (typeNodes.length > 1) {
        const layoutNodeIds = new Set(layout.nodes.map((n) => n.nodeId));
        const adjacency = new Map<string, string[]>();
        for (const n of typeNodes) adjacency.set(n.nodeId, []);
        for (const e of layout.edges) {
          if (!e.vehicleTypeEdgeProperties.some((p) => p.vehicleTypeId === type)) continue;
          if (!adjacency.has(e.startNodeId) || !adjacency.has(e.endNodeId)) continue;
          if (!layoutNodeIds.has(e.endNodeId)) continue;
          adjacency.get(e.startNodeId)!.push(e.endNodeId);
          adjacency.get(e.endNodeId)!.push(e.startNodeId);
        }
        const seen = new Set<string>();
        const sizes: number[] = [];
        for (const n of typeNodes) {
          if (seen.has(n.nodeId)) continue;
          let size = 0;
          const queue = [n.nodeId];
          seen.add(n.nodeId);
          while (queue.length > 0) {
            const id = queue.pop()!;
            size++;
            for (const next of adjacency.get(id)!) {
              if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
              }
            }
          }
          sizes.push(size);
        }
        if (sizes.length > 1) {
          sizes.sort((a, b) => b - a);
          out.push({
            severity: "warning",
            code: "LIF-A003",
            path: layoutPath,
            message:
              `the track network usable by "${type}" in layout "${layout.layoutId}" ` +
              `splits into ${sizes.length} disconnected parts (${sizes.join(" + ")} nodes)`,
          });
        }
      }

      // A004 — directed traps: reachable but not leavable.
      layout.nodes.forEach((n, ni) => {
        if (!usableNodes.has(n.nodeId)) return;
        if ((inDegree.get(n.nodeId) ?? 0) > 0 && (outDegree.get(n.nodeId) ?? 0) === 0) {
          out.push({
            severity: "warning",
            code: "LIF-A004",
            path: `${layoutPath}.nodes[${ni}]`,
            message:
              `vehicle type "${type}" can enter node "${n.nodeId}" ` +
              `(layout "${layout.layoutId}") but has no usable edge to leave it`,
          });
        }
      });
    });
  }
  return out;
}
