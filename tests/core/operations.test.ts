import { describe, expect, test } from "bun:test";
import {
  addEdge,
  addLayout,
  addNode,
  addStation,
  createEmptyLif,
  findEdge,
  findLayout,
  findNode,
  findStation,
  generateNodeGrid,
  hasErrors,
  moveNode,
  parseLif,
  removeEdge,
  removeLayout,
  renameLayout,
  updateLayout,
  removeNode,
  removeStation,
  renameEdge,
  renameNode,
  renameStation,
  replaceEdge,
  replaceNode,
  replaceStation,
  touchExportTimestamp,
  updateEdge,
  updateMetaInformation,
  updateNode,
  updateStation,
  validateLif,
  type Lif,
  type LifNode,
} from "../../src/lif";
import { loadFixture } from "./helpers";

async function warehouse(): Promise<Lif> {
  const { lif, diagnostics } = parseLif(await loadFixture("warehouse.lif.json"));
  expect(diagnostics).toEqual([]);
  return lif;
}

function node(nodeId: string, x: number, y: number): LifNode {
  return {
    nodeId,
    nodePosition: { x, y },
    vehicleTypeNodeProperties: [{ vehicleTypeId: "acme.tugger" }],
  };
}

describe("createEmptyLif", () => {
  test("produces a structurally valid document", () => {
    const lif = createEmptyLif("Test project", "tester", new Date("2026-07-06T12:00:00Z"));
    expect(lif.metaInformation.exportTimestamp).toBe("2026-07-06T12:00:00.000Z");
    expect(lif.metaInformation.lifVersion).toBe("1.0.0");
    const diagnostics = validateLif(lif);
    expect(hasErrors(diagnostics)).toBe(false); // only the empty-layout warning
    expect(diagnostics.map((d) => d.code)).toEqual(["LIF-V022"]);
  });
});

describe("operations are pure", () => {
  test("the input document is never mutated", async () => {
    const lif = await warehouse();
    const before = JSON.stringify(lif);
    addNode(lif, "ground", node("n-new", 1, 1));
    moveNode(lif, "n-dock", 9, 9);
    removeNode(lif, "n-pick");
    renameNode(lif, "n-dock", "n-dock2");
    removeEdge(lif, "e-west-east");
    updateStation(lif, "st-pick", { stationName: "changed" });
    touchExportTimestamp(lif);
    expect(JSON.stringify(lif)).toBe(before);
  });
});

describe("node operations", () => {
  test("addNode adds to the requested layout and rejects duplicates", async () => {
    const lif = await warehouse();
    const next = addNode(lif, "mezzanine", node("n-new", 5, 5));
    expect(findNode(next, "n-new")!.layout.layoutId).toBe("mezzanine");
    expect(() => addNode(next, "ground", node("n-new", 0, 0))).toThrow("already exists");
    expect(() => addNode(lif, "nope", node("n-x", 0, 0))).toThrow('layout "nope" not found');
  });

  test("moveNode updates coordinates", async () => {
    const lif = await warehouse();
    const next = moveNode(lif, "n-dock", 1.25, -2.5);
    expect(findNode(next, "n-dock")!.node.nodePosition).toEqual({ x: 1.25, y: -2.5 });
  });

  test("updateNode shallow-merges a patch", async () => {
    const lif = await warehouse();
    const next = updateNode(lif, "n-dock", { nodeName: "Dock 1", mapId: "map-g2" });
    const updated = findNode(next, "n-dock")!.node;
    expect(updated.nodeName).toBe("Dock 1");
    expect(updated.mapId).toBe("map-g2");
    expect(updated.nodePosition).toEqual({ x: 0, y: 0 });
  });

  test("removeNode cascades to edges and station references", async () => {
    const lif = await warehouse();
    const next = removeNode(lif, "n-pick");
    expect(findNode(next, "n-pick")).toBeUndefined();
    // Both edges touching n-pick are gone.
    expect(findEdge(next, "e-west-pick")).toBeUndefined();
    expect(findEdge(next, "e-pick-west")).toBeUndefined();
    // st-pick only interacted with n-pick and is removed with it.
    expect(findStation(next, "st-pick")).toBeUndefined();
    // The result is still semantically clean (plus the pre-existing lift-edge info).
    expect(hasErrors(validateLif(next))).toBe(false);
  });

  test("removeNode keeps stations that still have other interaction nodes", async () => {
    const lif = await warehouse();
    const next = removeNode(lif, "n-buf-a");
    const handover = findStation(next, "st-handover")!.station;
    expect(handover.interactionNodeIds).toEqual(["n-buf-b"]);
  });

  test("removeNode leaves stations that were already empty untouched", async () => {
    const lif = await warehouse();
    lif.layouts[0]!.stations.push({ stationId: "st-preexisting-empty", interactionNodeIds: [] });
    const next = removeNode(lif, "n-pick");
    // The cascade prunes st-pick (emptied by this removal), not the one that
    // was already empty — that is the validator's finding, not ours.
    expect(findStation(next, "st-preexisting-empty")).toBeDefined();
    expect(findStation(next, "st-pick")).toBeUndefined();
  });

  test("renameNode rewrites edge and station references across layouts", async () => {
    const lif = await warehouse();
    const next = renameNode(lif, "n-lift-m", "n-lift-upper");
    expect(findNode(next, "n-lift-m")).toBeUndefined();
    // Cross-layout edge in "ground" now points at the renamed node.
    expect(findEdge(next, "e-lift-up")!.edge.endNodeId).toBe("n-lift-upper");
    expect(findEdge(next, "e-lift-buf-a")!.edge.startNodeId).toBe("n-lift-upper");
    expect(hasErrors(validateLif(next))).toBe(false);
    expect(() => renameNode(lif, "n-dock", "n-charge")).toThrow("already exists");
  });
});

