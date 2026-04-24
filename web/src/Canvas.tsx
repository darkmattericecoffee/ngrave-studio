import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Circle, Group, Layer, Line, Path, Rect, Stage, Text, Transformer } from 'react-konva'

import PipetteEmptyCursor from './assets/pipette-empty.svg'
import PipetteFilledCursor from './assets/pipette-filled.svg'
import PipetteGlyph from './assets/pipette-glyph.svg'
import { AppIcon, Icons } from './lib/icons'
import { isTypingTarget } from './lib/domEvents'
import { MATERIAL_PRESETS, DEFAULT_MATERIAL } from './lib/materialPresets'
import type { MaterialPreset } from './lib/materialPresets'
import { useImageAsset } from './hooks/useImageAsset'
import {
  getEffectiveFocusGroupId,
  getEffectiveInteractionMode,
  getFocusScopeContainerId,
  getSubtreeIds,
} from './lib/editorTree'
import { resizeGeneratorToBounds, supportsGeneratorResizeBack } from './lib/generators'
import { getNodeSize } from './lib/nodeDimensions'
import { getNodePreviewBounds, type Bounds } from './lib/nodeBounds'
import { ancestorMatrix, computeCutPlan, manualJobsFromComputed, type ComputedJob } from './lib/jobs'
import { getBoundsForNodes, getGuides, getLineGuideStops } from './lib/objectSnapping'
import { getNodeTransformPatch } from './lib/transformUtils'
import { generateCenterlineForNode } from './lib/centerline'
import { LIBRARY_DRAG_MIME, parseLibraryDragPayload } from './lib/libraryItems'
import { EngravePreviewStack, ShapeRenderer } from './ShapeRenderer'
import { EditorContextMenu } from './components/EditorContextMenu'
import { TextEditOverlay } from './components/TextEditOverlay'
import { useCanvasState } from './hooks/useCanvasState'
import { useSelection } from './hooks/useSelection'
import { useEditorStore } from './store'
import type { CanvasNode, CircleNode, GroupNode, LineNode, PathAnchor, PathNode, RectNode, MarqueeRect, ViewportState } from './types/editor'

interface Point {
  x: number
  y: number
}

interface MarqueeHighlight {
  id: string
  rect: MarqueeRect
}

interface CanvasProps {
  allowStageSelection?: boolean
  materialPreset?: MaterialPreset
  onMaterialChange?: (preset: MaterialPreset) => void
  forceEngravePreview?: boolean
  prepareMode?: boolean
}

const GUIDELINE_OFFSET = 5
const GUIDELINE_NAME = 'snap-guideline'
const MIN_ARTBOARD_SIZE = 240
const MAX_ARTBOARD_SIZE = 2000
const MIN_SCALE = 0.25
const MAX_SCALE = 4
const WHEEL_SCALE_BY = 1.02
const PINCH_ZOOM_SENSITIVITY = 0.01
const TRACKPAD_PAN_DELTA_THRESHOLD = 50
const EYEDROPPER_CURSOR_HOTSPOT_X = 3
const EYEDROPPER_CURSOR_HOTSPOT_Y = 16
const EYEDROPPER_PICK_FLASH_MS = 140
const IMPORT_FOCUS_PADDING_PX = 96
const PREPARE_FIT_PADDING_PX = 56

type NodeLiveTransform = { x: number; y: number; rotation: number; scaleX: number; scaleY: number }

function mergeBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function translateBounds(bounds: Bounds, dx: number, dy: number): Bounds {
  return {
    minX: bounds.minX + dx,
    minY: bounds.minY + dy,
    maxX: bounds.maxX + dx,
    maxY: bounds.maxY + dy,
  }
}

function getVisibleCutBounds(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
): Bounds | null {
  let bounds: Bounds | null = null

  for (const rootId of rootIds) {
    const node = nodesById[rootId]
    if (!node || !node.visible) continue

    const baseBounds = getNodePreviewBounds(node, nodesById)
    if (!baseBounds) continue

    const grid = node.gridMetadata
    if (!grid || grid.rows * grid.cols <= 1) {
      bounds = mergeBounds(bounds, baseBounds)
      continue
    }

    const size = getNodeSize(node, nodesById)
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        bounds = mergeBounds(
          bounds,
          translateBounds(
            baseBounds,
            c * (size.width + grid.colGap),
            r * (size.height + grid.rowGap),
          ),
        )
      }
    }
  }

  return bounds
}

function anchorPointFromCanvasBounds(anchor: PathAnchor, bounds: Bounds): Point {
  const midX = (bounds.minX + bounds.maxX) / 2
  const midY = (bounds.minY + bounds.maxY) / 2
  const x = anchor === 'TopLeft' || anchor === 'MiddleLeft' || anchor === 'BottomLeft'
    ? bounds.minX
    : anchor === 'TopRight' || anchor === 'MiddleRight' || anchor === 'BottomRight'
      ? bounds.maxX
      : midX
  const y = anchor === 'TopLeft' || anchor === 'TopCenter' || anchor === 'TopRight'
    ? bounds.minY
    : anchor === 'BottomLeft' || anchor === 'BottomCenter' || anchor === 'BottomRight'
      ? bounds.maxY
      : midY

  return { x, y }
}

function getEffectiveTransform(node: CanvasNode, live: Map<string, NodeLiveTransform>): NodeLiveTransform {
  return live.get(node.id) ?? { x: node.x, y: node.y, rotation: node.rotation ?? 0, scaleX: node.scaleX ?? 1, scaleY: node.scaleY ?? 1 }
}

function renderOutlineNode(
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
  live: Map<string, NodeLiveTransform>,
): React.ReactElement | null {
  const node = nodesById[nodeId]
  if (!node || !node.visible) return null
  const t = getEffectiveTransform(node, live)
  if (node.type === 'group') {
    const g = node as GroupNode
    return (
      <Group key={nodeId} {...t}>
        {g.childIds.map((childId) => renderOutlineNode(childId, nodesById, live))}
      </Group>
    )
  }
  const base = {
    ...t,
    stroke: '#0d99ff',
    strokeWidth: 1,
    strokeScaleEnabled: false,
    fill: '',
    listening: false,
  }
  if (node.type === 'path') return <Path key={nodeId} {...base} data={(node as PathNode).data} />
  if (node.type === 'rect') {
    const n = node as RectNode
    return <Rect key={nodeId} {...base} width={n.width} height={n.height} cornerRadius={n.cornerRadius} />
  }
  if (node.type === 'circle') return <Circle key={nodeId} {...base} radius={(node as CircleNode).radius} />
  if (node.type === 'line') {
    const n = node as LineNode
    return <Line key={nodeId} {...base} points={n.points} closed={n.closed} />
  }
  return null
}

// Renders a node wrapped in its ancestor group transforms so nested nodes
// are positioned correctly regardless of how deep they sit in the hierarchy.
function renderOutlineNodeWithAncestors(
  targetId: string,
  nodesById: Record<string, CanvasNode>,
  live: Map<string, NodeLiveTransform>,
): React.ReactElement | null {
  const chain: string[] = []
  let currentId: string | undefined = targetId
  while (currentId) {
    chain.unshift(currentId)
    const currentNode: CanvasNode | undefined = nodesById[currentId]
    currentId = currentNode?.parentId ?? undefined
  }

  function renderChain(remaining: string[]): React.ReactElement | null {
    if (remaining.length === 0) return null
    const [id, ...rest] = remaining
    const node = nodesById[id]
    if (!node || !node.visible) return null
    const t = getEffectiveTransform(node, live)
    if (rest.length === 0) {
      return renderOutlineNode(id, nodesById, live)
    }
    return <Group key={id} {...t}>{renderChain(rest)}</Group>
  }

  return renderChain(chain)
}

function renderCenterlineOverlayNode(
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
  live: Map<string, NodeLiveTransform>,
  toolDiameter: number,
  centerlinePathRefs: Map<string, Konva.Path>,
): React.ReactElement | null {
  const node = nodesById[nodeId]
  if (!node || !node.visible) return null

  const t = getEffectiveTransform(node, live)

  if (node.centerlineMetadata?.enabled) {
    const result = generateCenterlineForNode(nodeId, nodesById, { toolDiameter })
    const recoveredPathData = result.recoveredDetails?.map((detail) => detail.pathData).join(' ') ?? ''
    const pathData = node.centerlineMetadata.aiSmoothedPathData
      ? [node.centerlineMetadata.aiSmoothedPathData, recoveredPathData].filter(Boolean).join(' ')
      : result.error ? null : result.pathData

    if (!pathData) return null

    return (
      <Group key={`centerline-${nodeId}`} {...t} listening={false}>
        <Path
          ref={(instance) => {
            if (instance) centerlinePathRefs.set(nodeId, instance)
            else centerlinePathRefs.delete(nodeId)
          }}
          data={pathData}
          fill=""
          stroke="#ff2bd6"
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      </Group>
    )
  }

  if (node.type !== 'group') return null

  return (
    <Group key={`centerline-${nodeId}`} {...t} listening={false}>
      {(node as GroupNode).childIds.map((childId) =>
        renderCenterlineOverlayNode(childId, nodesById, live, toolDiameter, centerlinePathRefs),
      )}
    </Group>
  )
}

const isEmptyCanvasTarget = (target: Konva.Node): boolean => {
  const name = target.name?.() ?? ''
  return (
    target.getClassName() === 'Stage' ||
    target.getClassName() === 'Layer' ||
    name.includes('canvas-empty') ||
    name.includes('artboard-base')
  )
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum)

const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale.toFixed(4))))

const normalizeRect = (start: Point, end: Point): MarqueeRect => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
})

const intersects = (a: MarqueeRect, b: MarqueeRect): boolean =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y

const containsPoint = (rect: MarqueeRect, point: Point): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height

const getNodeScreenRect = (node: Konva.Node | null): MarqueeRect | null => {
  if (!node) {
    return null
  }

  const box = node.getClientRect({ skipShadow: true, skipStroke: false })
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  }
}

const scaleViewportFromAnchor = (
  viewport: ViewportState,
  nextScale: number,
  anchor: Point,
): ViewportState => {
  const clampedScale = clampScale(nextScale)
  if (Math.abs(clampedScale - viewport.scale) < 0.0001) {
    return viewport
  }

  const anchorInScene = {
    x: (anchor.x - viewport.x) / viewport.scale,
    y: (anchor.y - viewport.y) / viewport.scale,
  }

  return {
    scale: clampedScale,
    x: anchor.x - anchorInScene.x * clampedScale,
    y: anchor.y - anchorInScene.y * clampedScale,
  }
}

function ToolbarTooltip({
  label,
  shortcuts,
  note,
  children,
}: {
  label: string
  shortcuts?: string[]
  note?: string
  children: React.ReactNode
}) {
  return (
    <div className="group/tt relative">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden min-w-max -translate-x-1/2 flex-col items-center gap-1 rounded-lg border border-white/10 bg-[rgba(19,19,23,0.95)] px-3 py-2 shadow-xl backdrop-blur-xl group-hover/tt:flex">
        <span className="text-xs font-medium text-white/90">{label}</span>
        {shortcuts && shortcuts.length > 0 && (
          <div className="flex items-center gap-1">
            {shortcuts.map((shortcut) => (
              <kbd key={shortcut} className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/70">
                {shortcut}
              </kbd>
            ))}
          </div>
        )}
        {note && <span className="text-[10px] text-white/50">{note}</span>}
      </div>
    </div>
  )
}

