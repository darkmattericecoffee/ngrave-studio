import { useCallback, useMemo, useRef, useState } from 'react'
import { Button, ButtonGroup, Tabs } from '@heroui/react'
import { LayoutCells, Sparkles } from '@gravity-ui/icons'
import { RotateCcw, RotateCw } from 'lucide-react'

import { resizeGeneratorToBounds, supportsGeneratorResizeBack } from '../lib/generators'
import { GENERATOR_LIBRARY_ITEMS } from '../lib/libraryItems'
import { getNodeSize } from '../lib/nodeDimensions'
import { generateCenterlineForNode } from '../lib/centerline'
import { AppIcon, Icons } from '../lib/icons'
import { useEditorStore } from '../store'
import type { CanvasNode, CenterlineMetadata, GeneratorParams, GroupNode, RectNode } from '../types/editor'
import type { MaterialPreset } from '../lib/materialPresets'
import { MaterialTabContent, PreviewTabContent } from './MaterialTabContent'
import { CutDepthEditor } from './CutDepthEditor'
import { DowelHoleForm } from './library/DowelHoleForm'
import { ScallopFrameForm } from './library/ScallopFrameForm'
import { TenonForm } from './library/TenonForm'
import {
  OPENROUTER_API_KEY_STORAGE,
  buildSvgForSmoothing,
  extractPathDataFromSvg,
  streamAiSmooth,
} from '../lib/aiSmooth'

type InspectorTab = 'design' | 'cut' | 'material'

interface StudioInspectorProps {
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  materialPreset: MaterialPreset
  onMaterialChange: (preset: MaterialPreset) => void
}

export function StudioInspector({ activeTab, onTabChange, materialPreset, onMaterialChange }: StudioInspectorProps) {
  const viewMode = useEditorStore((s) => s.preview.viewMode)
  const isPreview3d = viewMode === 'preview3d'

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <div className="px-4 py-4" />

      {/* Tabs */}
      <div className="px-4 pb-4">
        <Tabs
          className="w-full"
          selectedKey={activeTab}
          onSelectionChange={(key) => onTabChange(String(key) as InspectorTab)}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="Inspector tabs" className="grid w-full grid-cols-3">
              <Tabs.Tab id="design">
                Design
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="cut">
                Cut
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="material">
                {isPreview3d ? 'Camera' : 'Material'}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <SelectedArtHint />
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {activeTab === 'design' ? (
          <DesignTabContent />
        ) : activeTab === 'cut' ? (
          <CutTabContent />
        ) : isPreview3d ? (
          <PreviewTabContent />
        ) : (
          <MaterialTabContent materialPreset={materialPreset} onMaterialChange={onMaterialChange} />
        )}
      </div>
    </div>
  )
}

function SelectedArtHint() {
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const selectedStage = useEditorStore((s) => s.selectedStage)
  const nodesById = useEditorStore((s) => s.nodesById)

  const selectedNodes = useMemo(
    () => selectedIds.map((id) => nodesById[id]).filter((node): node is CanvasNode => Boolean(node)),
    [selectedIds, nodesById],
  )

  if (selectedStage) {
    return (
      <div className="mt-2 flex min-w-0">
        <div className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#0d99ff]/45 bg-[rgba(13,153,255,0.14)] px-2 py-1 text-xs text-[#0d99ff]">
          <span className="shrink-0">Selected</span>
          <span className="min-w-0 truncate font-medium">Artboard</span>
        </div>
      </div>
    )
  }

  if (selectedNodes.length === 0) return null

  const firstNode = selectedNodes[0]
  const extraCount = selectedNodes.length - 1

  return (
    <div className="mt-2 flex min-w-0">
      <div className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#0d99ff]/45 bg-[rgba(13,153,255,0.14)] px-2 py-1 text-xs text-[#0d99ff]">
        <span className="shrink-0">Selected</span>
        <span className="min-w-0 truncate font-medium">{firstNode.name || firstNode.id}</span>
        <span className="shrink-0 opacity-75">
          {extraCount > 0 ? `+ ${extraCount}` : firstNode.type}
        </span>
      </div>
    </div>
  )
}

