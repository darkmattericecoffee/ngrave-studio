// Schneider's "Algorithm for Automatically Fitting Digitized Curves"
// (Graphics Gems I, 1990), adapted for 2D polylines.
//
// Given a dense polyline (e.g., pixel-traced skeleton), produces a list of
// cubic Bézier segments that approximate the shape within a given error
// tolerance, recursively splitting where the fit exceeds tolerance.
//
// Used by the raster centerline backend to convert 1-pixel skeleton traces
// into smooth curves instead of thousands of straight segments.

export type Vec2 = [number, number]
export type CubicBezier = [Vec2, Vec2, Vec2, Vec2]

const REPARAM_ITERATIONS = 4

export function fitPolylineToCubics(points: Vec2[], tolerance: number): CubicBezier[] {
  if (points.length < 2) return []
  if (points.length === 2) {
    return [linearCubic(points[0], points[1])]
  }

  const tHat1 = computeLeftTangent(points, 0)
  const tHat2 = computeRightTangent(points, points.length - 1)
  return fitCubicRec(points, 0, points.length - 1, tHat1, tHat2, tolerance)
}

function fitCubicRec(
  points: Vec2[],
  first: number,
  last: number,
  tHat1: Vec2,
  tHat2: Vec2,
  tolerance: number,
): CubicBezier[] {
  const nPts = last - first + 1

  // Only two points in range — use heuristic (Schneider: dist/3).
  if (nPts === 2) {
    const dist = distance(points[first], points[last]) / 3
    const p0 = points[first]
    const p3 = points[last]
    const p1: Vec2 = [p0[0] + tHat1[0] * dist, p0[1] + tHat1[1] * dist]
    const p2: Vec2 = [p3[0] + tHat2[0] * dist, p3[1] + tHat2[1] * dist]
    return [[p0, p1, p2, p3]]
  }

  let u = chordLengthParameterize(points, first, last)
  let bez = generateBezier(points, first, last, u, tHat1, tHat2)
  let [maxError, splitPoint] = computeMaxError(points, first, last, bez, u)

  if (maxError < tolerance) return [bez]

  // Try a few Newton-Raphson reparameterizations before splitting.
  if (maxError < tolerance * 4) {
    for (let i = 0; i < REPARAM_ITERATIONS; i++) {
      const uPrime = reparameterize(points, first, last, u, bez)
      bez = generateBezier(points, first, last, uPrime, tHat1, tHat2)
      const [err, sp] = computeMaxError(points, first, last, bez, uPrime)
      if (err < tolerance) return [bez]
      u = uPrime
      maxError = err
      splitPoint = sp
    }
  }

  // Split at point of maximum error, recurse.
  const tHatCenter = computeCenterTangent(points, splitPoint)
  const tHatCenterNeg: Vec2 = [-tHatCenter[0], -tHatCenter[1]]
  const left = fitCubicRec(points, first, splitPoint, tHat1, tHatCenter, tolerance)
  const right = fitCubicRec(points, splitPoint, last, tHatCenterNeg, tHat2, tolerance)
  return left.concat(right)
}

function linearCubic(a: Vec2, b: Vec2): CubicBezier {
  const p1: Vec2 = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3]
  const p2: Vec2 = [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3]
  return [a, p1, p2, b]
}

function computeLeftTangent(points: Vec2[], idx: number): Vec2 {
  return normalize([points[idx + 1][0] - points[idx][0], points[idx + 1][1] - points[idx][1]])
}

function computeRightTangent(points: Vec2[], idx: number): Vec2 {
  return normalize([points[idx - 1][0] - points[idx][0], points[idx - 1][1] - points[idx][1]])
}

