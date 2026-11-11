//! How long a toast stays: five seconds, as Nuxt UI's Toaster keeps today's, held while the
//! pointer is on it.

use crate::App;

pub const TOAST_MS: f64 = 5_000.0;

/// When a toast was first drawn, and whether the pointer holds it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Shown {
    since: Option<f64>,
    held: bool,
}

impl Shown {
    /// Whether it has stayed its time by `now`; the first ask starts the time.
    pub fn over(&mut self, now: f64) -> bool {
        let since = *self.since.get_or_insert(now);
        !self.held && now - since >= TOAST_MS
    }

    /// Held while the pointer is on it, then a full time again from when it leaves.
    pub fn hold(&mut self, held: bool) {
        self.held = held;
        if !held {
            self.since = None;
        }
    }
}

impl App {
    /// Takes down every toast whose time is over; whether any went.
    pub fn expire_toasts(&mut self, now: f64) -> bool {
        let notices = self.board.notices.len();
        self.board.notices.retain_mut(|n| !n.shown.over(now));
        let gone = notices != self.board.notices.len();
        let pages = [
            &mut self.pages.machines.told,
            &mut self.pages.schedules.told,
            &mut self.standing.told,
        ]
        .map(|told| told.expire(now));
        gone || pages.contains(&true)
    }

    pub fn hold_notice(&mut self, id: u64, held: bool) {
        if let Some(n) = self.board.notices.iter_mut().find(|n| n.id == id) {
            n.shown.hold(held);
        }
    }
}
