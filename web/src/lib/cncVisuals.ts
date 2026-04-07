import type { CanvasNode, CncMetadata, EngraveType } from '../types/editor'

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
export type NormalizedEngraveType = 'contour' | 'pocket'

export interface CncVisualOverrides {
  stroke?: string
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

  return type === 'pocket' || type === 'raster' ? 'pocket' : 'contour'
}

export function resolveEngraveType(
  type: EngraveType | undefined,
  fallback: NormalizedEngraveType = 'pocket',
): NormalizedEngraveType {
  return normalizeEngraveType(type) ?? fallback
}

export function getCncVisualOverrides(
  cncMetadata?: CncMetadata,
  parentCncMetadata?: CncMetadata,
): CncVisualOverrides {
  // Use own metadata, falling back to parent metadata for inheritance
  const effectiveMeta = cncMetadata?.cutDepth !== undefined
    ? cncMetadata
    : parentCncMetadata

  if (!effectiveMeta) return {}

  const { cutDepth, engraveType } = effectiveMeta

  if (cutDepth === undefined || cutDepth === null) return {}

  const ratio = Math.min(1, Math.max(0, cutDepth / MAX_CUT_DEPTH))
  const type = resolveEngraveType(engraveType, 'contour')

  if (type === 'pocket') {
    const fillAlpha = 0.30 + ratio * 0.65
    return {
      fill: `rgba(15, 8, 3, ${fillAlpha.toFixed(2)})`,
      stroke: depthToColor(cutDepth),
    }
  }

  return {
    stroke: depthToColor(cutDepth),
  }
}
