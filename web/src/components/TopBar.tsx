import { useEffect, useState, type ReactNode } from 'react'
import { Button, ButtonGroup, Dropdown, Label, ProgressBar, ProgressCircle } from '@heroui/react'
import type { JobProgress, GenerateJobResponse } from '@svg2gcode/bridge'
import ArrowDownToSquareIcon from '@gravity-ui/icons/esm/ArrowDownToSquare.js'
import SparklesIcon from '@gravity-ui/icons/esm/Sparkles.js'

import { AppIcon } from '../lib/icons'
import type { ViewMode } from '../types/preview'

interface TopBarProps {
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
  onGenerateGcode: () => void
  onDownloadGcode: (format: 'nc' | 'gcode') => void
  downloadFormat: 'nc' | 'gcode'
  onDownloadFormatChange: (format: 'nc' | 'gcode') => void
  isGenerating?: boolean
  progress?: JobProgress | null
  hasGcodeResult?: boolean
  gcodeResult?: GenerateJobResponse | null
  gcodeError?: string | null
  onDismissGcode?: () => void
  prepareExportControl?: ReactNode
}

const GCODE_TOAST_AUTO_DISMISS_MS = 5000
const GCODE_TOAST_COUNTDOWN_TICK_MS = 100

function progressLabel(progress: JobProgress | null | undefined): string {
  if (!progress) return 'Preparing GCode generation…'

  switch (progress.phase) {
    case 'processing': {
      const { current, total } = progress
      if (total > 0) {
        return `Processing operation ${Math.min(current + 1, total)} of ${total}`
      }
      return 'Processing operations…'
    }
    case 'optimizing':
      return 'Optimizing toolpath order…'
    case 'formatting':
      return 'Formatting GCode output…'
    default:
      return 'Generating GCode…'
  }
}

function progressPercent(progress: JobProgress | null | undefined): number {
  if (!progress) return 3

  switch (progress.phase) {
    case 'processing': {
      const { current, total } = progress
      if (total > 0) return Math.max(5, Math.min(85, Math.round((current / total) * 85)))
      return 10
    }
    case 'optimizing':
      return 92
    case 'formatting':
      return 97
    default:
      return 3
  }
}

