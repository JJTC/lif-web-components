import { describe, expect, test } from "bun:test";
import {
  addVehicleTypeEverywhere,
  analyzeLif,
  listVehicleTypes,
  removeVehicleType,
  renameVehicleType,
  vehicleTypeCoverage,
  type Lif,
} from "../../src/lif";
import warehouseJson from "../../fixtures/warehouse.lif.json";

/** Two-layout doc: type "a" everywhere, type "b" only on the first node. */
function sampleDoc(): Lif {
  return {
    metaInformation: {
      projectIdentification: "types-test",
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
            vehicleTypeNodeProperties: [{ vehicleTypeId: "a" }, { vehicleTypeId: "b" }],
          },
          {
            nodeId: "n2",
            nodePosition: { x: 2, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "a" }],
          },
        ],
        edges: [
          {
            edgeId: "e1",
            startNodeId: "n1",
            endNodeId: "n2",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "a", rotationAllowed: true }],
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
            nodePosition: { x: 0, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "a" }],
          },
        ],
        edges: [],
        stations: [],
      },
    ],
  };
}

describe("vehicle type operations", () => {
  test("listVehicleTypes derives the sorted roster from node and edge properties", () => {
    expect(listVehicleTypes(sampleDoc())).toEqual(["a", "b"]);
  });

  test("vehicleTypeCoverage counts document-wide usage", () => {
    expect(vehicleTypeCoverage(sampleDoc())).toEqual([
      { vehicleTypeId: "a", nodesWithType: 3, edgesWithType: 1, totalNodes: 3, totalEdges: 1 },
      { vehicleTypeId: "b", nodesWithType: 1, edgesWithType: 0, totalNodes: 3, totalEdges: 1 },
    ]);
  });

  test("renameVehicleType sweeps every property entry and validates ids", () => {
    const doc = sampleDoc();
    const before = structuredClone(doc);
    const renamed = renameVehicleType(doc, "a", "acme.mk2");
    expect(doc).toEqual(before); // pure op
    expect(listVehicleTypes(renamed)).toEqual(["acme.mk2", "b"]);
    expect(renamed.layouts[1]!.nodes[0]!.vehicleTypeNodeProperties[0]!.vehicleTypeId).toBe(
      "acme.mk2",
    );
    expect(renamed.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.vehicleTypeId).toBe(
      "acme.mk2",
    );
    expect(() => renameVehicleType(doc, "nope", "x")).toThrow('vehicle type "nope" not found');
    expect(() => renameVehicleType(doc, "a", "b")).toThrow('vehicle type "b" already exists');
    expect(() => renameVehicleType(doc, "a", "")).toThrow("must not be empty");
  });

  test("removeVehicleType strips the type everywhere (validation flags empty arrays)", () => {
    const removed = removeVehicleType(sampleDoc(), "a");
    expect(listVehicleTypes(removed)).toEqual(["b"]);
    expect(removed.layouts[0]!.nodes[1]!.vehicleTypeNodeProperties).toEqual([]);
    expect(removed.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties).toEqual([]);
    expect(() => removeVehicleType(sampleDoc(), "nope")).toThrow("not found");
  });

  test("addVehicleTypeEverywhere fills gaps only, with defaults", () => {
    const added = addVehicleTypeEverywhere(sampleDoc(), "b", {
      node: { theta: 1.5 },
      edge: { rotationAllowed: true, maxSpeed: 0.8 },
    });
    // n1 already had "b" — untouched (no theta added).
    expect(added.layouts[0]!.nodes[0]!.vehicleTypeNodeProperties).toEqual([
      { vehicleTypeId: "a" },
      { vehicleTypeId: "b" },
    ]);
    expect(added.layouts[0]!.nodes[1]!.vehicleTypeNodeProperties).toContainEqual({
      vehicleTypeId: "b",
      theta: 1.5,
    });
    expect(added.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties).toContainEqual({
      vehicleTypeId: "b",
      rotationAllowed: true,
      maxSpeed: 0.8,
    });
    const coverage = vehicleTypeCoverage(added).find((c) => c.vehicleTypeId === "b")!;
    expect(coverage).toMatchObject({ nodesWithType: 3, edgesWithType: 1 });
    // Brand-new type, no defaults: edge entries still get the required rotationAllowed.
    const fresh = addVehicleTypeEverywhere(sampleDoc(), "c");
    expect(fresh.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties).toContainEqual({
      vehicleTypeId: "c",
      rotationAllowed: false,
    });
  });
});

