/**
 * Pure mapping functions from VDA 5050 runtime messages onto the components'
 * runtime types. Deliberately no transport here: the host
 * owns MQTT and subscriptions; these helpers own only the shape conversion.
 */

import type { LifRoute, LifRouteStop, LifVehicle } from "../components/lif-viewer";
import type { SupportedAction, VehicleProfile } from "../components/lif-editor";
import type {
  Vda5050AgvPosition,
  Vda5050Error,
  Vda5050Factsheet,
  Vda5050Load,
  Vda5050OperatingMode,
  Vda5050Order,
  Vda5050State,
  Vda5050Velocity,
  Vda5050Visualization,
} from "./types";

/**
 * A viewer vehicle enriched with VDA 5050 state. The viewer reads only the
 * `LifVehicle` fields; the extras ride along untouched for fleet UIs
 * (`lif-select` handlers, the fleet panel).
 */
export interface Vda5050Vehicle extends LifVehicle {
  manufacturer: string;
  serialNumber: string;
  /** Percent, 0–100. */
  batteryCharge?: number;
  charging?: boolean;
  driving?: boolean;
  paused?: boolean;
  operatingMode?: Vda5050OperatingMode;
  /** Undefined when the AGV reports no order (empty string on the wire). */
  orderId?: string;
  /** Undefined when the AGV reports none (empty string on the wire). */
  lastNodeId?: string;
  errors?: Vda5050Error[];
  loads?: Vda5050Load[];
  velocity?: Vda5050Velocity;
}

interface PositionedMessage {
  manufacturer: string;
  serialNumber: string;
  agvPosition?: Vda5050AgvPosition;
  velocity?: Vda5050Velocity;
}

/**
 * Pose and identity shared by state and visualization messages. Null when the
 * AGV cannot be placed on the map (no position, or not yet localized).
 */
function positionedVehicle(msg: PositionedMessage): Vda5050Vehicle | null {
  const p = msg.agvPosition;
  if (!p || p.positionInitialized === false) return null;
  const vehicle: Vda5050Vehicle = {
    vehicleId: `${msg.manufacturer}/${msg.serialNumber}`,
    manufacturer: msg.manufacturer,
    serialNumber: msg.serialNumber,
    label: msg.serialNumber,
    x: p.x,
    y: p.y,
  };
  if (p.theta !== undefined) vehicle.theta = p.theta;
  if (p.mapId !== undefined) vehicle.mapId = p.mapId;
  if (msg.velocity) vehicle.velocity = { ...msg.velocity };
  return vehicle;
}

/**
 * Map a VDA 5050 `state` message to a live vehicle for `viewer.vehicles`.
 * Returns null when the AGV reports no usable position — filter those out.
 * `overrides` wins last (set `vehicleTypeId`, `layoutId`, or a custom label).
 */
export function stateToVehicle(
  state: Vda5050State,
  overrides?: Partial<LifVehicle>,
): Vda5050Vehicle | null {
  const vehicle = positionedVehicle(state);
  if (!vehicle) return null;
  if (state.batteryState) {
    vehicle.batteryCharge = state.batteryState.batteryCharge;
    vehicle.charging = state.batteryState.charging;
  }
  if (state.driving !== undefined) vehicle.driving = state.driving;
  if (state.paused !== undefined) vehicle.paused = state.paused;
  if (state.operatingMode !== undefined) vehicle.operatingMode = state.operatingMode;
  if (state.orderId) vehicle.orderId = state.orderId;
  if (state.lastNodeId) vehicle.lastNodeId = state.lastNodeId;
  if (state.errors?.length) {
    vehicle.errors = structuredClone(state.errors);
    // FATAL stops the vehicle → "error"; anything else reported → "warning".
    // "offline" cannot be derived from a message — its absence is the signal;
    // hosts set it themselves (e.g. on a stale timestamp).
    vehicle.status = state.errors.some((e) => e.errorLevel === "FATAL") ? "error" : "warning";
  }
  if (state.loads?.length) vehicle.loads = structuredClone(state.loads);
  return overrides ? { ...vehicle, ...overrides } : vehicle;
}

