/**
 * TypeScript model of the VDMA Layout Interchange Format (LIF) 1.0.0.
 *
 * Field names, types and optionality mirror the guideline's tables 8.3.1–8.3.13.
 * Optional fields whose absence has a defined meaning get accessor helpers below
 * (the parser never injects defaults, so documents round-trip losslessly).
 */

export interface Lif {
  metaInformation: MetaInformation;
  layouts: Layout[];
}

export interface MetaInformation {
  /** Human-readable name of the project. */
  projectIdentification: string;
  /** Creator of the LIF file (company or person). */
  creator: string;
  /** ISO8601 UTC timestamp distinguishing file versions over time. */
  exportTimestamp: string;
  /** Semantic version of the LIF format, e.g. "1.0.0". */
  lifVersion: string;
}

export interface Layout {
  layoutId: string;
  layoutName?: string;
  layoutVersion: string;
  layoutLevelId?: string;
  layoutDescription?: string;
  nodes: LifNode[];
  edges: LifEdge[];
  stations: Station[];
}

export interface Position {
  /** Metres, relative to the project-specific global origin. */
  x: number;
  y: number;
}

/** Named LifNode to avoid clashing with the DOM's Node type. */
export interface LifNode {
  /** Unique across all layouts in the file. */
  nodeId: string;
  /** Visualization only; need not be unique. */
  nodeName?: string;
  nodeDescription?: string;
  /** Map in which the node's position is referenced; maps share the global origin. */
  mapId?: string;
  nodePosition: Position;
  /** Must contain one element per vehicle type allowed to use this node. */
  vehicleTypeNodeProperties: VehicleTypeNodeProperty[];
}

export interface VehicleTypeNodeProperty {
  vehicleTypeId: string;
  /** Absolute vehicle orientation on the node, radians in [-π, π]. */
  theta?: number;
  actions?: LifAction[];
}

export type RequirementType = "REQUIRED" | "CONDITIONAL" | "OPTIONAL";
export type BlockingType = "NONE" | "SOFT" | "HARD";

export interface LifAction {
  /** VDA 5050 action name; manufacturer-specific values allowed. */
  actionType: string;
  actionDescription?: string;
  requirementType?: RequirementType;
  blockingType: BlockingType;
  actionParameters?: ActionParameter[];
}

export interface ActionParameter {
  /** Unique within the action's parameter list. */
  key: string;
  value: string;
}

export interface LifEdge {
  /** Unique across all layouts in the file. */
  edgeId: string;
  edgeName?: string;
  edgeDescription?: string;
  /** Must reference a node in the same layout. */
  startNodeId: string;
  /** May reference a node in another layout (models a layout transition). */
  endNodeId: string;
  /** Must contain one element per vehicle type allowed to use this edge. */
  vehicleTypeEdgeProperties: VehicleTypeEdgeProperty[];
}

export type OrientationType = "GLOBAL" | "TANGENTIAL";
export type RotationDirection = "NONE" | "CCW" | "CW" | "BOTH";

export interface VehicleTypeEdgeProperty {
  vehicleTypeId: string;
  /** Radians; interpreted per orientationType (TANGENTIAL: 0 forwards, π backwards). */
  vehicleOrientation?: number;
  /** Default: "TANGENTIAL". */
  orientationType?: OrientationType;
  rotationAllowed: boolean;
  /** Default: "BOTH". */
  rotationAtStartNodeAllowed?: RotationDirection;
  /** Default: "BOTH". */
  rotationAtEndNodeAllowed?: RotationDirection;
  /** m/s; absent means no limitation. */
  maxSpeed?: number;
  /** rad/s; absent means no limitation. */
  maxRotationSpeed?: number;
  /** Metres; minimal height of the load handling device. Absent: no limitation. */
  minHeight?: number;
  /** Metres; maximum height of vehicle including load. Absent: no limitation. */
  maxHeight?: number;
  /** Absent: usable both loaded and unloaded. */
  loadRestriction?: LoadRestriction;
  actions?: LifAction[];
  /** NURBS curve from start to end node. */
  trajectory?: Trajectory;
  /** Default: true. */
  reentryAllowed?: boolean;
}

export interface LoadRestriction {
  unloaded: boolean;
  loaded: boolean;
  /** Only meaningful when loaded is true; absent/empty means all load sets. */
  loadSetNames?: string[];
}

export interface Trajectory {
  /** ≥ 1. Default: 1. */
  degree?: number;
  /** Values in [0, 1]; length must equal controlPoints.length + degree + 1. */
  knotVector: number[];
  /** Includes the beginning and end points of the curve. */
  controlPoints: ControlPoint[];
}

export interface ControlPoint {
  x: number;
  y: number;
  /** ≥ 0. Default: 1.0. */
  weight?: number;
}

export interface Station {
  /** Unique across all layouts in the file. */
  stationId: string;
  /** At least one nodeId; nodes where interaction with the station takes place. */
  interactionNodeIds: string[];
  stationName?: string;
  stationDescription?: string;
  /** Metres, ≥ 0. Default: 0. */
  stationHeight?: number;
  /** Visualization only. */
  stationPosition?: StationPosition;
}

export interface StationPosition {
  x: number;
  y: number;
  /** Radians in [-π, π]. */
  theta?: number;
}

/* ------------------------------------------------------------------ */
/* Defined-default accessors (the parser never injects these values). */
/* ------------------------------------------------------------------ */

export function getOrientationType(p: VehicleTypeEdgeProperty): OrientationType {
  return p.orientationType ?? "TANGENTIAL";
}

export function getRotationAtStartNodeAllowed(p: VehicleTypeEdgeProperty): RotationDirection {
  return p.rotationAtStartNodeAllowed ?? "BOTH";
}

export function getRotationAtEndNodeAllowed(p: VehicleTypeEdgeProperty): RotationDirection {
  return p.rotationAtEndNodeAllowed ?? "BOTH";
}

export function getReentryAllowed(p: VehicleTypeEdgeProperty): boolean {
  return p.reentryAllowed ?? true;
}

export function getDegree(t: Trajectory): number {
  return t.degree ?? 1;
}

export function getWeight(c: ControlPoint): number {
  return c.weight ?? 1.0;
}

export function getStationHeight(s: Station): number {
  return s.stationHeight ?? 0;
}

/**
 * Combine rotation permissions where edges meet at a node (guideline §8.3.9.1):
 * the incoming edge's rotationAtEndNodeAllowed and the outgoing edge's
 * rotationAtStartNodeAllowed act as a boolean AND per direction.
 */
export function combineRotationDirections(
  a: RotationDirection,
  b: RotationDirection,
): RotationDirection {
  const ccw = (a === "CCW" || a === "BOTH") && (b === "CCW" || b === "BOTH");
  const cw = (a === "CW" || a === "BOTH") && (b === "CW" || b === "BOTH");
  if (ccw && cw) return "BOTH";
  if (ccw) return "CCW";
  if (cw) return "CW";
  return "NONE";
}
