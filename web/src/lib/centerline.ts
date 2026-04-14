import {
  CpNodeFs,
  findMats,
  getBranches,
  getPathsFromStr,
  simplifyMat,
  toScaleAxis,
  type CpNode,
  type Mat,
  type MatOptions,
} from 'flo-mat'
import svgpath from 'svgpath'

import { resolveNodeCncMetadata } from './cncMetadata'
import { generateRasterSkeleton, type RasterBranch } from './centerlineRaster'
import { fitPolylineToCubics, type CubicBezier } from './bezierFit'
import type { CanvasNode, CenterlineMetadata, PathNode } from '../types/editor'

type Matrix = [number, number, number, number, number, number]
type Bezier = number[][]

export interface CenterlineResult {
  pathData: string | null
  segmentCount: number
  branchCount: number
  error: string | null
}

export const DEFAULT_CENTERLINE_METADATA: CenterlineMetadata = {
  enabled: true,
  scaleAxis: 1.5,
  samples: 3,
  edgeTrim: 1,
  simplifyTolerance: 0.5,
  forceRaster: false,
}

const CENTERLINE_SCALE_MIN = 1
const CENTERLINE_SCALE_MAX = 4
const CENTERLINE_SAMPLES_MIN = 3
const CENTERLINE_SAMPLES_MAX = 15
const CENTERLINE_EDGE_TRIM_MIN = 0
const CENTERLINE_EDGE_TRIM_MAX = 20
const CENTERLINE_SIMPLIFY_MIN = 0
const CENTERLINE_SIMPLIFY_MAX = 5
const DEFAULT_TOOL_DIAMETER = 3
const CENTERLINE_CACHE_LIMIT = 24
const LENGTH_EPSILON = 1e-6

const centerlineCache = new Map<string, CenterlineResult>()

export interface CenterlineGenerationOptions {
  toolDiameter?: number
}

interface CenterlineProcessingOptions {
  edgeTrimDistance: number
  simplifyTolerance?: number
}

interface CenterlineEdge {
  bezier: Bezier
  startNode: CpNode | null
  endNode: CpNode | null
  startRadius: number
  endRadius: number
}

interface BranchPath {
  pathData: string
  segmentCount: number
}

interface CenterlineBranch {
  edges: CenterlineEdge[]
  startLeaf: boolean
  endLeaf: boolean
  discarded?: boolean
  syntheticPathData?: string
  syntheticSegmentCount?: number
}

type BranchSide = 'start' | 'end'

