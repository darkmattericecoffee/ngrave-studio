import { useEffect, useMemo, useState } from 'react'
import { SearchField } from '@heroui/react'
import { ChevronDown, ChevronRight, Sparkles } from '@gravity-ui/icons'

import { resolveNodeCncMetadata } from '../lib/cncMetadata'
import { AppIcon, Icons } from '../lib/icons'
import { depthToColor } from '../lib/cncVisuals'
import { useEditorStore } from '../store'
import type { CanvasNode, GroupNode } from '../types/editor'

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

const NODE_TYPE_LABEL: Record<string, string> = {
  group: 'group',
  rect: 'rect',
  circle: 'circle',
  line: 'line',
  path: 'path',
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

export function LayerTree() {
  const nodesById = useEditorStore((s) => s.nodesById)
  const rootIds = useEditorStore((s) => s.rootIds)
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const selectOne = useEditorStore((s) => s.selectOne)
  const selectMany = useEditorStore((s) => s.selectMany)
  const toggleSelection = useEditorStore((s) => s.toggleSelection)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)
  const setHoveredId = useEditorStore((s) => s.setHoveredId)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [lastClickedId, setLastClickedId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragAnchorId, setDragAnchorId] = useState<string | null>(null)

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

  useEffect(() => {
    const onMouseUp = () => setIsDragging(false)
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  function handleRowMouseDown(id: string, e: React.MouseEvent) {
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

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <SearchField value={query} onChange={setQuery} fullWidth>
          <SearchField.Group>
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
              const childCount = isGroup ? (node as GroupNode).childIds.length : 0
              const selected = selectedIds.includes(id)
              const isCollapsed = collapsed[id] ?? false
              const effectiveCncMetadata = resolveNodeCncMetadata(node, nodesById)
              const cncColor = effectiveCncMetadata.cutDepth != null
                ? depthToColor(effectiveCncMetadata.cutDepth)
                : null

              return (
                <div key={id} className="rounded-lg border border-border bg-[var(--surface)]">
                  <button
                    className={cn(
                      'group/row flex w-full items-center justify-between rounded-lg px-3 py-3 text-left transition-colors hover:bg-[var(--surface-secondary)] active:bg-[var(--surface-tertiary)]',
                      selected && 'bg-[var(--surface-tertiary)]',
                      !node.visible && 'opacity-50',
                    )}
                    onMouseDown={(e) => handleRowMouseDown(id, e)}
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
                      {cncColor ? (
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: cncColor }} />
                      ) : null}
                      <span className="truncate text-sm font-medium">{node.name || id}</span>
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
                      <span className="min-w-[3rem] text-right text-xs text-muted-foreground">
                        {isGroup ? `${childCount} parts` : NODE_TYPE_LABEL[node.type]}
                      </span>
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
                          onRowMouseEnter={handleRowMouseEnter}
                          onRowMouseLeave={handleRowMouseLeave}
                          onToggleVisible={handleToggleVisible}
                          onToggleLocked={handleToggleLocked}
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
  onRowMouseEnter,
  onRowMouseLeave,
  onToggleVisible,
  onToggleLocked,
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
  onRowMouseEnter: (id: string) => void
  onRowMouseLeave: () => void
  onToggleVisible: (id: string) => void
  onToggleLocked: (id: string) => void
}) {
  const node = nodesById[nodeId]
  if (!node) return null

  const isGroup = node.type === 'group'
  const childIds = isGroup ? (node as GroupNode).childIds : []
  const isSelected = selectedIds.includes(nodeId)
  const label = node.name || nodeId
  const typeTag = NODE_TYPE_LABEL[node.type]

  const normalizedQuery = query.trim().toLowerCase()
  const matchesSelf = !normalizedQuery || label.toLowerCase().includes(normalizedQuery) || node.type.includes(normalizedQuery)
  const hasMatchingChildren = isGroup && childIds.some((cid) => {
    const child = nodesById[cid]
    return child && matchesQuery(child, nodesById, normalizedQuery)
  })

  if (!matchesSelf && !hasMatchingChildren) return null

  const effectiveCncMetadata = resolveNodeCncMetadata(node, nodesById)
  const cncColor = effectiveCncMetadata.cutDepth != null
    ? depthToColor(effectiveCncMetadata.cutDepth)
    : null

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
          {cncColor ? (
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: cncColor }} />
          ) : null}
          <span className="truncate text-sm">{label}</span>
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
          <span className="min-w-[2.5rem] text-right text-xs text-muted-foreground">{typeTag}</span>
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
              onRowMouseEnter={onRowMouseEnter}
              onRowMouseLeave={onRowMouseLeave}
              onToggleVisible={onToggleVisible}
              onToggleLocked={onToggleLocked}
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
