/**
 * Per-vehicle-type shortest-path routing over the LIF network —
 * the master-control planning primitive: "can type X get from A to B, and
 * which way". An edge is traversable by a type when the edge carries a
 * property entry for that type and both endpoint nodes do too; cross-layout
 * transition edges are traversable (that is their purpose). Costs are metres:
 * the type's own evaluable trajectory length when present, else the
 * straight-line distance between the endpoints.
 */

import { isTrajectoryEvaluable, sampleTrajectory } from "./nurbs";
import type { Lif } from "./types";

export interface RouteResult {
  /** Visited nodes, from → to inclusive. */
  nodeIds: string[];
  /** Traversed edges, one per leg (`nodeIds.length - 1`). */
  edgeIds: string[];
  /** Total cost in metres. */
  length: number;
}

interface Arc {
  to: string;
  edgeId: string;
  cost: number;
}

/** Binary min-heap on distance; enough for facility-scale graphs. */
class MinHeap {
  #items: { id: string; dist: number }[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(id: string, dist: number): void {
    const items = this.#items;
    items.push({ id, dist });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.dist <= items[i]!.dist) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): { id: string; dist: number } | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left]!.dist < items[smallest]!.dist) smallest = left;
        if (right < items.length && items[right]!.dist < items[smallest]!.dist) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i]!, items[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Dijkstra over the type's usable sub-network. Returns null when the target
 * is unreachable or either endpoint is not usable by the type; throws only
 * on unknown node ids (programmer error, like the edit operations).
 */
export function shortestRoute(
  lif: Lif,
  vehicleTypeId: string,
  fromNodeId: string,
  toNodeId: string,
): RouteResult | null {
  const nodePos = new Map<string, { x: number; y: number }>();
  const usable = new Set<string>();
  for (const layout of lif.layouts) {
    for (const n of layout.nodes) {
      nodePos.set(n.nodeId, n.nodePosition);
      if (n.vehicleTypeNodeProperties.some((p) => p.vehicleTypeId === vehicleTypeId)) {
        usable.add(n.nodeId);
      }
    }
  }
  if (!nodePos.has(fromNodeId)) throw new Error(`node "${fromNodeId}" not found`);
  if (!nodePos.has(toNodeId)) throw new Error(`node "${toNodeId}" not found`);
  if (!usable.has(fromNodeId) || !usable.has(toNodeId)) return null;
  if (fromNodeId === toNodeId) return { nodeIds: [fromNodeId], edgeIds: [], length: 0 };

  const adjacency = new Map<string, Arc[]>();
  for (const layout of lif.layouts) {
    for (const edge of layout.edges) {
      const prop = edge.vehicleTypeEdgeProperties.find((p) => p.vehicleTypeId === vehicleTypeId);
      if (!prop) continue;
      if (!usable.has(edge.startNodeId) || !usable.has(edge.endNodeId)) continue;
      const a = nodePos.get(edge.startNodeId)!;
      const b = nodePos.get(edge.endNodeId)!;
      let cost: number;
      if (prop.trajectory && isTrajectoryEvaluable(prop.trajectory)) {
        const pts = sampleTrajectory(prop.trajectory, 48);
        cost = 0;
        for (let i = 1; i < pts.length; i++) {
          cost += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        }
      } else {
        cost = Math.hypot(b.x - a.x, b.y - a.y);
      }
      let arcs = adjacency.get(edge.startNodeId);
      if (!arcs) adjacency.set(edge.startNodeId, (arcs = []));
      arcs.push({ to: edge.endNodeId, edgeId: edge.edgeId, cost });
    }
  }

  const dist = new Map<string, number>([[fromNodeId, 0]]);
  const prev = new Map<string, { nodeId: string; edgeId: string }>();
  const done = new Set<string>();
  const heap = new MinHeap();
  heap.push(fromNodeId, 0);
  while (heap.size > 0) {
    const { id, dist: d } = heap.pop()!;
    if (done.has(id)) continue;
    done.add(id);
    if (id === toNodeId) break;
    for (const arc of adjacency.get(id) ?? []) {
      const candidate = d + arc.cost;
      if (candidate < (dist.get(arc.to) ?? Infinity)) {
        dist.set(arc.to, candidate);
        prev.set(arc.to, { nodeId: id, edgeId: arc.edgeId });
        heap.push(arc.to, candidate);
      }
    }
  }
  if (!done.has(toNodeId)) return null;

  const nodeIds: string[] = [toNodeId];
  const edgeIds: string[] = [];
  for (let id = toNodeId; id !== fromNodeId; ) {
    const step = prev.get(id)!;
    edgeIds.unshift(step.edgeId);
    nodeIds.unshift(step.nodeId);
    id = step.nodeId;
  }
  return { nodeIds, edgeIds, length: dist.get(toNodeId)! };
}
