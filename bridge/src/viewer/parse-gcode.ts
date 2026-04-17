import { clamp } from "../utils";
import type { OperationLineRange } from "../types";

export type MotionKind = "rapid" | "plunge" | "cut" | "retract";

export interface ParsedSegment {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  command: "G0" | "G1";
  motionKind: MotionKind;
  lineNumber: number;
  operationId: string | null;
  operationName: string | null;
  operationColor: string | null;
  feedrate: number | null;
  distance: number;
  cumulativeDistanceStart: number;
  cumulativeDistanceEnd: number;
}

export interface ParsedEvent {
  kind: "plunge" | "retract";
  lineNumber: number;
  distance: number;
  operationId: string | null;
  operationName: string | null;
  position: { x: number; y: number; z: number };
}

export interface OperationSpan {
  operationId: string;
  operationName: string;
  color: string | null;
  startDistance: number;
  endDistance: number;
}

export interface ParsedProgram {
  segments: ParsedSegment[];
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
  totalDistance: number;
  events: ParsedEvent[];
  operationSpans: OperationSpan[];
}

export interface PlaybackSample {
  distance: number;
  segmentIndex: number;
  segment: ParsedSegment | null;
  position: { x: number; y: number; z: number };
  motionKind: MotionKind;
  operationId: string | null;
}

export function parseGcodeProgram(
  gcode: string,
  operationRanges: OperationLineRange[],
): ParsedProgram {
  const operationForLine = buildOperationLineMap(operationRanges);
  let modalCommand: "G0" | "G1" | "G2" | "G3" = "G0";
  let modalFeedrate: number | null = null;
  let current = { x: 0, y: 0, z: 0 };
  let totalDistance = 0;
  const segments: ParsedSegment[] = [];
  const events: ParsedEvent[] = [];
  let bounds: ParsedProgram["bounds"] = null;

  const pushSegment = (
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
    command: "G0" | "G1",
    lineNumber: number,
    feedrate: number | null,
  ): { distance: number } => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 1.0e-9) {
      return { distance: 0 };
    }

    const operation = operationForLine.get(lineNumber) ?? null;
    const motionKind = classifyMotion(command, start, end);
    const segment: ParsedSegment = {
      start,
      end,
      command,
      motionKind,
      lineNumber,
      operationId: operation?.operation_id ?? null,
      operationName: operation?.operation_name ?? null,
      operationColor: operation?.color ?? null,
      feedrate,
      distance,
      cumulativeDistanceStart: totalDistance,
      cumulativeDistanceEnd: totalDistance + distance,
    };
    totalDistance += distance;
    segments.push(segment);

    if (motionKind === "plunge" || motionKind === "retract") {
      events.push({
        kind: motionKind,
        lineNumber,
        distance: segment.cumulativeDistanceEnd,
        operationId: segment.operationId,
        operationName: segment.operationName,
        position: end,
      });
    }

    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, segment.start.x, segment.end.x),
          minY: Math.min(bounds.minY, segment.start.y, segment.end.y),
          minZ: Math.min(bounds.minZ, segment.start.z, segment.end.z),
          maxX: Math.max(bounds.maxX, segment.start.x, segment.end.x),
          maxY: Math.max(bounds.maxY, segment.start.y, segment.end.y),
          maxZ: Math.max(bounds.maxZ, segment.start.z, segment.end.z),
        }
      : {
          minX: Math.min(segment.start.x, segment.end.x),
          minY: Math.min(segment.start.y, segment.end.y),
          minZ: Math.min(segment.start.z, segment.end.z),
          maxX: Math.max(segment.start.x, segment.end.x),
          maxY: Math.max(segment.start.y, segment.end.y),
          maxZ: Math.max(segment.start.z, segment.end.z),
        };

    return { distance };
  };

  for (const [index, rawLine] of gcode.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.split(";")[0].trim();
    if (!line) {
      continue;
    }

    const tokens = line.split(/\s+/);
    const next = { ...current };
    let hasMove = false;
    let arcR: number | null = null;
    let arcI: number | null = null;
    let arcJ: number | null = null;

    for (const token of tokens) {
      if (token === "G0" || token === "G00") {
        modalCommand = "G0";
      } else if (token === "G1" || token === "G01") {
        modalCommand = "G1";
      } else if (token === "G2" || token === "G02") {
        modalCommand = "G2";
      } else if (token === "G3" || token === "G03") {
        modalCommand = "G3";
      } else if (token.startsWith("X")) {
        next.x = Number.parseFloat(token.slice(1));
        hasMove = true;
      } else if (token.startsWith("Y")) {
        next.y = Number.parseFloat(token.slice(1));
        hasMove = true;
      } else if (token.startsWith("Z")) {
        next.z = Number.parseFloat(token.slice(1));
        hasMove = true;
      } else if (token.startsWith("F")) {
        modalFeedrate = Number.parseFloat(token.slice(1));
      } else if (token.startsWith("R")) {
        arcR = Number.parseFloat(token.slice(1));
      } else if (token.startsWith("I")) {
        arcI = Number.parseFloat(token.slice(1));
      } else if (token.startsWith("J")) {
        arcJ = Number.parseFloat(token.slice(1));
      }
    }

    if (!hasMove) {
      continue;
    }

    if (modalCommand === "G2" || modalCommand === "G3") {
      const clockwise = modalCommand === "G2";
      const arcPoints = expandArc(current, next, arcR, arcI, arcJ, clockwise);
      let segStart = current;
      for (const pt of arcPoints) {
        pushSegment(segStart, pt, "G1", lineNumber, modalFeedrate);
        segStart = pt;
      }
      current = next;
      continue;
    }

    const linearCommand: "G0" | "G1" = modalCommand === "G0" ? "G0" : "G1";
    pushSegment(current, next, linearCommand, lineNumber, modalFeedrate);
    current = next;
  }

  return {
    segments,
    bounds,
    totalDistance,
    events,
    operationSpans: buildOperationSpans(segments, operationRanges),
  };
}

