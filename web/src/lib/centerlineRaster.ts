// Raster-based centerline backend.
//
// For hand-drawn / annulus-topology shapes where the MAT backend struggles
// with noisy boundaries or multi-loop topology, we rasterize the filled shape,
// run Zhang-Suen thinning to collapse every pen stroke to a 1-pixel spine,
// then trace the spine into polylines. The caller feeds those polylines back
// into the shared graph-based post-processor from `centerline.ts`.

export interface RasterBranch {
  points: Array<[number, number]>
  startLeaf: boolean
  endLeaf: boolean
}

export interface RasterSkeletonResult {
  branches: RasterBranch[]
  error: string | null
}

const PX_PER_MM = 10
const MAX_CANVAS_PIXELS = 4_000_000 // ~2000×2000
const PADDING_PX = 4

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function generateRasterSkeleton(
  pathData: string[],
  localBounds: Bounds,
): RasterSkeletonResult {
  if (pathData.length === 0) {
    return { branches: [], error: 'No path data supplied to raster skeleton.' }
  }

  const widthMm = Math.max(0.1, localBounds.maxX - localBounds.minX)
  const heightMm = Math.max(0.1, localBounds.maxY - localBounds.minY)

  let pxPerMm = PX_PER_MM
  let width = Math.ceil(widthMm * pxPerMm) + PADDING_PX * 2
  let height = Math.ceil(heightMm * pxPerMm) + PADDING_PX * 2

  if (width * height > MAX_CANVAS_PIXELS) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
    pxPerMm *= scale
    width = Math.ceil(widthMm * pxPerMm) + PADDING_PX * 2
    height = Math.ceil(heightMm * pxPerMm) + PADDING_PX * 2
  }

  if (width <= 0 || height <= 0) {
    return { branches: [], error: 'Raster skeleton: empty bounds.' }
  }

  // Use DOM canvas (available in the editor at runtime).
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return { branches: [], error: 'Raster skeleton: 2D canvas unavailable.' }
  }

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)

  // Map local SVG coordinates -> canvas pixels with PADDING_PX margin.
  const offsetX = -localBounds.minX * pxPerMm + PADDING_PX
  const offsetY = -localBounds.minY * pxPerMm + PADDING_PX
  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(pxPerMm, pxPerMm)
  ctx.fillStyle = '#ffffff'
  for (const d of pathData) {
    try {
      const p = new Path2D(d)
      ctx.fill(p, 'nonzero')
    } catch {
      // skip unparseable path
    }
  }
  ctx.restore()

  const imageData = ctx.getImageData(0, 0, width, height)
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) {
    // white pixels are foreground (ink)
    mask[i] = imageData.data[i * 4] > 128 ? 1 : 0
  }

  zhangSuenThin(mask, width, height)

  const rawBranches = traceSkeleton(mask, width, height, pxPerMm, offsetX, offsetY)

  // The directional-walk tracer produces one long branch per connected spine
  // plus short residue branches from the leftover edges around junction
  // knots. Drop residue shorter than ~5 px (0.5mm at 10 px/mm) AND whose end-
  // points both snap onto the interior of a longer branch — those are
  // guaranteed noise, not real features. For simplicity here we just filter
  // by length: 2mm comfortably clears pixel noise while preserving real
  // strokes (letter stems, apple leaf tips, etc.).
  const minLengthMm = 2.0
  const lengthFiltered = rawBranches.filter((b) => polylineLength(b.points) >= minLengthMm)

  // Branches whose BOTH endpoints are junction pixels (neither end is a true
  // leaf) are often Zhang-Suen noise: a short "bridge" between two nearby
  // junction pixels left over from the thinning process, or a shortcut that
  // cuts across a thick region. But we can't just length-gate them — a hollow
  // shape's skeleton (e.g. a coffee-cup handle's inner arc) is ALSO a short
  // junction-to-junction branch and is perfectly legitimate.
  //
  // Distinguish them by straightness: a Zhang-Suen bridge at a junction knot
  // is a near-straight line from one junction pixel to another, while a real
  // skeleton arc bows noticeably along its length. Drop short junction-only
  // branches whose chord/arclength ratio is near 1.
  const junctionOnlyMinLengthMm = 6.0
  const straightnessMaxLengthMm = 15.0 // only apply straightness test below this
  const maxStraightnessRatio = 0.97 // chord/arc > this → essentially straight
  const topologyFiltered = lengthFiltered.filter((b) => {
    const len = polylineLength(b.points)
    if (b.startLeaf || b.endLeaf) return true
    if (len < junctionOnlyMinLengthMm) return false
    if (len <= straightnessMaxLengthMm) {
      const start = b.points[0]
      const end = b.points[b.points.length - 1]
      const chord = Math.hypot(end[0] - start[0], end[1] - start[1])
      if (chord / len > maxStraightnessRatio) return false
    }
    return true
  })

  // Drop any branch whose geometry largely overlaps an already-kept longer
  // branch. Junction re-seeding around a noisy Y-fork occasionally produces
  // a short spur that runs parallel to the main stroke for a few mm.
  // Sorted longest-first, each branch is kept only if less than
  // `coverageRatio` of its length sits within `proximityMm` of an already-
  // kept branch.
  const overlapFiltered = dedupeOverlappingBranches(topologyFiltered, 0.8, 0.7)

  // Drop "chord" branches: very-short junction-to-junction bridges whose two
  // endpoints both project onto the SAME much-longer branch with significant
  // arclength separation. These are Zhang-Suen artifacts where the second
  // tracing pass walked an unused edge that bisects an existing loop.
  //
  // IMPORTANT: we must NOT kill legitimate cross-strokes (e.g. the top rim of
  // a coffee-cup body, or the crossbar of an 'H'), which topologically look
  // like chords too. The `maxCandidateRatio` guard keeps any branch that is
  // more than 15% of its presumed parent's length — a true cross-stroke.
  // Independent of edgeTrim, so it works at Trim=0.
  const branches = dropChordBranches(overlapFiltered, {
    chordProximityMm: 3.0,
    minSeparationRatio: 0.3,
    maxCandidateRatio: 0.15,
    maxCandidateLengthMm: 12.0,
  })

  if (branches.length === 0) {
    return { branches: [], error: 'Raster skeleton produced no lines.' }
  }

  return { branches, error: null }
}

