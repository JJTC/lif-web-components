/**
 * Display-relevant subset of the VDA 5050 2.x message types — the MQTT/JSON
 * protocol between AGVs and a master control, i.e. the runtime counterpart
 * to the static LIF layout file.
 *
 * These interfaces re-express interface facts from the openly published
 * VDA 5050 specification (github.com/VDA5050/VDA5050, CC-BY-4.0). They cover the
 * fields the mapping helpers and UI read — messages on the wire carry more,
 * and extra properties are simply ignored. Fields the specification requires
 * are kept optional here wherever the mappers tolerate their absence.
 */

/** Header fields shared by all VDA 5050 topics (subset). */
export interface Vda5050Header {
  headerId?: number;
  /** ISO 8601. */
  timestamp?: string;
  /** Protocol version, e.g. "2.1.0". */
  version?: string;
  manufacturer: string;
  serialNumber: string;
}

export interface Vda5050AgvPosition {
  x: number;
  y: number;
  /** Radians, counter-clockwise positive — the convention LIF shares. */
  theta?: number;
  mapId?: string;
  positionInitialized?: boolean;
  mapDescription?: string;
  localizationScore?: number;
  deviationRange?: number;
}

export interface Vda5050Velocity {
  vx?: number;
  vy?: number;
  omega?: number;
}

export interface Vda5050BatteryState {
  /** Percent, 0–100. */
  batteryCharge: number;
  charging: boolean;
  batteryVoltage?: number;
  batteryHealth?: number;
  /** Estimated remaining reach in metres. */
  reach?: number;
}

export type Vda5050ErrorLevel = "WARNING" | "FATAL";

export interface Vda5050ErrorReference {
  referenceKey: string;
  referenceValue: string;
}

export interface Vda5050Error {
  errorType: string;
  errorLevel: Vda5050ErrorLevel;
  errorDescription?: string;
  errorHint?: string;
  errorReferences?: Vda5050ErrorReference[];
}

export interface Vda5050Load {
  loadId?: string;
  loadType?: string;
  loadPosition?: string;
  weight?: number;
}

export type Vda5050OperatingMode =
  | "AUTOMATIC"
  | "SEMIAUTOMATIC"
  | "MANUAL"
  | "SERVICE"
  | "TEACHIN";

export type Vda5050ActionStatus =
  | "WAITING"
  | "INITIALIZING"
  | "RUNNING"
  | "PAUSED"
  | "FINISHED"
  | "FAILED";

export interface Vda5050ActionState {
  actionId: string;
  actionStatus: Vda5050ActionStatus;
  actionType?: string;
  actionDescription?: string;
  resultDescription?: string;
}

export interface Vda5050SafetyState {
  eStop?: "AUTOACK" | "MANUAL" | "REMOTE" | "NONE";
  fieldViolation?: boolean;
}

/** VDA 5050 `state` topic (subset). */
export interface Vda5050State extends Vda5050Header {
  /** Empty string on the wire means "no order". */
  orderId?: string;
  orderUpdateId?: number;
  /** Empty string on the wire means "none yet". */
  lastNodeId?: string;
  driving?: boolean;
  paused?: boolean;
  operatingMode?: Vda5050OperatingMode;
  agvPosition?: Vda5050AgvPosition;
  velocity?: Vda5050Velocity;
  batteryState?: Vda5050BatteryState;
  errors?: Vda5050Error[];
  loads?: Vda5050Load[];
  actionStates?: Vda5050ActionState[];
  safetyState?: Vda5050SafetyState;
}

/**
 * VDA 5050 `visualization` topic (subset) — the high-rate pose stream the
 * protocol dedicates to UIs; the ideal feed for the live vehicle overlay.
 */
export interface Vda5050Visualization extends Vda5050Header {
  agvPosition?: Vda5050AgvPosition;
  velocity?: Vda5050Velocity;
}

export interface Vda5050Action {
  actionId: string;
  actionType: string;
  /** Same literals as LIF's blockingType. */
  blockingType?: "NONE" | "SOFT" | "HARD";
  actionDescription?: string;
  actionParameters?: Array<{ key: string; value: unknown }>;
}

export interface Vda5050NodePosition {
  x: number;
  y: number;
  theta?: number;
  mapId?: string;
  allowedDeviationXY?: number;
  allowedDeviationTheta?: number;
}

export interface Vda5050OrderNode {
  nodeId: string;
  sequenceId: number;
  /** true → base (committed); false → horizon (planned). */
  released: boolean;
  nodeDescription?: string;
  nodePosition?: Vda5050NodePosition;
  actions?: Vda5050Action[];
}

export interface Vda5050OrderEdge {
  edgeId: string;
  sequenceId: number;
  /** true → base (committed); false → horizon (planned). */
  released: boolean;
  startNodeId: string;
  endNodeId: string;
  edgeDescription?: string;
  actions?: Vda5050Action[];
}

/**
 * VDA 5050 `order` topic (subset). Order node/edge ids refer to the LIF
 * layout the master control plans on — that correspondence is the point of
 * the handover. Consumed by the route overlay.
 */
export interface Vda5050Order extends Vda5050Header {
  orderId: string;
  orderUpdateId: number;
  zoneSetId?: string;
  nodes: Vda5050OrderNode[];
  edges: Vda5050OrderEdge[];
}

export interface Vda5050TypeSpecification {
  seriesName: string;
  seriesDescription?: string;
  /** "DIFF" | "OMNI" | "THREEWHEEL" per the spec; kept open for vendor values. */
  agvKinematic?: string;
  /** "FORKLIFT" | "CONVEYOR" | "TUGGER" | "CARRIER" per the spec; kept open. */
  agvClass?: string;
  maxLoadMass?: number;
  localizationTypes?: string[];
  navigationTypes?: string[];
}

export interface Vda5050PhysicalParameters {
  speedMin?: number;
  speedMax?: number;
  accelerationMax?: number;
  decelerationMax?: number;
  heightMin?: number;
  heightMax?: number;
  width?: number;
  length?: number;
}

export interface Vda5050ActionParameterSpec {
  key: string;
  /** "BOOL" | "NUMBER" | "INTEGER" | "FLOAT" | "STRING" | "OBJECT" | "ARRAY" per the spec. */
  valueDataType?: string;
  description?: string;
  isOptional?: boolean;
}

export type Vda5050ActionScope = "INSTANT" | "NODE" | "EDGE";

export interface Vda5050AgvAction {
  actionType: string;
  actionDescription?: string;
  /** Where the AGV supports the action; INSTANT-only actions cannot be placed in a layout. */
  actionScopes?: Vda5050ActionScope[];
  actionParameters?: Vda5050ActionParameterSpec[];
  resultDescription?: string;
}

export interface Vda5050ProtocolFeatures {
  agvActions?: Vda5050AgvAction[];
}

/**
 * VDA 5050 `factsheet` (subset) — the AGV's self-description. Standalone
 * factsheet files may omit the header identity fields.
 */
export interface Vda5050Factsheet {
  version?: string;
  manufacturer?: string;
  serialNumber?: string;
  typeSpecification: Vda5050TypeSpecification;
  physicalParameters?: Vda5050PhysicalParameters;
  protocolFeatures?: Vda5050ProtocolFeatures;
}