describe("analyzeLif (LIF-A0xx network analysis)", () => {
  test("reports coverage gaps as info (A001 nodes, A002 edges)", () => {
    const diagnostics = analyzeLif(sampleDoc());
    const a001 = diagnostics.filter((d) => d.code === "LIF-A001");
    expect(a001).toHaveLength(1);
    expect(a001[0]).toMatchObject({ severity: "info", path: "layouts[0]" });
    expect(a001[0]!.message).toContain('"b" cannot use 1 of 2 nodes');
    expect(a001[0]!.message).toContain("n2");
    const a002 = diagnostics.filter((d) => d.code === "LIF-A002");
    expect(a002).toHaveLength(1);
    expect(a002[0]!.message).toContain('"b" cannot use 1 of 1 edges');
    // Type "a" covers everything: no coverage advisories for it (its one-way
    // trap at n2 is a topology finding, asserted in the next test).
    const coverageCodes = ["LIF-A001", "LIF-A002"];
    expect(
      diagnostics.filter((d) => coverageCodes.includes(d.code) && d.message.includes('"a"')),
    ).toEqual([]);
  });

  test("flags disconnected islands (A003) and one-way traps (A004)", () => {
    const doc = sampleDoc();
    const layout = doc.layouts[0]!;
    // Extend: n3/n4 form a second island for type "a"; e1 (n1→n2) is one-way,
    // so n2 is enterable but not leavable.
    layout.nodes.push(
      {
        nodeId: "n3",
        nodePosition: { x: 10, y: 0 },
        vehicleTypeNodeProperties: [{ vehicleTypeId: "a" }],
      },
      {
        nodeId: "n4",
        nodePosition: { x: 12, y: 0 },
        vehicleTypeNodeProperties: [{ vehicleTypeId: "a" }],
      },
    );
    layout.edges.push(
      {
        edgeId: "e2",
        startNodeId: "n3",
        endNodeId: "n4",
        vehicleTypeEdgeProperties: [{ vehicleTypeId: "a", rotationAllowed: true }],
      },
      {
        edgeId: "e3",
        startNodeId: "n4",
        endNodeId: "n3",
        vehicleTypeEdgeProperties: [{ vehicleTypeId: "a", rotationAllowed: true }],
      },
    );
    const diagnostics = analyzeLif(doc);
    const a003 = diagnostics.filter((d) => d.code === "LIF-A003" && d.message.includes('"a"'));
    expect(a003).toHaveLength(1);
    expect(a003[0]).toMatchObject({ severity: "warning", path: "layouts[0]" });
    expect(a003[0]!.message).toContain("2 disconnected parts (2 + 2 nodes)");
    const a004 = diagnostics.filter((d) => d.code === "LIF-A004" && d.message.includes('"a"'));
    expect(a004).toHaveLength(1);
    expect(a004[0]!.message).toContain('can enter node "n2"');
    expect(a004[0]!.path).toBe("layouts[0].nodes[1]");
  });

  test("a type on edges but no nodes is flagged (A005), not silently skipped", () => {
    const doc = sampleDoc();
    doc.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties.push({
      vehicleTypeId: "ghost",
      rotationAllowed: false,
    });
    const findings = analyzeLif(doc).filter((d) => d.code === "LIF-A005");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", path: "layouts[0]" });
    expect(findings[0]!.message).toContain('"ghost" appears on 1 edge');
    expect(findings[0]!.message).toContain("e1");
  });

  test("a self-loop does not mask a one-way trap (A004)", () => {
    const doc = sampleDoc();
    // e1 is n1→n2 one-way; a self-loop at n2 must not count as an exit.
    doc.layouts[0]!.edges.push({
      edgeId: "e-self",
      startNodeId: "n2",
      endNodeId: "n2",
      vehicleTypeEdgeProperties: [{ vehicleTypeId: "a", rotationAllowed: true }],
    });
    const traps = analyzeLif(doc).filter(
      (d) => d.code === "LIF-A004" && d.message.includes('"a"'),
    );
    expect(traps).toHaveLength(1);
    expect(traps[0]!.message).toContain('can enter node "n2"');
  });

  test("a fully covered, well-connected network yields no advisories", () => {
    const doc = sampleDoc();
    const layout = doc.layouts[0]!;
    layout.nodes[1]!.vehicleTypeNodeProperties.push({ vehicleTypeId: "b" });
    layout.edges[0]!.vehicleTypeEdgeProperties.push({ vehicleTypeId: "b", rotationAllowed: true });
    // Close the loop so nothing is a trap for either type.
    layout.edges.push({
      edgeId: "e-back",
      startNodeId: "n2",
      endNodeId: "n1",
      vehicleTypeEdgeProperties: [
        { vehicleTypeId: "a", rotationAllowed: true },
        { vehicleTypeId: "b", rotationAllowed: true },
      ],
    });
    expect(analyzeLif(doc)).toEqual([]);
  });

  test("runs clean over the warehouse fixture (smoke)", () => {
    const diagnostics = analyzeLif(warehouseJson as unknown as Lif);
    // Advisories are allowed; hard errors are not what analysis produces.
    expect(diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });
});