function dedupeOverlappingBranches(
  branches: RasterBranch[],
  proximityMm: number,
  coverageRatio: number,
): RasterBranch[] {
  const withLen = branches.map((b) => ({ b, len: polylineLength(b.points) }))
  withLen.sort((a, b) => b.len - a.len)
  const kept: RasterBranch[] = []
  const keptBBoxes: Bounds[] = []

  for (const { b, len } of withLen) {
    if (kept.length === 0) {
      kept.push(b)
      keptBBoxes.push(polylineBBox(b.points, proximityMm))
      continue
    }
    const bbox = polylineBBox(b.points, proximityMm)
    let covered = 0
    for (let i = 1; i < b.points.length; i++) {
      const a = b.points[i - 1]
      const c = b.points[i]
      const segLen = Math.hypot(c[0] - a[0], c[1] - a[1])
      if (segLen === 0) continue
      const mx = (a[0] + c[0]) / 2
      const my = (a[1] + c[1]) / 2
      for (let k = 0; k < kept.length; k++) {
        const kbb = keptBBoxes[k]
        if (mx < kbb.minX || mx > kbb.maxX || my < kbb.minY || my > kbb.maxY) continue
        if (pointToPolylineDist(mx, my, kept[k].points) <= proximityMm) {
          covered += segLen
          break
        }
      }
    }
    if (covered / len < coverageRatio) {
      kept.push(b)
      keptBBoxes.push(bbox)
    }
  }
  return kept
}

interface ChordFilterOptions {
  chordProximityMm: number
  minSeparationRatio: number
  maxCandidateRatio: number
  maxCandidateLengthMm: number
}

function dropChordBranches(
  branches: RasterBranch[],
  opts: ChordFilterOptions,
): RasterBranch[] {
  const lens = branches.map((b) => polylineLength(b.points))
  const cumulative = branches.map((b) => buildArcLengths(b.points))
  const survivors: boolean[] = new Array(branches.length).fill(true)

  for (let i = 0; i < branches.length; i++) {
    const cand = branches[i]
    // Only filter junction-to-junction bridges. A leaf at either end means
    // the branch is a real protrusion, not a chord.
    if (cand.startLeaf || cand.endLeaf) continue
    if (cand.points.length < 2) continue
    const candLen = lens[i]
    if (candLen > opts.maxCandidateLengthMm) continue

    const start = cand.points[0]
    const end = cand.points[cand.points.length - 1]

    for (let j = 0; j < branches.length; j++) {
      if (j === i || !survivors[j]) continue
      const parent = branches[j]
      const parentLen = lens[j]
      // Parent must be much longer so we don't kill legitimate cross-strokes
      // (e.g. the top rim of a cup body, the crossbar of an 'H').
      if (candLen > parentLen * opts.maxCandidateRatio) continue

      const p0 = projectOntoPolyline(start[0], start[1], parent.points, cumulative[j])
      if (p0.distance > opts.chordProximityMm) continue
      const p1 = projectOntoPolyline(end[0], end[1], parent.points, cumulative[j])
      if (p1.distance > opts.chordProximityMm) continue

      const sep = Math.abs(p1.arcLength - p0.arcLength)
      if (sep >= parentLen * opts.minSeparationRatio) {
        survivors[i] = false
        break
      }
    }
  }

  return branches.filter((_, idx) => survivors[idx])
}