interface BranchEndpoint {
  branchIndex: number
  side: BranchSide
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function normalizeCenterlineMetadata(
  metadata: Partial<CenterlineMetadata> | undefined,
): CenterlineMetadata {
  const scaleAxis = metadata?.scaleAxis
  const samples = metadata?.samples
  const edgeTrim = metadata?.edgeTrim
  const simplifyTolerance = metadata?.simplifyTolerance

  return {
    enabled: metadata?.enabled ?? DEFAULT_CENTERLINE_METADATA.enabled,
    scaleAxis: clamp(
      scaleAxis !== undefined && Number.isFinite(scaleAxis)
        ? scaleAxis
        : DEFAULT_CENTERLINE_METADATA.scaleAxis,
      CENTERLINE_SCALE_MIN,
      CENTERLINE_SCALE_MAX,
    ),
    samples: Math.round(clamp(
      samples !== undefined && Number.isFinite(samples)
        ? samples
        : DEFAULT_CENTERLINE_METADATA.samples,
      CENTERLINE_SAMPLES_MIN,
      CENTERLINE_SAMPLES_MAX,
    )),
    edgeTrim: clamp(
      edgeTrim !== undefined && Number.isFinite(edgeTrim)
        ? edgeTrim
        : DEFAULT_CENTERLINE_METADATA.edgeTrim,
      CENTERLINE_EDGE_TRIM_MIN,
      CENTERLINE_EDGE_TRIM_MAX,
    ),
    simplifyTolerance: clamp(
      simplifyTolerance !== undefined && Number.isFinite(simplifyTolerance)
        ? simplifyTolerance
        : DEFAULT_CENTERLINE_METADATA.simplifyTolerance,
      CENTERLINE_SIMPLIFY_MIN,
      CENTERLINE_SIMPLIFY_MAX,
    ),
    forceRaster: metadata?.forceRaster === true,
  }
}

export function hasActiveCenterline(node: CanvasNode | undefined): boolean {
  return node?.centerlineMetadata?.enabled === true
}

export function subtreeHasActiveCenterline(
  node: CanvasNode | undefined,
  nodesById: Record<string, CanvasNode>,
): boolean {
  if (!node || !node.visible) return false
  if (hasActiveCenterline(node)) return true

  if (node.type !== 'group') return false
  return node.childIds.some((childId) => subtreeHasActiveCenterline(nodesById[childId], nodesById))
}

export function generateCenterlineForNode(
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
  options: CenterlineGenerationOptions = {},
): CenterlineResult {
  const node = nodesById[nodeId]
  if (!node || !node.visible) {
    return {
      pathData: null,
      segmentCount: 0,
      branchCount: 0,
      error: 'Select a visible filled path or group to create centerlines.',
    }
  }

  const metadata = normalizeCenterlineMetadata(node.centerlineMetadata)
  const collected = collectCenterlinePathData(nodeId, nodesById)
  if (collected.error) {
    return { pathData: null, segmentCount: 0, branchCount: 0, error: collected.error }
  }

  if (collected.pathData.length === 0) {
    return {
      pathData: null,
      segmentCount: 0,
      branchCount: 0,
      error: 'No supported filled closed paths were found for centerlines.',
    }
  }

  try {
    const edgeTrimDistance = trimDistanceFromMetadata(metadata, options.toolDiameter)
    const cacheKey = centerlineCacheKey(collected.pathData, metadata, edgeTrimDistance)
    const cached = getCachedCenterline(cacheKey)
    if (cached) return cached

    const bezierLoops = getPathsFromStr(collected.pathData.join(' '))
    if (bezierLoops.length === 0) {
      return {
        pathData: null,
        segmentCount: 0,
        branchCount: 0,
        error: 'FloMat could not read any closed loops from the selected shape.',
      }
    }

    const backend = pickBackend(bezierLoops, metadata)
    let result: CenterlineResult

    if (backend === 'raster') {
      const bounds = boundsFromBezierLoops(bezierLoops)
      const rasterResult = bounds
        ? rasterBackendToResult(collected.pathData, bounds, {
            edgeTrimDistance,
            simplifyTolerance: metadata.simplifyTolerance,
          })
        : null
      if (rasterResult && rasterResult.pathData) {
        result = rasterResult
      } else {
        // Raster failed — fall back to the MAT backend so the user still gets output.
        const mats = findMats(bezierLoops, matOptionsForMetadata(metadata))
        const sats = mats.map((mat) => {
          const sat = toScaleAxis(mat, metadata.scaleAxis)
          if (metadata.simplifyTolerance <= 0 || !sat.cpNode) return sat
          return simplifyMat(sat, metadata.simplifyTolerance)
        })
        result = matsToPathData(sats, { edgeTrimDistance })
      }
    } else {
      const mats = findMats(bezierLoops, matOptionsForMetadata(metadata))
      const sats = mats.map((mat) => {
        const sat = toScaleAxis(mat, metadata.scaleAxis)
        if (metadata.simplifyTolerance <= 0 || !sat.cpNode) return sat
        return simplifyMat(sat, metadata.simplifyTolerance)
      })
      result = matsToPathData(sats, { edgeTrimDistance })
    }

    setCachedCenterline(cacheKey, result)
    return result
  } catch (error) {
    return {
      pathData: null,
      segmentCount: 0,
      branchCount: 0,
      error: `Centerlines could not be generated: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function buildCenterlineExportNodes(
  rootId: string,
  nodesById: Record<string, CanvasNode>,
  options: CenterlineGenerationOptions = {},
): { rootNode: CanvasNode; nodesById: Record<string, CanvasNode> } {
  const nextNodes: Record<string, CanvasNode> = {}

  const cloneNode = (nodeId: string): void => {
    const node = nodesById[nodeId]
    if (!node || !node.visible) return

    if (hasActiveCenterline(node)) {
      const result = generateCenterlineForNode(nodeId, nodesById, options)
      if (!result.pathData || result.error) {
        throw new Error(result.error ?? 'Centerlines could not be generated for G-code export.')
      }

      const effectiveMetadata = resolveNodeCncMetadata(node, nodesById)
      nextNodes[nodeId] = {
        id: node.id,
        type: 'path',
        name: `${node.name || 'Shape'} Centerline`,
        x: node.x,
        y: node.y,
        rotation: node.rotation,
        scaleX: node.scaleX,
        scaleY: node.scaleY,
        draggable: node.draggable,
        locked: node.locked,
        visible: node.visible,
        opacity: 1,
        parentId: node.parentId,
        data: result.pathData,
        fill: undefined,
        stroke: '#000000',
        strokeWidth: 1,
        fillRule: undefined,
        cncMetadata: {
          ...effectiveMetadata,
          engraveType: 'contour',
        },
      } satisfies PathNode
      return
    }

    if (node.type === 'group') {
      nextNodes[nodeId] = { ...node, childIds: [...node.childIds] }
      node.childIds.forEach(cloneNode)
      return
    }

    nextNodes[nodeId] = { ...node } as CanvasNode
  }

  cloneNode(rootId)
  const rootNode = nextNodes[rootId]
  if (!rootNode) {
    throw new Error('Centerline export did not produce a visible root node.')
  }

  return { rootNode, nodesById: nextNodes }
}

interface CollectResult {
  pathData: string[]
  error: string | null
}

function collectCenterlinePathData(
  rootId: string,
  nodesById: Record<string, CanvasNode>,
): CollectResult {
  const pathData: string[] = []
  let error: string | null = null

  const visit = (nodeId: string, parentMatrix: Matrix, includeOwnTransform: boolean): void => {
    if (error) return
    const node = nodesById[nodeId]
    if (!node || !node.visible) return

    const matrix = includeOwnTransform
      ? multiplyMatrices(parentMatrix, matrixForNode(node))
      : parentMatrix

    if (node.type === 'group') {
      node.childIds.forEach((childId) => visit(childId, matrix, true))
      return
    }

    if (node.type !== 'path') {
      error = 'Centerlines currently support only filled closed path geometry.'
      return
    }

    const normalized = normalizeSupportedPath(node, matrix)
    if (normalized.error) {
      error = normalized.error
      return
    }

    if (normalized.pathData) {
      pathData.push(normalized.pathData)
    }
  }

  visit(rootId, identityMatrix(), false)
  return { pathData, error }
}

function normalizeSupportedPath(
  node: PathNode,
  matrix: Matrix,
): { pathData: string | null; error: string | null } {
  if (!node.fill) {
    return { pathData: null, error: 'Centerlines currently require filled paths.' }
  }

  if (!/[Zz]/.test(node.data)) {
    return { pathData: null, error: 'Centerlines currently require closed paths.' }
  }

  try {
    return {
      pathData: svgpath(node.data)
        .unarc()
        .unshort()
        .abs()
        .matrix(matrix)
        .round(3)
        .toString(),
      error: null,
    }
  } catch (error) {
    return {
      pathData: null,
      error: `A path could not be prepared for centerlines: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function matOptionsForMetadata(metadata: CenterlineMetadata): MatOptions {
  const normalized = normalizeCenterlineMetadata(metadata)
  return {
    applySat: false,
    simplify: false,
    maxCurviness: clamp(1.2 / normalized.samples, 0.01, 3),
    maxLength: clamp(48 / normalized.samples, 1, 1024),
    angleIncrement: clamp(45 / normalized.samples, 3, 15),
  }
}

function trimDistanceFromMetadata(
  metadata: CenterlineMetadata,
  toolDiameter: number | undefined,
): number {
  const normalized = normalizeCenterlineMetadata(metadata)
  const diameter = Number.isFinite(toolDiameter) && toolDiameter !== undefined
    ? toolDiameter
    : DEFAULT_TOOL_DIAMETER
  return Math.max(0, diameter) * 0.5 * normalized.edgeTrim
}

function centerlineCacheKey(
  pathData: string[],
  metadata: CenterlineMetadata,
  edgeTrimDistance: number,
): string {
  return JSON.stringify({
    pathData,
    scaleAxis: metadata.scaleAxis,
    samples: metadata.samples,
    edgeTrimDistance,
    simplifyTolerance: metadata.simplifyTolerance,
    forceRaster: metadata.forceRaster === true,
  })
}

// -----------------------------------------------------------------------------
// Backend selection (MAT vs raster thinning)
// -----------------------------------------------------------------------------

type BezierLoop = number[][][]

function pickBackend(
  bezierLoops: BezierLoop[],
  metadata: CenterlineMetadata,
): 'mat' | 'raster' {
  if (metadata.forceRaster) return 'raster'
  // Annulus detection: sort loops by area, test if any smaller loop is
  // contained inside a larger loop. If yes, the shape has a hole → raster.
  if (bezierLoops.length < 2) return 'mat'

  const infos = bezierLoops
    .map((loop, idx) => {
      const polygon = loopToPolygon(loop)
      if (polygon.length < 3) return null
      return {
        idx,
        polygon,
        area: Math.abs(polygonArea(polygon)),
        sample: polygon[0],
      }
    })
    .filter((info): info is { idx: number; polygon: number[][]; area: number; sample: number[] } => Boolean(info))
    .sort((a, b) => b.area - a.area)

  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      if (pointInPolygon(infos[j].sample, infos[i].polygon)) return 'raster'
    }
  }
  return 'mat'
}

function loopToPolygon(loop: BezierLoop): number[][] {
  const points: number[][] = []
  for (const bezier of loop) {
    if (!bezier || bezier.length === 0) continue
    const first = bezier[0]
    if (points.length === 0 && first) points.push([first[0], first[1]])
    // Sample a handful of points per bezier to approximate the polygon.
    const samples = 4
    for (let i = 1; i <= samples; i++) {
      const t = i / samples
      const p = pointAtBezier(bezier, t)
      points.push([p[0], p[1]])
    }
  }
  return points
}

function polygonArea(points: number[][]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return sum * 0.5
}

function pointInPolygon(point: number[], polygon: number[][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0]
    const yi = polygon[i][1]
    const xj = polygon[j][0]
    const yj = polygon[j][1]
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function boundsFromBezierLoops(loops: BezierLoop[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const loop of loops) {
    for (const bezier of loop) {
      for (const point of bezier) {
        if (!point) continue
        if (point[0] < minX) minX = point[0]
        if (point[1] < minY) minY = point[1]
        if (point[0] > maxX) maxX = point[0]
        if (point[1] > maxY) maxY = point[1]
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { minX, minY, maxX, maxY }
}

function rasterBackendToResult(
  pathData: string[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  options: CenterlineProcessingOptions,
): CenterlineResult | null {
  let raster
  try {
    raster = generateRasterSkeleton(pathData, bounds)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[centerline] raster backend failed', err)
    }
    return null
  }
  if (raster.error || raster.branches.length === 0) return null

  const rawBranches = rasterBranchesToCenterlineBranches(
    raster.branches,
    options.simplifyTolerance ?? 0.5,
  )
  if (rawBranches.length === 0) return null

  // Raster tracing now produces one long continuous polyline per skeleton
  // component (the directional walk passes through Zhang-Suen junction knots
  // by picking the most-collinear continuation). Emit the polylines directly
  // after leaf trimming — the graph stitching pipeline is tuned for flo-mat
  // beziers and just adds noise on polyline input.
  const parts: string[] = []
  let segmentCount = 0
  // Trim distances: the user's `edgeTrim` pulls back true leaves (outline
  // endings), and half that amount pulls back junction ends so branches
  // meeting at a shared skeleton junction don't visually overshoot into
  // the adjacent stroke's interior. Zhang-Suen leaves the junction pixel
  // inside the thicker stroke's fill region, so the raw skeleton end of a
  // thinner branch can reach ~1 skeleton-radius past the visual stroke
  // boundary of the thicker one. Half the edgeTrim closes that visual gap
  // cleanly without introducing a hard break.
  const leafTrim = options.edgeTrimDistance
  const junctionTrim = options.edgeTrimDistance * 0.5
  for (const branch of rawBranches) {
    const beziers = branch.edges.map((e) => cloneBezier(e.bezier))
    const startDistance = branch.startLeaf ? leafTrim : junctionTrim
    const endDistance = branch.endLeaf ? leafTrim : junctionTrim
    let trimmed = trimBeziersFromStart(beziers, startDistance)
    trimmed = trimBeziersFromEnd(trimmed, endDistance)
    if (trimmed.length === 0) continue
    const pathDataStr = beziersToContinuousPathData(trimmed)
    if (!pathDataStr) continue
    parts.push(pathDataStr)
    segmentCount += trimmed.length
  }
  if (parts.length === 0) return null
  return {
    pathData: parts.join(' '),
    segmentCount,
    branchCount: rawBranches.length,
    error: null,
  }
}

function rasterBranchesToCenterlineBranches(
  rasterBranches: RasterBranch[],
  fitTolerance: number,
): CenterlineBranch[] {
  const out: CenterlineBranch[] = []
  for (const rb of rasterBranches) {
    if (rb.points.length < 2) continue
    // Pre-simplify with a tight RDP tolerance to strip pixel-stairstep noise
    // before the curve fitter. 0.15mm ≈ 1.5 px at 10 px/mm — small enough to
    // preserve real curvature, large enough to kill axis-aligned stairsteps.
    const simplified = rdpSimplify(rb.points, 0.15)
    // Detect sharp corners (e.g. the pointed bottom of an apple) and split
    // the polyline there before fitting — otherwise Schneider rounds them
    // into a smooth curve. Angle threshold: 50° deviation from straight.
    const cornerIndices = findSharpCorners(simplified, 1.5, Math.cos((Math.PI * 50) / 180))
    // Fit a chain of cubic Béziers to each segment between corners. Tolerance
    // is the max perpendicular distance any original point may lie from the
    // fitted curve. Matches the user's `simplifyTolerance` slider (mm).
    const cubics: CubicBezier[] = []
    const tol = Math.max(0.05, fitTolerance)
    let start = 0
    for (const corner of cornerIndices) {
      if (corner - start >= 1) {
        const segment = simplified.slice(start, corner + 1)
        cubics.push(...fitPolylineToCubics(segment, tol))
      }
      start = corner
    }
    if (simplified.length - 1 - start >= 1) {
      const segment = simplified.slice(start)
      cubics.push(...fitPolylineToCubics(segment, tol))
    }
    if (cubics.length === 0) continue
    const edges: CenterlineEdge[] = cubics.map((c: CubicBezier) => ({
      bezier: [
        [c[0][0], c[0][1]],
        [c[1][0], c[1][1]],
        [c[2][0], c[2][1]],
        [c[3][0], c[3][1]],
      ],
      startNode: null,
      endNode: null,
      startRadius: 0,
      endRadius: 0,
    }))
    out.push({ edges, startLeaf: rb.startLeaf, endLeaf: rb.endLeaf })
  }
  return out
}

/**
 * Scan a polyline for sharp corners. Returns the indices of vertices whose
 * incoming/outgoing tangents (sampled at ~`windowMm` on each side) have a
 * normalized dot product below `cosThreshold` — i.e., the bend is sharper
 * than the angle corresponding to that cosine. These indices become split
 * points for curve fitting so sharp corners don't get rounded off.
 */
function findSharpCorners(
  points: Array<[number, number]>,
  windowMm: number,
  cosThreshold: number,
): number[] {
  if (points.length < 5) return []
  const corners: number[] = []

  // Precompute cumulative arc length.
  const cum: number[] = new Array(points.length)
  cum[0] = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0]
    const dy = points[i][1] - points[i - 1][1]
    cum[i] = cum[i - 1] + Math.hypot(dx, dy)
  }

  // Sampling helper: walk outward from index `i` in direction `dir` (±1)
  // until we've covered `windowMm` of arc length, return that point.
  const samplePoint = (i: number, dir: 1 | -1): [number, number] | null => {
    const start = cum[i]
    const target = dir === 1 ? start + windowMm : start - windowMm
    if (dir === 1) {
      for (let j = i + 1; j < points.length; j++) {
        if (cum[j] >= target) return points[j]
      }
      return points[points.length - 1]
    }
    for (let j = i - 1; j >= 0; j--) {
      if (cum[j] <= target) return points[j]
    }
    return points[0]
  }

  for (let i = 2; i < points.length - 2; i++) {
    const back = samplePoint(i, -1)
    const fwd = samplePoint(i, 1)
    if (!back || !fwd) continue
    const p = points[i]
    const bx = p[0] - back[0]
    const by = p[1] - back[1]
    const fx = fwd[0] - p[0]
    const fy = fwd[1] - p[1]
    const bl = Math.hypot(bx, by)
    const fl = Math.hypot(fx, fy)
    if (bl < 1e-6 || fl < 1e-6) continue
    const dot = (bx * fx + by * fy) / (bl * fl)
    if (dot < cosThreshold) {
      // Only keep the sharpest corner within a small neighborhood to avoid
      // registering the same corner multiple times from adjacent vertices.
      if (corners.length > 0 && i - corners[corners.length - 1] < 4) {
        // Replace previous with sharper (lower dot) if this one is sharper.
        const prev = corners[corners.length - 1]
        const prevDot = cornerDotAt(points, prev, windowMm, cum, samplePoint)
        if (dot < prevDot) corners[corners.length - 1] = i
      } else {
        corners.push(i)
      }
    }
  }
  return corners
}

function cornerDotAt(
  points: Array<[number, number]>,
  i: number,
  _windowMm: number,
  _cum: number[],
  samplePoint: (i: number, dir: 1 | -1) => [number, number] | null,
): number {
  const back = samplePoint(i, -1)
  const fwd = samplePoint(i, 1)
  if (!back || !fwd) return 1
  const p = points[i]
  const bx = p[0] - back[0]
  const by = p[1] - back[1]
  const fx = fwd[0] - p[0]
  const fy = fwd[1] - p[1]
  const bl = Math.hypot(bx, by)
  const fl = Math.hypot(fx, fy)
  if (bl < 1e-6 || fl < 1e-6) return 1
  return (bx * fx + by * fy) / (bl * fl)
}

function rdpSimplify(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (points.length < 3) return points
  const sqTolerance = tolerance * tolerance
  const result: Array<[number, number]> = []

  const perpSq = (p: [number, number], a: [number, number], b: [number, number]): number => {
    let x = a[0]
    let y = a[1]
    let dx = b[0] - x
    let dy = b[1] - y
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
      if (t > 1) {
        x = b[0]
        y = b[1]
      } else if (t > 0) {
        x += dx * t
        y += dy * t
      }
    }
    dx = p[0] - x
    dy = p[1] - y
    return dx * dx + dy * dy
  }

  const stack: Array<[number, number]> = [[0, points.length - 1]]
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  while (stack.length > 0) {
    const [first, last] = stack.pop()!
    let maxSqDist = 0
    let index = first
    for (let i = first + 1; i < last; i++) {
      const sq = perpSq(points[i], points[first], points[last])
      if (sq > maxSqDist) {
        index = i
        maxSqDist = sq
      }
    }
    if (maxSqDist > sqTolerance) {
      keep[index] = 1
      stack.push([first, index])
      stack.push([index, last])
    }
  }

  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i])
  }
  return result
}

