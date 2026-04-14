import { useEffect, useMemo, useState } from 'react'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Circle, Group, Line, Path, Rect } from 'react-konva'

import {
  getEffectiveFocusGroupId,
  getEffectiveInteractionMode,
  getFocusRenderMode,
  resolveSelectionTarget,
} from './lib/editorTree'
import {
  buildDepthPreviewPlan,
} from './lib/booleanUnion'
import {
  getCncVisualOverrides,
  getEngravePreviewFill,
  getEngravePreviewStroke,
  isOpenPathNode,
  normalizeEngraveType,
} from './lib/cncVisuals'
import { mergeCncMetadata } from './lib/cncMetadata'
import { useSelection } from './hooks/useSelection'
import { useEditorStore } from './store'
import type { CanvasNode, CncMetadata, GroupNode, PathNode } from './types/editor'

export interface ShapeRendererProps {
  nodeId: string
  registerNodeRef: (nodeId: string, node: Konva.Node | null) => void
  parentDimmed?: boolean
  interactionBlocked?: boolean
  showCncOverrides?: boolean
  outlineOnly?: boolean
  hitboxOnly?: boolean
  parentCncMetadata?: CncMetadata
  onNodeDragStart?: (nodeId: string, konvaNode: Konva.Node) => void
  onNodeDragMove?: (nodeId: string, konvaNode: Konva.Node) => void
  onNodeDragEnd?: (nodeId: string, konvaNode: Konva.Node) => void
}

const SCALLOP_BREATHE_MIN_OPACITY = 0.55
const SCALLOP_BREATHE_MAX_OPACITY = 0.95
const SCALLOP_BREATHE_CYCLE_MS = 900

