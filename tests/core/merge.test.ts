import { describe, expect, test } from "bun:test";
import {
  collectIdCollisions,
  mergeLif,
  parseLif,
  prefixLifIds,
  serializeLif,
  transformLif,
  type Lif,
} from "../../src/lif";

function docA(): Lif {
  return {
    metaInformation: {
      projectIdentification: "Plant A",
      creator: "integrator-a",
      exportTimestamp: "2026-07-01T00:00:00Z",
      lifVersion: "1.0.0",
    },
    layouts: [
      {
        layoutId: "ground",
        layoutVersion: "1",
        nodes: [
          {
            nodeId: "n1",
            nodePosition: { x: 1, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t", theta: 3 }],
          },
          {
            nodeId: "n2",
            nodePosition: { x: 3, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
          },
        ],
        edges: [
          {
            edgeId: "e1",
            startNodeId: "n1",
            endNodeId: "n2",
            vehicleTypeEdgeProperties: [
              {
                vehicleTypeId: "t",
                rotationAllowed: true,
                vehicleOrientation: 0.5,
                orientationType: "GLOBAL",
                trajectory: {
                  degree: 1,
                  knotVector: [0, 0, 1, 1],
                  controlPoints: [
                    { x: 1, y: 0 },
                    { x: 3, y: 0 },
                  ],
                },
              },
              { vehicleTypeId: "u", rotationAllowed: false, vehicleOrientation: 0.5 },
            ],
          },
        ],
        stations: [
          {
            stationId: "s1",
            interactionNodeIds: ["n1"],
            stationPosition: { x: 1, y: 1, theta: 0 },
          },
        ],
      },
    ],
  };
}

function docB(): Lif {
  return {
    metaInformation: {
      projectIdentification: "Annex B",
      creator: "integrator-b",
      exportTimestamp: "2026-07-02T00:00:00Z",
      lifVersion: "1.0.0",
    },
    layouts: [
      {
        layoutId: "ground",
        layoutVersion: "1",
        nodes: [
          {
            nodeId: "b1",
            nodePosition: { x: 10, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
          },
        ],
        edges: [],
        stations: [],
      },
      {
        layoutId: "cellar",
        layoutVersion: "1",
        nodes: [],
        edges: [],
        stations: [],
      },
    ],
  };
}

describe("transformLif", () => {
  test("rotates about the origin then translates; angles normalize into [-π, π]", () => {
    const doc = docA();
    const before = structuredClone(doc);
    const moved = transformLif(doc, { rotateRad: Math.PI / 2, dx: 10, dy: 5 });
    expect(doc).toEqual(before); // pure

    const n1 = moved.layouts[0]!.nodes[0]!;
    expect(n1.nodePosition.x).toBeCloseTo(10, 10); // (1,0) → (0,1) → +t
    expect(n1.nodePosition.y).toBeCloseTo(6, 10);
    // θ = 3 + π/2 wraps around +π.
    expect(n1.vehicleTypeNodeProperties[0]!.theta!).toBeCloseTo(3 + Math.PI / 2 - 2 * Math.PI, 10);

    const station = moved.layouts[0]!.stations[0]!;
    expect(station.stationPosition!.x).toBeCloseTo(9, 10); // (1,1) → (-1,1) → +t
    expect(station.stationPosition!.y).toBeCloseTo(6, 10);
    expect(station.stationPosition!.theta!).toBeCloseTo(Math.PI / 2, 10);

    const [globalProp, tangentialProp] = moved.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties;
    expect(globalProp!.trajectory!.controlPoints[1]!.x).toBeCloseTo(10, 10);
    expect(globalProp!.trajectory!.controlPoints[1]!.y).toBeCloseTo(8, 10);
    // GLOBAL orientations are absolute and rotate; TANGENTIAL are path-relative.
    expect(globalProp!.vehicleOrientation!).toBeCloseTo(0.5 + Math.PI / 2, 10);
    expect(tangentialProp!.vehicleOrientation!).toBe(0.5);
  });

  test("the zero transform is an identity copy", () => {
    const doc = docA();
    const copy = transformLif(doc, {});
    expect(copy).toEqual(doc);
    expect(copy).not.toBe(doc);
  });
});

describe("prefixLifIds", () => {
  test("prefixes every id and every internal reference, but never vehicle types", () => {
    const prefixed = prefixLifIds(docA(), "a:");
    const layout = prefixed.layouts[0]!;
    expect(layout.layoutId).toBe("a:ground");
    expect(layout.nodes.map((n) => n.nodeId)).toEqual(["a:n1", "a:n2"]);
    expect(layout.edges[0]).toMatchObject({
      edgeId: "a:e1",
      startNodeId: "a:n1",
      endNodeId: "a:n2",
    });
    expect(layout.stations[0]!.stationId).toBe("a:s1");
    expect(layout.stations[0]!.interactionNodeIds).toEqual(["a:n1"]);
    expect(layout.edges[0]!.vehicleTypeEdgeProperties[0]!.vehicleTypeId).toBe("t");
  });
});

describe("collectIdCollisions / mergeLif", () => {
  test("collision detection per kind", () => {
    const collisions = collectIdCollisions(docA(), docB());
    expect(collisions).toEqual({ layouts: ["ground"], nodes: [], edges: [], stations: [] });
    const withNodeClash = docB();
    withNodeClash.layouts[0]!.nodes[0]!.nodeId = "n1";
    expect(collectIdCollisions(docA(), withNodeClash).nodes).toEqual(["n1"]);
  });

  test("merges: same-id layouts union, new layouts append, provenance recorded", () => {
    const a = docA();
    const before = structuredClone(a);
    const merged = mergeLif(a, docB());
    expect(a).toEqual(before); // pure
    expect(merged.layouts.map((l) => l.layoutId)).toEqual(["ground", "cellar"]);
    expect(merged.layouts[0]!.nodes.map((n) => n.nodeId)).toEqual(["n1", "n2", "b1"]);
    const provenance = (merged.metaInformation as unknown as Record<string, unknown>)[
      "x-mergedSources"
    ];
    expect(provenance).toEqual([
      {
        projectIdentification: "Annex B",
        creator: "integrator-b",
        exportTimestamp: "2026-07-02T00:00:00Z",
        // The base keeps its own layout metadata; the source's is recorded.
        unionedLayouts: [{ layoutId: "ground", layoutVersion: "1" }],
      },
    ]);
  });

  test("duplicate layout ids inside one source are refused", () => {
    const bad = docB();
    bad.layouts.push(structuredClone(bad.layouts[0]!));
    expect(() => mergeLif(docA(), bad)).toThrow('duplicate layout id "ground"');
  });

  test("provenance accumulates and survives a serialize/parse round-trip", () => {
    const third: Lif = {
      metaInformation: {
        projectIdentification: "Cell C",
        creator: "integrator-c",
        exportTimestamp: "2026-07-03T00:00:00Z",
        lifVersion: "1.0.0",
      },
      layouts: [{ layoutId: "cell-c", layoutVersion: "1", nodes: [], edges: [], stations: [] }],
    };
    const merged = mergeLif(mergeLif(docA(), docB()), third);
    const { lif: reparsed } = parseLif(serializeLif(merged));
    const provenance = (reparsed.metaInformation as unknown as Record<string, unknown>)[
      "x-mergedSources"
    ] as unknown[];
    expect(provenance).toHaveLength(2);
    expect(provenance[1]).toMatchObject({ creator: "integrator-c" });
  });

  test("element id collisions throw with a prefix hint", () => {
    const clashing = docB();
    clashing.layouts[0]!.nodes[0]!.nodeId = "n1";
    expect(() => mergeLif(docA(), clashing)).toThrow(/node "n1".*prefix one document first/);
    // Prefixing resolves it.
    const merged = mergeLif(docA(), prefixLifIds(clashing, "b:"));
    expect(merged.layouts.map((l) => l.layoutId)).toEqual(["ground", "b:ground", "b:cellar"]);
  });
});