function buildArcLengths(points: Array<[number, number]>): number[] {
  const out = new Array(points.length)
  out[0] = 0
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    out[i] = total
  }
  return out
}

function projectOntoPolyline(
  px: number,
  py: number,
  points: Array<[number, number]>,
  cumulative: number[],
): { distance: number; arcLength: number } {
  let bestD2 = Infinity
  let bestArc = 0
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1][0]
    const ay = points[i - 1][1]
    const bx = points[i][0]
    const by = points[i][1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = 0
    if (len2 > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / len2
      if (t < 0) t = 0
      else if (t > 1) t = 1
    }
    const cx = ax + t * dx
    const cy = ay + t * dy
    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy)
    if (d2 < bestD2) {
      bestD2 = d2
      bestArc = cumulative[i - 1] + t * Math.sqrt(len2)
    }
  }
  return { distance: Math.sqrt(bestD2), arcLength: bestArc }
}

function polylineBBox(points: Array<[number, number]>, pad: number): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

function pointToPolylineDist(px: number, py: number, points: Array<[number, number]>): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1][0]
    const ay = points[i - 1][1]
    const bx = points[i][0]
    const by = points[i][1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = 0
    if (len2 > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / len2
      if (t < 0) t = 0
      else if (t > 1) t = 1
    }
    const cx = ax + t * dx
    const cy = ay + t * dy
    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy)
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

function polylineLength(points: Array<[number, number]>): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0]
    const dy = points[i][1] - points[i - 1][1]
    total += Math.hypot(dx, dy)
  }
  return total
}

// -----------------------------------------------------------------------------
// Zhang-Suen thinning
// -----------------------------------------------------------------------------