function useBreathingOpacity(active: boolean): number {
  const [opacity, setOpacity] = useState(1)

  useEffect(() => {
    if (!active) {
      setOpacity(1)
      return
    }

    let frameId = 0

    const tick = (now: number) => {
      const phase = (now % SCALLOP_BREATHE_CYCLE_MS) / SCALLOP_BREATHE_CYCLE_MS
      const wave = (Math.sin(phase * Math.PI * 2) + 1) / 2
      setOpacity(
        SCALLOP_BREATHE_MIN_OPACITY +
        (SCALLOP_BREATHE_MAX_OPACITY - SCALLOP_BREATHE_MIN_OPACITY) * wave,
      )
      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [active])

  return opacity
}

interface SharedShapeProps {
  node: CanvasNode
  opacity: number
  listening: boolean
  draggable: boolean
  isSelected: boolean
  activeInteractionMode: 'group' | 'direct'
  showCncOverrides?: boolean
  outlineOnly?: boolean
  hitboxOnly?: boolean
  parentCncMetadata?: CncMetadata
  toolDiameter?: number
  viewportScale?: number
  registerNodeRef: (nodeId: string, node: Konva.Node | null) => void
  onPointerDown: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void
  onClick: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void
  onDoubleClick: (event: KonvaEventObject<MouseEvent | TouchEvent>) => void
  onDragStart: (event: KonvaEventObject<DragEvent>) => void
  onDragMove: (event: KonvaEventObject<DragEvent>) => void
  onDragEnd: (event: KonvaEventObject<DragEvent>) => void
}

const MIN_PLUNGE_HIT_DIAMETER_PX = 18

function SvgPathNode({
  node,
  opacity,
  listening,
  draggable,
  isSelected,
  activeInteractionMode,
  showCncOverrides,
  outlineOnly,
  parentCncMetadata,
  toolDiameter,
  viewportScale,
  registerNodeRef,
  onPointerDown,
  onClick,
  onDoubleClick,
  onDragStart,
  onDragMove,
  onDragEnd,
}: SharedShapeProps & { node: PathNode }) {
  const cncOverrides = showCncOverrides !== false
    ? getCncVisualOverrides(node, node.cncMetadata, parentCncMetadata)
    : {}
  const isOpenPath = toolDiameter != null && isOpenPathNode(node)
  const useCncStroke = isOpenPath && showCncOverrides !== false
  const cncStrokeWidth = toolDiameter != null && viewportScale ? toolDiameter / viewportScale : toolDiameter
  const baseStrokeWidth = useCncStroke ? cncStrokeWidth! : node.strokeWidth
  const baseStroke = useCncStroke && !node.stroke ? 'rgba(30, 20, 10, 0.65)' : node.stroke
  const visualProps = Object.assign(
    { fill: outlineOnly ? '' : node.fill, stroke: baseStroke, strokeWidth: baseStrokeWidth },
    cncOverrides,
  )
  if (outlineOnly && !cncOverrides.fill) {
    delete visualProps.fill
  }
  if (isSelected && !outlineOnly) {
    visualProps.stroke = '#0d99ff'
    if (!visualProps.strokeWidth) visualProps.strokeWidth = 1.5
  }

  // In direct selection mode, only hit-test the stroke so enclosed areas don't occlude inner paths
  // (Konva fills the hit canvas for ALL closed paths, even those with fill:none)
  // We intercept fillShape (not fillStrokeShape) so strokeShape still runs through
  // its normal code path inside fillStrokeShape — preserving exact transform/coordinate handling
  const strokeOnlyHitFunc = activeInteractionMode === 'direct'
    ? (context: any, shape: any) => {
        const origFill = context.fillShape
        context.fillShape = () => {}
        shape._sceneFunc(context)
        context.fillShape = origFill
      }
    : undefined

  // Plunge points: render a circle showing the tool diameter footprint
  const effectiveMeta = mergeCncMetadata(node.cncMetadata, parentCncMetadata)
  const isPlunge = normalizeEngraveType(effectiveMeta?.engraveType) === 'plunge'
  const renderHint = node.renderHint?.kind === 'plungeCircle' ? node.renderHint : undefined
  const plungeDiameter = renderHint?.diameter ?? toolDiameter ?? 0
  const plungeRadius = plungeDiameter / 2
  const plungeCenterX = renderHint?.centerX ?? plungeRadius
  const plungeCenterY = renderHint?.centerY ?? plungeRadius
  const plungeHitRadius = Math.max(
    plungeRadius,
    MIN_PLUNGE_HIT_DIAMETER_PX / Math.max((viewportScale ?? 1) * 2, 0.0001),
  )

  if (isPlunge && plungeRadius > 0) {
    const neutralStroke = isSelected ? '#0d99ff' : 'rgba(74, 52, 30, 0.72)'
    const neutralFill = outlineOnly ? undefined : (isSelected ? 'rgba(13, 153, 255, 0.14)' : 'rgba(74, 52, 30, 0.16)')
    const plungeStroke = showCncOverrides !== false
      ? (visualProps.stroke || '#0d99ff')
      : neutralStroke
    const plungeFill = showCncOverrides !== false
      ? (outlineOnly ? undefined : (visualProps.fill || 'rgba(60, 130, 240, 0.35)'))
      : neutralFill

    return (
      <Group
        ref={(instance) => registerNodeRef(node.id, instance)}
        id={node.id}
        x={node.x}
        y={node.y}
        rotation={node.rotation}
        scaleX={node.scaleX}
        scaleY={node.scaleY}
        draggable={draggable}
        visible={node.visible}
        opacity={opacity}
        listening={listening}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        onClick={onClick}
        onTap={onClick}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      >
        <Circle
          x={plungeCenterX}
          y={plungeCenterY}
          radius={plungeHitRadius}
          fill="rgba(0,0,0,0.01)"
          strokeEnabled={false}
        />
        <Circle
          x={plungeCenterX}
          y={plungeCenterY}
          radius={plungeRadius}
          fill={plungeFill}
          fillEnabled={Boolean(plungeFill)}
          stroke={plungeStroke}
          strokeWidth={isSelected ? 1.5 : 0.5}
          listening={false}
        />
        <Line
          points={[
            plungeCenterX - plungeRadius * 0.5,
            plungeCenterY,
            plungeCenterX + plungeRadius * 0.5,
            plungeCenterY,
          ]}
          stroke={plungeStroke}
          strokeWidth={0.3}
          listening={false}
        />
        <Line
          points={[
            plungeCenterX,
            plungeCenterY - plungeRadius * 0.5,
            plungeCenterX,
            plungeCenterY + plungeRadius * 0.5,
          ]}
          stroke={plungeStroke}
          strokeWidth={0.3}
          listening={false}
        />
      </Group>
    )
  }

  return (
    <Path
      ref={(instance) => registerNodeRef(node.id, instance)}
      id={node.id}
      x={node.x}
      y={node.y}
      data={node.data}
      rotation={node.rotation}
      scaleX={node.scaleX}
      scaleY={node.scaleY}
      draggable={draggable}
      visible={node.visible}
      opacity={opacity}
      listening={listening}
      hitStrokeWidth={Math.max((baseStrokeWidth ?? 2) * 2, 12)}
      hitFunc={strokeOnlyHitFunc}
      {...visualProps}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
      onClick={onClick}
      onTap={onClick}
      onDblClick={onDoubleClick}
      onDblTap={onDoubleClick}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
    />
  )
}

export function ShapeRenderer({
  nodeId,
  registerNodeRef,
  parentDimmed = false,
  interactionBlocked = false,
  showCncOverrides = true,
  outlineOnly = false,
  hitboxOnly = false,
  parentCncMetadata,
  onNodeDragStart,
  onNodeDragMove,
  onNodeDragEnd,
}: ShapeRendererProps) {
  const node = useEditorStore((state) => state.nodesById[nodeId])
  const nodesById = useEditorStore((state) => state.nodesById)
  const focusGroupId = useEditorStore((state) => state.focusGroupId)
  const interactionMode = useEditorStore((state) => state.interactionMode)
  const directSelectionModifierActive = useEditorStore((state) => state.directSelectionModifierActive)
  const pendingImport = useEditorStore((state) => state.ui.pendingImport)
  const isTransforming = useEditorStore((state) => state.ui.isTransforming)
  const eyedropperMode = useEditorStore((state) => state.eyedropperMode)
  const applyEyedropperPick = useEditorStore((state) => state.applyEyedropperPick)
  const toolDiameter = useEditorStore((state) => state.machiningSettings.toolDiameter)
  const viewportScale = useEditorStore((state) => state.viewport.scale)
  const updateNodeTransform = useEditorStore((state) => state.updateNodeTransform)
  const { enterFocusMode, isSelected, selectNode } = useSelection()

  if (!node || !node.visible) {
    return null
  }

  const activeInteractionMode = getEffectiveInteractionMode(interactionMode, directSelectionModifierActive)
  const effectiveFocusGroupId = getEffectiveFocusGroupId(
    focusGroupId,
    interactionMode,
    directSelectionModifierActive,
  )
  const effectiveRenderMode = getFocusRenderMode(nodeId, effectiveFocusGroupId, nodesById)
  const isDimmed = parentDimmed || effectiveRenderMode === 'dimmed'
  const centerlineOpacity = node.centerlineMetadata?.enabled ? 0.2 : 1
  const opacity = hitboxOnly ? 0 : (isDimmed ? node.opacity * 0.22 : node.opacity) * centerlineOpacity
  const resolvedSelectionTarget = resolveSelectionTarget(
    node.id,
    nodesById,
    effectiveFocusGroupId,
    activeInteractionMode,
  )

  const listening = !pendingImport && !isDimmed
  const isDirectlyInteractive =
    activeInteractionMode === 'direct' || resolvedSelectionTarget === node.id
  const draggable =
    listening &&
    !interactionBlocked &&
    isDirectlyInteractive &&
    node.draggable &&
    !node.locked &&
    !(activeInteractionMode === 'direct' && node.type === 'group')

  const onPointerDown = (event: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (eyedropperMode !== 'off') {
      if ('button' in event.evt && event.evt.button !== 0) return
      event.cancelBubble = true
      window.dispatchEvent(new CustomEvent('editor-eyedropper-pick'))
      applyEyedropperPick(node.id)
      return
    }
    if (!listening || interactionBlocked) return
    if ('button' in event.evt && event.evt.button !== 0) return
    if (!isDirectlyInteractive) return

    const additive = 'shiftKey' in event.evt ? event.evt.shiftKey || event.evt.ctrlKey : false
    if (!additive && isSelected(resolvedSelectionTarget)) {
      event.cancelBubble = true
      return
    }

    selectNode(node.id, additive)
    event.cancelBubble = true
  }

  const onClick = (event: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!listening || !isDirectlyInteractive || interactionBlocked) return
    if ('button' in event.evt && event.evt.button !== 0) return
    event.cancelBubble = true
  }

  const onDoubleClick = (event: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!listening || !isDirectlyInteractive || interactionBlocked) return
    if ('button' in event.evt && event.evt.button !== 0) return
    event.cancelBubble = true
    if (activeInteractionMode === 'direct') return
    enterFocusMode(node.id)
  }

  const onDragStart = (event: KonvaEventObject<DragEvent>) => {
    event.cancelBubble = true
    onNodeDragStart?.(node.id, event.target as Konva.Node)
  }

  const onDragMove = (event: KonvaEventObject<DragEvent>) => {
    event.cancelBubble = true
    onNodeDragMove?.(node.id, event.target as Konva.Node)
  }

  const onDragEnd = (event: KonvaEventObject<DragEvent>) => {
    event.cancelBubble = true
    if (onNodeDragEnd) {
      onNodeDragEnd(node.id, event.target as Konva.Node)
      return
    }

    updateNodeTransform(node.id, { x: event.target.x(), y: event.target.y() })
  }

  const commonProps = {
    node,
    opacity,
    listening,
    draggable,
    isSelected: isSelected(node.id),
    activeInteractionMode,
    showCncOverrides,
    outlineOnly,
    hitboxOnly,
    parentCncMetadata,
    toolDiameter,
    viewportScale,
    registerNodeRef,
    onPointerDown,
    onClick,
    onDoubleClick,
    onDragStart,
    onDragMove,
    onDragEnd,
  }

  const shouldBreatheWhileTransforming =
    node.type === 'group' &&
    node.generatorMetadata?.params.kind === 'scallopFrame' &&
    isTransforming &&
    commonProps.isSelected &&
    !hitboxOnly

  const breathingOpacity = useBreathingOpacity(shouldBreatheWhileTransforming)

  if (node.type === 'group') {
    const groupNode = node as GroupNode

    return (
      <Group
        ref={(instance) => registerNodeRef(node.id, instance)}
        id={node.id}
        x={groupNode.x}
        y={groupNode.y}
        rotation={groupNode.rotation}
        scaleX={groupNode.scaleX}
        scaleY={groupNode.scaleY}
        draggable={draggable}
        visible={groupNode.visible}
        opacity={opacity * breathingOpacity}
        listening={listening}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        onClick={onClick}
        onTap={onClick}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      >
        {groupNode.childIds.map((childId) => (
          <ShapeRenderer
            key={childId}
            nodeId={childId}
            registerNodeRef={registerNodeRef}
            parentDimmed={isDimmed}
            interactionBlocked={interactionBlocked}
            showCncOverrides={showCncOverrides}
            outlineOnly={outlineOnly}
            parentCncMetadata={mergeCncMetadata(groupNode.cncMetadata, parentCncMetadata)}
            onNodeDragStart={onNodeDragStart}
            onNodeDragMove={onNodeDragMove}
            onNodeDragEnd={onNodeDragEnd}
            hitboxOnly={hitboxOnly}
          />
        ))}
      </Group>
    )
  }

  if (node.type === 'rect') {
    const cncOverrides = showCncOverrides
      ? getCncVisualOverrides(node, node.cncMetadata, parentCncMetadata)
      : {}
    const visualProps: { fill?: string; stroke?: string; strokeWidth?: number } = Object.assign(
      { fill: outlineOnly ? '' : node.fill, stroke: node.stroke, strokeWidth: node.strokeWidth },
      cncOverrides,
    )
    if (outlineOnly && !cncOverrides.fill) {
      visualProps.fill = undefined
    }
    if (commonProps.isSelected && !outlineOnly) {
      visualProps.stroke = '#0d99ff'
      if (!visualProps.strokeWidth) visualProps.strokeWidth = 1.5
    }

    const rectStrokeOnlyHitFunc = activeInteractionMode === 'direct'
      ? (context: any, shape: any) => {
          const origFill = context.fillShape
          context.fillShape = () => {}
          shape._sceneFunc(context)
          context.fillShape = origFill
        }
      : undefined

    return (
      <Rect
        ref={(instance) => registerNodeRef(node.id, instance)}
        id={node.id}
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        cornerRadius={node.cornerRadius}
        rotation={node.rotation}
        scaleX={node.scaleX}
        scaleY={node.scaleY}
        draggable={draggable}
        visible={node.visible}
        opacity={opacity}
        listening={listening}
        hitFunc={rectStrokeOnlyHitFunc}
        hitStrokeWidth={activeInteractionMode === 'direct' ? 12 : undefined}
        {...visualProps}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        onClick={onClick}
        onTap={onClick}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    )
  }

  if (node.type === 'circle') {
    const cncOverrides = showCncOverrides
      ? getCncVisualOverrides(node, node.cncMetadata, parentCncMetadata)
      : {}
    const visualProps = Object.assign(
      { fill: node.fill, stroke: node.stroke, strokeWidth: node.strokeWidth },
      cncOverrides,
    )
    if (commonProps.isSelected) {
      visualProps.stroke = '#0d99ff'
      if (!visualProps.strokeWidth) visualProps.strokeWidth = 1.5
    }

    const circleStrokeOnlyHitFunc = activeInteractionMode === 'direct'
      ? (context: any, shape: any) => {
          const origFill = context.fillShape
          context.fillShape = () => {}
          shape._sceneFunc(context)
          context.fillShape = origFill
        }
      : undefined

    return (
      <Circle
        ref={(instance) => registerNodeRef(node.id, instance)}
        id={node.id}
        x={node.x}
        y={node.y}
        radius={node.radius}
        rotation={node.rotation}
        scaleX={node.scaleX}
        scaleY={node.scaleY}
        draggable={draggable}
        visible={node.visible}
        opacity={opacity}
        listening={listening}
        hitFunc={circleStrokeOnlyHitFunc}
        hitStrokeWidth={activeInteractionMode === 'direct' ? 12 : undefined}
        {...visualProps}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        onClick={onClick}
        onTap={onClick}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    )
  }

  if (node.type === 'line') {
    const cncOverrides = showCncOverrides
      ? getCncVisualOverrides(node, node.cncMetadata, parentCncMetadata)
      : {}
    const isOpenPath = toolDiameter != null && isOpenPathNode(node)
    const useCncStroke = isOpenPath && showCncOverrides
    const cncStrokeWidth = toolDiameter != null ? toolDiameter / viewportScale : toolDiameter
    const baseStrokeWidth = useCncStroke ? cncStrokeWidth! : node.strokeWidth
    const baseStroke = useCncStroke && !node.stroke ? 'rgba(30, 20, 10, 0.65)' : node.stroke
    const visualProps = Object.assign(
      {
        stroke: baseStroke,
        strokeWidth: baseStrokeWidth,
        fill: node.fill,
        lineCap: useCncStroke ? 'round' : node.lineCap,
        lineJoin: useCncStroke ? 'round' : node.lineJoin,
      },
      cncOverrides,
    )
    const hitWidth = Math.max((baseStrokeWidth ?? 2) * 2, 12)

    if (commonProps.isSelected && !outlineOnly) {
      visualProps.stroke = '#0d99ff'
      if (!visualProps.strokeWidth) visualProps.strokeWidth = 1.5
    }

    const lineStrokeOnlyHitFunc = activeInteractionMode === 'direct' && node.closed
      ? (context: any, shape: any) => {
          const origFill = context.fillShape
          context.fillShape = () => {}
          shape._sceneFunc(context)
          context.fillShape = origFill
        }
      : undefined

    return (
      <Line
        ref={(instance) => registerNodeRef(node.id, instance)}
        id={node.id}
        x={node.x}
        y={node.y}
        points={node.points}
        closed={node.closed}
        fillRule={node.fillRule}
        rotation={node.rotation}
        scaleX={node.scaleX}
        scaleY={node.scaleY}
        draggable={draggable}
        visible={node.visible}
        opacity={opacity}
        listening={listening}
        hitStrokeWidth={hitWidth}
        hitFunc={lineStrokeOnlyHitFunc}
        {...visualProps}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        onClick={onClick}
        onTap={onClick}
        onDblClick={onDoubleClick}
        onDblTap={onDoubleClick}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    )
  }

  return <SvgPathNode {...commonProps} node={node} />
}

