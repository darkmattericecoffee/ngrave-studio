import { create } from 'zustand'

import { getAncestorIds, getSelectableIdsInScope, getSubtreeIds, isGroupNode } from './lib/editorTree'
import { normalizeGeneratorParams, runGenerator, supportsGeneratorResizeBack } from './lib/generators'
import { resolveParamsAgainstTool } from './lib/generators'
import { getNodeSize } from './lib/nodeDimensions'
import { importSvgToScene } from './lib/svgImport'
import type {
  ArtboardState,
  BasicShapeKind,
  CanvasNode,
  CenterlineMetadata,
  CncMetadata,
  EngraveType,
  EyedropperMode,
  GeneratorParams,
  GridMetadata,
  GroupNode,
  ImportStatus,
  InteractionMode,
  Job,
  MachiningSettings,
  MarqueeRect,
  PathAnchor,
  PendingSvgImport,
  RenderHint,
  ViewportState,
} from './types/editor'
import { parseGcodeProgram } from '@svg2gcode/bridge/viewer'
import { groupSegments, computeGroupSweep } from './components/preview/segmentsToToolpaths'
import { insertTabs } from './lib/gcodeTabInsertion'
import type { CameraType, PreviewState, ToolpathGroup, ViewMode } from './types/preview'
import { DEFAULT_MATERIAL } from './lib/materialPresets'
import type { MaterialPreset } from './lib/materialPresets'
import { getAutoImportPlacement } from './lib/importPlacement'
import { DEFAULT_CENTERLINE_METADATA, normalizeCenterlineMetadata } from './lib/centerline'

type HistorySnapshot = {
  nodesById: Record<string, CanvasNode>
  rootIds: string[]
  selectedIds: string[]
  artboard: ArtboardState
}

const MAX_HISTORY = 50

type ImportFocusRequest = {
  requestId: number
  rect: MarqueeRect
}

let nextImportFocusRequestId = 1

export interface EditorStore {
  nodesById: Record<string, CanvasNode>
  rootIds: string[]
  selectedIds: string[]
  selectedStage: boolean
  focusGroupId: string | null
  interactionMode: InteractionMode
  directSelectionModifierActive: boolean
  clipboard: { rootIds: string[]; nodesById: Record<string, CanvasNode> } | null
  history: { past: HistorySnapshot[]; future: HistorySnapshot[] }
  artboard: ArtboardState
  machiningSettings: MachiningSettings
  viewport: ViewportState
  ui: {
    marquee: MarqueeRect | null
    isTransforming: boolean
    pendingImport: PendingSvgImport | null
    importFocusRequest: ImportFocusRequest | null
    importStatus: ImportStatus | null
    /** NodeId of a text generator whose content input should be focused by the Inspector. */
    focusTextRequestId: string | null
    /** NodeId of a text generator currently being edited inline on the canvas. */
    editingTextNodeId: string | null
  }
  nodeVersion: number
  hoveredId: string | null
  hoveredPathAnchor: PathAnchor | null
  /** Currently-focused job for the inspector's per-job anchor picker. */
  selectedJobId: string | null
  /** Which tab of the layer panel is active. Canvas reads this to gate the
   *  job overlays (they only render on the Cut Order tab). */
  layerPanelView: 'layers' | 'cutOrder'
  setLayerPanelView: (view: 'layers' | 'cutOrder') => void
  eyedropperMode: EyedropperMode
  eyedropperSourceNodeId: string | null
  setHoveredId: (id: string | null) => void
  setHoveredPathAnchor: (anchor: PathAnchor | null) => void
  setSelectedJob: (id: string | null) => void
  /** Patch a single job inside `manualJobs`. If no manual override exists yet,
   *  `seedFromAuto` must supply the current auto-derived partition to pin. */
  updateJob: (id: string, patch: Partial<Job>, seedFromAuto?: Job[]) => void
  /** Replace the entire manual partition. Pass `null` to revert to auto. */
  commitManualJobs: (jobs: Job[] | null) => void
  setEyedropperMode: (mode: EyedropperMode) => void
  applyEyedropperPick: (clickedNodeId: string) => void
  setInteractionMode: (mode: InteractionMode) => void
  setDirectSelectionModifierActive: (active: boolean) => void
  setFocusGroup: (groupId: string | null) => void
  clearFocusGroup: () => void
  selectStage: () => void
  selectOne: (id: string) => void
  selectMany: (ids: string[]) => void
  toggleSelection: (id: string) => void
  clearSelection: () => void
  updateNodeTransform: (
    nodeId: string,
    patch: Partial<CanvasNode>,
  ) => void
  updateCncMetadata: (nodeId: string, patch: Partial<CncMetadata>) => void
  updateCncMetadataMany: (nodeIds: string[], patch: Partial<CncMetadata>) => void
  pushHistory: () => void
  undo: () => void
  redo: () => void
  deleteSelected: () => void
  copySelected: () => void
  cutSelected: () => void
  pasteClipboard: () => void
  groupSelected: () => void
  ungroupSelected: () => void
  orderSelected: (direction: 'forward' | 'backward' | 'front' | 'back') => void
  rotateSelected: (degrees: number) => void
  renameNode: (nodeId: string, nextName: string) => void
  setSelectedEngraveType: (engraveType: Extract<EngraveType, 'contour' | 'pocket'>) => void
  duplicateSelected: (offsetX?: number, offsetY?: number) => void
  duplicateInPlace: () => void
  selectAll: () => void
  setArtboardSize: (patch: Partial<ArtboardState>) => void
  setMachiningSettings: (patch: Partial<MachiningSettings>) => void
  setViewport: (patch: Partial<ViewportState>) => void
  resetViewport: () => void
  setMarquee: (marquee: MarqueeRect | null) => void
  setIsTransforming: (isTransforming: boolean) => void
  stagePendingImport: (pendingImport: PendingSvgImport) => void
  clearPendingImport: () => void
  placePendingImport: (
    position: { x: number; y: number },
    options?: { focusViewport?: boolean },
  ) => void
  clearImportFocusRequest: (requestId: number) => void
  setImportStatus: (status: ImportStatus | null) => void
  requestFocusText: (nodeId: string) => void
  consumeFocusTextRequest: () => void
  startEditingText: (nodeId: string) => void
  stopEditingText: () => void

  // Library tab
  leftPanelTab: 'layers' | 'library'
  setLeftPanelTab: (tab: 'layers' | 'library') => void
  placeGenerator: (params: GeneratorParams, position?: { x: number; y: number }) => void
  placeShape: (kind: BasicShapeKind, position?: { x: number; y: number }) => void
  updateGeneratorParams: (
    nodeId: string,
    params: GeneratorParams,
    options?: {
      groupPatch?: Partial<GroupNode>
      skipHistory?: boolean
    },
  ) => void

