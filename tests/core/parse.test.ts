import { describe, expect, test } from "bun:test";
import {
  hasErrors,
  LifParseError,
  parseLif,
  serializeLif,
  type LifAction,
} from "../../src/lif";
import { byCode, loadFixture } from "./helpers";

describe("parseLif on clean documents", () => {
  test("minimal fixture parses without diagnostics", async () => {
    const { lif, diagnostics } = parseLif(await loadFixture("minimal.lif.json"));
    expect(diagnostics).toEqual([]);
    expect(lif.metaInformation.lifVersion).toBe("1.0.0");
    expect(lif.layouts).toHaveLength(1);
    expect(lif.layouts[0]!.nodes.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
    expect(lif.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.rotationAllowed).toBe(false);
  });

  test("warehouse fixture parses without diagnostics", async () => {
    const { lif, diagnostics } = parseLif(await loadFixture("warehouse.lif.json"));
    expect(diagnostics).toEqual([]);
    expect(lif.layouts.map((l) => l.layoutId)).toEqual(["ground", "mezzanine"]);
    const arc = lif.layouts[0]!.edges.find((e) => e.edgeId === "e-east-lift-arc")!;
    expect(arc.vehicleTypeEdgeProperties[0]!.trajectory!.controlPoints).toHaveLength(3);
  });

  test("accepts an already-parsed object", async () => {
    const raw = JSON.parse(await loadFixture("minimal.lif.json"));
    const { diagnostics } = parseLif(raw);
    expect(diagnostics).toEqual([]);
  });

  test("does not mutate its input", async () => {
    const raw = JSON.parse(await loadFixture("quirks-legacy.lif.json"));
    // Coercions inside shared arrays must not leak into the input either.
    raw.layouts[1].stations[0].interactionNodeIds = [3];
    raw.layouts[0].edges[0].vehicleTypeEdgeProperties[0].trajectory = {
      degree: 1,
      knotVector: ["0", "0", "1", "1"],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 6.5, y: 0 },
      ],
    };
    const before = JSON.stringify(raw);
    parseLif(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("parseLif error handling", () => {
  test("rejects invalid JSON", () => {
    expect(() => parseLif("{ not json")).toThrow(LifParseError);
  });

  test("rejects non-object roots", () => {
    expect(() => parseLif("[]")).toThrow(LifParseError);
    expect(() => parseLif("42")).toThrow(LifParseError);
    expect(() => parseLif(null)).toThrow(LifParseError);
  });

  test("missing metaInformation and layouts are errors, not throws", () => {
    const { diagnostics } = parseLif({});
    expect(hasErrors(diagnostics)).toBe(true);
    const paths = diagnostics.map((d) => d.path);
    expect(paths).toContain("");
    expect(byCode(diagnostics, "LIF-P002").length).toBe(2);
  });

  test("missing required leaf fields are reported with paths", () => {
    const { diagnostics } = parseLif({
      metaInformation: {
        projectIdentification: "x",
        creator: "x",
        exportTimestamp: "x",
        lifVersion: "1.0.0",
      },
      layouts: [
        {
          layoutId: "l1",
          layoutVersion: "1",
          nodes: [{ nodeId: "n1", vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }] }],
          edges: [],
          stations: [],
        },
      ],
    });
    const missing = byCode(diagnostics, "LIF-P002");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.path).toBe("layouts[0].nodes[0]");
    expect(missing[0]!.message).toContain("nodePosition");
  });

  test("invalid enum values are errors but preserved", () => {
    const { lif, diagnostics } = parseLif({
      metaInformation: {
        projectIdentification: "x",
        creator: "x",
        exportTimestamp: "x",
        lifVersion: "1.0.0",
      },
      layouts: [
        {
          layoutId: "l1",
          layoutVersion: "1",
          nodes: [],
          edges: [
            {
              edgeId: "e1",
              startNodeId: "a",
              endNodeId: "b",
              vehicleTypeEdgeProperties: [
                { vehicleTypeId: "t", rotationAllowed: true, orientationType: "SIDEWAYS" },
              ],
            },
          ],
          stations: [],
        },
      ],
    });
    expect(byCode(diagnostics, "LIF-P007")).toHaveLength(1);
    expect(
      lif.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.orientationType,
    ).toBe("SIDEWAYS" as never);
  });
});

describe("parseLif on hostile input", () => {
  test("wrong types everywhere produce diagnostics, never a throw", () => {
    const { lif, diagnostics } = parseLif({
      metaInformation: 42,
      layouts: [
        {
          layoutId: {},
          layoutVersion: "1",
          nodes: [
            42,
            {
              nodeId: "n1",
              nodePosition: null,
              vehicleTypeNodeProperties: "none",
            },
            {
              nodeId: "n2",
              nodePosition: { x: "abc", y: [] },
              vehicleTypeNodeProperties: [{ vehicleTypeId: "t", actions: [{ actionType: "a", blockingType: 42 }] }],
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
                  rotationAllowed: "maybe",
                  loadRestriction: [],
                  trajectory: { degree: 1, knotVector: "bad", controlPoints: [{ x: 0, y: 0 }] },
                },
              ],
            },
            {
              edgeId: "e2",
              startNodeId: "n1",
              endNodeId: "n2",
              vehicleTypeEdgeProperties: [
                {
                  vehicleTypeId: "t",
                  rotationAllowed: true,
                  trajectory: { knotVector: [0, "x", 1, 1], controlPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
                },
              ],
            },
          ],
          stations: [
            { stationId: "s1", interactionNodeIds: "n1", stationPosition: 5 },
            { stationId: "s2", interactionNodeIds: [{}, "n2"] },
          ],
        },
        "not a layout",
      ],
    });
    expect(hasErrors(diagnostics)).toBe(true);
    // Structure is still navigable after all that.
    expect(lif.layouts).toHaveLength(2);
    expect(lif.layouts[0]!.nodes).toHaveLength(3);
    expect(byCode(diagnostics, "LIF-P003").length).toBeGreaterThanOrEqual(12);
    // Every diagnostic carries a non-empty path or points at the root.
    for (const d of diagnostics) {
      expect(typeof d.path).toBe("string");
      expect(d.message.length).toBeGreaterThan(0);
    }
  });

  test("boolean-ish and number-ish strings in unusual places coerce with warnings", () => {
    const { lif, diagnostics } = parseLif({
      metaInformation: {
        projectIdentification: "x",
        creator: "x",
        exportTimestamp: "x",
        lifVersion: 1.0,
      },
      layouts: [
        {
          layoutId: "l",
          layoutVersion: "1",
          nodes: [],
          edges: [
            {
              edgeId: "e",
              startNodeId: "a",
              endNodeId: "b",
              vehicleTypeEdgeProperties: [
                {
                  vehicleTypeId: "t",
                  rotationAllowed: true,
                  reentryAllowed: "false",
                  trajectory: {
                    degree: "2",
                    knotVector: [0, 0, "0.5", 1, 1],
                    controlPoints: [
                      { x: 0, y: 0, weight: "2" },
                      { x: 1, y: 1 },
                    ],
                  },
                },
              ],
            },
          ],
          stations: [],
        },
      ],
    });
    expect(hasErrors(diagnostics)).toBe(false);
    expect(lif.metaInformation.lifVersion).toBe("1");
    const prop = lif.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!;
    expect(prop.reentryAllowed).toBe(false);
    expect(prop.trajectory!.degree).toBe(2);
    expect(prop.trajectory!.knotVector).toEqual([0, 0, 0.5, 1, 1]);
    expect(prop.trajectory!.controlPoints[0]!.weight).toBe(2);
  });
});

