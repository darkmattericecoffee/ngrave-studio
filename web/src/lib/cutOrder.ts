import type { ArtboardState, CanvasNode, GroupNode } from '../types/editor'
import { boundsCentroid, getNodePreviewBounds, type Bounds } from './nodeBounds'

export type CutOrderStrategy = 'auto' | 'manual'

export interface CutOrderLeaf {
  nodeId: string
  /** Blob id this leaf belongs to (auto mode) or a single root id (manual mode).
   *  Leaves sharing a `groupId` cluster into the same job downstream. */
  groupId: string
  /** Display name of the owning blob. */
  groupName: string
  /** 0-based global order across all leaves. */
  index: number
}

export interface CutOrderResult {
  sequence: CutOrderLeaf[]
  /** Ordered list of distinct groupIds in the order they first appear in `sequence`. */
  groupOrder: string[]
  /** Map from groupId → human-readable group name. */
  groupNames: Record<string, string>
  /** Leaves flagged as "big encompassing" during auto planning. */
  spannerNodeIds: string[]
}

const ROOT_GROUP_ID = '__root__'
const ROOT_GROUP_NAME = 'Root'

// ---------- Tuning constants for the auto planner ----------

/** Bounds area ≥ this fraction of the union-bounds area → leaf is a spanner. */
const SPANNER_AREA_RATIO = 0.35
/** Leaf whose bounds contain this many other leaves' centroids → spanner. */
const SPANNER_CONTAIN_COUNT = 3
/** Extra padding (mm) applied when testing bounds overlap — catches shapes that just touch. */
const BLOB_BOUNDS_SLOP_MM = 2
/** Adaptive centroid radius = fraction × sqrt(area_a × area_b). */
const BLOB_RADIUS_FRACTION = 0.6
/** Absolute floor for the adaptive radius (mm). */
const BLOB_MIN_RADIUS_MM = 8

function isGroup(node: CanvasNode | undefined): node is GroupNode {
  return !!node && node.type === 'group'
}

interface LeafInfo {
  nodeId: string
  bounds: Bounds | null
  centroid: { x: number; y: number } | null
  svgIndex: number
}

function collectLeavesInSvgOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
): LeafInfo[] {
  const out: LeafInfo[] = []

  function walk(ids: string[]) {
    for (const id of ids) {
      const node = nodesById[id]
      if (!node || !node.visible) continue
      if (isGroup(node)) {
        walk(node.childIds)
      } else {
        out.push({ nodeId: id, bounds: null, centroid: null, svgIndex: out.length })
      }
    }
  }

  walk(rootIds)
  return out
}

function attachGeometry(leaves: LeafInfo[], nodesById: Record<string, CanvasNode>): LeafInfo[] {
  for (const leaf of leaves) {
    const node = nodesById[leaf.nodeId]
    const bounds = node ? getNodePreviewBounds(node, nodesById) : null
    leaf.bounds = bounds
    leaf.centroid = bounds ? boundsCentroid(bounds) : null
  }
  return leaves
}

function boundsArea(b: Bounds): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function unionAll(bs: Bounds[]): Bounds | null {
  if (bs.length === 0) return null
  let out: Bounds = { ...bs[0]! }
  for (let i = 1; i < bs.length; i += 1) {
    const b = bs[i]!
    out = {
      minX: Math.min(out.minX, b.minX),
      minY: Math.min(out.minY, b.minY),
      maxX: Math.max(out.maxX, b.maxX),
      maxY: Math.max(out.maxY, b.maxY),
    }
  }
  return out
}

function boundsOverlap(a: Bounds, b: Bounds, slop: number): boolean {
  return !(
    a.maxX + slop < b.minX ||
    b.maxX + slop < a.minX ||
    a.maxY + slop < b.minY ||
    b.maxY + slop < a.minY
  )
}

function containsCentroid(b: Bounds, p: { x: number; y: number }): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

