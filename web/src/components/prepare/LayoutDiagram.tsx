import { useMemo } from 'react'

import type { ArtboardState } from '../../types/editor'
import type { Bounds } from '../../lib/nodeBounds'
import type { ComputedJob } from '../../lib/jobs'
import { MATERIAL_PRESETS, type MaterialPreset } from '../../lib/materialPresets'

interface CutBadge {
  nodeId: string
  x: number
  y: number
  jobIndex: number
  step: number
}

interface LayoutDiagramProps {
  artboard: ArtboardState
  /** Inner <g> content of the design SVG (pre-built by the parent via exportToSVG). */
  designInnerSvg: string
  /** Union bounds of the design in artboard-mm (origin = artboard top-left, y grows down). */
  designBounds: Bounds | null
  jobs: ComputedJob[]
  materialPreset: MaterialPreset
  /** When non-null, render numbered badges at each leaf's (x,y) in cut order. */
  cutBadges?: CutBadge[] | null
}

// Extra mm reserved around the material rect for dimension lines and labels.
const DIM_PAD = 80
const LABEL_PX = 11
const TICK_LEN = 4
const DIM_OFFSET = 18

// Per-job anchor tag (filled pill with white text + leader line to anchor).
// Positioned outside the design-bounds offset dims so both coexist.
const TAG_FILL = '#059669'
const TAG_TEXT = '#ffffff'
const TAG_FONT = 9
const TAG_PAD_X = 3.5
const TAG_PAD_Y = 2.5
const TAG_CHAR_W = TAG_FONT * 0.56
const TAG_GAP = 40 // mm from material's left edge to tag's right edge (leaves room for Y-offset dim)
const TAG_BOTTOM_CENTER_OFFSET = 34 // mm from material bottom edge to tag center

function Hdim({
  y,
  x1,
  x2,
  label,
  placement,
}: {
  y: number
  x1: number
  x2: number
  label: string
  placement: 'above' | 'below'
}) {
  const textY = placement === 'above' ? y - 4 : y + LABEL_PX
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke="#333" strokeWidth={0.6} />
      <line x1={x1} y1={y - TICK_LEN} x2={x1} y2={y + TICK_LEN} stroke="#333" strokeWidth={0.6} />
      <line x1={x2} y1={y - TICK_LEN} x2={x2} y2={y + TICK_LEN} stroke="#333" strokeWidth={0.6} />
      <text
        x={(x1 + x2) / 2}
        y={textY}
        fontSize={LABEL_PX}
        textAnchor="middle"
        fill="#111"
        fontFamily="sans-serif"
      >
        {label}
      </text>
    </g>
  )
}

function Vdim({
  x,
  y1,
  y2,
  label,
  placement,
}: {
  x: number
  y1: number
  y2: number
  label: string
  placement: 'left' | 'right'
}) {
  const textX = placement === 'left' ? x - 4 : x + 4
  const anchor = placement === 'left' ? 'end' : 'start'
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} stroke="#333" strokeWidth={0.6} />
      <line x1={x - TICK_LEN} y1={y1} x2={x + TICK_LEN} y2={y1} stroke="#333" strokeWidth={0.6} />
      <line x1={x - TICK_LEN} y1={y2} x2={x + TICK_LEN} y2={y2} stroke="#333" strokeWidth={0.6} />
      <text
        x={textX}
        y={(y1 + y2) / 2 + LABEL_PX / 3}
        fontSize={LABEL_PX}
        textAnchor={anchor}
        fill="#111"
        fontFamily="sans-serif"
      >
        {label}
      </text>
    </g>
  )
}

function fmtMm(mm: number): string {
  if (Number.isNaN(mm) || !Number.isFinite(mm)) return '—'
  return `${Math.round(mm * 10) / 10} mm`
}

