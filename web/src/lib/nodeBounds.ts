import type { CanvasNode, GroupNode, LineNode } from '../types/editor'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

let measureSvg: SVGSVGElement | null = null
let measurePath: SVGPathElement | null = null
const pathBoundsCache = new Map<string, Bounds | null>()

function ensureMeasureElements() {
  if (measureSvg || typeof document === 'undefined') return

  measureSvg = document.createElementNS(SVG_NS, 'svg')
  measureSvg.setAttribute('width', '0')
  measureSvg.setAttribute('height', '0')
  measureSvg.setAttribute('aria-hidden', 'true')
  Object.assign(measureSvg.style, {
    position: 'absolute',
    left: '-99999px',
    top: '-99999px',
    visibility: 'hidden',
    pointerEvents: 'none',
  })

  measurePath = document.createElementNS(SVG_NS, 'path')
  measureSvg.appendChild(measurePath)
  document.body.appendChild(measureSvg)
}

export function measurePathBounds(data: string): Bounds | null {
  if (pathBoundsCache.has(data)) {
    return pathBoundsCache.get(data) ?? null
  }

  ensureMeasureElements()
  if (!measurePath) return null

  try {
    measurePath.setAttribute('d', data)
    const box = measurePath.getBBox()
    const bounds = {
      minX: box.x,
      minY: box.y,
      maxX: box.x + box.width,
      maxY: box.y + box.height,
    }
    pathBoundsCache.set(data, bounds)
    return bounds
  } catch {
    pathBoundsCache.set(data, null)
    return null
  }
}

export function identityMatrix(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

export function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

export function nodeMatrix(node: CanvasNode): Matrix {
  const radians = node.rotation * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)

  return {
    a: cos * node.scaleX,
    b: sin * node.scaleX,
    c: -sin * node.scaleY,
    d: cos * node.scaleY,
    e: node.x,
    f: node.y,
  }
}

function applyMatrix(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  }
}

function addPoint(bounds: Bounds | null, x: number, y: number): Bounds {
  if (!bounds) {
    return { minX: x, minY: y, maxX: x, maxY: y }
  }

  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, y),
  }
}

function addTransformedRect(
  bounds: Bounds | null,
  matrix: Matrix,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Bounds {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ].reduce<Bounds | null>((nextBounds, [x, y]) => {
    const point = applyMatrix(matrix, x, y)
    return addPoint(nextBounds, point.x, point.y)
  }, bounds)!
}

function strokePadding(strokeWidth?: number): number {
  return Math.max((strokeWidth ?? 0) / 2, 0.5)
}

export function getNodePreviewBounds(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  parentMatrix = identityMatrix(),
): Bounds | null {
  if (!node.visible) return null

  const matrix = multiplyMatrices(parentMatrix, nodeMatrix(node))

  if (node.type === 'group') {
    return (node as GroupNode).childIds.reduce<Bounds | null>((bounds, childId) => {
      const child = nodesById[childId]
      if (!child) return bounds
      const childBounds = getNodePreviewBounds(child, nodesById, matrix)
      if (!childBounds) return bounds
      return addTransformedRect(
        bounds,
        identityMatrix(),
        childBounds.minX,
        childBounds.minY,
        childBounds.maxX,
        childBounds.maxY,
      )
    }, null)
  }

  if (node.type === 'rect') {
    const pad = strokePadding(node.strokeWidth)
    return addTransformedRect(null, matrix, -pad, -pad, node.width + pad, node.height + pad)
  }

  if (node.type === 'circle') {
    const pad = strokePadding(node.strokeWidth)
    return addTransformedRect(null, matrix, -node.radius - pad, -node.radius - pad, node.radius + pad, node.radius + pad)
  }

  if (node.type === 'line') {
    const lineNode = node as LineNode
    if (lineNode.points.length < 2) return null
    const xs = lineNode.points.filter((_, index) => index % 2 === 0)
    const ys = lineNode.points.filter((_, index) => index % 2 === 1)
    const pad = strokePadding(lineNode.strokeWidth)
    return addTransformedRect(
      null,
      matrix,
      Math.min(...xs) - pad,
      Math.min(...ys) - pad,
      Math.max(...xs) + pad,
      Math.max(...ys) + pad,
    )
  }

  const pathBounds = measurePathBounds(node.data)
  if (!pathBounds) return null
  const pad = strokePadding(node.strokeWidth)
  return addTransformedRect(
    null,
    matrix,
    pathBounds.minX - pad,
    pathBounds.minY - pad,
    pathBounds.maxX + pad,
    pathBounds.maxY + pad,
  )
}

export function boundsToViewBox(bounds: Bounds): string {
  const width = Math.max(0.001, bounds.maxX - bounds.minX)
  const height = Math.max(0.001, bounds.maxY - bounds.minY)
  const span = Math.max(width, height, 1)
  const padding = Math.max(span * 0.12, 1)
  const extraX = Math.max(0, span - width) / 2
  const extraY = Math.max(0, span - height) / 2

  return [
    bounds.minX - padding - extraX,
    bounds.minY - padding - extraY,
    width + padding * 2 + extraX * 2,
    height + padding * 2 + extraY * 2,
  ].join(' ')
}

export function boundsCentroid(bounds: Bounds): { x: number; y: number } {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }
}
