import { useEffect, useMemo, useState } from 'react'
import { Card, SearchField } from '@heroui/react'
import { Sparkles } from '@gravity-ui/icons'

import dominoImage from '../../assets/library/domino.png'
import dowelImage from '../../assets/library/dowel.png'
import { useEditorStore } from '../../store'
import type {
  DowelHoleParams,
  GeneratorParams,
  GroupNode,
  TenonParams,
} from '../../types/editor'
import { DowelHoleForm } from './DowelHoleForm'
import { TenonForm } from './TenonForm'

const DEFAULT_TENON: TenonParams = {
  kind: 'tenon',
  name: 'Tenon',
  width: 10,
  height: 20,
  matchToolWidth: false,
  rowCount: 1,
  colCount: 1,
  rowSpacing: 30,
  colSpacing: 30,
  outputType: 'pocket',
}

const DEFAULT_DOWEL: DowelHoleParams = {
  kind: 'dowelHole',
  name: 'Dowel Hole',
  diameter: 8,
  matchToolDiameter: false,
  rowCount: 1,
  colCount: 1,
  rowSpacing: 30,
  colSpacing: 30,
  outputType: 'pocket',
}

interface GeneratorCard {
  kind: GeneratorParams['kind']
  label: string
  description: string
  imageSrc: string
  defaultParams: GeneratorParams
}

const GENERATORS: GeneratorCard[] = [
  {
    kind: 'tenon',
    label: 'Tenon / Domino',
    description: 'Rectangular mortise pocket or contour for repeatable joinery.',
    imageSrc: dominoImage,
    defaultParams: DEFAULT_TENON,
  },
  {
    kind: 'dowelHole',
    label: 'Dowel Hole',
    description: 'Circular dowel placements for drilled or pocketed alignment holes.',
    imageSrc: dowelImage,
    defaultParams: DEFAULT_DOWEL,
  },
]

function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(' ')
}

export function LibraryPanel() {
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const nodesById = useEditorStore((s) => s.nodesById)
  const setLeftPanelTab = useEditorStore((s) => s.setLeftPanelTab)
  const placeGenerator = useEditorStore((s) => s.placeGenerator)
  const updateGeneratorParams = useEditorStore((s) => s.updateGeneratorParams)

  const [query, setQuery] = useState('')
  const [activeKind, setActiveKind] = useState<GeneratorParams['kind'] | null>(null)

  const selectedGeneratorNode = useMemo(() => {
    if (selectedIds.length !== 1) return null
    const node = nodesById[selectedIds[0]]
    if (!node || node.type !== 'group') return null
    return (node as GroupNode).generatorMetadata ? (node as GroupNode) : null
  }, [selectedIds, nodesById])

  useEffect(() => {
    if (selectedGeneratorNode) {
      setLeftPanelTab('library')
    }
  }, [selectedGeneratorNode, setLeftPanelTab])

  const editingKind = selectedGeneratorNode?.generatorMetadata?.params.kind ?? null

  const filteredGenerators = GENERATORS.filter((generator) => {
    if (editingKind === generator.kind) return true
    if (!query.trim()) return true
    const normalizedQuery = query.trim().toLowerCase()
    return (
      generator.label.toLowerCase().includes(normalizedQuery) ||
      generator.description.toLowerCase().includes(normalizedQuery) ||
      generator.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
    )
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
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
        {filteredGenerators.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-[var(--surface)] px-4 py-6 text-center text-sm text-muted-foreground">
            No library items match your search.
          </p>
        ) : (
          <div className="space-y-4">
            {filteredGenerators.map((card) => {
              const isEditing = editingKind === card.kind
              const isExpanded = isEditing || activeKind === card.kind
              const selectedNodeId = isEditing ? selectedGeneratorNode?.id : undefined
              const selectedParams = isEditing ? selectedGeneratorNode?.generatorMetadata?.params : null

              return (
                <Card
                  key={card.kind}
                  className={cn(
                    'overflow-hidden border border-border bg-[var(--surface)] shadow-none transition-colors',
                    isExpanded && 'border-primary/40 bg-[var(--surface-secondary)]',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (isEditing) return
                      setActiveKind((current) => current === card.kind ? null : card.kind)
                    }}
                    className="w-full cursor-pointer text-left"
                  >
                    <Card.Header className="flex flex-row items-center gap-3 p-4">
                      <img
                        alt={card.label}
                        className="pointer-events-none aspect-square w-12 shrink-0 rounded-2xl object-cover select-none"
                        loading="lazy"
                        src={card.imageSrc}
                      />
                      <div className="min-w-0 flex-1 self-center">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                            <Card.Title className="truncate text-sm font-semibold text-foreground">
                              {card.label}
                            </Card.Title>
                          </div>
                          <Card.Description className="mt-1 text-xs leading-5 text-muted-foreground">
                            {card.description}
                          </Card.Description>
                          {isEditing ? (
                            <div className="mt-3">
                              <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                                Editing
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </Card.Header>
                  </button>

                  {isExpanded ? (
                    <Card.Content className="border-t border-border px-4 py-4">
                      {card.kind === 'tenon' ? (
                        <TenonForm
                          initialParams={(selectedParams && selectedParams.kind === 'tenon')
                            ? selectedParams
                            : DEFAULT_TENON}
                          mode={isEditing ? 'edit' : 'new'}
                          nodeId={selectedNodeId}
                          onPlace={isEditing ? undefined : (params) => {
                            placeGenerator(params)
                            setActiveKind(null)
                          }}
                          onUpdate={isEditing && selectedNodeId
                            ? (params) => updateGeneratorParams(selectedNodeId, params)
                            : undefined}
                        />
                      ) : (
                        <DowelHoleForm
                          initialParams={(selectedParams && selectedParams.kind === 'dowelHole')
                            ? selectedParams
                            : DEFAULT_DOWEL}
                          mode={isEditing ? 'edit' : 'new'}
                          nodeId={selectedNodeId}
                          onPlace={isEditing ? undefined : (params) => {
                            placeGenerator(params)
                            setActiveKind(null)
                          }}
                          onUpdate={isEditing && selectedNodeId
                            ? (params) => updateGeneratorParams(selectedNodeId, params)
                            : undefined}
                        />
                      )}
                    </Card.Content>
                  ) : null}
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