export function LayoutDiagram({
  artboard,
  designInnerSvg,
  designBounds,
  jobs,
  materialPreset,
  cutBadges,
}: LayoutDiagramProps) {
  const matW = artboard.width
  const matH = artboard.height

  const preset = MATERIAL_PRESETS.find((p) => p.id === materialPreset) ?? MATERIAL_PRESETS[0]

  const viewMinX = -DIM_PAD
  const viewMinY = -DIM_PAD
  const viewW = matW + DIM_PAD * 2
  const viewH = matH + DIM_PAD * 2

  const hasDesign = !!designBounds
  const dX = designBounds ? designBounds.minX : 0
  const dY = designBounds ? designBounds.minY : 0
  const dW = designBounds ? designBounds.maxX - designBounds.minX : 0
  const dH = designBounds ? designBounds.maxY - designBounds.minY : 0
  const offFromBLX = designBounds ? designBounds.minX : 0
  const offFromBLY = designBounds ? matH - designBounds.maxY : 0

  const patternId = useMemo(() => `prepare-material-${preset.id}`, [preset.id])

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
      className="block w-full"
      style={{ aspectRatio: `${viewW} / ${viewH}`, maxHeight: '60vh' }}
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={matW}
          height={matH}
          x={0}
          y={0}
        >
          <image
            href={preset.textureSrc}
            x={0}
            y={0}
            width={matW}
            height={matH}
            preserveAspectRatio="xMidYMid slice"
          />
        </pattern>
      </defs>

      {/* Material rectangle (= artboard = machinable area) */}
      <rect
        x={0}
        y={0}
        width={matW}
        height={matH}
        fill={`url(#${patternId})`}
        stroke="#222"
        strokeWidth={0.8}
      />

      {/* Design — exportToSVG normalizes the artboard origin to (0,0). */}
      {designInnerSvg ? (
        <g dangerouslySetInnerHTML={{ __html: designInnerSvg }} />
      ) : null}

      {/* Design bounding box (dashed) */}
      {hasDesign && dW > 0 && dH > 0 && (
        <rect
          x={dX}
          y={dY}
          width={dW}
          height={dH}
          fill="none"
          stroke="#dc2626"
          strokeWidth={0.7}
          strokeDasharray="3 2"
        />
      )}

      {/* Shared-axis horizon lines. Drawn before the crosshairs so the crosses
          read crisp on top. A shared x draws a vertical line across the full
          material height; a shared y draws a horizontal line. De-duplicated so
          we emit one line per unique coordinate. */}
      {(() => {
        const sharedXs = new Set<number>()
        const sharedYs = new Set<number>()
        for (const job of jobs) {
          const a = job.anchorAlignment
          if (!a) continue
          if (a.sharedX != null) sharedXs.add(a.sharedX)
          if (a.sharedY != null) sharedYs.add(a.sharedY)
        }
        const lines: React.ReactNode[] = []
        for (const x of sharedXs) {
          lines.push(
            <line
              key={`hx-${x}`}
              x1={x}
              y1={0}
              x2={x}
              y2={matH}
              stroke="#059669"
              strokeWidth={0.6}
              strokeDasharray="4 3"
              opacity={0.55}
            />,
          )
        }
        for (const y of sharedYs) {
          lines.push(
            <line
              key={`hy-${y}`}
              x1={0}
              y1={y}
              x2={matW}
              y2={y}
              stroke="#059669"
              strokeWidth={0.6}
              strokeDasharray="4 3"
              opacity={0.55}
            />,
          )
        }
        return lines
      })()}

      {/* Per-job anchor crosshairs */}
      {jobs.map((job, i) => {
        const cx = job.anchorPointMm.x
        const cy = job.anchorPointMm.y
        return (
          <g key={job.id}>
            <circle cx={cx} cy={cy} r={6} fill="none" stroke="#059669" strokeWidth={0.9} />
            <line x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} stroke="#059669" strokeWidth={0.9} />
            <line x1={cx} y1={cy - 9} x2={cx} y2={cy + 9} stroke="#059669" strokeWidth={0.9} />
            <text
              x={cx + 8}
              y={cy - 8}
              fontSize={LABEL_PX}
              fill="#065f46"
              fontFamily="sans-serif"
              fontWeight={600}
            >
              {job.name || `Job ${i + 1}`}
            </text>
          </g>
        )
      })}

      {/* Material dimensions */}
      <Hdim y={-DIM_OFFSET} x1={0} x2={matW} label={`W ${fmtMm(matW)}`} placement="above" />
      <Vdim x={matW + DIM_OFFSET} y1={0} y2={matH} label={`H ${fmtMm(matH)}`} placement="right" />

      {/* Design reach + design-bounds offsets from BL.
          The design offset dims sit in the narrow band next to the material
          (y≈matH+9, x≈-6); per-job anchor pills sit further out, so both rows
          coexist without overlap. */}
      {hasDesign && dW > 0 && dH > 0 && (
        <>
          <Hdim
            y={dY - 10}
            x1={dX}
            x2={dX + dW}
            label={`Design W ${fmtMm(dW)}`}
            placement="above"
          />
          <Vdim
            x={dX + dW + 10}
            y1={dY}
            y2={dY + dH}
            label={`Design H ${fmtMm(dH)}`}
            placement="right"
          />
          <Hdim
            y={matH + DIM_OFFSET / 2}
            x1={0}
            x2={dX}
            label={`X ${fmtMm(offFromBLX)}`}
            placement="above"
          />
          <Vdim
            x={-6}
            y1={dY + dH}
            y2={matH}
            label={`Y ${fmtMm(offFromBLY)}`}
            placement="left"
          />
        </>
      )}

      {/* Per-job X/Y offset pills with leader lines to the anchor.
          One tag per unique coordinate, so jobs snapped onto a shared horizon
          line share a pill rather than stacking duplicates. */}
      {(() => {
        const xSeen = new Set<number>()
        const ySeen = new Set<number>()
        const nodes: React.ReactNode[] = []
        const pillFor = (label: string) => {
          const width = Math.max(20, label.length * TAG_CHAR_W + TAG_PAD_X * 2)
          const height = TAG_FONT + TAG_PAD_Y * 2
          return { width, height }
        }

        for (const job of jobs) {
          const cx = job.anchorPointMm.x
          const cy = job.anchorPointMm.y
          const xFromBL = job.crossOffsetFromArtboardBL.x
          const yFromBL = job.crossOffsetFromArtboardBL.y

          if (!xSeen.has(cx)) {
            xSeen.add(cx)
            const label = `X ${fmtMm(xFromBL)}`
            const { width, height } = pillFor(label)
            const tagCx = cx
            const tagCy = matH + TAG_BOTTOM_CENTER_OFFSET
            const pillTop = tagCy - height / 2
            nodes.push(
              <g key={`jx-${job.id}`}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={tagCx}
                  y2={pillTop}
                  stroke={TAG_FILL}
                  strokeWidth={0.55}
                  opacity={0.85}
                />
                <rect
                  x={tagCx - width / 2}
                  y={pillTop}
                  width={width}
                  height={height}
                  rx={2}
                  ry={2}
                  fill={TAG_FILL}
                />
                <text
                  x={tagCx}
                  y={tagCy + TAG_FONT / 2 - 1}
                  fontSize={TAG_FONT}
                  textAnchor="middle"
                  fill={TAG_TEXT}
                  fontFamily="sans-serif"
                  fontWeight={700}
                >
                  {label}
                </text>
              </g>,
            )
          }

          if (!ySeen.has(cy)) {
            ySeen.add(cy)
            const label = `Y ${fmtMm(yFromBL)}`
            const { width, height } = pillFor(label)
            const rightEdge = -TAG_GAP
            const tagCx = rightEdge - width / 2
            const tagCy = cy
            nodes.push(
              <g key={`jy-${job.id}`}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={rightEdge}
                  y2={tagCy}
                  stroke={TAG_FILL}
                  strokeWidth={0.55}
                  opacity={0.85}
                />
                <rect
                  x={tagCx - width / 2}
                  y={tagCy - height / 2}
                  width={width}
                  height={height}
                  rx={2}
                  ry={2}
                  fill={TAG_FILL}
                />
                <text
                  x={tagCx}
                  y={tagCy + TAG_FONT / 2 - 1}
                  fontSize={TAG_FONT}
                  textAnchor="middle"
                  fill={TAG_TEXT}
                  fontFamily="sans-serif"
                  fontWeight={700}
                >
                  {label}
                </text>
              </g>,
            )
          }
        }
        return nodes
      })()}

      {/* Cut-order number badges — rendered at each leaf's artboard-space
          (minX, minY). Darker hue bg + lighter hue text, matching the canvas. */}
      {cutBadges && cutBadges.length > 0
        ? cutBadges.map((b) => {
            const hue = (b.jobIndex * 57) % 360
            const bg = `hsl(${hue}, 65%, 28%)`
            const fg = `hsl(${hue}, 90%, 88%)`
            const stroke = `hsl(${hue}, 70%, 55%)`
            const r = 4.5
            return (
              <g key={`cut-badge-${b.nodeId}`}>
                <circle cx={b.x} cy={b.y} r={r} fill={bg} stroke={stroke} strokeWidth={0.5} />
                <text
                  x={b.x}
                  y={b.y + 2}
                  fontSize={5.2}
                  textAnchor="middle"
                  fill={fg}
                  fontFamily="sans-serif"
                  fontWeight={700}
                >
                  {b.step}
                </text>
              </g>
            )
          })
        : null}
    </svg>
  )
}
