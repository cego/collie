//! These tests say when a frame happens, in milliseconds from their runtime's start, and
//! `Runtime::frame` takes the seconds since the last frame. A shown spinner makes a headless
//! frame step through its loop, so a step mistaken for minutes costs minutes.

use rune::Runtime;
use std::cell::Cell;

thread_local! {
    /// The runtime that last drew by `frame_at`, and the `ms` it drew at.
    static LAST: Cell<(usize, f64)> = const { Cell::new((0, 0.0)) };
}

pub trait FrameAt {
    /// Draws the frame at `ms`, stepping by the time since the last `frame_at` on this
    /// runtime, so frames drawn by plain `frame` between them don't shift the steps a test
    /// names. A time already past draws at once.
    fn frame_at(&mut self, ms: f64) -> bool;
}

impl<S: 'static> FrameAt for Runtime<S> {
    fn frame_at(&mut self, ms: f64) -> bool {
        let this = self as *const Self as usize;
        let (runtime, last) = LAST.replace((this, ms));
        let since = if runtime == this { last } else { 0.0 };
        self.frame(((ms - since) / 1000.0).max(0.0))
    }
}
