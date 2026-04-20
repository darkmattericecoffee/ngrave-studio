import { useEffect, useMemo, useState } from 'react'
import { SearchField } from '@heroui/react'
import { ChevronDown, ChevronRight, Geo, GeoFill, LayoutCells, Sparkles } from '@gravity-ui/icons'

import { resolveNodeCncMetadata } from '../lib/cncMetadata'
import { AppIcon, Icons } from '../lib/icons'
import { depthToColor, isGeometricallyOpen, normalizeEngraveType } from '../lib/cncVisuals'
import { computeCutOrder } from '../lib/cutOrder'
import { boundsToViewBox, getNodePreviewBounds } from '../lib/nodeBounds'
import { useEditorStore } from '../store'
import { CutOrderView } from './CutOrderView'
import { EditorContextMenu } from './EditorContextMenu'
import type { CanvasNode, GroupNode, LineNode, MachiningSettings } from '../types/editor'
import type { NormalizedEngraveType } from '../lib/cncVisuals'

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

const LAYER_PREVIEW_SIZE = 24
const DEPTH_EPSILON = 0.0001

const ENGRAVE_LABEL: Record<NormalizedEngraveType, string> = {
  contour: 'Contour',
  pocket: 'Pocket',
  plunge: 'Plunge',
}

interface LayerCncSummary {
  depth: number | null
  depthLabel: string
  mode: NormalizedEngraveType | 'mixed'
  modeLabel: string
}

// Build a flat ordered list of all rendered node IDs (depth-first), respecting
// collapsed state and query filter. Used for shift-click and drag range selection.
function buildFlatList(
  ids: string[],
  nodesById: Record<string, CanvasNode>,
  collapsed: Record<string, boolean>,
  query: string,
): string[] {
  const result: string[] = []
  for (const id of ids) {
    const node = nodesById[id]
    if (!node) continue
    if (!matchesQuery(node, nodesById, query.toLowerCase())) continue
    result.push(id)
    if (node.type === 'group' && !collapsed[id]) {
      result.push(...buildFlatList((node as GroupNode).childIds, nodesById, collapsed, query))
    }
  }
  return result
}

function collectLeafNodes(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
): CanvasNode[] {
  if (node.type !== 'group') return [node]

  const childNodes = (node as GroupNode).childIds.flatMap((childId) => {
    const child = nodesById[childId]
    return child ? collectLeafNodes(child, nodesById) : []
  })

  return childNodes.length > 0 ? childNodes : [node]
}

function inferEngraveMode(node: CanvasNode, nodesById: Record<string, CanvasNode>): NormalizedEngraveType {
  const metadataMode = normalizeEngraveType(resolveNodeCncMetadata(node, nodesById).engraveType)
  if (metadataMode) return metadataMode
  return isGeometricallyOpen(node) ? 'contour' : 'pocket'
}

function formatDepth(depth: number): string {
  return `${Number(depth.toFixed(2))} mm`
}

export function buildLayerCncSummary(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  defaultDepth: number,
): LayerCncSummary {
  const leafNodes = collectLeafNodes(node, nodesById)
  const depths = new Set<string>()
  const modes = new Set<NormalizedEngraveType>()
  let firstDepth: number | null = null
  let firstMode: NormalizedEngraveType | null = null

  leafNodes.forEach((leaf) => {
    const metadata = resolveNodeCncMetadata(leaf, nodesById)
    const depth = metadata.cutDepth ?? defaultDepth
    const mode = inferEngraveMode(leaf, nodesById)

    if (firstDepth === null) firstDepth = depth
    if (firstMode === null) firstMode = mode

    depths.add((Math.round(depth / DEPTH_EPSILON) * DEPTH_EPSILON).toFixed(4))
    modes.add(mode)
  })

  const mixedDepth = depths.size > 1
  const mixedMode = modes.size > 1
  const mode: NormalizedEngraveType | 'mixed' = mixedMode ? 'mixed' : (firstMode ?? 'pocket')

  return {
    depth: mixedDepth ? null : firstDepth ?? defaultDepth,
    depthLabel: mixedDepth ? 'Mixed depth' : formatDepth(firstDepth ?? defaultDepth),
    mode,
    modeLabel: mode === 'mixed' ? 'Mixed' : ENGRAVE_LABEL[mode],
  }
}