function zhangSuenThin(mask: Uint8Array, w: number, h: number): void {
  const toRemove: number[] = []
  let changed = true

  const idx = (x: number, y: number) => y * w + x

  while (changed) {
    changed = false

    for (let pass = 0; pass < 2; pass++) {
      toRemove.length = 0

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = mask[idx(x, y)]
          if (p !== 1) continue

          const p2 = mask[idx(x, y - 1)]
          const p3 = mask[idx(x + 1, y - 1)]
          const p4 = mask[idx(x + 1, y)]
          const p5 = mask[idx(x + 1, y + 1)]
          const p6 = mask[idx(x, y + 1)]
          const p7 = mask[idx(x - 1, y + 1)]
          const p8 = mask[idx(x - 1, y)]
          const p9 = mask[idx(x - 1, y - 1)]

          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (B < 2 || B > 6) continue

          // A = number of 0->1 transitions in the sequence p2..p9,p2
          let A = 0
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          for (let i = 0; i < 8; i++) {
            if (seq[i] === 0 && seq[i + 1] === 1) A += 1
          }
          if (A !== 1) continue

          if (pass === 0) {
            if (p2 * p4 * p6 !== 0) continue
            if (p4 * p6 * p8 !== 0) continue
          } else {
            if (p2 * p4 * p8 !== 0) continue
            if (p2 * p6 * p8 !== 0) continue
          }

          toRemove.push(idx(x, y))
        }
      }

      if (toRemove.length > 0) {
        for (const i of toRemove) mask[i] = 0
        changed = true
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Skeleton tracing into polylines
// -----------------------------------------------------------------------------

const NEIGHBOR_OFFSETS: Array<[number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]

function traceSkeleton(
  mask: Uint8Array,
  w: number,
  h: number,
  pxPerMm: number,
  offsetX: number,
  offsetY: number,
): RasterBranch[] {
  const idx = (x: number, y: number) => y * w + x

  // Count 8-neighbors per ink pixel.
  const degree = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[idx(x, y)] !== 1) continue
      let n = 0
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        if (mask[idx(nx, ny)] === 1) n += 1
      }
      degree[idx(x, y)] = n
    }
  }

  const pxToLocal = (px: number, py: number): [number, number] => [
    (px + 0.5 - offsetX) / pxPerMm,
    (py + 0.5 - offsetY) / pxPerMm,
  ]

  // Mark used edges between pixels to avoid walking the same segment twice.
  // Key = min(i,j)*w*h + max(i,j)
  const used = new Set<number>()
  const edgeKey = (a: number, b: number): number =>
    a < b ? a * w * h + b : b * w * h + a

  const branches: RasterBranch[] = []

  // Walk a chain from (startX, startY) in direction (firstDx, firstDy). At
  // junction pixels (degree ≥ 3) we don't stop — we pick the neighbor whose
  // direction is most collinear with the current walking direction. This lets
  // a single 1-pixel-wide ring pass through any degree-3+ pixels that Zhang-
  // Suen left behind, producing one continuous polyline instead of several
  // fragments meeting at a junction knot.
  const walk = (
    startX: number,
    startY: number,
    firstDx: number,
    firstDy: number,
  ): RasterBranch | null => {
    const points: Array<[number, number]> = [pxToLocal(startX, startY)]
    let cx = startX
    let cy = startY
    const nx0 = startX + firstDx
    const ny0 = startY + firstDy
    if (nx0 < 0 || nx0 >= w || ny0 < 0 || ny0 >= h) return null
    if (mask[idx(nx0, ny0)] !== 1) return null

    used.add(edgeKey(idx(cx, cy), idx(nx0, ny0)))
    points.push(pxToLocal(nx0, ny0))
    let lastDx = firstDx
    let lastDy = firstDy
    cx = nx0
    cy = ny0

    while (true) {
      // Gather all unused neighbor candidates.
      let bestDx = 0
      let bestDy = 0
      let bestScore = -Infinity // highest dot-product with previous direction
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const tx = cx + dx
        const ty = cy + dy
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue
        if (mask[idx(tx, ty)] !== 1) continue
        const key = edgeKey(idx(cx, cy), idx(tx, ty))
        if (used.has(key)) continue
        // Prefer the most forward direction. Normalize last direction to
        // unit-ish (diagonal has length √2, axial has length 1 — we compare
        // normalized dot products).
        const ll = Math.hypot(lastDx, lastDy) || 1
        const cl = Math.hypot(dx, dy) || 1
        const score = (lastDx * dx + lastDy * dy) / (ll * cl)
        if (score > bestScore) {
          bestScore = score
          bestDx = dx
          bestDy = dy
        }
      }
      if (bestScore === -Infinity) break
      // Require the next step to not double back (>90°). Back-turns mean we
      // hit a dead-end and should stop.
      if (bestScore < -0.1) break
      // If we're standing on a real junction pixel (degree ≥ 3), only pass
      // through when the continuation is nearly collinear (cos ≥ 0.7 ≈ 45°).
      // Zhang-Suen often leaves degree-3 artifacts along smooth rings where
      // the best continuation is ~1.0 — those should pass through seamlessly.
      // True Y-forks have continuations at ~60° off the incoming direction
      // (dot ≈ 0.5) and should split into separate branches so the geometry
      // stays honest.
      if (degree[idx(cx, cy)] >= 3 && bestScore < 0.7) break
      const tx = cx + bestDx
      const ty = cy + bestDy
      used.add(edgeKey(idx(cx, cy), idx(tx, ty)))
      points.push(pxToLocal(tx, ty))
      lastDx = bestDx
      lastDy = bestDy
      cx = tx
      cy = ty
    }

    if (points.length < 2) return null
    const startDeg = degree[idx(startX, startY)]
    const endDeg = degree[idx(cx, cy)]
    return {
      points,
      startLeaf: startDeg === 1,
      endLeaf: endDeg === 1,
    }
  }

  // First walk from every true leaf (degree === 1). Each leaf walk passes
  // through straight-through d≥3 pixels via collinear continuation, but
  // stops at real Y/T junctions thanks to the 0.7 cosine threshold above.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[idx(x, y)] !== 1) continue
      if (degree[idx(x, y)] !== 1) continue
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        if (mask[idx(nx, ny)] !== 1) continue
        if (used.has(edgeKey(idx(x, y), idx(nx, ny)))) continue
        const br = walk(x, y, dx, dy)
        if (br) branches.push(br)
      }
    }
  }

  // Second pass: walk any still-unused edges incident to junction pixels
  // (degree ≥ 3). This catches the "other" branches of a Y-fork that leaf
  // walks from the opposite side didn't visit. We walk each unused outgoing
  // edge as its own branch, terminating at leaves or at the next junction.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[idx(x, y)] !== 1) continue
      if (degree[idx(x, y)] < 3) continue
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        if (mask[idx(nx, ny)] !== 1) continue
        if (used.has(edgeKey(idx(x, y), idx(nx, ny)))) continue
        const br = walk(x, y, dx, dy)
        if (br) branches.push(br)
      }
    }
  }

  // Any remaining ink pixels are isolated loops — walk one arbitrary direction.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[idx(x, y)] !== 1) continue
      if (degree[idx(x, y)] !== 2) continue
      let handled = false
      for (const [dx, dy] of NEIGHBOR_OFFSETS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        if (mask[idx(nx, ny)] !== 1) continue
        if (used.has(edgeKey(idx(x, y), idx(nx, ny)))) continue
        const br = walk(x, y, dx, dy)
        if (br) {
          branches.push(br)
          handled = true
          break
        }
      }
      if (!handled) continue
    }
  }

  return branches
}
