import type { ArtboardState, CanvasNode, Job, MachiningSettings, PathAnchor } from '../types/editor'
import { computeCutOrder, type CutOrderLeaf, type CutOrderResult } from './cutOrder'
import {
  boundsCentroid,
  getNodePreviewBounds,
  identityMatrix,
  multiplyMatrices,
  nodeMatrix,
  type Bounds,
  type Matrix,
} from './nodeBounds'

export interface ComputedJob extends Job {
  /** Union bounds of the job's leaves in artboard mm. */
  boundsMm: Bounds
  /** Anchor-resolved reference point in artboard mm. */
  anchorPointMm: { x: number; y: number }
  /** Pencil-cross offset measured from the artboard's bottom-left corner (mm). */
  crossOffsetFromArtboardBL: { x: number; y: number }
  /** Derived via the containment pass (true even when `forceOwnJob` is false). */
  isBigSpanner: boolean
  /** `true` when the partition came from `manualJobs`; `false` when auto-derived. */
  fromManualOverride: boolean
  /** Populated when the align-anchors pass snapped this job onto a shared
   *  horizon line with at least one neighbor. Used by the Prepare view to draw
   *  horizon guides and by the bridge to send an explicit anchor override to
   *  Rust so the gcode zero matches the pencil cross. */
  anchorAlignment?: { sharedX?: number; sharedY?: number }
}

const JOB_ID_PREFIX = 'job'

function anchorPoint(anchor: PathAnchor, bounds: Bounds): { x: number; y: number } {
  const midX = (bounds.minX + bounds.maxX) / 2
  const midY = (bounds.minY + bounds.maxY) / 2
  const x =
    anchor === 'TopLeft' || anchor === 'MiddleLeft' || anchor === 'BottomLeft'
      ? bounds.minX
      : anchor === 'TopRight' || anchor === 'MiddleRight' || anchor === 'BottomRight'
        ? bounds.maxX
        : midX
  const y =
    anchor === 'TopLeft' || anchor === 'TopCenter' || anchor === 'TopRight'
      ? bounds.minY
      : anchor === 'BottomLeft' || anchor === 'BottomCenter' || anchor === 'BottomRight'
        ? bounds.maxY
        : midY
  return { x, y }
}

function unionBounds(all: (Bounds | null)[]): Bounds | null {
  let out: Bounds | null = null
  for (const b of all) {
    if (!b) continue
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : b
  }
  return out
}

function hashString(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function stableJobId(nodeIds: string[], fallbackIndex = 0): string {
  const source = nodeIds.length > 0 ? nodeIds.join('|') : `empty-${fallbackIndex}`
  return `${JOB_ID_PREFIX}-${hashString(source)}`
}

function makeUniqueJobId(nodeIds: string[], usedIds: Set<string>, fallbackIndex = 0): string {
  const base = stableJobId(nodeIds, fallbackIndex)
  if (!usedIds.has(base)) {
    usedIds.add(base)
    return base
  }
  let suffix = 2
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  usedIds.add(id)
  return id
}

function makeManualJob(nodeIds: string[], index: number, usedIds: Set<string>): Job {
  return {
    id: makeUniqueJobId(nodeIds, usedIds, index),
    name: `Job ${index + 1}`,
    nodeIds,
    pathAnchor: 'Center',
    forceOwnJob: false,
  }
}

function orderedLeafIds(cutOrder: CutOrderResult): string[] {
  return cutOrder.sequence.map((leaf) => leaf.nodeId)
}

function cutOrderIndexMap(cutOrder: CutOrderResult): Map<string, number> {
  return new Map(cutOrder.sequence.map((leaf, index) => [leaf.nodeId, index]))
}

function sortNodeIdsByCutOrder(nodeIds: string[], orderIndex: Map<string, number>): string[] {
  return [...nodeIds].sort(
    (a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
}

function uniqueJobId(id: string, usedIds: Set<string>, nodeIds: string[], fallbackIndex: number): string {
  const base = id || stableJobId(nodeIds, fallbackIndex)
  if (!usedIds.has(base)) {
    usedIds.add(base)
    return base
  }
  let suffix = 2
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1
  const next = `${base}-${suffix}`
  usedIds.add(next)
  return next
}

function renumberJobNames(jobs: Job[]): Job[] {
  return jobs.map((job, index) => ({
    ...job,
    name: /^Job\s+\d+$/i.test(job.name.trim()) ? `Job ${index + 1}` : job.name,
  }))
}

export function manualJobsFromComputed(jobs: ComputedJob[]): Job[] {
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    nodeIds: [...job.nodeIds],
    pathAnchor: job.pathAnchor,
    forceOwnJob: job.forceOwnJob,
  }))
}