  // Alignment
  alignSelectedNodes: (direction: 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY') => void

  // Grid/Repeat
  enableGrid: (nodeId: string) => void
  disableGrid: (nodeId: string) => void
  updateGridMetadata: (nodeId: string, patch: Partial<GridMetadata>) => void

  // Centerlines
  enableCenterline: (nodeId: string) => void
  disableCenterline: (nodeId: string) => void
  updateCenterlineMetadata: (nodeId: string, patch: Partial<CenterlineMetadata>) => void
  /** Node IDs whose centerline overlay is currently being AI-streamed (drives canvas breathing animation) */
  aiSmoothStreamingIds: string[]
  setAiSmoothStreamingIds: (ids: string[]) => void

  // Preview state
  preview: PreviewState
  setViewMode: (mode: ViewMode) => void
  setCameraType: (type: CameraType) => void
  setPlaybackDistance: (distance: number) => void
  setIsPlaying: (playing: boolean) => void
  togglePlayback: () => void
  setPlaybackRate: (rate: number) => void
  setLoopPlayback: (loop: boolean) => void
  setShowSvgOverlay: (show: boolean) => void
  setShowStock: (show: boolean) => void
  setShowRapidMoves: (show: boolean) => void
  setShowCutOrder: (show: boolean) => void
  setShowJobOrder: (show: boolean) => void
  setMaterialPreset: (preset: MaterialPreset) => void
  setSceneReady: (ready: boolean) => void
  initPreview: (result: import('@svg2gcode/bridge').GenerateJobResponse) => Promise<void>
  clearPreview: () => void

  // Prepare tab UI state
  prepareShowCutNumbers: boolean
  setPrepareShowCutNumbers: (show: boolean) => void
  prepareExportCutNumbers: boolean
  setPrepareExportCutNumbers: (show: boolean) => void
  prepareJobPlayback: { isPlaying: boolean; currentJobIndex: number; rate: number; loop: boolean }
  toggleJobPlayback: () => void
  setJobPlaybackPlaying: (playing: boolean) => void
  setCurrentJobIndex: (index: number) => void
  setJobPlaybackRate: (rate: number) => void
  setJobPlaybackLoop: (loop: boolean) => void
}

function generateId(): string {
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function buildPlungeCircleRenderHint(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  diameter: number,
): RenderHint | undefined {
  if (node.type === 'group' || diameter <= 0) {
    return undefined
  }

  const { baseWidth, baseHeight } = getNodeSize(node, nodesById)
  if (baseWidth <= 0 || baseHeight <= 0) {
    return undefined
  }

  return {
    kind: 'plungeCircle',
    diameter,
    centerX: baseWidth / 2,
    centerY: baseHeight / 2,
  }
}

function circlePathData(diameter: number): string {
  const radius = diameter / 2
  return [
    `M ${diameter} ${radius}`,
    `A ${radius} ${radius} 0 1 0 0 ${radius}`,
    `A ${radius} ${radius} 0 1 0 ${diameter} ${radius}`,
    'Z',
  ].join(' ')
}

function getBasicShapeSize(kind: BasicShapeKind): { width: number; height: number } {
  if (kind === 'circle') {
    return { width: 64, height: 64 }
  }

  if (kind === 'triangle') {
    return { width: 88, height: 72 }
  }

  return { width: 96, height: 64 }
}

function getCenteredPlacement(
  center: { x: number; y: number },
  width: number,
  height: number,
  artboard: ArtboardState,
): { x: number; y: number } {
  return {
    x: clamp(center.x - width / 2, 0, Math.max(0, artboard.width - width)),
    y: clamp(center.y - height / 2, 0, Math.max(0, artboard.height - height)),
  }
}

function createBasicShapeNode(
  kind: BasicShapeKind,
  position: { x: number; y: number },
  defaultDepthMm: number,
): CanvasNode {
  const id = generateId()
  const { width, height } = getBasicShapeSize(kind)
  const base = {
    id,
    name: kind === 'rectangle' ? 'Rectangle' : kind === 'circle' ? 'Circle' : 'Triangle',
    x: position.x,
    y: position.y,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId: null,
    cncMetadata: {
      cutDepth: defaultDepthMm,
      engraveType: 'contour' as const,
    },
  }

  if (kind === 'rectangle') {
    return {
      ...base,
      type: 'rect',
      width,
      height,
      fill: '',
      stroke: '#121212',
      strokeWidth: 1,
      cornerRadius: 0,
    }
  }

  if (kind === 'circle') {
    return {
      ...base,
      type: 'path',
      data: circlePathData(width),
      fill: '',
      stroke: '#121212',
      strokeWidth: 1,
      fillRule: 'nonzero',
    }
  }

  return {
    ...base,
    type: 'line',
    points: [0, height, width / 2, 0, width, height],
    closed: true,
    fill: '',
    stroke: '#121212',
    strokeWidth: 1,
    lineJoin: 'miter',
  }
}

function applyGeneratorRenderHints(
  pending: PendingSvgImport,
  params: GeneratorParams,
) {
  if (params.kind !== 'dowelHole' || !params.matchToolDiameter) {
    return
  }

  for (const node of Object.values(pending.nodesById)) {
    const renderHint = buildPlungeCircleRenderHint(node, pending.nodesById, params.diameter)
    if (renderHint) {
      node.renderHint = renderHint
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function resolveAnchoredAxisPosition(
  currentStart: number,
  currentSize: number,
  nextSize: number,
  containerSize: number,
  preferStartAnchor: boolean,
): number {
  const minStart = 0
  const maxStart = Math.max(0, containerSize - nextSize)
  const startAnchored = currentStart
  const endAnchored = currentStart + currentSize - nextSize
  const fits = (candidate: number) => candidate >= minStart && candidate <= maxStart

  if (preferStartAnchor) {
    if (fits(startAnchored)) return startAnchored
    if (fits(endAnchored)) return endAnchored
    return clamp(startAnchored, minStart, maxStart)
  }

  if (fits(endAnchored)) return endAnchored
  if (fits(startAnchored)) return startAnchored
  return clamp(endAnchored, minStart, maxStart)
}

function getAutoGeneratorGroupPatch(
  existingGroup: GroupNode,
  nodesById: Record<string, CanvasNode>,
  artboard: ArtboardState,
  nextWidth: number,
  nextHeight: number,
): Pick<GroupNode, 'x' | 'y'> {
  const currentSize = getNodeSize(existingGroup, nodesById)
  const currentWidth = currentSize.width
  const currentHeight = currentSize.height
  const currentRight = existingGroup.x + currentWidth
  const currentBottom = existingGroup.y + currentHeight
  const spaceLeft = existingGroup.x
  const spaceRight = artboard.width - currentRight
  const spaceAbove = existingGroup.y
  const spaceBelow = artboard.height - currentBottom

  const preferGrowLeft = spaceLeft > spaceRight
  const preferGrowUp = spaceAbove >= spaceBelow

  return {
    x: resolveAnchoredAxisPosition(
      existingGroup.x,
      currentWidth,
      nextWidth,
      artboard.width,
      !preferGrowLeft,
    ),
    y: resolveAnchoredAxisPosition(
      existingGroup.y,
      currentHeight,
      nextHeight,
      artboard.height,
      !preferGrowUp,
    ),
  }
}

function cloneSubtree(
  rootId: string,
  nodesById: Record<string, CanvasNode>,
  dx: number,
  dy: number,
  newParentId: string | null,
): { newRootId: string; clonedNodes: Record<string, CanvasNode> } {
  const root = nodesById[rootId]
  if (!root) return { newRootId: rootId, clonedNodes: {} }

  const newRootId = generateId()
  const clonedNodes: Record<string, CanvasNode> = {}

  if (root.type === 'group') {
    const childClones = root.childIds.map((childId) =>
      cloneSubtree(childId, nodesById, 0, 0, newRootId),
    )
    childClones.forEach((c) => Object.assign(clonedNodes, c.clonedNodes))
    clonedNodes[newRootId] = {
      ...root,
      id: newRootId,
      x: root.x + dx,
      y: root.y + dy,
      childIds: childClones.map((c) => c.newRootId),
      parentId: newParentId,
    }
  } else {
    clonedNodes[newRootId] = {
      ...root,
      id: newRootId,
      x: root.x + dx,
      y: root.y + dy,
      parentId: newParentId,
    } as CanvasNode
  }

  return { newRootId, clonedNodes }
}

type OrderingDirection = 'forward' | 'backward' | 'front' | 'back'

interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

function reorderSiblings(
  ids: string[],
  selected: Set<string>,
  direction: OrderingDirection,
): { ids: string[]; changed: boolean } {
  if (!ids.some((id) => selected.has(id))) {
    return { ids, changed: false }
  }

  if (direction === 'front') {
    const selectedIds = ids.filter((id) => selected.has(id))
    if (selectedIds.length === 0 || ids.slice(-selectedIds.length).every((id, index) => id === selectedIds[index])) {
      return { ids, changed: false }
    }
    return {
      ids: [...ids.filter((id) => !selected.has(id)), ...selectedIds],
      changed: true,
    }
  }

  if (direction === 'back') {
    const selectedIds = ids.filter((id) => selected.has(id))
    if (selectedIds.length === 0 || ids.slice(0, selectedIds.length).every((id, index) => id === selectedIds[index])) {
      return { ids, changed: false }
    }
    return {
      ids: [...selectedIds, ...ids.filter((id) => !selected.has(id))],
      changed: true,
    }
  }

  const nextIds = [...ids]
  let changed = false

  if (direction === 'forward') {
    for (let index = nextIds.length - 2; index >= 0; index -= 1) {
      if (selected.has(nextIds[index]) && !selected.has(nextIds[index + 1])) {
        ;[nextIds[index], nextIds[index + 1]] = [nextIds[index + 1], nextIds[index]]
        changed = true
      }
    }
  } else {
    for (let index = 1; index < nextIds.length; index += 1) {
      if (selected.has(nextIds[index]) && !selected.has(nextIds[index - 1])) {
        ;[nextIds[index - 1], nextIds[index]] = [nextIds[index], nextIds[index - 1]]
        changed = true
      }
    }
  }

  return { ids: changed ? nextIds : ids, changed }
}

function normalizeRotation(degrees: number): number {
  const normalized = degrees % 360
  return Object.is(normalized, -0) ? 0 : normalized
}

function nodeMatrix(node: CanvasNode): Matrix {
  const radians = (node.rotation ?? 0) * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const scaleX = node.scaleX ?? 1
  const scaleY = node.scaleY ?? 1

  return {
    a: cos * scaleX,
    b: sin * scaleX,
    c: -sin * scaleY,
    d: cos * scaleY,
    e: node.x,
    f: node.y,
  }
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  }
}

function transformPatchFromMatrix(matrix: Matrix): Pick<CanvasNode, 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY'> {
  const scaleX = Math.hypot(matrix.a, matrix.b) || 1
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  const scaleY = determinant / scaleX

  return {
    x: matrix.e,
    y: matrix.f,
    rotation: normalizeRotation(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI),
    scaleX,
    scaleY,
  }
}

const initialNodes: Record<string, CanvasNode> = {}

const initialRootIds: string[] = []
const initialViewport: ViewportState = {
  x: 0,
  y: 0,
  scale: 1,
}

function applyEyedropperToTargets(
  nodesById: Record<string, CanvasNode>,
  sourceNode: CanvasNode,
  targetIds: string[],
  eyedropperMode: EyedropperMode,
): Record<string, CanvasNode> {
  const nextNodes = { ...nodesById }
  const sourceIsGroup = sourceNode.type === 'group'

  for (const targetId of targetIds) {
    if (targetId === sourceNode.id) continue
    const target = nextNodes[targetId]
    if (!target) continue

    if (eyedropperMode === 'full' && !sourceIsGroup) {
      const patch: Record<string, unknown> = {}
      if (sourceNode.fill !== undefined && 'fill' in target) patch.fill = sourceNode.fill
      if (sourceNode.stroke !== undefined && 'stroke' in target) patch.stroke = sourceNode.stroke
      if (sourceNode.strokeWidth !== undefined && 'strokeWidth' in target) {
        patch.strokeWidth = sourceNode.strokeWidth
      }
      nextNodes[targetId] = {
        ...target,
        ...patch,
        cncMetadata: sourceNode.cncMetadata ? { ...sourceNode.cncMetadata } : target.cncMetadata,
      } as CanvasNode
    } else {
      nextNodes[targetId] = {
        ...target,
        cncMetadata: sourceNode.cncMetadata ? { ...sourceNode.cncMetadata } : target.cncMetadata,
      } as CanvasNode
    }
  }

  return nextNodes
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  nodesById: initialNodes,
  rootIds: initialRootIds,
  selectedIds: [],
  selectedStage: false,
  focusGroupId: null,
  interactionMode: 'group',
  directSelectionModifierActive: false,
  clipboard: null,
  history: { past: [], future: [] },
  artboard: {
    width: 600,
    height: 500,
    thickness: 18,
    x: 0,
    y: 0,
  },
  machiningSettings: {
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
    pathAnchor: 'BottomLeft',
    clusterDetourRadius: 5,
    circularInterpolation: true,
    cutOrderStrategy: 'auto',
    manualCutOrder: null,
    jobsEnabled: true,
    manualJobs: null,
    alignJobAnchors: true,
    alignJobAnchorsToleranceMm: 20,
  },
  viewport: initialViewport,
  ui: {
    marquee: null,
    isTransforming: false,
    pendingImport: null,
    importFocusRequest: null,
    importStatus: null,
    focusTextRequestId: null,
    editingTextNodeId: null,
  },
  nodeVersion: 0,
  hoveredId: null,
  hoveredPathAnchor: null,
  selectedJobId: null,
  layerPanelView: 'layers',
  eyedropperMode: 'off',
  eyedropperSourceNodeId: null,
  leftPanelTab: 'layers',
  setHoveredId: (id) => set({ hoveredId: id }),
  setHoveredPathAnchor: (anchor) => set({ hoveredPathAnchor: anchor }),
  setSelectedJob: (id) => set({ selectedJobId: id }),
  setLayerPanelView: (view) => set({ layerPanelView: view }),
  commitManualJobs: (jobs) => {
    set((state) => ({
      machiningSettings: { ...state.machiningSettings, manualJobs: jobs },
      // Drop the stale selection when the partition is reset.
      selectedJobId: jobs == null ? null : state.selectedJobId,
    }))
  },
  updateJob: (id, patch, seedFromAuto) => {
    set((state) => {
      const base = state.machiningSettings.manualJobs ?? seedFromAuto ?? null
      if (!base) return {}
      const next = base.map((j) => (j.id === id ? { ...j, ...patch } : j))
      return {
        machiningSettings: { ...state.machiningSettings, manualJobs: next },
      }
    })
  },
  setEyedropperMode: (mode) => set({
    eyedropperMode: mode,
    eyedropperSourceNodeId: null,
  }),
  applyEyedropperPick: (clickedNodeId) => {
    const { eyedropperMode, eyedropperSourceNodeId, selectedIds, nodesById } = get()
    if (eyedropperMode === 'off') return

    const clickedNode = nodesById[clickedNodeId]
    if (!clickedNode) {
      set({ eyedropperMode: 'off' })
      return
    }

    if (selectedIds.length > 0) {
      get().pushHistory()
      set((state) => ({
        nodesById: applyEyedropperToTargets(
          state.nodesById,
          clickedNode,
          state.selectedIds,
          state.eyedropperMode,
        ),
        eyedropperMode: 'off',
        eyedropperSourceNodeId: null,
      }))
      return
    }

    if (!eyedropperSourceNodeId) {
      set({ eyedropperSourceNodeId: clickedNodeId })
      return
    }

    if (eyedropperSourceNodeId === clickedNodeId) {
      return
    }

    const sourceNode = nodesById[eyedropperSourceNodeId]
    if (!sourceNode) {
      set({ eyedropperSourceNodeId: clickedNodeId })
      return
    }

    get().pushHistory()

    set((state) => ({
      nodesById: applyEyedropperToTargets(
        state.nodesById,
        sourceNode,
        [clickedNodeId],
        state.eyedropperMode,
      ),
      eyedropperMode: 'off',
      eyedropperSourceNodeId: null,
    }))
  },
  setInteractionMode: (mode) => {
    set({ interactionMode: mode })
  },
  setDirectSelectionModifierActive: (directSelectionModifierActive) => {
    set({ directSelectionModifierActive })
  },
  setFocusGroup: (groupId) => {
    set({
      focusGroupId: groupId,
      selectedIds: groupId ? [groupId] : [],
      selectedStage: false,
    })
  },
  clearFocusGroup: () => {
    set({ focusGroupId: null, selectedIds: [], selectedStage: false })
  },
  selectStage: () => {
    set({ selectedIds: [], selectedStage: true })
  },
  selectOne: (id) => {
    set({ selectedIds: [id], selectedStage: false })
  },
  selectMany: (ids) => {
    set({ selectedIds: Array.from(new Set(ids)), selectedStage: false })
  },
  toggleSelection: (id) => {
    const { selectedIds } = get()
    set({
      selectedIds: selectedIds.includes(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
      selectedStage: false,
    })
  },
  clearSelection: () => {
    set({ selectedIds: [], selectedStage: false })
  },
  updateNodeTransform: (nodeId, patch) => {
    set((state) => ({
      ...(state.nodesById[nodeId]
        ? {
            nodesById: {
              ...state.nodesById,
              [nodeId]: {
                ...state.nodesById[nodeId],
                ...patch,
              } as CanvasNode,
            },
          }
        : {}),
    }))
  },
  updateCncMetadata: (nodeId, patch) => {
    get().pushHistory()
    set((state) => {
      const existing = state.nodesById[nodeId]
      if (!existing) return {}
      return {
        nodesById: {
          ...state.nodesById,
          [nodeId]: {
            ...existing,
            cncMetadata: { ...existing.cncMetadata, ...patch },
          } as CanvasNode,
        },
      }
    })
  },
  updateCncMetadataMany: (nodeIds, patch) => {
    if (nodeIds.length === 0) return
    get().pushHistory()
    set((state) => {
      const nextNodes = { ...state.nodesById }
      let changed = false
      for (const id of nodeIds) {
        const existing = nextNodes[id]
        if (!existing) continue
        nextNodes[id] = {
          ...existing,
          cncMetadata: { ...existing.cncMetadata, ...patch },
        } as CanvasNode
        changed = true
      }
      return changed ? { nodesById: nextNodes } : {}
    })
  },
  pushHistory: () => {
    const { nodesById, rootIds, selectedIds, artboard } = get()
    const snapshot: HistorySnapshot = { nodesById, rootIds, selectedIds, artboard }
    set((state) => ({
      nodeVersion: state.nodeVersion + 1,
      history: {
        past: [...state.history.past.slice(-(MAX_HISTORY - 1)), snapshot],
        future: [],
      },
    }))
  },
  undo: () => {
    const { history, nodesById, rootIds, selectedIds, artboard } = get()
    if (history.past.length === 0) return
    const past = [...history.past]
    const snapshot = past.pop()!
    const current: HistorySnapshot = { nodesById, rootIds, selectedIds, artboard }
    set((state) => ({
      nodesById: snapshot.nodesById,
      rootIds: snapshot.rootIds,
      selectedIds: snapshot.selectedIds,
      artboard: snapshot.artboard,
      focusGroupId: null,
      nodeVersion: state.nodeVersion + 1,
      history: { past, future: [current, ...history.future] },
    }))
  },
  redo: () => {
    const { history, nodesById, rootIds, selectedIds, artboard } = get()
    if (history.future.length === 0) return
    const [snapshot, ...future] = history.future
    const current: HistorySnapshot = { nodesById, rootIds, selectedIds, artboard }
    set((state) => ({
      nodesById: snapshot.nodesById,
      rootIds: snapshot.rootIds,
      selectedIds: snapshot.selectedIds,
      artboard: snapshot.artboard,
      focusGroupId: null,
      nodeVersion: state.nodeVersion + 1,
      history: { past: [...history.past, current], future },
    }))
  },
  deleteSelected: () => {
    const { nodesById, rootIds, selectedIds } = get()
    if (selectedIds.length === 0) {
      return
    }

    get().pushHistory()

    const idsToDelete = new Set<string>()
    selectedIds.forEach((id) => {
      getSubtreeIds(id, nodesById).forEach((subtreeId) => {
        idsToDelete.add(subtreeId)
      })
    })

    const nextNodes = Object.fromEntries(
      Object.entries(nodesById)
        .filter(([id]) => !idsToDelete.has(id))
        .map(([id, node]) => {
          if (!isGroupNode(node)) {
            return [id, node]
          }

          return [
            id,
            {
              ...node,
              childIds: node.childIds.filter((childId) => !idsToDelete.has(childId)),
            },
          ]
        }),
    ) as Record<string, CanvasNode>

    const nextRootIds = rootIds.filter((id) => !idsToDelete.has(id))

    set({
      nodesById: nextNodes,
      rootIds: nextRootIds,
      selectedIds: [],
      selectedStage: false,
      focusGroupId:
        get().focusGroupId && idsToDelete.has(get().focusGroupId as string)
          ? null
          : get().focusGroupId,
    })
  },
  copySelected: () => {
    const { nodesById, selectedIds } = get()
    if (selectedIds.length === 0) return

    const clipboardNodesById: Record<string, CanvasNode> = {}
    selectedIds.forEach((id) => {
      getSubtreeIds(id, nodesById).forEach((subtreeId) => {
        clipboardNodesById[subtreeId] = { ...nodesById[subtreeId] }
      })
    })

    const clipboardRootIds = selectedIds.filter((id) => {
      const node = nodesById[id]
      return !node?.parentId || !selectedIds.includes(node.parentId)
    })

    set({ clipboard: { rootIds: clipboardRootIds, nodesById: clipboardNodesById } })
  },
  cutSelected: () => {
    const { selectedIds } = get()
    if (selectedIds.length === 0) return
    get().copySelected()
    get().deleteSelected()
  },
  pasteClipboard: () => {
    const { nodesById, rootIds, clipboard } = get()
    if (!clipboard) return

    get().pushHistory()

    const newRootIds: string[] = []
    const newNodesById: Record<string, CanvasNode> = {}

    clipboard.rootIds.forEach((rootId) => {
      const { newRootId, clonedNodes } = cloneSubtree(rootId, clipboard.nodesById, 20, 20, null)
      newRootIds.push(newRootId)
      Object.assign(newNodesById, clonedNodes)
    })

    set({
      nodesById: { ...nodesById, ...newNodesById },
      rootIds: [...rootIds, ...newRootIds],
      selectedIds: newRootIds,
      selectedStage: false,
    })
  },
  groupSelected: () => {
    const { nodesById, rootIds, selectedIds } = get()
    const selectedNodes = selectedIds
      .map((id) => nodesById[id])
      .filter((node): node is CanvasNode => Boolean(node))

    if (selectedNodes.length < 2) return

    const parentId = selectedNodes[0].parentId
    if (!selectedNodes.every((node) => node.parentId === parentId)) return

    const siblings = parentId ? (nodesById[parentId] as GroupNode | undefined)?.childIds : rootIds
    if (!siblings) return

    const selected = new Set(selectedIds)
    const groupedChildIds = siblings.filter((id) => selected.has(id))
    if (groupedChildIds.length < 2) return

    const groupX = Math.min(...groupedChildIds.map((id) => nodesById[id]?.x ?? 0))
    const groupY = Math.min(...groupedChildIds.map((id) => nodesById[id]?.y ?? 0))
    const groupId = generateId()
    const groupNode: GroupNode = {
      id: groupId,
      type: 'group',
      name: 'Group',
      x: groupX,
      y: groupY,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      draggable: true,
      locked: false,
      visible: true,
      opacity: 1,
      parentId,
      childIds: groupedChildIds,
    }

    const nextNodesById: Record<string, CanvasNode> = {
      ...nodesById,
      [groupId]: groupNode,
    }

    groupedChildIds.forEach((id) => {
      const child = nextNodesById[id]
      if (!child) return
      nextNodesById[id] = {
        ...child,
        x: child.x - groupX,
        y: child.y - groupY,
        parentId: groupId,
      } as CanvasNode
    })

    const nextSiblings = siblings.flatMap((id) => {
      if (id === groupedChildIds[0]) return [groupId]
      return selected.has(id) ? [] : [id]
    })

    if (parentId) {
      const parent = nextNodesById[parentId]
      if (!parent || parent.type !== 'group') return
      nextNodesById[parentId] = {
        ...parent,
        childIds: nextSiblings,
      }
      get().pushHistory()
      set({
        nodesById: nextNodesById,
        selectedIds: [groupId],
        selectedStage: false,
      })
      return
    }

    get().pushHistory()
    set({
      nodesById: nextNodesById,
      rootIds: nextSiblings,
      selectedIds: [groupId],
      selectedStage: false,
    })
  },
  ungroupSelected: () => {
    const { nodesById, rootIds, selectedIds, focusGroupId } = get()
    const selected = new Set(selectedIds)
    const selectedGroupIds = selectedIds.filter((id) => {
      const node = nodesById[id]
      return (
        node?.type === 'group' &&
        !getAncestorIds(id, nodesById).some((ancestorId) => selected.has(ancestorId))
      )
    })

    if (selectedGroupIds.length === 0) return

    const groupIds = new Set(selectedGroupIds)
    const nextNodesById: Record<string, CanvasNode> = { ...nodesById }
    let nextRootIds = rootIds
    const nextSelectedIds: string[] = []

    const expandSiblings = (siblings: string[]): { ids: string[]; changed: boolean } => {
      let changed = false
      const ids = siblings.flatMap((id) => {
        const group = nodesById[id]
        if (!groupIds.has(id) || group?.type !== 'group') {
          return [id]
        }

        changed = true
        nextSelectedIds.push(...(group as GroupNode).childIds)
        return (group as GroupNode).childIds
      })

      return { ids, changed }
    }

    const rootResult = expandSiblings(rootIds)
    if (rootResult.changed) {
      nextRootIds = rootResult.ids
    }

    for (const node of Object.values(nodesById)) {
      if (node.type !== 'group' || groupIds.has(node.id)) continue
      const result = expandSiblings((node as GroupNode).childIds)
      if (!result.changed) continue
      nextNodesById[node.id] = {
        ...(nextNodesById[node.id] as GroupNode),
        childIds: result.ids,
      }
    }

    for (const groupId of selectedGroupIds) {
      const group = nodesById[groupId]
      if (!group || group.type !== 'group') continue

      const groupMatrix = nodeMatrix(group)
      ;(group as GroupNode).childIds.forEach((childId) => {
        const child = nodesById[childId]
        if (!child) return
        nextNodesById[childId] = {
          ...child,
          ...transformPatchFromMatrix(multiplyMatrices(groupMatrix, nodeMatrix(child))),
          parentId: group.parentId,
          visible: group.visible && child.visible,
          locked: group.locked || child.locked,
          opacity: group.opacity * child.opacity,
          cncMetadata: group.cncMetadata
            ? { ...group.cncMetadata, ...child.cncMetadata }
            : child.cncMetadata,
        } as CanvasNode
      })

      delete nextNodesById[groupId]
    }

    get().pushHistory()
    set({
      nodesById: nextNodesById,
      rootIds: nextRootIds,
      selectedIds: nextSelectedIds,
      selectedStage: false,
      focusGroupId: focusGroupId && groupIds.has(focusGroupId) ? null : focusGroupId,
    })
  },
  orderSelected: (direction) => {
    const { nodesById, rootIds, selectedIds } = get()
    if (selectedIds.length === 0) return

    const selected = new Set(selectedIds)
    let nextRootIds = rootIds
    let nextNodesById = nodesById
    let changed = false

    const rootResult = reorderSiblings(rootIds, selected, direction)
    if (rootResult.changed) {
      nextRootIds = rootResult.ids
      changed = true
    }

    for (const node of Object.values(nodesById)) {
      if (node.type !== 'group') continue
      const result = reorderSiblings((node as GroupNode).childIds, selected, direction)
      if (!result.changed) continue

      if (nextNodesById === nodesById) {
        nextNodesById = { ...nodesById }
      }

      nextNodesById[node.id] = {
        ...(nextNodesById[node.id] as GroupNode),
        childIds: result.ids,
      }
      changed = true
    }

    if (!changed) return

    get().pushHistory()
    set({
      nodesById: nextNodesById,
      rootIds: nextRootIds,
    })
  },
  rotateSelected: (degrees) => {
    const { nodesById, selectedIds } = get()
    const editableIds = selectedIds.filter((id) => nodesById[id])
    if (editableIds.length === 0) return

    get().pushHistory()
    set((state) => {
      const nextNodesById = { ...state.nodesById }
      editableIds.forEach((id) => {
        const node = nextNodesById[id]
        if (!node) return
        nextNodesById[id] = {
          ...node,
          rotation: normalizeRotation((node.rotation ?? 0) + degrees),
        } as CanvasNode
      })
      return { nodesById: nextNodesById }
    })
  },
  renameNode: (nodeId, nextName) => {
    const normalizedName = nextName.trim()
    const node = get().nodesById[nodeId]
    if (!node || !normalizedName || normalizedName === node.name) return

    get().pushHistory()
    set((state) => ({
      nodesById: {
        ...state.nodesById,
        [nodeId]: {
          ...node,
          name: normalizedName,
        } as CanvasNode,
      },
    }))
  },
  setSelectedEngraveType: (engraveType) => {
    const { nodesById, selectedIds } = get()
    const editableIds = selectedIds.filter((id) => nodesById[id])
    if (editableIds.length === 0) return

    const changed = editableIds.some((id) => nodesById[id]?.cncMetadata?.engraveType !== engraveType)
    if (!changed) return

    get().pushHistory()
    set((state) => {
      const nextNodesById = { ...state.nodesById }
      editableIds.forEach((id) => {
        const node = nextNodesById[id]
        if (!node) return
        nextNodesById[id] = {
          ...node,
          cncMetadata: {
            ...node.cncMetadata,
            engraveType,
          },
        } as CanvasNode
      })
      return { nodesById: nextNodesById }
    })
  },
  duplicateSelected: (offsetX = 20, offsetY = 20) => {
    const { nodesById, rootIds, selectedIds } = get()
    if (selectedIds.length === 0) return

    get().pushHistory()

    const topLevelIds = selectedIds.filter((id) => {
      const node = nodesById[id]
      return !node?.parentId || !selectedIds.includes(node.parentId)
    })

    const newRootIds: string[] = []
    const updatedNodesById: Record<string, CanvasNode> = { ...nodesById }
    let updatedRootIds = [...rootIds]

    topLevelIds.forEach((id) => {
      const node = nodesById[id]
      const parentId = node?.parentId ?? null
      const { newRootId, clonedNodes } = cloneSubtree(id, nodesById, offsetX, offsetY, parentId)
      newRootIds.push(newRootId)
      Object.assign(updatedNodesById, clonedNodes)

      if (!parentId) {
        updatedRootIds = [...updatedRootIds, newRootId]
      } else {
        const parent = updatedNodesById[parentId]
        if (parent && isGroupNode(parent)) {
          updatedNodesById[parentId] = {
            ...parent,
            childIds: [...parent.childIds, newRootId],
          }
        }
      }
    })

    set({
      nodesById: updatedNodesById,
      rootIds: updatedRootIds,
      selectedIds: newRootIds,
      selectedStage: false,
    })
  },
  duplicateInPlace: () => {
    const { nodesById, rootIds, selectedIds } = get()
    if (selectedIds.length === 0) return

    const topLevelIds = selectedIds.filter((id) => {
      const node = nodesById[id]
      return !node?.parentId || !selectedIds.includes(node.parentId)
    })

    const updatedNodesById: Record<string, CanvasNode> = { ...nodesById }
    let updatedRootIds = [...rootIds]

    topLevelIds.forEach((id) => {
      const node = nodesById[id]
      const parentId = node?.parentId ?? null
      const { newRootId, clonedNodes } = cloneSubtree(id, nodesById, 0, 0, parentId)
      Object.assign(updatedNodesById, clonedNodes)

      if (!parentId) {
        updatedRootIds = [...updatedRootIds, newRootId]
      } else {
        const parent = updatedNodesById[parentId]
        if (parent && isGroupNode(parent)) {
          updatedNodesById[parentId] = {
            ...parent,
            childIds: [...parent.childIds, newRootId],
          }
        }
      }
    })

    // Keep selectedIds on the originals so Konva keeps dragging them
    set({ nodesById: updatedNodesById, rootIds: updatedRootIds })
  },
  selectAll: () => {
    const { rootIds, focusGroupId, nodesById, interactionMode } = get()
    const ids = getSelectableIdsInScope(rootIds, nodesById, focusGroupId, interactionMode)
    set({ selectedIds: ids, selectedStage: false })
  },
  setArtboardSize: (patch) => {
    get().pushHistory()
    set((state) => ({
      artboard: {
        ...state.artboard,
        ...patch,
      },
    }))
  },
  setMachiningSettings: (patch) => {
    const tabFields = ['tabsEnabled', 'tabWidth', 'tabHeight', 'tabSpacing'] as const
    const touchesTabs = tabFields.some((k) => k in patch)
    set((state) => {
      const next: Partial<typeof state> = {
        machiningSettings: { ...state.machiningSettings, ...patch },
      }
      // Invalidate cached gcodeText when tab settings change
      if (touchesTabs && state.preview.gcodeText !== null) {
        next.preview = { ...state.preview, gcodeText: null }
      }
      return next
    })
  },
  setViewport: (patch) => {
    set((state) => ({
      viewport: {
        ...state.viewport,
        ...patch,
      },
    }))
  },
  resetViewport: () => {
    set({
      viewport: initialViewport,
    })
  },
  setMarquee: (marquee) => {
    set((state) => ({
      ui: {
        ...state.ui,
        marquee,
      },
    }))
  },
  setIsTransforming: (isTransforming) => {
    set((state) => ({
      ui: {
        ...state.ui,
        isTransforming,
      },
    }))
  },
  stagePendingImport: (pendingImport) => {
    set((state) => ({
      selectedIds: [],
      selectedStage: false,
      focusGroupId: null,
      ui: {
        ...state.ui,
        pendingImport,
        importStatus: {
          tone: 'info',
          message: `Click on the artboard to place "${pendingImport.name}". Press Escape to cancel.`,
        },
      },
    }))
  },
  clearPendingImport: () => {
    set((state) => ({
      ui: {
        ...state.ui,
        pendingImport: null,
      },
    }))
  },
  placePendingImport: (position, options) => {
    const { nodesById, rootIds, ui } = get()
    const pendingImport = ui.pendingImport

    if (!pendingImport) {
      return
    }

    get().pushHistory()

    const rootNode = pendingImport.nodesById[pendingImport.rootId]
    if (!rootNode || rootNode.type !== 'group') {
      return
    }

    const { machiningSettings } = get()
    const isGenerator = Boolean((rootNode as GroupNode).generatorMetadata)
    const nextRootNode = {
      ...rootNode,
      x: position.x,
      y: position.y,
      ...(isGenerator ? {} : { originalSvg: pendingImport.originalSvg }),
      cncMetadata: {
        ...rootNode.cncMetadata,
        cutDepth: rootNode.cncMetadata?.cutDepth ?? machiningSettings.defaultDepthMm,
        engraveType: rootNode.cncMetadata?.engraveType ?? ('pocket' as const),
      },
    }

    set((state) => ({
      nodesById: {
        ...nodesById,
        ...pendingImport.nodesById,
        [pendingImport.rootId]: nextRootNode,
      },
      rootIds: [...rootIds, pendingImport.rootId],
      selectedIds: [pendingImport.rootId],
      selectedStage: false,
      focusGroupId: null,
      ui: {
        ...state.ui,
        pendingImport: null,
        importFocusRequest: options?.focusViewport
          ? {
              requestId: nextImportFocusRequestId++,
              rect: {
                x: position.x,
                y: position.y,
                width: pendingImport.width,
                height: pendingImport.height,
              },
            }
          : state.ui.importFocusRequest,
        importStatus: {
          tone: 'success',
          message: `Imported "${pendingImport.name}" onto the artboard.`,
        },
      },
    }))
  },
  clearImportFocusRequest: (requestId) => {
    set((state) => ({
      ui: {
        ...state.ui,
        importFocusRequest:
          state.ui.importFocusRequest?.requestId === requestId
            ? null
            : state.ui.importFocusRequest,
      },
    }))
  },
  setImportStatus: (importStatus) => {
    set((state) => ({
      ui: {
        ...state.ui,
        importStatus,
      },
    }))
  },

  // Library tab
  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),

  requestFocusText: (nodeId) => set((state) => ({
    ui: { ...state.ui, focusTextRequestId: nodeId },
  })),
  consumeFocusTextRequest: () => set((state) => ({
    ui: { ...state.ui, focusTextRequestId: null },
  })),
  startEditingText: (nodeId) => set((state) => ({
    ui: { ...state.ui, editingTextNodeId: nodeId },
  })),
  stopEditingText: () => set((state) => ({
    ui: { ...state.ui, editingTextNodeId: null },
  })),

  placeGenerator: (params, position) => {
    const { artboard, machiningSettings, nodesById, rootIds } = get()
    const resolved = normalizeGeneratorParams(resolveParamsAgainstTool(params, machiningSettings))
    const svgText = runGenerator(resolved)
    const pending = importSvgToScene({
      artboardWidth: artboard.width,
      artboardHeight: artboard.height,
      fileName: resolved.name,
      svgText,
      defaultCutDepth: machiningSettings.defaultDepthMm,
    })
    applyGeneratorRenderHints(pending, resolved)
    // Determine effective engraveType:
    // - matchToolWidth tenons use lines → always contour
    // - matchToolDiameter dowels are drill points → plunge
    // - otherwise use the outputType from params
    let engraveType = resolved.outputType as string
    if (resolved.kind === 'tenon' && resolved.matchToolWidth) {
      engraveType = 'contour'
    } else if (resolved.kind === 'dowelHole' && resolved.matchToolDiameter) {
      engraveType = 'plunge'
    } else if (resolved.kind === 'text') {
      engraveType = resolved.outputType
    }
    for (const node of Object.values(pending.nodesById)) {
      node.cncMetadata = { ...node.cncMetadata, engraveType: engraveType as import('./types/editor').EngraveType }
    }
    // Stamp generatorMetadata on the root group
    const rootNode = pending.nodesById[pending.rootId]
    if (rootNode && rootNode.type === 'group') {
      ;(rootNode as GroupNode).generatorMetadata = { params: resolved }
    }
    get().stagePendingImport(pending)
    const placement = position
      ? getCenteredPlacement(position, pending.width, pending.height, artboard)
      : resolved.kind === 'text'
        ? {
            x: Math.max(0, (artboard.width - pending.width) / 2),
            y: Math.max(0, (artboard.height - pending.height) / 2),
          }
        : getAutoImportPlacement({
            artboard,
            nodesById,
            rootIds,
            width: pending.width,
            height: pending.height,
          })
    get().placePendingImport(placement)
  },

  placeShape: (kind, position) => {
    const { artboard, machiningSettings, nodesById, rootIds } = get()
    const { width, height } = getBasicShapeSize(kind)
    const placement = position
      ? getCenteredPlacement(position, width, height, artboard)
      : getAutoImportPlacement({
          artboard,
          nodesById,
          rootIds,
          width,
          height,
        })
    const node = createBasicShapeNode(kind, placement, machiningSettings.defaultDepthMm)

    get().pushHistory()

    set((state) => ({
      nodesById: {
        ...state.nodesById,
        [node.id]: node,
      },
      rootIds: [...state.rootIds, node.id],
      selectedIds: [node.id],
      selectedStage: false,
      focusGroupId: null,
      ui: {
        ...state.ui,
        pendingImport: null,
        importStatus: {
          tone: 'success',
          message: `Added "${node.name}" to the artboard.`,
        },
      },
    }))
  },

  updateGeneratorParams: (nodeId, params, options) => {
    const { nodesById, artboard, machiningSettings } = get()
    const existingNode = nodesById[nodeId]
    if (!existingNode || existingNode.type !== 'group') return

    if (!options?.skipHistory) {
      get().pushHistory()
    }

    const resolved = normalizeGeneratorParams(resolveParamsAgainstTool(params, machiningSettings))
    const svgText = runGenerator(resolved)
    const pending = importSvgToScene({
      artboardWidth: artboard.width,
      artboardHeight: artboard.height,
      fileName: resolved.name,
      svgText,
      defaultCutDepth: machiningSettings.defaultDepthMm,
    })
    applyGeneratorRenderHints(pending, resolved)

    const existingGroup = existingNode as GroupNode
    const newRootNode = pending.nodesById[pending.rootId]
    if (!newRootNode || newRootNode.type !== 'group') return
    const nextGroupSize = getNodeSize(newRootNode, pending.nodesById)

    // Collect old child subtree IDs to remove
    const oldChildIds = new Set<string>()
    for (const childId of existingGroup.childIds) {
      for (const id of getSubtreeIds(childId, nodesById)) {
        oldChildIds.add(id)
      }
    }

    // Determine effective engraveType
    let engraveType = resolved.outputType as string
    if (resolved.kind === 'tenon' && resolved.matchToolWidth) {
      engraveType = 'contour'
    } else if (resolved.kind === 'dowelHole' && resolved.matchToolDiameter) {
      engraveType = 'plunge'
    } else if (resolved.kind === 'text') {
      engraveType = resolved.outputType
    }
    const newChildren: Record<string, CanvasNode> = {}
    for (const [id, node] of Object.entries(pending.nodesById)) {
      if (id === pending.rootId) continue
      newChildren[id] = {
        ...node,
        parentId: node.parentId === pending.rootId ? nodeId : node.parentId,
        cncMetadata: { ...node.cncMetadata, engraveType: engraveType as import('./types/editor').EngraveType },
      }
    }

    const autoGroupPatch = resolved.kind === 'text'
      ? { x: existingGroup.x, y: existingGroup.y }
      : getAutoGeneratorGroupPatch(
          existingGroup,
          nodesById,
          artboard,
          nextGroupSize.width,
          nextGroupSize.height,
        )

    const updatedGroup: GroupNode = {
      ...existingGroup,
      ...autoGroupPatch,
      ...options?.groupPatch,
      childIds: (newRootNode as GroupNode).childIds,
      generatorMetadata: { params: resolved },
    }

    if (supportsGeneratorResizeBack(resolved)) {
      updatedGroup.scaleX = 1
      updatedGroup.scaleY = 1
    }

    const prunedNodes: Record<string, CanvasNode> = {}
    for (const [id, node] of Object.entries(nodesById)) {
      if (!oldChildIds.has(id)) prunedNodes[id] = node
    }

    set({
      nodesById: { ...prunedNodes, [nodeId]: updatedGroup, ...newChildren },
    })
  },

  // Alignment
  alignSelectedNodes: (direction) => {
    const { selectedIds, nodesById, artboard } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()

    // Compute union bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const id of selectedIds) {
      const node = nodesById[id]
      if (!node) continue
      const ns = getNodeSize(node, nodesById)
      if (node.x < minX) minX = node.x
      if (node.y < minY) minY = node.y
      if (node.x + ns.width > maxX) maxX = node.x + ns.width
      if (node.y + ns.height > maxY) maxY = node.y + ns.height
    }

    // For single node, align to artboard
    const refMinX = selectedIds.length === 1 ? 0 : minX
    const refMinY = selectedIds.length === 1 ? 0 : minY
    const refMaxX = selectedIds.length === 1 ? artboard.width : maxX
    const refMaxY = selectedIds.length === 1 ? artboard.height : maxY
    const refCenterX = (refMinX + refMaxX) / 2
    const refCenterY = (refMinY + refMaxY) / 2

    for (const id of selectedIds) {
      const node = nodesById[id]
      if (!node) continue
      const ns = getNodeSize(node, nodesById)
      let newX = node.x
      let newY = node.y
      if (direction === 'left') newX = refMinX
      else if (direction === 'right') newX = refMaxX - ns.width
      else if (direction === 'centerX') newX = refCenterX - ns.width / 2
      else if (direction === 'top') newY = refMinY
      else if (direction === 'bottom') newY = refMaxY - ns.height
      else if (direction === 'centerY') newY = refCenterY - ns.height / 2
      get().updateNodeTransform(id, { x: newX, y: newY } as Partial<CanvasNode>)
    }
  },

  // Grid/Repeat
  enableGrid: (nodeId) => {
    get().pushHistory()
    set((state) => {
      const node = state.nodesById[nodeId]
      if (!node) return {}
      return {
        nodesById: {
          ...state.nodesById,
          [nodeId]: { ...node, gridMetadata: { rows: 1, cols: 2, rowGap: 5, colGap: 5 } },
        },
      }
    })
  },

  disableGrid: (nodeId) => {
    get().pushHistory()
    set((state) => {
      const node = state.nodesById[nodeId]
      if (!node) return {}
      const rest = { ...node } as CanvasNode & { gridMetadata?: GridMetadata }
      delete rest.gridMetadata
      return { nodesById: { ...state.nodesById, [nodeId]: rest as CanvasNode } }
    })
  },

  updateGridMetadata: (nodeId, patch) => {
    set((state) => {
      const node = state.nodesById[nodeId]
      if (!node || !node.gridMetadata) return {}
      return {
        nodesById: {
          ...state.nodesById,
          [nodeId]: { ...node, gridMetadata: { ...node.gridMetadata, ...patch } },
        },
      }
    })
  },

  // Centerlines
  enableCenterline: (nodeId) => {
    get().pushHistory()
    set((state) => {
      const node = state.nodesById[nodeId]
      if (!node) return {}
      return {
        nodesById: {
          ...state.nodesById,
          [nodeId]: {
            ...node,
            centerlineMetadata: normalizeCenterlineMetadata({
              ...DEFAULT_CENTERLINE_METADATA,
              ...node.centerlineMetadata,
              enabled: true,
            }),
          } as CanvasNode,
        },
      }
    })
  },

  disableCenterline: (nodeId) => {
    get().pushHistory()
    set((state) => {
      const node = state.nodesById[nodeId]
      if (!node) return {}
      const rest = { ...node } as CanvasNode & {
        centerlineMetadata?: CenterlineMetadata
      }
      delete rest.centerlineMetadata
      return { nodesById: { ...state.nodesById, [nodeId]: rest as CanvasNode } }
    })
  },

  updateCenterlineMetadata: (nodeId, patch) => {
    set((state) => {
      const node = state.nodesById[nodeId]
      if (!node || !node.centerlineMetadata) return {}
      const invalidatesAiSmooth = (
        patch.scaleAxis !== undefined ||
        patch.samples !== undefined ||
        patch.toolDiameter !== undefined ||
        patch.edgeTrim !== undefined ||
        patch.simplifyTolerance !== undefined ||
        patch.smallDetailTightness !== undefined ||
        patch.forceRaster !== undefined
      ) && patch.aiSmoothedPathData === undefined
      return {
        nodesById: {
          ...state.nodesById,
          [nodeId]: {
            ...node,
            centerlineMetadata: normalizeCenterlineMetadata({
              ...node.centerlineMetadata,
              ...patch,
              ...(invalidatesAiSmooth ? { aiSmoothedPathData: undefined } : {}),
            }),
          } as CanvasNode,
        },
      }
    })
  },

  aiSmoothStreamingIds: [],
  setAiSmoothStreamingIds: (ids) => set({ aiSmoothStreamingIds: ids }),

  // Preview state
  preview: {
    viewMode: 'design',
    cameraType: 'perspective',
    playbackDistance: 0,
    isPlaying: false,
    playbackRate: 60,
    loopPlayback: true,
    showSvgOverlay: true,
    showStock: true,
    showRapidMoves: false,
    showCutOrder: false,
    showJobOrder: false,
    materialPreset: DEFAULT_MATERIAL,
    initProgress: null,
    isSceneReady: true,
    parsedProgram: null,
    toolpaths: null,
    stockBounds: null,
    gcodeText: null,
    previewSnapshot: null,
    toolShape: null,
  },
  setViewMode: (mode) => {
    set((state) => ({
      preview: { ...state.preview, viewMode: mode, isPlaying: false },
      prepareJobPlayback: { ...state.prepareJobPlayback, isPlaying: false },
    }))
  },
  setCameraType: (type) => {
    set((state) => ({
      preview: { ...state.preview, cameraType: type },
    }))
  },
  setPlaybackDistance: (distance) => {
    set((state) => ({
      preview: { ...state.preview, playbackDistance: distance },
    }))
  },
  setIsPlaying: (playing) => {
    set((state) => ({
      preview: { ...state.preview, isPlaying: playing },
    }))
  },
  togglePlayback: () => {
    set((state) => {
      const { preview } = state
      if (!preview.parsedProgram) return {}
      // If at end, reset to beginning
      if (!preview.isPlaying && preview.playbackDistance >= preview.parsedProgram.totalDistance) {
        return { preview: { ...preview, isPlaying: true, playbackDistance: 0 } }
      }
      return { preview: { ...preview, isPlaying: !preview.isPlaying } }
    })
  },
  setPlaybackRate: (rate) => {
    set((state) => ({
      preview: { ...state.preview, playbackRate: rate },
    }))
  },
  setLoopPlayback: (loop) => {
    set((state) => ({
      preview: { ...state.preview, loopPlayback: loop },
    }))
  },
  setShowSvgOverlay: (show) => {
    set((state) => ({
      preview: { ...state.preview, showSvgOverlay: show },
    }))
  },
  setShowStock: (show) => {
    set((state) => ({
      preview: { ...state.preview, showStock: show },
    }))
  },
  setShowRapidMoves: (show) => {
    set((state) => ({
      preview: { ...state.preview, showRapidMoves: show },
    }))
  },
  setShowCutOrder: (show) => {
    set((state) => ({
      preview: { ...state.preview, showCutOrder: show },
    }))
  },
  setShowJobOrder: (show) => {
    set((state) => ({
      preview: { ...state.preview, showJobOrder: show },
    }))
  },
  setMaterialPreset: (preset) => {
    set((state) => ({
      preview: { ...state.preview, materialPreset: preset },
    }))
  },
  setSceneReady: (ready) => {
    set((state) => ({
      preview: { ...state.preview, isSceneReady: ready },
    }))
  },
  initPreview: async (result) => {
    const { machiningSettings, artboard } = get()

    // Mesh building happens after initPreview returns (inside PreviewCanvas).
    // Flag the scene as not-ready here so the init overlay keeps covering the
    // grey mount gap until PreviewCanvas signals the first frame has painted.
    set((state) => ({ preview: { ...state.preview, isSceneReady: false } }))

    const setProgress = (initProgress: number) =>
      set((state) => ({ preview: { ...state.preview, initProgress } }))

    // Yield to the event loop so React can paint the current progress value
    // before we kick off the next synchronous block. Without these yields the
    // bar stays pinned at its last rendered value (0%) while tabs/parse/group
    // run synchronously, even though setProgress is called between them.
    const yieldToPaint = () => new Promise((r) => setTimeout(r, 0))

    setProgress(1)
    await yieldToPaint()

    // Post-process GCode to insert tabs on through-cuts when enabled
    let gcode = result.gcode
    if (machiningSettings.tabsEnabled) {
      gcode = insertTabs(gcode, {
        materialThickness: artboard.thickness,
        tabWidth: machiningSettings.tabWidth,
        tabHeight: machiningSettings.tabHeight,
        tabSpacing: machiningSettings.tabSpacing,
      })
    }

    setProgress(4)
    await yieldToPaint()
    const program = parseGcodeProgram(gcode, result.operation_ranges)

    setProgress(8)
    await yieldToPaint()
    const toolRadius = result.preview_snapshot.tool_diameter / 2
    const toolShape = machiningSettings.toolShape
    const rawGroups = groupSegments(program.segments, toolRadius, toolShape)

    setProgress(12)
    await yieldToPaint()

    // Compute sweep shapes incrementally, yielding to the event loop for UI updates
    const toolpaths: ToolpathGroup[] = []
    const groupCount = Math.max(rawGroups.length, 1)
    let lastReportedPct = 12
    for (let i = 0; i < rawGroups.length; i++) {
      toolpaths.push(computeGroupSweep(rawGroups[i]))
      const pct = 12 + Math.round(((i + 1) / groupCount) * 83)
      // Only push an update (and yield) when the integer percent actually
      // advances. With many small groups this keeps the progress bar smooth
      // without thrashing zustand/React on every iteration.
      if (pct !== lastReportedPct) {
        setProgress(pct)
        lastReportedPct = pct
        await yieldToPaint()
      }
    }
    setProgress(97)
    await yieldToPaint()

    const stockBounds = {
      minX: 0,
      minY: 0,
      maxX: result.preview_snapshot.material_width,
      maxY: result.preview_snapshot.material_height,
    }

    // Keep initProgress at 100 through the final state commit so the bar
    // doesn't visually snap back to 0% while the modal is still on screen.
    // App.tsx resets it to null when it tears the modal down.
    set((state) => ({
      preview: {
        ...state.preview,
        viewMode: 'preview3d',
        initProgress: 100,
        parsedProgram: program,
        toolpaths,
        stockBounds,
        gcodeText: gcode,
        previewSnapshot: result.preview_snapshot,
        toolShape,
        playbackDistance: 0,
        isPlaying: false,
      },
    }))
  },
  clearPreview: () => {
    set((state) => ({
      preview: {
        ...state.preview,
        viewMode: 'design',
        initProgress: null,
        isSceneReady: true,
        parsedProgram: null,
        toolpaths: null,
        stockBounds: null,
        gcodeText: null,
        previewSnapshot: null,
        toolShape: null,
        playbackDistance: 0,
        isPlaying: false,
      },
    }))
  },

  prepareShowCutNumbers: true,
  setPrepareShowCutNumbers: (show) => set({ prepareShowCutNumbers: show }),
  prepareExportCutNumbers: true,
  setPrepareExportCutNumbers: (show) => set({ prepareExportCutNumbers: show }),
  prepareJobPlayback: { isPlaying: false, currentJobIndex: 0, rate: 1, loop: false },
  toggleJobPlayback: () => {
    set((state) => ({
      prepareJobPlayback: {
        ...state.prepareJobPlayback,
        isPlaying: !state.prepareJobPlayback.isPlaying,
      },
    }))
  },
  setJobPlaybackPlaying: (playing) => {
    set((state) => ({
      prepareJobPlayback: { ...state.prepareJobPlayback, isPlaying: playing },
    }))
  },
  setCurrentJobIndex: (index) => {
    set((state) => ({
      prepareJobPlayback: { ...state.prepareJobPlayback, currentJobIndex: index },
    }))
  },
  setJobPlaybackRate: (rate) => {
    set((state) => ({
      prepareJobPlayback: { ...state.prepareJobPlayback, rate },
    }))
  },
  setJobPlaybackLoop: (loop) => {
    set((state) => ({
      prepareJobPlayback: { ...state.prepareJobPlayback, loop },
    }))
  },
}))

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { useEditorStore: typeof useEditorStore }).useEditorStore = useEditorStore
}