function DesignTabContent() {
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const nodesById = useEditorStore((s) => s.nodesById)
  const artboard = useEditorStore((s) => s.artboard)
  const toolDiameter = useEditorStore((s) => s.machiningSettings.toolDiameter)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)
  const updateGeneratorParams = useEditorStore((s) => s.updateGeneratorParams)
  const alignSelectedNodes = useEditorStore((s) => s.alignSelectedNodes)
  const rotateSelected = useEditorStore((s) => s.rotateSelected)
  const enableGrid = useEditorStore((s) => s.enableGrid)
  const disableGrid = useEditorStore((s) => s.disableGrid)
  const updateGridMetadata = useEditorStore((s) => s.updateGridMetadata)
  const enableCenterline = useEditorStore((s) => s.enableCenterline)
  const disableCenterline = useEditorStore((s) => s.disableCenterline)
  const updateCenterlineMetadata = useEditorStore((s) => s.updateCenterlineMetadata)
  const [rotationDegrees, setRotationDegrees] = useState(90)

  const firstNode = selectedIds.length > 0 ? nodesById[selectedIds[0]] : null
  const canEditCenterlines = Boolean(
    firstNode &&
    selectedIds.length === 1 &&
    firstNode.parentId === null &&
    (firstNode.type === 'group' || firstNode.type === 'path'),
  )

  // Compute union bounding box (in canvas px = mm) for all selected nodes
  const selectionBounds = useMemo(() => {
    if (selectedIds.length === 0) return null
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
    if (!isFinite(minX)) return null
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }, [selectedIds, nodesById])

  const selectionOffset = useMemo(() => {
    if (!selectionBounds) return null
    return {
      x: selectionBounds.x,
      y: artboard.height - selectionBounds.y - selectionBounds.height,
    }
  }, [selectionBounds, artboard.height])

  const resizableGeneratorNode = useMemo(() => {
    if (!firstNode || selectedIds.length !== 1 || firstNode.type !== 'group') return null
    const group = firstNode as GroupNode
    const params = group.generatorMetadata?.params
    if (!params || !supportsGeneratorResizeBack(params)) return null
    return group
  }, [firstNode, selectedIds.length])

  const selectedGeneratorNode = useMemo(() => {
    if (!firstNode || selectedIds.length !== 1 || firstNode.type !== 'group') return null
    const group = firstNode as GroupNode
    return group.generatorMetadata ? group : null
  }, [firstNode, selectedIds.length])

  const selectedRectNode = selectedIds.length === 1 && firstNode?.type === 'rect'
    ? firstNode as RectNode
    : null

  const centerlineResult = useMemo(() => {
    if (!firstNode?.centerlineMetadata?.enabled) return null
    return generateCenterlineForNode(firstNode.id, nodesById, { toolDiameter })
  }, [firstNode, nodesById, toolDiameter])

  return (
    <div className="space-y-5">
      {/* Alignment controls — visible when something is selected */}
      {firstNode && (
        <section className="space-y-3">
          <SectionHeading title="Align" />
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Horizontal</span>
              <ButtonGroup orientation="horizontal" variant="tertiary" aria-label="Horizontal alignment">
                <Button isIconOnly onPress={() => alignSelectedNodes('left')}>
                  <AppIcon icon={Icons.alignLeft} className="h-4 w-4" />
                </Button>
                <Button isIconOnly onPress={() => alignSelectedNodes('centerX')}>
                  <ButtonGroup.Separator />
                  <AppIcon icon={Icons.alignCenterHorizontal} className="h-4 w-4" />
                </Button>
                <Button isIconOnly onPress={() => alignSelectedNodes('right')}>
                  <ButtonGroup.Separator />
                  <AppIcon icon={Icons.alignRight} className="h-4 w-4" />
                </Button>
              </ButtonGroup>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">Vertical</span>
              <ButtonGroup orientation="horizontal" variant="tertiary" aria-label="Vertical alignment">
                <Button isIconOnly onPress={() => alignSelectedNodes('top')}>
                  <AppIcon icon={Icons.alignTop} className="h-4 w-4" />
                </Button>
                <Button isIconOnly onPress={() => alignSelectedNodes('centerY')}>
                  <ButtonGroup.Separator />
                  <AppIcon icon={Icons.alignCenterVertical} className="h-4 w-4" />
                </Button>
                <Button isIconOnly onPress={() => alignSelectedNodes('bottom')}>
                  <ButtonGroup.Separator />
                  <AppIcon icon={Icons.alignBottom} className="h-4 w-4" />
                </Button>
              </ButtonGroup>
            </div>
          </div>
        </section>
      )}

      {selectedGeneratorNode && (
        <section className="space-y-4">
          <SelectedGeneratorHeading node={selectedGeneratorNode} />
          <div className="rounded-md border border-border bg-content1 px-3 py-3">
            <GeneratorSettingsPanel
              node={selectedGeneratorNode}
              onUpdate={(params) => updateGeneratorParams(selectedGeneratorNode.id, params)}
            />
          </div>
        </section>
      )}

      {selectedRectNode && (
        <section className="space-y-4">
          <SectionHeading title="Shape" />
          <div className="space-y-2">
            <SubsectionHeading title="Corners" />
            <NumberPill
              label="Radius"
              value={round2(selectedRectNode.cornerRadius ?? 0)}
              unit="mm"
              onChange={(value) => {
                if (value === null) return
                const maxRadius = Math.min(selectedRectNode.width, selectedRectNode.height) / 2
                updateNodeTransform(selectedRectNode.id, {
                  cornerRadius: Math.max(0, Math.min(value, maxRadius)),
                } as Partial<CanvasNode>)
              }}
            />
          </div>
        </section>
      )}

      {/* Dimensions & offset */}
      {firstNode && selectionBounds && selectionOffset && (
        <section className="space-y-4">
          <SectionHeading title="Placement" />
          <div className="space-y-3">
            <div className="space-y-2">
              <SubsectionHeading title="Dimensions" />
              <div className="flex flex-wrap gap-2">
                <NumberPill
                  label="W"
                  value={round2(selectionBounds.width)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null || v <= 0 || selectionBounds.width <= 0) return
                    if (resizableGeneratorNode) {
                      updateGeneratorParams(
                        resizableGeneratorNode.id,
                        resizeGeneratorToBounds(
                          resizableGeneratorNode.generatorMetadata!.params,
                          v,
                          selectionBounds.height,
                        ),
                      )
                      return
                    }
                    const ratio = v / selectionBounds.width
                    selectedIds.forEach((id) => {
                      const node = nodesById[id]
                      if (!node) return
                      const ns = getNodeSize(node, nodesById)
                      if (node.type === 'rect') {
                        updateNodeTransform(id, { width: ns.width * ratio, height: ns.height * ratio } as Partial<CanvasNode>)
                      } else {
                        updateNodeTransform(id, { scaleX: node.scaleX * ratio, scaleY: node.scaleY * ratio } as Partial<CanvasNode>)
                      }
                    })
                  }}
                />
                <NumberPill
                  label="H"
                  value={round2(selectionBounds.height)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null || v <= 0 || selectionBounds.height <= 0) return
                    if (resizableGeneratorNode) {
                      updateGeneratorParams(
                        resizableGeneratorNode.id,
                        resizeGeneratorToBounds(
                          resizableGeneratorNode.generatorMetadata!.params,
                          selectionBounds.width,
                          v,
                        ),
                      )
                      return
                    }
                    const ratio = v / selectionBounds.height
                    selectedIds.forEach((id) => {
                      const node = nodesById[id]
                      if (!node) return
                      const ns = getNodeSize(node, nodesById)
                      if (node.type === 'rect') {
                        updateNodeTransform(id, { width: ns.width * ratio, height: ns.height * ratio } as Partial<CanvasNode>)
                      } else {
                        updateNodeTransform(id, { scaleX: node.scaleX * ratio, scaleY: node.scaleY * ratio } as Partial<CanvasNode>)
                      }
                    })
                  }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <SubsectionHeading title="Offset" />
              <div className="flex flex-wrap gap-2">
                <NumberPill
                  label="X"
                  value={round2(selectionOffset.x)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null) return
                    const deltaX = v - selectionBounds.x
                    selectedIds.forEach((id) => {
                      const node = nodesById[id]
                      if (!node) return
                      updateNodeTransform(id, { x: node.x + deltaX } as Partial<CanvasNode>)
                    })
                  }}
                />
                <NumberPill
                  label="Y"
                  value={round2(selectionOffset.y)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null) return
                    // selectionOffset.y = artboard.height - selectionBounds.y - selectionBounds.height
                    // new canvasTop = artboard.height - v - selectionBounds.height
                    const newCanvasTop = artboard.height - v - selectionBounds.height
                    const deltaY = newCanvasTop - selectionBounds.y
                    selectedIds.forEach((id) => {
                      const node = nodesById[id]
                      if (!node) return
                      updateNodeTransform(id, { y: node.y + deltaY } as Partial<CanvasNode>)
                    })
                  }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <SubsectionHeading title="Rotation" />
              <div className="flex flex-wrap items-center gap-2">
                <ButtonGroup orientation="horizontal" variant="tertiary" aria-label="Rotation">
                  <Button
                    isIconOnly
                    aria-label={`Rotate ${rotationDegrees} degrees counter-clockwise`}
                    onPress={() => rotateSelected(-rotationDegrees)}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                  <Button
                    isIconOnly
                    aria-label={`Rotate ${rotationDegrees} degrees clockwise`}
                    onPress={() => rotateSelected(rotationDegrees)}
                  >
                    <ButtonGroup.Separator />
                    <RotateCw className="h-4 w-4" />
                  </Button>
                </ButtonGroup>
                <NumberPill
                  label="By"
                  value={round2(rotationDegrees)}
                  unit="deg"
                  onChange={(v) => {
                    if (v === null || !Number.isFinite(v)) return
                    setRotationDegrees(Math.abs(v))
                  }}
                />
              </div>
              {selectedIds.length === 1 && (
                <p className="text-[10px] text-muted-foreground">
                  Current rotation: {round2(firstNode.rotation ?? 0)} deg
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Grid/Repeat — only for single selection */}
      {firstNode && selectedIds.length === 1 && (
        <section className="space-y-4">
          <SectionHeading title="Grid / Repeat" />
          {firstNode.gridMetadata ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <NumberPill
                  label="Cols"
                  value={firstNode.gridMetadata.cols}
                  unit=""
                  onChange={(v) => {
                    if (v === null || v < 1) return
                    updateGridMetadata(firstNode.id, { cols: Math.round(v) })
                  }}
                />
                <NumberPill
                  label="Rows"
                  value={firstNode.gridMetadata.rows}
                  unit=""
                  onChange={(v) => {
                    if (v === null || v < 1) return
                    updateGridMetadata(firstNode.id, { rows: Math.round(v) })
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <NumberPill
                  label="Col gap"
                  value={round2(firstNode.gridMetadata.colGap)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null || v < 0) return
                    updateGridMetadata(firstNode.id, { colGap: v })
                  }}
                />
                <NumberPill
                  label="Row gap"
                  value={round2(firstNode.gridMetadata.rowGap)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null || v < 0) return
                    updateGridMetadata(firstNode.id, { rowGap: v })
                  }}
                />
              </div>
              <button
                className="w-full rounded-md border border-border px-3 py-2 text-xs text-destructive hover:bg-content1"
                onClick={() => disableGrid(firstNode.id)}
              >
                Remove grid
              </button>
            </div>
          ) : (
            <button
              className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-content1 px-3 py-2 text-sm text-foreground hover:bg-content2"
              onClick={() => enableGrid(firstNode.id)}
            >
              <LayoutCells className="h-4 w-4" />
              Make grid
            </button>
          )}
        </section>
      )}

      {/* Centerlines — only for single root group/path selection */}
      {firstNode && canEditCenterlines && (
        <section className="space-y-4">
          <SectionHeading title="Centerlines" />
          {firstNode.centerlineMetadata?.enabled ? (
            <CenterlinesEnabledPanel
              nodeId={firstNode.id}
              meta={firstNode.centerlineMetadata}
              materialToolDiameter={toolDiameter}
              centerlineResult={centerlineResult}
              onUpdate={(patch) => updateCenterlineMetadata(firstNode.id, patch)}
              onRemove={() => disableCenterline(firstNode.id)}
            />
          ) : (
            <button
              className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-content1 px-3 py-2 text-sm text-foreground hover:bg-content2"
              onClick={() => enableCenterline(firstNode.id)}
            >
              Create Centerlines
            </button>
          )}
        </section>
      )}
    </div>
  )
}