export function sampleProgramAtDistance(
  program: ParsedProgram,
  requestedDistance: number,
): PlaybackSample {
  if (program.segments.length === 0) {
    return {
      distance: 0,
      segmentIndex: -1,
      segment: null,
      position: { x: 0, y: 0, z: 0 },
      motionKind: "rapid",
      operationId: null,
    };
  }

  const distance = clamp(requestedDistance, 0, program.totalDistance);
  const finalSegment = program.segments.at(-1)!;
  if (distance >= program.totalDistance) {
    return {
      distance,
      segmentIndex: program.segments.length - 1,
      segment: finalSegment,
      position: finalSegment.end,
      motionKind: finalSegment.motionKind,
      operationId: finalSegment.operationId,
    };
  }

  const segmentIndex = program.segments.findIndex(
    (segment) => distance <= segment.cumulativeDistanceEnd,
  );
  const segment = program.segments[Math.max(0, segmentIndex)];
  const spanDistance = segment.distance || 1;
  const t = clamp(
    (distance - segment.cumulativeDistanceStart) / spanDistance,
    0,
    1,
  );

  return {
    distance,
    segmentIndex,
    segment,
    position: {
      x: segment.start.x + (segment.end.x - segment.start.x) * t,
      y: segment.start.y + (segment.end.y - segment.start.y) * t,
      z: segment.start.z + (segment.end.z - segment.start.z) * t,
    },
    motionKind: segment.motionKind,
    operationId: segment.operationId,
  };
}

/**
 * Expand a G2 (clockwise) / G3 (counter-clockwise) arc into a polyline of
 * intermediate points in the XY plane (Z is linearly interpolated for helix
 * arcs, though svg2gcode does not emit those). Accepts either `R<radius>` or
 * `I<dx>` / `J<dy>` center-offset form.
 *
 * Returns the list of points ending at `end` (excluding `start`).
 */
