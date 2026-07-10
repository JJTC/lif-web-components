import { describe, expect, test } from "bun:test";
import {
  factsheetToVehicleProfile,
  orderToRoute,
  stateToVehicle,
  visualizationToVehicle,
  type Vda5050Factsheet,
  type Vda5050Order,
  type Vda5050State,
  type Vda5050Visualization,
} from "../../src/vda5050";
import type { LifVehicle } from "../../src/components/lif-viewer";
import stateJson from "../../fixtures/vda5050-state.json";
import visualizationJson from "../../fixtures/vda5050-visualization.json";
import factsheetJson from "../../fixtures/vda5050-factsheet.json";
import orderJson from "../../fixtures/vda5050-order.json";

const state = stateJson as Vda5050State;
const visualization = visualizationJson as Vda5050Visualization;
const factsheet = factsheetJson as Vda5050Factsheet;
const order = orderJson as Vda5050Order;

describe("stateToVehicle", () => {
  test("maps identity, pose and status from a full state message", () => {
    const v = stateToVehicle(state);
    expect(v).not.toBeNull();
    expect(v!.vehicleId).toBe("acme-robotics/tugger-042");
    expect(v!.label).toBe("tugger-042");
    expect(v!.manufacturer).toBe("acme-robotics");
    expect(v!.serialNumber).toBe("tugger-042");
    expect(v!.x).toBe(8.35);
    expect(v!.y).toBe(2.1);
    expect(v!.theta).toBeCloseTo(Math.PI / 2, 10);
    expect(v!.mapId).toBe("map-ground");
    expect(v!.batteryCharge).toBe(73.5);
    expect(v!.charging).toBe(false);
    expect(v!.driving).toBe(true);
    expect(v!.paused).toBe(false);
    expect(v!.operatingMode).toBe("AUTOMATIC");
    expect(v!.orderId).toBe("order-7f3a");
    expect(v!.lastNodeId).toBe("n-aisle-w");
    expect(v!.errors).toHaveLength(1);
    expect(v!.errors![0]!.errorLevel).toBe("WARNING");
    expect(v!.loads).toHaveLength(1);
    expect(v!.loads![0]!.loadId).toBe("pallet-9931");
    expect(v!.velocity?.vx).toBe(1.1);
    // The result feeds viewer.vehicles directly.
    const vehicles: LifVehicle[] = [v!];
    expect(vehicles[0]!.vehicleId).toBe("acme-robotics/tugger-042");
  });

  test("overrides win last: host assigns vehicleTypeId, layoutId and label", () => {
    const v = stateToVehicle(state, {
      vehicleTypeId: "acme.tugger",
      layoutId: "ground",
      label: "Tugger 42",
    });
    expect(v!.vehicleTypeId).toBe("acme.tugger");
    expect(v!.layoutId).toBe("ground");
    expect(v!.label).toBe("Tugger 42");
    expect(v!.x).toBe(8.35);
  });

  test("returns null without a usable position", () => {
    const { agvPosition: _dropped, ...noPosition } = state;
    expect(stateToVehicle(noPosition)).toBeNull();
    expect(
      stateToVehicle({
        ...state,
        agvPosition: { ...state.agvPosition!, positionInitialized: false },
      }),
    ).toBeNull();
  });

  test('normalizes the wire convention: empty orderId/lastNodeId mean "none"', () => {
    const idle = stateToVehicle({ ...state, orderId: "", lastNodeId: "" });
    expect(idle!.orderId).toBeUndefined();
    expect(idle!.lastNodeId).toBeUndefined();
  });

  test("derives marker status from the error levels", () => {
    // The fixture carries one WARNING error.
    expect(stateToVehicle(state)!.status).toBe("warning");
    const fatal = stateToVehicle({
      ...state,
      errors: [
        ...state.errors!,
        { errorType: "motorStall", errorLevel: "FATAL" },
      ],
    });
    expect(fatal!.status).toBe("error");
    expect(stateToVehicle({ ...state, errors: [] })!.status).toBeUndefined();
    // "offline" is the host's call (stale feed) — overrides carry it.
    expect(stateToVehicle(state, { status: "offline" })!.status).toBe("offline");
  });

  test("does not mutate the input and detaches errors/loads from it", () => {
    const before = structuredClone(stateJson);
    const v = stateToVehicle(state);
    expect(stateJson).toEqual(before);
    expect(v!.errors).not.toBe(state.errors);
    expect(v!.errors![0]).not.toBe(state.errors![0]);
    // Deep detachment: nested reference arrays must not alias the message.
    expect(v!.errors![0]!.errorReferences).not.toBe(state.errors![0]!.errorReferences);
    expect(v!.loads).not.toBe(state.loads);
  });
});

