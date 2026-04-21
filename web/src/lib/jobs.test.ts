import { describe, expect, it } from 'vitest'

import type { ArtboardState, CanvasNode, GroupNode, Job, MachiningSettings, RectNode } from '../types/editor'
import type { CutOrderResult } from './cutOrder'
import {
  assignLeafIdsToJob,
  computeCutPlan,
  computeJobs,
  manualJobsFromComputed,
  moveLeafToJob,
  normalizeManualJobs,
  splitManualJobsAtCutIndex,
} from './jobs'

const ARTBOARD: ArtboardState = { width: 600, height: 500, thickness: 18, x: 0, y: 0 }

const BASE_SETTINGS: MachiningSettings = {
  toolDiameter: 3,
  toolShape: 'Flat',
  defaultDepthMm: 3,
  passCount: 1,
  maxStepdown: null,
  stepover: null,
  maxFillPasses: null,
  cutFeedrate: null,
  shallowCutFeedrate: null,
  plungeFeedrate: null,
  travelZ: null,
  cutZ: null,
  machineWidth: null,
  machineHeight: null,
  tabsEnabled: false,
  tabWidth: 4,
  tabHeight: 1.5,
  tabSpacing: 50,
  optimizePathOrder: true,
  pathAnchor: 'Center',
  clusterDetourRadius: null,
  circularInterpolation: true,
  cutOrderStrategy: 'auto',
  manualCutOrder: null,
  jobsEnabled: true,
  manualJobs: null,
}

function rect(id: string, x: number, y: number, w = 10, h = 10, parentId: string | null = null): RectNode {
  return {
    id,
    type: 'rect',
    name: id,
    x,
    y,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId,
    width: w,
    height: h,
    fill: '',
    stroke: '#000',
    strokeWidth: 1,
  }
}

function group(id: string, childIds: string[]): GroupNode {
  return {
    id,
    type: 'group',
    name: id,
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId: null,
    childIds,
  }
}

function cutOrderFromIds(ids: string[]): CutOrderResult {
  return {
    sequence: ids.map((nodeId, index) => ({
      nodeId,
      groupId: '__root__',
      groupName: 'Root',
      index,
    })),
    groupOrder: ['__root__'],
    groupNames: { __root__: 'Root' },
    spannerNodeIds: [],
  }
}

function makeScene(nodes: CanvasNode[]): Record<string, CanvasNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]))
}

