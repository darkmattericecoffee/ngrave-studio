import type { ArtboardState, CanvasNode, CircleNode, GroupNode, LineNode, MachiningSettings, PathNode, RectNode } from '../types/editor'
import { resolveNodeCncMetadata } from './cncMetadata'
import { isGeometricallyOpen, normalizeEngraveType } from './cncVisuals'

/**
 * When a node is geometrically closed AND its effective engraveType resolves
 * to "pocket", the SVG must go out with a solid fill. The Rust CAM turtle only
 * registers a closed subpath as a pocket-able fill shape when `current_paint.fill`
 * is truthy (see `lib/src/converter/cam.rs::CamTurtle::flush_subpath`). Emitting
 * `fill="none"` would silently downgrade the operation to a contour, regardless
 * of the data-engrave-type annotation.
 *
 * Honors an explicit `node.fill` when present, so user-set fills always win.
 */
const POCKET_EXPORT_FILL = '#000'

interface SerializeContext {
  nodesById: Record<string, CanvasNode>
  /** When true, substitute a solid fill for closed nodes whose resolved engraveType is "pocket". */
  forcePocketFill: boolean
}

function effectiveFill(node: CanvasNode, ctx: SerializeContext, fallback: string = 'none'): string {
  if ('fill' in node && node.fill) return node.fill
  if (!ctx.forcePocketFill) return fallback
  if (isGeometricallyOpen(node)) return fallback
  const resolved = normalizeEngraveType(resolveNodeCncMetadata(node, ctx.nodesById).engraveType)
  if (resolved === 'pocket') return POCKET_EXPORT_FILL
  return fallback
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function attr(name: string, value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ''
  return ` ${name}="${esc(value)}"`
}

function optionalAttr(name: string, value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' && value === 1 && name === 'opacity') return ''
  return ` ${name}="${esc(value)}"`
}

/**
 * Builds a compact SVG transform string. Omits components that are identity.
 */
function serializeTransform(
  x: number,
  y: number,
  rotation: number,
  scaleX: number,
  scaleY: number,
): string {
  const parts: string[] = []

  if (x !== 0 || y !== 0) {
    parts.push(`translate(${x} ${y})`)
  }
  if (rotation !== 0) {
    parts.push(`rotate(${rotation})`)
  }
  if (scaleX !== 1 || scaleY !== 1) {
    parts.push(`scale(${scaleX} ${scaleY})`)
  }

  return parts.length > 0 ? ` transform="${parts.join(' ')}"` : ''
}

/**
 * Injects CNC custom data attributes for leaf nodes.
 * Returns an empty string when no CNC metadata is set.
 */
function cncDataAttrs(node: CanvasNode): string {
  const meta = node.cncMetadata
  if (!meta) return ''
  let out = ''
  if (meta.cutDepth !== undefined) {
    out += attr('data-cut-depth', meta.cutDepth)
  }
  if (meta.engraveType) {
    out += attr('data-engrave-type', meta.engraveType)
  }
  return out
}

function centerlineDataAttrs(node: CanvasNode): string {
  const meta = node.centerlineMetadata
  if (!meta) return ''
  return (
    attr('data-centerline-enabled', meta.enabled ? 'true' : 'false') +
    attr('data-centerline-scale-axis', meta.scaleAxis) +
    attr('data-centerline-samples', meta.samples) +
    (meta.toolDiameter !== undefined ? attr('data-centerline-tool-diameter', meta.toolDiameter) : '') +
    attr('data-centerline-edge-trim', meta.edgeTrim) +
    attr('data-centerline-simplify-tolerance', meta.simplifyTolerance) +
    attr('data-centerline-small-detail-tightness', meta.smallDetailTightness ?? 0) +
    (meta.forceRaster ? attr('data-centerline-force-raster', 'true') : '')
  )
}

function renderHintAttrs(node: CanvasNode): string {
  const renderHint = node.renderHint
  if (!renderHint) return ''

  if (renderHint.kind === 'plungeCircle') {
    return (
      attr('data-s2g-render-kind', 'plunge-circle') +
      attr('data-s2g-render-diameter', renderHint.diameter) +
      attr('data-s2g-render-center-x', renderHint.centerX) +
      attr('data-s2g-render-center-y', renderHint.centerY)
    )
  }

  return ''
}

// ─── per-type serializers ─────────────────────────────────────────────────────

function serializeGroup(
  node: GroupNode,
  ctx: SerializeContext,
  indent: string,
): string {
  const transform = serializeTransform(node.x, node.y, node.rotation, node.scaleX, node.scaleY)
  const opacityAttr = optionalAttr('opacity', node.opacity)
  const children = node.childIds
    .map((id) => {
      const child = ctx.nodesById[id]
      if (!child || !child.visible) return ''
      return serializeNode(child, ctx, indent + '  ')
    })
    .filter(Boolean)
    .join('\n')

  return `${indent}<g${transform}${opacityAttr}${centerlineDataAttrs(node)}>\n${children}\n${indent}</g>`
}

function serializeRect(node: RectNode, ctx: SerializeContext, indent: string): string {
  const transform = serializeTransform(0, 0, node.rotation, node.scaleX, node.scaleY)
  return (
    `${indent}<rect` +
    attr('x', node.x) +
    attr('y', node.y) +
    attr('width', node.width) +
    attr('height', node.height) +
    attr('fill', effectiveFill(node, ctx)) +
    attr('stroke', node.stroke ?? 'none') +
    attr('stroke-width', node.strokeWidth) +
    (node.cornerRadius ? attr('rx', node.cornerRadius) : '') +
    optionalAttr('opacity', node.opacity) +
    (transform || '') +
    cncDataAttrs(node) +
    centerlineDataAttrs(node) +
    renderHintAttrs(node) +
    ' />'
  )
}

function serializeCircle(node: CircleNode, ctx: SerializeContext, indent: string): string {
  // Konva treats (x, y) as the center of the circle.
  // Represent this in SVG as cx/cy on the circle element, no separate translate needed.
  const fill = effectiveFill(node, ctx)
  if (node.rotation !== 0 || node.scaleX !== 1 || node.scaleY !== 1) {
    // If there's non-trivial transform, wrap in a group for correctness.
    const transform = serializeTransform(node.x, node.y, node.rotation, node.scaleX, node.scaleY)
    return (
      `${indent}<g${transform}>\n` +
      `${indent}  <circle` +
      attr('cx', 0) +
      attr('cy', 0) +
      attr('r', node.radius) +
      attr('fill', fill) +
      attr('stroke', node.stroke ?? 'none') +
      attr('stroke-width', node.strokeWidth) +
      optionalAttr('opacity', node.opacity) +
      cncDataAttrs(node) +
      centerlineDataAttrs(node) +
      renderHintAttrs(node) +
      ` />\n${indent}</g>`
    )
  }

  return (
    `${indent}<circle` +
    attr('cx', node.x) +
    attr('cy', node.y) +
    attr('r', node.radius) +
    attr('fill', fill) +
    attr('stroke', node.stroke ?? 'none') +
    attr('stroke-width', node.strokeWidth) +
    optionalAttr('opacity', node.opacity) +
    cncDataAttrs(node) +
    centerlineDataAttrs(node) +
    renderHintAttrs(node) +
    ' />'
  )
}

function serializeLine(node: LineNode, ctx: SerializeContext, indent: string): string {
  const transform = serializeTransform(node.x, node.y, node.rotation, node.scaleX, node.scaleY)
  // Build "x1,y1 x2,y2 ..." from flat [x1, y1, x2, y2, ...] points array.
  const pointPairs: string[] = []
  for (let i = 0; i + 1 < node.points.length; i += 2) {
    pointPairs.push(`${node.points[i]},${node.points[i + 1]}`)
  }
  const pointsStr = pointPairs.join(' ')
  const tag = node.closed ? 'polygon' : 'polyline'

  return (
    `${indent}<${tag}` +
    attr('points', pointsStr) +
    attr('stroke', node.stroke ?? 'none') +
    attr('stroke-width', node.strokeWidth) +
    ` fill="${effectiveFill(node, ctx)}"` +
    (node.fillRule ? attr('fill-rule', node.fillRule) : '') +
    (node.lineCap ? attr('stroke-linecap', node.lineCap) : '') +
    (node.lineJoin ? attr('stroke-linejoin', node.lineJoin) : '') +
    optionalAttr('opacity', node.opacity) +
    (transform || '') +
    cncDataAttrs(node) +
    centerlineDataAttrs(node) +
    renderHintAttrs(node) +
    ' />'
  )
}

function serializePath(node: PathNode, ctx: SerializeContext, indent: string): string {
  const transform = serializeTransform(node.x, node.y, node.rotation, node.scaleX, node.scaleY)
  return (
    `${indent}<path` +
    attr('d', node.data) +
    attr('fill', effectiveFill(node, ctx)) +
    attr('stroke', node.stroke ?? 'none') +
    attr('stroke-width', node.strokeWidth) +
    (node.fillRule ? attr('fill-rule', node.fillRule) : '') +
    optionalAttr('opacity', node.opacity) +
    (transform || '') +
    cncDataAttrs(node) +
    centerlineDataAttrs(node) +
    renderHintAttrs(node) +
    ' />'
  )
}

function serializeNode(
  node: CanvasNode,
  ctx: SerializeContext,
  indent: string,
): string {
  if (!node.visible) return ''

  switch (node.type) {
    case 'group':
      return serializeGroup(node, ctx, indent)
    case 'rect':
      return serializeRect(node, ctx, indent)
    case 'circle':
      return serializeCircle(node, ctx, indent)
    case 'line':
      return serializeLine(node, ctx, indent)
    case 'path':
      return serializePath(node, ctx, indent)
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

export interface ExportToSVGOptions {
  /**
   * When true, closed nodes whose resolved engraveType is "pocket" are
   * serialized with a solid fill instead of `fill="none"`. The Rust CAM
   * turtle only treats closed subpaths as pocketable fill shapes when the
   * SVG paint includes a real fill, so this is required for the CAM
   * pipeline to actually generate pocket toolpaths for generator output
   * (e.g. tenons/dominos) and other stroke-only closed geometry.
   *
   * Leave false for project save / user-facing exports so the saved SVG
   * round-trips without accidentally marking shapes as filled.
   */
  forcePocketFill?: boolean
}

/**
 * Converts the normalized canvas state into a clean SVG string.
 *
 * - Coordinates are normalized to artboard-relative (0,0 = artboard top-left).
 * - CNC properties are embedded as data-cut-depth / data-engrave-type attributes.
 * - Invisible nodes are omitted.
 */
export function exportToSVG(
  nodesById: Record<string, CanvasNode>,
  rootIds: string[],
  artboard: ArtboardState,
  options: ExportToSVGOptions = {},
): string {
  const { width, height, x: artX, y: artY } = artboard
  const ctx: SerializeContext = { nodesById, forcePocketFill: options.forcePocketFill ?? false }

  const innerIndent = '    '
  const rootContent = rootIds
    .map((id) => {
      const node = nodesById[id]
      if (!node || !node.visible) return ''
      return serializeNode(node, ctx, innerIndent)
    })
    .filter(Boolean)
    .join('\n')

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <!-- Exported by Konva CNC Editor — artboard origin (${artX}, ${artY}) normalized to 0,0 -->`,
    `  <g transform="translate(${-artX} ${-artY})">`,
    rootContent,
    `  </g>`,
    `</svg>`,
  ].join('\n')
}

/**
 * Exports the full project as an SVG with all Engrav metadata embedded as
 * data attributes on the root element, enabling a complete round-trip restore.
 *
 * Embedded attributes:
 *   data-engrav-version       — schema version ("1")
 *   data-engrav-project-name  — project name
 *   data-engrav-artboard      — JSON: { width, height, thickness }
 *   data-engrav-machining     — JSON: full MachiningSettings
 *   data-engrav-material      — material preset ID string
 */
export function exportProjectSVG(
  nodesById: Record<string, CanvasNode>,
  rootIds: string[],
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
  materialPreset: string,
  projectName: string,
): string {
  const { width, height, x: artX, y: artY } = artboard
  // Project save never substitutes fills — we want lossless round-trip.
  const ctx: SerializeContext = { nodesById, forcePocketFill: false }

  const innerIndent = '    '
  const rootContent = rootIds
    .map((id) => {
      const node = nodesById[id]
      if (!node || !node.visible) return ''
      return serializeNode(node, ctx, innerIndent)
    })
    .filter(Boolean)
    .join('\n')

  const artboardJson = JSON.stringify({ width: artboard.width, height: artboard.height, thickness: artboard.thickness })
  const machiningJson = JSON.stringify(machiningSettings)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
    `  data-engrav-version="1"`,
    `  data-engrav-project-name="${esc(projectName)}"`,
    `  data-engrav-artboard="${esc(artboardJson)}"`,
    `  data-engrav-machining="${esc(machiningJson)}"`,
    `  data-engrav-material="${esc(materialPreset)}">`,
    `  <!-- Engrav Studio project file -->`,
    `  <g transform="translate(${-artX} ${-artY})">`,
    rootContent,
    `  </g>`,
    `</svg>`,
  ].join('\n')
}
