import { clamp } from "../utils";
import type { ParsedProgram, ParsedSegment } from "./parse-gcode";

const RAPID_PLAYBACK_MULTIPLIER = 6;

export function clipSegmentToDistance(
  segment: ParsedSegment,
  currentDistance: number,
): ParsedSegment | null {
  if (currentDistance <= segment.cumulativeDistanceStart) {
    return null;
  }
  if (currentDistance >= segment.cumulativeDistanceEnd) {
    return segment;
  }

  const t = clamp(
    (currentDistance - segment.cumulativeDistanceStart) / Math.max(segment.distance, 1.0e-9),
    0,
    1,
  );
  const midpoint = interpolatePoint(segment, t);

  return {
    ...segment,
    end: midpoint,
    distance: segment.distance * t,
    cumulativeDistanceEnd: currentDistance,
  };
}

export function splitSegmentAtDistance(
  segment: ParsedSegment,
  currentDistance: number,
) {
  if (currentDistance <= segment.cumulativeDistanceStart) {
    return { past: null, future: segment };
  }
  if (currentDistance >= segment.cumulativeDistanceEnd) {
    return { past: segment, future: null };
  }

  const t = clamp(
    (currentDistance - segment.cumulativeDistanceStart) / Math.max(segment.distance, 1.0e-9),
    0,
    1,
  );
  const midpoint = interpolatePoint(segment, t);

  return {
    past: {
      ...segment,
      end: midpoint,
      distance: segment.distance * t,
      cumulativeDistanceEnd: currentDistance,
    } satisfies ParsedSegment,
    future: {
      ...segment,
      start: midpoint,
      distance: segment.distance * (1 - t),
      cumulativeDistanceStart: currentDistance,
    } satisfies ParsedSegment,
  };
}

export function advanceProgramDistance(
  program: ParsedProgram,
  currentDistance: number,
  deltaSeconds: number,
  baseRateMmPerSecond: number,
): number {
  if (
    program.totalDistance <= 0 ||
    program.segments.length === 0 ||
    deltaSeconds <= 0 ||
    baseRateMmPerSecond <= 0
  ) {
    return clamp(currentDistance, 0, program.totalDistance);
  }

  let remainingSeconds = deltaSeconds;
  let distance = clamp(currentDistance, 0, program.totalDistance);
  let segmentIndex = program.segments.findIndex(
    (segment) => distance < segment.cumulativeDistanceEnd,
  );
  if (segmentIndex < 0) {
    return program.totalDistance;
  }

  while (remainingSeconds > 0 && segmentIndex < program.segments.length) {
    const segment = program.segments[segmentIndex];
    const segmentEnd = segment.cumulativeDistanceEnd;
    const remainingDistance = segmentEnd - distance;
    if (remainingDistance <= 1.0e-9) {
      segmentIndex += 1;
      distance = segmentEnd;
      continue;
    }

    const rate = playbackRateForSegment(segment, baseRateMmPerSecond);
    const segmentSeconds = remainingDistance / rate;
    if (remainingSeconds < segmentSeconds) {
      return distance + remainingSeconds * rate;
    }

    remainingSeconds -= segmentSeconds;
    distance = segmentEnd;
    segmentIndex += 1;
  }

  return clamp(distance, 0, program.totalDistance);
}

function playbackRateForSegment(
  segment: ParsedSegment,
  baseRateMmPerSecond: number,
): number {
  if (
    segment.motionKind === "rapid" ||
    (segment.motionKind === "retract" && segment.command === "G0")
  ) {
    return baseRateMmPerSecond * RAPID_PLAYBACK_MULTIPLIER;
  }

  return baseRateMmPerSecond;
}

function interpolatePoint(segment: ParsedSegment, t: number) {
  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * t,
    y: segment.start.y + (segment.end.y - segment.start.y) * t,
    z: segment.start.z + (segment.end.z - segment.start.z) * t,
  };
}
