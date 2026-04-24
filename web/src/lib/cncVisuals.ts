import type { CanvasNode, CncMetadata, EngraveType } from '../types/editor'
import { mergeCncMetadata, resolveNodeCncMetadata } from './cncMetadata'

export const MAX_CUT_DEPTH = 20

export function depthToColor(depth: number, maxDepth: number = MAX_CUT_DEPTH): string {
  const ratio = Math.min(1, Math.max(0, depth / maxDepth))
  const hue = 60 - ratio * 60
  return `hsl(${hue}, 90%, 55%)`
}

/** Returns true if the node is geometrically open (not closed). */
export function isGeometricallyOpen(node: CanvasNode): boolean {
  if (node.type === 'line') return !node.closed
  if (node.type === 'path') return !/[Zz]/.test(node.data)
  return false
}

/**
 * Returns true if the node should be treated as a stroke-only path for CNC purposes.
 * A path is stroke-only if it's geometrically open OR if it has no fill (stroke-only).
 * Closed paths with `fill: none` (e.g. from Illustrator outlines) should be routed
 * as contour/outline, not as pockets.
 */
export function isOpenPathNode(node: CanvasNode): boolean {
  if (isGeometricallyOpen(node)) return true
  // Closed path with no fill — treat as outline, not fillable area
  if (node.type === 'line') return !node.fill
  if (node.type === 'path') return !node.fill
  return false
}
export type NormalizedEngraveType = 'contour' | 'pocket' | 'plunge'

export interface CncVisualOverrides {
  stroke?: string
  strokeWidth?: number
  strokeScaleEnabled?: boolean
  fill?: string
}

const previewAlphaForDepth = (cutDepth: number): number => {
  const ratio = Math.min(1, Math.max(0, cutDepth / MAX_CUT_DEPTH))
  return 0.34 + ratio * 0.42
}

export function getEngravePreviewFill(depth: number): string {
  return `rgba(30, 14, 5, ${previewAlphaForDepth(depth).toFixed(2)})`
}

export function getEngravePreviewStroke(depth: number): string {
  const ratio = Math.min(1, Math.max(0, depth / MAX_CUT_DEPTH))
  return `rgba(18, 8, 2, ${(0.34 + ratio * 0.34).toFixed(2)})`
}

export function normalizeEngraveType(type?: EngraveType): NormalizedEngraveType | undefined {
  if (!type) {
    return undefined
  }

  if (type === 'plunge') return 'plunge'
  return type === 'pocket' || type === 'raster' ? 'pocket' : 'contour'
}

export function resolveEngraveType(
  type: EngraveType | undefined,
  fallback: NormalizedEngraveType = 'pocket',
): NormalizedEngraveType {
  return normalizeEngraveType(type) ?? fallback
}

function resolveNormalizedPreviewEngraveMode(
  node: CanvasNode,
  normalizedType: NormalizedEngraveType | undefined,
  fallback: NormalizedEngraveType = 'pocket',
): NormalizedEngraveType {
  if (isGeometricallyOpen(node)) {
    return 'contour'
  }

  return normalizedType ?? fallback
}

export function resolvePreviewEngraveMode(
  node: CanvasNode,
  cncMetadata?: CncMetadata,
  parentCncMetadata?: CncMetadata,
  fallback: NormalizedEngraveType = 'pocket',
): NormalizedEngraveType {
  const effectiveMeta = mergeCncMetadata(cncMetadata, parentCncMetadata)
  return resolveNormalizedPreviewEngraveMode(
    node,
    normalizeEngraveType(effectiveMeta?.engraveType),
    fallback,
  )
}

export function resolveNodePreviewEngraveMode(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  fallback: NormalizedEngraveType = 'pocket',
): NormalizedEngraveType {
  const effectiveMeta = resolveNodeCncMetadata(node, nodesById)
  return resolveNormalizedPreviewEngraveMode(
    node,
    normalizeEngraveType(effectiveMeta.engraveType),
    fallback,
  )
}

export function shouldUseToolDiameterStrokePreview(
  _node: CanvasNode,
  resolvedMode: NormalizedEngraveType,
): boolean {
  return resolvedMode === 'contour'
}

export function getCncVisualOverrides(
  node: CanvasNode,
  cncMetadata?: CncMetadata,
  parentCncMetadata?: CncMetadata,
): CncVisualOverrides {
  const effectiveMeta = mergeCncMetadata(cncMetadata, parentCncMetadata)

  if (!effectiveMeta) return {}

  const { cutDepth } = effectiveMeta

  if (cutDepth === undefined || cutDepth === null) return {}

  const ratio = Math.min(1, Math.max(0, cutDepth / MAX_CUT_DEPTH))
  const type = resolvePreviewEngraveMode(node, cncMetadata, parentCncMetadata, 'pocket')

  if (type === 'plunge') {
    return {
      fill: `rgba(60, 130, 240, ${(0.35 + ratio * 0.45).toFixed(2)})`,
      stroke: depthToColor(cutDepth),
    }
  }

  if (type === 'pocket') {
    const hue = 60 - ratio * 60
    return {
      fill: `hsla(${hue}, 90%, 55%, 0.5)`,
      stroke: 'rgba(0, 0, 0, 0.35)',
      strokeWidth: 1.5,
      strokeScaleEnabled: false,
    }
  }

  return {
    stroke: depthToColor(cutDepth),
  }
}
