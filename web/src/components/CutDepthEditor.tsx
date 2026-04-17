import { useMemo, useState } from 'react'
import { Geo, GeoFill } from '@gravity-ui/icons'
import { Button, Slider, Tabs } from '@heroui/react'

import { resolveNodeCncMetadata } from '../lib/cncMetadata'
import { depthToColor, isGeometricallyOpen, normalizeEngraveType } from '../lib/cncVisuals'
import { isGroupNode, getSubtreeIds } from '../lib/editorTree'
import { useEditorStore } from '../store'
import type { CanvasNode, CncMetadata, EngraveType } from '../types/editor'
import type { NormalizedEngraveType } from '../lib/cncVisuals'

/** Resolve selected IDs (which may include groups) to leaf node IDs */
function resolveLeafIds(
  selectedIds: string[],
  nodesById: Record<string, CanvasNode>,
): string[] {
  const leafIds: string[] = []
  for (const id of selectedIds) {
    const allIds = getSubtreeIds(id, nodesById)
    for (const subId of allIds) {
      const node = nodesById[subId]
      if (node && !isGroupNode(node)) {
        leafIds.push(subId)
      }
    }
  }
  return [...new Set(leafIds)]
}

const ENGRAVE_TYPES: NormalizedEngraveType[] = ['contour', 'pocket', 'plunge']
const ENGRAVE_LABEL: Record<string, string> = {
  contour: 'Contour',
  pocket: 'Pocket',
  plunge: 'Plunge',
}

interface SelectionAnalysis {
  effectiveDepth: number | null
  isMixedDepth: boolean
  effectiveType: NormalizedEngraveType | null
  isMixedType: boolean
  allOpenPaths: boolean
}

function analyzeSelection(
  leafIds: string[],
  nodesById: Record<string, CanvasNode>,
  defaultDepth: number,
): SelectionAnalysis {
  if (leafIds.length === 0) {
    return { effectiveDepth: null, isMixedDepth: false, effectiveType: null, isMixedType: false, allOpenPaths: false }
  }

  let firstDepth: number | undefined
  let isMixedDepth = false
  let firstType: NormalizedEngraveType | undefined
  let isMixedType = false
  let allOpenPaths = true

  for (const id of leafIds) {
    const node = nodesById[id]
    if (!node) continue

    const meta = resolveNodeCncMetadata(node, nodesById)
    const depth = meta.cutDepth ?? defaultDepth
    const type = normalizeEngraveType(meta.engraveType)

    if (firstDepth === undefined) {
      firstDepth = depth
    } else if (depth !== firstDepth) {
      isMixedDepth = true
    }

    if (firstType === undefined) {
      firstType = type
    } else if (type !== firstType) {
      isMixedType = true
    }

    // Only geometrically-open paths are restricted to contour. Closed shapes
    // without a fill (e.g. makerjs-generated tenon/domino output) can still
    // be pocketed or plunged.
    if (!isGeometricallyOpen(node)) {
      allOpenPaths = false
    }
  }

  return {
    effectiveDepth: isMixedDepth ? null : (firstDepth ?? defaultDepth),
    isMixedDepth,
    effectiveType: isMixedType ? null : (firstType ?? null),
    isMixedType,
    allOpenPaths,
  }
}

export function CutDepthEditor() {
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const nodesById = useEditorStore((s) => s.nodesById)
  const artboard = useEditorStore((s) => s.artboard)
  const defaultDepth = useEditorStore((s) => s.machiningSettings.defaultDepthMm)
  const updateCncMetadata = useEditorStore((s) => s.updateCncMetadata)
  const selectMany = useEditorStore((s) => s.selectMany)

  const leafIds = useMemo(
    () => resolveLeafIds(selectedIds, nodesById),
    [selectedIds, nodesById],
  )

  const analysis = useMemo(
    () => analyzeSelection(leafIds, nodesById, defaultDepth),
    [leafIds, nodesById, defaultDepth],
  )

  const allCutDepthGroups = useMemo(
    () => buildCutDepthGroups(nodesById, defaultDepth),
    [nodesById, defaultDepth],
  )

  const applyAll = (patch: Partial<CncMetadata>) => {
    leafIds.forEach((id) => updateCncMetadata(id, patch))
  }

  const applyToIds = (ids: string[], patch: Partial<CncMetadata>) => {
    ids.forEach((id) => updateCncMetadata(id, patch))
  }

  const clearAll = () => {
    leafIds.forEach((id) =>
      updateCncMetadata(id, { cutDepth: undefined, engraveType: undefined }),
    )
  }

  const hasSelection = selectedIds.length > 0

  return (
    <section className="space-y-4">
      <SectionHeading
        title="Cut depths"
        rightContent={
          selectedIds.length > 1 ? (
            <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
              Editing {selectedIds.length} selected
            </span>
          ) : !hasSelection && allCutDepthGroups.length > 0 ? (
            <span className="rounded-full border border-border bg-content1 px-2 py-0.5 text-xs text-muted-foreground">
              {allCutDepthGroups.length} groups
            </span>
          ) : null
        }
      />

      {!hasSelection ? (
        <CutDepthGroupsList
          groups={allCutDepthGroups}
          maxDepth={artboard.thickness}
          onDepthChange={(ids, value) => applyToIds(ids, { cutDepth: value })}
          onFillModeChange={(ids, value) => applyToIds(ids, { engraveType: value })}
          onSelectGroup={selectMany}
        />
      ) : (
        <DepthEditor
          analysis={analysis}
          maxDepth={artboard.thickness}
          defaultDepth={defaultDepth}
          onDepthChange={(value) => applyAll({ cutDepth: value })}
          onTypeChange={(value) => applyAll({ engraveType: value })}
          onClear={clearAll}
        />
      )}
    </section>
  )
}

