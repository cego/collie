//! A notched mouse wheel's line steps glide to where they land, as a browser smooths them;
//! a touchpad's precise deltas still scroll the content 1:1 under the fingers.

use rune::{El, ScrollPos, Spring, Tx, WheelEvent};
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

/// How a step eases to its place: quick enough that a spun wheel keeps up with the hand.
pub const SPRING: Spring = Spring::new(0.2, 0.0);
/// A step this long after the last starts from where the view is, not where it was going.
const SETTLED: f64 = 0.4;
/// A viewport whose offset moved this recently is still being scrolled.
const STILL: f64 = 0.15;

/// One viewport's wheel glide: where it is, how far it scrolls, and where a glide is going.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Glide {
    offset: f32,
    max: f32,
    target: Option<(f32, f64)>,
}

impl Glide {
    /// The viewport is at `offset` of `max`.
    pub fn scrolled(&mut self, offset: f32, max: f32) {
        self.offset = offset;
        self.max = max;
    }

    /// A line step of `dy` points (positive moves the content down) at `now` seconds: the
    /// offset to glide to, or None where the view is already at that end. Steps that come while
    /// a glide is underway add up from where it is going, so a spun wheel goes the whole way.
    pub fn step(&mut self, dy: f32, now: f64) -> Option<f32> {
        let from = match self.target {
            Some((to, at)) if now - at < SETTLED && (to - self.offset).abs() > 0.5 => to,
            _ => self.offset,
        };
        let to = (from - dy).clamp(0.0, self.max.max(0.0));
        if (to - from).abs() < 0.01 {
            return None;
        }
        self.target = Some((to, now));
        Some(to)
    }

    /// A step's glide hasn't landed yet.
    pub fn gliding(&self) -> bool {
        self.target
            .is_some_and(|(to, _)| (to - self.offset).abs() > 0.5)
    }

    /// The hand took over (a touchpad, a drag): the next step starts where the view is.
    pub fn held(&mut self) {
        self.target = None;
    }
}

thread_local! {
    static GLIDES: RefCell<HashMap<String, Glide>> = RefCell::new(HashMap::new());
    static MOVED: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
}

/// Whether a viewport `smooth` made moved within the last moment: a hand, a fling or a glide
/// is scrolling it, and a commit now would cost its frames.
pub fn moving() -> bool {
    MOVED.with(|m| m.get().is_some_and(|at| seconds() - at < STILL))
}

fn with<T>(key: &str, f: impl FnOnce(&mut Glide) -> T) -> T {
    GLIDES.with(|all| f(all.borrow_mut().entry(key.to_string()).or_default()))
}

fn seconds() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

/// Makes the scroll viewport `scroller`, keyed `key`, glide its mouse-wheel steps. The step
/// runs no view: it asks for the glide and says `live_only`.
pub fn smooth<S: 'static>(scroller: El, key: &str) -> El {
    let (seen, wheel) = (key.to_string(), key.to_string());
    scroller
        .on_scroll_offset(move |at: ScrollPos| {
            // A hand or its momentum, or one of this module's glides; never the end followed
            // as content grows, nor an anchor holding the view.
            let (by_hand, _, _) = rune::scroll_watch_state();
            let moved = with(&seen, |g| {
                let gliding = g.gliding() && (g.offset - at.offset[1]).abs() > 0.01;
                g.scrolled(at.offset[1], at.max[1]);
                by_hand || gliding
            });
            if moved {
                MOVED.with(|m| m.set(Some(seconds())));
            }
        })
        .on_wheel(move |_: &mut S, e: WheelEvent, tx: &mut Tx| {
            let line = !e.precise && e.dx == 0.0 && e.dy != 0.0;
            let plain = !(e.mods.cmd || e.mods.ctrl || e.mods.alt || e.mods.shift);
            if !line || !plain {
                with(&wheel, Glide::held);
                return false;
            }
            let Some(to) = with(&wheel, |g| g.step(e.dy, seconds())) else {
                return false;
            };
            tx.scroll_to_with(wheel.clone(), 0.0, to, SPRING);
            tx.live_only();
            true
        })
}
