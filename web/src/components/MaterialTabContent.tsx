import { useState, type SVGProps } from 'react'
import { Button, Label, Slider } from '@heroui/react'
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Diamond,
} from '@gravity-ui/icons'

import { resolveEffectiveMaxStepdown } from '../lib/bridgeSettingsAdapter'
import { useEditorStore } from '../store'
import type { MachiningSettings, PathAnchor, RouterBitShape } from '../types/editor'
import { MATERIAL_PRESETS } from '../lib/materialPresets'
import type { MaterialPreset } from '../lib/materialPresets'
import flatRouterBitImg from '../assets/router_bits/flat_router_bit.png'
import roundRouterBitImg from '../assets/router_bits/round_router_bit.png'
import vCarveBitImg from '../assets/router_bits/v_carve_bit.png'

interface MaterialTabContentProps {
  materialPreset: MaterialPreset
  onMaterialChange: (preset: MaterialPreset) => void
}

function defaultStepover(shape: RouterBitShape, diameter: number): number {
  const factor = shape === 'Flat' ? 0.8 : 0.4
  return Math.round(diameter * factor * 100) / 100
}

const DEFAULT_CUT_FEEDRATE = 300
const DEFAULT_PLUNGE_FEEDRATE = 120
const PATH_ANCHORS: Array<{
  value: PathAnchor
  name: string
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element
}> = [
  { value: 'TopLeft', name: 'Top left', icon: ArrowUpLeft },
  { value: 'TopCenter', name: 'Top center', icon: ArrowUp },
  { value: 'TopRight', name: 'Top right', icon: ArrowUpRight },
  { value: 'MiddleLeft', name: 'Middle left', icon: ArrowLeft },
  { value: 'Center', name: 'Center', icon: Diamond },
  { value: 'MiddleRight', name: 'Middle right', icon: ArrowRight },
  { value: 'BottomLeft', name: 'Bottom left', icon: ArrowDownLeft },
  { value: 'BottomCenter', name: 'Bottom center', icon: ArrowDown },
  { value: 'BottomRight', name: 'Bottom right', icon: ArrowDownRight },
]

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
}