function FillModeIcon({
  summary,
}: {
  summary: LayerCncSummary
}) {
  const Icon = summary.mode === 'contour' ? Geo : GeoFill
  const color = summary.depth != null ? depthToColor(summary.depth) : undefined

  return (
    <Icon
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      aria-hidden="true"
      style={color ? { color } : undefined}
    />
  )
}

export function LayerCncSummaryTag({
  summary,
}: {
  summary: LayerCncSummary
}) {
  return (
    <span
      className="flex min-w-[5.5rem] items-center justify-end gap-1.5 whitespace-nowrap text-right text-xs text-muted-foreground"
      title={`${summary.modeLabel} · ${summary.depthLabel}`}
    >
      <FillModeIcon summary={summary} />
      <span>{summary.depthLabel}</span>
    </span>
  )
}

export function LayerName({
  node,
  isRenaming,
  draft,
  className,
  onStartRename,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  node: CanvasNode
  isRenaming: boolean
  draft: string
  className?: string
  onStartRename: (node: CanvasNode) => void
  onDraftChange: (value: string) => void
  onCommit: (node: CanvasNode) => void
  onCancel: () => void
}) {
  if (isRenaming) {
    return (
      <input
        autoFocus
        value={draft}
        aria-label="Layer name"
        className="min-w-0 flex-1 rounded border border-primary/40 bg-background px-1.5 py-0.5 text-sm text-foreground outline-none ring-1 ring-primary/20"
        onChange={(event) => onDraftChange(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={() => onCommit(node)}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            onCommit(node)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
    )
  }

  return (
    <span
      className={className}
      title="Double-click to rename"
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onStartRename(node)
      }}
    >
      {node.name || node.id}
    </span>
  )
}

function nodeTransform(node: CanvasNode): string | undefined {
  const transforms: string[] = []

  if (node.x !== 0 || node.y !== 0) {
    transforms.push(`translate(${node.x} ${node.y})`)
  }
  if (node.rotation !== 0) {
    transforms.push(`rotate(${node.rotation})`)
  }
  if (node.scaleX !== 1 || node.scaleY !== 1) {
    transforms.push(`scale(${node.scaleX} ${node.scaleY})`)
  }

  return transforms.length > 0 ? transforms.join(' ') : undefined
}

function paintOrUndefined(value?: string): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'none') return undefined
  return normalized
}

function shapePaint(node: Exclude<CanvasNode, GroupNode>): {
  fill: string
  stroke: string
  strokeWidth: number
} {
  const fill = paintOrUndefined('fill' in node ? node.fill : undefined)
  const stroke = paintOrUndefined('stroke' in node ? node.stroke : undefined)
  const strokeWidth = 'strokeWidth' in node ? node.strokeWidth : 1
  const fallbackStroke = fill ? 'none' : 'currentColor'

  return {
    fill: fill ?? 'none',
    stroke: stroke ?? fallbackStroke,
    strokeWidth: Boolean(stroke) || !fill ? Math.max(strokeWidth || 1, 1) : 0,
  }
}

function linePoints(points: number[]): string {
  const pairs: string[] = []
  for (let index = 0; index + 1 < points.length; index += 2) {
    pairs.push(`${points[index]},${points[index + 1]}`)
  }
  return pairs.join(' ')
}

function renderPreviewNode(node: CanvasNode, nodesById: Record<string, CanvasNode>) {
  const transform = nodeTransform(node)
  const opacity = node.opacity === 1 ? undefined : node.opacity

  if (node.type === 'group') {
    return (
      <g key={node.id} transform={transform} opacity={opacity}>
        {(node as GroupNode).childIds.map((childId) => {
          const child = nodesById[childId]
          return child ? renderPreviewNode(child, nodesById) : null
        })}
      </g>
    )
  }

  const paint = shapePaint(node)
  const sharedProps = {
    transform,
    opacity,
    fill: paint.fill,
    stroke: paint.stroke,
    strokeWidth: paint.strokeWidth,
    vectorEffect: 'non-scaling-stroke',
  } as const

  if (node.type === 'rect') {
    return (
      <rect
        key={node.id}
        {...sharedProps}
        x={0}
        y={0}
        width={node.width}
        height={node.height}
        rx={node.cornerRadius}
      />
    )
  }

  if (node.type === 'circle') {
    return <circle key={node.id} {...sharedProps} cx={0} cy={0} r={node.radius} />
  }

  if (node.type === 'line') {
    const lineNode = node as LineNode
    const Tag = lineNode.closed ? 'polygon' : 'polyline'
    return (
      <Tag
        key={node.id}
        {...sharedProps}
        points={linePoints(lineNode.points)}
        fill={lineNode.closed ? paint.fill : 'none'}
        strokeLinecap={lineNode.lineCap}
        strokeLinejoin={lineNode.lineJoin}
        fillRule={lineNode.fillRule}
      />
    )
  }

  return (
    <path
      key={node.id}
      {...sharedProps}
      d={node.data}
      fillRule={node.fillRule}
    />
  )
}