function getCachedCenterline(key: string): CenterlineResult | null {
  const cached = centerlineCache.get(key)
  if (!cached) return null

  centerlineCache.delete(key)
  centerlineCache.set(key, cached)
  return { ...cached }
}

function setCachedCenterline(key: string, result: CenterlineResult): void {
  centerlineCache.set(key, { ...result })
  while (centerlineCache.size > CENTERLINE_CACHE_LIMIT) {
    const oldest = centerlineCache.keys().next().value
    if (!oldest) break
    centerlineCache.delete(oldest)
  }
}

function matsToPathData(
  mats: Mat[],
  options: CenterlineProcessingOptions,
): CenterlineResult {
  const rawBranches: CenterlineBranch[] = []
  let rawBranchCount = 0

  for (const mat of mats) {
    const cpNode = mat.cpNode
    if (!cpNode) continue
    for (const branch of getBranches(cpNode)) {
      rawBranchCount += 1
      const cb = branchToCenterlineBranchRaw(branch)
      if (cb) rawBranches.push(cb)
    }
  }

  // Phase 1: try the stroke-skeleton graph pipeline
  try {
    const strokeResult = renderStrokeSkeleton(rawBranches, options)
    if (strokeResult) return strokeResult
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[centerline] stroke skeleton pipeline failed; falling back to legacy MAT output', err)
    }
  }

  // Fallback: legacy terminal-trim + post-process + render
  return legacyRenderBranches(rawBranches, options, rawBranchCount)
}

function branchToCenterlineBranchRaw(branch: CpNode[]): CenterlineBranch | null {
  const edges = branch
    .map((startNode): CenterlineEdge | null => {
      const bezier = CpNodeFs.getMatCurveToNext(startNode)
      if (!bezier || bezier.length < 2) return null
      const endNode = startNode.next
      return {
        bezier: cloneBezier(bezier),
        startNode,
        endNode,
        startRadius: startNode.cp.circle.radius,
        endRadius: endNode.cp.circle.radius,
      }
    })
    .filter((edge): edge is CenterlineEdge => Boolean(edge))

  if (edges.length === 0) return null

  const first = edges[0]
  const last = edges[edges.length - 1]
  const startLeaf = first?.startNode ? isLeafLike(first.startNode) : false
  const endLeaf = last?.endNode ? isLeafLike(last.endNode) : false

  return { edges, startLeaf, endLeaf }
}

