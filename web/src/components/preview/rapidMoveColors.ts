import * as THREE from 'three'
import type { ParsedSegment } from '@svg2gcode/bridge/viewer'

const NEAR_RAPID_COLOR = new THREE.Color(0x2f9cff)
const MID_RAPID_COLOR = new THREE.Color(0xffd166)
const FAR_RAPID_COLOR = new THREE.Color(0xff3b30)

export interface RapidMoveColorScale {
  nearMm: number
  farMm: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function segmentXyDistance(segment: ParsedSegment): number {
  return Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y)
}

export function createRapidMoveColorScale(segments: ParsedSegment[]): RapidMoveColorScale {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const segment of segments) {
    minX = Math.min(minX, segment.start.x, segment.end.x)
    minY = Math.min(minY, segment.start.y, segment.end.y)
    maxX = Math.max(maxX, segment.start.x, segment.end.x)
    maxY = Math.max(maxY, segment.start.y, segment.end.y)
  }

  const diagonal = isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0
  const nearMm = clamp(diagonal * 0.06, 3, 25)
  const farMm = Math.max(nearMm + 1, clamp(diagonal * 0.35, 15, 300))

  return { nearMm, farMm }
}

export function rapidDistanceColor(distanceMm: number, scale: RapidMoveColorScale): THREE.Color {
  const t = clamp((distanceMm - scale.nearMm) / (scale.farMm - scale.nearMm), 0, 1)

  if (t <= 0.55) {
    return NEAR_RAPID_COLOR.clone().lerp(MID_RAPID_COLOR, t / 0.55)
  }

  return MID_RAPID_COLOR.clone().lerp(FAR_RAPID_COLOR, (t - 0.55) / 0.45)
}

export function rapidDistanceCssColor(distanceMm: number, scale: RapidMoveColorScale): string {
  return `#${rapidDistanceColor(distanceMm, scale).getHexString()}`
}

export function incomingRapidDistanceForCut(
  cutSegment: ParsedSegment,
  segments: ParsedSegment[],
): number {
  let cutIndex = segments.findIndex((segment) => segment === cutSegment)
  if (cutIndex < 0) {
    cutIndex = segments.findIndex(
      (segment) =>
        segment.lineNumber === cutSegment.lineNumber &&
        Math.abs(segment.cumulativeDistanceStart - cutSegment.cumulativeDistanceStart) < 1.0e-9,
    )
  }
  if (cutIndex <= 0) return 0

  let distance = 0
  for (let i = cutIndex - 1; i >= 0; i -= 1) {
    const segment = segments[i]
    if (segment.motionKind === 'rapid') {
      distance += segmentXyDistance(segment)
    } else if (segment.motionKind === 'plunge' || segment.motionKind === 'retract') {
      continue
    } else {
      break
    }
  }

  return distance
}
