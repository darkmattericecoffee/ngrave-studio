import { useState } from 'react'
import { Card, SearchField } from '@heroui/react'
import { Sparkles } from '@gravity-ui/icons'

import {
  LIBRARY_DRAG_MIME,
  LIBRARY_ITEMS,
  createLibraryDragPayload,
} from '../../lib/libraryItems'
import { useEditorStore } from '../../store'
import type { BasicShapeKind, GeneratorParams } from '../../types/editor'

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function ShapePreview({ kind }: { kind: BasicShapeKind }) {
  return (
    <div className="flex aspect-square w-10 shrink-0 items-center justify-center rounded-md border border-border bg-content1">
      <svg
        aria-hidden="true"
        className="h-7 w-7 text-foreground"
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {kind === 'rectangle' ? (
          <rect x="8" y="12" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="3" />
        ) : kind === 'circle' ? (
          <circle cx="24" cy="24" r="15" stroke="currentColor" strokeWidth="3" />
        ) : (
          <path d="M24 8L40 38H8L24 8Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
        )}
      </svg>
    </div>
  )
}

export function LibraryPanel() {
  const placeGenerator = useEditorStore((s) => s.placeGenerator)
  const placeShape = useEditorStore((s) => s.placeShape)
  const [query, setQuery] = useState('')

  const normalizedQuery = query.trim().toLowerCase()
  const filteredItems = LIBRARY_ITEMS.filter((item) => {
    if (!normalizedQuery) return true
    return (
      item.label.toLowerCase().includes(normalizedQuery) ||
      item.description.toLowerCase().includes(normalizedQuery) ||
      item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
    )
  })

  const addItemToArtboard = (item: (typeof LIBRARY_ITEMS)[number]) => {
    if (item.itemType === 'generator') {
      placeGenerator(item.defaultParams as GeneratorParams)
      return
    }

    placeShape(item.kind)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <SearchField value={query} onChange={setQuery} fullWidth aria-label="Search library">
          <SearchField.Group aria-label="Search library">
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
            <SearchField.Input className="w-full" placeholder="Search library" />
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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {filteredItems.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-[var(--surface)] px-4 py-6 text-center text-sm text-muted-foreground">
            No library items match your search.
          </p>
        ) : (
          <div className="space-y-2">
            {filteredItems.map((item) => {
              const dragPayload = createLibraryDragPayload(item)

              return (
                <Card
                  key={`${item.itemType}-${item.kind}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy'
                    event.dataTransfer.setData(LIBRARY_DRAG_MIME, JSON.stringify(dragPayload))
                  }}
                  className={cn(
                    'group relative cursor-grab overflow-hidden rounded-md border border-border bg-[var(--surface)] shadow-none',
                    'transition-all duration-150 ease-out active:cursor-grabbing',
                    'hover:-translate-y-0.5 hover:scale-[1.01] hover:border-primary/40 hover:bg-[var(--surface-secondary)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]',
                  )}
                >
                  <Card.Header className="flex flex-col p-3">
                    <div className="flex min-w-0 items-center gap-3 pr-9">
                      {item.itemType === 'generator' ? (
                        <img
                          alt={item.label}
                          className="pointer-events-none aspect-square w-10 shrink-0 rounded-md object-cover select-none"
                          loading="lazy"
                          src={item.imageSrc}
                          draggable={false}
                        />
                      ) : (
                        <ShapePreview kind={item.kind} />
                      )}
                      <div className="min-w-0 flex-1 self-center">
                        <div className="flex items-center gap-1.5">
                          {item.itemType === 'generator' ? (
                            <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                          ) : null}
                          <Card.Title className="truncate text-sm font-semibold text-foreground">
                            {item.label}
                          </Card.Title>
                        </div>
                        <Card.Description className="mt-0.5 overflow-hidden text-[11px] leading-4 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                          {item.description}
                        </Card.Description>
                      </div>
                    </div>
                  </Card.Header>
                  <button
                    type="button"
                    aria-label={`Add ${item.label} to artboard`}
                    title="Add to artboard"
                    className="absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 scale-90 items-center justify-center rounded-md bg-primary text-lg font-medium leading-none text-primary-foreground opacity-0 shadow-[0_8px_18px_rgba(0,0,0,0.2)] transition-all duration-150 hover:opacity-90 focus:scale-100 focus:opacity-100 group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation()
                      addItemToArtboard(item)
                    }}
                  >
                    +
                  </button>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
