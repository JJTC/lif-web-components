/**
 * Lenient LIF parser.
 *
 * Accepts any structurally recognizable LIF document, normalizes known
 * spec quirks, and reports everything it finds as diagnostics instead of
 * throwing. It throws `LifParseError` only when the input is not JSON or
 * the root is not an object.
 *
 * Contract: when the returned diagnostics contain no "error" entries, the
 * returned object conforms to the `Lif` types. Unknown/vendor fields are
 * preserved untouched (lossless round-trip); the parser never injects
 * defined-default values.
 *
 * Normalizations (each reported as a warning):
 * - numbers/booleans written as strings are coerced (e.g. `stationHeight: "0.55"`,
 *   as seen in every example of the guideline),
 * - strings written as numbers are coerced (e.g. `layoutVersion: 1`),
 * - a legacy draft-0.11.0 action field `required: boolean` is mapped to
 *   `requirementType` (guideline §8.4 figure vs table 8.3.6),
 * - a missing `stations` array becomes `[]` (required per table 8.3.3 but
 *   omitted by 8 of the guideline's 19 examples).
 */

import { DiagnosticCollector, type Diagnostic } from "./diagnostics";
import type {
  ActionParameter,
  ControlPoint,
  Layout,
  Lif,
  LifAction,
  LifEdge,
  LifNode,
  LoadRestriction,
  MetaInformation,
  Position,
  Station,
  StationPosition,
  Trajectory,
  VehicleTypeEdgeProperty,
  VehicleTypeNodeProperty,
} from "./types";

/** The LIF format version this library implements. */
export const LIF_VERSION = "1.0.0";

export class LifParseError extends Error {}