function legacyRenderBranches(
  rawBranches: CenterlineBranch[],
  options: CenterlineProcessingOptions,
  rawBranchCount: number,
): CenterlineResult {
  const parts: string[] = []
  let segmentCount = 0
  let branchCount = 0

  const trimmed: CenterlineBranch[] = []
  for (const branch of rawBranches) {
    const trimmedEdges = trimTerminalEdges(
      branch.edges.map((e) => ({ ...e, bezier: cloneBezier(e.bezier) })),
      options.edgeTrimDistance,
      branch.startLeaf,
      branch.endLeaf,
    )
    if (trimmedEdges.length === 0) continue
    trimmed.push({ edges: trimmedEdges, startLeaf: branch.startLeaf, endLeaf: branch.endLeaf })
  }

  postProcessBranches(trimmed, options.edgeTrimDistance)

  for (const branch of trimmed) {
    if (branch.discarded) continue
    const branchPath = centerlineBranchToPathData(branch)
    if (!branchPath) continue
    parts.push(branchPath.pathData)
    segmentCount += branchPath.segmentCount
    branchCount += 1
  }

  if (parts.length === 0) {
    return {
      pathData: null,
      segmentCount: 0,
      branchCount: 0,
      error: rawBranchCount > 0
        ? 'Centerline trim removed all branches. Lower Trim or tool diameter.'
        : 'FloMat did not return any centerline segments for this shape.',
    }
  }

  return {
    pathData: parts.join(' '),
    segmentCount,
    branchCount,
    error: null,
  }
}

// ---------------------------------------------------------------------------
// Stroke-skeleton graph pipeline (Phase 1)
//
// Converts raw MAT branches into a junction graph, collapses short interior
// edges (X-knot dissolves into a single super-junction), pairs edges at every
// junction by tangent continuity (so the two diagonals of an X are recognised
// as continuations), walks stroke chains, and straightens the last ~2R of each
// branch at interior junctions (kills the inscribed-circle "gravity" that
// curves T-junctions inward on shapes like the letter e).
// ---------------------------------------------------------------------------

interface GraphNode {
  id: number
  point: number[]
  edgeSlots: Array<{ edgeId: number; side: BranchSide }>
}

interface GraphEdge {
  id: number
  branchIndex: number
  startNodeId: number
  endNodeId: number
  length: number
  discarded: boolean
}

interface StrokeSkeletonGraph {
  nodes: Map<number, GraphNode>
  edges: GraphEdge[]
  branches: CenterlineBranch[]
}

interface PairedSlot {
  edgeId: number
  side: BranchSide
}

type PairingMap = Map<string, PairedSlot>

interface StrokeStep {
  edgeId: number
  reversed: boolean
}

interface StrokeChain {
  steps: StrokeStep[]
  startLeaf: boolean
  endLeaf: boolean
}

const STRAIGHT_COS_30 = Math.cos((30 * Math.PI) / 180)

function renderStrokeSkeleton(
  rawBranches: CenterlineBranch[],
  options: CenterlineProcessingOptions,
  pipelineOptions: {
    straighten?: boolean
    collapseShort?: boolean
    clusterToleranceOverride?: number
    pairDotThreshold?: number
  } = {},
): CenterlineResult | null {
  const {
    straighten = true,
    collapseShort = true,
    clusterToleranceOverride,
    pairDotThreshold,
  } = pipelineOptions
  if (rawBranches.length === 0) return null

  const referenceRadius = estimateReferenceRadius(rawBranches)
  const toolDistance = Math.max(options.edgeTrimDistance, referenceRadius)
  const mergeRadius = Math.max(toolDistance * 1.5, 0.75)
  const tangentDistance = Math.max(toolDistance * 2, 0.5)

  // Deep-clone branches so we can mutate during straightening.
  const workBranches: CenterlineBranch[] = rawBranches.map((b) => ({
    startLeaf: b.startLeaf,
    endLeaf: b.endLeaf,
    edges: b.edges.map((e) => ({
      bezier: cloneBezier(e.bezier),
      startNode: e.startNode,
      endNode: e.endNode,
      startRadius: e.startRadius,
      endRadius: e.endRadius,
    })),
  }))

  const graph = buildJunctionGraph(workBranches, mergeRadius, clusterToleranceOverride)
  if (collapseShort) {
    collapseShortEdges(graph, mergeRadius)
  }
  const pairs = pairAllJunctions(graph, tangentDistance, pairDotThreshold)
  if (straighten) {
    straightenJunctions(graph, pairs, tangentDistance)
  }
  const strokes = walkStrokes(graph, pairs)

  if (strokes.length === 0) return null

  const parts: string[] = []
  let segmentCount = 0
  let branchCount = 0

  for (const stroke of strokes) {
    const beziers = collectStrokeBeziers(stroke, graph)
    if (beziers.length === 0) continue

    const trimmed = trimStrokeLeaves(
      beziers,
      options.edgeTrimDistance,
      stroke.startLeaf,
      stroke.endLeaf,
    )
    if (trimmed.length === 0) continue

    const pathData = beziersToContinuousPathData(trimmed)
    if (!pathData) continue

    parts.push(pathData)
    segmentCount += trimmed.length
    branchCount += 1
  }

  if (parts.length === 0) return null

  return {
    pathData: parts.join(' '),
    segmentCount,
    branchCount,
    error: null,
  }
}

function estimateReferenceRadius(branches: CenterlineBranch[]): number {
  let sum = 0
  let count = 0
  for (const b of branches) {
    for (const e of b.edges) {
      if (Number.isFinite(e.startRadius) && e.startRadius > 0) {
        sum += e.startRadius
        count += 1
      }
      if (Number.isFinite(e.endRadius) && e.endRadius > 0) {
        sum += e.endRadius
        count += 1
      }
    }
  }
  if (count === 0) return 1
  return sum / count
}

function buildJunctionGraph(
  branches: CenterlineBranch[],
  mergeRadius: number,
  toleranceOverride?: number,
): StrokeSkeletonGraph {
  const graph: StrokeSkeletonGraph = {
    nodes: new Map(),
    edges: [],
    branches,
  }
  const tolerance = toleranceOverride ?? Math.max(0.75, mergeRadius * 0.5)
  let nextNodeId = 0

  const findOrCreateNode = (point: number[]): number => {
    for (const node of graph.nodes.values()) {
      if (distance(node.point, point) <= tolerance) return node.id
    }
    const id = nextNodeId++
    graph.nodes.set(id, { id, point: [...point], edgeSlots: [] })
    return id
  }

  branches.forEach((branch, branchIndex) => {
    if (branch.edges.length === 0) return
    const startPoint = endpointPoint(branch, 'start')
    const endPoint = endpointPoint(branch, 'end')
    const startNodeId = findOrCreateNode(startPoint)
    const endNodeId = findOrCreateNode(endPoint)
    const edgeId = graph.edges.length
    const length = totalEdgeLength(branch.edges)
    graph.edges.push({
      id: edgeId,
      branchIndex,
      startNodeId,
      endNodeId,
      length,
      discarded: false,
    })
    graph.nodes.get(startNodeId)!.edgeSlots.push({ edgeId, side: 'start' })
    graph.nodes.get(endNodeId)!.edgeSlots.push({ edgeId, side: 'end' })
  })

  return graph
}

function activeDegree(node: GraphNode, graph: StrokeSkeletonGraph): number {
  let n = 0
  for (const slot of node.edgeSlots) {
    if (!graph.edges[slot.edgeId].discarded) n += 1
  }
  return n
}

function collapseShortEdges(graph: StrokeSkeletonGraph, mergeRadius: number): void {
  const maxCollapseLen = mergeRadius * 2
  let changed = true
  let iterations = 0
  const maxIterations = graph.edges.length * 4

  while (changed && iterations < maxIterations) {
    iterations += 1
    changed = false

    for (const edge of graph.edges) {
      if (edge.discarded) continue
      if (edge.length > maxCollapseLen) continue
      if (edge.startNodeId === edge.endNodeId) continue

      const startNode = graph.nodes.get(edge.startNodeId)
      const endNode = graph.nodes.get(edge.endNodeId)
      if (!startNode || !endNode) continue

      // Only collapse when BOTH sides are real junctions (degree ≥ 2).
      // This protects true leaf stubs and very short but real strokes.
      if (activeDegree(startNode, graph) < 2) continue
      if (activeDegree(endNode, graph) < 2) continue

      // Merge endNode into startNode.
      const mergedPoint = midpoint(startNode.point, endNode.point)
      startNode.point = mergedPoint

      for (const slot of endNode.edgeSlots) {
        if (slot.edgeId === edge.id) continue
        const other = graph.edges[slot.edgeId]
        if (!other || other.discarded) continue
        if (other.startNodeId === endNode.id) other.startNodeId = startNode.id
        if (other.endNodeId === endNode.id) other.endNodeId = startNode.id
        startNode.edgeSlots.push(slot)
      }

      startNode.edgeSlots = startNode.edgeSlots.filter((s) => s.edgeId !== edge.id)
      graph.nodes.delete(endNode.id)
      edge.discarded = true
      changed = true
      break
    }
  }
}