export function Canvas({ allowStageSelection = false, materialPreset = DEFAULT_MATERIAL, forceEngravePreview = false, prepareMode = false }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setContainerSize({ width: Math.max(400, width), height: Math.max(300, height) })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const stageSize = containerSize
  const { artboardRect, marquee, nodesById, rootIds } = useCanvasState(containerSize)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const selectedStage = useEditorStore((state) => state.selectedStage)
  const focusGroupId = useEditorStore((state) => state.focusGroupId)
  const interactionMode = useEditorStore((state) => state.interactionMode)
  const directSelectionModifierActive = useEditorStore(
    (state) => state.directSelectionModifierActive,
  )
  const viewport = useEditorStore((state) => state.viewport)
  const pendingImport = useEditorStore((state) => state.ui.pendingImport)
  const importFocusRequest = useEditorStore((state) => state.ui.importFocusRequest)
  const eyedropperMode = useEditorStore((state) => state.eyedropperMode)
  const eyedropperSourceNodeId = useEditorStore((state) => state.eyedropperSourceNodeId)
  const toolDiameter = useEditorStore((state) => state.machiningSettings.toolDiameter)
  const defaultDepthMm = useEditorStore((state) => state.machiningSettings.defaultDepthMm)
  const setViewport = useEditorStore((state) => state.setViewport)
  const clearImportFocusRequest = useEditorStore((state) => state.clearImportFocusRequest)
  const resetViewport = useEditorStore((state) => state.resetViewport)
  const setMarquee = useEditorStore((state) => state.setMarquee)
  const setEyedropperMode = useEditorStore((state) => state.setEyedropperMode)
  const clearSelection = useEditorStore((state) => state.clearSelection)
  const clearFocusGroup = useEditorStore((state) => state.clearFocusGroup)
  const setIsTransforming = useEditorStore((state) => state.setIsTransforming)
  const setArtboardSize = useEditorStore((state) => state.setArtboardSize)
  const updateNodeTransform = useEditorStore((state) => state.updateNodeTransform)
  const updateGeneratorParams = useEditorStore((state) => state.updateGeneratorParams)
  const updateGridMetadata = useEditorStore((state) => state.updateGridMetadata)
  const duplicateInPlace = useEditorStore((state) => state.duplicateInPlace)
  const pushHistory = useEditorStore((state) => state.pushHistory)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)
  const canUndo = useEditorStore((state) => state.history.past.length > 0)
  const canRedo = useEditorStore((state) => state.history.future.length > 0)
  const placePendingImport = useEditorStore((state) => state.placePendingImport)
  const placeGenerator = useEditorStore((state) => state.placeGenerator)
  const placeShape = useEditorStore((state) => state.placeShape)
  const setInteractionMode = useEditorStore((state) => state.setInteractionMode)
  const aiSmoothStreamingIds = useEditorStore((state) => state.aiSmoothStreamingIds)
  const { getMarqueeCandidateIds, selectMany, selectStage, selectableIds } = useSelection()
  const stageRef = useRef<Konva.Stage | null>(null)
  const artboardRef = useRef<Konva.Rect | null>(null)
  const guideLayerRef = useRef<Konva.Layer | null>(null)
  const transformerRef = useRef<Konva.Transformer | null>(null)
  const artboardTargetRef = useRef<Konva.Rect | null>(null)
  const nodeRefs = useRef(new Map<string, Konva.Node>())
  const centerlinePathRefs = useRef(new Map<string, Konva.Path>())
  const dragStartPositions = useRef<Record<string, { x: number; y: number }>>({})
  const prepareJobDragRef = useRef<{
    jobId: string
    startX: number
    startY: number
    positions: Record<string, { x: number; y: number }>
  } | null>(null)
  const gapDragRef = useRef<
    | { kind: 'grid'; startPointerX: number; startPointerY: number; startGap: number; axis: 'col' | 'row'; nodeId: string }
    | { kind: 'generator'; startPointerX: number; startPointerY: number; startSpacing: number; axis: 'col' | 'row'; nodeId: string; minSpacing: number }
    | null
  >(null)
  const isAltKeyDownRef = useRef(false)
  const isDuplicateDragRef = useRef(false)
  const marqueeStartRef = useRef<Point | null>(null)
  const marqueeRectRef = useRef<MarqueeRect | null>(null)
  const didMarqueeDragRef = useRef(false)
  const justFinishedMarqueeRef = useRef(false)
  const justFinishedPanRef = useRef(false)
  const panPointerRef = useRef<Point | null>(null)
  const panResetTimeoutRef = useRef<number | null>(null)
  const isPanningRef = useRef(false)
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [panToolActive, setPanToolActive] = useState(false)
  const [showOutlines, setShowOutlines] = useState(true)
  const showEngravePreview = forceEngravePreview
  const [isZoomEditing, setIsZoomEditing] = useState(false)
  const [zoomDraft, setZoomDraft] = useState('')
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [eyedropperCursorFlashFilled, setEyedropperCursorFlashFilled] = useState(false)
  const [transformTick, setTransformTick] = useState(0)
  const [contextMenu, setContextMenu] = useState({ isOpen: false, x: 0, y: 0 })
  const zoomInputRef = useRef<HTMLInputElement | null>(null)
  const presetDef = MATERIAL_PRESETS.find((p) => p.id === materialPreset) ?? MATERIAL_PRESETS[0]
  const woodTexture = useImageAsset(presetDef.textureSrc)
  const effectiveFocusGroupId = getEffectiveFocusGroupId(
    focusGroupId,
    interactionMode,
    directSelectionModifierActive,
  )
  const focusScopeContainerId = getFocusScopeContainerId(effectiveFocusGroupId, nodesById)

  const interactionBlocked = isSpacePressed || isPanning || panToolActive
  const zoomPercent = Math.round(viewport.scale * 100)

  const registerNodeRef = useCallback((nodeId: string, node: Konva.Node | null) => {
    if (node) {
      nodeRefs.current.set(nodeId, node)
      return
    }

    nodeRefs.current.delete(nodeId)
  }, [])
  const noopRegisterNodeRef = useCallback(() => {}, [])

  const getContextMenuTargetId = (target: Konva.Node): string | null => {
    if (isEmptyCanvasTarget(target)) {
      return null
    }

    let current: Konva.Node | null = target
    while (current) {
      const id = current.id()
      if (id && selectableIds.includes(id)) {
        return id
      }
      current = current.parent
    }

    return null
  }

  const clearSnapGuides = useCallback(() => {
    const guideLayer = guideLayerRef.current
    if (!guideLayer) {
      return
    }

    guideLayer.find(`.${GUIDELINE_NAME}`).forEach((line) => line.destroy())
    guideLayer.batchDraw()
  }, [])

  const getMarqueeHitHighlights = useCallback(
    (currentMarquee: MarqueeRect): MarqueeHighlight[] => {
      // Direct selection targets strokes — treat shapes whose AABB fully
      // encloses the marquee as non-hits (the marquee sat inside the fill
      // without crossing any edge). Group mode keeps the simple AABB overlap.
      const strict = getEffectiveInteractionMode(interactionMode, directSelectionModifierActive) === 'direct'
      return getMarqueeCandidateIds().flatMap((nodeId) => {
        const node = nodeRefs.current.get(nodeId)
        if (!node || !node.isVisible()) {
          return []
        }

        const rect = getNodeScreenRect(node)
        if (!rect || !intersects(currentMarquee, rect)) {
          return []
        }

        if (strict) {
          const shapeContainsMarquee =
            rect.x <= currentMarquee.x &&
            rect.y <= currentMarquee.y &&
            rect.x + rect.width >= currentMarquee.x + currentMarquee.width &&
            rect.y + rect.height >= currentMarquee.y + currentMarquee.height
          if (shapeContainsMarquee) return []
        }

        return [{ id: nodeId, rect }]
      })
    },
    [getMarqueeCandidateIds, interactionMode, directSelectionModifierActive],
  )

  const [marqueeHighlights, setMarqueeHighlights] = useState<MarqueeHighlight[]>([])

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      setMarqueeHighlights(marquee ? getMarqueeHitHighlights(marquee) : [])
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [getMarqueeHitHighlights, marquee])

  // Breathing animation on centerline overlay paths while AI is streaming
  useEffect(() => {
    if (aiSmoothStreamingIds.length === 0) return

    const savedOpacities = new Map<string, number>()
    for (const id of aiSmoothStreamingIds) {
      const p = centerlinePathRefs.current.get(id)
      if (p) savedOpacities.set(id, p.opacity())
    }

    const startTime = performance.now()
    let rafId = 0

    const animate = () => {
      const elapsed = performance.now() - startTime
      const alpha = 0.3 + 0.7 * Math.abs(Math.sin(elapsed * 0.0025))
      for (const id of aiSmoothStreamingIds) {
        const p = centerlinePathRefs.current.get(id)
        if (p) {
          p.opacity(alpha)
          p.getLayer()?.batchDraw()
        }
      }
      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(rafId)
      for (const id of aiSmoothStreamingIds) {
        const p = centerlinePathRefs.current.get(id)
        if (p) {
          p.opacity(savedOpacities.get(id) ?? 1)
          p.getLayer()?.batchDraw()
        }
      }
    }
  }, [aiSmoothStreamingIds])

  const queuePanClickSuppressionReset = () => {
    if (panResetTimeoutRef.current !== null) {
      window.clearTimeout(panResetTimeoutRef.current)
    }

    panResetTimeoutRef.current = window.setTimeout(() => {
      justFinishedPanRef.current = false
      panResetTimeoutRef.current = null
    }, 0)
  }

  const drawSnapGuides = useCallback(
    (
      guides: ReturnType<typeof getGuides>,
      scopeRect: MarqueeRect,
    ) => {
      const guideLayer = guideLayerRef.current
      if (!guideLayer) {
        return
      }

      clearSnapGuides()

      guides.forEach((guide) => {
        const line =
          guide.orientation === 'H'
            ? new Konva.Line({
                points: [
                  scopeRect.x,
                  guide.lineGuide,
                  scopeRect.x + scopeRect.width,
                  guide.lineGuide,
                ],
                stroke: 'rgb(0, 161, 255)',
                strokeWidth: 1,
                name: GUIDELINE_NAME,
                dash: [4, 6],
                listening: false,
              })
            : new Konva.Line({
                points: [
                  guide.lineGuide,
                  scopeRect.y,
                  guide.lineGuide,
                  scopeRect.y + scopeRect.height,
                ],
                stroke: 'rgb(0, 161, 255)',
                strokeWidth: 1,
                name: GUIDELINE_NAME,
                dash: [4, 6],
                listening: false,
              })

        guideLayer.add(line)
      })

      guideLayer.batchDraw()
    },
    [clearSnapGuides],
  )

  const screenToScene = (point: Point): Point => ({
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  })

  const zoomAroundPoint = (nextScale: number, anchor: Point) => {
    const currentViewport = useEditorStore.getState().viewport
    const nextViewport = scaleViewportFromAnchor(currentViewport, nextScale, anchor)
    if (
      nextViewport.scale === currentViewport.scale &&
      nextViewport.x === currentViewport.x &&
      nextViewport.y === currentViewport.y
    ) {
      return
    }

    setViewport(nextViewport)
  }

  const fitViewportToArtboard = useCallback((paddingPx = IMPORT_FOCUS_PADDING_PX) => {
    const availableWidth = Math.max(1, stageSize.width - paddingPx * 2)
    const availableHeight = Math.max(1, stageSize.height - paddingPx * 2)
    const fitScale = clampScale(Math.min(
      MAX_SCALE,
      availableWidth / Math.max(1, artboardRect.width),
      availableHeight / Math.max(1, artboardRect.height),
    ))
    const center = {
      x: artboardRect.x + artboardRect.width / 2,
      y: artboardRect.y + artboardRect.height / 2,
    }

    setViewport({
      scale: fitScale,
      x: stageSize.width / 2 - center.x * fitScale,
      y: stageSize.height / 2 - center.y * fitScale,
    })
  }, [artboardRect.height, artboardRect.width, artboardRect.x, artboardRect.y, setViewport, stageSize.height, stageSize.width])

  useEffect(() => {
    if (!prepareMode) return
    fitViewportToArtboard(PREPARE_FIT_PADDING_PX)
  }, [fitViewportToArtboard, prepareMode])

  useEffect(() => {
    if (!importFocusRequest) {
      return
    }

    const currentViewport = useEditorStore.getState().viewport
    const sceneRect = {
      x: artboardRect.x + importFocusRequest.rect.x,
      y: artboardRect.y + importFocusRequest.rect.y,
      width: Math.max(1, importFocusRequest.rect.width),
      height: Math.max(1, importFocusRequest.rect.height),
    }
    const availableWidth = Math.max(1, stageSize.width - IMPORT_FOCUS_PADDING_PX * 2)
    const availableHeight = Math.max(1, stageSize.height - IMPORT_FOCUS_PADDING_PX * 2)
    const fitScale = Math.min(
      MAX_SCALE,
      availableWidth / sceneRect.width,
      availableHeight / sceneRect.height,
    )
    const nextScale = clampScale(Math.min(currentViewport.scale, fitScale))
    const center = {
      x: sceneRect.x + sceneRect.width / 2,
      y: sceneRect.y + sceneRect.height / 2,
    }

    setViewport({
      scale: nextScale,
      x: stageSize.width / 2 - center.x * nextScale,
      y: stageSize.height / 2 - center.y * nextScale,
    })
    clearImportFocusRequest(importFocusRequest.requestId)
  }, [artboardRect, clearImportFocusRequest, importFocusRequest, setViewport, stageSize.height, stageSize.width])

  const startPan = (event: MouseEvent) => {
    event.preventDefault()
    isPanningRef.current = true
    setIsPanning(true)
    justFinishedPanRef.current = false
    panPointerRef.current = { x: event.clientX, y: event.clientY }
    marqueeStartRef.current = null
    marqueeRectRef.current = null
    didMarqueeDragRef.current = false
    setMarquee(null)
  }

  // When generator params change, the group's children get new IDs. Track this
  // so the transformer recalculates its bounding box.
  const selectedChildKey = useMemo(() => {
    return selectedIds.map((id) => {
      const node = nodesById[id]
      return node?.type === 'group' ? (node as import('./types/editor').GroupNode).childIds.join(',') : ''
    }).join('|')
  }, [selectedIds, nodesById])

  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) {
      return
    }

    const artboardTarget = artboardTargetRef.current
    const nodes =
      selectedStage && allowStageSelection && artboardTarget
        ? [artboardTarget]
        : selectedIds
            .map((id) => nodeRefs.current.get(id))
            .filter((node): node is Konva.Node => Boolean(node))

    transformer.nodes(nodes)
    transformer.getLayer()?.batchDraw()
  }, [allowStageSelection, selectedIds, selectedStage, selectedChildKey, showEngravePreview])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        isAltKeyDownRef.current = true
      }

      if (event.code !== 'Space' || isTypingTarget(event.target)) {
        return
      }

      event.preventDefault()
      setIsSpacePressed(true)
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        isAltKeyDownRef.current = false
      }

      if (event.code !== 'Space') {
        return
      }

      setIsSpacePressed(false)
    }

    const onBlur = () => {
      isAltKeyDownRef.current = false
      setIsSpacePressed(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    const stopPan = () => {
      if (!isPanningRef.current) {
        return
      }

      isPanningRef.current = false
      setIsPanning(false)
      panPointerRef.current = null
      justFinishedPanRef.current = true
      queuePanClickSuppressionReset()
    }

    const onMouseMove = (event: MouseEvent) => {
      if (!isPanningRef.current) {
        return
      }

      event.preventDefault()

      const lastPointer = panPointerRef.current
      if (!lastPointer) {
        panPointerRef.current = { x: event.clientX, y: event.clientY }
        return
      }

      const dx = event.clientX - lastPointer.x
      const dy = event.clientY - lastPointer.y

      if (dx === 0 && dy === 0) {
        return
      }

      panPointerRef.current = { x: event.clientX, y: event.clientY }
      const currentViewport = useEditorStore.getState().viewport
      setViewport({
        x: currentViewport.x + dx,
        y: currentViewport.y + dy,
      })
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', stopPan)
    window.addEventListener('blur', stopPan)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopPan)
      window.removeEventListener('blur', stopPan)
      if (panResetTimeoutRef.current !== null) {
        window.clearTimeout(panResetTimeoutRef.current)
      }
    }
  }, [setViewport])

  const getFocusScopeRect = useCallback((): MarqueeRect => {
    const artboardScopeRect = getNodeScreenRect(artboardRef.current) ?? artboardRect
    if (!effectiveFocusGroupId || !focusScopeContainerId) {
      return artboardScopeRect
    }

    return getNodeScreenRect(nodeRefs.current.get(focusScopeContainerId) ?? null) ?? artboardScopeRect
  }, [artboardRect, effectiveFocusGroupId, focusScopeContainerId])

  const applyObjectSnapping = useCallback(
    (nodeId: string) => {
      const movingIds = selectedIds.includes(nodeId) ? selectedIds : [nodeId]
      const movingNodes = movingIds
        .map((id) => nodeRefs.current.get(id))
        .filter((node): node is Konva.Node => Boolean(node))

      if (movingNodes.length === 0) {
        clearSnapGuides()
        return
      }

      const movingBounds = getBoundsForNodes(movingNodes)
      if (!movingBounds) {
        clearSnapGuides()
        return
      }

      const excludedIds = new Set(movingIds.flatMap((id) => getSubtreeIds(id, nodesById)))
      const guideNodes = selectableIds
        .filter((id) => !excludedIds.has(id))
        .map((id) => nodeRefs.current.get(id))
        .filter((node): node is Konva.Node => node != null)
        .filter((node) => node.isVisible())

      const scopeRect = getFocusScopeRect()
      const guides = getGuides(
        getLineGuideStops(scopeRect, guideNodes),
        movingBounds,
        GUIDELINE_OFFSET,
      )

      if (guides.length === 0) {
        clearSnapGuides()
        return
      }

      const delta = guides.reduce(
        (result, guide) => ({
          x: guide.orientation === 'V' ? guide.delta : result.x,
          y: guide.orientation === 'H' ? guide.delta : result.y,
        }),
        { x: 0, y: 0 },
      )

      movingNodes.forEach((node) => {
        const absolutePosition = node.absolutePosition()
        node.absolutePosition({
          x: absolutePosition.x + delta.x,
          y: absolutePosition.y + delta.y,
        })
      })

      drawSnapGuides(guides, scopeRect)
    },
    [
      clearSnapGuides,
      drawSnapGuides,
      getFocusScopeRect,
      nodesById,
      selectableIds,
      selectedIds,
    ],
  )

  const syncArtboardTargetToState = (artboardTarget: Konva.Rect) => {
    const width = clamp(
      Math.round(artboardTarget.width() * artboardTarget.scaleX()),
      MIN_ARTBOARD_SIZE,
      MAX_ARTBOARD_SIZE,
    )
    const height = clamp(
      Math.round(artboardTarget.height() * artboardTarget.scaleY()),
      MIN_ARTBOARD_SIZE,
      MAX_ARTBOARD_SIZE,
    )
    const x = Math.round(artboardTarget.x())
    const y = Math.round(artboardTarget.y())

    artboardTarget.width(width)
    artboardTarget.height(height)
    artboardTarget.scaleX(1)
    artboardTarget.scaleY(1)

    setArtboardSize({
      width,
      height,
      x: x - Math.round((stageSize.width - width) / 2),
      y: y - Math.round((stageSize.height - height) / 2),
    })
  }

  const handleNodeDragStart = useCallback((nodeId: string) => {
    const ids = selectedIds.includes(nodeId) ? selectedIds : [nodeId]
    const positions: Record<string, { x: number; y: number }> = {}
    ids.forEach((id) => {
      const node = nodeRefs.current.get(id)
      if (node) {
        positions[id] = { x: node.x(), y: node.y() }
      }
    })
    dragStartPositions.current = positions
    pushHistory()
    if (!isDuplicateDragRef.current) {
      isDuplicateDragRef.current = isAltKeyDownRef.current
      if (isDuplicateDragRef.current) {
        duplicateInPlace()
      }
    }
    clearSnapGuides()
  }, [clearSnapGuides, duplicateInPlace, pushHistory, selectedIds])

  const handleNodeDragMove = useCallback((nodeId: string, konvaNode: Konva.Node) => {
    if (selectedIds.length > 1) {
      const startPos = dragStartPositions.current[nodeId]
      if (!startPos) {
        return
      }

      const dx = konvaNode.x() - startPos.x
      const dy = konvaNode.y() - startPos.y

      selectedIds.forEach((id) => {
        if (id === nodeId) {
          return
        }

        const otherNode = nodeRefs.current.get(id)
        const otherStart = dragStartPositions.current[id]
        if (otherNode && otherStart) {
          otherNode.x(otherStart.x + dx)
          otherNode.y(otherStart.y + dy)
          updateNodeTransform(id, { x: otherStart.x + dx, y: otherStart.y + dy })
        }
      })
    }

    applyObjectSnapping(nodeId)
    updateNodeTransform(nodeId, { x: konvaNode.x(), y: konvaNode.y() })
  }, [applyObjectSnapping, selectedIds, updateNodeTransform])

  const handleNodeDragEnd = useCallback((nodeId: string, konvaNode: Konva.Node) => {
    clearSnapGuides()
    isDuplicateDragRef.current = false

    if (selectedIds.length <= 1) {
      updateNodeTransform(nodeId, { x: konvaNode.x(), y: konvaNode.y() })
    } else {
      selectedIds.forEach((id) => {
        const node = nodeRefs.current.get(id)
        if (node) {
          updateNodeTransform(id, { x: node.x(), y: node.y() })
        }
      })
    }

    dragStartPositions.current = {}
  }, [clearSnapGuides, selectedIds, updateNodeTransform])

  const handlePrepareJobDragStart = useCallback((job: ComputedJob, konvaNode: Konva.Node) => {
    if (!prepareMode) return
    const positions: Record<string, { x: number; y: number }> = {}
    for (const nodeId of job.nodeIds) {
      const node = nodesById[nodeId]
      if (node) positions[nodeId] = { x: node.x, y: node.y }
    }
    if (Object.keys(positions).length === 0) return

    pushHistory()
    const state = useEditorStore.getState()
    if (!state.machiningSettings.manualJobs) {
      const { jobs } = computeCutPlan(rootIds, nodesById, state.machiningSettings, state.artboard)
      state.commitManualJobs(manualJobsFromComputed(jobs))
    }
    state.setSelectedJob(job.id)
    prepareJobDragRef.current = {
      jobId: job.id,
      startX: konvaNode.x(),
      startY: konvaNode.y(),
      positions,
    }
  }, [nodesById, prepareMode, pushHistory, rootIds])

  const handlePrepareJobDragMove = useCallback((jobId: string, konvaNode: Konva.Node) => {
    const drag = prepareJobDragRef.current
    if (!drag || drag.jobId !== jobId) return
    const dx = konvaNode.x() - drag.startX
    const dy = konvaNode.y() - drag.startY
    for (const [nodeId, start] of Object.entries(drag.positions)) {
      updateNodeTransform(nodeId, { x: start.x + dx, y: start.y + dy })
    }
  }, [updateNodeTransform])

  const handlePrepareJobDragEnd = useCallback((jobId: string, konvaNode: Konva.Node) => {
    handlePrepareJobDragMove(jobId, konvaNode)
    prepareJobDragRef.current = null
  }, [handlePrepareJobDragMove])

  const finishMarqueeSelection = (additive: boolean) => {
    const currentMarquee = marqueeRectRef.current
    if (!currentMarquee || currentMarquee.width < 3 || currentMarquee.height < 3) {
      marqueeRectRef.current = null
      setMarquee(null)
      marqueeStartRef.current = null
      didMarqueeDragRef.current = false
      return
    }

    const hits = getMarqueeHitHighlights(currentMarquee).map(({ id }) => id)

    if (hits.length === 0 && !additive) {
      clearSelection()
    } else if (additive) {
      selectMany(Array.from(new Set([...selectedIds, ...hits])))
    } else {
      selectMany(hits)
    }

    justFinishedMarqueeRef.current = true
    marqueeRectRef.current = null
    setMarquee(null)
    marqueeStartRef.current = null
    didMarqueeDragRef.current = false
  }

  const onPointerDown = (event: KonvaEventObject<MouseEvent>) => {
    if (event.evt.button === 1 || (event.evt.button === 0 && (isSpacePressed || panToolActive))) {
      startPan(event.evt)
      return
    }

    const stage = stageRef.current
    if (
      interactionBlocked ||
      !stage ||
      event.evt.button !== 0 ||
      pendingImport ||
      !isEmptyCanvasTarget(event.target)
    ) {
      return
    }

    if (eyedropperMode !== 'off') {
      setEyedropperMode('off')
      return
    }

    const position = stage.getPointerPosition()
    if (!position) {
      return
    }

    marqueeStartRef.current = position
    marqueeRectRef.current = { x: position.x, y: position.y, width: 0, height: 0 }
    didMarqueeDragRef.current = false
    setMarquee({ x: position.x, y: position.y, width: 0, height: 0 })
  }

  const onPointerMove = () => {
    const stage = stageRef.current
    if (!stage || pendingImport) {
      return
    }

    // Gap handle dragging — takes priority over everything else
    if (gapDragRef.current) {
      const pos = stage.getPointerPosition()
      if (pos) {
        const drag = gapDragRef.current
        if (drag.kind === 'grid') {
          const { startPointerX, startPointerY, startGap, axis, nodeId } = drag
          if (axis === 'col') {
            const dx = pos.x - startPointerX
            updateGridMetadata(nodeId, { colGap: Math.max(0, startGap + dx / viewport.scale) })
          } else {
            const dy = pos.y - startPointerY
            updateGridMetadata(nodeId, { rowGap: Math.max(0, startGap + dy / viewport.scale) })
          }
        } else if (drag.kind === 'generator') {
          const { startPointerX, startPointerY, startSpacing, axis, nodeId, minSpacing } = drag
          const genNode = nodesById[nodeId]
          if (genNode?.type === 'group' && (genNode as GroupNode).generatorMetadata) {
            const params = (genNode as GroupNode).generatorMetadata!.params
            if ('colSpacing' in params) {
              if (axis === 'col') {
                const dx = pos.x - startPointerX
                const newSpacing = Math.max(minSpacing, startSpacing + dx / viewport.scale)
                updateGeneratorParams(nodeId, { ...params, colSpacing: newSpacing }, { skipHistory: true })
              } else {
                const dy = pos.y - startPointerY
                const newSpacing = Math.max(minSpacing, startSpacing + dy / viewport.scale)
                updateGeneratorParams(nodeId, { ...params, rowSpacing: newSpacing }, { skipHistory: true })
              }
            }
          }
        }
      }
      return
    }

    // Hover detection when not dragging a marquee
    if (!marqueeStartRef.current && !interactionBlocked) {
      const pos = stage.getPointerPosition()
      if (pos) {
        const activeMode = prepareMode
          ? 'direct'
          : getEffectiveInteractionMode(interactionMode, directSelectionModifierActive)

        if (activeMode === 'direct' || eyedropperMode !== 'off') {
          // In direct selection mode, sample ALL shapes at cursor position
          // so inner paths aren't occluded by filled closed shapes above them
          const allShapes = stage.getAllIntersections(pos)
          const candidates: string[] = []
          for (const shape of allShapes) {
            if (isEmptyCanvasTarget(shape)) continue
            let current: Konva.Node | null = shape
            while (current) {
              const id = current.id()
              if (id && selectableIds.includes(id)) {
                if (!candidates.includes(id)) candidates.push(id)
                break
              }
              current = current.parent
            }
          }

          // Pick the candidate with the smallest bounding area (prefers inner paths)
          let bestId: string | null = null
          let bestArea = Infinity
          for (const id of candidates) {
            if (selectedIds.includes(id)) continue
            const ref = nodeRefs.current.get(id)
            if (ref) {
              const rect = ref.getClientRect()
              const area = rect.width * rect.height
              if (area < bestArea) {
                bestArea = area
                bestId = id
              }
            }
          }
          setHoveredNodeId(bestId)
        } else {
          // Group mode: use single topmost intersection (existing behavior)
          const shape = stage.getIntersection(pos)
          if (!shape || isEmptyCanvasTarget(shape)) {
            setHoveredNodeId(null)
          } else {
            let current: Konva.Node | null = shape
            let foundId: string | null = null
            while (current) {
              const id = current.id()
              if (id && selectableIds.includes(id)) {
                foundId = id
                break
              }
              current = current.parent
            }
            setHoveredNodeId(foundId && !selectedIds.includes(foundId) ? foundId : null)
          }
        }
      }
    }

    if (!marqueeStartRef.current || interactionBlocked) {
      return
    }

    const position = stage.getPointerPosition()
    if (!position) {
      return
    }

    const newMarquee = normalizeRect(marqueeStartRef.current, position)
    marqueeRectRef.current = newMarquee
    setMarquee(newMarquee)
    didMarqueeDragRef.current = true
  }

  const onPointerUp = (event: KonvaEventObject<MouseEvent>) => {
    // End gap handle drag
    if (gapDragRef.current) {
      gapDragRef.current = null
      pushHistory()
      return
    }

    if (pendingImport || !marqueeStartRef.current) {
      return
    }

    const additive = event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey
    if (!didMarqueeDragRef.current) {
      setMarquee(null)
      marqueeStartRef.current = null
      if (!additive) {
        clearSelection()
      }
      return
    }

    finishMarqueeSelection(additive)
  }

  const onStageClick = (event: KonvaEventObject<MouseEvent>) => {
    if (justFinishedPanRef.current) {
      return
    }

    const stage = stageRef.current
    const position = stage?.getPointerPosition()

    if (pendingImport) {
      if (!position) {
        return
      }

      const scenePosition = screenToScene(position)
      if (!containsPoint(artboardRect, scenePosition)) {
        return
      }

      const minX = artboardRect.x
      const maxX = artboardRect.x + artboardRect.width - pendingImport.width
      const minY = artboardRect.y
      const maxY = artboardRect.y + artboardRect.height - pendingImport.height

      placePendingImport({
        x: clamp(scenePosition.x - pendingImport.width / 2, minX, Math.max(minX, maxX)),
        y: clamp(scenePosition.y - pendingImport.height / 2, minY, Math.max(minY, maxY)),
      })
      return
    }

    if (interactionBlocked || !isEmptyCanvasTarget(event.target)) {
      return
    }

    if (justFinishedMarqueeRef.current) {
      justFinishedMarqueeRef.current = false
      return
    }

    const additiveSelectionPressed =
      event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey

    if (effectiveFocusGroupId) {
      if (!position || !containsPoint(getFocusScopeRect(), position)) {
        clearFocusGroup()
        if (allowStageSelection && !additiveSelectionPressed) {
          selectStage()
        }
        return
      }

      if (!additiveSelectionPressed && !marqueeStartRef.current) {
        clearSelection()
      }

      return
    }

    if (!additiveSelectionPressed && !marqueeStartRef.current) {
      if (allowStageSelection) {
        selectStage()
      } else {
        clearSelection()
      }
    }
  }

  const onContextMenu = (event: KonvaEventObject<PointerEvent>) => {
    event.evt.preventDefault()

    if (pendingImport || interactionBlocked) {
      return
    }

    const targetId = getContextMenuTargetId(event.target)
    if (targetId && !selectedIds.includes(targetId)) {
      selectMany([targetId])
    }

    setContextMenu({
      isOpen: true,
      x: event.evt.clientX,
      y: event.evt.clientY,
    })
  }

  const handleLibraryDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(LIBRARY_DRAG_MIME)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleLibraryDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const rawPayload = event.dataTransfer.getData(LIBRARY_DRAG_MIME)
    if (!rawPayload) {
      return
    }

    const payload = parseLibraryDragPayload(rawPayload)
    if (!payload) {
      return
    }

    event.preventDefault()

    const container = containerRef.current
    if (!container) {
      return
    }

    const bounds = container.getBoundingClientRect()
    const scenePosition = screenToScene({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    })

    if (!containsPoint(artboardRect, scenePosition)) {
      return
    }

    const artboardPosition = {
      x: scenePosition.x - artboardRect.x,
      y: scenePosition.y - artboardRect.y,
    }

    if (payload.itemType === 'generator') {
      placeGenerator(payload.params, artboardPosition)
      return
    }

    placeShape(payload.kind, artboardPosition)
  }

  const onTransformStart = () => {
    pushHistory()
    clearSnapGuides()
    setIsTransforming(true)
  }

  const onTransformEnd = () => {
    setTransformTick(0)

    if (selectedStage && allowStageSelection) {
      const artboardTarget = artboardTargetRef.current
      if (artboardTarget) {
        syncArtboardTargetToState(artboardTarget)
      }

      setIsTransforming(false)
      return
    }

    selectedIds.forEach((nodeId) => {
      const node = nodeRefs.current.get(nodeId)
      if (!node) {
        return
      }

      const nodeDefinition = nodesById[nodeId]
      if (!nodeDefinition) {
        return
      }

      if (nodeDefinition.type === 'group' && nodeDefinition.generatorMetadata) {
        const params = nodeDefinition.generatorMetadata.params
        if (supportsGeneratorResizeBack(params)) {
          const nodeSize = getNodeSize(nodeDefinition, nodesById)
          const requestedWidth = Math.max(1, nodeSize.width * Math.abs(node.scaleX()))
          const requestedHeight = Math.max(1, nodeSize.height * Math.abs(node.scaleY()))

          node.scaleX(1)
          node.scaleY(1)

          updateGeneratorParams(
            nodeId,
            resizeGeneratorToBounds(params, requestedWidth, requestedHeight),
            {
              skipHistory: true,
              groupPatch: {
                x: node.x(),
                y: node.y(),
                rotation: node.rotation(),
                scaleX: 1,
                scaleY: 1,
              },
            },
          )
          return
        }
      }

      updateNodeTransform(nodeId, getNodeTransformPatch(nodeDefinition, node))

      if (nodeDefinition.type !== 'group') {
        node.scaleX(1)
        node.scaleY(1)
      }
    })

    setIsTransforming(false)
  }

  const handleWheel = (event: KonvaEventObject<WheelEvent>) => {
    if (isPanningRef.current) {
      return
    }

    event.evt.preventDefault()

    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) {
      return
    }

    const currentViewport = useEditorStore.getState().viewport
    const { deltaX, deltaY, ctrlKey } = event.evt

    if (ctrlKey) {
      // Trackpad pinch gesture (browsers synthesize ctrlKey for pinch).
      const factor = Math.exp(-deltaY * PINCH_ZOOM_SENSITIVITY)
      zoomAroundPoint(currentViewport.scale * factor, pointer)
      return
    }

    const isTrackpadPan =
      deltaX !== 0 ||
      !Number.isInteger(deltaY) ||
      Math.abs(deltaY) < TRACKPAD_PAN_DELTA_THRESHOLD

    if (isTrackpadPan) {
      setViewport({
        x: currentViewport.x - deltaX,
        y: currentViewport.y - deltaY,
      })
      return
    }

    const zoomDirection = deltaY > 0 ? -1 : 1
    const nextScale =
      zoomDirection > 0
        ? currentViewport.scale * WHEEL_SCALE_BY
        : currentViewport.scale / WHEEL_SCALE_BY

    zoomAroundPoint(nextScale, pointer)
  }

  const beginZoomEdit = () => {
    setZoomDraft(String(Math.round(viewport.scale * 100)))
    setIsZoomEditing(true)
  }

  const cancelZoomEdit = () => {
    setIsZoomEditing(false)
    setZoomDraft('')
  }

  const applyZoomDraft = () => {
    const normalized = zoomDraft.replace(',', '.').trim()
    if (!normalized) {
      cancelZoomEdit()
      return
    }
    const parsed = parseFloat(normalized)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      cancelZoomEdit()
      return
    }
    zoomAroundPoint(parsed / 100, { x: stageSize.width / 2, y: stageSize.height / 2 })
    setIsZoomEditing(false)
    setZoomDraft('')
  }

  useEffect(() => {
    if (isZoomEditing) {
      zoomInputRef.current?.select()
    }
  }, [isZoomEditing])

  useEffect(() => {
    if (eyedropperMode !== 'off' && !eyedropperSourceNodeId) {
      setEyedropperCursorFlashFilled(false)
    }
  }, [eyedropperMode, eyedropperSourceNodeId])

  useEffect(() => {
    const flashFilledCursor = () => {
      setEyedropperCursorFlashFilled(true)
      window.setTimeout(() => {
        setEyedropperCursorFlashFilled(false)
      }, EYEDROPPER_PICK_FLASH_MS)
    }

    window.addEventListener('editor-eyedropper-pick', flashFilledCursor)
    return () => {
      window.removeEventListener('editor-eyedropper-pick', flashFilledCursor)
    }
  }, [])

  const effectiveInteractionMode = prepareMode
    ? 'direct'
    : getEffectiveInteractionMode(interactionMode, directSelectionModifierActive)


  const selectionBoundingRect = (() => {
    if (selectedIds.length === 0 || selectedStage) return null
    const rects = selectedIds.flatMap((id) => {
      const n = nodeRefs.current.get(id)
      const r = n ? getNodeScreenRect(n) : null
      return r ? [r] : []
    })
    if (rects.length === 0) return null
    const minX = Math.min(...rects.map((r) => r.x))
    const minY = Math.min(...rects.map((r) => r.y))
    const maxX = Math.max(...rects.map((r) => r.x + r.width))
    const maxY = Math.max(...rects.map((r) => r.y + r.height))
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  })()

  const panelHoveredId = useEditorStore((s) => s.hoveredId)
  const setStoreHoveredId = useEditorStore((s) => s.setHoveredId)
  useEffect(() => {
    if (!prepareMode) return
    setStoreHoveredId(hoveredNodeId)
    return () => setStoreHoveredId(null)
  }, [hoveredNodeId, prepareMode, setStoreHoveredId])
  const hoveredPathAnchor = useEditorStore((s) => s.hoveredPathAnchor)
  const hoveredPathAnchorPreview = useMemo(() => {
    if (!hoveredPathAnchor) return null

    const bounds = getVisibleCutBounds(rootIds, nodesById)
    if (!bounds) return null

    return {
      bounds,
      point: anchorPointFromCanvasBounds(hoveredPathAnchor, bounds),
    }
  }, [hoveredPathAnchor, nodesById, rootIds])

  const jobsEnabled = useEditorStore((s) => s.machiningSettings.jobsEnabled)
  const machiningSettings = useEditorStore((s) => s.machiningSettings)
  const storeArtboard = useEditorStore((s) => s.artboard)
  const selectedJobId = useEditorStore((s) => s.selectedJobId)
  const setSelectedJob = useEditorStore((s) => s.setSelectedJob)
  const layerPanelView = useEditorStore((s) => s.layerPanelView)
  const prepareShowCutNumbers = useEditorStore((s) => s.prepareShowCutNumbers)
  const prepareJobPlayback = useEditorStore((s) => s.prepareJobPlayback)
  const computedJobs = useMemo<ComputedJob[]>(() => {
    if (!jobsEnabled) return []
    // Overlays are editing affordances tied to the Cut Order tab — don't
    // clutter the canvas while the user is on the Layers tab.
    if (!prepareMode && layerPanelView !== 'cutOrder') return []
    const { jobs } = computeCutPlan(rootIds, nodesById, machiningSettings, storeArtboard)
    // Draw overlay only when splitting actually produced multiple jobs —
    // a single job is just "whole file" and the existing anchor preview
    // already covers that case.
    return prepareMode ? jobs : jobs.length > 1 ? jobs : []
  }, [jobsEnabled, layerPanelView, machiningSettings, nodesById, prepareMode, rootIds, storeArtboard])
  const designBounds = useMemo(() => {
    let bounds: Bounds | null = null
    for (const id of rootIds) {
      const node = nodesById[id]
      if (!node) continue
      bounds = mergeBounds(bounds, getNodePreviewBounds(node, nodesById))
    }
    return bounds
  }, [nodesById, rootIds])
  const outlineSourceIds = useMemo(
    () => [
      ...new Set([
        ...selectedIds,
        ...(hoveredNodeId ? [hoveredNodeId] : []),
        ...(panelHoveredId ? [panelHoveredId] : []),
      ]),
    ],
    [hoveredNodeId, panelHoveredId, selectedIds],
  )

  // During an active transform, read current x/y/rotation/scale directly from
  // Konva node refs so the outline tracks the handles in real-time.
  const liveTransforms = useMemo(() => {
    const transforms = new Map<string, NodeLiveTransform>()
    if (transformTick > 0) {
      for (const id of selectedIds) {
        const kn = nodeRefs.current.get(id)
        if (kn) {
          transforms.set(id, {
            x: kn.x(),
            y: kn.y(),
            rotation: kn.rotation(),
            scaleX: kn.scaleX(),
            scaleY: kn.scaleY(),
          })
        }
      }
    }
    return transforms
  }, [selectedIds, transformTick])

  const centerlineOverlayNodes = useMemo(
    () =>
      rootIds.map((nodeId) =>
        renderCenterlineOverlayNode(
          nodeId,
          nodesById,
          liveTransforms,
          toolDiameter,
          centerlinePathRefs.current,
        ),
      ),
    [liveTransforms, nodesById, rootIds, toolDiameter],
  )

  const outlineOverlayNodes = useMemo(
    () =>
      outlineSourceIds.map((id) =>
        renderOutlineNodeWithAncestors(id, nodesById, liveTransforms),
      ),
    [liveTransforms, nodesById, outlineSourceIds],
  )

  const showFilledEyedropperCursor = eyedropperSourceNodeId !== null || eyedropperCursorFlashFilled
  const cursor =
    isPanning || panToolActive
      ? (isPanning ? 'grabbing' : 'grab')
      : isSpacePressed
        ? 'grab'
        : eyedropperMode !== 'off' || eyedropperCursorFlashFilled
          ? `url("${showFilledEyedropperCursor ? PipetteFilledCursor : PipetteEmptyCursor}") ${EYEDROPPER_CURSOR_HOTSPOT_X} ${EYEDROPPER_CURSOR_HOTSPOT_Y}, alias`
          : 'default'

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-background"
      style={{ cursor }}
      onDragOver={handleLibraryDragOver}
      onDrop={handleLibraryDrop}
    >
      {/* Dot grid background */}
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:32px_32px]"
      />

      <EditorContextMenu
        isOpen={contextMenu.isOpen}
        x={contextMenu.x}
        y={contextMenu.y}
        onOpenChange={(isOpen) => setContextMenu((current) => ({ ...current, isOpen }))}
      />

      <TextEditOverlay />

      {/* Bottom floating toolbar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-7 z-20 flex justify-center px-6">
        <div className="pointer-events-auto flex items-center gap-2 rounded-[1.75rem] border border-white/10 bg-[rgba(19,19,23,0.9)] px-4 py-3 text-white shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
          {prepareMode ? (
            <>
              {/* Direct selection (always on in prepare). */}
              <ToolbarTooltip label="Direct selection" note="Always on in Prepare">
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.14] text-white cursor-default"
                  aria-pressed
                  title="Direct selection (always on in Prepare)"
                >
                  <AppIcon icon={Icons.cursor} className="h-5 w-5" />
                </button>
              </ToolbarTooltip>
              <ToolbarTooltip label="Pan" shortcuts={['H', 'Space']}>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${panToolActive ? 'bg-white/[0.14] text-white' : 'text-white/75 hover:text-white'}`}
                  onClick={() => setPanToolActive((v) => !v)}
                  title="Pan (H)"
                >
                  <AppIcon icon={Icons.hand} className="h-5 w-5" />
                </button>
              </ToolbarTooltip>
            </>
          ) : (
            <>
              {/* Direct selection toggle */}
              <ToolbarTooltip label="Direct selection" shortcuts={['D', '⌘ Click']} note="Shift+click multi-selects. Shift+⌘ click picks groups.">
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${effectiveInteractionMode === 'direct' ? 'bg-white/[0.14] text-white' : 'text-white/75 hover:text-white'}`}
                  onClick={() => setInteractionMode(interactionMode === 'direct' ? 'group' : 'direct')}
                  title="Direct selection (D)"
                >
                  <AppIcon icon={Icons.cursor} className="h-5 w-5" />
                </button>
              </ToolbarTooltip>

              {/* Pan tool toggle */}
              <ToolbarTooltip label="Pan" shortcuts={['H', 'Space']}>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${panToolActive ? 'bg-white/[0.14] text-white' : 'text-white/75 hover:text-white'}`}
                  onClick={() => setPanToolActive((v) => !v)}
                  title="Pan (H)"
                >
                  <AppIcon icon={Icons.hand} className="h-5 w-5" />
                </button>
              </ToolbarTooltip>

              {/* Outlines toggle */}
              <ToolbarTooltip label="Show Depth">
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${showOutlines ? 'bg-white/[0.14] text-white' : 'text-white/75 hover:text-white'}`}
                  onClick={() => setShowOutlines((v) => !v)}
                  title="Show Depth - show colored depth lines"
                >
                  <AppIcon icon={Icons.textIndent} className="h-5 w-5 rotate-90" />
                </button>
              </ToolbarTooltip>
            </>
          )}

          {/* Undo / Redo */}
          <div className="mx-1 h-6 w-px bg-white/10" />
          <ToolbarTooltip label="Undo" shortcuts={['⌘Z']}>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition text-white/75 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
              disabled={!canUndo}
              onClick={() => undo()}
              title="Undo (⌘Z)"
            >
              <AppIcon icon={Icons.undo} className="h-5 w-5" />
            </button>
          </ToolbarTooltip>
          <ToolbarTooltip label="Redo" shortcuts={['⌘⇧Z']}>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition text-white/75 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
              disabled={!canRedo}
              onClick={() => redo()}
              title="Redo (⌘⇧Z)"
            >
              <AppIcon icon={Icons.redo} className="h-5 w-5" />
            </button>
          </ToolbarTooltip>
          {prepareMode ? null : (
            <ToolbarTooltip label="Pick Styles" shortcuts={['⌘I']} note="⌘⇧I for depth only">
              <button
                type="button"
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition ${
                  eyedropperMode !== 'off' ? 'bg-white/[0.14] text-white' : 'text-white/75 hover:text-white'
                }`}
                onClick={() => setEyedropperMode(eyedropperMode === 'full' ? 'off' : 'full')}
                title="Pick Styles (⌘I)"
              >
                <img
                  src={PipetteGlyph}
                  alt=""
                  aria-hidden="true"
                  className={`h-4 w-4 select-none object-contain [filter:brightness(0)_invert(1)] ${
                    eyedropperMode !== 'off' ? 'opacity-100' : 'opacity-75'
                  }`}
                  draggable={false}
                />
              </button>
            </ToolbarTooltip>
          )}

          {/* Zoom controls */}
          <div className="ml-2 flex items-center gap-3 rounded-[1.2rem] bg-white/[0.05] px-4 py-2">
            <button
              type="button"
              className="text-white/72 hover:text-white disabled:opacity-40"
              disabled={viewport.scale <= MIN_SCALE}
              onClick={(e) => {
                e.stopPropagation()
                if (isZoomEditing) cancelZoomEdit()
                zoomAroundPoint(viewport.scale / 1.15, { x: stageSize.width / 2, y: stageSize.height / 2 })
              }}
              aria-label="Zoom out"
            >
              <AppIcon icon={Icons.minus} className="h-4 w-4" />
            </button>

            {isZoomEditing ? (
              <div className="flex min-w-14 items-center justify-center text-[1rem] text-white">
                <input
                  ref={zoomInputRef}
                  inputMode="decimal"
                  aria-label="Zoom percentage"
                  className="w-12 border-none bg-transparent text-center text-white outline-none"
                  value={zoomDraft}
                  onChange={(e) => setZoomDraft(e.target.value)}
                  onBlur={applyZoomDraft}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') { e.preventDefault(); applyZoomDraft() }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelZoomEdit() }
                  }}
                />
                <span className="pl-1 text-white/72">%</span>
              </div>
            ) : (
              <button
                type="button"
                className="min-w-14 text-center text-[1rem] text-white"
                onClick={(e) => { e.stopPropagation(); beginZoomEdit() }}
              >
                {zoomPercent}%
              </button>
            )}

            <button
              type="button"
              className="text-white/72 hover:text-white disabled:opacity-40"
              disabled={viewport.scale >= MAX_SCALE}
              onClick={(e) => {
                e.stopPropagation()
                if (isZoomEditing) cancelZoomEdit()
                zoomAroundPoint(viewport.scale * 1.15, { x: stageSize.width / 2, y: stageSize.height / 2 })
              }}
              aria-label="Zoom in"
            >
              <AppIcon icon={Icons.plus} className="h-4 w-4" />
            </button>
          </div>

          {/* Fit button */}
          <button
            type="button"
            className="min-w-12 px-3 font-medium uppercase tracking-[0.08em] text-white/80 hover:text-white"
            onClick={() => {
              if (isZoomEditing) cancelZoomEdit()
              if (prepareMode) fitViewportToArtboard(PREPARE_FIT_PADDING_PX)
              else resetViewport()
            }}
          >
            Fit
          </button>
        </div>
      </div>

      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        className="!cursor-inherit"
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        onMouseLeave={() => setHoveredNodeId(null)}
        onClick={onStageClick}
        onContextMenu={onContextMenu}
        onWheel={handleWheel}
      >
        <Layer>
          <Rect
            name="canvas-empty stage-backdrop"
            x={0}
            y={0}
            width={stageSize.width}
            height={stageSize.height}
            fill="rgba(0,0,0,0)"
          />
        </Layer>

        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale}>
          {allowStageSelection && selectedStage ? (
            <Rect
              ref={artboardTargetRef}
              x={artboardRect.x}
              y={artboardRect.y}
              width={artboardRect.width}
              height={artboardRect.height}
              fill="rgba(255, 255, 255, 0.01)"
              draggable={!pendingImport && !interactionBlocked}
              onMouseDown={(event) => {
                event.cancelBubble = true
              }}
              onTouchStart={(event) => {
                event.cancelBubble = true
              }}
              onClick={(event) => {
                event.cancelBubble = true
              }}
              onTap={(event) => {
                event.cancelBubble = true
              }}
              onDragStart={(event) => {
                event.cancelBubble = true
                setIsTransforming(true)
              }}
              onDragMove={(event) => {
                event.cancelBubble = true
                syncArtboardTargetToState(event.target as Konva.Rect)
              }}
              onDragEnd={(event) => {
                event.cancelBubble = true
                syncArtboardTargetToState(event.target as Konva.Rect)
                setIsTransforming(false)
              }}
              onTransform={(event) => {
                event.cancelBubble = true
                syncArtboardTargetToState(event.target as Konva.Rect)
              }}
            />
          ) : null}

          <Group x={artboardRect.x} y={artboardRect.y}>
            <Rect
              ref={artboardRef}
              name="canvas-empty artboard-base"
              x={0}
              y={0}
              width={artboardRect.width}
              height={artboardRect.height}
              fill={woodTexture ? undefined : '#6a4b33'}
              fillPatternImage={woodTexture ?? undefined}
              fillPatternRepeat="repeat"
              fillPatternScaleX={presetDef.textureScale}
              fillPatternScaleY={presetDef.textureScale}
              stroke={selectedStage ? 'rgba(115,187,255,0.95)' : 'rgba(132,94,62,0.55)'}
              strokeWidth={selectedStage ? 1.4 / viewport.scale : 1 / viewport.scale}
              cornerRadius={2 / viewport.scale}
              shadowColor="rgba(0,0,0,0.35)"
              shadowBlur={24}
              shadowOffsetY={8}
            />

            {prepareMode ? (
              <Rect
                x={0}
                y={0}
                width={artboardRect.width}
                height={artboardRect.height}
                fill="rgba(0,0,0,0.35)"
                listening={false}
              />
            ) : null}

            {effectiveFocusGroupId && focusScopeContainerId ? (
              <Rect
                name="canvas-empty focus-overlay"
                x={0}
                y={0}
                width={artboardRect.width}
                height={artboardRect.height}
                fill="rgba(20, 14, 9, 0.35)"
                listening={false}
              />
            ) : null}

            {prepareMode && designBounds ? (
              <Group listening={false}>
                {(() => {
                  const dimStroke = '#d1d5db'
                  const dimText = '#ffffff'
                  const dimTextStroke = '#000000'
                  const dimTextStrokeWidth = 3 / viewport.scale
                  const tick = 5 / viewport.scale
                  const matTopY = -18 / viewport.scale
                  const matRightX = storeArtboard.width + 18 / viewport.scale
                  const designTopY = designBounds.minY - 10 / viewport.scale
                  const designRightX = designBounds.maxX + 10 / viewport.scale
                  const designMidY = designBounds.minY + (designBounds.maxY - designBounds.minY) / 2
                  const designOffsetY = storeArtboard.height - designBounds.maxY
                  const designOffsetDimY = storeArtboard.height + 10 / viewport.scale
                  const designOffsetDimX = -10 / viewport.scale
                  return (
                    <>
                      <Line
                        points={[0, matTopY, storeArtboard.width, matTopY]}
                        stroke={dimStroke}
                        strokeWidth={0.8 / viewport.scale}
                      />
                      <Line points={[0, matTopY - tick, 0, matTopY + tick]} stroke={dimStroke} strokeWidth={0.8 / viewport.scale} />
                      <Line points={[storeArtboard.width, matTopY - tick, storeArtboard.width, matTopY + tick]} stroke={dimStroke} strokeWidth={0.8 / viewport.scale} />
                      <Text
                        x={0}
                        y={matTopY - 15 / viewport.scale}
                        width={storeArtboard.width}
                        text={`W ${storeArtboard.width.toFixed(0)} mm`}
                        fontSize={11 / viewport.scale}
                        fill={dimText}
                        stroke={dimTextStroke}
                        strokeWidth={dimTextStrokeWidth}
                        fillAfterStrokeEnabled
                        align="center"
                      />
                      <Line
                        points={[matRightX, 0, matRightX, storeArtboard.height]}
                        stroke={dimStroke}
                        strokeWidth={0.8 / viewport.scale}
                      />
                      <Line points={[matRightX - tick, 0, matRightX + tick, 0]} stroke={dimStroke} strokeWidth={0.8 / viewport.scale} />
                      <Line points={[matRightX - tick, storeArtboard.height, matRightX + tick, storeArtboard.height]} stroke={dimStroke} strokeWidth={0.8 / viewport.scale} />
                      <Text
                        x={matRightX + 4 / viewport.scale}
                        y={2 / viewport.scale}
                        text={`H ${storeArtboard.height.toFixed(0)} mm`}
                        fontSize={11 / viewport.scale}
                        fill={dimText}
                        stroke={dimTextStroke}
                        strokeWidth={dimTextStrokeWidth}
                        fillAfterStrokeEnabled
                      />
                      <Line
                        points={[designBounds.minX, designTopY, designBounds.maxX, designTopY]}
                        stroke={dimStroke}
                        strokeWidth={0.7 / viewport.scale}
                      />
                      <Line points={[designBounds.minX, designTopY - tick, designBounds.minX, designTopY + tick]} stroke={dimStroke} strokeWidth={0.7 / viewport.scale} />
                      <Line points={[designBounds.maxX, designTopY - tick, designBounds.maxX, designTopY + tick]} stroke={dimStroke} strokeWidth={0.7 / viewport.scale} />
                      <Text
                        x={designBounds.minX}
                        y={designTopY - 15 / viewport.scale}
                        width={designBounds.maxX - designBounds.minX}
                        text={`Design W ${(designBounds.maxX - designBounds.minX).toFixed(1)} mm`}
                        fontSize={11 / viewport.scale}
                        fill={dimText}
                        stroke={dimTextStroke}
                        strokeWidth={dimTextStrokeWidth}
                        fillAfterStrokeEnabled
                        align="center"
                      />
                      <Line
                        points={[designRightX, designBounds.minY, designRightX, designBounds.maxY]}
                        stroke={dimStroke}
                        strokeWidth={0.7 / viewport.scale}
                      />
                      <Line points={[designRightX - tick, designBounds.minY, designRightX + tick, designBounds.minY]} stroke={dimStroke} strokeWidth={0.7 / viewport.scale} />
                      <Line points={[designRightX - tick, designBounds.maxY, designRightX + tick, designBounds.maxY]} stroke={dimStroke} strokeWidth={0.7 / viewport.scale} />
                      <Text
                        x={designRightX + 4 / viewport.scale}
                        y={designMidY - 6 / viewport.scale}
                        text={`Design H ${(designBounds.maxY - designBounds.minY).toFixed(1)} mm`}
                        fontSize={11 / viewport.scale}
                        fill={dimText}
                        stroke={dimTextStroke}
                        strokeWidth={dimTextStrokeWidth}
                        fillAfterStrokeEnabled
                      />
                      <Line
                        points={[0, designOffsetDimY, designBounds.minX, designOffsetDimY]}
                        stroke={dimStroke}
                        strokeWidth={0.7 / viewport.scale}
                      />
                      <Text
                        x={Math.max(0, designBounds.minX / 2 - 22 / viewport.scale)}
                        y={designOffsetDimY + 4 / viewport.scale}
                        text={`X ${designBounds.minX.toFixed(1)} mm`}
                        fontSize={10 / viewport.scale}
                        fill={dimText}
                        stroke={dimTextStroke}
                        strokeWidth={dimTextStrokeWidth}
                        fillAfterStrokeEnabled
                      />
                      <Line
                        points={[designOffsetDimX, designBounds.maxY, designOffsetDimX, storeArtboard.height]}
                        stroke={dimStroke}
                        strokeWidth={0.7 / viewport.scale}
                      />
                      <Text
                        x={designOffsetDimX - 48 / viewport.scale}
                        y={designBounds.maxY + Math.max(0, designOffsetY / 2 - 6 / viewport.scale)}
                        text={`Y ${designOffsetY.toFixed(1)} mm`}
                        fontSize={10 / viewport.scale}
                        fill={dimText}
                        stroke={dimTextStroke}
                        strokeWidth={dimTextStrokeWidth}
                        fillAfterStrokeEnabled
                      />
                    </>
                  )
                })()}
                <Rect
                  x={designBounds.minX}
                  y={designBounds.minY}
                  width={designBounds.maxX - designBounds.minX}
                  height={designBounds.maxY - designBounds.minY}
                  fill="rgba(220,38,38,0.025)"
                  stroke="#ef4444"
                  strokeWidth={0.8 / viewport.scale}
                  dash={[4 / viewport.scale, 3 / viewport.scale]}
                />
              </Group>
            ) : null}

            {/* Per-job fill. Drawn BEFORE the shape stack so shapes sit above
                it in hit-order: clicking a shape always hits the shape first,
                and only clicks on empty fill fall through to the job. */}
            {computedJobs.length > 1
              ? computedJobs.map((job, jobIndex) => {
                  const { boundsMm } = job
                  const hue = (jobIndex * 57) % 360
                  const fillColor = `hsl(${hue}, 75%, 55%)`
                  const active = selectedJobId === job.id
                  return (
                    <Rect
                      key={`job-fill-${job.id}`}
                      name="job-fill"
                      x={boundsMm.minX}
                      y={boundsMm.minY}
                      width={boundsMm.maxX - boundsMm.minX}
                      height={boundsMm.maxY - boundsMm.minY}
                      fill={fillColor}
                      opacity={active ? 0.32 : 0.08}
                      stroke={active ? fillColor : undefined}
                      strokeWidth={active ? 1.2 / viewport.scale : 0}
                      listening={effectiveInteractionMode !== 'direct'}
                      onClick={(e) => {
                        e.cancelBubble = true
                        setSelectedJob(active ? null : job.id)
                      }}
                      onTap={(e) => {
                        e.cancelBubble = true
                        setSelectedJob(active ? null : job.id)
                      }}
                    />
                  )
                })
              : null}

            {showEngravePreview
              ? (
                <EngravePreviewStack
                  rootIds={rootIds}
                  defaultDepth={defaultDepthMm}
                  toolDiameter={toolDiameter}
                  registerNodeRef={registerNodeRef}
                  interactionBlocked={interactionBlocked}
                  disableDrag={prepareMode}
                  showCncOverrides={prepareMode || showOutlines}
                  outlineOnly={!prepareMode && showOutlines}
                  onNodeDragStart={handleNodeDragStart}
                  onNodeDragMove={handleNodeDragMove}
                  onNodeDragEnd={handleNodeDragEnd}
                />
              )
              : rootIds.map((nodeId) => {
                const node = nodesById[nodeId]
                const grid = node?.gridMetadata
                if (!grid || grid.rows * grid.cols <= 1) {
                  return (
                    <ShapeRenderer
                      key={nodeId}
                      nodeId={nodeId}
                      registerNodeRef={registerNodeRef}
                      interactionBlocked={interactionBlocked}
                      disableDrag={prepareMode}
                      showCncOverrides={prepareMode || showOutlines}
                      outlineOnly={!prepareMode && showOutlines}
                      onNodeDragStart={handleNodeDragStart}
                      onNodeDragMove={handleNodeDragMove}
                      onNodeDragEnd={handleNodeDragEnd}
                    />
                  )
                }
                const ns = getNodeSize(node, nodesById)
                const { rows, cols, rowGap, colGap } = grid
                // Live resize: read scale from Konva ref while transformer is active
                const liveKnGrid = transformTick > 0 && selectedIds.includes(nodeId) ? nodeRefs.current.get(nodeId) : null
                const cellW = liveKnGrid ? ns.baseWidth * Math.abs(liveKnGrid.scaleX()) : ns.width
                const cellH = liveKnGrid ? ns.baseHeight * Math.abs(liveKnGrid.scaleY()) : ns.height
                const copies: React.ReactNode[] = []
                for (let r = 0; r < rows; r++) {
                  for (let c = 0; c < cols; c++) {
                    if (r === 0 && c === 0) {
                      copies.push(
                        <ShapeRenderer
                          key={`${nodeId}-0-0`}
                            nodeId={nodeId}
                            registerNodeRef={registerNodeRef}
                            interactionBlocked={interactionBlocked}
                            disableDrag={prepareMode}
                            showCncOverrides={prepareMode || showOutlines}
                            outlineOnly={!prepareMode && showOutlines}
                            onNodeDragStart={handleNodeDragStart}
                            onNodeDragMove={handleNodeDragMove}
                            onNodeDragEnd={handleNodeDragEnd}
                        />
                      )
                    } else {
                      copies.push(
                        <Group key={`${nodeId}-${r}-${c}`} x={c * (cellW + colGap)} y={r * (cellH + rowGap)} listening={false}>
                          <ShapeRenderer
                            nodeId={nodeId}
                            registerNodeRef={noopRegisterNodeRef}
                            interactionBlocked
                            showCncOverrides={prepareMode || showOutlines}
                            outlineOnly={!prepareMode && showOutlines}
                          />
                        </Group>
                      )
                    }
                  }
                }
                return <React.Fragment key={nodeId}>{copies}</React.Fragment>
              })}

            {prepareMode && prepareShowCutNumbers && computedJobs.length > 0 ? (() => {
              const badgeRadius = 10 / viewport.scale
              const badgeFontSize = 11 / viewport.scale
              const badgeStroke = 1.5 / viewport.scale
              const isPlaying = prepareJobPlayback.isPlaying
              const currentStep = prepareJobPlayback.currentJobIndex
              let runningIndex = 0
              const badges: React.ReactNode[] = []
              for (let jobIndex = 0; jobIndex < computedJobs.length; jobIndex++) {
                const job = computedJobs[jobIndex]
                const hue = (jobIndex * 57) % 360
                const badgeBg = `hsl(${hue}, 65%, 28%)`
                const badgeStrokeColor = `hsl(${hue}, 70%, 55%)`
                const badgeTextColor = `hsl(${hue}, 90%, 88%)`
                for (const nodeId of job.nodeIds) {
                  const node = nodesById[nodeId]
                  if (!node) continue
                  const nb = getNodePreviewBounds(node, nodesById, ancestorMatrix(node, nodesById))
                  if (!nb) continue
                  const stepIndex = runningIndex
                  runningIndex += 1
                  const cx = nb.minX
                  const cy = nb.minY
                  const dimmed = isPlaying && stepIndex > currentStep
                  badges.push(
                    <Group
                      key={`cut-num-${nodeId}`}
                      x={cx}
                      y={cy}
                      listening={false}
                      opacity={dimmed ? 0.4 : 1}
                    >
                      <Circle
                        radius={badgeRadius}
                        fill={badgeBg}
                        stroke={badgeStrokeColor}
                        strokeWidth={badgeStroke}
                      />
                      <Text
                        x={-badgeRadius}
                        y={-badgeRadius}
                        width={badgeRadius * 2}
                        height={badgeRadius * 2}
                        text={String(stepIndex + 1)}
                        fontSize={badgeFontSize}
                        fontStyle="bold"
                        fill={badgeTextColor}
                        align="center"
                        verticalAlign="middle"
                      />
                    </Group>,
                  )
                }
              }
              return <Group listening={false}>{badges}</Group>
            })() : null}

            {prepareMode && computedJobs.length > 1 ? (() => {
              const sharedXs = new Set<number>()
              const sharedYs = new Set<number>()
              for (const job of computedJobs) {
                if (job.anchorAlignment?.sharedX != null) sharedXs.add(job.anchorAlignment.sharedX)
                if (job.anchorAlignment?.sharedY != null) sharedYs.add(job.anchorAlignment.sharedY)
              }
              return (
                <Group listening={false}>
                  {[...sharedXs].map((x) => (
                    <Line
                      key={`prepare-shared-x-${x}`}
                      points={[x, 0, x, storeArtboard.height]}
                      stroke="#10b981"
                      strokeWidth={0.8 / viewport.scale}
                      dash={[5 / viewport.scale, 4 / viewport.scale]}
                      opacity={0.65}
                    />
                  ))}
                  {[...sharedYs].map((y) => (
                    <Line
                      key={`prepare-shared-y-${y}`}
                      points={[0, y, storeArtboard.width, y]}
                      stroke="#10b981"
                      strokeWidth={0.8 / viewport.scale}
                      dash={[5 / viewport.scale, 4 / viewport.scale]}
                      opacity={0.65}
                    />
                  ))}
                </Group>
              )
            })() : null}

            {centerlineOverlayNodes}

            {/* Per-job overlay: dashed bounds rectangle + crosshair at each
                job's anchor + dashed offset guides to the artboard's left and
                bottom edges. Clicking a job routes the inspector's anchor
                picker to that job via `selectedJobId`. The per-job palette
                is a simple deterministic hue so colour-coding matches 3D
                preview badges. */}
            {computedJobs.length > 1
              ? (() => {
                const xSeen = new Set<string>()
                const ySeen = new Set<string>()
                return computedJobs.map((job, jobIndex) => {
                  const { boundsMm, anchorPointMm } = job
                  const hue = (jobIndex * 57) % 360
                  const strokeColor = `hsl(${hue}, 75%, 55%)`
                  const arm = 10 / viewport.scale
                  const strokeWidth = 1.2 / viewport.scale
                  const active = selectedJobId === job.id
                  const artboardLeft = 0
                  const artboardBottom = storeArtboard.height
                  const measureColor = `hsl(${hue}, 70%, 42%)`
                  const jobLabelColor = `hsl(${hue}, 70%, 28%)`
                  const pillFontSize = 10 / viewport.scale
                  const pillHeight = 16 / viewport.scale
                  const pillPaddingX = 5 / viewport.scale
                  const pillRadius = 2 / viewport.scale
                  const offsetGap = 12 / viewport.scale
                  const xLabel = `X ${job.crossOffsetFromArtboardBL.x.toFixed(1)} mm`
                  const yLabel = `Y ${job.crossOffsetFromArtboardBL.y.toFixed(1)} mm`
                  const showXOffsetPill = !xSeen.has(anchorPointMm.x.toFixed(3))
                  const showYOffsetPill = !ySeen.has(anchorPointMm.y.toFixed(3))
                  xSeen.add(anchorPointMm.x.toFixed(3))
                  ySeen.add(anchorPointMm.y.toFixed(3))
                  const xPillWidth = Math.max(46 / viewport.scale, xLabel.length * pillFontSize * 0.58 + pillPaddingX * 2)
                  const yPillWidth = Math.max(46 / viewport.scale, yLabel.length * pillFontSize * 0.58 + pillPaddingX * 2)
                  const xPillX = anchorPointMm.x - xPillWidth / 2
                  const xPillY = artboardBottom + offsetGap
                  const yPillX = artboardLeft - yPillWidth - offsetGap
                  const yPillY = anchorPointMm.y - pillHeight / 2
                  return (
                    <Group key={`job-overlay-${job.id}`}>
                      {/* Border — in prepare mode we let shape hovers drive
                          selection via the panel lists, so the border is
                          decorative (listening=false). */}
                      <Rect
                        x={boundsMm.minX}
                        y={boundsMm.minY}
                        width={boundsMm.maxX - boundsMm.minX}
                        height={boundsMm.maxY - boundsMm.minY}
                        stroke={strokeColor}
                        strokeWidth={(active ? 1.8 : 0.9) / viewport.scale}
                        opacity={0.5}
                        listening={!prepareMode}
                        hitStrokeWidth={prepareMode ? 0 : Math.max(8 / viewport.scale, 6)}
                        onClick={
                          prepareMode
                            ? undefined
                            : (e) => {
                                e.cancelBubble = true
                                setSelectedJob(active ? null : job.id)
                              }
                        }
                        onTap={
                          prepareMode
                            ? undefined
                            : (e) => {
                                e.cancelBubble = true
                                setSelectedJob(active ? null : job.id)
                              }
                        }
                      />
                      {/* Non-interactive guides/labels — never intercept clicks. */}
                      <Group listening={false}>
                        {/* Offset guide — horizontal, crosshair → artboard left edge. */}
                        <Line
                          points={[
                            artboardLeft,
                            anchorPointMm.y,
                            anchorPointMm.x,
                            anchorPointMm.y,
                          ]}
                          stroke={measureColor}
                          strokeWidth={strokeWidth}
                          dash={[3 / viewport.scale, 3 / viewport.scale]}
                        />
                        {showXOffsetPill ? (
                          <Line
                            points={[
                              anchorPointMm.x,
                              anchorPointMm.y,
                            anchorPointMm.x,
                            xPillY,
                          ]}
                            stroke={measureColor}
                            strokeWidth={strokeWidth}
                            opacity={0.85}
                          />
                        ) : null}
                        {/* Offset guide — vertical, crosshair → artboard bottom edge. */}
                        <Line
                          points={[
                            anchorPointMm.x,
                            anchorPointMm.y,
                            anchorPointMm.x,
                            artboardBottom,
                          ]}
                          stroke={measureColor}
                          strokeWidth={strokeWidth}
                          dash={[3 / viewport.scale, 3 / viewport.scale]}
                        />
                        {showYOffsetPill ? (
                          <Line
                            points={[
                              anchorPointMm.x,
                              anchorPointMm.y,
                            yPillX + yPillWidth,
                            anchorPointMm.y,
                          ]}
                            stroke={measureColor}
                            strokeWidth={strokeWidth}
                            opacity={0.85}
                          />
                        ) : null}
                        {/* Crosshair at anchor. */}
                        <Line
                          points={[
                            anchorPointMm.x - arm,
                            anchorPointMm.y,
                            anchorPointMm.x + arm,
                            anchorPointMm.y,
                          ]}
                          stroke={measureColor}
                          strokeWidth={strokeWidth * 1.2}
                          lineCap="round"
                        />
                        <Line
                          points={[
                            anchorPointMm.x,
                            anchorPointMm.y - arm,
                            anchorPointMm.x,
                            anchorPointMm.y + arm,
                          ]}
                          stroke={measureColor}
                          strokeWidth={strokeWidth * 1.2}
                          lineCap="round"
                        />
                        <Text
                          x={anchorPointMm.x + arm}
                          y={anchorPointMm.y - arm - 14 / viewport.scale}
                          text={`J${jobIndex + 1}`}
                          fontSize={11 / viewport.scale}
                          fill={jobLabelColor}
                          fontStyle="bold"
                        />
                        {showXOffsetPill ? (
                        <Group>
                          <Rect
                            x={xPillX}
                            y={xPillY}
                            width={xPillWidth}
                            height={pillHeight}
                            cornerRadius={pillRadius}
                            fill={measureColor}
                          />
                          <Text
                            x={xPillX}
                            y={xPillY}
                            width={xPillWidth}
                            height={pillHeight}
                            text={xLabel}
                            fontSize={pillFontSize}
                            fill="#ffffff"
                            fontStyle="bold"
                            align="center"
                            verticalAlign="middle"
                          />
                        </Group>
                        ) : null}
                        {showYOffsetPill ? (
                        <Group>
                          <Rect
                            x={yPillX}
                            y={yPillY}
                            width={yPillWidth}
                            height={pillHeight}
                            cornerRadius={pillRadius}
                            fill={measureColor}
                          />
                          <Text
                            x={yPillX}
                            y={yPillY}
                            width={yPillWidth}
                            height={pillHeight}
                            text={yLabel}
                            fontSize={pillFontSize}
                            fill="#ffffff"
                            fontStyle="bold"
                            align="center"
                            verticalAlign="middle"
                          />
                        </Group>
                        ) : null}
                      </Group>
                    </Group>
                  )
                })
              })()
              : null}

            {hoveredPathAnchorPreview ? (() => {
              const { bounds, point } = hoveredPathAnchorPreview
              const markerRadius = 5 / viewport.scale
              const arm = 11 / viewport.scale
              const strokeWidth = 1.4 / viewport.scale
              return (
                <Group key="path-anchor-preview" listening={false}>
                  <Rect
                    x={bounds.minX}
                    y={bounds.minY}
                    width={bounds.maxX - bounds.minX}
                    height={bounds.maxY - bounds.minY}
                    stroke="#0d99ff"
                    strokeWidth={0.9 / viewport.scale}
                    dash={[5 / viewport.scale, 4 / viewport.scale]}
                    fill="rgba(13,153,255,0.04)"
                  />
                  <Line
                    points={[point.x - arm, point.y, point.x + arm, point.y]}
                    stroke="#00d5ff"
                    strokeWidth={strokeWidth}
                    lineCap="round"
                  />
                  <Line
                    points={[point.x, point.y - arm, point.x, point.y + arm]}
                    stroke="#00d5ff"
                    strokeWidth={strokeWidth}
                    lineCap="round"
                  />
                  <Circle
                    x={point.x}
                    y={point.y}
                    radius={markerRadius}
                    fill="rgba(0,213,255,0.22)"
                    stroke="#ffffff"
                    strokeWidth={1.1 / viewport.scale}
                  />
                </Group>
              )
            })() : null}

            {/* Grid gap handles for selected grid nodes */}
            {selectedIds.map((nodeId) => {
              const node = nodesById[nodeId]
              const grid = node?.gridMetadata
              if (!grid) return null
              const ns = getNodeSize(node, nodesById)
              const { rows, cols, rowGap, colGap } = grid
              // Live resize: read scale/position from Konva ref while transformer is active
              const liveKnHandle = transformTick > 0 ? nodeRefs.current.get(nodeId) : null
              const cellW = liveKnHandle ? ns.baseWidth * Math.abs(liveKnHandle.scaleX()) : ns.width
              const cellH = liveKnHandle ? ns.baseHeight * Math.abs(liveKnHandle.scaleY()) : ns.height
              const nodeX = liveKnHandle ? liveKnHandle.x() : node.x
              const nodeY = liveKnHandle ? liveKnHandle.y() : node.y
              const totalW = cols * cellW + (cols - 1) * colGap
              const totalH = rows * cellH + (rows - 1) * rowGap
              const handleR = 5 / viewport.scale
              const handles: React.ReactNode[] = []

              // Column gap handles
              for (let c = 0; c < cols - 1; c++) {
                const gapX = nodeX + (c + 1) * cellW + c * colGap
                const gapW = Math.max(colGap, 0)
                handles.push(
                  <Rect
                    key={`cgap-rect-${nodeId}-${c}`}
                    x={gapX}
                    y={nodeY}
                    width={gapW}
                    height={totalH}
                    fill="rgba(255,0,255,0.12)"
                    stroke="rgba(255,0,255,0.35)"
                    strokeWidth={0.5 / viewport.scale}
                    listening={false}
                  />,
                  <Circle
                    key={`cgap-handle-${nodeId}-${c}`}
                    x={gapX + gapW / 2}
                    y={nodeY + totalH / 2}
                    radius={handleR}
                    fill="#0d99ff"
                    stroke="#ffffff"
                    strokeWidth={1 / viewport.scale}
                    onMouseDown={(e) => {
                      const pos = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 }
                      gapDragRef.current = { kind: 'grid', startPointerX: pos.x, startPointerY: pos.y, startGap: colGap, axis: 'col', nodeId }
                      e.cancelBubble = true
                    }}
                  />
                )
              }

              // Row gap handles
              for (let r = 0; r < rows - 1; r++) {
                const gapY = nodeY + (r + 1) * cellH + r * rowGap
                const gapH = Math.max(rowGap, 0)
                handles.push(
                  <Rect
                    key={`rgap-rect-${nodeId}-${r}`}
                    x={nodeX}
                    y={gapY}
                    width={totalW}
                    height={gapH}
                    fill="rgba(255,0,255,0.12)"
                    stroke="rgba(255,0,255,0.35)"
                    strokeWidth={0.5 / viewport.scale}
                    listening={false}
                  />,
                  <Circle
                    key={`rgap-handle-${nodeId}-${r}`}
                    x={nodeX + totalW / 2}
                    y={gapY + gapH / 2}
                    radius={handleR}
                    fill="#0d99ff"
                    stroke="#ffffff"
                    strokeWidth={1 / viewport.scale}
                    onMouseDown={(e) => {
                      const pos = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 }
                      gapDragRef.current = { kind: 'grid', startPointerX: pos.x, startPointerY: pos.y, startGap: rowGap, axis: 'row', nodeId }
                      e.cancelBubble = true
                    }}
                  />
                )
              }

              return <React.Fragment key={`grid-handles-${nodeId}`}>{handles}</React.Fragment>
            })}

            {/* Generator spacing handles for selected tenon/dowelHole nodes */}
            {selectedIds.map((nodeId) => {
              const node = nodesById[nodeId]
              if (node?.type !== 'group') return null
              const gMeta = (node as GroupNode).generatorMetadata
              if (!gMeta) return null
              const params = gMeta.params
              if (params.kind !== 'tenon' && params.kind !== 'dowelHole') return null
              const { rowCount, colCount, rowSpacing, colSpacing } = params
              const itemW = params.kind === 'tenon' ? params.width : params.diameter
              const itemH = params.kind === 'tenon' ? params.height : params.diameter
              const totalW = (colCount - 1) * colSpacing + itemW
              const totalH = (rowCount - 1) * rowSpacing + itemH
              const handleR = 5 / viewport.scale
              const handles: React.ReactNode[] = []

              // Column spacing handles (between columns)
              for (let c = 0; c < colCount - 1; c++) {
                const gapX = node.x + c * colSpacing + itemW
                const gapW = Math.max(colSpacing - itemW, 0)
                handles.push(
                  <Rect
                    key={`gen-cgap-rect-${nodeId}-${c}`}
                    x={gapX}
                    y={node.y}
                    width={gapW}
                    height={totalH}
                    fill="rgba(255,0,255,0.12)"
                    stroke="rgba(255,0,255,0.35)"
                    strokeWidth={0.5 / viewport.scale}
                    listening={false}
                  />,
                  <Circle
                    key={`gen-cgap-handle-${nodeId}-${c}`}
                    x={gapX + gapW / 2}
                    y={node.y + totalH / 2}
                    radius={handleR}
                    fill="#0d99ff"
                    stroke="#ffffff"
                    strokeWidth={1 / viewport.scale}
                    onMouseDown={(e) => {
                      const pos = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 }
                      gapDragRef.current = { kind: 'generator', startPointerX: pos.x, startPointerY: pos.y, startSpacing: colSpacing, axis: 'col', nodeId, minSpacing: itemW }
                      e.cancelBubble = true
                    }}
                  />
                )
              }

              // Row spacing handles (between rows)
              for (let r = 0; r < rowCount - 1; r++) {
                const gapY = node.y + r * rowSpacing + itemH
                const gapH = Math.max(rowSpacing - itemH, 0)
                handles.push(
                  <Rect
                    key={`gen-rgap-rect-${nodeId}-${r}`}
                    x={node.x}
                    y={gapY}
                    width={totalW}
                    height={gapH}
                    fill="rgba(255,0,255,0.12)"
                    stroke="rgba(255,0,255,0.35)"
                    strokeWidth={0.5 / viewport.scale}
                    listening={false}
                  />,
                  <Circle
                    key={`gen-rgap-handle-${nodeId}-${r}`}
                    x={node.x + totalW / 2}
                    y={gapY + gapH / 2}
                    radius={handleR}
                    fill="#0d99ff"
                    stroke="#ffffff"
                    strokeWidth={1 / viewport.scale}
                    onMouseDown={(e) => {
                      const pos = stageRef.current?.getPointerPosition() ?? { x: 0, y: 0 }
                      gapDragRef.current = { kind: 'generator', startPointerX: pos.x, startPointerY: pos.y, startSpacing: rowSpacing, axis: 'row', nodeId, minSpacing: itemH }
                      e.cancelBubble = true
                    }}
                  />
                )
              }

              return <React.Fragment key={`gen-handles-${nodeId}`}>{handles}</React.Fragment>
            })}
          </Group>

          <Transformer
            ref={transformerRef}
            visible={!prepareMode}
            resizeEnabled={!prepareMode}
            rotateEnabled={!selectedStage && !prepareMode}
            flipEnabled={false}
            boundBoxFunc={(oldBox, newBox) => {
              const minSize =
                selectedStage && allowStageSelection ? MIN_ARTBOARD_SIZE : 8
              const maxSize =
                selectedStage && allowStageSelection ? MAX_ARTBOARD_SIZE : Number.POSITIVE_INFINITY

              if (
                Math.abs(newBox.width) < minSize ||
                Math.abs(newBox.height) < minSize ||
                Math.abs(newBox.width) > maxSize ||
                Math.abs(newBox.height) > maxSize
              ) {
                return oldBox
              }

              return newBox
            }}
            anchorStroke="#0d99ff"
            anchorFill="#ffffff"
            anchorSize={8}
            borderStroke="#0d99ff"
            borderDash={[]}
            anchorStyleFunc={(anchor) => {
              if (anchor.hasName('rotater')) {
                anchor.cornerRadius(anchor.width() / 2)
              } else {
                anchor.cornerRadius(1.5)
              }
            }}
            onTransformStart={onTransformStart}
            onTransform={() => setTransformTick((t) => t + 1)}
            onTransformEnd={onTransformEnd}
          />
        </Layer>

        {/* Illustrator-style thin path outline overlay — document space */}
        <Layer x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale} listening={false}>
          <Group x={artboardRect.x} y={artboardRect.y}>
            {outlineOverlayNodes}
          </Group>
        </Layer>

        <Layer ref={guideLayerRef} listening={false}>
          {/* Path outline overlay (in the layer above) handles hover visualization */}
          {marqueeHighlights.map(({ id, rect }) => (
            <Rect
              key={id}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              stroke="#0d99ff"
              strokeWidth={1}
              listening={false}
            />
          ))}
          {marquee ? (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.width}
              height={marquee.height}
              fill="rgba(24,160,251,0.1)"
              stroke="#0d99ff"
              strokeWidth={1}
              listening={false}
            />
          ) : null}
          {selectionBoundingRect ? (() => {
            const fmtN = (v: number) => {
              const n = Math.round((v / viewport.scale) * 10) / 10
              return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1)
            }
            const label = `${fmtN(selectionBoundingRect.width)} × ${fmtN(selectionBoundingRect.height)}`
            const PILL_H = 20
            const PILL_W = 110
            const pillX = selectionBoundingRect.x + selectionBoundingRect.width / 2 - PILL_W / 2
            const pillY = selectionBoundingRect.y + selectionBoundingRect.height + 7
            return (
              <>
                <Rect
                  x={pillX}
                  y={pillY}
                  width={PILL_W}
                  height={PILL_H}
                  fill="#0d99ff"
                  cornerRadius={4}
                  listening={false}
                />
                <Text
                  x={pillX}
                  y={pillY + 4}
                  width={PILL_W}
                  text={label}
                  fill="#ffffff"
                  fontSize={11}
                  fontStyle="500"
                  fontFamily="Inter, system-ui, sans-serif"
                  align="center"
                  listening={false}
                />
              </>
            )
          })() : null}
        </Layer>
      </Stage>
    </div>
  )
}