function expandArc(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  r: number | null,
  i: number | null,
  j: number | null,
  clockwise: boolean,
): Array<{ x: number; y: number; z: number }> {
  let cx: number;
  let cy: number;

  if (i != null || j != null) {
    cx = start.x + (i ?? 0);
    cy = start.y + (j ?? 0);
  } else if (r != null) {
    // Solve for center given chord endpoints and radius (signed R convention).
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    const chordDx = end.x - start.x;
    const chordDy = end.y - start.y;
    const chordLen = Math.hypot(chordDx, chordDy);
    if (chordLen <= 1.0e-9) {
      return [end];
    }
    const absR = Math.abs(r);
    const h2 = absR * absR - (chordLen / 2) * (chordLen / 2);
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    // Perpendicular to chord (rotate chord 90°).
    const perpX = -chordDy / chordLen;
    const perpY = chordDx / chordLen;
    // R>0 takes shorter arc; R<0 takes longer arc. Clockwise flips side.
    const longArc = r < 0;
    const sideSign = clockwise === longArc ? 1 : -1;
    cx = mx + sideSign * perpX * h;
    cy = my + sideSign * perpY * h;
  } else {
    // No arc info — fall back to straight line.
    return [end];
  }

  const radius = Math.hypot(start.x - cx, start.y - cy);
  if (radius <= 1.0e-9) {
    return [end];
  }

  const startAngle = Math.atan2(start.y - cy, start.x - cx);
  const endAngle = Math.atan2(end.y - cy, end.x - cx);
  let sweep = endAngle - startAngle;
  if (clockwise) {
    if (sweep >= 0) sweep -= 2 * Math.PI;
  } else {
    if (sweep <= 0) sweep += 2 * Math.PI;
  }

  const arcLen = Math.abs(sweep) * radius;
  // Chord tolerance 0.05 mm — small enough for smooth visuals.
  const maxChord = 0.5;
  const stepCount = Math.max(4, Math.ceil(arcLen / maxChord));

  const points: Array<{ x: number; y: number; z: number }> = [];
  for (let k = 1; k <= stepCount; k += 1) {
    const t = k / stepCount;
    const a = startAngle + sweep * t;
    points.push({
      x: cx + radius * Math.cos(a),
      y: cy + radius * Math.sin(a),
      z: start.z + (end.z - start.z) * t,
    });
  }
  // Snap the last point exactly onto `end` to avoid float drift.
  points[points.length - 1] = end;
  return points;
}

function classifyMotion(
  command: "G0" | "G1",
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
): MotionKind {
  const xyDistance = Math.hypot(end.x - start.x, end.y - start.y);
  const dz = end.z - start.z;

  if (xyDistance <= 1.0e-9 && dz < 0) {
    return "plunge";
  }
  if (xyDistance <= 1.0e-9 && dz > 0) {
    return "retract";
  }
  if (command === "G0") {
    return "rapid";
  }
  return "cut";
}

function buildOperationLineMap(ranges: OperationLineRange[]) {
  const map = new Map<number, OperationLineRange>();
  for (const range of ranges) {
    for (let line = range.start_line; line <= range.end_line; line += 1) {
      map.set(line, range);
    }
  }
  return map;
}

function buildOperationSpans(
  segments: ParsedSegment[],
  ranges: OperationLineRange[],
): OperationSpan[] {
  return ranges.flatMap((range) => {
    const matchingSegments = segments.filter(
      (segment) =>
        segment.lineNumber >= range.start_line && segment.lineNumber <= range.end_line,
    );
    if (matchingSegments.length === 0) {
      return [];
    }

    return [
      {
        operationId: range.operation_id,
        operationName: range.operation_name,
        color: range.color,
        startDistance: matchingSegments[0].cumulativeDistanceStart,
        endDistance: matchingSegments.at(-1)!.cumulativeDistanceEnd,
      },
    ];
  });
}
