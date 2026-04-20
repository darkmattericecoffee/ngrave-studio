import { useState } from 'react'
import type { CanvasNode } from '../types/editor'
import type { CutOrderResult } from '../lib/cutOrder'
import { buildLayerCncSummary, LayerCncSummaryTag, LayerPreview } from './LayerTree'

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

export function CutOrderView({
  cutOrder,
  nodesById,
  selectedIds,
  defaultDepth,
  onSelect,
  onHover,
  onHoverLeave,
  onContextMenu,
  onReorder,
}: {
  cutOrder: CutOrderResult
  nodesById: Record<string, CanvasNode>
  selectedIds: string[]
  defaultDepth: number
  onSelect: (id: string, e: React.MouseEvent) => void
  onHover: (id: string) => void
  onHoverLeave: () => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  onReorder: (nextOrder: string[]) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState(true)

  if (cutOrder.sequence.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="rounded-md border border-dashed border-border bg-[var(--surface)] px-3 py-3 text-sm text-muted-foreground">
          Nothing to cut yet. Import an SVG or add a shape to see the order.
        </div>
      </div>
    )
  }

  function handleDrop(targetId: string, before: boolean) {
    if (!draggingId || draggingId === targetId) return
    const ids = cutOrder.sequence.map((l) => l.nodeId)
    const fromIdx = ids.indexOf(draggingId)
    const targetIdx = ids.indexOf(targetId)
    if (fromIdx < 0 || targetIdx < 0) return
    const [moved] = ids.splice(fromIdx, 1)
    const insertIdx = ids.indexOf(targetId) + (before ? 0 : 1)
    ids.splice(insertIdx, 0, moved)
    onReorder(ids)
  }

  // Partition leaves by groupId while preserving order.
  const partitions: Array<{ groupId: string; groupName: string; leaves: typeof cutOrder.sequence }> = []
  for (const leaf of cutOrder.sequence) {
    const last = partitions[partitions.length - 1]
    if (last && last.groupId === leaf.groupId) {
      last.leaves.push(leaf)
    } else {
      partitions.push({ groupId: leaf.groupId, groupName: leaf.groupName, leaves: [leaf] })
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="space-y-4">
        {partitions.map((partition) => (
          <div key={`${partition.groupId}-${partition.leaves[0]?.index ?? 0}`}>
            <div className="mb-1 flex items-center gap-2 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span>{partition.groupName}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-0.5">
              {partition.leaves.map((leaf) => {
                const node = nodesById[leaf.nodeId]
                if (!node) return null
                const selected = selectedIds.includes(leaf.nodeId)
                const summary = buildLayerCncSummary(node, nodesById, defaultDepth)
                const isDragging = draggingId === leaf.nodeId
                const isDropTarget = dropTargetId === leaf.nodeId && draggingId && draggingId !== leaf.nodeId
                return (
                  <div
                    key={leaf.nodeId}
                    className={cn(
                      'relative',
                      isDropTarget && dropBefore && 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded before:bg-primary',
                      isDropTarget && !dropBefore && 'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded after:bg-primary',
                    )}
                    draggable
                    onDragStart={(e) => {
                      setDraggingId(leaf.nodeId)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', leaf.nodeId)
                    }}
                    onDragEnd={() => {
                      setDraggingId(null)
                      setDropTargetId(null)
                    }}
                    onDragOver={(e) => {
                      if (!draggingId || draggingId === leaf.nodeId) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      const rect = e.currentTarget.getBoundingClientRect()
                      const before = e.clientY < rect.top + rect.height / 2
                      setDropTargetId(leaf.nodeId)
                      setDropBefore(before)
                    }}
                    onDragLeave={(e) => {
                      const related = e.relatedTarget as Node | null
                      if (!related || !e.currentTarget.contains(related)) {
                        if (dropTargetId === leaf.nodeId) setDropTargetId(null)
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(leaf.nodeId, dropBefore)
                      setDraggingId(null)
                      setDropTargetId(null)
                    }}
                  >
                    <button
                      type="button"
                      className={cn(
                        'group/row flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-secondary)] active:bg-[var(--surface-tertiary)]',
                        selected && 'bg-[var(--surface-tertiary)]',
                        !node.visible && 'opacity-50',
                        isDragging && 'opacity-40',
                      )}
                      onClick={(e) => onSelect(leaf.nodeId, e)}
                      onMouseEnter={() => onHover(leaf.nodeId)}
                      onMouseLeave={onHoverLeave}
                      onContextMenu={(e) => onContextMenu(leaf.nodeId, e)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="inline-flex h-4 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground"
                          aria-hidden
                        >
                          ⋮⋮
                        </span>
                        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold tabular-nums text-primary">
                          {leaf.index + 1}
                        </span>
                        <LayerPreview node={node} nodesById={nodesById} />
                        <span className="truncate text-sm">{node.name || node.id}</span>
                      </span>
                      <LayerCncSummaryTag summary={summary} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
