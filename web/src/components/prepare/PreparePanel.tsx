import { useEffect, useMemo, useRef, useState } from 'react'
import type { Selection, SortDescriptor } from '@heroui/react'
import { Button, Chip, Table, cn } from '@heroui/react'
import ArrowDownToSquareIcon from '@gravity-ui/icons/esm/ArrowDownToSquare.js'

import { AppIcon } from '../../lib/icons'
import { useEditorStore } from '../../store'
import { MATERIAL_PRESETS, type MaterialPreset } from '../../lib/materialPresets'
import { ancestorMatrix, computeCutPlan } from '../../lib/jobs'
import { getNodePreviewBounds, type Bounds } from '../../lib/nodeBounds'
import { exportToSVG } from '../../lib/svgExport'
import { exportPreparePdf } from '../../lib/exportPreparePdf'
import { LayoutDiagram } from './LayoutDiagram'
import { JobPreview } from '../LayerTree'

interface PreparePanelProps {
  projectName: string
  materialPreset: MaterialPreset
  exportOnly?: boolean
}

function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function fmt(value: number | null | undefined, unit: string = 'mm', digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const f = Math.round(value * 10 ** digits) / 10 ** digits
  return `${f} ${unit}`
}

function SortableColumnHeader({
  children,
  sortDirection,
}: {
  children: React.ReactNode
  sortDirection?: 'ascending' | 'descending'
}) {
  return (
    <span className="flex items-center justify-between gap-2">
      {children}
      {!!sortDirection && (
        <span
          className={cn(
            'text-[10px] transition-transform duration-100 ease-out',
            sortDirection === 'descending' ? 'rotate-180' : '',
          )}
          aria-hidden
        >
          ▲
        </span>
      )}
    </span>
  )
}

function extractDesignInnerSvg(svgText: string): string {
  // exportToSVG wraps all content in <g transform="translate(-artX -artY)">.
  // We grab that <g> node's outerHTML so its transform is preserved, then
  // splice it into the layout diagram.
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const g = doc.querySelector('svg > g')
  return g ? g.outerHTML : ''
}