function SelectedGeneratorHeading({ node }: { node: GroupNode }) {
  const params = node.generatorMetadata?.params
  const item = params
    ? GENERATOR_LIBRARY_ITEMS.find((libraryItem) => libraryItem.kind === params.kind)
    : null
  const title = item?.label ?? params?.name ?? node.name

  return (
    <div className="flex min-w-0 items-center gap-2">
      {item ? (
        <img
          alt=""
          aria-hidden="true"
          className="h-8 w-8 shrink-0 rounded-md object-cover"
          src={item.imageSrc}
          draggable={false}
        />
      ) : (
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      )}
      <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
    </div>
  )
}

function GeneratorSettingsPanel({
  node,
  onUpdate,
}: {
  node: GroupNode
  onUpdate: (params: GeneratorParams) => void
}) {
  const params = node.generatorMetadata?.params
  if (!params) return null

  if (params.kind === 'tenon') {
    return (
      <TenonForm
        initialParams={params}
        mode="edit"
        nodeId={node.id}
        onUpdate={onUpdate}
      />
    )
  }

  if (params.kind === 'dowelHole') {
    return (
      <DowelHoleForm
        initialParams={params}
        mode="edit"
        nodeId={node.id}
        onUpdate={onUpdate}
      />
    )
  }

  return (
    <ScallopFrameForm
      initialParams={params}
      mode="edit"
      nodeId={node.id}
      onUpdate={onUpdate}
    />
  )
}

