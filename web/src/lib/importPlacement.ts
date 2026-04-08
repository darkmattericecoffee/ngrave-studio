import { getNodeSize } from './nodeDimensions'
import type { ArtboardState, CanvasNode } from '../types/editor'

const IMPORT_GAP = 10

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function overlaps(a: Rect, b: Rect) {
  return !(
    a.x + a.width + IMPORT_GAP <= b.x ||
    b.x + b.width + IMPORT_GAP <= a.x ||
    a.y + a.height + IMPORT_GAP <= b.y ||
    b.y + b.height + IMPORT_GAP <= a.y
  )
}

function fitsWithinArtboard(rect: Rect, artboard: ArtboardState) {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= artboard.width &&
    rect.y + rect.height <= artboard.height
  )
}

export function getAutoImportPlacement(params: {
  artboard: ArtboardState
  nodesById: Record<string, CanvasNode>
  rootIds: string[]
  width: number
  height: number
}) {
  const fallback = {
    x: 0,
    y: Math.max(0, params.artboard.height - params.height),
  }

  const occupied = params.rootIds
    .map((rootId) => {
      const node = params.nodesById[rootId]
      if (!node) {
        return null
      }

      const size = getNodeSize(node, params.nodesById)
      return {
        x: node.x,
        y: node.y,
        width: size.width,
        height: size.height,
      } satisfies Rect
    })
    .filter((rect): rect is Rect => rect != null)

  if (occupied.length === 0) {
    return fallback
  }

  const candidates = occupied.flatMap((rect) => [
    {
      x: rect.x + rect.width + IMPORT_GAP,
      y: rect.y,
      width: params.width,
      height: params.height,
    },
    {
      x: rect.x,
      y: rect.y - params.height - IMPORT_GAP,
      width: params.width,
      height: params.height,
    },
  ])

  for (const candidate of candidates) {
    if (!fitsWithinArtboard(candidate, params.artboard)) {
      continue
    }

    if (occupied.some((rect) => overlaps(candidate, rect))) {
      continue
    }

    return { x: candidate.x, y: candidate.y }
  }

  return fallback
}
