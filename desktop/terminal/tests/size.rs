//! `test/desktop-terminal-size.test.ts`, case for case, against the Rust settling.

use collie_desktop_terminal::size::{SettledResizes, Size};
use std::time::Duration;

/// The sizes sent, as a clock that only `advance` moves reads them.
struct World {
    sizes: SettledResizes,
    now: Duration,
    sent: Vec<Size>,
}

impl World {
    fn new() -> World {
        World {
            sizes: SettledResizes::default(),
            now: Duration::ZERO,
            sent: Vec::new(),
        }
    }
    fn resized(&mut self, size: Size) {
        self.sizes.resized(size, self.now);
    }
    fn opened(&mut self, size: Size) {
        let told = self.sizes.opened(size);
        self.sent.push(told);
    }
    fn advance(&mut self, ms: u64) {
        self.now += Duration::from_millis(ms);
        self.sent.extend(self.sizes.due(self.now));
    }
}

#[test]
fn a_drag_through_many_sizes_resizes_the_pane_once_120_ms_after_it_settles() {
    let mut world = World::new();
    world.resized((80, 24));
    world.advance(40);
    world.resized((92, 24));
    world.advance(40);
    world.resized((131, 38));
    world.advance(119);
    assert_eq!(world.sent, vec![]);
    world.advance(1);
    assert_eq!(world.sent, vec![(131, 38)]);
    world.advance(500);
    assert_eq!(world.sent, vec![(131, 38)]);
}

#[test]
fn settling_back_at_the_size_the_pane_already_has_sends_nothing() {
    let mut world = World::new();
    world.opened((80, 24));
    world.resized((120, 30));
    world.advance(60);
    world.resized((80, 24));
    world.advance(500);
    assert_eq!(world.sent, vec![(80, 24)]);
}

#[test]
fn a_controller_that_opens_is_told_its_size_at_once_and_a_resize_still_settling_is_dropped() {
    let mut world = World::new();
    world.opened((80, 24));
    world.resized((100, 30));
    world.opened((100, 30));
    assert_eq!(world.sent, vec![(80, 24), (100, 30)]);
    assert!(!world.sizes.pending());
}

#[test]
fn a_terminal_that_goes_away_sends_no_resize_it_was_still_settling() {
    let mut world = World::new();
    world.resized((100, 30));
    world.sizes.stop();
    assert!(!world.sizes.pending());
    world.advance(500);
    assert_eq!(world.sent, vec![]);
}