function outwardTangent(
  branch: CenterlineBranch,
  side: BranchSide,
  tangentDistance: number,
): number[] | null {
  if (branch.edges.length === 0) return null
  const endpoint = endpointPoint(branch, side)
  const interior = interiorPointFromEnd(branch.edges, side, tangentDistance)
  if (!interior) return null
  return normalize([interior[0] - endpoint[0], interior[1] - endpoint[1]])
}

function interiorPointFromEnd(
  edges: CenterlineEdge[],
  side: BranchSide,
  targetDistance: number,
): number[] | null {
  const totalLength = totalEdgeLength(edges)
  if (totalLength <= LENGTH_EPSILON) return null
  const clampedDistance = Math.min(targetDistance, totalLength * 0.8)
  const walkFromStart = side === 'start' ? clampedDistance : totalLength - clampedDistance
  return pointAtBranchDistance(edges, walkFromStart)
}

function pointAtBranchDistance(
  edges: CenterlineEdge[],
  distanceFromStart: number,
): number[] | null {
  if (edges.length === 0) return null
  let remaining = Math.max(0, distanceFromStart)
  for (const edge of edges) {
    const len = bezierApproxLength(edge.bezier)
    if (remaining <= len) {
      const t = len <= LENGTH_EPSILON ? 0 : tAtBezierLength(edge.bezier, remaining)
      return pointAtBezier(edge.bezier, t)
    }
    remaining -= len
  }
  const last = edges[edges.length - 1]
  return last ? pointAtBezier(last.bezier, 1) : null
}

function slotKey(edgeId: number, side: BranchSide): string {
  return `${edgeId}:${side}`
}

function pairAllJunctions(
  graph: StrokeSkeletonGraph,
  tangentDistance: number,
  pairDotThreshold: number = -STRAIGHT_COS_30,
): PairingMap {
  const pairs: PairingMap = new Map()

  for (const node of graph.nodes.values()) {
    const active = node.edgeSlots.filter((s) => !graph.edges[s.edgeId].discarded)
    if (active.length < 2) continue

    const candidates: Array<{ slot: { edgeId: number; side: BranchSide }; tangent: number[] }> = []
    for (const slot of active) {
      const branch = graph.branches[graph.edges[slot.edgeId].branchIndex]
      const t = outwardTangent(branch, slot.side, tangentDistance)
      if (t) candidates.push({ slot, tangent: t })
    }
    if (candidates.length < 2) continue

    if (candidates.length === 2) {
      // Degree-2 nodes: pair unconditionally (graph was already collapsed,
      // so any genuine junction here means a smooth continuation).
      const a = candidates[0].slot
      const b = candidates[1].slot
      pairs.set(slotKey(a.edgeId, a.side), { edgeId: b.edgeId, side: b.side })
      pairs.set(slotKey(b.edgeId, b.side), { edgeId: a.edgeId, side: a.side })
      continue
    }

    // d ≥ 3: greedy most-opposite-tangent matching, require dot < -cos(30°).
    const remaining = new Set<number>()
    for (let i = 0; i < candidates.length; i++) remaining.add(i)

    while (remaining.size >= 2) {
      let bestA = -1
      let bestB = -1
      let bestScore = Infinity
      for (const i of remaining) {
        for (const j of remaining) {
          if (i >= j) continue
          const d = dot(candidates[i].tangent, candidates[j].tangent)
          if (d < bestScore) {
            bestScore = d
            bestA = i
            bestB = j
          }
        }
      }
      if (bestA < 0 || bestB < 0) break
      if (bestScore > pairDotThreshold) break

      const a = candidates[bestA].slot
      const b = candidates[bestB].slot
      pairs.set(slotKey(a.edgeId, a.side), { edgeId: b.edgeId, side: b.side })
      pairs.set(slotKey(b.edgeId, b.side), { edgeId: a.edgeId, side: a.side })
      remaining.delete(bestA)
      remaining.delete(bestB)
    }
  }

  return pairs
}

function computeJunctionSnap(
  node: GraphNode,
  graph: StrokeSkeletonGraph,
  pairs: PairingMap,
  tangentDistance: number,
): number[] {
  const active = node.edgeSlots.filter((s) => !graph.edges[s.edgeId].discarded)
  if (active.length < 2) return [...node.point]

  // Gather interior-sample points for each active slot.
  const samples: Array<{ slot: { edgeId: number; side: BranchSide }; interior: number[]; paired: boolean }> = []
  for (const slot of active) {
    const branch = graph.branches[graph.edges[slot.edgeId].branchIndex]
    const interior = interiorPointFromEnd(branch.edges, slot.side, tangentDistance)
    if (!interior) continue
    samples.push({
      slot,
      interior,
      paired: pairs.has(slotKey(slot.edgeId, slot.side)),
    })
  }
  if (samples.length < 2) return [...node.point]

  // Build the set of unique paired lines (a, b).
  const seen = new Set<number>()
  const pairLines: Array<{ a: number[]; b: number[] }> = []
  for (const s of samples) {
    if (!s.paired) continue
    const partner = pairs.get(slotKey(s.slot.edgeId, s.slot.side))
    if (!partner) continue
    const comboId =
      Math.min(s.slot.edgeId, partner.edgeId) * 1_000_000 +
      Math.max(s.slot.edgeId, partner.edgeId)
    if (seen.has(comboId)) continue
    seen.add(comboId)
    const partnerBranch = graph.branches[graph.edges[partner.edgeId].branchIndex]
    const partnerInterior = interiorPointFromEnd(partnerBranch.edges, partner.side, tangentDistance)
    if (!partnerInterior) continue
    pairLines.push({ a: s.interior, b: partnerInterior })
  }

  if (pairLines.length === 0) {
    // No continuations: just average the interior sample points (pulls the
    // snap toward a sensible "center of strokes" rather than keeping the
    // MAT-curved node point).
    const avg = [0, 0]
    for (const s of samples) {
      avg[0] += s.interior[0]
      avg[1] += s.interior[1]
    }
    return [avg[0] / samples.length, avg[1] / samples.length]
  }

  if (pairLines.length === 1) {
    const line = pairLines[0]
    const base = midpoint(line.a, line.b)
    // If there are stems, project them onto the line and pick the one closest
    // to the collapsed node position — this turns T-junctions perpendicular.
    const stems = samples.filter((s) => !s.paired)
    if (stems.length === 0) return base
    let best = base
    let bestDist = distance(best, node.point)
    for (const stem of stems) {
      const proj = projectPointOntoLine(stem.interior, line.a, line.b)
      const d = distance(proj, node.point)
      if (d < bestDist) {
        best = proj
        bestDist = d
      }
    }
    return best
  }

  // Multiple continuations (X-crossing etc): intersect the first two lines.
  const intersection = lineIntersection(
    pairLines[0].a,
    pairLines[0].b,
    pairLines[1].a,
    pairLines[1].b,
  )
  if (intersection) return intersection

  // Fallback: centroid of pair-line midpoints.
  const avg = [0, 0]
  for (const line of pairLines) {
    const m = midpoint(line.a, line.b)
    avg[0] += m[0]
    avg[1] += m[1]
  }
  return [avg[0] / pairLines.length, avg[1] / pairLines.length]
}

function projectPointOntoLine(p: number[], a: number[], b: number[]): number[] {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lenSq = dx * dx + dy * dy
  if (lenSq <= LENGTH_EPSILON) return [...a]
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq
  return [a[0] + dx * t, a[1] + dy * t]
}

function lineIntersection(
  a1: number[],
  a2: number[],
  b1: number[],
  b2: number[],
): number[] | null {
  const d1x = a2[0] - a1[0]
  const d1y = a2[1] - a1[1]
  const d2x = b2[0] - b1[0]
  const d2y = b2[1] - b1[1]
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) <= LENGTH_EPSILON) return null
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denom
  return [a1[0] + d1x * t, a1[1] + d1y * t]
}

function straightenJunctions(
  graph: StrokeSkeletonGraph,
  pairs: PairingMap,
  tangentDistance: number,
): void {
  for (const node of graph.nodes.values()) {
    const active = node.edgeSlots.filter((s) => !graph.edges[s.edgeId].discarded)
    if (active.length < 2) continue

    const snap = computeJunctionSnap(node, graph, pairs, tangentDistance)
    node.point = snap

    for (const slot of active) {
      const branch = graph.branches[graph.edges[slot.edgeId].branchIndex]
      straightenBranchEnd(branch, slot.side, snap, tangentDistance)
    }
  }
}