describe('computeJobs', () => {
  it('keeps auto job ids stable across recomputes', () => {
    const childIds = ['a', 'b', 'c']
    const nodes: CanvasNode[] = [
      group('import', childIds),
      rect('a', 100, 100, 20, 20, 'import'),
      rect('b', 130, 100, 20, 20, 'import'),
      rect('c', 100, 130, 20, 20, 'import'),
    ]
    const scene = makeScene(nodes)
    const cutOrder = cutOrderFromIds(childIds)

    const first = computeJobs(cutOrder, scene, BASE_SETTINGS, ARTBOARD).jobs
    const second = computeJobs(cutOrder, scene, BASE_SETTINGS, ARTBOARD).jobs

    expect(first.map((job) => job.id)).toEqual(second.map((job) => job.id))
    expect(first).toHaveLength(1)
  })

  it('splits a manual job before the marker row and carries later leaves forward', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c', 'd'])
    const base = manualJobsFromComputed([
      {
        id: 'job-all',
        name: 'Job 1',
        nodeIds: ['a', 'b', 'c', 'd'],
        pathAnchor: 'Center',
        forceOwnJob: false,
        boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        anchorPointMm: { x: 5, y: 5 },
        crossOffsetFromArtboardBL: { x: 5, y: 495 },
        isBigSpanner: false,
        fromManualOverride: false,
      },
    ])

    const split = splitManualJobsAtCutIndex(cutOrder, base, 2)
    expect(split.map((job) => job.nodeIds)).toEqual([['a', 'b'], ['c', 'd']])

    const withInsertedLeaf = normalizeManualJobs(cutOrderFromIds(['a', 'b', 'c', 'x', 'd']), split)
    expect(withInsertedLeaf.map((job) => job.nodeIds)).toEqual([['a', 'b'], ['c', 'x', 'd']])
  })

  it('normalizes deleted and duplicate leaves without losing the visible order', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c'])
    const normalized = normalizeManualJobs(cutOrder, [
      { id: 'one', name: 'Job 1', nodeIds: ['a', 'b', 'b', 'missing'], pathAnchor: 'Center', forceOwnJob: false },
      { id: 'two', name: 'Job 2', nodeIds: ['b', 'c'], pathAnchor: 'Center', forceOwnJob: false },
    ])

    expect(normalized.map((job) => job.nodeIds)).toEqual([['a', 'b'], ['c']])
  })

  it('moves selected cut-order leaves into an existing job', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c', 'd'])
    const base: Job[] = [
      { id: 'one', name: 'Job 1', nodeIds: ['a', 'b'], pathAnchor: 'Center', forceOwnJob: false },
      { id: 'two', name: 'Job 2', nodeIds: ['c', 'd'], pathAnchor: 'Center', forceOwnJob: false },
    ]

    const next = assignLeafIdsToJob(cutOrder, base, ['b', 'c'], 'one')
    expect(next.map((job) => job.nodeIds)).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('reorders leaves within a job by distance to the job anchor (Center)', () => {
    // Four rects spaced around a centre point; cluster radius merges them all
    // into one job. With `Center` anchor, the greedy order should start at the
    // rect closest to the bounds centroid, then chain to the nearest remaining.
    const childIds = ['tl', 'tr', 'bl', 'br']
    const nodes: CanvasNode[] = [
      group('import', childIds),
      rect('tl', 100, 100, 20, 20, 'import'), // centroid (110, 110)
      rect('tr', 130, 100, 20, 20, 'import'), // centroid (140, 110)
      rect('bl', 100, 130, 20, 20, 'import'), // centroid (110, 140)
      rect('br', 130, 130, 20, 20, 'import'), // centroid (140, 140)
    ]
    const scene = makeScene(nodes)
    const plan = computeCutPlan(childIds, scene, BASE_SETTINGS, ARTBOARD)

    // All four rects fall into one auto job whose Center anchor sits at (125,125).
    // All four centroids are equidistant from the anchor; the stable tie-break
    // picks `tl` first (lowest cutIndex). From `tl`, `tr` and `bl` are both at
    // distance 30 → tie-break picks `tr` (lower cutIndex), then `br`, then `bl`.
    expect(plan.jobs).toHaveLength(1)
    expect(plan.jobs[0]!.nodeIds).toEqual(['tl', 'tr', 'br', 'bl'])
    expect(plan.cutOrder.sequence.map((l) => l.nodeId)).toEqual(['tl', 'tr', 'br', 'bl'])
  })

  it('honors a non-default anchor: TopRight orders leaves from the top-right corner', () => {
    const childIds = ['tl', 'tr', 'bl', 'br']
    const nodes: CanvasNode[] = [
      group('import', childIds),
      rect('tl', 100, 100, 20, 20, 'import'),
      rect('tr', 130, 100, 20, 20, 'import'),
      rect('bl', 100, 130, 20, 20, 'import'),
      rect('br', 130, 130, 20, 20, 'import'),
    ]
    const scene = makeScene(nodes)
    const settings: MachiningSettings = {
      ...BASE_SETTINGS,
      manualJobs: [
        {
          id: 'job-1',
          name: 'Job 1',
          nodeIds: childIds,
          pathAnchor: 'TopRight',
          forceOwnJob: false,
        },
      ],
    }
    const plan = computeCutPlan(childIds, scene, settings, ARTBOARD)

    // TopRight anchor resolves to (maxX, minY) of the union bounds = (150, 100).
    // `tr` (140,110) is nearest. From `tr`: `tl` and `br` are equidistant (30),
    // tie-break by cutIndex picks `tl`, then `bl` (nearest to `tl`), then `br`.
    expect(plan.jobs).toHaveLength(1)
    expect(plan.jobs[0]!.pathAnchor).toBe('TopRight')
    expect(plan.jobs[0]!.nodeIds).toEqual(['tr', 'tl', 'bl', 'br'])
  })

  it('skips anchor-based reorder when the cut-order strategy is manual', () => {
    const childIds = ['tl', 'tr', 'bl', 'br']
    const nodes: CanvasNode[] = [
      group('import', childIds),
      rect('tl', 100, 100, 20, 20, 'import'),
      rect('tr', 130, 100, 20, 20, 'import'),
      rect('bl', 100, 130, 20, 20, 'import'),
      rect('br', 130, 130, 20, 20, 'import'),
    ]
    const scene = makeScene(nodes)
    const manualOrder = ['br', 'bl', 'tr', 'tl']
    const settings: MachiningSettings = {
      ...BASE_SETTINGS,
      cutOrderStrategy: 'manual',
      manualCutOrder: manualOrder,
    }
    const plan = computeCutPlan(childIds, scene, settings, ARTBOARD)

    expect(plan.jobs[0]!.nodeIds).toEqual(manualOrder)
    expect(plan.cutOrder.sequence.map((l) => l.nodeId)).toEqual(manualOrder)
  })

  it('moves a dragged leaf into another job and updates manual cut order', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c', 'd'])
    const base: Job[] = [
      { id: 'one', name: 'Job 1', nodeIds: ['a', 'b'], pathAnchor: 'Center', forceOwnJob: false },
      { id: 'two', name: 'Job 2', nodeIds: ['c', 'd'], pathAnchor: 'Center', forceOwnJob: false },
    ]

    const result = moveLeafToJob(cutOrder, base, 'b', 'two', 'd', true)

    expect(result.manualCutOrder).toEqual(['a', 'c', 'b', 'd'])
    expect(result.manualJobs.map((job) => job.nodeIds)).toEqual([['a'], ['c', 'b', 'd']])
  })
})