export function MaterialTabContent({ materialPreset, onMaterialChange }: MaterialTabContentProps) {
  const artboard = useEditorStore((s) => s.artboard)
  const selectedStage = useEditorStore((s) => s.selectedStage)
  const setArtboardSize = useEditorStore((s) => s.setArtboardSize)
  const machiningSettings = useEditorStore((s) => s.machiningSettings)
  const setMachiningSettings = useEditorStore((s) => s.setMachiningSettings)
  const setHoveredPathAnchor = useEditorStore((s) => s.setHoveredPathAnchor)
  const nodesById = useEditorStore((s) => s.nodesById)
  const selectedJobId = useEditorStore((s) => s.selectedJobId)
  const setSelectedJob = useEditorStore((s) => s.setSelectedJob)
  const updateJob = useEditorStore((s) => s.updateJob)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [stepoverFlash, setStepoverFlash] = useState(false)

  const setField = (patch: Partial<MachiningSettings>) => setMachiningSettings(patch)

  // Look up the pinned manual entry for the selected job (if any). Auto-
  // derived jobs aren't surfaced here yet — scaffolding only wires the
  // path where the user has already committed manual overrides.
  const selectedJobEntry =
    selectedJobId != null
      ? machiningSettings.manualJobs?.find((j) => j.id === selectedJobId) ?? null
      : null
  const anchorLabel = selectedJobEntry
    ? `Anchor for: ${selectedJobEntry.name}`
    : 'Anchor for: whole file'
  const effectiveAnchor = selectedJobEntry?.pathAnchor ?? machiningSettings.pathAnchor
  const setEffectiveAnchor = (next: PathAnchor) => {
    if (selectedJobEntry) {
      updateJob(selectedJobEntry.id, { pathAnchor: next })
    } else {
      setField({ pathAnchor: next })
    }
  }

  const maxCutDepth = Object.values(nodesById).reduce<number>((max, node) => {
    const d = node.cncMetadata?.cutDepth
    return d !== undefined && d > max ? d : max
  }, machiningSettings.defaultDepthMm)

  const depthPerPass =
    machiningSettings.passCount > 1
      ? round2(maxCutDepth / machiningSettings.passCount)
      : null
  const effectiveMaxStepdown = resolveEffectiveMaxStepdown(machiningSettings, maxCutDepth)
  const passMode = machiningSettings.maxStepdown != null ? 'stepdown' : 'passes'
  const estimatedPassCount = effectiveMaxStepdown != null
    ? Math.max(1, Math.ceil(maxCutDepth / effectiveMaxStepdown))
    : 1
  const fullDepthFeed = machiningSettings.cutFeedrate ?? DEFAULT_CUT_FEEDRATE
  const maxFeed = machiningSettings.shallowCutFeedrate ?? fullDepthFeed
  const feedRange = [Math.min(fullDepthFeed, maxFeed), Math.max(fullDepthFeed, maxFeed)]
  const feedSliderMax = Math.max(1000, Math.ceil(feedRange[1] / 100) * 100)
  const hasFeedRange = feedRange[1] > feedRange[0]
  const firstPassDepth = effectiveMaxStepdown != null ? Math.min(effectiveMaxStepdown, maxCutDepth) : maxCutDepth
  const firstPassFeed = hasFeedRange && maxCutDepth > 0
    ? Math.round(feedRange[1] + (feedRange[0] - feedRange[1]) * Math.min(1, firstPassDepth / maxCutDepth))
    : fullDepthFeed

  const updateFeedRange = (values: number[]) => {
    const [rawA = fullDepthFeed, rawB = maxFeed] = values
    const minFeed = Math.max(10, Math.round(Math.min(rawA, rawB)))
    const highFeed = Math.max(minFeed, Math.round(Math.max(rawA, rawB)))
    setField({
      cutFeedrate: minFeed,
      shallowCutFeedrate: highFeed > minFeed ? highFeed : null,
    })
  }

  return (
    <div className="space-y-5">
      {/* Material selector */}
      <section className="space-y-3">
        <SectionHeading title="Material" />
        <div className="flex flex-wrap gap-2">
          <NumberPill label="W" value={artboard.width} unit="mm"
            onChange={(v) => { if (v !== null && v >= 1) setArtboardSize({ width: Math.round(v) }) }} />
          <NumberPill label="H" value={artboard.height} unit="mm"
            onChange={(v) => { if (v !== null && v >= 1) setArtboardSize({ height: Math.round(v) }) }} />
          <NumberPill label="T" value={artboard.thickness} unit="mm"
            onChange={(v) => { if (v !== null && v >= 0) setArtboardSize({ thickness: v }) }} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {MATERIAL_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`relative overflow-hidden rounded-lg border-2 transition ${
                materialPreset === preset.id
                  ? 'border-primary'
                  : 'border-border hover:border-border/80'
              }`}
              onClick={() => onMaterialChange(preset.id)}
            >
              <img
                src={preset.textureSrc}
                alt={preset.label}
                className="h-14 w-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 bg-black/50 px-1 py-1 text-center text-xs font-medium text-white">
                {preset.label}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Router bit */}
      <section className="space-y-3">
        <SectionHeading title="Router bit" />
        <div className="flex items-end gap-3">
          <NumberField label="Diameter" unit="mm" value={machiningSettings.toolDiameter}
            onChange={(v) => { if (v !== null && v > 0) setField({ toolDiameter: v }) }} />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Shape</p>
          <div className="flex gap-3">
            {([['Flat', flatRouterBitImg], ['Ball', roundRouterBitImg], ['V', vCarveBitImg]] as [RouterBitShape, string][]).map(
              ([shape, img]) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => {
                    const prevDefault = defaultStepover(machiningSettings.toolShape, machiningSettings.toolDiameter)
                    const newDefault = defaultStepover(shape, machiningSettings.toolDiameter)
                    const isAutoStepover = machiningSettings.stepover === null || machiningSettings.stepover === prevDefault
                    setField({ toolShape: shape, ...(isAutoStepover && { stepover: newDefault }) })
                    if (isAutoStepover && shape !== machiningSettings.toolShape) {
                      setStepoverFlash(true)
                      setTimeout(() => setStepoverFlash(false), 1000)
                    }
                  }}
                  className={`flex flex-col items-center gap-1 rounded-lg border-2 px-2 py-2 transition ${
                    machiningSettings.toolShape === shape
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-border/60'
                  }`}
                >
                  <img src={img} alt={shape} className="h-10 w-10 object-contain" />
                  <span className="text-xs text-foreground">{shape}</span>
                </button>
              ),
            )}
          </div>
        </div>
        <div className={`transition-all duration-200 ${stepoverFlash ? 'ring-2 ring-primary rounded-lg p-1 -m-1' : ''}`}>
          <NumberField label="Stepover" unit="mm" value={machiningSettings.stepover}
            onChange={(v) => { setStepoverFlash(false); setField({ stepover: positiveOrNull(v) }) }} />
        </div>
      </section>

      {/* Cut planning */}
      <section className="space-y-3">
        <SectionHeading title="Cut planning" />
        <div className="flex flex-wrap items-end gap-3">
          <NumberField label="Target depth" unit="mm" value={machiningSettings.defaultDepthMm}
            onChange={(v) => { if (v !== null && v > 0) setField({ defaultDepthMm: v }) }} />
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">Depth strategy</p>
            <div className="inline-flex h-8 overflow-hidden rounded-md border border-border bg-content1">
              <button
                type="button"
                className={`px-2 text-xs transition-colors ${passMode === 'passes' ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-content2'}`}
                onClick={() => setField({ maxStepdown: null })}
              >
                Passes
              </button>
              <button
                type="button"
                className={`px-2 text-xs transition-colors ${passMode === 'stepdown' ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-content2'}`}
                onClick={() => setField({ maxStepdown: effectiveMaxStepdown ?? Math.max(0.1, maxCutDepth) })}
              >
                mm / pass
              </button>
            </div>
          </div>
          {passMode === 'passes' ? (
            <div className="grid gap-1">
              <p className="text-xs text-muted-foreground">Passes</p>
              <div className="inline-flex h-8 items-center rounded-md border border-border bg-content1 px-2">
                <input
                  type="text"
                  inputMode="numeric"
                  className="w-10 border-0 bg-transparent px-0 text-sm text-foreground outline-none"
                  value={String(machiningSettings.passCount)}
                  onChange={(e) => {
                    const v = Math.max(1, Math.round(Number(e.target.value)))
                    if (Number.isFinite(v)) setField({ passCount: v })
                  }}
                />
                <span className="pl-1 text-xs text-muted-foreground">x</span>
              </div>
            </div>
          ) : (
            <NumberField label="Depth / pass" unit="mm" value={machiningSettings.maxStepdown}
              onChange={(v) => setField({ maxStepdown: positiveOrNull(v) ?? effectiveMaxStepdown ?? 1 })} />
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {passMode === 'passes'
            ? `${depthPerPass ?? maxCutDepth} mm per pass across ${maxCutDepth} mm.`
            : `${estimatedPassCount} pass${estimatedPassCount === 1 ? '' : 'es'} across ${maxCutDepth} mm.`}
        </div>
      </section>

      {/* Work anchor */}
      <section className="space-y-3">
        <SectionHeading title="Work anchor" />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{anchorLabel}</p>
          {selectedJobEntry ? (
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => setSelectedJob(null)}
            >
              Edit whole-file default
            </button>
          ) : null}
        </div>
        <PathAnchorPicker
          value={effectiveAnchor}
          onChange={setEffectiveAnchor}
          onPreview={setHoveredPathAnchor}
        />
        <p className="text-xs text-muted-foreground">
          This point in the generated cut bounds becomes machine 0,0. Bottom left keeps today&apos;s output.
        </p>

        <div className="space-y-2 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={machiningSettings.alignJobAnchors}
              onChange={(e) => setField({ alignJobAnchors: e.target.checked })}
              className="rounded border-border"
            />
            Align nearby job anchors onto a shared line
          </label>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Tolerance</span>
            <input
              type="number"
              min={0}
              step={1}
              value={machiningSettings.alignJobAnchorsToleranceMm}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value)
                if (Number.isFinite(next) && next >= 0) {
                  setField({ alignJobAnchorsToleranceMm: next })
                }
              }}
              disabled={!machiningSettings.alignJobAnchors}
              className="w-16 rounded border border-border bg-background px-1.5 py-0.5 text-right text-foreground disabled:opacity-50"
            />
            <span>mm</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Centered anchors within this distance snap onto a shared x or y — draw one horizon line on the material and measure one offset per job.
          </p>
        </div>
      </section>

      {/* Jobs — split the program into rezero checkpoints. */}
      <section className="space-y-3">
        <SectionHeading title="Jobs" />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={machiningSettings.jobsEnabled}
            onChange={(e) => setField({ jobsEnabled: e.target.checked })}
            className="rounded border-border"
          />
          Split into jobs with rezero pauses
        </label>
        <p className="text-xs text-muted-foreground">
          On handheld CNCs, long travel drifts. Job boundaries pause the machine (M0) so you can realign the router at a pencil cross and rezero. The planner clusters shapes spatially and isolates large encompassing shapes as their own job.
        </p>
      </section>

      {/* Feed speed */}
      <section className="space-y-3">
        <SectionHeading title="Feed speed" />
        <Slider
          aria-label="Feed range"
          className="w-full"
          value={feedRange}
          minValue={10}
          maxValue={feedSliderMax}
          step={10}
          onChange={(value) => updateFeedRange(value as number[])}
        >
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs text-muted-foreground">XY feed range</Label>
            <Slider.Output className="text-xs text-foreground" />
          </div>
          <Slider.Track className="relative h-2 w-full cursor-pointer rounded-full bg-content2">
            {({ state }) => (
              <>
                <Slider.Fill className="absolute inset-y-0 rounded-full bg-primary" />
                {state.values.map((_, index) => (
                  <Slider.Thumb
                    key={index}
                    index={index}
                    className="block h-4 w-4 rounded-full border-2 border-white bg-primary shadow-md outline-none"
                  />
                ))}
              </>
            )}
          </Slider.Track>
        </Slider>
        <div className="flex flex-wrap gap-3">
          <NumberField label="Min feed" unit="mm/min" value={feedRange[0]}
            onChange={(v) => {
              const nextMin = positiveOrNull(v) ?? feedRange[0]
              updateFeedRange([nextMin, Math.max(nextMin, feedRange[1])])
            }} />
          <NumberField label="Max feed" unit="mm/min" value={feedRange[1]}
            onChange={(v) => {
              const nextMax = positiveOrNull(v) ?? feedRange[1]
              updateFeedRange([Math.min(feedRange[0], nextMax), nextMax])
            }} />
          <NumberField label="Plunge feed" unit="mm/min" value={machiningSettings.plungeFeedrate ?? DEFAULT_PLUNGE_FEEDRATE}
            onChange={(v) => setField({ plungeFeedrate: positiveOrNull(v) })} />
        </div>
        <p className="text-xs text-muted-foreground">
          {hasFeedRange
            ? `First pass about ${firstPassFeed} mm/min, final pass ${feedRange[0]} mm/min.`
            : `All XY cuts use ${feedRange[0]} mm/min.`}
        </p>
      </section>

      {/* Tabs */}
      <section className="space-y-3">
        <SectionHeading title="Tabs" />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={machiningSettings.tabsEnabled}
            onChange={(e) => setField({ tabsEnabled: e.target.checked })}
            className="rounded border-border"
          />
          Apply tabs on through-cuts
        </label>
        {machiningSettings.tabsEnabled && (
          <>
            <p className="text-xs text-muted-foreground">
              Tabs hold the part in place when cutting all the way through. Sand or snap them off after machining.
            </p>
            <div className="flex flex-wrap gap-3">
              <NumberField label="Width" unit="mm" value={machiningSettings.tabWidth}
                onChange={(v) => { if (v !== null && v > 0) setField({ tabWidth: v }) }} />
              <NumberField label="Height" unit="mm" value={machiningSettings.tabHeight}
                onChange={(v) => { if (v !== null && v > 0) setField({ tabHeight: v }) }} />
              <NumberField label="Spacing" unit="mm" value={machiningSettings.tabSpacing}
                onChange={(v) => { if (v !== null && v > 0) setField({ tabSpacing: v }) }} />
            </div>
          </>
        )}
      </section>

      {/* Advanced */}
      <section className="rounded-md border border-border bg-content1 px-3 py-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          <span className="text-xs text-muted-foreground">{advancedOpen ? '▾' : '▸'}</span>
          <p className="text-sm font-medium text-foreground">Advanced</p>
        </button>
        {advancedOpen && (
          <div className="mt-3 flex flex-wrap gap-3">
            <div className="w-full space-y-1">
              <label className="text-xs text-muted-foreground">Max Fill Passes</label>
              <div className="grid grid-cols-4 gap-1">
                {([1, 2, 3, null] as const).map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    className={`rounded-md border px-1 py-1 text-xs transition-colors ${
                      machiningSettings.maxFillPasses === v
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-content1 text-foreground hover:bg-content2'
                    }`}
                    onClick={() => setField({ maxFillPasses: v })}
                  >
                    {v === null ? 'Auto' : v}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Limit lateral pocket passes. Lower values allow thicker single-pass cuts.
              </p>
            </div>
            <NumberField label="Travel Z" unit="mm" value={machiningSettings.travelZ}
              onChange={(v) => setField({ travelZ: v })} />
            <NumberField label="Cut Z" unit="mm" value={machiningSettings.cutZ}
              onChange={(v) => setField({ cutZ: v })} />
            <NumberField label="Machine W" unit="mm" value={machiningSettings.machineWidth}
              onChange={(v) => setField({ machineWidth: v })} />
            <NumberField label="Machine H" unit="mm" value={machiningSettings.machineHeight}
              onChange={(v) => setField({ machineHeight: v })} />

            {/* Path optimization */}
            <div className="w-full space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium text-foreground">Path optimization</p>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={machiningSettings.optimizePathOrder}
                  onChange={(e) => setField({ optimizePathOrder: e.target.checked })}
                  className="rounded border-border"
                />
                Reorder paths to minimize travel (TSP)
              </label>
              <p className="text-xs text-muted-foreground">
                Solves a travel-minimizing order over strokes. Good default on; turn off to keep document order.
              </p>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={machiningSettings.clusterDetourRadius != null}
                  onChange={(e) =>
                    setField({ clusterDetourRadius: e.target.checked ? 5 : null })
                  }
                  className="rounded border-border"
                />
                Cluster nearby strokes as detours
              </label>
              {machiningSettings.clusterDetourRadius != null && (
                <div className="pl-6">
                  <NumberField
                    label="Detour radius"
                    unit="mm"
                    value={machiningSettings.clusterDetourRadius}
                    onChange={(v) =>
                      setField({ clusterDetourRadius: v != null && v > 0 ? v : null })
                    }
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                After reordering, splices short strokes into nearby longer strokes at the closest command boundary within this radius. Helps handheld / drift-prone CNCs by keeping consecutive cuts local.
              </p>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={machiningSettings.circularInterpolation}
                  onChange={(e) => setField({ circularInterpolation: e.target.checked })}
                  className="rounded border-border"
                />
                Emit G2/G3 arcs (circular interpolation)
              </label>
              <p className="text-xs text-muted-foreground">
                Outputs curves as arcs instead of polylines. Much smaller gcode; requires firmware that supports G2/G3 (GRBL/fluidNC do).
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Artboard position info */}
      <section className="space-y-3">
        <SectionHeading title="Artboard" />
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div className="rounded-md border border-border bg-content1 px-3 py-2">
            Offset X: {artboard.x}
          </div>
          <div className="rounded-md border border-border bg-content1 px-3 py-2">
            Offset Y: {artboard.y}
          </div>
        </div>
        <div className="rounded-md border border-border bg-content1 px-3 py-3 text-sm text-muted-foreground">
          {selectedStage
            ? 'Artboard selected — drag or resize on canvas.'
            : 'Click the stage to select the artboard.'}
        </div>
      </section>
    </div>
  )
}

export function PreviewTabContent() {
  const cameraType = useEditorStore((s) => s.preview.cameraType)
  const showStock = useEditorStore((s) => s.preview.showStock)
  const showSvgOverlay = useEditorStore((s) => s.preview.showSvgOverlay)
  const showRapidMoves = useEditorStore((s) => s.preview.showRapidMoves)
  const showCutOrder = useEditorStore((s) => s.preview.showCutOrder)
  const showJobOrder = useEditorStore((s) => s.preview.showJobOrder)
  const setCameraType = useEditorStore((s) => s.setCameraType)
  const setShowStock = useEditorStore((s) => s.setShowStock)
  const setShowSvgOverlay = useEditorStore((s) => s.setShowSvgOverlay)
  const setShowRapidMoves = useEditorStore((s) => s.setShowRapidMoves)
  const setShowCutOrder = useEditorStore((s) => s.setShowCutOrder)
  const setShowJobOrder = useEditorStore((s) => s.setShowJobOrder)

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SectionHeading title="3D Camera" />
        <div className="flex gap-2">
          {(['perspective', 'orthographic'] as const).map((type) => (
            <Button
              key={type}
              size="sm"
              variant={cameraType === type ? 'primary' : 'secondary'}
              onPress={() => setCameraType(type)}
            >
              {type === 'perspective' ? 'Perspective' : 'Ortho'}
            </Button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading title="View options" />
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={showStock}
              onChange={(e) => setShowStock(e.target.checked)}
              className="rounded border-border"
            />
            Stock view (vs sweep volumes)
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={showSvgOverlay}
              onChange={(e) => setShowSvgOverlay(e.target.checked)}
              className="rounded border-border"
            />
            SVG path overlay
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={showRapidMoves}
              onChange={(e) => setShowRapidMoves(e.target.checked)}
              className="rounded border-border"
            />
            Show rapid moves
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={showCutOrder}
              onChange={(e) => setShowCutOrder(e.target.checked)}
              className="rounded border-border"
            />
            Show cut order badges + rapids
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={showJobOrder}
              onChange={(e) => setShowJobOrder(e.target.checked)}
              className="rounded border-border"
            />
            Show job order and starting anchor
          </label>
        </div>
      </section>
    </div>
  )
}

export function PathAnchorPicker({
  value,
  onChange,
  onPreview,
}: {
  value: PathAnchor
  onChange: (value: PathAnchor) => void
  onPreview: (value: PathAnchor | null) => void
}) {
  const active = PATH_ANCHORS.find((anchor) => anchor.value === value)

  return (
    <div className="space-y-2">
      <div className="grid w-40 grid-cols-3 gap-1">
        {PATH_ANCHORS.map((anchor) => {
          const selected = anchor.value === value
          const Icon = anchor.icon
          return (
            <button
              key={anchor.value}
              type="button"
              className={`flex h-10 items-center justify-center rounded-md border text-xs font-semibold transition-colors ${
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-content1 text-foreground hover:bg-content2'
              }`}
              title={anchor.name}
              aria-label={`Use ${anchor.name} as work anchor`}
              aria-pressed={selected}
              onMouseEnter={() => onPreview(anchor.value)}
              onMouseLeave={() => onPreview(null)}
              onFocus={() => onPreview(anchor.value)}
              onBlur={() => onPreview(null)}
              onClick={() => onChange(anchor.value)}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          )
        })}
      </div>
      <div className="text-xs text-foreground">
        {active?.name ?? 'Bottom left'}
      </div>
    </div>
  )
}

// ── Shared UI components ──

export function SectionHeading({
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

export function NumberField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string
  unit: string
  value: number | null
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
    <div className="grid gap-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="inline-flex h-8 items-center rounded-md border border-border bg-content1 px-2">
        <input
          type="text"
          inputMode="decimal"
          placeholder="—"
          className="w-14 border-0 bg-transparent px-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
          value={editValue ?? (value !== null ? String(value) : '')}
          onFocus={(e) => {
            setEditValue(value !== null ? String(value) : '')
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
    </div>
  )
}