/**
 * Map a VDA 5050 `visualization` message (the high-rate pose topic) to a live
 * vehicle. Same identity and null semantics as `stateToVehicle`, pose only.
 */
export function visualizationToVehicle(
  visualization: Vda5050Visualization,
  overrides?: Partial<LifVehicle>,
): Vda5050Vehicle | null {
  const vehicle = positionedVehicle(visualization);
  if (!vehicle) return null;
  return overrides ? { ...vehicle, ...overrides } : vehicle;
}

/**
 * Map a VDA 5050 `order` message to a viewer route overlay. Nodes/edges are
 * ordered by sequenceId; `released: false` elements become the dashed
 * horizon; node actions become stop badges. Each leg is matched to its edge
 * by endpoints (forward direction preferred), so a missing or out-of-order
 * edge degrades that one leg to a straight line instead of desynchronizing
 * the rest. `overrides` wins last.
 */
export function orderToRoute(order: Vda5050Order, overrides?: Partial<LifRoute>): LifRoute {
  const nodes = [...order.nodes].sort((a, b) => a.sequenceId - b.sequenceId);
  const edges = [...order.edges].sort((a, b) => a.sequenceId - b.sequenceId);
  const route: LifRoute = {
    routeId: order.orderId,
    label: order.orderId,
    vehicleId: `${order.manufacturer}/${order.serialNumber}`,
    stops: nodes.map((n): LifRouteStop => {
      const stop: LifRouteStop = { nodeId: n.nodeId };
      if (n.released === false) stop.released = false;
      const actions = (n.actions ?? []).map((a) => a.actionType);
      if (actions.length > 0) stop.actions = actions;
      return stop;
    }),
  };
  if (edges.length > 0 && nodes.length > 1) {
    route.edgeIds = nodes.slice(1).map((node, i) => {
      const from = nodes[i]!.nodeId;
      const forward = edges.find((e) => e.startNodeId === from && e.endNodeId === node.nodeId);
      const reverse =
        forward ?? edges.find((e) => e.startNodeId === node.nodeId && e.endNodeId === from);
      return (forward ?? reverse)?.edgeId ?? null;
    });
  }
  return overrides ? { ...route, ...overrides } : route;
}

export interface FactsheetProfileOptions {
  /** Override the derived id (default `manufacturer.seriesName`, or `seriesName` alone). */
  vehicleTypeId?: string;
}

/**
 * Map a VDA 5050 `factsheet` to the editor's `vehicleProfile`: physical
 * limits become form warnings and the supported actions become the action
 * palette. INSTANT-only actions are excluded — they cannot be placed in a
 * layout. The factsheet carries no creation-policy defaults and no
 * requirement/blocking defaults; set those on the returned profile if the
 * host has a policy.
 */
export function factsheetToVehicleProfile(
  factsheet: Vda5050Factsheet,
  options?: FactsheetProfileOptions,
): VehicleProfile {
  const series = factsheet.typeSpecification.seriesName;
  const profile: VehicleProfile = {
    vehicleTypeId:
      options?.vehicleTypeId ??
      (factsheet.manufacturer ? `${factsheet.manufacturer}.${series}` : series),
  };

  const phys = factsheet.physicalParameters;
  const limits: VehicleProfile["limits"] = {};
  if (phys?.speedMax !== undefined) limits.maxSpeed = phys.speedMax;
  if (phys?.heightMax !== undefined) limits.maxHeight = phys.heightMax;
  if (phys?.heightMin !== undefined) limits.minHeight = phys.heightMin;
  if (Object.keys(limits).length > 0) profile.limits = limits;

  const actions = (factsheet.protocolFeatures?.agvActions ?? []).flatMap(
    (action): SupportedAction[] => {
      const scopes = (action.actionScopes ?? []).filter(
        (scope): scope is "NODE" | "EDGE" => scope === "NODE" || scope === "EDGE",
      );
      if (scopes.length === 0) return [];
      const supported: SupportedAction = { actionType: action.actionType, scopes };
      if (action.actionDescription !== undefined) {
        supported.description = action.actionDescription;
      }
      return [supported];
    },
  );
  if (actions.length > 0) profile.supportedActions = actions;

  return profile;
}
