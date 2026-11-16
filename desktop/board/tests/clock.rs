//! `frame_at` keeps each runtime on its own clock, wherever the runtime lives and whatever
//! another runtime has drawn.

mod support;

use collie_desktop_board::App;
use support::clock::{FrameAt, clock};
use support::runtime;

#[test]
fn a_moved_runtime_keeps_its_steps() {
    let mut first = runtime(App::default());
    first.frame_at(300.0);
    let mut moved = Box::new(first);
    moved.frame_at(450.0);
    assert!((clock(&mut moved) - 0.45).abs() < 1e-9);
}

#[test]
fn a_runtime_steps_on_its_own_clock_beside_one_that_is_ahead_or_behind() {
    let mut ahead = runtime(App::default());
    ahead.frame_at(5000.0);
    let mut fresh = runtime(App::default());
    fresh.frame_at(100.0);
    assert!((clock(&mut fresh) - 0.1).abs() < 1e-9);
    fresh.frame(8.0);
    ahead.frame_at(5100.0);
    assert!((clock(&mut ahead) - 5.1).abs() < 1e-9);
    // A time already past draws at once.
    fresh.frame_at(200.0);
    assert!((clock(&mut fresh) - 8.1).abs() < 1e-9);
}