function CutTabContent() {
  return (
    <div className="space-y-5">
      <CutDepthEditor />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Centerlines enabled panel
// ---------------------------------------------------------------------------

/** Quality 1–5 → [scaleAxis, samples] */
const QUALITY_MAP: [number, number][] = [
  [1.0, 3],   // Q1 — fast / coarse
  [1.5, 3],   // Q2 — default
  [2.0, 5],   // Q3
  [2.5, 8],   // Q4
  [3.5, 12],  // Q5 — slow / fine
]

function qualityFromMeta(meta: CenterlineMetadata): number {
  let best = 1
  let bestDist = Infinity
  QUALITY_MAP.forEach(([scale, samples], i) => {
    const dist = Math.abs(meta.scaleAxis - scale) + Math.abs(meta.samples - samples) * 0.3
    if (dist < bestDist) { bestDist = dist; best = i + 1 }
  })
  return best
}

type AiStatus = 'idle' | 'streaming' | 'error'

function CenterlinesEnabledPanel({
  nodeId,
  meta,
  materialToolDiameter,
  centerlineResult,
  onUpdate,
  onRemove,
}: {
  nodeId: string
  meta: CenterlineMetadata
  materialToolDiameter: number
  centerlineResult: ReturnType<typeof generateCenterlineForNode> | null
  onUpdate: (patch: Partial<CenterlineMetadata>) => void
  onRemove: () => void
}) {
  const setAiSmoothStreamingIds = useEditorStore((s) => s.setAiSmoothStreamingIds)

  const [aiStatus, setAiStatus] = useState<AiStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState(
    () => localStorage.getItem(OPENROUTER_API_KEY_STORAGE) ?? '',
  )
  const abortRef = useRef<AbortController | null>(null)

  const quality = qualityFromMeta(meta)
  const isStreaming = aiStatus === 'streaming'
  const hasAiSmoothed = Boolean(meta.aiSmoothedPathData)
  const effectiveToolDiameter = meta.toolDiameter ?? materialToolDiameter
  const toolDiameterMax = Math.max(10, materialToolDiameter * 3, effectiveToolDiameter)

  const setQuality = (q: number) => {
    const [scaleAxis, samples] = QUALITY_MAP[q - 1]
    onUpdate({ scaleAxis, samples })
  }

  const saveApiKey = () => {
    localStorage.setItem(OPENROUTER_API_KEY_STORAGE, apiKeyDraft.trim())
    setShowKeyInput(false)
  }

  const handleAiSmooth = useCallback(async () => {
    const apiKey = localStorage.getItem(OPENROUTER_API_KEY_STORAGE)?.trim()
    if (!apiKey) { setShowKeyInput(true); return }

    // Smooth only the true centerline strokes. Recovered plunge/pocket details
    // keep their own generated geometry and CNC metadata.
    const pathData = meta.aiSmoothedPathData ?? centerlineResult?.centerlinePathData ?? centerlineResult?.pathData
    if (!pathData) { setErrorMsg('No centerline path to smooth'); return }

    setAiStatus('streaming')
    setErrorMsg('')
    abortRef.current = new AbortController()
    setAiSmoothStreamingIds([nodeId])

    try {
      const svgInput = buildSvgForSmoothing(pathData)
      const result = await streamAiSmooth(svgInput, apiKey, 'openai/gpt-4o-mini', abortRef.current.signal)
      const newData = extractPathDataFromSvg(result)
      if (newData) {
        onUpdate({ aiSmoothedPathData: newData })
        setAiStatus('idle')
      } else {
        setErrorMsg('Could not parse SVG from AI response — check browser console for details')
        setAiStatus('error')
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setErrorMsg((err as Error)?.message ?? 'Unknown error')
        setAiStatus('error')
      } else {
        setAiStatus('idle')
      }
    } finally {
      setAiSmoothStreamingIds([])
    }
  }, [nodeId, meta.aiSmoothedPathData, centerlineResult, onUpdate, setAiSmoothStreamingIds])

  const handleCancel = () => {
    abortRef.current?.abort()
  }

  const handleRemove = () => {
    // Clear AI smoothing before removing centerlines so original is preserved
    if (hasAiSmoothed) onUpdate({ aiSmoothedPathData: undefined })
    onRemove()
  }

  return (
    <div className="space-y-3">
      {/* Quality slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Quality</p>
          <span className="text-xs text-foreground">
            {quality}
            <span className="ml-1 text-muted-foreground">
              — scale {QUALITY_MAP[quality - 1][0]} · {QUALITY_MAP[quality - 1][1]} samples
            </span>
          </span>
        </div>
        <input
          type="range" min={1} max={5} step={1}
          value={quality}
          disabled={isStreaming}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => setQuality(Number(e.target.value))}
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>Coarse</span><span>Fine</span>
        </div>
      </div>

      {/* Centerline bit slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Centerline bit</p>
          <span className="text-xs text-foreground">
            {round2(effectiveToolDiameter)}
            <span className="ml-1 text-muted-foreground">mm</span>
          </span>
        </div>
        <input
          type="range" min={0.1} max={toolDiameterMax} step={0.1}
          value={effectiveToolDiameter}
          disabled={isStreaming}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => onUpdate({ toolDiameter: Number(e.target.value) })}
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Fine</span>
          {meta.toolDiameter !== undefined ? (
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => onUpdate({ toolDiameter: undefined })}
            >
              Use material bit ({round2(materialToolDiameter)} mm)
            </button>
          ) : (
            <span>Using material bit</span>
          )}
        </div>
      </div>

      {/* Trim slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Trim</p>
          <span className="text-xs text-foreground">
            {round2(meta.edgeTrim)}
            <span className="ml-1 text-muted-foreground">R</span>
          </span>
        </div>
        <input
          type="range" min={0} max={5} step={0.1}
          value={meta.edgeTrim}
          disabled={isStreaming}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => onUpdate({ edgeTrim: Number(e.target.value) })}
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>None</span><span>Trim ends</span>
        </div>
      </div>

      {/* Simplify slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Simplify</p>
          <span className="text-xs text-foreground">
            {round2(meta.simplifyTolerance)}
            <span className="ml-1 text-muted-foreground">mm</span>
          </span>
        </div>
        <input
          type="range" min={0} max={2} step={0.1}
          value={meta.simplifyTolerance}
          disabled={isStreaming}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => onUpdate({ simplifyTolerance: Number(e.target.value) })}
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>More nodes</span><span>Fewer nodes</span>
        </div>
      </div>

      {/* Small detail slider */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Small details</p>
          <span className="text-xs text-foreground">
            {round2(meta.smallDetailTightness ?? 0)}
          </span>
        </div>
        <input
          type="range" min={0} max={1} step={0.05}
          value={meta.smallDetailTightness ?? 0}
          disabled={isStreaming}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(e) => onUpdate({ smallDetailTightness: Number(e.target.value) })}
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>Original</span><span>Tighter</span>
        </div>
      </div>

      {/* Force raster */}
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={meta.forceRaster === true}
          onChange={(e) => onUpdate({ forceRaster: e.target.checked })}
        />
        Force raster skeleton (hand drawings)
      </label>

      {/* Status line */}
      {centerlineResult && (
        <p className={`text-xs ${centerlineResult.error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {centerlineResult.error
            ?? `${centerlineResult.branchCount} centerline branch${centerlineResult.branchCount === 1 ? '' : 'es'} generated (${centerlineResult.segmentCount} curve segment${centerlineResult.segmentCount === 1 ? '' : 's'}).`}
          {hasAiSmoothed && !centerlineResult.error && (
            <span className="ml-1 text-primary">AI smoothed.</span>
          )}
        </p>
      )}

      {/* API key input */}
      {showKeyInput && (
        <div className="rounded-md border border-border bg-content1 p-3 space-y-2">
          <p className="text-xs text-muted-foreground">OpenRouter API key</p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="sk-or-..."
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none"
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveApiKey() }}
            />
            <Button size="sm" variant="primary" onPress={saveApiKey}>Save</Button>
          </div>
        </div>
      )}

      {/* Error */}
      {aiStatus === 'error' && errorMsg && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMsg}
        </p>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {isStreaming ? (
          <button
            className="w-full rounded-md border border-border px-3 py-2 text-xs text-foreground hover:bg-content1 flex items-center justify-between"
            onClick={handleCancel}
          >
            <span className="animate-pulse">Smoothing…</span>
            <span className="text-muted-foreground">Cancel</span>
          </button>
        ) : (
          <button
            className="w-full rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary hover:bg-primary/20"
            onClick={handleAiSmooth}
          >
            AI Smooth
          </button>
        )}

        <button
          className="w-full rounded-md border border-border px-3 py-2 text-xs text-destructive hover:bg-content1"
          onClick={handleRemove}
        >
          Remove centerlines
        </button>

        {!showKeyInput && (
          <button
            type="button"
            className="text-center text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowKeyInput((v) => !v)}
          >
            {localStorage.getItem(OPENROUTER_API_KEY_STORAGE) ? 'Change API key' : 'Set API key'}
          </button>
        )}
      </div>
    </div>
  )
}

function NumberPill({
  label,
  value,
  unit,
  onChange,
}: {
  label: string
  value: number
  unit: string
  onChange: (value: number | null) => void
}) {
  const [editValue, setEditValue] = useState<string | null>(null)

  const commit = (raw: string) => {
    const parsed = Number.parseFloat(raw)
    if (raw.trim() === '') {
      onChange(null)
    } else if (Number.isFinite(parsed)) {
      onChange(parsed)
    }
    setEditValue(null)
  }

  return (
    <div className="inline-flex h-8 items-center rounded-md border border-border bg-content1 px-2">
      <div className="shrink-0 text-xs text-muted-foreground">{label}</div>
      <input
        type="text"
        inputMode="decimal"
        className="w-12 border-0 bg-transparent px-1.5 text-sm text-foreground outline-none"
        value={editValue ?? String(value)}
        onFocus={(e) => {
          setEditValue(String(value))
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { setEditValue(null); e.currentTarget.blur() }
        }}
      />
      {unit && <div className="pl-1 text-xs text-muted-foreground">{unit}</div>}
    </div>
  )
}

function SectionHeading({
  title,
  rightContent,
}: {
  title: React.ReactNode
  rightContent?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {rightContent ? <div>{rightContent}</div> : null}
    </div>
  )
}

function SubsectionHeading({ title }: { title: string }) {
  return <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