export function PreparePanel({ projectName, materialPreset, exportOnly = false }: PreparePanelProps) {
  const artboard = useEditorStore((s) => s.artboard)
  const nodesById = useEditorStore((s) => s.nodesById)
  const rootIds = useEditorStore((s) => s.rootIds)
  const machiningSettings = useEditorStore((s) => s.machiningSettings)
  const prepareExportCutNumbers = useEditorStore((s) => s.prepareExportCutNumbers)

  const rootRef = useRef<HTMLDivElement>(null)
  const [isExporting, setIsExporting] = useState(false)

  const preset = MATERIAL_PRESETS.find((p) => p.id === materialPreset) ?? MATERIAL_PRESETS[0]

  const { jobs, designBounds, designInnerSvg, cutBadges } = useMemo(() => {
    const plan = computeCutPlan(rootIds, nodesById, machiningSettings, artboard)

    let bounds: Bounds | null = null
    for (const id of rootIds) {
      const node = nodesById[id]
      if (!node) continue
      const b = getNodePreviewBounds(node, nodesById)
      bounds = unionBounds(bounds, b)
    }

    const svgText = exportToSVG(nodesById, rootIds, artboard)
    const inner = extractDesignInnerSvg(svgText)

    const badges: { nodeId: string; x: number; y: number; jobIndex: number; step: number }[] = []
    let running = 0
    plan.jobs.forEach((job, jobIndex) => {
      for (const nodeId of job.nodeIds) {
        const node = nodesById[nodeId]
        if (!node) continue
        const nb = getNodePreviewBounds(node, nodesById, ancestorMatrix(node, nodesById))
        if (!nb) continue
        running += 1
        badges.push({ nodeId, x: nb.minX, y: nb.minY, jobIndex, step: running })
      }
    })

    return { jobs: plan.jobs, designBounds: bounds, designInnerSvg: inner, cutBadges: badges }
  }, [artboard, machiningSettings, nodesById, rootIds])

  const generatedAt = useMemo(() => new Date().toLocaleString(), [])

  const totalLeaves = jobs.reduce((sum, j) => sum + j.nodeIds.length, 0)

  const handleExport = async () => {
    if (!rootRef.current) return
    setIsExporting(true)
    try {
      const safeName = (projectName || 'project').replace(/[^\w.\-]+/g, '_')
      await exportPreparePdf(rootRef.current, {
        filename: `${safeName}-prepare.pdf`,
      })
    } finally {
      setIsExporting(false)
    }
  }

  const passMode = machiningSettings.maxStepdown != null ? 'stepdown' : 'passes'
  const designOffsetX = designBounds?.minX ?? 0
  const designOffsetYFromTop = designBounds?.minY ?? 0
  const designOffsetYFromBL =
    designBounds != null ? artboard.height - designBounds.maxY : 0
  const designW = designBounds ? designBounds.maxX - designBounds.minX : 0
  const designH = designBounds ? designBounds.maxY - designBounds.minY : 0

  return (
    <div className={exportOnly ? "" : "h-full w-full overflow-auto bg-neutral-200 px-6 py-6"}>
      <div className={exportOnly ? "flex justify-end" : "mx-auto flex max-w-5xl items-center justify-between pb-4"}>
        {!exportOnly && (
        <div className="text-sm text-neutral-700">
          Review the layout, cut list and offsets before machining. Export as PDF to keep a record.
        </div>
        )}
        <Button
          className="rounded-full bg-emerald-600 px-4 gap-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          size="sm"
          onPress={handleExport}
          isDisabled={isExporting}
        >
          <AppIcon icon={ArrowDownToSquareIcon} className="h-4 w-4" />
          {isExporting ? 'Exporting…' : 'Export PDF'}
        </Button>
      </div>

      <div className={exportOnly ? "fixed left-[-10000px] top-0 w-[1024px] bg-neutral-200 px-6 py-6" : ""}>
      <div
        ref={rootRef}
        className="mx-auto max-w-5xl space-y-2 rounded-lg bg-white p-4 text-neutral-900 shadow-sm"
      >
        {/* Header */}
        <header className="flex items-start justify-between border-b border-neutral-200 pb-2">
          <div>
            <h1 className="text-xl font-semibold leading-tight">{projectName || 'Untitled project'}</h1>
            <p className="mt-0.5 text-xs text-neutral-500">
              Generated {generatedAt} · Material: {preset.label}
            </p>
          </div>
          <div className="text-right text-[11px] text-neutral-500 leading-snug">
            <div>
              Tool: Ø{fmt(machiningSettings.toolDiameter, 'mm')} {machiningSettings.toolShape}
            </div>
            <div>
              {jobs.length} job{jobs.length === 1 ? '' : 's'} · {totalLeaves} cut
              {totalLeaves === 1 ? '' : 's'}
            </div>
          </div>
        </header>

        {/* Layout diagram */}
        <section>
          <div className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 p-2">
            <LayoutDiagram
              artboard={artboard}
              designInnerSvg={designInnerSvg}
              designBounds={designBounds}
              jobs={jobs}
              materialPreset={materialPreset}
              cutBadges={prepareExportCutNumbers ? cutBadges : null}
            />
          </div>
        </section>

        {/* Jobs table — moved directly under layout so anchors and their per-job
            offsets read top-to-bottom in one glance. */}
        <section>
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Jobs ({jobs.length})
          </h2>
          {jobs.length === 0 ? (
            <p className="text-xs text-neutral-500">No jobs — place geometry on the artboard.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
                  <Th>#</Th>
                  <Th>Name</Th>
                  <Th className="text-right">Cuts</Th>
                  <Th>Anchor</Th>
                  <Th className="text-right">X BL</Th>
                  <Th className="text-right">Y BL</Th>
                  <Th className="text-right">W</Th>
                  <Th className="text-right">H</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => {
                  const w = job.boundsMm.maxX - job.boundsMm.minX
                  const h = job.boundsMm.maxY - job.boundsMm.minY
                  return (
                    <tr
                      key={job.id}
                      className="border-b border-neutral-200 last:border-b-0"
                    >
                      <Td>{i + 1}</Td>
                      <Td>{job.name}</Td>
                      <Td className="text-right tabular-nums">{job.nodeIds.length}</Td>
                      <Td>
                        {job.pathAnchor}
                        {job.anchorAlignment?.sharedX != null && (
                          <span className="ml-1 rounded bg-emerald-100 px-1 text-[9px] font-medium text-emerald-800">
                            X={fmt(job.anchorAlignment.sharedX)}
                          </span>
                        )}
                        {job.anchorAlignment?.sharedY != null && (
                          <span className="ml-1 rounded bg-emerald-100 px-1 text-[9px] font-medium text-emerald-800">
                            Y={fmt(artboard.height - job.anchorAlignment.sharedY)}
                          </span>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {fmt(job.crossOffsetFromArtboardBL.x)}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {fmt(job.crossOffsetFromArtboardBL.y)}
                      </Td>
                      <Td className="text-right tabular-nums">{fmt(w)}</Td>
                      <Td className="text-right tabular-nums">{fmt(h)}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* Compact design totals + material + machining as a tight row so the
            whole report fits on one page. */}
        {designBounds && (
          <section>
            <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Design
            </h2>
            <div className="grid grid-cols-4 gap-x-3 gap-y-0.5 text-[11px] md:grid-cols-8">
              <CompactStat label="W" value={fmt(designW)} />
              <CompactStat label="H" value={fmt(designH)} />
              <CompactStat label="X BL" value={fmt(designOffsetX)} />
              <CompactStat label="Y BL" value={fmt(designOffsetYFromBL)} />
              <CompactStat label="X TL" value={fmt(designOffsetX)} />
              <CompactStat label="Y TL" value={fmt(designOffsetYFromTop)} />
              <CompactStat label="Reach R" value={fmt(artboard.width - designBounds.maxX)} />
              <CompactStat label="Reach T" value={fmt(designBounds.minY)} />
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
            Setup
          </h2>
          <div className="grid grid-cols-4 gap-x-3 gap-y-0.5 text-[11px] md:grid-cols-8">
            <CompactStat label="Material" value={preset.label} />
            <CompactStat label="Size" value={`${fmt(artboard.width)} × ${fmt(artboard.height)}`} />
            <CompactStat label="Depth" value={fmt(artboard.thickness)} />
            <CompactStat
              label="Tool"
              value={`Ø${fmt(machiningSettings.toolDiameter)} ${machiningSettings.toolShape}`}
            />
            <CompactStat label="Target depth" value={fmt(machiningSettings.defaultDepthMm)} />
            <CompactStat
              label={passMode === 'passes' ? 'Passes' : 'Max stepdown'}
              value={
                passMode === 'passes'
                  ? `${machiningSettings.passCount}`
                  : fmt(machiningSettings.maxStepdown)
              }
            />
            <CompactStat
              label="Cut feed"
              value={fmt(machiningSettings.cutFeedrate, 'mm/min', 0)}
            />
            <CompactStat label="Work anchor" value={machiningSettings.pathAnchor} />
          </div>
        </section>
      </div>
      </div>
    </div>
  )
}

export function PrepareJobSummary({
  collapsed = false,
  onToggle,
}: {
  collapsed?: boolean
  onToggle?: () => void
} = {}) {
  const artboard = useEditorStore((s) => s.artboard)
  const nodesById = useEditorStore((s) => s.nodesById)
  const rootIds = useEditorStore((s) => s.rootIds)
  const machiningSettings = useEditorStore((s) => s.machiningSettings)
  const selectedJobId = useEditorStore((s) => s.selectedJobId)
  const setSelectedJob = useEditorStore((s) => s.setSelectedJob)
  const hoveredId = useEditorStore((s) => s.hoveredId)
  const tableContainerRef = useRef<HTMLDivElement | null>(null)
  const selectedKeys = useMemo<Selection>(
    () => (selectedJobId ? new Set([selectedJobId]) : new Set()),
    [selectedJobId],
  )
  const handleSelectionChange = (keys: Selection) => {
    if (keys === 'all') return
    const first = keys.values().next().value
    setSelectedJob(typeof first === 'string' ? first : null)
  }
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: 'index',
    direction: 'ascending',
  })

  const jobs = useMemo(
    () => computeCutPlan(rootIds, nodesById, machiningSettings, artboard).jobs,
    [artboard, machiningSettings, nodesById, rootIds],
  )
  const rows = useMemo(
    () =>
      jobs.map((job, index) => {
        const width = job.boundsMm.maxX - job.boundsMm.minX
        const height = job.boundsMm.maxY - job.boundsMm.minY
        const sharedAnchor = job.anchorAlignment?.sharedX != null
          ? `X=${fmt(job.anchorAlignment.sharedX)}`
          : job.anchorAlignment?.sharedY != null
            ? `Y=${fmt(artboard.height - job.anchorAlignment.sharedY)}`
            : null
        return {
          id: job.id,
          index: index + 1,
          name: job.name,
          cuts: job.nodeIds.length,
          anchor: job.pathAnchor,
          sharedAnchor,
          x: job.crossOffsetFromArtboardBL.x,
          y: job.crossOffsetFromArtboardBL.y,
          width,
          height,
        }
      }),
    [artboard.height, jobs],
  )
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const column = sortDescriptor.column as keyof typeof rows[number]
      const first = a[column]
      const second = b[column]
      const cmp =
        typeof first === 'number' && typeof second === 'number'
          ? first - second
          : String(first ?? '').localeCompare(String(second ?? ''))
      return sortDescriptor.direction === 'descending' ? -cmp : cmp
    })
  }, [rows, sortDescriptor])

  const hoveredJobId = useMemo(() => {
    if (!hoveredId) return null
    return jobs.find((job) => job.nodeIds.includes(hoveredId))?.id ?? null
  }, [hoveredId, jobs])

  useEffect(() => {
    if (!hoveredJobId || !tableContainerRef.current) return
    const row = tableContainerRef.current.querySelector<HTMLElement>(
      `[data-key="${CSS.escape(hoveredJobId)}"]`,
    )
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [hoveredJobId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Jobs ({jobs.length})
        </h2>
        {onToggle ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-[var(--surface-secondary)] hover:text-foreground"
            onClick={onToggle}
          >
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
        ) : null}
      </div>
      {collapsed ? null : (
      <div ref={tableContainerRef} className="min-h-0 flex-1 overflow-auto px-5 py-2">
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No jobs — place geometry on the artboard.</p>
        ) : (
          <Table className="h-full">
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Prepare jobs summary"
                className="min-w-[900px]"
                selectedKeys={selectedKeys}
                selectionMode="single"
                selectionBehavior="replace"
                sortDescriptor={sortDescriptor}
                onSelectionChange={handleSelectionChange}
                onSortChange={setSortDescriptor}
              >
                <Table.Header>
                  <Table.Column allowsSorting isRowHeader id="index">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>#</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column id="preview">
                    {() => <span aria-hidden />}
                  </Table.Column>
                  <Table.Column allowsSorting id="name">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>Name</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="cuts">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>Cuts</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="anchor">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>Anchor</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="x" className="text-end">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>X BL</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="y" className="text-end">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>Y BL</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="width" className="text-end">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>W</SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="height" className="text-end">
                    {({ sortDirection }) => (
                      <SortableColumnHeader sortDirection={sortDirection}>H</SortableColumnHeader>
                    )}
                  </Table.Column>
                </Table.Header>
                <Table.Body>
                  {sortedRows.map((job) => (
                    <Table.Row
                      key={job.id}
                      id={job.id}
                      className={hoveredJobId === job.id ? 'bg-primary/20' : undefined}
                    >
                      <Table.Cell className="font-medium tabular-nums">
                        <span
                          className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold"
                          style={{
                            backgroundColor: `hsl(${((job.index - 1) * 57) % 360}, 65%, 28%)`,
                            color: `hsl(${((job.index - 1) * 57) % 360}, 90%, 88%)`,
                            boxShadow: `0 0 0 1px hsl(${((job.index - 1) * 57) % 360}, 70%, 55%)`,
                          }}
                        >
                          J{job.index}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        {(() => {
                          const j = jobs.find((entry) => entry.id === job.id)
                          return j ? <JobPreview job={j} nodesById={nodesById} size={28} /> : null
                        })()}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex flex-col">
                          <span className="text-xs font-medium">{job.name}</span>
                          <span className="text-xs text-muted-foreground">{job.id}</span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">{job.cuts}</Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center gap-2">
                          <span>{job.anchor}</span>
                          {job.sharedAnchor ? (
                            <Chip color="success" size="sm" variant="soft">
                              {job.sharedAnchor}
                            </Chip>
                          ) : null}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-end tabular-nums">{fmt(job.x)}</Table.Cell>
                      <Table.Cell className="text-end tabular-nums">{fmt(job.y)}</Table.Cell>
                      <Table.Cell className="text-end tabular-nums">{fmt(job.width)}</Table.Cell>
                      <Table.Cell className="text-end tabular-nums">{fmt(job.height)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </div>
      )}
    </div>
  )
}

function CompactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[9px] uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  )
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`py-1 pr-2 font-medium ${className}`}>{children}</th>
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-0.5 pr-2 ${className}`}>{children}</td>
}
