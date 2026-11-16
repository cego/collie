//! These tests say when a frame happens, in milliseconds from their runtime's start, and
//! `Runtime::frame` takes the seconds since the last frame. A shown spinner makes a headless
//! frame step through its loop, so a step mistaken for minutes costs minutes.

use rune::Runtime;
use std::cell::Cell;

thread_local! {
    /// The `ms` this test thread last drew at by `frame_at`, and its runtime's clock after.
    static LAST: Cell<(f64, f64)> = const { Cell::new((0.0, 0.0)) };
}

pub trait FrameAt {
    /// Draws the frame at `ms`, stepping by the time since the last `frame_at`, so frames drawn
    /// by plain `frame` between them don't shift the steps a test names. A time already past
    /// draws at once. A runtime whose clock is behind the last one's is a new runtime, and
    /// steps from its start; a runtime moved to another place keeps its clock and its steps.
    fn frame_at(&mut self, ms: f64) -> bool;
}

fn clock<S: 'static>(runtime: &mut Runtime<S>) -> f64 {
    let mut now = 0.0;
    runtime.update_if(|_, tx| {
        now = tx.clock();
        false
    });
    now
}

impl<S: 'static> FrameAt for Runtime<S> {
    fn frame_at(&mut self, ms: f64) -> bool {
        let (last, then) = LAST.get();
        let since = if clock(self) >= then { last } else { 0.0 };
        let drew = self.frame(((ms - since) / 1000.0).max(0.0));
        LAST.set((ms, clock(self)));
        drew
    }
}
