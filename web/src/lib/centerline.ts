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
}

interface CenterlineEdge {
  bezier: Bezier
  startNode: CpNode
  endNode: CpNode
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

    const mats = findMats(bezierLoops, matOptionsForMetadata(metadata))
    const sats = mats.map((mat) => {
      const sat = toScaleAxis(mat, metadata.scaleAxis)
      if (metadata.simplifyTolerance <= 0 || !sat.cpNode) return sat
      return simplifyMat(sat, metadata.simplifyTolerance)
    })
    const result = matsToPathData(sats, { edgeTrimDistance })
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

  if (node.fillRule === 'evenodd') {
    return { pathData: null, error: 'Centerlines currently support only nonzero fill-rule paths.' }
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
  })
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
  const parts: string[] = []
  let segmentCount = 0
  let branchCount = 0
  let rawBranchCount = 0

  for (const mat of mats) {
    const cpNode = mat.cpNode
    if (!cpNode) continue

    const branches: CenterlineBranch[] = []
    for (const branch of getBranches(cpNode)) {
      rawBranchCount += 1
      const centerlineBranch = branchToCenterlineBranch(branch, options)
      if (centerlineBranch) branches.push(centerlineBranch)
    }

    postProcessBranches(branches, options.edgeTrimDistance)

    for (const branch of branches) {
      if (branch.discarded) continue
      const branchPath = centerlineBranchToPathData(branch)
      if (!branchPath) continue
      parts.push(branchPath.pathData)
      segmentCount += branchPath.segmentCount
      branchCount += 1
    }
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

function branchToCenterlineBranch(
  branch: CpNode[],
  options: CenterlineProcessingOptions,
): CenterlineBranch | null {
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
  const startLeaf = first ? isLeafLike(first.startNode) : false
  const endLeaf = last ? isLeafLike(last.endNode) : false
  const trimmed = trimTerminalEdges(edges, options.edgeTrimDistance, startLeaf, endLeaf)
  if (trimmed.length === 0) return null

  return {
    edges: trimmed,
    startLeaf,
    endLeaf,
  }
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
