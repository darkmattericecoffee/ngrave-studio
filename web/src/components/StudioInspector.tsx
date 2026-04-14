import { useMemo, useState } from 'react'
import { Button, ButtonGroup, Tabs } from '@heroui/react'
import { LayoutCells } from '@gravity-ui/icons'

import { resizeGeneratorToBounds, supportsGeneratorResizeBack } from '../lib/generators'
import { getNodeSize } from '../lib/nodeDimensions'
import { generateCenterlineForNode } from '../lib/centerline'
import { AppIcon, Icons } from '../lib/icons'
import { useEditorStore } from '../store'
import type { CanvasNode, GroupNode } from '../types/editor'
import type { MaterialPreset } from '../lib/materialPresets'
import { MaterialTabContent, PreviewTabContent } from './MaterialTabContent'
import { CutDepthEditor } from './CutDepthEditor'

type InspectorTab = 'design' | 'material'

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
            <Tabs.List aria-label="Inspector tabs">
              <Tabs.Tab id="design">
                Design
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="material">
                {isPreview3d ? 'Camera' : 'Material'}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {activeTab === 'design' ? (
          <DesignTabContent />
        ) : isPreview3d ? (
          <PreviewTabContent />
        ) : (
          <MaterialTabContent materialPreset={materialPreset} onMaterialChange={onMaterialChange} />
        )}
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
  const enableGrid = useEditorStore((s) => s.enableGrid)
  const disableGrid = useEditorStore((s) => s.disableGrid)
  const updateGridMetadata = useEditorStore((s) => s.updateGridMetadata)
  const enableCenterline = useEditorStore((s) => s.enableCenterline)
  const disableCenterline = useEditorStore((s) => s.disableCenterline)
  const updateCenterlineMetadata = useEditorStore((s) => s.updateCenterlineMetadata)

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
          <div className="space-y-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Horizontal</span>
              <ButtonGroup orientation="horizontal" variant="tertiary">
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
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Vertical</span>
              <ButtonGroup orientation="horizontal" variant="tertiary">
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

      {/* Selected art */}
      <section className="space-y-4">
        <SectionHeading title="Selected art" />
        {firstNode ? (
          <div className="rounded-md border border-border bg-content1 px-3 py-3">
            <p className="text-sm font-medium text-foreground">{firstNode.name || firstNode.id}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {firstNode.type}
              {selectedIds.length > 1 ? ` · ${selectedIds.length} selected` : ''}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-content1 px-3 py-3 text-sm text-muted-foreground">
            Select an art object to edit its placement and dimensions.
          </div>
        )}
      </section>

      {/* Dimensions & offset */}
      {firstNode && selectionBounds && selectionOffset && (
        <section className="space-y-4">
          <SectionHeading title="Dimensions" />
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
          <SectionHeading title="Offset" />
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
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <NumberPill
                  label="Scale"
                  value={round2(firstNode.centerlineMetadata.scaleAxis)}
                  unit=""
                  onChange={(v) => {
                    if (v === null) return
                    updateCenterlineMetadata(firstNode.id, { scaleAxis: v })
                  }}
                />
                <NumberPill
                  label="Samples"
                  value={firstNode.centerlineMetadata.samples}
                  unit=""
                  onChange={(v) => {
                    if (v === null) return
                    updateCenterlineMetadata(firstNode.id, { samples: Math.round(v) })
                  }}
                />
                <NumberPill
                  label="Trim"
                  value={round2(firstNode.centerlineMetadata.edgeTrim)}
                  unit="R"
                  onChange={(v) => {
                    if (v === null) return
                    updateCenterlineMetadata(firstNode.id, { edgeTrim: v })
                  }}
                />
                <NumberPill
                  label="Simplify"
                  value={round2(firstNode.centerlineMetadata.simplifyTolerance)}
                  unit="mm"
                  onChange={(v) => {
                    if (v === null) return
                    updateCenterlineMetadata(firstNode.id, { simplifyTolerance: v })
                  }}
                />
              </div>
              {centerlineResult ? (
                <p className={`text-xs ${centerlineResult.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {centerlineResult.error ?? `${centerlineResult.branchCount} centerline branch${centerlineResult.branchCount === 1 ? '' : 'es'} generated (${centerlineResult.segmentCount} curve segment${centerlineResult.segmentCount === 1 ? '' : 's'}).`}
                </p>
              ) : null}
              <button
                className="w-full rounded-md border border-border px-3 py-2 text-xs text-destructive hover:bg-content1"
                onClick={() => disableCenterline(firstNode.id)}
              >
                Remove centerlines
              </button>
            </div>
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

      {/* Cut depths */}
      <CutDepthEditor />
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
  title: string
  rightContent?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {rightContent ? <div>{rightContent}</div> : null}
    </div>
  )
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
