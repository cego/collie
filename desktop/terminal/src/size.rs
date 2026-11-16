//! When a terminal tells herdr's controller its size (`desktop/src/shared/terminal-size.ts`).
//! Each resize redraws the agent's whole pane, so a drag or a layout change sends only the size
//! it settles at.

use std::time::Duration;

/// How long a size must hold before the pane is resized to it.
pub const SETTLE: Duration = Duration::from_millis(120);

pub type Size = (u16, u16);

/// The sizes to send, read off a clock the caller keeps: `now` is any monotonic time.
#[derive(Debug, Default)]
pub struct SettledResizes {
    sent: Option<Size>,
    pending: Option<(Size, Duration)>,
}

impl SettledResizes {
    /// A controller just opened, and refused any resize sent while it was starting.
    pub fn opened(&mut self, size: Size) -> Size {
        self.pending = None;
        self.sent = Some(size);
        size
    }

    pub fn resized(&mut self, size: Size, now: Duration) {
        self.pending = Some((size, now + SETTLE));
    }

    /// The size to send at `now`, once one has settled.
    pub fn due(&mut self, now: Duration) -> Option<Size> {
        let (size, at) = self.pending?;
        if now < at {
            return None;
        }
        self.pending = None;
        if self.sent == Some(size) {
            return None;
        }
        self.sent = Some(size);
        Some(size)
    }

    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn stop(&mut self) {
        self.pending = None;
    }
}
