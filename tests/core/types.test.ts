import { describe, expect, test } from "bun:test";
import {
  combineRotationDirections,
  getDegree,
  getOrientationType,
  getReentryAllowed,
  getRotationAtEndNodeAllowed,
  getRotationAtStartNodeAllowed,
  getStationHeight,
  getWeight,
  type RotationDirection,
  type VehicleTypeEdgeProperty,
} from "../../src/lif";

const bareEdgeProperty: VehicleTypeEdgeProperty = {
  vehicleTypeId: "t",
  rotationAllowed: true,
};

describe("defined-default accessors (guideline defaults, never injected by the parser)", () => {
  test("edge property defaults", () => {
    expect(getOrientationType(bareEdgeProperty)).toBe("TANGENTIAL");
    expect(getRotationAtStartNodeAllowed(bareEdgeProperty)).toBe("BOTH");
    expect(getRotationAtEndNodeAllowed(bareEdgeProperty)).toBe("BOTH");
    expect(getReentryAllowed(bareEdgeProperty)).toBe(true);
  });

  test("explicit values win over defaults", () => {
    const p: VehicleTypeEdgeProperty = {
      ...bareEdgeProperty,
      orientationType: "GLOBAL",
      rotationAtStartNodeAllowed: "CW",
      rotationAtEndNodeAllowed: "NONE",
      reentryAllowed: false,
    };
    expect(getOrientationType(p)).toBe("GLOBAL");
    expect(getRotationAtStartNodeAllowed(p)).toBe("CW");
    expect(getRotationAtEndNodeAllowed(p)).toBe("NONE");
    expect(getReentryAllowed(p)).toBe(false);
  });

  test("trajectory, control point and station defaults", () => {
    expect(getDegree({ knotVector: [0, 0, 1, 1], controlPoints: [] })).toBe(1);
    expect(getDegree({ degree: 3, knotVector: [], controlPoints: [] })).toBe(3);
    expect(getWeight({ x: 0, y: 0 })).toBe(1);
    expect(getWeight({ x: 0, y: 0, weight: 0 })).toBe(0);
    expect(getStationHeight({ stationId: "s", interactionNodeIds: ["n"] })).toBe(0);
    expect(
      getStationHeight({ stationId: "s", interactionNodeIds: ["n"], stationHeight: 2.5 }),
    ).toBe(2.5);
  });
});

describe("combineRotationDirections (guideline 8.3.9.1: boolean AND per direction)", () => {
  const cases: Array<[RotationDirection, RotationDirection, RotationDirection]> = [
    ["BOTH", "BOTH", "BOTH"],
    ["BOTH", "NONE", "NONE"], // the guideline's own example
    ["NONE", "BOTH", "NONE"],
    ["BOTH", "CW", "CW"], // CW on one side restricts BOTH
    ["CCW", "BOTH", "CCW"],
    ["CW", "CW", "CW"],
    ["CCW", "CCW", "CCW"],
    ["CW", "CCW", "NONE"], // directional values that do not align
    ["CCW", "CW", "NONE"],
    ["NONE", "NONE", "NONE"],
    ["CW", "NONE", "NONE"],
  ];
  for (const [a, b, want] of cases) {
    test(`${a} ∧ ${b} = ${want}`, () => {
      expect(combineRotationDirections(a, b)).toBe(want);
    });
  }

  test("is commutative", () => {
    const values: RotationDirection[] = ["NONE", "CW", "CCW", "BOTH"];
    for (const a of values) {
      for (const b of values) {
        expect(combineRotationDirections(a, b)).toBe(combineRotationDirections(b, a));
      }
    }
  });
});