export function normalizeManualJobs(cutOrder: CutOrderResult, jobs: Job[] | null): Job[] {
  const leaves = orderedLeafIds(cutOrder)
  if (leaves.length === 0) return []
  if (!jobs || jobs.length === 0) {
    const usedIds = new Set<string>()
    return [makeManualJob(leaves, 0, usedIds)]
  }

  const validLeafIds = new Set(leaves)
  const orderIndex = cutOrderIndexMap(cutOrder)
  const sourceByLeafId = new Map<string, number>()
  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    for (const nodeId of jobs[jobIndex]?.nodeIds ?? []) {
      if (validLeafIds.has(nodeId) && !sourceByLeafId.has(nodeId)) {
        sourceByLeafId.set(nodeId, jobIndex)
      }
    }
  }

  const buckets = jobs.map(() => [] as string[])
  let currentJobIndex = jobs.findIndex((job) => job.nodeIds.some((nodeId) => validLeafIds.has(nodeId)))
  if (currentJobIndex < 0) currentJobIndex = 0

  for (const nodeId of leaves) {
    const explicitJobIndex = sourceByLeafId.get(nodeId)
    if (explicitJobIndex != null) currentJobIndex = explicitJobIndex
    buckets[currentJobIndex]?.push(nodeId)
  }

  const usedIds = new Set<string>()
  const normalized: Job[] = []
  for (let index = 0; index < jobs.length; index += 1) {
    const nodeIds = sortNodeIdsByCutOrder([...new Set(buckets[index] ?? [])], orderIndex)
    if (nodeIds.length === 0) continue
    const source = jobs[index]!
    normalized.push({
      id: uniqueJobId(source.id, usedIds, nodeIds, index),
      name: source.name || `Job ${normalized.length + 1}`,
      nodeIds,
      pathAnchor: source.pathAnchor,
      forceOwnJob: source.forceOwnJob,
    })
  }

  if (normalized.length === 0) {
    normalized.push(makeManualJob(leaves, 0, usedIds))
  }

  return renumberJobNames(normalized)
}

export function splitManualJobsAtCutIndex(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  cutIndex: number,
): Job[] {
  const leaves = orderedLeafIds(cutOrder)
  if (cutIndex <= 0 || cutIndex >= leaves.length) {
    return normalizeManualJobs(cutOrder, jobs)
  }

  const normalized = normalizeManualJobs(cutOrder, jobs)
  const targetNodeId = leaves[cutIndex]
  if (!targetNodeId) return normalized

  const jobIndex = normalized.findIndex((job) => job.nodeIds.includes(targetNodeId))
  if (jobIndex < 0) return normalized
  const job = normalized[jobIndex]!
  const splitIndex = job.nodeIds.indexOf(targetNodeId)
  if (splitIndex <= 0) return normalized

  const beforeIds = job.nodeIds.slice(0, splitIndex)
  const afterIds = job.nodeIds.slice(splitIndex)
  const usedIds = new Set(normalized.map((entry, index) => (index === jobIndex ? '' : entry.id)).filter(Boolean))
  const newJob: Job = {
    id: makeUniqueJobId(afterIds, usedIds, normalized.length),
    name: `Job ${jobIndex + 2}`,
    nodeIds: afterIds,
    pathAnchor: job.pathAnchor,
    forceOwnJob: false,
  }

  return renumberJobNames([
    ...normalized.slice(0, jobIndex),
    { ...job, nodeIds: beforeIds },
    newJob,
    ...normalized.slice(jobIndex + 1),
  ])
}