export interface ParseLifResult {
  lif: Lif;
  diagnostics: Diagnostic[];
}

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a LIF document from a JSON string or an already-parsed value. */
export function parseLif(input: string | unknown): ParseLifResult {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      throw new LifParseError(`Input is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (!isRecord(raw)) {
    throw new LifParseError("LIF root must be a JSON object");
  }

  const c = new DiagnosticCollector();
  const out: Rec = { ...raw };

  if (isRecord(raw.metaInformation)) {
    out.metaInformation = c.in("metaInformation", () =>
      parseMeta(c, raw.metaInformation as Rec),
    );
  } else if (raw.metaInformation === undefined) {
    c.error("LIF-P002", "required field 'metaInformation' is missing");
    out.metaInformation = {};
  } else {
    c.error("LIF-P003", "'metaInformation' must be a JSON object");
    out.metaInformation = {};
  }

  out.layouts = parseArray(c, out, "layouts", parseLayout, { required: true });

  return { lif: out as unknown as Lif, diagnostics: c.diagnostics };
}

/* ------------------------------------------------------------------ */
/* Field helpers — mutate a shallow copy in place, collect diagnostics */
/* ------------------------------------------------------------------ */

function coerceString(c: DiagnosticCollector, o: Rec, key: string): void {
  const v = o[key];
  if (typeof v === "string") return;
  if (typeof v === "number" || typeof v === "boolean") {
    o[key] = String(v);
    c.warning("LIF-P004", `'${key}' should be a string; coerced ${JSON.stringify(v)}`, `.${key}`);
    return;
  }
  c.error("LIF-P003", `'${key}' must be a string (got ${typeName(v)})`, `.${key}`);
}

function reqString(c: DiagnosticCollector, o: Rec, key: string): void {
  if (o[key] === undefined) {
    c.error("LIF-P002", `required field '${key}' is missing`);
    return;
  }
  coerceString(c, o, key);
}

function optString(c: DiagnosticCollector, o: Rec, key: string): void {
  if (o[key] === undefined) return;
  coerceString(c, o, key);
}

function coerceNumber(c: DiagnosticCollector, o: Rec, key: string): void {
  const v = o[key];
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      c.error("LIF-P003", `'${key}' must be a finite number`, `.${key}`);
    }
    return;
  }
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    o[key] = Number(v);
    c.warning("LIF-P004", `'${key}' should be a number; coerced "${v}"`, `.${key}`);
    return;
  }
  c.error("LIF-P003", `'${key}' must be a number (got ${typeName(v)})`, `.${key}`);
}

function reqNumber(c: DiagnosticCollector, o: Rec, key: string): void {
  if (o[key] === undefined) {
    c.error("LIF-P002", `required field '${key}' is missing`);
    return;
  }
  coerceNumber(c, o, key);
}

function optNumber(c: DiagnosticCollector, o: Rec, key: string): void {
  if (o[key] === undefined) return;
  coerceNumber(c, o, key);
}

function coerceBoolean(c: DiagnosticCollector, o: Rec, key: string): void {
  const v = o[key];
  if (typeof v === "boolean") return;
  if (v === "true" || v === "false") {
    o[key] = v === "true";
    c.warning("LIF-P004", `'${key}' should be a boolean; coerced "${v}"`, `.${key}`);
    return;
  }
  c.error("LIF-P003", `'${key}' must be a boolean (got ${typeName(v)})`, `.${key}`);
}

function reqBoolean(c: DiagnosticCollector, o: Rec, key: string): void {
  if (o[key] === undefined) {
    c.error("LIF-P002", `required field '${key}' is missing`);
    return;
  }
  coerceBoolean(c, o, key);
}

function optBoolean(c: DiagnosticCollector, o: Rec, key: string): void {
  if (o[key] === undefined) return;
  coerceBoolean(c, o, key);
}

function optEnum(c: DiagnosticCollector, o: Rec, key: string, values: readonly string[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v !== "string") {
    c.error("LIF-P003", `'${key}' must be a string (got ${typeName(v)})`, `.${key}`);
    return;
  }
  if (!values.includes(v)) {
    c.error(
      "LIF-P007",
      `'${key}' has invalid value "${v}" (expected ${values.join(" | ")})`,
      `.${key}`,
    );
  }
}

function reqEnum(c: DiagnosticCollector, o: Rec, key: string, values: readonly string[]): void {
  if (o[key] === undefined) {
    c.error("LIF-P002", `required field '${key}' is missing`);
    return;
  }
  optEnum(c, o, key, values);
}

interface ArrayOpts {
  required?: boolean;
  /** Warning code + message to use when a required array is absent. */
  absentWarning?: { code: string; message: string };
}

function parseArray<T>(
  c: DiagnosticCollector,
  o: Rec,
  key: string,
  item: (c: DiagnosticCollector, raw: Rec) => T,
  opts: ArrayOpts = {},
): T[] {
  const v = o[key];
  if (v === undefined) {
    if (opts.absentWarning) {
      c.warning(opts.absentWarning.code, opts.absentWarning.message);
    } else if (opts.required) {
      c.error("LIF-P002", `required field '${key}' is missing`);
    } else {
      // Optional and absent: leave it absent (lossless round-trip).
      return [];
    }
    o[key] = [];
    return o[key] as T[];
  }
  if (!Array.isArray(v)) {
    c.error("LIF-P003", `'${key}' must be an array (got ${typeName(v)})`, `.${key}`);
    o[key] = [];
    return o[key] as T[];
  }
  const parsed = v.map((entry, i) =>
    c.in(`.${key}[${i}]`, () => {
      if (!isRecord(entry)) {
        c.error("LIF-P003", `entry must be a JSON object (got ${typeName(entry)})`);
        return entry as T;
      }
      return item(c, entry);
    }),
  );
  o[key] = parsed;
  return parsed;
}

function parseStringArray(c: DiagnosticCollector, o: Rec, key: string, required: boolean): void {
  const v = o[key];
  if (v === undefined) {
    if (required) {
      c.error("LIF-P002", `required field '${key}' is missing`);
      o[key] = [];
    }
    return;
  }
  if (!Array.isArray(v)) {
    c.error("LIF-P003", `'${key}' must be an array of strings (got ${typeName(v)})`, `.${key}`);
    o[key] = [];
    return;
  }
  const copy = v.slice();
  o[key] = copy;
  copy.forEach((entry, i) => {
    if (typeof entry !== "string") {
      if (typeof entry === "number" || typeof entry === "boolean") {
        copy[i] = String(entry);
        c.warning("LIF-P004", `entry should be a string; coerced ${JSON.stringify(entry)}`, `.${key}[${i}]`);
      } else {
        c.error("LIF-P003", `entry must be a string (got ${typeName(entry)})`, `.${key}[${i}]`);
      }
    }
  });
}

function parseObject<T>(
  c: DiagnosticCollector,
  o: Rec,
  key: string,
  required: boolean,
  item: (c: DiagnosticCollector, raw: Rec) => T,
): void {
  const v = o[key];
  if (v === undefined) {
    if (required) c.error("LIF-P002", `required field '${key}' is missing`);
    return;
  }
  if (!isRecord(v)) {
    c.error("LIF-P003", `'${key}' must be a JSON object (got ${typeName(v)})`, `.${key}`);
    return;
  }
  o[key] = c.in(`.${key}`, () => item(c, v));
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/* ------------------------------------------------------------- */
/* Per-object parsers (each receives and returns a shallow copy). */
/* ------------------------------------------------------------- */

function parseMeta(c: DiagnosticCollector, raw: Rec): MetaInformation {
  const o: Rec = { ...raw };
  reqString(c, o, "projectIdentification");
  reqString(c, o, "creator");
  reqString(c, o, "exportTimestamp");
  reqString(c, o, "lifVersion");
  return o as unknown as MetaInformation;
}

function parseLayout(c: DiagnosticCollector, raw: Rec): Layout {
  const o: Rec = { ...raw };
  reqString(c, o, "layoutId");
  optString(c, o, "layoutName");
  reqString(c, o, "layoutVersion");
  optString(c, o, "layoutLevelId");
  optString(c, o, "layoutDescription");
  parseArray(c, o, "nodes", parseNode, { required: true });
  parseArray(c, o, "edges", parseEdge, { required: true });
  parseArray(c, o, "stations", parseStation, {
    required: true,
    absentWarning: {
      code: "LIF-P006",
      message:
        "'stations' is required by table 8.3.3 but missing (common in real files); treated as empty",
    },
  });
  return o as unknown as Layout;
}

function parseNode(c: DiagnosticCollector, raw: Rec): LifNode {
  const o: Rec = { ...raw };
  reqString(c, o, "nodeId");
  optString(c, o, "nodeName");
  optString(c, o, "nodeDescription");
  optString(c, o, "mapId");
  parseObject(c, o, "nodePosition", true, parsePosition);
  parseArray(c, o, "vehicleTypeNodeProperties", parseVehicleTypeNodeProperty, { required: true });
  return o as unknown as LifNode;
}

function parsePosition(c: DiagnosticCollector, raw: Rec): Position {
  const o: Rec = { ...raw };
  reqNumber(c, o, "x");
  reqNumber(c, o, "y");
  return o as unknown as Position;
}

function parseVehicleTypeNodeProperty(c: DiagnosticCollector, raw: Rec): VehicleTypeNodeProperty {
  const o: Rec = { ...raw };
  reqString(c, o, "vehicleTypeId");
  optNumber(c, o, "theta");
  parseArray(c, o, "actions", parseAction);
  return o as unknown as VehicleTypeNodeProperty;
}

function parseAction(c: DiagnosticCollector, raw: Rec): LifAction {
  const o: Rec = { ...raw };
  reqString(c, o, "actionType");
  optString(c, o, "actionDescription");
  // Draft-0.11.0 leftover (§8.4 figure): `required: boolean` instead of requirementType.
  if (o.requirementType === undefined && typeof o.required === "boolean") {
    o.requirementType = o.required ? "REQUIRED" : "OPTIONAL";
    delete o.required;
    c.warning(
      "LIF-P005",
      `legacy 'required' boolean mapped to requirementType "${o.requirementType}"`,
      ".required",
    );
  } else if (o.requirementType !== undefined && typeof o.required === "boolean") {
    // Both present: keep the canonical field, flag the stray legacy one.
    c.warning(
      "LIF-P008",
      "action has both 'required' (legacy) and 'requirementType'; 'requirementType' is used and 'required' is preserved as an unknown field",
      ".required",
    );
  }
  optEnum(c, o, "requirementType", ["REQUIRED", "CONDITIONAL", "OPTIONAL"]);
  reqEnum(c, o, "blockingType", ["NONE", "SOFT", "HARD"]);
  parseArray(c, o, "actionParameters", parseActionParameter);
  return o as unknown as LifAction;
}

function parseActionParameter(c: DiagnosticCollector, raw: Rec): ActionParameter {
  const o: Rec = { ...raw };
  reqString(c, o, "key");
  reqString(c, o, "value");
  return o as unknown as ActionParameter;
}

function parseEdge(c: DiagnosticCollector, raw: Rec): LifEdge {
  const o: Rec = { ...raw };
  reqString(c, o, "edgeId");
  optString(c, o, "edgeName");
  optString(c, o, "edgeDescription");
  reqString(c, o, "startNodeId");
  reqString(c, o, "endNodeId");
  parseArray(c, o, "vehicleTypeEdgeProperties", parseVehicleTypeEdgeProperty, { required: true });
  return o as unknown as LifEdge;
}

function parseVehicleTypeEdgeProperty(c: DiagnosticCollector, raw: Rec): VehicleTypeEdgeProperty {
  const o: Rec = { ...raw };
  reqString(c, o, "vehicleTypeId");
  optNumber(c, o, "vehicleOrientation");
  optEnum(c, o, "orientationType", ["GLOBAL", "TANGENTIAL"]);
  reqBoolean(c, o, "rotationAllowed");
  optEnum(c, o, "rotationAtStartNodeAllowed", ["NONE", "CCW", "CW", "BOTH"]);
  optEnum(c, o, "rotationAtEndNodeAllowed", ["NONE", "CCW", "CW", "BOTH"]);
  optNumber(c, o, "maxSpeed");
  optNumber(c, o, "maxRotationSpeed");
  optNumber(c, o, "minHeight");
  optNumber(c, o, "maxHeight");
  parseObject(c, o, "loadRestriction", false, parseLoadRestriction);
  parseArray(c, o, "actions", parseAction);
  parseObject(c, o, "trajectory", false, parseTrajectory);
  optBoolean(c, o, "reentryAllowed");
  return o as unknown as VehicleTypeEdgeProperty;
}

function parseLoadRestriction(c: DiagnosticCollector, raw: Rec): LoadRestriction {
  const o: Rec = { ...raw };
  reqBoolean(c, o, "unloaded");
  reqBoolean(c, o, "loaded");
  parseStringArray(c, o, "loadSetNames", false);
  return o as unknown as LoadRestriction;
}

function parseTrajectory(c: DiagnosticCollector, raw: Rec): Trajectory {
  const o: Rec = { ...raw };
  optNumber(c, o, "degree");
  const kv = o.knotVector;
  if (kv === undefined) {
    c.error("LIF-P002", "required field 'knotVector' is missing");
    o.knotVector = [];
  } else if (!Array.isArray(kv)) {
    c.error("LIF-P003", `'knotVector' must be an array of numbers (got ${typeName(kv)})`, ".knotVector");
    o.knotVector = [];
  } else {
    const copy = kv.slice();
    o.knotVector = copy;
    copy.forEach((entry, i) => {
      if (typeof entry !== "number") {
        if (typeof entry === "string" && entry.trim() !== "" && Number.isFinite(Number(entry))) {
          copy[i] = Number(entry);
          c.warning("LIF-P004", `knot should be a number; coerced "${entry}"`, `.knotVector[${i}]`);
        } else {
          c.error("LIF-P003", `knot must be a number (got ${typeName(entry)})`, `.knotVector[${i}]`);
        }
      }
    });
  }
  parseArray(c, o, "controlPoints", parseControlPoint, { required: true });
  return o as unknown as Trajectory;
}

function parseControlPoint(c: DiagnosticCollector, raw: Rec): ControlPoint {
  const o: Rec = { ...raw };
  reqNumber(c, o, "x");
  reqNumber(c, o, "y");
  optNumber(c, o, "weight");
  return o as unknown as ControlPoint;
}

function parseStation(c: DiagnosticCollector, raw: Rec): Station {
  const o: Rec = { ...raw };
  reqString(c, o, "stationId");
  parseStringArray(c, o, "interactionNodeIds", true);
  optString(c, o, "stationName");
  optString(c, o, "stationDescription");
  optNumber(c, o, "stationHeight");
  parseObject(c, o, "stationPosition", false, parseStationPosition);
  return o as unknown as Station;
}

function parseStationPosition(c: DiagnosticCollector, raw: Rec): StationPosition {
  const o: Rec = { ...raw };
  reqNumber(c, o, "x");
  reqNumber(c, o, "y");
  optNumber(c, o, "theta");
  return o as unknown as StationPosition;
}
