import { describe, expect, test } from "bun:test";
import { shortestRoute, type Lif } from "../../src/lif";
import warehouseJson from "../../fixtures/warehouse.lif.json";

const warehouse = warehouseJson as unknown as Lif;

/**
 * n1(0,0) → n2(2,0) → n3(2,2); direct n1→n3 only for type "u"; return edge
 * n3→n1 for "t"; a parallel n1→n2 edge whose "w" entry has a long polyline
 * trajectory; a transition edge n2→m1 into a second layout.
 */
function graphDoc(): Lif {
  return {
    metaInformation: {
      projectIdentification: "route-test",
      creator: "test",
      exportTimestamp: "2026-07-09T00:00:00Z",
      lifVersion: "1.0.0",
    },
    layouts: [
      {
        layoutId: "L1",
        layoutVersion: "1",
        nodes: [
          {
            nodeId: "n1",
            nodePosition: { x: 0, y: 0 },
            vehicleTypeNodeProperties: [
              { vehicleTypeId: "t" },
              { vehicleTypeId: "u" },
              { vehicleTypeId: "w" },
            ],
          },
          {
            nodeId: "n2",
            nodePosition: { x: 2, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }, { vehicleTypeId: "w" }],
          },
          {
            nodeId: "n3",
            nodePosition: { x: 2, y: 2 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }, { vehicleTypeId: "u" }],
          },
        ],
        edges: [
          {
            edgeId: "e12",
            startNodeId: "n1",
            endNodeId: "n2",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: true }],
          },
          {
            edgeId: "e12-detour",
            startNodeId: "n1",
            endNodeId: "n2",
            vehicleTypeEdgeProperties: [
              { vehicleTypeId: "t", rotationAllowed: true },
              {
                vehicleTypeId: "w",
                rotationAllowed: true,
                trajectory: {
                  degree: 1,
                  knotVector: [0, 0, 0.5, 1, 1],
                  controlPoints: [
                    { x: 0, y: 0 },
                    { x: 1, y: 2 },
                    { x: 2, y: 0 },
                  ],
                },
              },
            ],
          },
          {
            edgeId: "e23",
            startNodeId: "n2",
            endNodeId: "n3",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: true }],
          },
          {
            edgeId: "e13-direct",
            startNodeId: "n1",
            endNodeId: "n3",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "u", rotationAllowed: true }],
          },
          {
            edgeId: "e31-return",
            startNodeId: "n3",
            endNodeId: "n1",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: true }],
          },
          {
            edgeId: "e-transition",
            startNodeId: "n2",
            endNodeId: "m1",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: true }],
          },
        ],
        stations: [],
      },
      {
        layoutId: "L2",
        layoutVersion: "1",
        nodes: [
          {
            nodeId: "m1",
            nodePosition: { x: 6, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
          },
        ],
        edges: [],
        stations: [],
      },
    ],
  };
}

describe("shortestRoute", () => {
  test("routes only over the type's usable edges (detour instead of the direct edge)", () => {
    const route = shortestRoute(graphDoc(), "t", "n1", "n3")!;
    expect(route.nodeIds).toEqual(["n1", "n2", "n3"]);
    expect(route.edgeIds).toEqual(["e12", "e23"]);
    expect(route.length).toBeCloseTo(4, 10);
  });

  test("another type takes its own direct edge", () => {
    const route = shortestRoute(graphDoc(), "u", "n1", "n3")!;
    expect(route.nodeIds).toEqual(["n1", "n3"]);
    expect(route.edgeIds).toEqual(["e13-direct"]);
    expect(route.length).toBeCloseTo(Math.hypot(2, 2), 10);
  });

  test("parallel edges: the straight one wins over the trajectory detour", () => {
    const route = shortestRoute(graphDoc(), "t", "n1", "n2")!;
    expect(route.edgeIds).toEqual(["e12"]);
    expect(route.length).toBeCloseTo(2, 10);
  });

  test("trajectory length is the cost when the type's entry carries one", () => {
    // "w" can only use e12-detour, whose polyline runs (0,0)→(1,2)→(2,0).
    const route = shortestRoute(graphDoc(), "w", "n1", "n2")!;
    expect(route.edgeIds).toEqual(["e12-detour"]);
    expect(route.length).toBeCloseTo(2 * Math.hypot(1, 2), 5);
  });

  test("directionality holds and unreachable targets return null", () => {
    // t can return n3→n1 via the explicit return edge…
    expect(shortestRoute(graphDoc(), "t", "n3", "n2")!.nodeIds).toEqual(["n3", "n1", "n2"]);
    // …but u has no edge back.
    expect(shortestRoute(graphDoc(), "u", "n3", "n1")).toBeNull();
  });

  test("same node, unusable endpoints, unknown ids", () => {
    expect(shortestRoute(graphDoc(), "t", "n1", "n1")).toEqual({
      nodeIds: ["n1"],
      edgeIds: [],
      length: 0,
    });
    // n2 carries no "u" entry.
    expect(shortestRoute(graphDoc(), "u", "n1", "n2")).toBeNull();
    expect(shortestRoute(graphDoc(), "nope", "n1", "n2")).toBeNull();
    expect(() => shortestRoute(graphDoc(), "t", "ghost", "n2")).toThrow('node "ghost" not found');
  });

  test("traverses cross-layout transition edges", () => {
    const route = shortestRoute(graphDoc(), "t", "n1", "m1")!;
    expect(route.nodeIds).toEqual(["n1", "n2", "m1"]);
    expect(route.edgeIds).toEqual(["e12", "e-transition"]);
  });

  test("warehouse smoke: a tugger reaches the mezzanine buffer through the lift", () => {
    const route = shortestRoute(warehouse, "acme.tugger", "n-dock", "n-buf-b")!;
    expect(route.nodeIds.slice(0, 2)).toEqual(["n-dock", "n-aisle-w"]);
    expect(route.nodeIds).toContain("n-lift-g");
    expect(route.nodeIds[route.nodeIds.length - 1]).toBe("n-buf-b");
    expect(route.edgeIds).toContain("e-lift-up");
    // The forklift cannot: the lift edges are tugger-only.
    expect(shortestRoute(warehouse, "acme.forklift", "n-dock", "n-buf-b")).toBeNull();
  });
});