describe("visualizationToVehicle", () => {
  test("maps the high-rate pose topic: identity and pose, no status fields", () => {
    const v = visualizationToVehicle(visualization);
    expect(v!.vehicleId).toBe("acme-robotics/tugger-042");
    expect(v!.x).toBe(9.05);
    expect(v!.y).toBe(2.1);
    expect(v!.mapId).toBe("map-ground");
    expect(v!.velocity?.vx).toBe(1.2);
    expect(v!.batteryCharge).toBeUndefined();
    expect(v!.orderId).toBeUndefined();
  });

  test("returns null without a position; overrides apply", () => {
    const { agvPosition: _dropped, ...noPosition } = visualization;
    expect(visualizationToVehicle(noPosition)).toBeNull();
    const v = visualizationToVehicle(visualization, { vehicleTypeId: "acme.tugger" });
    expect(v!.vehicleTypeId).toBe("acme.tugger");
  });
});

describe("orderToRoute", () => {
  test("maps sequence-ordered nodes/edges to a route with base/horizon and action badges", () => {
    const route = orderToRoute(order);
    expect(route.routeId).toBe("order-7f3a");
    expect(route.label).toBe("order-7f3a");
    expect(route.vehicleId).toBe("acme-robotics/tugger-042");
    expect(route.stops).toEqual([
      { nodeId: "n-dock", actions: ["pick"] },
      { nodeId: "n-aisle-w" },
      { nodeId: "n-aisle-e", released: false, actions: ["drop", "beep"] },
    ]);
    expect(route.edgeIds).toEqual(["e-dock-west", "e-west-east"]);
  });

  test("an edge that does not connect its adjacent stops falls back to a straight leg", () => {
    const skewed = structuredClone(order) as Vda5050Order;
    skewed.edges[1]!.startNodeId = "somewhere-else";
    expect(orderToRoute(skewed).edgeIds).toEqual(["e-dock-west", null]);
  });

  test("a missing edge degrades only its own leg — later legs still match", () => {
    const gappy = structuredClone(order) as Vda5050Order;
    gappy.edges = gappy.edges.filter((e) => e.edgeId !== "e-dock-west");
    // Leg 0 has no edge; leg 1 must still find e-west-east by endpoints.
    expect(orderToRoute(gappy).edgeIds).toEqual([null, "e-west-east"]);
  });

  test("forward edges win over reverse parallels for a leg", () => {
    const parallel = structuredClone(order) as Vda5050Order;
    parallel.edges.push({
      edgeId: "e-east-west",
      sequenceId: 5,
      released: false,
      startNodeId: "n-aisle-e",
      endNodeId: "n-aisle-w", // reverse of leg 1's direction
    });
    expect(orderToRoute(parallel).edgeIds).toEqual(["e-dock-west", "e-west-east"]);
  });

  test("overrides win and the input is not mutated", () => {
    const before = structuredClone(orderJson);
    const route = orderToRoute(order, { label: "Pick run 7" });
    expect(route.label).toBe("Pick run 7");
    expect(orderJson).toEqual(before);
  });
});

describe("factsheetToVehicleProfile", () => {
  test("derives id, physical limits and the placeable action palette", () => {
    const profile = factsheetToVehicleProfile(factsheet);
    expect(profile.vehicleTypeId).toBe("acme-robotics.tugger");
    expect(profile.limits).toEqual({ maxSpeed: 1.8, maxHeight: 2.0, minHeight: 0.4 });
    // cancelOrder is INSTANT-only and cannot be placed in a layout.
    expect(profile.supportedActions?.map((a) => a.actionType)).toEqual([
      "pick",
      "drop",
      "startCharging",
      "beep",
    ]);
    const beep = profile.supportedActions!.find((a) => a.actionType === "beep")!;
    expect(beep.scopes).toEqual(["NODE", "EDGE"]);
    expect(beep.description).toBe("Acoustic signal");
    const charging = profile.supportedActions!.find((a) => a.actionType === "startCharging")!;
    expect(charging.scopes).toEqual(["NODE"]);
  });

  test("vehicleTypeId can be overridden; minimal factsheets yield a minimal profile", () => {
    expect(
      factsheetToVehicleProfile(factsheet, { vehicleTypeId: "site-7.tugger" }).vehicleTypeId,
    ).toBe("site-7.tugger");
    const minimal = factsheetToVehicleProfile({ typeSpecification: { seriesName: "lifter" } });
    expect(minimal.vehicleTypeId).toBe("lifter");
    expect(minimal.limits).toBeUndefined();
    expect(minimal.supportedActions).toBeUndefined();
  });

  test("does not mutate the input", () => {
    const before = structuredClone(factsheetJson);
    factsheetToVehicleProfile(factsheet);
    expect(factsheetJson).toEqual(before);
  });
});
