//! These tests say when a frame happens, in milliseconds on their runtime's own clock, and
//! `Runtime::frame` takes the seconds since the last frame. A shown spinner makes a headless
//! frame step through its loop, so a step mistaken for minutes costs minutes.

use rune::Runtime;

/// This runtime's clock, in seconds since it started.
pub fn clock<S: 'static>(runtime: &mut Runtime<S>) -> f64 {
    let mut now = 0.0;
    runtime.update_if(|_, tx| {
        now = tx.clock();
        false
    });
    now
}

pub trait FrameAt {
    /// Draws the frame when this runtime's clock reads `ms`; a time already past draws at once.
    fn frame_at(&mut self, ms: f64) -> bool;
}

impl<S: 'static> FrameAt for Runtime<S> {
    fn frame_at(&mut self, ms: f64) -> bool {
        let now = clock(self);
        self.frame((ms / 1000.0 - now).max(0.0))
    }
}
