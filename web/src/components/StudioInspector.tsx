import { useMemo, useState } from 'react'
import { Button, Tabs } from '@heroui/react'

import { getNodeSize } from '../lib/nodeDimensions'
import { useEditorStore } from '../store'
import type { CanvasNode } from '../types/editor'
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
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)

  const firstNode = selectedIds.length > 0 ? nodesById[selectedIds[0]] : null

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

  return (
    <div className="space-y-5">
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
      <div className="pl-1 text-xs text-muted-foreground">{unit}</div>
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
