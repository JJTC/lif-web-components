import { describe, expect, test } from "bun:test";
import { hasErrors, parseLif, validateLif, type Diagnostic } from "../../src/lif";
import { byCode, loadFixture } from "./helpers";

async function validateFixture(name: string): Promise<Diagnostic[]> {
  const { lif, diagnostics } = parseLif(await loadFixture(name));
  expect(hasErrors(diagnostics)).toBe(false);
  return validateLif(lif);
}

describe("validateLif on valid documents", () => {
  test("minimal fixture has no findings", async () => {
    expect(await validateFixture("minimal.lif.json")).toEqual([]);
  });

  test("warehouse fixture only notes its intentional cross-layout lift edge", async () => {
    const diagnostics = await validateFixture("warehouse.lif.json");
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d.code).toBe("LIF-V007");
    expect(d.severity).toBe("info");
    expect(d.path).toContain(".endNodeId");
    expect(d.message).toContain("e-lift-up");
    expect(d.message).toContain("mezzanine");
  });
});

describe("validateLif finds semantic problems", () => {
  test("invalid-semantics fixture triggers the expected rules", async () => {
    const diagnostics = await validateFixture("invalid-semantics.lif.json");

    const expectations: Array<[code: string, pathFragment: string]> = [
      ["LIF-V002", "nodes[1].nodeId"], // duplicate nodeId "a1"
      ["LIF-V008", "nodes[2].vehicleTypeNodeProperties"], // empty vehicle types
      ["LIF-V010", "vehicleTypeNodeProperties[1].vehicleTypeId"], // duplicate vehicle type
      ["LIF-V018", "vehicleTypeNodeProperties[0].theta"], // theta 4.5 > π
      ["LIF-V005", "edges[0].startNodeId"], // start node in other layout
      ["LIF-V006", "edges[0].endNodeId"], // end node nowhere
      ["LIF-V027", "maxSpeed"], // non-positive speed
      ["LIF-V028", "vehicleTypeEdgeProperties[0]"], // minHeight > maxHeight
      ["LIF-V019", "loadRestriction.loadSetNames"], // loadSetNames with loaded=false
      ["LIF-V021", "actionParameters[1].key"], // duplicate action parameter key
      ["LIF-V020", "actions"], // two REQUIRED actions
      ["LIF-V014", "trajectory.knotVector"], // wrong knot count
      ["LIF-V025", "controlPoints[1].weight"], // negative weight
      ["LIF-V011", "stations[0].interactionNodeIds"], // empty interaction nodes
      ["LIF-V026", "stations[0].stationHeight"], // negative height
      ["LIF-V012", "stations[1].interactionNodeIds[0]"], // ghost node
      ["LIF-V013", "stations[1].interactionNodeIds[1]"], // node from other layout
    ];

    for (const [code, pathFragment] of expectations) {
      const matching = byCode(diagnostics, code);
      expect(matching.length, `expected ${code} to be reported`).toBeGreaterThanOrEqual(1);
      expect(
        matching.some((d) => d.path.includes(pathFragment)),
        `expected some ${code} at path containing "${pathFragment}", got ${matching.map((d) => d.path).join(", ")}`,
      ).toBe(true);
    }
  });

  test("duplicate IDs across layouts are errors", () => {
    const { lif } = parseLif({
      metaInformation: {
        projectIdentification: "t",
        creator: "t",
        exportTimestamp: "t",
        lifVersion: "1.0.0",
      },
      layouts: [
        {
          layoutId: "dup",
          layoutVersion: "1",
          nodes: [
            {
              nodeId: "x",
              nodePosition: { x: 0, y: 0 },
              vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
            },
          ],
          edges: [],
          stations: [],
        },
        {
          layoutId: "dup",
          layoutVersion: "1",
          nodes: [
            {
              nodeId: "x",
              nodePosition: { x: 1, y: 1 },
              vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
            },
          ],
          edges: [],
          stations: [],
        },
      ],
    });
    const diagnostics = validateLif(lif);
    expect(byCode(diagnostics, "LIF-V001")).toHaveLength(1);
    expect(byCode(diagnostics, "LIF-V002")).toHaveLength(1);
  });

  test("meta format warnings for non-ISO timestamp and non-semver version", () => {
    const { lif } = parseLif({
      metaInformation: {
        projectIdentification: "t",
        creator: "t",
        exportTimestamp: "yesterday",
        lifVersion: "v1",
      },
      layouts: [{ layoutId: "l", layoutVersion: "1", nodes: [], edges: [], stations: [] }],
    });
    const diagnostics = validateLif(lif);
    expect(byCode(diagnostics, "LIF-V030")).toHaveLength(1);
    expect(byCode(diagnostics, "LIF-V031")).toHaveLength(1);
    expect(diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  test("self-loop edges get an info diagnostic", () => {
    const { lif } = parseLif({
      metaInformation: { projectIdentification: "t", creator: "t", exportTimestamp: "2026-07-06T10:00:00.00Z", lifVersion: "1.0.0" },
      layouts: [
        {
          layoutId: "l",
          layoutVersion: "1",
          nodes: [{ nodeId: "a", nodePosition: { x: 0, y: 0 }, vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }] }],
          edges: [{ edgeId: "self", startNodeId: "a", endNodeId: "a", vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: false }] }],
          stations: [],
        },
      ],
    });
    const d = byCode(validateLif(lif), "LIF-V029");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("info");
  });

  test("rotation contradiction at a shared node (CW arriving vs CCW leaving) is flagged", () => {
    // n-mid: edge A arrives with rotationAtEnd=CW, edge B leaves with rotationAtStart=CCW → NONE.
    const { lif } = parseLif({
      metaInformation: { projectIdentification: "t", creator: "t", exportTimestamp: "2026-07-06T10:00:00.00Z", lifVersion: "1.0.0" },
      layouts: [
        {
          layoutId: "l",
          layoutVersion: "1",
          nodes: ["a", "mid", "b"].map((id, i) => ({
            nodeId: id,
            nodePosition: { x: i * 2, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "veh" }],
          })),
          edges: [
            { edgeId: "A", startNodeId: "a", endNodeId: "mid", vehicleTypeEdgeProperties: [{ vehicleTypeId: "veh", rotationAllowed: false, rotationAtEndNodeAllowed: "CW" }] },
            { edgeId: "B", startNodeId: "mid", endNodeId: "b", vehicleTypeEdgeProperties: [{ vehicleTypeId: "veh", rotationAllowed: false, rotationAtStartNodeAllowed: "CCW" }] },
          ],
          stations: [],
        },
      ],
    });
    const d = byCode(validateLif(lif), "LIF-V032");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("info");
    expect(d[0]!.message).toContain("mid");
  });

  test("intentional NONE and aligned rotations do not trip the contradiction check", () => {
    const { lif } = parseLif({
      metaInformation: { projectIdentification: "t", creator: "t", exportTimestamp: "2026-07-06T10:00:00.00Z", lifVersion: "1.0.0" },
      layouts: [
        {
          layoutId: "l",
          layoutVersion: "1",
          nodes: ["a", "mid", "b"].map((id, i) => ({
            nodeId: id,
            nodePosition: { x: i * 2, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "veh" }],
          })),
          edges: [
            // Arriving BOTH, leaving NONE → NONE, but NONE is intentional on B: not flagged.
            { edgeId: "A", startNodeId: "a", endNodeId: "mid", vehicleTypeEdgeProperties: [{ vehicleTypeId: "veh", rotationAllowed: false, rotationAtEndNodeAllowed: "BOTH" }] },
            { edgeId: "B", startNodeId: "mid", endNodeId: "b", vehicleTypeEdgeProperties: [{ vehicleTypeId: "veh", rotationAllowed: false, rotationAtStartNodeAllowed: "NONE" }] },
          ],
          stations: [],
        },
      ],
    });
    expect(byCode(validateLif(lif), "LIF-V032")).toHaveLength(0);
  });

  test("empty layouts get a warning", () => {
    const { lif } = parseLif({
      metaInformation: {
        projectIdentification: "t",
        creator: "t",
        exportTimestamp: "t",
        lifVersion: "1.0.0",
      },
      layouts: [{ layoutId: "l", layoutVersion: "1", nodes: [], edges: [], stations: [] }],
    });
    const diagnostics = validateLif(lif);
    expect(byCode(diagnostics, "LIF-V022")).toHaveLength(1);
    expect(hasErrors(diagnostics)).toBe(false);
  });

  test("knot vector range and ordering violations are reported", async () => {
    const { lif } = parseLif(await loadFixture("minimal.lif.json"));
    lif.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.trajectory = {
      degree: 1,
      knotVector: [0, 0.8, 0.2, 1],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
      ],
    };
    const diagnostics = validateLif(lif);
    expect(byCode(diagnostics, "LIF-V015")).toHaveLength(1);
  });

  test("trajectory endpoints far from nodes produce warnings (guideline example 10.17 quirk)", async () => {
    const { lif } = parseLif(await loadFixture("minimal.lif.json"));
    lif.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.trajectory = {
      degree: 1,
      knotVector: [0, 0, 1, 1],
      controlPoints: [
        { x: 100, y: 100 },
        { x: 108, y: 100 },
      ],
    };
    const diagnostics = validateLif(lif);
    const warnings = byCode(diagnostics, "LIF-V017");
    expect(warnings).toHaveLength(2);
    expect(warnings.every((d) => d.severity === "warning")).toBe(true);
  });
});