describe("layout operations", () => {
  test("addLayout and removeLayout", async () => {
    const lif = await warehouse();
    const added = addLayout(lif, {
      layoutId: "basement",
      layoutVersion: "1",
      nodes: [],
      edges: [],
      stations: [],
    });
    expect(added.layouts.map((l) => l.layoutId)).toEqual(["ground", "mezzanine", "basement"]);
    expect(() => addLayout(added, added.layouts[0]!)).toThrow("already exists");

    const removed = removeLayout(added, "basement");
    expect(findLayout(removed, "basement")).toBeUndefined();
    expect(removed.layouts).toHaveLength(2);
    expect(() => removeLayout(removed, "basement")).toThrow("not found");
  });

  test("removing a layout that other layouts reference leaves findings for the validator", async () => {
    const lif = await warehouse();
    const removed = removeLayout(lif, "mezzanine");
    const diagnostics = validateLif(removed);
    // The ground layout's lift edge now points into the void.
    expect(diagnostics.some((d) => d.code === "LIF-V006")).toBe(true);
  });
});

describe("layout metadata and grid generation", () => {
  test("updateLayout patches metadata; renameLayout changes the id with duplicate protection", async () => {
    const lif = await warehouse();
    const updated = updateLayout(lif, "ground", { layoutName: "Hall A", layoutLevelId: "EG" });
    const layout = findLayout(updated, "ground")!;
    expect(layout.layoutName).toBe("Hall A");
    expect(layout.layoutLevelId).toBe("EG");
    expect(layout.nodes.length).toBeGreaterThan(0); // collections untouched

    const renamed = renameLayout(lif, "ground", "hall-a");
    expect(findLayout(renamed, "ground")).toBeUndefined();
    expect(findLayout(renamed, "hall-a")!.nodes.length).toBeGreaterThan(0);
    expect(() => renameLayout(lif, "ground", "mezzanine")).toThrow("already exists");
  });

  test("generateNodeGrid produces a row-major grid with the requested geometry", () => {
    const lif = createEmptyLif();
    const next = generateNodeGrid(lif, "layout-1", {
      xCount: 3,
      yCount: 2,
      spacing: 1.5,
      startX: 10,
      startY: -2,
      idPrefix: "g",
      mapId: "map-1",
      vehicleTypeId: "demo.tugger",
      connect: "NONE",
    });
    const layout = next.layouts[0]!;
    expect(layout.nodes).toHaveLength(6);
    expect(layout.edges).toHaveLength(0);
    expect(findNode(next, "g1")!.node.nodePosition).toEqual({ x: 10, y: -2 });
    expect(findNode(next, "g3")!.node.nodePosition).toEqual({ x: 13, y: -2 });
    expect(findNode(next, "g4")!.node.nodePosition).toEqual({ x: 10, y: -0.5 });
    expect(findNode(next, "g6")!.node.nodePosition).toEqual({ x: 13, y: -0.5 });
    expect(findNode(next, "g1")!.node.mapId).toBe("map-1");
    expect(hasErrors(validateLif(next))).toBe(false);
  });

  test("SINGLE connects each neighbour pair once, DOUBLE twice", () => {
    const lif = createEmptyLif();
    // 3x3 grid has 12 neighbour adjacencies.
    const single = generateNodeGrid(lif, "layout-1", {
      xCount: 3, yCount: 3, spacing: 1, startX: 0, startY: 0,
      idPrefix: "s", vehicleTypeId: "t", connect: "SINGLE",
    });
    expect(single.layouts[0]!.edges).toHaveLength(12);

    const double = generateNodeGrid(lif, "layout-1", {
      xCount: 3, yCount: 3, spacing: 1, startX: 0, startY: 0,
      idPrefix: "d", vehicleTypeId: "t", connect: "DOUBLE",
    });
    expect(double.layouts[0]!.edges).toHaveLength(24);
    expect(hasErrors(validateLif(double))).toBe(false);
  });

  test("generateNodeGrid merges edgeDefaults into every generated edge", () => {
    const next = generateNodeGrid(createEmptyLif(), "layout-1", {
      xCount: 2, yCount: 1, spacing: 1, startX: 0, startY: 0,
      idPrefix: "p", vehicleTypeId: "veh.one", connect: "DOUBLE",
      edgeDefaults: { maxSpeed: 1.2, rotationAllowed: true, orientationType: "GLOBAL" },
    });
    for (const edge of next.layouts[0]!.edges) {
      expect(edge.vehicleTypeEdgeProperties[0]).toMatchObject({
        vehicleTypeId: "veh.one",
        maxSpeed: 1.2,
        rotationAllowed: true,
        orientationType: "GLOBAL",
      });
    }
  });

  test("generateNodeGrid rejects id collisions and invalid parameters", () => {
    const base = generateNodeGrid(createEmptyLif(), "layout-1", {
      xCount: 2, yCount: 1, spacing: 1, startX: 0, startY: 0,
      idPrefix: "n", vehicleTypeId: "t", connect: "NONE",
    });
    expect(() =>
      generateNodeGrid(base, "layout-1", {
        xCount: 1, yCount: 1, spacing: 1, startX: 5, startY: 5,
        idPrefix: "n", vehicleTypeId: "t", connect: "NONE",
      }),
    ).toThrow("already exists");
    expect(() =>
      generateNodeGrid(base, "layout-1", {
        xCount: 0, yCount: 1, spacing: 1, startX: 0, startY: 0,
        idPrefix: "x", vehicleTypeId: "t", connect: "NONE",
      }),
    ).toThrow("positive integers");
    expect(() =>
      generateNodeGrid(base, "layout-1", {
        xCount: 1, yCount: 1, spacing: 0, startX: 0, startY: 0,
        idPrefix: "x", vehicleTypeId: "t", connect: "NONE",
      }),
    ).toThrow("spacing");
  });
});

