//! Keeping commits off a scroll: what the core says while a viewport scrolls waits until it
//! rests, and the chat's pane, closed, stops being built, since every commit runs the whole
//! view and on a long page that costs more than a frame.

use crate::App;

/// A change to the app the core's answer or stream brought.
pub type Change = Box<dyn FnOnce(&mut App) + Send>;

/// How long a closed chat pane keeps its contents, so its close plays over them (ms).
const CLOSING: f64 = 600.0;

#[derive(Default)]
pub struct Quiet {
    held: Vec<Change>,
    /// When the chat's pane was first seen closed, and whether its contents have gone since.
    chat_closed: Option<f64>,
    chat_gone: bool,
}

impl App {
    /// Applies `change`, or holds it while a viewport scrolls; whether the view must run.
    pub fn take_change(&mut self, change: Change) -> bool {
        self.quiet.held.push(change);
        self.release_held()
    }

    /// Applies what was held, in order, once nothing scrolls; whether it applied any.
    pub fn release_held(&mut self) -> bool {
        if self.quiet.held.is_empty() || collie_desktop_chat::glide::moving() {
            return false;
        }
        for change in std::mem::take(&mut self.quiet.held) {
            change(self);
        }
        true
    }

    /// At `now` (ms): a chat pane closed a moment ago stops being built; whether that changed
    /// what the view builds.
    pub fn rest_closed_chat(&mut self, now: f64) -> bool {
        let quiet = &mut self.quiet;
        if self.nav.chat.is_open() {
            quiet.chat_closed = None;
            quiet.chat_gone = false;
            return false;
        }
        let since = *quiet.chat_closed.get_or_insert(now);
        if quiet.chat_gone || now - since < CLOSING {
            return false;
        }
        quiet.chat_gone = true;
        true
    }

    /// Whether the chat's pane is built: open, or closing still.
    pub fn chat_built(&self) -> bool {
        self.nav.chat.is_open() || !self.quiet.chat_gone
    }
}