// --- Shared slider control ---

function DepthSliderControl({
  value,
  maxDepth,
  isMixed = false,
  onChange,
}: {
  value: number
  maxDepth: number
  isMixed?: boolean
  onChange: (v: number | undefined) => void
}) {
  const [editValue, setEditValue] = useState<string | null>(null)
  const safeMax = maxDepth || 1

  const commit = (raw: string) => {
    if (raw.trim() === '') {
      onChange(undefined)
    } else {
      const parsed = parseFloat(raw)
      if (Number.isFinite(parsed) && parsed >= 0) {
        onChange(Math.min(parsed, safeMax))
      }
    }
    setEditValue(null)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Depth</span>
        <div className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            placeholder={isMixed ? '--' : undefined}
            className="w-14 rounded border border-border bg-content1 px-1.5 py-0.5 text-right text-sm font-semibold text-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-primary/50"
            value={editValue ?? (isMixed ? '' : String(value))}
            onFocus={(e) => {
              setEditValue(isMixed ? '' : String(value))
              requestAnimationFrame(() => e.target.select())
            }}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') { setEditValue(null); e.currentTarget.blur() }
            }}
          />
          <span className="text-xs text-muted-foreground">mm</span>
        </div>
      </div>
      <Slider
        aria-label="Cut depth"
        value={isMixed ? 0 : value}
        minValue={0}
        maxValue={safeMax}
        step={0.1}
        onChange={(v) => onChange(v as number)}
      >
        <Slider.Track
          className="relative h-2 w-full cursor-pointer rounded-full"
          style={{
            background: 'linear-gradient(to right, hsl(60,100%,45%), hsl(30,100%,45%), hsl(0,100%,45%))',
          }}
        >
          <Slider.Fill className="absolute inset-y-0 left-0 rounded-full bg-white/25" />
          <Slider.Thumb
            className="block h-4 w-4 rounded-full border-2 border-white shadow-md outline-none"
            style={{
              background: isMixed ? '#888' : depthToColor(value, maxDepth),
            }}
          />
        </Slider.Track>
      </Slider>
      <div className="flex justify-between text-[10px] text-muted-foreground/50">
        <span>0</span>
        <span>{maxDepth} mm</span>
      </div>
    </div>
  )
}

// --- Depth editor for selected shapes ---

function DepthEditor({
  analysis,
  maxDepth,
  defaultDepth,
  onDepthChange,
  onTypeChange,
  onClear,
}: {
  analysis: SelectionAnalysis
  maxDepth: number
  defaultDepth: number
  onDepthChange: (value: number | undefined) => void
  onTypeChange: (value: EngraveType | undefined) => void
  onClear: () => void
}) {
  const displayDepth = analysis.effectiveDepth ?? defaultDepth
  const availableTypes: NormalizedEngraveType[] = analysis.allOpenPaths ? ['contour'] : ENGRAVE_TYPES

  return (
    <div className="space-y-4">
      <DepthSliderControl
        value={displayDepth}
        maxDepth={maxDepth}
        isMixed={analysis.isMixedDepth}
        onChange={onDepthChange}
      />

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Part fill</p>
        <FillModeTabs
          availableTypes={availableTypes}
          selectedType={analysis.isMixedType ? null : analysis.effectiveType}
          onTypeChange={(value) => onTypeChange(value)}
        />
        {analysis.isMixedType && (
          <p className="text-xs text-muted-foreground/70">Multiple fill types selected</p>
        )}
      </div>

      <Button variant="secondary" className="w-full text-sm text-danger" onPress={onClear}>
        Clear CNC data
      </Button>
    </div>
  )
}

// --- Overview groups list (no selection) ---

interface CutDepthGroup {
  key: string
  cutDepth: number
  nodeIds: string[]
  partCount: number
  fillMode?: NormalizedEngraveType
  mixedFill: boolean
  isDefault: boolean
  color: string
}

