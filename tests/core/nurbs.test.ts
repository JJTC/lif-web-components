import { describe, expect, test } from "bun:test";
import {
  evaluateTrajectory,
  isTrajectoryEvaluable,
  sampleTrajectory,
  trajectoryDomain,
  type Trajectory,
} from "../../src/lif";

const line: Trajectory = {
  degree: 1,
  knotVector: [0, 0, 1, 1],
  controlPoints: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
};

describe("degree-1 (polyline) trajectories", () => {
  test("evaluates linearly between control points", () => {
    expect(evaluateTrajectory(line, 0)).toEqual({ x: 0, y: 0 });
    expect(evaluateTrajectory(line, 0.5)).toEqual({ x: 5, y: 0 });
    expect(evaluateTrajectory(line, 1)).toEqual({ x: 10, y: 0 });
  });

  test("clamps parameters outside the domain", () => {
    expect(evaluateTrajectory(line, -3)).toEqual({ x: 0, y: 0 });
    expect(evaluateTrajectory(line, 42)).toEqual({ x: 10, y: 0 });
  });

  test("degree defaults to 1 when omitted", () => {
    const t: Trajectory = {
      knotVector: [0, 0, 0.5, 1, 1],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 4, y: 4 },
        { x: 8, y: 0 },
      ],
    };
    expect(isTrajectoryEvaluable(t)).toBe(true);
    expect(evaluateTrajectory(t, 0.5)).toEqual({ x: 4, y: 4 });
    expect(evaluateTrajectory(t, 0.25)).toEqual({ x: 2, y: 2 });
  });
});

describe("rational curves", () => {
  test("a weighted quadratic reproduces an exact quarter circle", () => {
    // Classic rational Bézier quarter circle of radius 1 around the origin.
    const quarter: Trajectory = {
      degree: 2,
      knotVector: [0, 0, 0, 1, 1, 1],
      controlPoints: [
        { x: 1, y: 0 },
        { x: 1, y: 1, weight: Math.SQRT1_2 },
        { x: 0, y: 1 },
      ],
    };
    for (const p of sampleTrajectory(quarter, 50)) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 12);
    }
    expect(evaluateTrajectory(quarter, 0)).toEqual({ x: 1, y: 0 });
    expect(evaluateTrajectory(quarter, 1)).toEqual({ x: 0, y: 1 });
  });

  test("guideline-style half circle (example 10.17 shape) starts and ends on its control points", () => {
    // Same structure as the guideline's trajectory example: degree 2,
    // knots [0,0,0,0.5,1,1,1], four control points — our own geometry.
    const half: Trajectory = {
      degree: 2,
      knotVector: [0, 0, 0, 0.5, 1, 1, 1],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 0, y: 1.8 },
        { x: 3.6, y: 1.8 },
        { x: 3.6, y: 0 },
      ],
    };
    expect(isTrajectoryEvaluable(half)).toBe(true);
    const pts = sampleTrajectory(half, 32);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[32]).toEqual({ x: 3.6, y: 0 });
    // Curve bulges upward and stays inside the control hull.
    const apex = evaluateTrajectory(half, 0.5);
    expect(apex.y).toBeGreaterThan(1);
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(-1e-12);
      expect(p.y).toBeLessThanOrEqual(1.8 + 1e-12);
      expect(p.x).toBeGreaterThanOrEqual(-1e-12);
      expect(p.x).toBeLessThanOrEqual(3.6 + 1e-12);
    }
    // Symmetric around the mid-parameter.
    expect(apex.x).toBeCloseTo(1.8, 12);
  });
});

describe("structural checks", () => {
  test("wrong knot count is not evaluable and sampling throws", () => {
    const bad: Trajectory = {
      degree: 2,
      knotVector: [0, 0, 0, 1, 1],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 0 },
      ],
    };
    expect(isTrajectoryEvaluable(bad)).toBe(false);
    expect(() => sampleTrajectory(bad)).toThrow();
  });

  test("decreasing knots, too few control points, and negative weights are rejected", () => {
    expect(
      isTrajectoryEvaluable({
        degree: 1,
        knotVector: [0, 0.7, 0.3, 1],
        controlPoints: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      }),
    ).toBe(false);
    expect(
      isTrajectoryEvaluable({
        degree: 3,
        knotVector: [0, 0, 0, 0, 1, 1, 1, 1],
        controlPoints: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
    ).toBe(false);
    expect(
      isTrajectoryEvaluable({
        degree: 1,
        knotVector: [0, 0, 1, 1],
        controlPoints: [
          { x: 0, y: 0 },
          { x: 1, y: 0, weight: -2 },
        ],
      }),
    ).toBe(false);
  });

  test("sampleTrajectory validates the segment count", () => {
    expect(() => sampleTrajectory(line, 0)).toThrow();
    expect(() => sampleTrajectory(line, 2.5)).toThrow();
  });

  test("domain follows the knot vector", () => {
    expect(trajectoryDomain(line)).toEqual([0, 1]);
    const shifted: Trajectory = {
      degree: 1,
      knotVector: [0, 0.25, 0.75, 1],
      controlPoints: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ],
    };
    expect(trajectoryDomain(shifted)).toEqual([0.25, 0.75]);
    // Unclamped ends still evaluate inside the domain.
    expect(evaluateTrajectory(shifted, 0.5).x).toBeCloseTo(2, 12);
  });
});