export function TopBar({
  viewMode,
  onViewModeChange,
  onGenerateGcode,
  onDownloadGcode,
  downloadFormat,
  onDownloadFormatChange,
  isGenerating,
  progress,
  hasGcodeResult,
  gcodeResult,
  gcodeError,
  onDismissGcode,
  prepareExportControl,
}: TopBarProps) {
  const [dismissedGcodeResult, setDismissedGcodeResult] = useState<GenerateJobResponse | null>(null)
  const [dismissCountdown, setDismissCountdown] = useState<{
    result: GenerateJobResponse | null
    remainingMs: number
  }>({
    result: null,
    remainingMs: GCODE_TOAST_AUTO_DISMISS_MS,
  })
  const percent = progressPercent(progress)
  const showGcodeResultToast = !!gcodeResult && dismissedGcodeResult !== gcodeResult
  const dismissRemainingMs =
    dismissCountdown.result === gcodeResult ? dismissCountdown.remainingMs : GCODE_TOAST_AUTO_DISMISS_MS
  const dismissCountdownValue = Math.max(
    0,
    Math.round((dismissRemainingMs / GCODE_TOAST_AUTO_DISMISS_MS) * 100),
  )
  const dismissCountdownSeconds = Math.max(1, Math.ceil(dismissRemainingMs / 1000))
  const isExpanded = isGenerating || showGcodeResultToast || !!gcodeError

  useEffect(() => {
    if (!gcodeResult || isGenerating || dismissedGcodeResult === gcodeResult) return

    const startedAt = Date.now()
    const intervalId = window.setInterval(() => {
      const remainingMs = Math.max(0, GCODE_TOAST_AUTO_DISMISS_MS - (Date.now() - startedAt))
      setDismissCountdown({ result: gcodeResult, remainingMs })

      if (remainingMs === 0) {
        setDismissedGcodeResult(gcodeResult)
        window.clearInterval(intervalId)
      }
    }, GCODE_TOAST_COUNTDOWN_TICK_MS)

    return () => window.clearInterval(intervalId)
  }, [dismissedGcodeResult, gcodeResult, isGenerating])

  const dismissGcodeResultToast = () => {
    if (!gcodeResult) return
    setDismissCountdown({ result: gcodeResult, remainingMs: 0 })
    setDismissedGcodeResult(gcodeResult)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
      <div className="pointer-events-auto inline-flex flex-col rounded-[1.75rem] border border-white/10 bg-[rgba(19,19,23,0.9)] px-3 py-3 text-white shadow-[0_24px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl transition-all duration-300">
        <div className="flex min-h-10 items-center gap-3">

          {/* Main workspace tabs */}
          <div className="flex h-10 items-center rounded-[1.2rem] bg-[#27272A] px-1">
            <button
              type="button"
              className={`flex h-8 min-w-[80px] items-center justify-center rounded-[0.9rem] px-5 text-sm font-medium transition ${
                viewMode === 'design'
                  ? 'bg-[#3f3f46] text-white'
                  : 'text-white/40 hover:text-white/60'
              }`}
              onClick={() => onViewModeChange('design')}
            >
              Design
            </button>
            <button
              type="button"
              className={`flex h-8 min-w-[80px] items-center justify-center rounded-[0.9rem] px-5 text-sm font-medium transition ${
                viewMode === 'prepare'
                  ? 'bg-[#3f3f46] text-white'
                  : 'text-white/40 hover:text-white/60'
              }`}
              onClick={() => onViewModeChange('prepare')}
            >
              Prepare
            </button>
          </div>

          {/* Generated preview tabs */}
          <div className="flex h-10 items-center rounded-[1.2rem] bg-[#27272A] px-1">
            <button
              type="button"
              className={`flex h-8 min-w-[68px] items-center justify-center rounded-[0.9rem] px-4 text-sm font-medium transition ${
                viewMode === 'preview2d'
                  ? 'bg-[#3f3f46] text-white'
                  : 'text-white/40 hover:text-white/60'
              }`}
              onClick={() => onViewModeChange('preview2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={`flex h-8 min-w-[68px] items-center justify-center rounded-[0.9rem] px-4 text-sm font-medium transition ${
                viewMode === 'preview3d'
                  ? 'bg-[#3f3f46] text-white'
                  : hasGcodeResult
                    ? 'text-white/40 hover:text-white/60'
                    : 'cursor-not-allowed text-white/20'
              }`}
              onClick={() => {
                if (hasGcodeResult) {
                  onViewModeChange('preview3d')
                }
              }}
            >
              3D
            </button>
          </div>

          {/* Generate GCode — immediately after tabs */}
          <Button
            className="rounded-full bg-emerald-600 text-[14px] font-medium text-white hover:bg-emerald-500 px-3 gap-1.5"
            size="sm"
            isDisabled={isGenerating}
            onPress={onGenerateGcode}
          >
            <AppIcon icon={SparklesIcon} className="h-4 w-4" />
            Make GCode
          </Button>
          <ButtonGroup
            className="rounded-full"
            aria-label="Export G-code"
          >
            <Button
              className="rounded-l-full bg-emerald-600 px-3 gap-1.5 text-[14px] font-medium text-white hover:bg-emerald-500 disabled:bg-emerald-900/40 disabled:text-white/35"
              size="sm"
              isDisabled={isGenerating || !hasGcodeResult}
              onPress={() => onDownloadGcode(downloadFormat)}
            >
              <AppIcon icon={ArrowDownToSquareIcon} className="h-4 w-4" />
              Export .{downloadFormat}
            </Button>
            <Dropdown>
              <Button
                isIconOnly
                aria-label="Choose export format"
                size="sm"
                className="rounded-r-full bg-emerald-600 px-2 text-white hover:bg-emerald-500 disabled:bg-emerald-900/40 disabled:text-white/35"
                isDisabled={isGenerating || !hasGcodeResult}
              >
                <span className="text-[11px] font-bold leading-none">···</span>
              </Button>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  onAction={(key) => {
                    const fmt = key as 'nc' | 'gcode'
                    onDownloadFormatChange(fmt)
                    onDownloadGcode(fmt)
                  }}
                >
                  <Dropdown.Item id="nc">Export as .nc</Dropdown.Item>
                  <Dropdown.Item id="gcode">Export as .gcode</Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </ButtonGroup>
          {viewMode === 'prepare' ? prepareExportControl : null}
        </div>

        {/* Expandable status area */}
        {isExpanded && (
          <div className="mt-3 border-t border-white/10 pt-3">
            {isGenerating && (
              <ProgressBar aria-label="GCode generation progress" className="w-full" value={percent}>
                <div className="mb-2 flex items-center justify-between gap-4 text-sm">
                  <Label className="text-sm font-medium text-white">{progressLabel(progress)}</Label>
                  <ProgressBar.Output className="text-xs text-white/60" />
                </div>
                <ProgressBar.Track className="h-2 overflow-hidden rounded-full bg-white/10">
                  <ProgressBar.Fill className="rounded-full bg-emerald-500 transition-all duration-300" />
                </ProgressBar.Track>
              </ProgressBar>
            )}

            {!isGenerating && showGcodeResultToast && gcodeResult && (
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5 min-w-0">
                  <p className="text-sm font-medium text-emerald-400">GCode generated</p>
                  <p className="text-xs text-white/50">
                    {gcodeResult.gcode.split('\n').length.toLocaleString()} lines
                    {' · '}
                    {gcodeResult.operation_ranges.length} operation{gcodeResult.operation_ranges.length !== 1 ? 's' : ''}
                  </p>
                  {gcodeResult.warnings.length > 0 && (
                    <div className="mt-1 rounded-lg bg-yellow-500/10 px-2.5 py-2">
                      <p className="mb-0.5 text-xs font-medium text-yellow-400">Warnings</p>
                      {gcodeResult.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-yellow-200/70">{w}</p>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="flex items-center gap-2">
                    <ProgressCircle
                      aria-label="GCode generated toast auto-dismiss countdown"
                      size="sm"
                      color="success"
                      value={dismissCountdownValue}
                    >
                      <ProgressCircle.Track className="h-7 w-7">
                        <ProgressCircle.TrackCircle className="stroke-white/15" />
                        <ProgressCircle.FillCircle className="stroke-emerald-400 transition-[stroke-dashoffset] duration-100 ease-linear" />
                      </ProgressCircle.Track>
                    </ProgressCircle>
                    <Label className="text-xs text-white/55">{dismissCountdownSeconds}s</Label>
                  </div>
                  <Button
                    size="sm"
                    className="rounded-full text-[13px] text-white"
                    variant="secondary"
                    onPress={dismissGcodeResultToast}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {!isGenerating && gcodeError && (
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-red-400">Generation failed</p>
                  <p className="text-xs text-white/50">{gcodeError}</p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 rounded-full text-[13px] text-white"
                  variant="secondary"
                  onPress={onDismissGcode}
                >
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