describe("parseLif normalizations (guideline errata)", () => {
  test("quirks fixture: every quirk is normalized with a warning, none is an error", async () => {
    const { lif, diagnostics } = parseLif(await loadFixture("quirks-legacy.lif.json"));
    expect(hasErrors(diagnostics)).toBe(false);

    // stationHeight "0.55" → 0.55 (guideline examples serialize it as string)
    const station = lif.layouts[1]!.stations[0]!;
    expect(station.stationHeight).toBe(0.55);

    // legacy `required: true` → requirementType REQUIRED (draft-0.11.0 leftover)
    const action = lif.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.actions![0]!;
    expect(action.requirementType).toBe("REQUIRED");
    expect((action as LifAction & { required?: unknown }).required).toBeUndefined();
    expect(byCode(diagnostics, "LIF-P005")).toHaveLength(1);

    // missing stations array → [] with warning
    expect(lif.layouts[0]!.stations).toEqual([]);
    expect(byCode(diagnostics, "LIF-P006")).toHaveLength(1);

    // numeric strings coerced: theta, x, maxSpeed, layoutVersion, rotationAllowed
    expect(lif.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.theta).toBeCloseTo(Math.PI / 2);
    expect(lif.layouts[0]!.nodes[1]!.nodePosition.x).toBe(6.5);
    expect(lif.layouts[0]!.layoutVersion).toBe("1");
    const prop = lif.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!;
    expect(prop.rotationAllowed).toBe(false);
    expect(prop.maxSpeed).toBe(1.2);
    expect(byCode(diagnostics, "LIF-P004").length).toBeGreaterThanOrEqual(5);
  });

  test("an action with both legacy 'required' and requirementType warns and keeps requirementType", () => {
    const { lif, diagnostics } = parseLif({
      metaInformation: { projectIdentification: "x", creator: "x", exportTimestamp: "x", lifVersion: "1.0.0" },
      layouts: [
        {
          layoutId: "l",
          layoutVersion: "1",
          nodes: [
            {
              nodeId: "n",
              nodePosition: { x: 0, y: 0 },
              vehicleTypeNodeProperties: [
                {
                  vehicleTypeId: "t",
                  actions: [{ actionType: "pick", required: false, requirementType: "CONDITIONAL", blockingType: "HARD" }],
                },
              ],
            },
          ],
          edges: [],
          stations: [],
        },
      ],
    });
    expect(byCode(diagnostics, "LIF-P008")).toHaveLength(1);
    const action = lif.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties[0]!.actions![0]!;
    expect(action.requirementType).toBe("CONDITIONAL");
    expect((action as LifAction & { required?: unknown }).required).toBe(false);
  });

  test("unknown vendor fields survive parse and serialize", async () => {
    const { lif } = parseLif(await loadFixture("quirks-legacy.lif.json"));
    const layout = lif.layouts[0] as unknown as Record<string, unknown>;
    expect(layout["x-vendor-extension"]).toEqual({ sourceTool: "PlannerX 9.1" });
    const reparsed = JSON.parse(serializeLif(lif));
    expect(reparsed.layouts[0]["x-vendor-extension"]).toEqual({ sourceTool: "PlannerX 9.1" });
  });
});

describe("round-trip", () => {
  for (const name of ["minimal.lif.json", "warehouse.lif.json"]) {
    test(`${name} is lossless through parse → serialize → parse`, async () => {
      const original = parseLif(await loadFixture(name));
      const reparsed = parseLif(serializeLif(original.lif));
      expect(reparsed.lif).toEqual(original.lif);
      expect(reparsed.diagnostics).toEqual([]);
    });
  }

  test("normalized quirks document is stable through a second round-trip", async () => {
    const first = parseLif(await loadFixture("quirks-legacy.lif.json"));
    const second = parseLif(serializeLif(first.lif));
    // After normalization there is nothing left to warn about.
    expect(second.diagnostics).toEqual([]);
    expect(second.lif).toEqual(first.lif);
  });
});