export interface EngravePreviewStackProps {
  rootIds: string[]
  defaultDepth: number | null
  toolDiameter: number
  registerNodeRef: (nodeId: string, node: Konva.Node | null) => void
  interactionBlocked?: boolean
  showCncOverrides?: boolean
  outlineOnly?: boolean
  onNodeDragStart?: (nodeId: string, konvaNode: Konva.Node) => void
  onNodeDragMove?: (nodeId: string, konvaNode: Konva.Node) => void
  onNodeDragEnd?: (nodeId: string, konvaNode: Konva.Node) => void
}

export function EngravePreviewStack({
  rootIds,
  defaultDepth,
  toolDiameter,
  registerNodeRef,
  interactionBlocked,
  showCncOverrides = true,
  outlineOnly = false,
  onNodeDragStart,
  onNodeDragMove,
  onNodeDragEnd,
}: EngravePreviewStackProps) {
  const nodesById = useEditorStore((state) => state.nodesById)
  const nodeVersion = useEditorStore((state) => state.nodeVersion)
  const previewPlan = useMemo(
    () => buildDepthPreviewPlan(rootIds, nodesById, defaultDepth, toolDiameter),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeVersion is a stable proxy for nodesById changes
    [defaultDepth, rootIds, nodeVersion, toolDiameter],
  )

  return (
    <>
      {previewPlan.layers.map(({ depth, mode, pathData }) =>
        pathData ? (
          <Path
            key={`depth-layer-${depth}-${mode}`}
            data={pathData}
            fill={getEngravePreviewFill(depth)}
            fillEnabled={true}
            stroke={getEngravePreviewStroke(depth)}
            strokeEnabled={showCncOverrides}
            strokeWidth={showCncOverrides ? 1 : 0}
            globalCompositeOperation="multiply"
            listening={false}
          />
        ) : null,
      )}

      {previewPlan.strokeShapes.map((shape) => (
        <Line
          key={`depth-stroke-${shape.sourceNodeId}`}
          points={shape.points}
          stroke={getEngravePreviewStroke(shape.depth)}
          strokeWidth={shape.strokeWidth}
          lineCap="round"
          lineJoin="round"
          globalCompositeOperation="multiply"
          listening={false}
        />
      ))}

      {previewPlan.interactiveRootIds.map((nodeId) => (
        <ShapeRenderer
          key={`depth-hitbox-${nodeId}`}
          nodeId={nodeId}
          registerNodeRef={registerNodeRef}
          interactionBlocked={interactionBlocked}
          showCncOverrides={false}
          hitboxOnly={true}
          onNodeDragStart={onNodeDragStart}
          onNodeDragMove={onNodeDragMove}
          onNodeDragEnd={onNodeDragEnd}
        />
      ))}

      {previewPlan.passthroughRootIds.map((nodeId) => (
        <ShapeRenderer
          key={`depth-passthrough-${nodeId}`}
          nodeId={nodeId}
          registerNodeRef={registerNodeRef}
          interactionBlocked={interactionBlocked}
          showCncOverrides={showCncOverrides}
          outlineOnly={outlineOnly}
          onNodeDragStart={onNodeDragStart}
          onNodeDragMove={onNodeDragMove}
          onNodeDragEnd={onNodeDragEnd}
        />
      ))}
    </>
  )
}
