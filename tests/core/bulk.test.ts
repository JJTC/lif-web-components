import { describe, expect, test } from "bun:test";
import {
  addVehicleTypeToElements,
  removeElements,
  removeVehicleTypeFromElements,
  updateEdgePropertiesBulk,
  type Lif,
} from "../../src/lif";

function doc(): Lif {
  return {
    metaInformation: {
      projectIdentification: "bulk-test",
      creator: "test",
      exportTimestamp: "2026-07-09T00:00:00Z",
      lifVersion: "1.0.0",
    },
    layouts: [
      {
        layoutId: "L",
        layoutVersion: "1",
        nodes: [
          {
            nodeId: "n1",
            nodePosition: { x: 0, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
          },
          {
            nodeId: "n2",
            nodePosition: { x: 2, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
          },
          {
            nodeId: "n3",
            nodePosition: { x: 4, y: 0 },
            vehicleTypeNodeProperties: [{ vehicleTypeId: "t" }],
          },
        ],
        edges: [
          {
            edgeId: "e12",
            startNodeId: "n1",
            endNodeId: "n2",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "t", rotationAllowed: false, maxSpeed: 1 }],
          },
          {
            edgeId: "e23",
            startNodeId: "n2",
            endNodeId: "n3",
            vehicleTypeEdgeProperties: [{ vehicleTypeId: "other", rotationAllowed: false }],
          },
        ],
        stations: [
          { stationId: "s1", interactionNodeIds: ["n1"] },
          { stationId: "s2", interactionNodeIds: ["n3"] },
        ],
      },
    ],
  };
}

describe("bulk operations", () => {
  test("addVehicleTypeToElements fills only listed elements lacking the type", () => {
    const next = addVehicleTypeToElements(
      doc(),
      { nodeIds: ["n1", "n2"], edgeIds: ["e23"] },
      "t",
      { edge: { rotationAllowed: true, maxSpeed: 0.5 } },
    );
    const layout = next.layouts[0]!;
    // n1 already had it: untouched. n3 not listed: untouched.
    expect(layout.nodes[0]!.vehicleTypeNodeProperties).toHaveLength(1);
    expect(layout.nodes[2]!.vehicleTypeNodeProperties).toHaveLength(1);
    expect(layout.edges[1]!.vehicleTypeEdgeProperties).toContainEqual({
      vehicleTypeId: "t",
      rotationAllowed: true,
      maxSpeed: 0.5,
    });
    expect(() => addVehicleTypeToElements(doc(), { nodeIds: ["ghost"] }, "t")).toThrow(
      'node "ghost" not found',
    );
  });

  test("removeVehicleTypeFromElements strips only the listed elements", () => {
    const next = removeVehicleTypeFromElements(doc(), { nodeIds: ["n1"], edgeIds: ["e12"] }, "t");
    const layout = next.layouts[0]!;
    expect(layout.nodes[0]!.vehicleTypeNodeProperties).toEqual([]);
    expect(layout.nodes[1]!.vehicleTypeNodeProperties).toHaveLength(1); // not listed
    expect(layout.edges[0]!.vehicleTypeEdgeProperties).toEqual([]);
  });

  test("updateEdgePropertiesBulk clones object-valued patch fields per edge", () => {
    const trajectory = {
      degree: 1,
      knotVector: [0, 0, 1, 1],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
    };
    const next = updateEdgePropertiesBulk(doc(), ["e12"], "t", { trajectory });
    const applied = next.layouts[0]!.edges[0]!.vehicleTypeEdgeProperties[0]!.trajectory!;
    expect(applied).toEqual(trajectory);
    expect(applied).not.toBe(trajectory); // no aliasing with the caller's patch
    trajectory.controlPoints[0]!.x = 99;
    expect(applied.controlPoints[0]!.x).toBe(0); // mutation does not leak in
  });

  test("removeElements leaves stations that were already empty untouched", () => {
    const d = doc();
    d.layouts[0]!.stations.push({ stationId: "s-empty", interactionNodeIds: [] });
    // Removing an edge triggers no station cascade at all.
    const next = removeElements(d, { edgeIds: ["e12"] });
    expect(next.layouts[0]!.stations.map((s) => s.stationId)).toEqual(["s1", "s2", "s-empty"]);
  });

  test("updateEdgePropertiesBulk merges into existing entries only", () => {
    const before = doc();
    const next = updateEdgePropertiesBulk(before, ["e12", "e23"], "t", {
      maxSpeed: 2.5,
      rotationAllowed: true,
    });
    expect(before).toEqual(doc()); // pure
    const [e12, e23] = next.layouts[0]!.edges;
    expect(e12!.vehicleTypeEdgeProperties[0]).toEqual({
      vehicleTypeId: "t",
      rotationAllowed: true,
      maxSpeed: 2.5,
    });
    // e23 has no "t" entry: untouched (adding is a separate, explicit act).
    expect(e23!.vehicleTypeEdgeProperties).toEqual([
      { vehicleTypeId: "other", rotationAllowed: false },
    ]);
  });

  test("removeElements deletes in one step with the removeNode cascade", () => {
    const next = removeElements(doc(), { nodeIds: ["n1"], edgeIds: ["e23"], stationIds: ["s2"] });
    const layout = next.layouts[0]!;
    expect(layout.nodes.map((n) => n.nodeId)).toEqual(["n2", "n3"]);
    // e12 went with n1 (cascade), e23 was listed.
    expect(layout.edges).toEqual([]);
    // s1 lost its only interaction node (n1) and is pruned; s2 was listed.
    expect(layout.stations).toEqual([]);
  });
});