class UnionFind {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    let r = i
    while (this.parent[r] !== r) r = this.parent[r]!
    while (this.parent[i] !== r) {
      const n = this.parent[i]!
      this.parent[i] = r
      i = n
    }
    return r
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

interface Blob {
  leaves: LeafInfo[]
  bounds: Bounds
  centroid: { x: number; y: number }
  minSvgIndex: number
  isSpanner: boolean
  spannerArea: number
  id: string
  name: string
}

function blobIdFromNodeIds(nodeIds: string[]): string {
  let hash = 2166136261
  for (const nodeId of nodeIds) {
    for (let i = 0; i < nodeId.length; i += 1) {
      hash ^= nodeId.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0x7c
  }
  return `blob-${(hash >>> 0).toString(36)}`
}

function makeBlob(leaves: LeafInfo[], isSpanner: boolean, fallbackName: string): Blob | null {
  const withBounds = leaves.filter((l) => l.bounds && l.centroid)
  if (withBounds.length === 0) return null
  const bounds = unionAll(withBounds.map((l) => l.bounds!))!
  const centroid = boundsCentroid(bounds)
  const sorted = [...leaves].sort((a, b) => a.svgIndex - b.svgIndex)
  const minSvgIndex = sorted[0]!.svgIndex
  const id = blobIdFromNodeIds(sorted.map((l) => l.nodeId))
  return {
    leaves: sorted,
    bounds,
    centroid,
    minSvgIndex,
    isSpanner,
    spannerArea: isSpanner ? boundsArea(bounds) : 0,
    id,
    name: fallbackName,
  }
}

function detectSpanners(leaves: LeafInfo[]): Set<number> {
  const valid = leaves
    .map((l, i) => ({ l, i }))
    .filter((x): x is { l: LeafInfo; i: number } => !!x.l.bounds && !!x.l.centroid)
  if (valid.length === 0) return new Set()

  const unionOfAll = unionAll(valid.map((x) => x.l.bounds!))
  const totalArea = unionOfAll ? boundsArea(unionOfAll) : 0

  const spanners = new Set<number>()
  for (const { l, i } of valid) {
    const area = boundsArea(l.bounds!)
    if (totalArea > 0 && area / totalArea >= SPANNER_AREA_RATIO) {
      spanners.add(i)
      continue
    }
    let containCount = 0
    for (const other of valid) {
      if (other.i === i) continue
      if (containsCentroid(l.bounds!, other.l.centroid!)) {
        containCount += 1
        if (containCount >= SPANNER_CONTAIN_COUNT) break
      }
    }
    if (containCount >= SPANNER_CONTAIN_COUNT) spanners.add(i)
  }
  return spanners
}

function clusterByProximity(leaves: LeafInfo[]): number[][] {
  const n = leaves.length
  const uf = new UnionFind(n)
  for (let i = 0; i < n; i += 1) {
    const a = leaves[i]!
    if (!a.bounds || !a.centroid) continue
    const areaA = boundsArea(a.bounds)
    for (let j = i + 1; j < n; j += 1) {
      const b = leaves[j]!
      if (!b.bounds || !b.centroid) continue
      if (boundsOverlap(a.bounds, b.bounds, BLOB_BOUNDS_SLOP_MM)) {
        uf.union(i, j)
        continue
      }
      const areaB = boundsArea(b.bounds)
      const radius = Math.max(BLOB_MIN_RADIUS_MM, BLOB_RADIUS_FRACTION * Math.sqrt(areaA * areaB))
      const dx = a.centroid.x - b.centroid.x
      const dy = a.centroid.y - b.centroid.y
      if (Math.hypot(dx, dy) <= radius) uf.union(i, j)
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < n; i += 1) {
    const r = uf.find(i)
    const arr = byRoot.get(r) ?? []
    arr.push(i)
    byRoot.set(r, arr)
  }
  return [...byRoot.values()]
}

function distanceFromBottomLeft(
  p: { x: number; y: number },
  artboard: ArtboardState,
): number {
  // Canvas y grows downward, user-visible bottom-left corner sits at y = artboard.height.
  return Math.hypot(p.x, artboard.height - p.y)
}

function computeAutoBlobs(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  artboard: ArtboardState,
): { blobs: Blob[]; spannerIds: string[] } {
  const leaves = attachGeometry(collectLeavesInSvgOrder(rootIds, nodesById), nodesById)
  if (leaves.length === 0) return { blobs: [], spannerIds: [] }

  const spannerSet = detectSpanners(leaves)

  const spannerBlobs: Blob[] = []
  const nonSpanners: LeafInfo[] = []
  for (let i = 0; i < leaves.length; i += 1) {
    const leaf = leaves[i]!
    if (spannerSet.has(i)) {
      const node = nodesById[leaf.nodeId]
      const blob = makeBlob([leaf], true, node?.name || leaf.nodeId)
      if (blob) spannerBlobs.push(blob)
    } else {
      nonSpanners.push(leaf)
    }
  }

  const clusters = clusterByProximity(nonSpanners)
  const detailBlobs: Blob[] = []
  for (const indices of clusters) {
    const blob = makeBlob(indices.map((i) => nonSpanners[i]!), false, 'Cluster')
    if (blob) detailBlobs.push(blob)
  }

  detailBlobs.sort((a, b) => {
    const da = distanceFromBottomLeft(a.centroid, artboard)
    const db = distanceFromBottomLeft(b.centroid, artboard)
    if (da !== db) return da - db
    return a.minSvgIndex - b.minSvgIndex
  })

  spannerBlobs.sort((a, b) => {
    if (a.spannerArea !== b.spannerArea) return a.spannerArea - b.spannerArea
    return a.minSvgIndex - b.minSvgIndex
  })

  let detailCounter = 0
  for (const blob of detailBlobs) {
    detailCounter += 1
    blob.name = `Cluster ${detailCounter}`
  }

  const blobs = [...detailBlobs, ...spannerBlobs]
  const spannerIds = spannerBlobs.flatMap((b) => b.leaves.map((l) => l.nodeId))
  return { blobs, spannerIds }
}

function computeManualLeafOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  manualOrder: string[],
): LeafInfo[] {
  const svgLeaves = collectLeavesInSvgOrder(rootIds, nodesById)
  const byId = new Map(svgLeaves.map((l) => [l.nodeId, l]))
  const used = new Set<string>()
  const out: LeafInfo[] = []
  for (const nodeId of manualOrder) {
    const leaf = byId.get(nodeId)
    if (leaf && !used.has(nodeId)) {
      out.push(leaf)
      used.add(nodeId)
    }
  }
  for (const leaf of svgLeaves) {
    if (!used.has(leaf.nodeId)) out.push(leaf)
  }
  return out
}

export function computeCutOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  strategy: CutOrderStrategy,
  manualOrder: string[] | null | undefined,
  artboard: ArtboardState,
): CutOrderResult {
  if (strategy === 'manual' && manualOrder && manualOrder.length > 0) {
    const leaves = computeManualLeafOrder(rootIds, nodesById, manualOrder)
    const sequence: CutOrderLeaf[] = leaves.map((leaf, index) => ({
      nodeId: leaf.nodeId,
      groupId: ROOT_GROUP_ID,
      groupName: ROOT_GROUP_NAME,
      index,
    }))
    return {
      sequence,
      groupOrder: sequence.length > 0 ? [ROOT_GROUP_ID] : [],
      groupNames: sequence.length > 0 ? { [ROOT_GROUP_ID]: ROOT_GROUP_NAME } : {},
      spannerNodeIds: [],
    }
  }

  const { blobs, spannerIds } = computeAutoBlobs(rootIds, nodesById, artboard)
  const sequence: CutOrderLeaf[] = []
  const groupOrder: string[] = []
  const groupNames: Record<string, string> = {}
  for (const blob of blobs) {
    groupOrder.push(blob.id)
    groupNames[blob.id] = blob.name
    for (const leaf of blob.leaves) {
      sequence.push({
        nodeId: leaf.nodeId,
        groupId: blob.id,
        groupName: blob.name,
        index: sequence.length,
      })
    }
  }

  return { sequence, groupOrder, groupNames, spannerNodeIds: spannerIds }
}

export { ROOT_GROUP_ID, ROOT_GROUP_NAME }