export function assignLeafIdsToJob(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  leafIds: string[],
  targetJobId: string | 'new',
): Job[] {
  const validLeaves = new Set(orderedLeafIds(cutOrder))
  const selected = [...new Set(leafIds)].filter((id) => validLeaves.has(id))
  if (selected.length === 0) return normalizeManualJobs(cutOrder, jobs)

  const orderIndex = cutOrderIndexMap(cutOrder)
  const sortedSelected = sortNodeIdsByCutOrder(selected, orderIndex)
  const selectedSet = new Set(sortedSelected)
  const stripped = normalizeManualJobs(cutOrder, jobs)
    .map((job) => ({
      ...job,
      nodeIds: job.nodeIds.filter((nodeId) => !selectedSet.has(nodeId)),
    }))
    .filter((job) => job.nodeIds.length > 0)

  if (targetJobId !== 'new') {
    const target = stripped.find((job) => job.id === targetJobId)
    if (target) {
      target.nodeIds = sortNodeIdsByCutOrder([...target.nodeIds, ...sortedSelected], orderIndex)
    } else {
      const original = normalizeManualJobs(cutOrder, jobs).find((job) => job.id === targetJobId)
      if (!original) return stripped
      stripped.push({ ...original, nodeIds: sortedSelected })
    }
    return renumberJobNames(stripped)
  }

  const usedIds = new Set(stripped.map((job) => job.id))
  const newJob = makeManualJob(sortedSelected, stripped.length, usedIds)
  const selectedStart = orderIndex.get(sortedSelected[0]!) ?? 0
  const insertAt = stripped.findIndex((job) => {
    const first = job.nodeIds[0]
    return first != null && (orderIndex.get(first) ?? Number.MAX_SAFE_INTEGER) > selectedStart
  })
  const nextJobs = [...stripped]
  nextJobs.splice(insertAt < 0 ? nextJobs.length : insertAt, 0, newJob)
  return renumberJobNames(nextJobs)
}

export interface MoveLeafToJobResult {
  manualCutOrder: string[]
  manualJobs: Job[]
}

/** Reorder the `manualJobs` list so the job sequence follows `nextJobIds`.
 *  Cut order is rewritten to match the new job order; leaf order inside each
 *  job is preserved. Unknown ids are ignored; jobs absent from `nextJobIds`
 *  are appended at the tail so we never lose assignments. */
export function reorderManualJobs(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  nextJobIds: string[],
): MoveLeafToJobResult {
  const normalized = normalizeManualJobs(cutOrder, jobs)
  const byId = new Map(normalized.map((job) => [job.id, job]))
  const seen = new Set<string>()
  const reordered: Job[] = []
  for (const id of nextJobIds) {
    const job = byId.get(id)
    if (job && !seen.has(id)) {
      reordered.push(job)
      seen.add(id)
    }
  }
  for (const job of normalized) {
    if (!seen.has(job.id)) reordered.push(job)
  }
  const renumbered = renumberJobNames(reordered)
  const manualCutOrder: string[] = []
  for (const job of renumbered) {
    for (const nodeId of job.nodeIds) manualCutOrder.push(nodeId)
  }
  return { manualCutOrder, manualJobs: renumbered }
}