export function LayerPreview({
  node,
  nodesById,
}: {
  node: CanvasNode
  nodesById: Record<string, CanvasNode>
}) {
  const bounds = useMemo(() => getNodePreviewBounds(node, nodesById), [node, nodesById])

  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-white text-muted-foreground"
      aria-hidden="true"
    >
      {bounds ? (
        <svg
          width={LAYER_PREVIEW_SIZE}
          height={LAYER_PREVIEW_SIZE}
          viewBox={boundsToViewBox(bounds)}
          className="h-full w-full"
        >
          {renderPreviewNode(node, nodesById)}
        </svg>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      )}
    </span>
  )
}

export function LayerTree() {
  const nodesById = useEditorStore((s) => s.nodesById)
  const rootIds = useEditorStore((s) => s.rootIds)
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const selectOne = useEditorStore((s) => s.selectOne)
  const selectMany = useEditorStore((s) => s.selectMany)
  const toggleSelection = useEditorStore((s) => s.toggleSelection)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)
  const setHoveredId = useEditorStore((s) => s.setHoveredId)
  const defaultDepth = useEditorStore((s) => s.machiningSettings.defaultDepthMm)
  const cutOrderStrategy = useEditorStore((s) => s.machiningSettings.cutOrderStrategy)
  const manualCutOrder = useEditorStore((s) => s.machiningSettings.manualCutOrder)
  const setMachiningSettings = useEditorStore((s) => s.setMachiningSettings)
  const pushHistory = useEditorStore((s) => s.pushHistory)
  const [view, setView] = useState<'layers' | 'cutOrder'>('layers')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragAnchorId, setDragAnchorId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [contextMenu, setContextMenu] = useState({
    isOpen: false,
    x: 0,
    y: 0,
    nodeId: null as string | null,
  })

  const filteredRootIds = rootIds.filter((id) => {
    const node = nodesById[id]
    if (!node) return false
    if (!query.trim()) return true
    return matchesQuery(node, nodesById, query.toLowerCase())
  })

  const flatList = useMemo(
    () => buildFlatList(rootIds, nodesById, collapsed, query),
    [rootIds, nodesById, collapsed, query],
  )

  const cutOrder = useMemo(
    () => computeCutOrder(rootIds, nodesById, cutOrderStrategy, manualCutOrder),
    [rootIds, nodesById, cutOrderStrategy, manualCutOrder],
  )

  useEffect(() => {
    const onMouseUp = () => setIsDragging(false)
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  function handleRowMouseDown(id: string, e: React.MouseEvent) {
    if (renamingId) return
    if (e.button !== 0) return
    e.preventDefault() // prevent text selection during drag

    if (e.shiftKey && lastClickedId !== null) {
      const a = flatList.indexOf(lastClickedId)
      const b = flatList.indexOf(id)
      if (a >= 0 && b >= 0) {
        selectMany(flatList.slice(Math.min(a, b), Math.max(a, b) + 1))
      }
      return
    }
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(id)
    } else {
      selectOne(id)
    }
    setLastClickedId(id)
    setIsDragging(true)
    setDragAnchorId(id)
  }

  function handleCutOrderRowSelect(id: string, e: React.MouseEvent) {
    if (e.button !== 0) return

    if (e.shiftKey && lastClickedId !== null) {
      const orderIds = cutOrder.sequence.map((leaf) => leaf.nodeId)
      const a = orderIds.indexOf(lastClickedId)
      const b = orderIds.indexOf(id)
      if (a >= 0 && b >= 0) {
        selectMany(orderIds.slice(Math.min(a, b), Math.max(a, b) + 1))
      }
      return
    }

    if (e.metaKey || e.ctrlKey) {
      toggleSelection(id)
    } else {
      selectOne(id)
    }
    setLastClickedId(id)
  }

  function handleRowContextMenu(id: string, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (!selectedIds.includes(id)) {
      selectOne(id)
    }

    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      nodeId: id,
    })
  }

  function handleRowMouseEnter(id: string) {
    setHoveredId(id)
    if (!isDragging || dragAnchorId === null) return
    const a = flatList.indexOf(dragAnchorId)
    const b = flatList.indexOf(id)
    if (a >= 0 && b >= 0) {
      selectMany(flatList.slice(Math.min(a, b), Math.max(a, b) + 1))
    }
  }

  function handleRowMouseLeave() {
    setHoveredId(null)
  }

  function handleToggleCollapsed(id: string) {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  }

  function handleToggleVisible(id: string) {
    const node = nodesById[id]
    if (node) updateNodeTransform(id, { visible: !node.visible })
  }

  function handleToggleLocked(id: string) {
    const node = nodesById[id]
    if (node) updateNodeTransform(id, { locked: !node.locked })
  }

  function handleStartRename(node: CanvasNode) {
    setRenamingId(node.id)
    setRenameDraft(node.name || node.id)
    setIsDragging(false)
    setDragAnchorId(null)
  }

  function handleCancelRename() {
    setRenamingId(null)
    setRenameDraft('')
  }

  function handleCommitRename(node: CanvasNode) {
    const nextName = renameDraft.trim()
    handleCancelRename()

    if (!nextName || nextName === node.name) return
    pushHistory()
    updateNodeTransform(node.id, { name: nextName } as Partial<CanvasNode>)
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <EditorContextMenu
        isOpen={contextMenu.isOpen}
        x={contextMenu.x}
        y={contextMenu.y}
        showRename
        onRename={() => {
          const node = contextMenu.nodeId ? nodesById[contextMenu.nodeId] : null
          if (node) handleStartRename(node)
        }}
        onOpenChange={(isOpen) => setContextMenu((current) => ({ ...current, isOpen }))}
      />
      <div className="flex items-center gap-1 border-b border-border px-3 pt-3">
        <button
          type="button"
          className={cn(
            'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            view === 'layers'
              ? 'bg-[var(--surface-tertiary)] text-foreground'
              : 'text-muted-foreground hover:bg-[var(--surface-secondary)]',
          )}
          onClick={() => setView('layers')}
        >
          Layers
        </button>
        <button
          type="button"
          className={cn(
            'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            view === 'cutOrder'
              ? 'bg-[var(--surface-tertiary)] text-foreground'
              : 'text-muted-foreground hover:bg-[var(--surface-secondary)]',
          )}
          onClick={() => setView('cutOrder')}
        >
          Cut Order
        </button>
      </div>
      {view === 'cutOrder' ? (
        <div className="border-b border-border px-4 py-3">
          <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Group ordering</span>
            <select
              className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={cutOrderStrategy}
              onChange={(e) =>
                setMachiningSettings({
                  cutOrderStrategy: e.target.value as MachiningSettings['cutOrderStrategy'],
                  ...(e.target.value !== 'manual' ? { manualCutOrder: null } : {}),
                })
              }
            >
              <option value="svg">SVG order</option>
              <option value="ltr">Left → Right</option>
              <option value="btt">Bottom → Top</option>
              {cutOrderStrategy === 'manual' && <option value="manual">Custom</option>}
            </select>
          </label>
          {cutOrderStrategy === 'manual' && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Dragging made this a custom order. Pick a preset to rebuild it.
            </p>
          )}
        </div>
      ) : (
      <div className="border-b border-border px-4 py-3">
        <SearchField value={query} onChange={setQuery} fullWidth aria-label="Filter art objects">
          <SearchField.Group aria-label="Filter art objects">
            <SearchField.SearchIcon>
              <svg height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
                <path
                  clipRule="evenodd"
                  d="M12.5 4c0 .174-.071.513-.885.888S9.538 5.5 8 5.5s-2.799-.237-3.615-.612C3.57 4.513 3.5 4.174 3.5 4s.071-.513.885-.888S6.462 2.5 8 2.5s2.799.237 3.615.612c.814.375.885.714.885.888m-1.448 2.66C10.158 6.888 9.115 7 8 7s-2.158-.113-3.052-.34l1.98 2.905c.21.308.322.672.322 1.044v3.37q.088.02.25.021c.422 0 .749-.14.95-.316c.185-.162.3-.38.3-.684v-2.39c0-.373.112-.737.322-1.045zM8 1c3.314 0 6 1 6 3a3.24 3.24 0 0 1-.563 1.826l-3.125 4.584a.35.35 0 0 0-.062.2V13c0 1.5-1.25 2.5-2.75 2.5s-1.75-1-1.75-1v-3.89a.35.35 0 0 0-.061-.2L2.563 5.826A3.24 3.24 0 0 1 2 4c0-2 2.686-3 6-3m-.88 12.936q-.015-.008-.013-.01z"
                  fill="currentColor"
                  fillRule="evenodd"
                />
              </svg>
            </SearchField.SearchIcon>
            <SearchField.Input className="w-full" placeholder="Filter art objects" />
            <SearchField.ClearButton>
              <svg height="16" viewBox="0 0 16 16" width="16" xmlns="http://www.w3.org/2000/svg">
                <path
                  clipRule="evenodd"
                  d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14M6.53 5.47a.75.75 0 0 0-1.06 1.06L6.94 8L5.47 9.47a.75.75 0 1 0 1.06 1.06L8 9.06l1.47 1.47a.75.75 0 1 0 1.06-1.06L9.06 8l1.47-1.47a.75.75 0 1 0-1.06-1.06L8 6.94z"
                  fill="currentColor"
                  fillRule="evenodd"
                />
              </svg>
            </SearchField.ClearButton>
          </SearchField.Group>
        </SearchField>
      </div>
      )}

      {view === 'cutOrder' ? (
        <CutOrderView
          cutOrder={cutOrder}
          nodesById={nodesById}
          selectedIds={selectedIds}
          defaultDepth={defaultDepth}
          onSelect={(id, e) => handleCutOrderRowSelect(id, e)}
          onHover={handleRowMouseEnter}
          onHoverLeave={handleRowMouseLeave}
          onContextMenu={handleRowContextMenu}
          onReorder={(nextOrder) =>
            setMachiningSettings({
              cutOrderStrategy: 'manual',
              manualCutOrder: nextOrder,
            })
          }
        />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {filteredRootIds.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-[var(--surface)] px-3 py-3 text-sm text-muted-foreground">
            {rootIds.length === 0
              ? 'Drop an SVG or use Import SVG to start.'
              : 'No results match your search.'}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRootIds.map((id) => {
              const node = nodesById[id]
              if (!node) return null
              const isGroup = node.type === 'group'
              const selected = selectedIds.includes(id)
              const isCollapsed = collapsed[id] ?? false
              const cncSummary = buildLayerCncSummary(node, nodesById, defaultDepth)

              return (
                <div key={id} className="rounded-lg border border-border bg-[var(--surface)]">
                  <button
                    className={cn(
                      'group/row flex w-full items-center justify-between rounded-lg px-3 py-3 text-left transition-colors hover:bg-[var(--surface-secondary)] active:bg-[var(--surface-tertiary)]',
                      selected && 'bg-[var(--surface-tertiary)]',
                      !node.visible && 'opacity-50',
                    )}
                    onMouseDown={(e) => handleRowMouseDown(id, e)}
                    onContextMenu={(e) => handleRowContextMenu(id, e)}
                    onMouseEnter={() => handleRowMouseEnter(id)}
                    onMouseLeave={handleRowMouseLeave}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {isGroup ? (
                        <span
                          role="button"
                          tabIndex={0}
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-[var(--surface-tertiary)]"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleToggleCollapsed(id)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              handleToggleCollapsed(id)
                            }
                          }}
                        >
                          {isCollapsed
                            ? <ChevronRight className="h-4 w-4" />
                            : <ChevronDown className="h-4 w-4" />}
                        </span>
                      ) : (
                        <span className="inline-flex h-5 w-5 items-center justify-center" />
                      )}
                      <AppIcon icon={Icons.picture} className="h-4 w-4 text-muted-foreground" />
                      <LayerPreview node={node} nodesById={nodesById} />
                      <LayerName
                        node={node}
                        isRenaming={renamingId === id}
                        draft={renameDraft}
                        className="truncate text-sm font-medium"
                        onStartRename={handleStartRename}
                        onDraftChange={setRenameDraft}
                        onCommit={handleCommitRename}
                        onCancel={handleCancelRename}
                      />
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={node.visible ? 'Hide layer' : 'Show layer'}
                        className={cn(
                          'inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-[var(--surface-tertiary)]',
                          node.visible
                            ? 'opacity-0 group-hover/row:opacity-100'
                            : 'opacity-100',
                        )}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleToggleVisible(id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            handleToggleVisible(id)
                          }
                        }}
                      >
                        <AppIcon icon={node.visible ? Icons.eye : Icons.eyeOff} className="h-3.5 w-3.5" />
                      </span>
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={node.locked ? 'Unlock layer' : 'Lock layer'}
                        className={cn(
                          'inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-[var(--surface-tertiary)]',
                          node.locked
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/row:opacity-100',
                        )}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleToggleLocked(id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            handleToggleLocked(id)
                          }
                        }}
                      >
                        <AppIcon icon={node.locked ? Icons.lock : Icons.lockOpen} className="h-3.5 w-3.5" />
                      </span>
                      {isGroup && (node as GroupNode).generatorMetadata ? (
                        <span title="Parametric generator" className="text-primary/70">
                          <Sparkles className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                      {node.gridMetadata ? (
                        <span title="Grid / Repeat" className="text-primary/70">
                          <LayoutCells className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                      {node.centerlineMetadata?.enabled ? (
                        <span title="Centerlines" className="text-[10px] font-semibold text-primary/70">
                          CL
                        </span>
                      ) : null}
                      <LayerCncSummaryTag summary={cncSummary} />
                    </span>
                  </button>

                  {isGroup && !isCollapsed ? (
                    <div className="border-t border-border px-1 py-1">
                      {(node as GroupNode).childIds.map((childId) => (
                        <TreeNode
                          key={childId}
                          nodeId={childId}
                          nodesById={nodesById}
                          selectedIds={selectedIds}
                          query={query}
                          depth={1}
                          collapsed={collapsed[childId] ?? false}
                          collapsedMap={collapsed}
                          onToggleCollapsed={handleToggleCollapsed}
                          onRowMouseDown={handleRowMouseDown}
                          onRowContextMenu={handleRowContextMenu}
                          onRowMouseEnter={handleRowMouseEnter}
                          onRowMouseLeave={handleRowMouseLeave}
                          onToggleVisible={handleToggleVisible}
                          onToggleLocked={handleToggleLocked}
                          defaultDepth={defaultDepth}
                          renamingId={renamingId}
                          renameDraft={renameDraft}
                          onStartRename={handleStartRename}
                          onDraftChange={setRenameDraft}
                          onCommitRename={handleCommitRename}
                          onCancelRename={handleCancelRename}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function TreeNode({
  nodeId,
  nodesById,
  selectedIds,
  query,
  depth,
  collapsed,
  collapsedMap,
  onToggleCollapsed,
  onRowMouseDown,
  onRowContextMenu,
  onRowMouseEnter,
  onRowMouseLeave,
  onToggleVisible,
  onToggleLocked,
  defaultDepth,
  renamingId,
  renameDraft,
  onStartRename,
  onDraftChange,
  onCommitRename,
  onCancelRename,
}: {
  nodeId: string
  nodesById: Record<string, CanvasNode>
  selectedIds: string[]
  query: string
  depth: number
  collapsed: boolean
  collapsedMap: Record<string, boolean>
  onToggleCollapsed: (id: string) => void
  onRowMouseDown: (id: string, e: React.MouseEvent) => void
  onRowContextMenu: (id: string, e: React.MouseEvent) => void
  onRowMouseEnter: (id: string) => void
  onRowMouseLeave: () => void
  onToggleVisible: (id: string) => void
  onToggleLocked: (id: string) => void
  defaultDepth: number
  renamingId: string | null
  renameDraft: string
  onStartRename: (node: CanvasNode) => void
  onDraftChange: (value: string) => void
  onCommitRename: (node: CanvasNode) => void
  onCancelRename: () => void
}) {
  const node = nodesById[nodeId]
  if (!node) return null

  const isGroup = node.type === 'group'
  const childIds = isGroup ? (node as GroupNode).childIds : []
  const isSelected = selectedIds.includes(nodeId)
  const label = node.name || nodeId

  const normalizedQuery = query.trim().toLowerCase()
  const matchesSelf = !normalizedQuery || label.toLowerCase().includes(normalizedQuery) || node.type.includes(normalizedQuery)
  const hasMatchingChildren = isGroup && childIds.some((cid) => {
    const child = nodesById[cid]
    return child && matchesQuery(child, nodesById, normalizedQuery)
  })

  if (!matchesSelf && !hasMatchingChildren) return null

  const cncSummary = buildLayerCncSummary(node, nodesById, defaultDepth)

  return (
    <div className="space-y-0.5">
      <button
        className={cn(
          'group/row flex w-full items-center justify-between rounded-md py-2 pr-3 text-left transition-colors hover:bg-[var(--surface-secondary)] active:bg-[var(--surface-tertiary)]',
          isSelected && 'bg-[var(--surface-tertiary)]',
          !node.visible && 'opacity-50',
        )}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onMouseDown={(e) => onRowMouseDown(nodeId, e)}
        onContextMenu={(e) => onRowContextMenu(nodeId, e)}
        onMouseEnter={() => onRowMouseEnter(nodeId)}
        onMouseLeave={onRowMouseLeave}
      >
        <span className="flex min-w-0 items-center gap-2">
          {isGroup ? (
            <span
              role="button"
              tabIndex={0}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onToggleCollapsed(nodeId)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onToggleCollapsed(nodeId)
                }
              }}
            >
              {collapsed
                ? <ChevronRight className="h-3.5 w-3.5" />
                : <ChevronDown className="h-3.5 w-3.5" />}
            </span>
          ) : null}
          <LayerPreview node={node} nodesById={nodesById} />
          <LayerName
            node={node}
            isRenaming={renamingId === nodeId}
            draft={renameDraft}
            className="truncate text-sm"
            onStartRename={onStartRename}
            onDraftChange={onDraftChange}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span
            role="button"
            tabIndex={-1}
            aria-label={node.visible ? 'Hide layer' : 'Show layer'}
            className={cn(
              'inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-[var(--surface-tertiary)]',
              node.visible
                ? 'opacity-0 group-hover/row:opacity-100'
                : 'opacity-100',
            )}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggleVisible(nodeId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onToggleVisible(nodeId)
              }
            }}
          >
            <AppIcon icon={node.visible ? Icons.eye : Icons.eyeOff} className="h-3 w-3" />
          </span>
          <span
            role="button"
            tabIndex={-1}
            aria-label={node.locked ? 'Unlock layer' : 'Lock layer'}
            className={cn(
              'inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-[var(--surface-tertiary)]',
              node.locked
                ? 'opacity-100'
                : 'opacity-0 group-hover/row:opacity-100',
            )}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onToggleLocked(nodeId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onToggleLocked(nodeId)
              }
            }}
          >
            <AppIcon icon={node.locked ? Icons.lock : Icons.lockOpen} className="h-3 w-3" />
          </span>
          {isGroup && (node as GroupNode).generatorMetadata ? (
            <span title="Parametric generator" className="text-primary/70">
              <Sparkles className="h-3 w-3" />
            </span>
          ) : null}
          {node.gridMetadata ? (
            <span title="Grid / Repeat" className="text-primary/70">
              <LayoutCells className="h-3 w-3" />
            </span>
          ) : null}
          {node.centerlineMetadata?.enabled ? (
            <span title="Centerlines" className="text-[9px] font-semibold text-primary/70">
              CL
            </span>
          ) : null}
          <LayerCncSummaryTag summary={cncSummary} />
        </span>
      </button>

      {isGroup && !collapsed
        ? childIds.map((cid) => (
            <TreeNode
              key={cid}
              nodeId={cid}
              nodesById={nodesById}
              selectedIds={selectedIds}
              query={query}
              depth={depth + 1}
              collapsed={collapsedMap[cid] ?? false}
              collapsedMap={collapsedMap}
              onToggleCollapsed={onToggleCollapsed}
              onRowMouseDown={onRowMouseDown}
              onRowContextMenu={onRowContextMenu}
              onRowMouseEnter={onRowMouseEnter}
              onRowMouseLeave={onRowMouseLeave}
              onToggleVisible={onToggleVisible}
              onToggleLocked={onToggleLocked}
              defaultDepth={defaultDepth}
              renamingId={renamingId}
              renameDraft={renameDraft}
              onStartRename={onStartRename}
              onDraftChange={onDraftChange}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))
        : null}
    </div>
  )
}

function matchesQuery(node: CanvasNode, nodesById: Record<string, CanvasNode>, q: string): boolean {
  const label = (node.name || node.id).toLowerCase()
  if (label.includes(q) || node.type.includes(q)) return true
  if (node.type === 'group') {
    return (node as GroupNode).childIds.some((cid) => {
      const child = nodesById[cid]
      return child ? matchesQuery(child, nodesById, q) : false
    })
  }
  return false
}
