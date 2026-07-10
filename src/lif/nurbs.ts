/**
 * NURBS evaluation for LIF edge trajectories (guideline 8.3.11/8.3.12).
 *
 * Standard rational B-spline machinery (knot span search + basis functions,
 * cf. Piegl & Tiller). Works in the curve's parametric domain
 * [knot[degree], knot[n+1]] so both clamped and unclamped knot vectors evaluate.
 */

import { getDegree, getWeight, type Trajectory } from "./types";

export interface Vec2 {
  x: number;
  y: number;
}

/** Structural check: can this trajectory be evaluated at all? */
export function isTrajectoryEvaluable(t: Trajectory): boolean {
  const p = getDegree(t);
  const cp = t.controlPoints;
  if (!Number.isInteger(p) || p < 1) return false;
  if (cp.length < p + 1) return false;
  if (t.knotVector.length !== cp.length + p + 1) return false;
  for (let i = 1; i < t.knotVector.length; i++) {
    if (!(t.knotVector[i]! >= t.knotVector[i - 1]!)) return false;
  }
  const [a, b] = trajectoryDomain(t);
  if (!(a < b)) return false;
  return cp.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && getWeight(c) >= 0);
}

/** Parametric domain [u_min, u_max] of the curve. */
export function trajectoryDomain(t: Trajectory): [number, number] {
  const p = getDegree(t);
  const n = t.controlPoints.length - 1;
  return [t.knotVector[p]!, t.knotVector[n + 1]!];
}

/** Largest span index i in [degree, n] with knot[i] <= u < knot[i+1]. */
function findSpan(t: Trajectory, u: number): number {
  const p = getDegree(t);
  const n = t.controlPoints.length - 1;
  const U = t.knotVector;
  if (u >= U[n + 1]!) return n;
  if (u <= U[p]!) return p;
  let low = p;
  let high = n + 1;
  let mid = (low + high) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** Non-zero basis functions N_{span-p..span} at u (triangular scheme). */
function basisFunctions(t: Trajectory, span: number, u: number): number[] {
  const p = getDegree(t);
  const U = t.knotVector;
  const N: number[] = new Array(p + 1).fill(0);
  const left: number[] = new Array(p + 1).fill(0);
  const right: number[] = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j]!;
    right[j] = U[span + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1]! + left[j - r]!;
      const temp = denom === 0 ? 0 : N[r]! / denom;
      N[r] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    N[j] = saved;
  }
  return N;
}

/**
 * Evaluate the curve at parameter u (clamped into the domain).
 * Throws if the trajectory is not evaluable — check `isTrajectoryEvaluable` first.
 */
export function evaluateTrajectory(t: Trajectory, u: number): Vec2 {
  if (!isTrajectoryEvaluable(t)) {
    throw new Error("trajectory is not evaluable (inconsistent degree/knots/control points)");
  }
  const [a, b] = trajectoryDomain(t);
  const uu = Math.min(Math.max(u, a), b);
  const p = getDegree(t);
  const span = findSpan(t, uu);
  const N = basisFunctions(t, span, uu);
  let x = 0;
  let y = 0;
  let w = 0;
  for (let j = 0; j <= p; j++) {
    const cp = t.controlPoints[span - p + j]!;
    const cw = N[j]! * getWeight(cp);
    x += cw * cp.x;
    y += cw * cp.y;
    w += cw;
  }
  if (w === 0) {
    // Degenerate (e.g. all weights zero in this span); fall back to the span's anchor point.
    const cp = t.controlPoints[span]!;
    return { x: cp.x, y: cp.y };
  }
  return { x: x / w, y: y / w };
}

/**
 * Sample the curve into `segments + 1` points, uniformly in parameter space.
 * Throws if the trajectory is not evaluable.
 */
export function sampleTrajectory(t: Trajectory, segments = 64): Vec2[] {
  if (segments < 1 || !Number.isInteger(segments)) {
    throw new Error(`segments must be a positive integer (got ${segments})`);
  }
  const [a, b] = trajectoryDomain(t);
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    pts.push(evaluateTrajectory(t, a + ((b - a) * i) / segments));
  }
  return pts;
}
