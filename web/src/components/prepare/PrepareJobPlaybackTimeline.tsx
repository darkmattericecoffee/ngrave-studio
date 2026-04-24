import { useEffect, useMemo, useRef } from 'react'
import { useEditorStore } from '../../store'
import { computeCutPlan } from '../../lib/jobs'

const SPEED_OPTIONS = [0.5, 1, 2, 5] as const

interface StepEntry {
  nodeId: string
  jobId: string
  jobIndex: number
}

export function PrepareJobPlaybackTimeline() {
  const artboard = useEditorStore((s) => s.artboard)
  const nodesById = useEditorStore((s) => s.nodesById)
  const rootIds = useEditorStore((s) => s.rootIds)
  const machiningSettings = useEditorStore((s) => s.machiningSettings)
  const playback = useEditorStore((s) => s.prepareJobPlayback)
  const togglePlayback = useEditorStore((s) => s.toggleJobPlayback)
  const setPlaying = useEditorStore((s) => s.setJobPlaybackPlaying)
  const setCurrentJobIndex = useEditorStore((s) => s.setCurrentJobIndex)
  const setJobPlaybackRate = useEditorStore((s) => s.setJobPlaybackRate)
  const setJobPlaybackLoop = useEditorStore((s) => s.setJobPlaybackLoop)
  const setSelectedJob = useEditorStore((s) => s.setSelectedJob)

  const steps = useMemo<StepEntry[]>(() => {
    const { jobs } = computeCutPlan(rootIds, nodesById, machiningSettings, artboard)
    const out: StepEntry[] = []
    jobs.forEach((job, jobIndex) => {
      for (const nodeId of job.nodeIds) out.push({ nodeId, jobId: job.id, jobIndex })
    })
    return out
  }, [artboard, machiningSettings, nodesById, rootIds])

  const stepCount = steps.length
  const currentIndex = Math.min(playback.currentJobIndex, Math.max(0, stepCount - 1))

  // Reflect the current step's job into the global selectedJobId so the
  // canvas paints the highlighted job.
  useEffect(() => {
    if (stepCount === 0) return
    if (!playback.isPlaying) return
    const step = steps[currentIndex]
    if (step) setSelectedJob(step.jobId)
  }, [currentIndex, stepCount, steps, playback.isPlaying, setSelectedJob])

  // Advance one cut per tick while playing.
  const tickRef = useRef<number | null>(null)
  useEffect(() => {
    if (!playback.isPlaying || stepCount === 0) return
    const intervalMs = Math.max(120, 1000 / playback.rate)
    const id = window.setInterval(() => {
      const next = useEditorStore.getState().prepareJobPlayback.currentJobIndex + 1
      if (next >= stepCount) {
        if (useEditorStore.getState().prepareJobPlayback.loop) {
          setCurrentJobIndex(0)
        } else {
          setPlaying(false)
          setCurrentJobIndex(stepCount - 1)
        }
        return
      }
      setCurrentJobIndex(next)
    }, intervalMs)
    tickRef.current = id as unknown as number
    return () => {
      window.clearInterval(id)
      tickRef.current = null
    }
  }, [stepCount, playback.isPlaying, playback.rate, setCurrentJobIndex, setPlaying])

  const handleReset = () => {
    setPlaying(false)
    setCurrentJobIndex(0)
    if (steps[0]) setSelectedJob(steps[0].jobId)
  }

  const handleTogglePlay = () => {
    if (stepCount === 0) return
    if (!playback.isPlaying && currentIndex >= stepCount - 1) {
      setCurrentJobIndex(0)
    }
    togglePlayback()
  }

  const handleScrub = (value: number) => {
    const clamped = Math.max(0, Math.min(stepCount - 1, Math.round(value)))
    setPlaying(false)
    setCurrentJobIndex(clamped)
    const step = steps[clamped]
    if (step) setSelectedJob(step.jobId)
  }

  const currentStep = steps[currentIndex]
  const jobCount = useMemo(() => {
    const ids = new Set<string>()
    for (const s of steps) ids.add(s.jobId)
    return ids.size
  }, [steps])

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-border bg-[rgba(19,19,23,0.95)] px-4 py-2 text-white">
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/8 text-sm hover:bg-white/14 disabled:opacity-40"
        onClick={handleTogglePlay}
        disabled={stepCount === 0}
        aria-label={playback.isPlaying ? 'Pause' : 'Play'}
      >
        {playback.isPlaying ? '⏸' : '▶'}
      </button>
      <button
        type="button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/8 text-xs hover:bg-white/14 disabled:opacity-40"
        onClick={handleReset}
        disabled={stepCount === 0}
        aria-label="Reset"
      >
        ⏮
      </button>

      <div className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-1.5 overflow-hidden rounded-full">
          {steps.map((step, i) => {
            const hue = (step.jobIndex * 57) % 360
            const reached = i <= currentIndex && playback.isPlaying
            return (
              <div
                key={`${step.jobId}-${step.nodeId}-${i}`}
                className="h-full flex-1"
                style={{
                  backgroundColor: `hsl(${hue}, 75%, 55%)`,
                  opacity: reached ? 0.9 : 0.35,
                  marginRight: i < steps.length - 1 ? 1 : 0,
                }}
              />
            )
          })}
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, stepCount - 1)}
          step={1}
          value={currentIndex}
          onChange={(e) => handleScrub(Number(e.target.value))}
          disabled={stepCount === 0}
          className="relative z-10 h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
        />
      </div>

      <span className="shrink-0 text-xs tabular-nums text-white/60">
        {stepCount === 0
          ? '0 / 0'
          : `#${currentIndex + 1} / ${stepCount}${currentStep ? ` · J${currentStep.jobIndex + 1}/${jobCount}` : ''}`}
      </span>

      <button
        type="button"
        className={`flex h-6 shrink-0 items-center rounded-full border px-2 text-[11px] transition ${
          playback.loop
            ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
            : 'border-white/15 bg-white/8 text-white/50'
        }`}
        onClick={() => setJobPlaybackLoop(!playback.loop)}
      >
        Loop
      </button>

      <select
        value={playback.rate}
        onChange={(e) => setJobPlaybackRate(Number(e.target.value))}
        className="h-6 shrink-0 rounded-full border border-white/15 bg-white/8 px-2 text-[11px] text-white outline-none"
      >
        {SPEED_OPTIONS.map((speed) => (
          <option key={speed} value={speed}>
            {speed}x
          </option>
        ))}
      </select>
    </div>
  )
}