function computeCenterTangent(points: Vec2[], idx: number): Vec2 {
  const v1: Vec2 = [points[idx - 1][0] - points[idx][0], points[idx - 1][1] - points[idx][1]]
  const v2: Vec2 = [points[idx][0] - points[idx + 1][0], points[idx][1] - points[idx + 1][1]]
  return normalize([(v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2])
}

function chordLengthParameterize(points: Vec2[], first: number, last: number): number[] {
  const u: number[] = new Array(last - first + 1)
  u[0] = 0
  for (let i = first + 1; i <= last; i++) {
    u[i - first] = u[i - first - 1] + distance(points[i], points[i - 1])
  }
  const total = u[last - first]
  if (total > 0) {
    for (let i = 1; i <= last - first; i++) u[i] /= total
  }
  return u
}

/**
 * Generate a bezier fitting the points[first..last] with tangent constraints.
 * Solves the 2x2 matrix equation from Schneider's paper for α1, α2.
 */
function generateBezier(
  points: Vec2[],
  first: number,
  last: number,
  uPrime: number[],
  tHat1: Vec2,
  tHat2: Vec2,
): CubicBezier {
  const nPts = last - first + 1
  // Precompute A[i][0] = tHat1 * B1(u), A[i][1] = tHat2 * B2(u)
  const A: Array<[Vec2, Vec2]> = new Array(nPts)
  for (let i = 0; i < nPts; i++) {
    const u = uPrime[i]
    const b1 = 3 * u * (1 - u) * (1 - u)
    const b2 = 3 * u * u * (1 - u)
    A[i] = [
      [tHat1[0] * b1, tHat1[1] * b1],
      [tHat2[0] * b2, tHat2[1] * b2],
    ]
  }

  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  const p0 = points[first]
  const p3 = points[last]

  for (let i = 0; i < nPts; i++) {
    const u = uPrime[i]
    const b0 = (1 - u) * (1 - u) * (1 - u)
    const b1 = 3 * u * (1 - u) * (1 - u)
    const b2 = 3 * u * u * (1 - u)
    const b3 = u * u * u
    // Target = points[first+i] - (B0*p0 + B3*p3)
    const tx = points[first + i][0] - (b0 + b1) * p0[0] - (b2 + b3) * p3[0]
    const ty = points[first + i][1] - (b0 + b1) * p0[1] - (b2 + b3) * p3[1]

    c00 += A[i][0][0] * A[i][0][0] + A[i][0][1] * A[i][0][1]
    c01 += A[i][0][0] * A[i][1][0] + A[i][0][1] * A[i][1][1]
    c11 += A[i][1][0] * A[i][1][0] + A[i][1][1] * A[i][1][1]
    x0 += A[i][0][0] * tx + A[i][0][1] * ty
    x1 += A[i][1][0] * tx + A[i][1][1] * ty
  }

  const det = c00 * c11 - c01 * c01
  let alpha1 = 0
  let alpha2 = 0
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - x1 * c01) / det
    alpha2 = (c00 * x1 - c01 * x0) / det
  }

  // Fall back to Wu-Barsky heuristic when alphas are negative or too small.
  const segLen = distance(p0, p3)
  const epsilon = 1e-6 * segLen
  if (alpha1 < epsilon || alpha2 < epsilon) {
    const dist = segLen / 3
    alpha1 = dist
    alpha2 = dist
  }

  return [
    p0,
    [p0[0] + tHat1[0] * alpha1, p0[1] + tHat1[1] * alpha1],
    [p3[0] + tHat2[0] * alpha2, p3[1] + tHat2[1] * alpha2],
    p3,
  ]
}

function computeMaxError(
  points: Vec2[],
  first: number,
  last: number,
  bez: CubicBezier,
  u: number[],
): [number, number] {
  let maxDist = 0
  let splitPoint = Math.floor((last - first + 1) / 2) + first
  for (let i = first + 1; i < last; i++) {
    const p = bezierEval(bez, u[i - first])
    const dx = p[0] - points[i][0]
    const dy = p[1] - points[i][1]
    const sq = dx * dx + dy * dy
    if (sq >= maxDist) {
      maxDist = sq
      splitPoint = i
    }
  }
  return [Math.sqrt(maxDist), splitPoint]
}

function reparameterize(
  points: Vec2[],
  first: number,
  last: number,
  u: number[],
  bez: CubicBezier,
): number[] {
  const uPrime: number[] = new Array(last - first + 1)
  for (let i = first; i <= last; i++) {
    uPrime[i - first] = newtonRaphsonRootFind(bez, points[i], u[i - first])
  }
  return uPrime
}

function newtonRaphsonRootFind(Q: CubicBezier, P: Vec2, u: number): number {
  // Q'(u) and Q''(u) control points
  const Q1: [Vec2, Vec2, Vec2] = [
    [3 * (Q[1][0] - Q[0][0]), 3 * (Q[1][1] - Q[0][1])],
    [3 * (Q[2][0] - Q[1][0]), 3 * (Q[2][1] - Q[1][1])],
    [3 * (Q[3][0] - Q[2][0]), 3 * (Q[3][1] - Q[2][1])],
  ]
  const Q2: [Vec2, Vec2] = [
    [2 * (Q1[1][0] - Q1[0][0]), 2 * (Q1[1][1] - Q1[0][1])],
    [2 * (Q1[2][0] - Q1[1][0]), 2 * (Q1[2][1] - Q1[1][1])],
  ]

  const Qu = bezierEval(Q, u)
  const Q1u = bezier2Eval(Q1, u)
  const Q2u = bezier1Eval(Q2, u)

  const num = (Qu[0] - P[0]) * Q1u[0] + (Qu[1] - P[1]) * Q1u[1]
  const den = Q1u[0] * Q1u[0] + Q1u[1] * Q1u[1] + (Qu[0] - P[0]) * Q2u[0] + (Qu[1] - P[1]) * Q2u[1]
  if (Math.abs(den) < 1e-12) return u
  return u - num / den
}

function bezierEval(b: CubicBezier, t: number): Vec2 {
  const mt = 1 - t
  const b0 = mt * mt * mt
  const b1 = 3 * mt * mt * t
  const b2 = 3 * mt * t * t
  const b3 = t * t * t
  return [
    b0 * b[0][0] + b1 * b[1][0] + b2 * b[2][0] + b3 * b[3][0],
    b0 * b[0][1] + b1 * b[1][1] + b2 * b[2][1] + b3 * b[3][1],
  ]
}

function bezier2Eval(b: [Vec2, Vec2, Vec2], t: number): Vec2 {
  const mt = 1 - t
  return [
    mt * mt * b[0][0] + 2 * mt * t * b[1][0] + t * t * b[2][0],
    mt * mt * b[0][1] + 2 * mt * t * b[1][1] + t * t * b[2][1],
  ]
}

function bezier1Eval(b: [Vec2, Vec2], t: number): Vec2 {
  return [(1 - t) * b[0][0] + t * b[1][0], (1 - t) * b[0][1] + t * b[1][1]]
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1])
  if (len === 0) return [0, 0]
  return [v[0] / len, v[1] / len]
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}