function straightenBranchEnd(
  branch: CenterlineBranch,
  side: BranchSide,
  snapPoint: number[],
  straightenDistance: number,
): void {
  if (branch.edges.length === 0) return
  const total = totalEdgeLength(branch.edges)
  if (total <= LENGTH_EPSILON) {
    moveEndpoint(branch, side, snapPoint)
    return
  }
  const trimDist = Math.min(straightenDistance, total * 0.8)

  if (side === 'end') {
    const trimmed = trimEdgesByLengthFromEnd(branch.edges, trimDist)
    if (trimmed.length === 0) {
      const start = branch.edges[0].bezier[0]
      branch.edges = [makeLineEdge(start, snapPoint)]
      return
    }
    const lastEdge = trimmed[trimmed.length - 1]
    const interior = lastEdge.bezier[lastEdge.bezier.length - 1]
    trimmed.push(makeLineEdge(interior, snapPoint))
    branch.edges = trimmed
  } else {
    const trimmed = trimEdgesByLengthFromStart(branch.edges, trimDist)
    if (trimmed.length === 0) {
      const lastBezier = branch.edges[branch.edges.length - 1].bezier
      const end = lastBezier[lastBezier.length - 1]
      branch.edges = [makeLineEdge(snapPoint, end)]
      return
    }
    const firstEdge = trimmed[0]
    const interior = firstEdge.bezier[0]
    trimmed.unshift(makeLineEdge(snapPoint, interior))
    branch.edges = trimmed
  }
}

function makeLineEdge(from: number[], to: number[]): CenterlineEdge {
  return {
    bezier: [[from[0], from[1]], [to[0], to[1]]],
    startNode: null,
    endNode: null,
    startRadius: 0,
    endRadius: 0,
  }
}

function walkStrokes(graph: StrokeSkeletonGraph, pairs: PairingMap): StrokeChain[] {
  const strokes: StrokeChain[] = []
  const visited = new Set<number>()

  for (const seed of graph.edges) {
    if (seed.discarded || visited.has(seed.id)) continue

    const forward: StrokeStep[] = [{ edgeId: seed.id, reversed: false }]
    visited.add(seed.id)

    // Walk forward from seed's 'end' side.
    let currentEdgeId = seed.id
    let currentExitSide: BranchSide = 'end'
    while (true) {
      const partner = pairs.get(slotKey(currentEdgeId, currentExitSide))
      if (!partner || visited.has(partner.edgeId)) break
      visited.add(partner.edgeId)
      const reversed = partner.side === 'end'
      forward.push({ edgeId: partner.edgeId, reversed })
      currentEdgeId = partner.edgeId
      currentExitSide = partner.side === 'start' ? 'end' : 'start'
    }

    // Walk backward from seed's 'start' side.
    const backward: StrokeStep[] = []
    currentEdgeId = seed.id
    currentExitSide = 'start'
    while (true) {
      const partner = pairs.get(slotKey(currentEdgeId, currentExitSide))
      if (!partner || visited.has(partner.edgeId)) break
      visited.add(partner.edgeId)
      const reversed = partner.side === 'start'
      backward.unshift({ edgeId: partner.edgeId, reversed })
      currentEdgeId = partner.edgeId
      currentExitSide = partner.side === 'start' ? 'end' : 'start'
    }

    const steps = [...backward, ...forward]
    if (steps.length === 0) continue

    const firstStep = steps[0]
    const lastStep = steps[steps.length - 1]
    const firstBranch = graph.branches[graph.edges[firstStep.edgeId].branchIndex]
    const lastBranch = graph.branches[graph.edges[lastStep.edgeId].branchIndex]
    const startLeaf = firstStep.reversed ? firstBranch.endLeaf : firstBranch.startLeaf
    const endLeaf = lastStep.reversed ? lastBranch.startLeaf : lastBranch.endLeaf

    strokes.push({ steps, startLeaf, endLeaf })
  }

  return strokes
}

function collectStrokeBeziers(stroke: StrokeChain, graph: StrokeSkeletonGraph): Bezier[] {
  const beziers: Bezier[] = []
  for (const step of stroke.steps) {
    const edge = graph.edges[step.edgeId]
    const branch = graph.branches[edge.branchIndex]
    if (step.reversed) {
      for (let i = branch.edges.length - 1; i >= 0; i--) {
        beziers.push(reverseBezier(branch.edges[i].bezier))
      }
    } else {
      for (const e of branch.edges) {
        beziers.push(cloneBezier(e.bezier))
      }
    }
  }
  return beziers
}

function reverseBezier(bezier: Bezier): Bezier {
  const out: Bezier = []
  for (let i = bezier.length - 1; i >= 0; i--) out.push([...bezier[i]])
  return out
}

function trimStrokeLeaves(
  beziers: Bezier[],
  distance: number,
  startLeaf: boolean,
  endLeaf: boolean,
): Bezier[] {
  if (distance <= 0 || (!startLeaf && !endLeaf)) return beziers
  const totalLen = beziers.reduce((s, b) => s + bezierApproxLength(b), 0)
  if (totalLen <= LENGTH_EPSILON) return beziers

  const minKeepRatio = startLeaf && endLeaf ? 0.4 : 0.35
  const maxTrim = totalLen * (1 - minKeepRatio)
  let startTrim = startLeaf ? distance : 0
  let endTrim = endLeaf ? distance : 0
  if (startTrim + endTrim > maxTrim) {
    const scale = maxTrim / (startTrim + endTrim)
    startTrim *= scale
    endTrim *= scale
  }

  let result = trimBeziersFromStart(beziers, startTrim)
  result = trimBeziersFromEnd(result, endTrim)
  return result
}

function trimBeziersFromStart(beziers: Bezier[], distance: number): Bezier[] {
  if (distance <= LENGTH_EPSILON) return beziers
  const result = beziers.map(cloneBezier)
  let remaining = distance
  while (result.length > 0 && remaining > LENGTH_EPSILON) {
    const b = result[0]
    const len = bezierApproxLength(b)
    if (len <= LENGTH_EPSILON || len <= remaining + LENGTH_EPSILON) {
      remaining -= Math.max(0, len)
      result.shift()
      continue
    }
    const t = tAtBezierLength(b, remaining)
    const [, right] = splitBezier(b, t)
    result[0] = right
    break
  }
  return result
}

function trimBeziersFromEnd(beziers: Bezier[], distance: number): Bezier[] {
  if (distance <= LENGTH_EPSILON) return beziers
  const result = beziers.map(cloneBezier)
  let remaining = distance
  while (result.length > 0 && remaining > LENGTH_EPSILON) {
    const lastIndex = result.length - 1
    const b = result[lastIndex]
    const len = bezierApproxLength(b)
    if (len <= LENGTH_EPSILON || len <= remaining + LENGTH_EPSILON) {
      remaining -= Math.max(0, len)
      result.pop()
      continue
    }
    const t = tAtBezierLength(b, len - remaining)
    const [left] = splitBezier(b, t)
    result[lastIndex] = left
    break
  }
  return result
}

function centerlineBranchToPathData(branch: CenterlineBranch): BranchPath | null {
  if (branch.syntheticPathData) {
    return {
      pathData: branch.syntheticPathData,
      segmentCount: branch.syntheticSegmentCount ?? 1,
    }
  }

  const pathData = beziersToContinuousPathData(branch.edges.map((edge) => edge.bezier))
  if (!pathData) return null

  return {
    pathData,
    segmentCount: branch.edges.length,
  }
}

function postProcessBranches(
  branches: CenterlineBranch[],
  edgeTrimDistance: number,
): void {
  collapseShortJunctionConnectors(branches, edgeTrimDistance)
  untangleHourglassBranches(branches, edgeTrimDistance)
}

function trimTerminalEdges(
  edges: CenterlineEdge[],
  edgeTrimDistance: number,
  trimStart: boolean,
  trimEnd: boolean,
): CenterlineEdge[] {
  if (edgeTrimDistance <= 0 || edges.length === 0) return edges

  if (!trimStart && !trimEnd) return edges

  const branchLength = totalEdgeLength(edges)
  if (branchLength <= LENGTH_EPSILON) return edges

  let startTrim = trimStart
    ? Math.max(edgeTrimDistance, distanceToRadiusFromStart(edges, edgeTrimDistance))
    : 0
  let endTrim = trimEnd
    ? Math.max(edgeTrimDistance, distanceToRadiusFromEnd(edges, edgeTrimDistance))
    : 0

  const minKeepRatio = trimStart && trimEnd ? 0.4 : 0.35
  const maxTrim = branchLength * (1 - minKeepRatio)
  const requestedTrim = startTrim + endTrim
  if (requestedTrim > maxTrim) {
    const trimScale = maxTrim / requestedTrim
    startTrim *= trimScale
    endTrim *= trimScale
  }

  return trimEdgesFromEnd(trimEdgesFromStart(edges, startTrim), endTrim)
}

