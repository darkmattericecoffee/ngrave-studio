import { describe, expect, it } from 'vitest'

import type { ArtboardState, CanvasNode, GroupNode, RectNode } from '../types/editor'
import { computeCutOrder } from './cutOrder'

const ARTBOARD: ArtboardState = { width: 600, height: 500, thickness: 18, x: 0, y: 0 }

function rect(
  id: string,
  x: number,
  y: number,
  w = 10,
  h = 10,
  parentId: string | null = null,
): RectNode {
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
    stroke: '',
    strokeWidth: 0,
  }
}

function group(id: string, childIds: string[], parentId: string | null = null): GroupNode {
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
    parentId,
    childIds,
  }
}

function scene(nodes: CanvasNode[]): Record<string, CanvasNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]))
}

describe('computeCutOrder — magic auto planner', () => {
  it('merges two SVG groups whose bounds overlap into a single blob', () => {
    // Two separate groups, each holding shapes that sit right next to each other.
    const nodes: CanvasNode[] = [
      group('g1', ['a', 'b']),
      group('g2', ['c', 'd']),
      rect('a', 100, 100, 20, 20, 'g1'),
      rect('b', 125, 100, 20, 20, 'g1'),
      rect('c', 150, 100, 20, 20, 'g2'),
      rect('d', 175, 100, 20, 20, 'g2'),
    ]
    const result = computeCutOrder(['g1', 'g2'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.groupOrder).toHaveLength(1)
    expect(result.sequence.map((l) => l.nodeId).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('splits a single SVG group into separate blobs when its shapes are far apart', () => {
    // One group containing two clusters on opposite corners of the artboard.
    const nodes: CanvasNode[] = [
      group('g', ['a', 'b', 'c', 'd']),
      rect('a', 20, 20, 15, 15, 'g'),
      rect('b', 40, 20, 15, 15, 'g'),
      rect('c', 500, 400, 15, 15, 'g'),
      rect('d', 520, 400, 15, 15, 'g'),
    ]
    const result = computeCutOrder(['g'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.groupOrder).toHaveLength(2)
    const blobIds = result.sequence.map((l) => l.groupId)
    // a/b share a blob, c/d share the other blob
    expect(blobIds[0]).toBe(blobIds[1])
    expect(blobIds[2]).toBe(blobIds[3])
    expect(blobIds[0]).not.toBe(blobIds[2])
  })

  it('isolates a rect that encompasses 3+ shapes and puts it last', () => {
    // Big outer rect (passe-partout) with four small rects inside it.
    const nodes: CanvasNode[] = [
      rect('frame', 50, 50, 400, 300),
      rect('inner1', 80, 80, 20, 20),
      rect('inner2', 150, 80, 20, 20),
      rect('inner3', 220, 80, 20, 20),
      rect('inner4', 290, 80, 20, 20),
    ]
    const result = computeCutOrder(
      ['frame', 'inner1', 'inner2', 'inner3', 'inner4'],
      scene(nodes),
      'auto',
      null,
      ARTBOARD,
    )
    expect(result.spannerNodeIds).toEqual(['frame'])
    // Frame is the last item in the sequence.
    expect(result.sequence[result.sequence.length - 1]!.nodeId).toBe('frame')
    // Frame is in its own blob.
    const frameBlob = result.sequence.find((l) => l.nodeId === 'frame')!.groupId
    const innerBlobs = result.sequence
      .filter((l) => l.nodeId !== 'frame')
      .map((l) => l.groupId)
    for (const blobId of innerBlobs) expect(blobId).not.toBe(frameBlob)
  })

  it('orders detail blobs by distance from the artboard bottom-left corner', () => {
    // Two clusters on opposite ends; near bottom-left should come first.
    const nodes: CanvasNode[] = [
      rect('far-a', 500, 50, 10, 10),
      rect('far-b', 520, 50, 10, 10),
      rect('near-a', 30, 470, 10, 10),
      rect('near-b', 50, 470, 10, 10),
    ]
    const result = computeCutOrder(
      ['far-a', 'far-b', 'near-a', 'near-b'],
      scene(nodes),
      'auto',
      null,
      ARTBOARD,
    )
    expect(result.sequence.slice(0, 2).map((l) => l.nodeId).sort()).toEqual(['near-a', 'near-b'])
    expect(result.sequence.slice(2).map((l) => l.nodeId).sort()).toEqual(['far-a', 'far-b'])
  })

  it('honors manual order and collapses all leaves into one root groupId', () => {
    const nodes: CanvasNode[] = [
      rect('a', 10, 10, 10, 10),
      rect('b', 50, 10, 10, 10),
      rect('c', 100, 10, 10, 10),
    ]
    const result = computeCutOrder(
      ['a', 'b', 'c'],
      scene(nodes),
      'manual',
      ['c', 'a', 'b'],
      ARTBOARD,
    )
    expect(result.sequence.map((l) => l.nodeId)).toEqual(['c', 'a', 'b'])
    expect(result.groupOrder).toEqual(['__root__'])
    expect(result.spannerNodeIds).toEqual([])
  })

  it('skips invisible nodes entirely', () => {
    const hidden = rect('a', 10, 10, 10, 10)
    hidden.visible = false
    const nodes: CanvasNode[] = [hidden, rect('b', 50, 10, 10, 10)]
    const result = computeCutOrder(['a', 'b'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.sequence.map((l) => l.nodeId)).toEqual(['b'])
  })

  it('orders multiple spanners smallest → largest', () => {
    // Two encompassing rects plus enough small shapes to trigger contain-count detection.
    const nodes: CanvasNode[] = [
      rect('big', 20, 20, 550, 450),
      rect('medium', 40, 40, 300, 250),
      rect('s1', 60, 60, 10, 10),
      rect('s2', 100, 60, 10, 10),
      rect('s3', 140, 60, 10, 10),
      rect('s4', 180, 60, 10, 10),
    ]
    const result = computeCutOrder(
      ['big', 'medium', 's1', 's2', 's3', 's4'],
      scene(nodes),
      'auto',
      null,
      ARTBOARD,
    )
    expect(result.spannerNodeIds).toEqual(expect.arrayContaining(['big', 'medium']))
    const seq = result.sequence.map((l) => l.nodeId)
    const mediumIdx = seq.indexOf('medium')
    const bigIdx = seq.indexOf('big')
    expect(mediumIdx).toBeLessThan(bigIdx)
    // Both spanners come after every detail leaf.
    for (const id of ['s1', 's2', 's3', 's4']) {
      expect(seq.indexOf(id)).toBeLessThan(mediumIdx)
    }
  })
})
