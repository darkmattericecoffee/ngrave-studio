import { create } from 'zustand'

import { getSelectableIdsInScope, getSubtreeIds, isGroupNode } from './lib/editorTree'
import { runGenerator } from './lib/generators'
import { resolveParamsAgainstTool } from './lib/generators'
import { getNodeSize } from './lib/nodeDimensions'
import { importSvgToScene } from './lib/svgImport'
import type {
  ArtboardState,
  CanvasNode,
  CncMetadata,
  EyedropperMode,
  GeneratorParams,
  GroupNode,
  ImportStatus,
  InteractionMode,
  MachiningSettings,
  MarqueeRect,
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

type HistorySnapshot = {
  nodesById: Record<string, CanvasNode>
  rootIds: string[]
  selectedIds: string[]
  artboard: ArtboardState
}

const MAX_HISTORY = 50

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
    importStatus: ImportStatus | null
  }
  hoveredId: string | null
  eyedropperMode: EyedropperMode
  eyedropperSourceNodeId: string | null
  setHoveredId: (id: string | null) => void
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
  pushHistory: () => void
  undo: () => void
  redo: () => void
  deleteSelected: () => void
  copySelected: () => void
  pasteClipboard: () => void
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
  placePendingImport: (position: { x: number; y: number }) => void
  setImportStatus: (status: ImportStatus | null) => void

  // Library tab
  leftPanelTab: 'layers' | 'library'
  setLeftPanelTab: (tab: 'layers' | 'library') => void
  placeGenerator: (params: GeneratorParams) => void
  updateGeneratorParams: (nodeId: string, params: GeneratorParams) => void

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
  setMaterialPreset: (preset: MaterialPreset) => void
  initPreview: (result: import('@svg2gcode/bridge').GenerateJobResponse) => Promise<void>
  clearPreview: () => void
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
    plungeFeedrate: null,
    travelZ: null,
    cutZ: null,
    machineWidth: null,
    machineHeight: null,
    tabsEnabled: false,
    tabWidth: 4,
    tabHeight: 1.5,
    tabSpacing: 50,
  },
  viewport: initialViewport,
  ui: {
    marquee: null,
    isTransforming: false,
    pendingImport: null,
    importStatus: null,
  },
  hoveredId: null,
  eyedropperMode: 'off',
  eyedropperSourceNodeId: null,
  leftPanelTab: 'layers',
  setHoveredId: (id) => set({ hoveredId: id }),
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
  pushHistory: () => {
    const { nodesById, rootIds, selectedIds, artboard } = get()
    const snapshot: HistorySnapshot = { nodesById, rootIds, selectedIds, artboard }
    set((state) => ({
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
    set({
      nodesById: snapshot.nodesById,
      rootIds: snapshot.rootIds,
      selectedIds: snapshot.selectedIds,
      artboard: snapshot.artboard,
      focusGroupId: null,
      history: { past, future: [current, ...history.future] },
    })
  },
  redo: () => {
    const { history, nodesById, rootIds, selectedIds, artboard } = get()
    if (history.future.length === 0) return
    const [snapshot, ...future] = history.future
    const current: HistorySnapshot = { nodesById, rootIds, selectedIds, artboard }
    set({
      nodesById: snapshot.nodesById,
      rootIds: snapshot.rootIds,
      selectedIds: snapshot.selectedIds,
      artboard: snapshot.artboard,
      focusGroupId: null,
      history: { past: [...history.past, current], future },
    })
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
  placePendingImport: (position) => {
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
        importStatus: {
          tone: 'success',
          message: `Imported "${pendingImport.name}" onto the artboard.`,
        },
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

  placeGenerator: (params) => {
    const { artboard, machiningSettings, nodesById, rootIds } = get()
    const resolved = resolveParamsAgainstTool(params, machiningSettings)
    const svgText = runGenerator(resolved)
    const pending = importSvgToScene({
      artboardWidth: artboard.width,
      artboardHeight: artboard.height,
      fileName: resolved.name,
      svgText,
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
    get().placePendingImport(
      getAutoImportPlacement({
        artboard,
        nodesById,
        rootIds,
        width: pending.width,
        height: pending.height,
      }),
    )
  },

  updateGeneratorParams: (nodeId, params) => {
    const { nodesById, artboard, machiningSettings } = get()
    const existingNode = nodesById[nodeId]
    if (!existingNode || existingNode.type !== 'group') return

    get().pushHistory()

    const resolved = resolveParamsAgainstTool(params, machiningSettings)
    const svgText = runGenerator(resolved)
    const pending = importSvgToScene({
      artboardWidth: artboard.width,
      artboardHeight: artboard.height,
      fileName: resolved.name,
      svgText,
    })
    applyGeneratorRenderHints(pending, resolved)

    const existingGroup = existingNode as GroupNode
    const newRootNode = pending.nodesById[pending.rootId]
    if (!newRootNode || newRootNode.type !== 'group') return

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

    const updatedGroup: GroupNode = {
      ...existingGroup,
      childIds: (newRootNode as GroupNode).childIds,
      generatorMetadata: { params: resolved },
    }

    const prunedNodes: Record<string, CanvasNode> = {}
    for (const [id, node] of Object.entries(nodesById)) {
      if (!oldChildIds.has(id)) prunedNodes[id] = node
    }

    set({
      nodesById: { ...prunedNodes, [nodeId]: updatedGroup, ...newChildren },
    })
  },

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
    materialPreset: DEFAULT_MATERIAL,
    initProgress: null,
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
  setMaterialPreset: (preset) => {
    set((state) => ({
      preview: { ...state.preview, materialPreset: preset },
    }))
  },
  initPreview: async (result) => {
    const { machiningSettings, artboard } = get()

    const setProgress = (initProgress: number) =>
      set((state) => ({ preview: { ...state.preview, initProgress } }))

    setProgress(0)

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

    setProgress(5)
    const program = parseGcodeProgram(gcode, result.operation_ranges)

    setProgress(10)
    const toolRadius = result.preview_snapshot.tool_diameter / 2
    const toolShape = machiningSettings.toolShape
    const rawGroups = groupSegments(program.segments, toolRadius, toolShape)

    // Compute sweep shapes incrementally, yielding to the event loop for UI updates
    const toolpaths: ToolpathGroup[] = []
    for (let i = 0; i < rawGroups.length; i++) {
      toolpaths.push(computeGroupSweep(rawGroups[i]))
      const pct = 10 + Math.round((i + 1) / rawGroups.length * 85)
      setProgress(pct)
      // Yield every few groups so the progress bar can repaint
      if (i % 3 === 0) {
        await new Promise((r) => setTimeout(r, 0))
      }
    }

    const stockBounds = {
      minX: 0,
      minY: 0,
      maxX: result.preview_snapshot.material_width,
      maxY: result.preview_snapshot.material_height,
    }

    set((state) => ({
      preview: {
        ...state.preview,
        viewMode: 'preview3d',
        initProgress: null,
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
}))