export function moveLeafToJob(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  leafId: string,
  targetJobId: string,
  targetLeafId: string,
  before: boolean,
): MoveLeafToJobResult {
  const currentOrder = orderedLeafIds(cutOrder)
  if (leafId === targetLeafId || !currentOrder.includes(leafId) || !currentOrder.includes(targetLeafId)) {
    return {
      manualCutOrder: currentOrder,
      manualJobs: normalizeManualJobs(cutOrder, jobs),
    }
  }

  const manualCutOrder = [...currentOrder]
  const fromIndex = manualCutOrder.indexOf(leafId)
  manualCutOrder.splice(fromIndex, 1)
  const targetIndex = manualCutOrder.indexOf(targetLeafId)
  manualCutOrder.splice(targetIndex + (before ? 0 : 1), 0, leafId)

  const baseJobs = normalizeManualJobs(cutOrder, jobs)
  const movedJob = baseJobs.find((job) => job.id === targetJobId)
  if (!movedJob) {
    return {
      manualCutOrder,
      manualJobs: baseJobs,
    }
  }

  const nextJobs = baseJobs
    .map((job) => ({ ...job, nodeIds: job.nodeIds.filter((nodeId) => nodeId !== leafId) }))
    .filter((job) => job.nodeIds.length > 0 || job.id === targetJobId)
  const targetJob = nextJobs.find((job) => job.id === targetJobId)
  if (!targetJob) {
    return {
      manualCutOrder,
      manualJobs: nextJobs,
    }
  }

  const insertIndex = targetJob.nodeIds.indexOf(targetLeafId)
  targetJob.nodeIds.splice(insertIndex < 0 ? targetJob.nodeIds.length : insertIndex + (before ? 0 : 1), 0, leafId)

  const leafById = new Map(cutOrder.sequence.map((leaf) => [leaf.nodeId, leaf]))
  const nextCutOrder: CutOrderResult = {
    ...cutOrder,
    sequence: manualCutOrder
      .map((nodeId, index) => {
        const leaf = leafById.get(nodeId)
        return leaf ? { ...leaf, index } : null
      })
      .filter((leaf): leaf is CutOrderResult['sequence'][number] => Boolean(leaf)),
  }

  return {
    manualCutOrder,
    manualJobs: normalizeManualJobs(nextCutOrder, nextJobs),
  }
}

interface LeafWithBounds {
  nodeId: string
  bounds: Bounds
  centroid: { x: number; y: number }
  cutIndex: number
  forceOwnJob: boolean
  /** Blob id assigned by `computeCutOrder` — already reflects spatial clustering. */
  blobId: string
}

/** Greedy radial ordering: first leaf is nearest to `anchorPt`; every next leaf
 *  is the remaining one nearest to the previously picked leaf's centroid.
 *  Ties broken by original `cutIndex` so the output is deterministic. */
function reorderLeavesByAnchor(
  leaves: LeafWithBounds[],
  anchorPt: { x: number; y: number },
): LeafWithBounds[] {
  if (leaves.length <= 1) return leaves
  const remaining = leaves.slice()
  const ordered: LeafWithBounds[] = []
  let target = anchorPt
  while (remaining.length > 0) {
    let bestIdx = 0
    let best = remaining[0]!
    let bestDist = Math.hypot(best.centroid.x - target.x, best.centroid.y - target.y)
    for (let i = 1; i < remaining.length; i += 1) {
      const leaf = remaining[i]!
      const d = Math.hypot(leaf.centroid.x - target.x, leaf.centroid.y - target.y)
      if (d < bestDist - 1e-9) {
        bestDist = d
        bestIdx = i
        best = leaf
      } else if (Math.abs(d - bestDist) < 1e-9 && leaf.cutIndex < best.cutIndex) {
        bestIdx = i
        best = leaf
      }
    }
    remaining.splice(bestIdx, 1)
    ordered.push(best)
    target = best.centroid
  }
  return ordered
}

/** Compose the transform matrix from the root down to — but not including —
 *  `node`, so bounds can be reported in artboard coordinate space rather than
 *  the leaf's local space. Without this, SVG-imported leaves sit at identity
 *  locally while their containing `<svg>` group carries the import scale and
 *  origin-flip, producing bounds hundreds of mm off from where the art actually
 *  renders. */
export function ancestorMatrix(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
): Matrix {
  const chain: CanvasNode[] = []
  let cur: CanvasNode | undefined = node.parentId ? nodesById[node.parentId] : undefined
  while (cur) {
    chain.push(cur)
    cur = cur.parentId ? nodesById[cur.parentId] : undefined
  }
  chain.reverse()
  let matrix = identityMatrix()
  for (const ancestor of chain) matrix = multiplyMatrices(matrix, nodeMatrix(ancestor))
  return matrix
}

/** Build per-leaf geometry from the cut order, dropping leaves without bounds
 *  (e.g. invisible nodes) so every partition step has real coordinates. */
