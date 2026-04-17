//! Drift-minimizing detour pass.
//!
//! After TSP has ordered strokes, this pass reinserts each short stroke into a
//! nearby longer stroke by splitting the longer stroke at its nearest command
//! boundary — as long as some point *along* that stroke comes within
//! `cluster_radius` of the short stroke's endpoint. Proximity is tested not
//! just at command boundaries but at interior samples along each curve, so a
//! feature that happens to sit mid-arc still gets picked up.
//!
//! Each piece stays a separate [`Stroke`] so the travel between them remains a
//! rapid (G0), not a cut.
//!
//! Use case: handheld / positional-drift CNCs where returning to a distant
//! short feature later would land off-target.

use lyon_geom::Point;

use crate::turtle::Stroke;

fn dist_sq(a: Point<f64>, b: Point<f64>) -> f64 {
    let d = a - b;
    d.x * d.x + d.y * d.y
}

/// Reinsert short strokes into nearby longer strokes by splitting the longer
/// stroke at the closest command boundary. `cluster_radius` is in the same
/// units as the stroke coordinates (mm after DPI conversion).
pub fn cluster_detour(strokes: Vec<Stroke>, cluster_radius: f64) -> Vec<Stroke> {
    if cluster_radius <= 0.0 || strokes.len() < 2 {
        return strokes;
    }
    let radius_sq = cluster_radius * cluster_radius;
    let lengths: Vec<f64> = strokes.iter().map(|s| s.approx_length()).collect();
    let n = strokes.len();
    let mut consumed = vec![false; n];
    let mut result: Vec<Stroke> = Vec::with_capacity(n);

    for i in 0..n {
        if consumed[i] {
            continue;
        }
        consumed[i] = true;
        let mut pieces: Vec<Stroke> = vec![strokes[i].clone()];

        loop {
            let mut best: Option<(f64, usize, usize, usize, bool)> = None;
            // (distance_sq, j, piece_idx, cmd_idx, reverse)

            for j in 0..n {
                if consumed[j] {
                    continue;
                }
                if lengths[j] >= lengths[i] {
                    continue;
                }
                let js = &strokes[j];
                let j_start = js.start_point();
                let j_end = js.end_point();

                for (pi, piece) in pieces.iter().enumerate() {
                    // Sample boundaries + interior points. 4 samples per cmd
                    // keeps curve-to-point distance honest without blowing up
                    // cost for pathological stroke counts.
                    for (ci, p) in piece.sample_along(4) {
                        let d_start = dist_sq(p, j_start);
                        let d_end = dist_sq(p, j_end);
                        let (d, rev) = if d_start <= d_end {
                            (d_start, false)
                        } else {
                            (d_end, true)
                        };
                        if d > radius_sq {
                            continue;
                        }
                        if best.map_or(true, |(bd, ..)| d < bd) {
                            best = Some((d, j, pi, ci, rev));
                        }
                    }
                }
            }

            let Some((_, j, pi, ci, rev)) = best else {
                break;
            };

            let piece = pieces.remove(pi);
            let (first, second) = piece.split_at(ci);
            let mut short = strokes[j].clone();
            if rev {
                short.reversed();
            }

            let mut slot = pi;
            if !first.is_empty() {
                pieces.insert(slot, first);
                slot += 1;
            }
            pieces.insert(slot, short);
            slot += 1;
            if !second.is_empty() {
                pieces.insert(slot, second);
            }
            consumed[j] = true;
        }

        for p in pieces {
            if !p.is_empty() {
                result.push(p);
            }
        }
    }

    result
}
