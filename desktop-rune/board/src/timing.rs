//! Desktop's own marks, as `desktopTiming` in `desktop/src/shared/record.ts` takes them, for
//! the main process's `recordMark`. That file stays their owner.

#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub name: &'static str,
    pub at: f64,
    pub card: String,
}

/// A start, and the first draw after it; no other start until that draw.
#[derive(Default)]
struct Answered {
    waiting: Option<(String, f64)>,
}

impl Answered {
    fn start(&mut self, card: &str, at: f64) -> bool {
        if self.waiting.is_some() {
            return false;
        }
        self.waiting = Some((card.into(), at));
        true
    }
}

/// A scroll with no other this long after it has ended.
const SCROLL_SETTLED_MS: f64 = 150.0;

#[derive(Default)]
pub struct Timing {
    pub marks: Vec<Mark>,
    board_drawn: bool,
    terminal: Answered,
    chat: Answered,
    scroll: Option<(String, f64)>,
    scrolls: u64,
    /// The last key and diff position the frames have seen.
    pub(crate) key_seen: f64,
    pub(crate) rows_at: Option<f32>,
}

impl Timing {
    fn mark(&mut self, name: &'static str, at: f64, card: &str) {
        self.marks.push(Mark {
            name,
            at,
            card: card.into(),
        });
    }

    pub fn board_usable(&mut self, at: f64) {
        if !std::mem::replace(&mut self.board_drawn, true) {
            self.mark("board-usable", at, "");
        }
    }

    pub fn key(&mut self, card: &str, at: f64) {
        if self.terminal.start(card, at) {
            self.mark("terminal-key", at, card);
        }
    }

    /// When the key waiting for its echo was sent.
    pub(crate) fn key_waiting(&self) -> Option<f64> {
        self.terminal.waiting.as_ref().map(|(_, at)| *at)
    }

    pub fn echoed(&mut self, at: f64) {
        if let Some((card, _)) = self.terminal.waiting.take() {
            self.mark("terminal-drawn", at, &card);
        }
    }

    pub fn chunk(&mut self, card: &str, at: f64) {
        if self.chat.start(card, at) {
            self.mark("chat-chunk", at, card);
        }
    }

    pub fn chat_drawn(&mut self, at: f64) {
        if let Some((card, _)) = self.chat.waiting.take() {
            self.mark("chat-drawn", at, &card);
        }
    }

    /// Whether this starts a scroll, whose frames are then to be watched.
    pub fn scrolled(&mut self, view: &str, at: f64) -> bool {
        if let Some((_, last)) = &mut self.scroll {
            *last = at;
            return false;
        }
        self.scrolls += 1;
        self.scroll = Some((format!("{view}:{}", self.scrolls), at));
        true
    }

    /// Whether the scroll goes on, so the next frame is watched too.
    pub fn frame(&mut self, at: f64) -> bool {
        let Some((card, last)) = self.scroll.clone() else {
            return false;
        };
        if at - last > SCROLL_SETTLED_MS {
            self.scroll = None;
            return false;
        }
        self.mark("frame", at, &card);
        true
    }
}