function leavesWithGeometry(
  cutOrder: CutOrderResult,
  nodesById: Record<string, CanvasNode>,
  manualJobs: Job[] | null,
): LeafWithBounds[] {
  const forceFlag = new Map<string, boolean>()
  if (manualJobs) {
    for (const j of manualJobs) {
      if (j.forceOwnJob) for (const id of j.nodeIds) forceFlag.set(id, true)
    }
  }

  const out: LeafWithBounds[] = []
  for (const leaf of cutOrder.sequence) {
    const node = nodesById[leaf.nodeId]
    if (!node) continue
    const bounds = getNodePreviewBounds(node, nodesById, ancestorMatrix(node, nodesById))
    if (!bounds) continue
    out.push({
      nodeId: leaf.nodeId,
      bounds,
      centroid: boundsCentroid(bounds),
      cutIndex: leaf.index,
      forceOwnJob: forceFlag.get(leaf.nodeId) ?? false,
      blobId: leaf.groupId,
    })
  }
  return out
}

/** Partition leaves into jobs by honoring the blob ids emitted by
 *  `computeCutOrder`. One blob = one job. `forceOwnJob` leaves split off into
 *  their own singleton job regardless of their blob. */
function autoPartition(
  leaves: LeafWithBounds[],
  groupOrder: string[],
): LeafWithBounds[][] {
  const forceSingletons: LeafWithBounds[] = []
  const byBlob = new Map<string, LeafWithBounds[]>()
  for (const leaf of leaves) {
    if (leaf.forceOwnJob) {
      forceSingletons.push(leaf)
      continue
    }
    const list = byBlob.get(leaf.blobId) ?? []
    list.push(leaf)
    byBlob.set(leaf.blobId, list)
  }

  const groups: LeafWithBounds[][] = []
  for (const leaf of forceSingletons) groups.push([leaf])
  for (const blobId of groupOrder) {
    const bucket = byBlob.get(blobId)
    if (bucket && bucket.length > 0) {
      groups.push([...bucket].sort((a, b) => a.cutIndex - b.cutIndex))
    }
  }
  // Any stray blobs not present in groupOrder (defensive — shouldn't happen).
  for (const [blobId, bucket] of byBlob) {
    if (!groupOrder.includes(blobId) && bucket.length > 0) {
      groups.push([...bucket].sort((a, b) => a.cutIndex - b.cutIndex))
    }
  }
  groups.sort((a, b) => {
    // Only reorder force-singletons relative to blob jobs by their cut index;
    // blob jobs remain in groupOrder.
    return Math.min(...a.map((l) => l.cutIndex)) - Math.min(...b.map((l) => l.cutIndex))
  })
  return groups
}

/** Single-linkage cluster of sorted 1D values. Returns groups of input indices;
 *  singletons included. Two consecutive sorted values join the same cluster
 *  when their gap is `<= tolerance`. */
function cluster1d(values: { value: number; index: number }[], tolerance: number): number[][] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const clusters: number[][] = []
  let current: typeof sorted = [sorted[0]!]
  for (let i = 1; i < sorted.length; i += 1) {
    const entry = sorted[i]!
    const prev = current[current.length - 1]!
    if (entry.value - prev.value <= tolerance) {
      current.push(entry)
    } else {
      clusters.push(current.map((e) => e.index))
      current = [entry]
    }
  }
  clusters.push(current.map((e) => e.index))
  return clusters
}

function roundMm(value: number): number {
  return Math.round(value * 10) / 10
}

/** Post-pass: for Center-anchored jobs whose anchor x (or y) values fall within
 *  `toleranceMm` of a neighbor, snap every member of the cluster to the cluster
 *  mean so they share a horizon line. Jobs with explicit non-Center anchors and
 *  singleton clusters are left alone. Mutates and returns the same array so
 *  downstream readers (bridge, UI) see the snapped points. */