function collapseShortJunctionConnectors(
  branches: CenterlineBranch[],
  edgeTrimDistance: number,
): void {
  if (edgeTrimDistance <= 0) return

  const maxConnectorLength = edgeTrimDistance * 2
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]
    if (
      branch.discarded ||
      branch.syntheticPathData ||
      branch.startLeaf ||
      branch.endLeaf ||
      branch.edges.length === 0
    ) {
      continue
    }

    const branchLength = totalEdgeLength(branch.edges)
    if (branchLength <= LENGTH_EPSILON || branchLength > maxConnectorLength) continue

    const startIncident = findIncidentEndpoints(branches, endpointPoint(branch, 'start'), i)
    const endIncident = findIncidentEndpoints(branches, endpointPoint(branch, 'end'), i)
    const incident = [...startIncident, ...endIncident]
    if (startIncident.length !== 2 || endIncident.length !== 2) continue
    if (!hasTwoOppositePairs(incident, branches)) continue

    const center = midpoint(endpointPoint(branch, 'start'), endpointPoint(branch, 'end'))
    branch.discarded = true
    incident.forEach((endpoint) => moveEndpoint(branches[endpoint.branchIndex], endpoint.side, center))
  }
}

function untangleHourglassBranches(
  branches: CenterlineBranch[],
  edgeTrimDistance: number,
): void {
  if (edgeTrimDistance <= 0) return

  const maxCenterGap = Math.max(edgeTrimDistance * 1.5, 8)
  for (let a = 0; a < branches.length; a++) {
    const branchA = branches[a]
    if (!isLeafToLeafBranch(branchA)) continue

    for (let b = a + 1; b < branches.length; b++) {
      const branchB = branches[b]
      if (!isLeafToLeafBranch(branchB)) continue

      const closest = closestInteriorBranchPoints(branchA, branchB)
      if (!closest || closest.distance > maxCenterGap) continue

      const center = midpoint(closest.a, closest.b)
      const endpoints = [
        endpointPoint(branchA, 'start'),
        endpointPoint(branchA, 'end'),
        endpointPoint(branchB, 'start'),
        endpointPoint(branchB, 'end'),
      ]
      const pairing = bestOppositePairing(endpoints, center)
      if (!pairing || pairing.original || pairing.score > -1.2) continue

      branchA.discarded = true
      branchB.discarded = true
      branches.push(
        syntheticBranch(endpoints[pairing.pairs[0][0]], center, endpoints[pairing.pairs[0][1]]),
        syntheticBranch(endpoints[pairing.pairs[1][0]], center, endpoints[pairing.pairs[1][1]]),
      )
      break
    }
  }
}

function trimEdgesFromStart(
  edges: CenterlineEdge[],
  trimDistance: number,
): CenterlineEdge[] {
  return trimEdgesByLengthFromStart(edges, trimDistance)
}

function trimEdgesFromEnd(
  edges: CenterlineEdge[],
  trimDistance: number,
): CenterlineEdge[] {
  return trimEdgesByLengthFromEnd(edges, trimDistance)
}

function trimEdgesByLengthFromStart(
  edges: CenterlineEdge[],
  trimDistance: number,
): CenterlineEdge[] {
  const trimmed = [...edges]
  let remaining = trimDistance

  while (trimmed.length > 0 && remaining > LENGTH_EPSILON) {
    const edge = trimmed[0]
    const length = bezierApproxLength(edge.bezier)

    if (length <= LENGTH_EPSILON || length <= remaining + LENGTH_EPSILON) {
      remaining -= Math.max(0, length)
      trimmed.shift()
      continue
    }

    const t = tAtBezierLength(edge.bezier, remaining)
    const [, right] = splitBezier(edge.bezier, t)
    trimmed[0] = {
      ...edge,
      bezier: right,
      startRadius: lerp(edge.startRadius, edge.endRadius, t),
    }
    break
  }

  return trimmed
}

function trimEdgesByLengthFromEnd(
  edges: CenterlineEdge[],
  trimDistance: number,
): CenterlineEdge[] {
  const trimmed = [...edges]
  let remaining = trimDistance

  while (trimmed.length > 0 && remaining > LENGTH_EPSILON) {
    const lastIndex = trimmed.length - 1
    const edge = trimmed[lastIndex]
    const length = bezierApproxLength(edge.bezier)

    if (length <= LENGTH_EPSILON || length <= remaining + LENGTH_EPSILON) {
      remaining -= Math.max(0, length)
      trimmed.pop()
      continue
    }

    const t = tAtBezierLength(edge.bezier, length - remaining)
    const [left] = splitBezier(edge.bezier, t)
    trimmed[lastIndex] = {
      ...edge,
      bezier: left,
      endRadius: lerp(edge.startRadius, edge.endRadius, t),
    }
    break
  }

  return trimmed
}

function distanceToRadiusFromStart(
  edges: CenterlineEdge[],
  radiusThreshold: number,
): number {
  let distance = 0

  for (const edge of edges) {
    const length = bezierApproxLength(edge.bezier)
    if (edge.startRadius >= radiusThreshold) return distance

    if (edge.endRadius >= radiusThreshold && edge.endRadius !== edge.startRadius) {
      const t = clamp(
        (radiusThreshold - edge.startRadius) / (edge.endRadius - edge.startRadius),
        0,
        1,
      )
      return distance + bezierApproxLength(edge.bezier, 0, t)
    }

    distance += length
  }

  return distance
}

function distanceToRadiusFromEnd(
  edges: CenterlineEdge[],
  radiusThreshold: number,
): number {
  let distance = 0

  for (let i = edges.length - 1; i >= 0; i--) {
    const edge = edges[i]
    const length = bezierApproxLength(edge.bezier)
    if (edge.endRadius >= radiusThreshold) return distance

    if (edge.startRadius >= radiusThreshold && edge.startRadius !== edge.endRadius) {
      const t = clamp(
        (radiusThreshold - edge.startRadius) / (edge.endRadius - edge.startRadius),
        0,
        1,
      )
      return distance + bezierApproxLength(edge.bezier, t, 1)
    }

    distance += length
  }

  return distance
}

function isLeafToLeafBranch(branch: CenterlineBranch): boolean {
  return (
    !branch.discarded &&
    !branch.syntheticPathData &&
    branch.startLeaf &&
    branch.endLeaf &&
    branch.edges.length > 0
  )
}

function findIncidentEndpoints(
  branches: CenterlineBranch[],
  point: number[],
  excludedBranchIndex: number,
): BranchEndpoint[] {
  const endpoints: BranchEndpoint[] = []

  branches.forEach((branch, branchIndex) => {
    if (
      branchIndex === excludedBranchIndex ||
      branch.discarded ||
      branch.syntheticPathData ||
      branch.edges.length === 0
    ) {
      return
    }

    if (distance(endpointPoint(branch, 'start'), point) <= 0.75) {
      endpoints.push({ branchIndex, side: 'start' })
    }
    if (distance(endpointPoint(branch, 'end'), point) <= 0.75) {
      endpoints.push({ branchIndex, side: 'end' })
    }
  })

  return endpoints
}

function hasTwoOppositePairs(
  endpoints: BranchEndpoint[],
  branches: CenterlineBranch[],
): boolean {
  if (endpoints.length !== 4) return false

  const directions = endpoints.map((endpoint) => endpointDirection(branches[endpoint.branchIndex], endpoint.side))
  if (directions.some((direction) => !direction)) return false

  const dirs = directions as number[][]
  return (
    (dot(dirs[0], dirs[1]) < -0.55 && dot(dirs[2], dirs[3]) < -0.55) ||
    (dot(dirs[0], dirs[2]) < -0.55 && dot(dirs[1], dirs[3]) < -0.55) ||
    (dot(dirs[0], dirs[3]) < -0.55 && dot(dirs[1], dirs[2]) < -0.55)
  )
}

function closestInteriorBranchPoints(
  branchA: CenterlineBranch,
  branchB: CenterlineBranch,
): { a: number[]; b: number[]; distance: number } | null {
  const pointsA = sampledBranchPoints(branchA)
  const pointsB = sampledBranchPoints(branchB)
  if (pointsA.length < 3 || pointsB.length < 3) return null

  let closest: { a: number[]; b: number[]; distance: number } | null = null
  for (let i = 1; i < pointsA.length - 1; i++) {
    for (let j = 1; j < pointsB.length - 1; j++) {
      const d = distance(pointsA[i], pointsB[j])
      if (!closest || d < closest.distance) {
        closest = { a: pointsA[i], b: pointsB[j], distance: d }
      }
    }
  }

  return closest
}

