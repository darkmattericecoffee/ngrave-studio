//! Atomic units operated on by a turtle.

use std::mem::swap;

use lyon_geom::{CubicBezierSegment, Point, QuadraticBezierSegment, SvgArc};

use crate::Turtle;

/// Atomic unit of a [Stroke].
#[derive(Debug, Clone)]
pub enum DrawCommand {
    LineTo { from: Point<f64>, to: Point<f64> },
    Arc(SvgArc<f64>),
    CubicBezier(CubicBezierSegment<f64>),
    QuadraticBezier(QuadraticBezierSegment<f64>),
    Comment(String),
}

impl DrawCommand {
    pub fn apply(&self, turtle: &mut impl Turtle) {
        match self {
            Self::LineTo { to, .. } => turtle.line_to(*to),
            Self::Arc(arc) => turtle.arc(*arc),
            Self::CubicBezier(cbs) => turtle.cubic_bezier(*cbs),
            Self::QuadraticBezier(qbs) => turtle.quadratic_bezier(*qbs),
            Self::Comment(s) => turtle.comment(s.clone()),
        }
    }

    pub fn end_point(&self) -> Option<Point<f64>> {
        match self {
            Self::LineTo { to, .. } => Some(*to),
            Self::Arc(arc) => Some(arc.to),
            Self::CubicBezier(cbs) => Some(cbs.to),
            Self::QuadraticBezier(qbs) => Some(qbs.to),
            Self::Comment(_) => None,
        }
    }

    fn reverse(&mut self) {
        match self {
            Self::LineTo { from, to } => {
                swap(from, to);
            }
            Self::Arc(arc) => {
                swap(&mut arc.to, &mut arc.from);
                arc.flags.sweep = !arc.flags.sweep;
            }
            Self::CubicBezier(cbs) => {
                swap(&mut cbs.from, &mut cbs.to);
                swap(&mut cbs.ctrl1, &mut cbs.ctrl2);
            }
            Self::QuadraticBezier(qbs) => {
                swap(&mut qbs.from, &mut qbs.to);
            }
            Self::Comment(_) => {}
        }
    }
}

/// A continuous tool-on sequence with a known start_point.
#[derive(Debug, Clone)]
pub struct Stroke {
    pub(super) start_point: Point<f64>,
    pub(super) commands: Vec<DrawCommand>,
}

impl Stroke {
    pub fn end_point(&self) -> Point<f64> {
        self.commands
            .iter()
            .rev()
            .find_map(DrawCommand::end_point)
            .unwrap_or(self.start_point)
    }

    /// Reverses the stroke so it runs from [Self::end_point] to [Self::start_point].
    pub fn reversed(&mut self) {
        self.start_point = self.end_point();
        self.commands.reverse();
        self.commands.iter_mut().for_each(|c| c.reverse());
    }

    pub fn start_point(&self) -> Point<f64> {
        self.start_point
    }

    pub fn commands(&self) -> impl Iterator<Item = &DrawCommand> {
        self.commands.iter()
    }

    /// True if the stroke has no drawing commands (only comments or nothing).
    pub fn is_empty(&self) -> bool {
        !self.commands.iter().any(|c| c.end_point().is_some())
    }

    /// Returns the position of the pen before each drawing command, plus the
    /// final position. Length is `commands.len() + 1`. Comments carry the
    /// previous position forward.
    pub fn command_boundaries(&self) -> Vec<Point<f64>> {
        let mut pts = Vec::with_capacity(self.commands.len() + 1);
        pts.push(self.start_point);
        let mut last = self.start_point;
        for c in &self.commands {
            if let Some(p) = c.end_point() {
                last = p;
            }
            pts.push(last);
        }
        pts
    }

    /// Approximate path length using straight-line distance between command
    /// boundaries. Fast and adequate for size-based heuristics.
    pub fn approx_length(&self) -> f64 {
        let bounds = self.command_boundaries();
        bounds
            .windows(2)
            .map(|w| (w[1] - w[0]).length())
            .sum()
    }

    /// Returns sample points for proximity testing, paired with the command
    /// boundary index we would split at to isolate that location.
    ///
    /// Always emits every boundary from [`Self::command_boundaries`]. When
    /// `samples_per_cmd > 0`, additionally interpolates that many points along
    /// each drawing command. Each interior sample is paired with whichever
    /// adjacent boundary is closer in parameter space (t < 0.5 → left boundary,
    /// else right), so callers can translate a "closest sample" back into a
    /// valid `split_at` index.
    pub fn sample_along(&self, samples_per_cmd: usize) -> Vec<(usize, Point<f64>)> {
        let bounds = self.command_boundaries();
        let mut out: Vec<(usize, Point<f64>)> = bounds
            .iter()
            .enumerate()
            .map(|(i, p)| (i, *p))
            .collect();
        if samples_per_cmd == 0 {
            return out;
        }
        for (ci, c) in self.commands.iter().enumerate() {
            if c.end_point().is_none() {
                continue;
            }
            for s in 1..=samples_per_cmd {
                let t = s as f64 / (samples_per_cmd + 1) as f64;
                let pt = match c {
                    DrawCommand::LineTo { from, to } => *from + (*to - *from) * t,
                    DrawCommand::Arc(arc) => arc.to_arc().sample(t),
                    DrawCommand::CubicBezier(cbs) => cbs.sample(t),
                    DrawCommand::QuadraticBezier(qbs) => qbs.sample(t),
                    DrawCommand::Comment(_) => continue,
                };
                let bi = if t < 0.5 { ci } else { ci + 1 };
                out.push((bi, pt));
            }
        }
        out
    }

    /// Splits the stroke between command `cmd_idx-1` and `cmd_idx`. The first
    /// returned stroke keeps `commands[..cmd_idx]`, the second starts at the
    /// boundary and holds `commands[cmd_idx..]`.
    pub fn split_at(self, cmd_idx: usize) -> (Stroke, Stroke) {
        assert!(cmd_idx <= self.commands.len());
        let boundaries = self.command_boundaries();
        let split_point = boundaries[cmd_idx];
        let mut cmds = self.commands;
        let second = cmds.split_off(cmd_idx);
        (
            Stroke {
                start_point: self.start_point,
                commands: cmds,
            },
            Stroke {
                start_point: split_point,
                commands: second,
            },
        )
    }
}