export function alignJobAnchors(
  jobs: ComputedJob[],
  toleranceMm: number,
  artboardHeight: number,
): ComputedJob[] {
  if (toleranceMm <= 0 || jobs.length < 2) return jobs
  const eligible: number[] = []
  for (let i = 0; i < jobs.length; i += 1) {
    if (jobs[i]!.pathAnchor === 'Center') eligible.push(i)
  }
  if (eligible.length < 2) return jobs

  const snapOnAxis = (axis: 'x' | 'y'): Map<number, number> => {
    const values = eligible.map((idx) => ({
      value: jobs[idx]!.anchorPointMm[axis],
      index: idx,
    }))
    const clusters = cluster1d(values, toleranceMm)
    const snapped = new Map<number, number>()
    for (const cluster of clusters) {
      if (cluster.length < 2) continue
      const sum = cluster.reduce((acc, idx) => acc + jobs[idx]!.anchorPointMm[axis], 0)
      const snappedValue = roundMm(sum / cluster.length)
      for (const idx of cluster) snapped.set(idx, snappedValue)
    }
    return snapped
  }

  const xSnaps = snapOnAxis('x')
  const ySnaps = snapOnAxis('y')

  for (const idx of eligible) {
    const job = jobs[idx]!
    const newX = xSnaps.get(idx)
    const newY = ySnaps.get(idx)
    if (newX == null && newY == null) continue
    const resolvedX = newX ?? job.anchorPointMm.x
    const resolvedY = newY ?? job.anchorPointMm.y
    job.anchorPointMm = { x: resolvedX, y: resolvedY }
    job.crossOffsetFromArtboardBL = {
      x: resolvedX,
      y: artboardHeight - resolvedY,
    }
    const alignment: { sharedX?: number; sharedY?: number } = {}
    if (newX != null) alignment.sharedX = newX
    if (newY != null) alignment.sharedY = newY
    job.anchorAlignment = alignment
  }
  return jobs
}

export interface ComputeJobsResult {
  jobs: ComputedJob[]
  /** Auto-derived partition regardless of manual override; the UI shows
   *  "Reset to auto" only when this diverges from `jobs`. */
  autoJobs: ComputedJob[]
}

export function computeJobs(
  cutOrder: CutOrderResult,
  nodesById: Record<string, CanvasNode>,
  settings: MachiningSettings,
  artboard: ArtboardState,
): ComputeJobsResult {
  const leaves = leavesWithGeometry(cutOrder, nodesById, settings.manualJobs)
  const autoGroupsRaw = autoPartition(leaves, cutOrder.groupOrder)
  const bigSpannerNodeIds = new Set(cutOrder.spannerNodeIds)

  // When the user has manually ordered the cut sequence, respect it verbatim.
  // Otherwise reorder leaves within each job so the first cut lands nearest the
  // job's resolved anchor point, with the rest chained greedily.
  const skipAnchorReorder = settings.cutOrderStrategy === 'manual'

  const finalize = (
    groups: LeafWithBounds[][],
    fromManual: boolean,
    nameHint: (index: number) => string,
    anchorFor: (nodeIds: string[]) => PathAnchor,
    idFor: (index: number, nodeIds: string[]) => string,
    forceFlagFor: (nodeIds: string[]) => boolean,
  ): ComputedJob[] => {
    return groups.map((group, index) => {
      const membershipIds = group.map((l) => l.nodeId)
      const bounds = unionBounds(group.map((l) => l.bounds))!
      const anchor = anchorFor(membershipIds)
      const anchorPt = anchorPoint(anchor, bounds)
      const orderedGroup = skipAnchorReorder ? group : reorderLeavesByAnchor(group, anchorPt)
      const nodeIds = orderedGroup.map((l) => l.nodeId)
      return {
        // Hash from cut-index membership so job ids stay stable even when the
        // anchor-driven reorder shuffles `nodeIds`.
        id: idFor(index, membershipIds),
        name: nameHint(index),
        nodeIds,
        pathAnchor: anchor,
        forceOwnJob: forceFlagFor(nodeIds),
        boundsMm: bounds,
        anchorPointMm: anchorPt,
        crossOffsetFromArtboardBL: {
          x: anchorPt.x,
          // Artboard y grows downward in the editor; the user measures up from the
          // bottom edge, so flip.
          y: artboard.height - anchorPt.y,
        },
        isBigSpanner: nodeIds.some((id) => bigSpannerNodeIds.has(id)) || forceFlagFor(nodeIds),
        fromManualOverride: fromManual,
      }
    })
  }

  // Pre-compute the auto result so the UI can show "Reset to auto".
  const autoJobs = finalize(
    autoGroupsRaw,
    false,
    (i) => `Job ${i + 1}`,
    () => 'Center',
    (i, nodeIds) => stableJobId(nodeIds, i),
    (nodeIds) => nodeIds.some((id) => bigSpannerNodeIds.has(id)),
  )
  if (settings.alignJobAnchors) {
    alignJobAnchors(autoJobs, settings.alignJobAnchorsToleranceMm, artboard.height)
  }

  if (!settings.manualJobs || settings.manualJobs.length === 0) {
    return { jobs: autoJobs, autoJobs }
  }

  // Apply the manual partition — each job keeps its user-set anchor and name
  // while re-deriving bounds from current node positions.
  const normalizedManualJobs = normalizeManualJobs(cutOrder, settings.manualJobs)
  const byId = new Map(leaves.map((l) => [l.nodeId, l]))
  const manualPairs = normalizedManualJobs
    .map((job) => ({
      job,
      group: job.nodeIds.map((id) => byId.get(id)).filter((x): x is LeafWithBounds => !!x),
    }))
    .filter((pair) => pair.group.length > 0)
  const manualGroups: LeafWithBounds[][] = manualPairs.map((pair) => pair.group)

  const manualJobsByIndex = manualPairs.map((pair) => pair.job)
  const manualJobs = finalize(
    manualGroups,
    true,
    (i) => manualJobsByIndex[i]?.name ?? `Job ${i + 1}`,
    (nodeIds) => {
      const idx = manualJobsByIndex.findIndex((mj) =>
        mj.nodeIds.every((id) => nodeIds.includes(id)),
      )
      return manualJobsByIndex[idx]?.pathAnchor ?? 'Center'
    },
    (i, nodeIds) => manualJobsByIndex[i]?.id ?? stableJobId(nodeIds, i),
    (nodeIds) =>
      manualJobsByIndex.find((mj) => mj.nodeIds.every((id) => nodeIds.includes(id)))
        ?.forceOwnJob ?? false,
  )
  if (settings.alignJobAnchors) {
    alignJobAnchors(manualJobs, settings.alignJobAnchorsToleranceMm, artboard.height)
  }

  return { jobs: manualJobs, autoJobs }
}