function sampledBranchPoints(branch: CenterlineBranch): number[][] {
  const points: number[][] = []
  for (const edge of branch.edges) {
    const steps = Math.max(4, edge.bezier.length * 4)
    for (let i = 0; i <= steps; i++) {
      if (points.length > 0 && i === 0) continue
      points.push(pointAtBezier(edge.bezier, i / steps))
    }
  }
  return points
}

function bestOppositePairing(
  endpoints: number[][],
  center: number[],
): { pairs: [[number, number], [number, number]]; score: number; original: boolean } | null {
  if (endpoints.length !== 4) return null

  const directions = endpoints.map((endpoint) => normalize([
    endpoint[0] - center[0],
    endpoint[1] - center[1],
  ]))
  if (directions.some((direction) => !direction)) return null

  const dirs = directions as number[][]
  const pairings: Array<{ pairs: [[number, number], [number, number]]; original: boolean }> = [
    { pairs: [[0, 1], [2, 3]], original: true },
    { pairs: [[0, 2], [1, 3]], original: false },
    { pairs: [[0, 3], [1, 2]], original: false },
  ]

  let best: { pairs: [[number, number], [number, number]]; score: number; original: boolean } | null = null
  for (const pairing of pairings) {
    const score = dot(dirs[pairing.pairs[0][0]], dirs[pairing.pairs[0][1]]) +
      dot(dirs[pairing.pairs[1][0]], dirs[pairing.pairs[1][1]])
    if (!best || score < best.score) {
      best = { ...pairing, score }
    }
  }

  return best
}

function syntheticBranch(start: number[], center: number[], end: number[]): CenterlineBranch {
  return {
    edges: [],
    startLeaf: true,
    endLeaf: true,
    syntheticPathData: `M ${fmt(start[0])} ${fmt(start[1])} L ${fmt(center[0])} ${fmt(center[1])} L ${fmt(end[0])} ${fmt(end[1])}`,
    syntheticSegmentCount: 2,
  }
}

function endpointPoint(branch: CenterlineBranch, side: BranchSide): number[] {
  if (side === 'start') {
    return branch.edges[0]?.bezier[0] ?? [0, 0]
  }

  const lastBezier = branch.edges[branch.edges.length - 1]?.bezier
  return lastBezier?.[lastBezier.length - 1] ?? [0, 0]
}

function moveEndpoint(branch: CenterlineBranch, side: BranchSide, point: number[]): void {
  if (branch.edges.length === 0) return

  if (side === 'start') {
    branch.edges[0].bezier[0] = [...point]
    return
  }

  const lastBezier = branch.edges[branch.edges.length - 1].bezier
  lastBezier[lastBezier.length - 1] = [...point]
}

function endpointDirection(branch: CenterlineBranch, side: BranchSide): number[] | null {
  if (branch.edges.length === 0) return null

  if (side === 'start') {
    const bezier = branch.edges[0].bezier
    return normalize(subtract(pointAtBezier(bezier, 0.12), bezier[0]))
  }

  const bezier = branch.edges[branch.edges.length - 1].bezier
  return normalize(subtract(pointAtBezier(bezier, 0.88), bezier[bezier.length - 1]))
}

function isLeafLike(cpNode: CpNode): boolean {
  return (
    CpNodeFs.isTerminating(cpNode) ||
    CpNodeFs.isFullyTerminating(cpNode) ||
    CpNodeFs.getRealProngCount(cpNode) <= 1
  )
}

function beziersToContinuousPathData(beziers: Bezier[]): string {
  const first = beziers[0]?.[0]
  if (!first) return ''

  const parts = [`M ${fmt(first[0])} ${fmt(first[1])}`]

  for (const bezier of beziers) {
    const command = bezierCommand(bezier)
    if (command) parts.push(command)
  }

  return parts.join(' ')
}

function bezierCommand(bezier: Bezier): string {
  const [, control1, control2, end] = bezier
  if (!control1) return ''

  if (bezier.length === 2) {
    return `L ${fmt(control1[0])} ${fmt(control1[1])}`
  }

  if (bezier.length === 3 && control2) {
    return `Q ${fmt(control1[0])} ${fmt(control1[1])} ${fmt(control2[0])} ${fmt(control2[1])}`
  }

  if (bezier.length === 4 && control2 && end) {
    return `C ${fmt(control1[0])} ${fmt(control1[1])} ${fmt(control2[0])} ${fmt(control2[1])} ${fmt(end[0])} ${fmt(end[1])}`
  }

  return ''
}

function cloneBezier(bezier: Bezier): Bezier {
  return bezier.map((point) => [...point])
}

function splitBezier(bezier: Bezier, t: number): [Bezier, Bezier] {
  if (bezier.length === 2) {
    const p01 = lerpPoint(bezier[0], bezier[1], t)
    return [
      [bezier[0], p01],
      [p01, bezier[1]],
    ]
  }

  if (bezier.length === 3) {
    const p01 = lerpPoint(bezier[0], bezier[1], t)
    const p12 = lerpPoint(bezier[1], bezier[2], t)
    const p0112 = lerpPoint(p01, p12, t)
    return [
      [bezier[0], p01, p0112],
      [p0112, p12, bezier[2]],
    ]
  }

  if (bezier.length === 4) {
    const p01 = lerpPoint(bezier[0], bezier[1], t)
    const p12 = lerpPoint(bezier[1], bezier[2], t)
    const p23 = lerpPoint(bezier[2], bezier[3], t)
    const p0112 = lerpPoint(p01, p12, t)
    const p1223 = lerpPoint(p12, p23, t)
    const p = lerpPoint(p0112, p1223, t)
    return [
      [bezier[0], p01, p0112, p],
      [p, p1223, p23, bezier[3]],
    ]
  }

  return [cloneBezier(bezier), cloneBezier(bezier)]
}

function lerpPoint(a: number[], b: number[], t: number): number[] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function midpoint(a: number[], b: number[]): number[] {
  return [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
  ]
}

function subtract(a: number[], b: number[]): number[] {
  return [
    a[0] - b[0],
    a[1] - b[1],
  ]
}

function normalize(vector: number[]): number[] | null {
  const length = Math.hypot(vector[0], vector[1])
  if (length <= LENGTH_EPSILON) return null
  return [vector[0] / length, vector[1] / length]
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1]
}

function totalEdgeLength(edges: CenterlineEdge[]): number {
  return edges.reduce((sum, edge) => sum + bezierApproxLength(edge.bezier), 0)
}

function tAtBezierLength(bezier: Bezier, targetLength: number): number {
  const totalLength = bezierApproxLength(bezier)
  if (targetLength <= 0) return 0
  if (targetLength >= totalLength) return 1

  let low = 0
  let high = 1
  for (let i = 0; i < 14; i++) {
    const mid = (low + high) / 2
    if (bezierApproxLength(bezier, 0, mid) < targetLength) {
      low = mid
    } else {
      high = mid
    }
  }
  return (low + high) / 2
}

function bezierApproxLength(bezier: Bezier, t0 = 0, t1 = 1): number {
  const steps = Math.max(4, Math.ceil(bezier.length * 4))
  let previous = pointAtBezier(bezier, t0)
  let length = 0

  for (let i = 1; i <= steps; i++) {
    const t = t0 + (t1 - t0) * (i / steps)
    const point = pointAtBezier(bezier, t)
    length += distance(previous, point)
    previous = point
  }

  return length
}

function pointAtBezier(bezier: Bezier, t: number): number[] {
  let points = cloneBezier(bezier)
  while (points.length > 1) {
    points = points.slice(1).map((point, index) => lerpPoint(points[index], point, t))
  }
  return points[0] ?? [0, 0]
}

function distance(a: number[], b: number[]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return Math.hypot(dx, dy)
}

function fmt(value: number | undefined): string {
  if (!Number.isFinite(value)) return '0'
  return Number(value!.toFixed(3)).toString()
}

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0]
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function translateMatrix(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y]
}

function scaleMatrix(x: number, y: number): Matrix {
  return [x, 0, 0, y, 0, 0]
}

function rotateMatrix(angleInDegrees: number): Matrix {
  const angleInRadians = (angleInDegrees * Math.PI) / 180
  const cos = Math.cos(angleInRadians)
  const sin = Math.sin(angleInRadians)
  return [cos, sin, -sin, cos, 0, 0]
}

function matrixForNode(node: CanvasNode): Matrix {
  return multiplyMatrices(
    multiplyMatrices(
      translateMatrix(node.x, node.y),
      rotateMatrix(node.rotation),
    ),
    scaleMatrix(node.scaleX, node.scaleY),
  )
}