describe("edge and station operations", () => {
  test("addEdge/updateEdge/removeEdge", async () => {
    const lif = await warehouse();
    const added = addEdge(lif, "ground", {
      edgeId: "e-charge-east",
      startNodeId: "n-charge",
      endNodeId: "n-aisle-e",
      vehicleTypeEdgeProperties: [{ vehicleTypeId: "acme.tugger", rotationAllowed: false }],
    });
    expect(findEdge(added, "e-charge-east")!.layout.layoutId).toBe("ground");
    expect(hasErrors(validateLif(added))).toBe(false);

    const updated = updateEdge(added, "e-charge-east", { edgeName: "Return lane" });
    expect(findEdge(updated, "e-charge-east")!.edge.edgeName).toBe("Return lane");

    const removed = removeEdge(updated, "e-charge-east");
    expect(findEdge(removed, "e-charge-east")).toBeUndefined();
    expect(() => removeEdge(removed, "e-charge-east")).toThrow("not found");
  });

  test("addStation/updateStation/removeStation", async () => {
    const lif = await warehouse();
    const added = addStation(lif, "ground", {
      stationId: "st-dock",
      interactionNodeIds: ["n-dock"],
      stationName: "Dock handover",
    });
    expect(findStation(added, "st-dock")!.layout.layoutId).toBe("ground");
    expect(hasErrors(validateLif(added))).toBe(false);
    expect(() => addStation(added, "ground", { stationId: "st-dock", interactionNodeIds: ["n-dock"] })).toThrow(
      "already exists",
    );

    const updated = updateStation(added, "st-dock", { stationHeight: 0.2 });
    expect(findStation(updated, "st-dock")!.station.stationHeight).toBe(0.2);

    const removed = removeStation(updated, "st-dock");
    expect(findStation(removed, "st-dock")).toBeUndefined();
  });

  test("renameEdge and renameStation change only the id and reject duplicates", async () => {
    const lif = await warehouse();
    const e = renameEdge(lif, "e-west-east", "e-main-aisle");
    expect(findEdge(e, "e-west-east")).toBeUndefined();
    expect(findEdge(e, "e-main-aisle")!.edge.startNodeId).toBe("n-aisle-w");
    expect(() => renameEdge(lif, "e-west-east", "e-east-west")).toThrow("already exists");
    expect(() => renameEdge(lif, "nope", "x")).toThrow("not found");

    const s = renameStation(lif, "st-pick", "st-pick-face-a");
    expect(findStation(s, "st-pick")).toBeUndefined();
    expect(findStation(s, "st-pick-face-a")!.station.stationName).toBe("Pick face A");
    expect(() => renameStation(lif, "st-pick", "st-charge")).toThrow("already exists");
  });

  test("replaceNode/replaceEdge/replaceStation swap the element wholesale", async () => {
    const lif = await warehouse();
    const node = structuredClone(findNode(lif, "n-dock")!.node);
    node.nodeDescription = "replaced";
    delete node.nodeName; // wholesale replace can drop fields, unlike a patch
    const withNode = replaceNode(lif, "n-dock", node);
    const replaced = findNode(withNode, "n-dock")!.node;
    expect(replaced.nodeDescription).toBe("replaced");
    expect(replaced.nodeName).toBeUndefined();
    expect(() => replaceNode(lif, "n-dock", { ...node, nodeId: "other" })).toThrow(
      "rename explicitly",
    );

    const edge = structuredClone(findEdge(lif, "e-west-east")!.edge);
    edge.vehicleTypeEdgeProperties[0]!.maxSpeed = 0.9;
    expect(
      findEdge(replaceEdge(lif, "e-west-east", edge), "e-west-east")!.edge
        .vehicleTypeEdgeProperties[0]!.maxSpeed,
    ).toBe(0.9);
    expect(() => replaceEdge(lif, "e-west-east", { ...edge, edgeId: "x" })).toThrow(
      "rename explicitly",
    );

    const station = structuredClone(findStation(lif, "st-charge")!.station);
    station.stationHeight = 1.5;
    expect(
      findStation(replaceStation(lif, "st-charge", station), "st-charge")!.station.stationHeight,
    ).toBe(1.5);
    expect(() => replaceStation(lif, "st-charge", { ...station, stationId: "x" })).toThrow(
      "rename explicitly",
    );
  });

  test("updateMetaInformation merges a patch", async () => {
    const lif = await warehouse();
    const next = updateMetaInformation(lif, { creator: "someone else" });
    expect(next.metaInformation.creator).toBe("someone else");
    expect(next.metaInformation.projectIdentification).toBe("Nordhavn Plant AGV");
  });

  test("touchExportTimestamp only changes the timestamp", async () => {
    const lif = await warehouse();
    const next = touchExportTimestamp(lif, new Date("2026-12-24T18:30:00Z"));
    expect(next.metaInformation.exportTimestamp).toBe("2026-12-24T18:30:00.000Z");
    expect({ ...next.metaInformation, exportTimestamp: "x" }).toEqual({
      ...lif.metaInformation,
      exportTimestamp: "x",
    });
  });
});