/** Rebuild `cutOrder.sequence` so each job's leaves appear in the order stored
 *  on `jobs[i].nodeIds`. Membership and group metadata are preserved — only the
 *  ordering and per-leaf `index` change. Any leaf missing from the jobs (e.g.
 *  invisible nodes filtered out by `computeJobs`) is appended at the tail so we
 *  never drop entries. */
export function reorderCutOrderByJobs(
  cutOrder: CutOrderResult,
  jobs: ComputedJob[],
): CutOrderResult {
  const leafById = new Map(cutOrder.sequence.map((leaf) => [leaf.nodeId, leaf]))
  const used = new Set<string>()
  const sequence: CutOrderLeaf[] = []
  for (const job of jobs) {
    for (const nodeId of job.nodeIds) {
      if (used.has(nodeId)) continue
      const leaf = leafById.get(nodeId)
      if (!leaf) continue
      used.add(nodeId)
      sequence.push({ ...leaf, index: sequence.length })
    }
  }
  for (const leaf of cutOrder.sequence) {
    if (used.has(leaf.nodeId)) continue
    used.add(leaf.nodeId)
    sequence.push({ ...leaf, index: sequence.length })
  }
  return { ...cutOrder, sequence }
}

export interface CutPlan {
  cutOrder: CutOrderResult
  jobs: ComputedJob[]
  autoJobs: ComputedJob[]
}

/** One-stop entry point used by the UI and the bridge adapter: run the cut-
 *  order planner, partition into jobs, and — in `auto` mode — rewrite the
 *  sequence so leaves inside each job radiate out from that job's anchor.
 *  `manual` mode skips the reorder: the user has explicit control. */
export function computeCutPlan(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  settings: MachiningSettings,
  artboard: ArtboardState,
): CutPlan {
  const initialCutOrder = computeCutOrder(
    rootIds,
    nodesById,
    settings.cutOrderStrategy,
    settings.manualCutOrder,
    artboard,
  )
  const { jobs, autoJobs } = computeJobs(initialCutOrder, nodesById, settings, artboard)
  if (settings.cutOrderStrategy === 'manual') {
    return { cutOrder: initialCutOrder, jobs, autoJobs }
  }
  return { cutOrder: reorderCutOrderByJobs(initialCutOrder, jobs), jobs, autoJobs }
}