function CutDepthGroupsList({
  groups,
  maxDepth,
  onDepthChange,
  onFillModeChange,
  onSelectGroup,
}: {
  groups: CutDepthGroup[]
  maxDepth: number
  onDepthChange: (ids: string[], value: number) => void
  onFillModeChange: (ids: string[], value: EngraveType) => void
  onSelectGroup: (ids: string[]) => void
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-content1 px-3 py-3 text-sm text-muted-foreground">
        No assigned parts yet.
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {groups.map((group) => (
        <div key={group.key} className="rounded-md border border-border bg-content1 p-3 space-y-3">
          {/* Header */}
          <div className="flex items-start gap-2">
            <ColorSwatch color={group.color} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground leading-tight">
                {formatCutDepth(group.cutDepth)}
                {group.isDefault && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">(default)</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {group.partCount} {group.partCount === 1 ? 'part' : 'parts'}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="min-h-7 rounded-full px-3 text-xs"
              onPress={() => onSelectGroup(group.nodeIds)}
            >
              Select
            </Button>
          </div>

          {/* Depth slider */}
          <DepthSliderControl
            value={group.cutDepth}
            maxDepth={maxDepth}
            onChange={(v) => {
              if (v !== undefined && v >= 0) onDepthChange(group.nodeIds, v)
            }}
          />

          {/* Part fill */}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Part fill</p>
            <FillModeTabs
              availableTypes={ENGRAVE_TYPES}
              selectedType={group.mixedFill ? null : group.fillMode ?? null}
              onTypeChange={(value) => {
                if (value) onFillModeChange(group.nodeIds, value)
              }}
            />
            {group.mixedFill && (
              <p className="text-xs text-muted-foreground/70">Mixed fill types.</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// --- Shared sub-components ---

function SectionHeading({
  title,
  rightContent,
}: {
  title: string
  rightContent?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="shrink-0 text-sm font-semibold text-foreground">{title}</h3>
      {rightContent ? <div>{rightContent}</div> : null}
    </div>
  )
}

function ColorSwatch({ color, className = '' }: { color: string; className?: string }) {
  return (
    <span
      className={`h-4 w-4 shrink-0 rounded-[4px] border border-border ${className}`.trim()}
      style={{ backgroundColor: color }}
    />
  )
}

function FillModeIcon({ mode }: { mode: NormalizedEngraveType }) {
  if (mode === 'contour') {
    return <Geo className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
  }
  return <GeoFill className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
}

function FillModeTabs({
  availableTypes,
  selectedType,
  onTypeChange,
}: {
  availableTypes: NormalizedEngraveType[]
  selectedType: NormalizedEngraveType | null
  onTypeChange: (value: EngraveType | undefined) => void
}) {
  return (
    <Tabs
      className="w-full"
      selectedKey={selectedType ?? undefined}
      onSelectionChange={(key) => onTypeChange(String(key) as EngraveType)}
    >
      <Tabs.ListContainer className="w-full">
        <Tabs.List
          aria-label="Part fill modes"
          className="w-full rounded-full bg-content2 p-1 *:min-w-0 *:flex-1 *:h-7 *:px-2.5 *:text-xs *:font-medium *:text-white/70 *:data-[selected=true]:text-white"
        >
          {availableTypes.map((type) => (
            <Tabs.Tab key={type} id={type}>
              <span className="flex items-center justify-center gap-1.5 text-current">
                <FillModeIcon mode={type} />
                <span>{ENGRAVE_LABEL[type]}</span>
              </span>
              <Tabs.Indicator className="rounded-full bg-primary" />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  )
}

function formatCutDepth(depth: number): string {
  return `${depth.toFixed(2)} mm`
}

// --- Build depth groups ---

function buildCutDepthGroups(
  nodesById: Record<string, CanvasNode>,
  defaultDepth: number,
): CutDepthGroup[] {
  const groups = new Map<string, {
    cutDepth: number
    nodeIds: string[]
    fillModes: Set<NormalizedEngraveType>
    isDefault: boolean
  }>()

  Object.values(nodesById).forEach((node) => {
    if (isGroupNode(node)) return

    const meta = resolveNodeCncMetadata(node, nodesById)
    const cutDepth = meta.cutDepth ?? defaultDepth
    const isDefault = meta.cutDepth === undefined
    const key = cutDepth.toFixed(3)
    const fillMode = normalizeEngraveType(meta.engraveType)
    const existing = groups.get(key)

    if (existing) {
      existing.nodeIds.push(node.id)
      if (fillMode) existing.fillModes.add(fillMode)
      if (!isDefault) existing.isDefault = false
      return
    }

    groups.set(key, {
      cutDepth,
      nodeIds: [node.id],
      fillModes: fillMode ? new Set([fillMode]) : new Set(),
      isDefault,
    })
  })

  return Array.from(groups.values())
    .sort((a, b) => a.cutDepth - b.cutDepth)
    .map((group) => {
      const [fillMode] = Array.from(group.fillModes)
      return {
        key: `${group.cutDepth.toFixed(3)}-${fillMode ?? 'unset'}`,
        cutDepth: group.cutDepth,
        nodeIds: group.nodeIds,
        partCount: group.nodeIds.length,
        fillMode,
        mixedFill: group.fillModes.size > 1,
        isDefault: group.isDefault,
        color: depthToColor(group.cutDepth),
      }
    })
}
