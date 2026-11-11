//! Collie Desktop drawn by Rune: the app's state, and the panes the shell lays out.

pub mod board;
pub mod calls;
pub mod flow;
pub mod icons;
pub mod notify;
pub mod pages;
pub mod record;
pub mod shell;
pub mod standing;
pub mod timing;

pub use shell::view;

use collie_desktop_chat::view::{Chat, DiffTab, chat};
use collie_desktop_protocol::generated::AguiEvent;
use collie_desktop_terminal::view::Tab;
use rune::{El, col};
use rune_kit::Kit;

pub use board::Shown;
pub use record::{GoTo, LoadDiff, ReadRecord, run_diff, run_file};

#[derive(Default)]
pub struct App {
    pub machines: Vec<Shown>,
    /// Why the board stopped hearing from the core, once it has.
    pub ended: Option<String>,
    pub terminal: Option<Tab>,
    /// Counts the terminals opened, so a closed one's late frames are dropped.
    pub opened: u64,
    pub go_to: Option<GoTo>,
    pub chat: Chat,
    pub nav: shell::Nav,
    pub pages: pages::Pages,
    /// Desktop's offer to help write the Standing direction, and its dialog.
    pub standing: standing::Standing,
    /// The Desktop core, once the app has one; a test gives it a fake.
    pub core: Option<calls::Core<App>>,
    /// The open pane's Run, by installation and id.
    pub open_run: Option<(String, String)>,
    /// Reads a Run's diff from the core for the `opened`th pane, handing it to `diff_read`.
    pub load_diff: Option<LoadDiff>,
    pub diff: Option<DiffTab>,
    pub flow: Option<flow::FlowMap>,
    /// Reads a Run's record for the `opened`th pane, handing its Flow to `flow_read`; gives
    /// back what stops reading it.
    pub read_record: Option<ReadRecord>,
    stop_record: Option<Box<dyn FnOnce()>>,
    pub timing: std::cell::RefCell<timing::Timing>,
    /// The board's own state: the rest of the Flock, the selection, dialogs and answers.
    pub board: board::Board,
}

impl App {
    /// A `say` event heard at `at`; text content of the live turn starts a chat mark.
    pub fn chat_heard(&mut self, turn: u64, event: Result<AguiEvent, String>, at: f64) {
        let content = matches!(&event, Ok(AguiEvent::TextMessageContent(_)));
        if self.chat.heard(turn, event) && content {
            self.timing.get_mut().chunk(&format!("turn-{turn}"), at);
        }
    }
}

/// The marks a frame drawn at `at` ends or starts, read from the board it drew.
pub fn frame_drawn(drawn: &rune::Runtime<App>, at: f64) -> Vec<timing::Mark> {
    let board = &drawn.state;
    let mut timing = board.timing.borrow_mut();
    if board.machines.iter().any(|m| !m.cards.is_empty()) {
        timing.board_usable(at);
    }
    if let (Some(tab), Some((_, run))) = (&board.terminal, &board.open_run) {
        if let Some(keyed) = tab.keyed_at.get() {
            timing.key(run, keyed);
        }
        let since = timing.key_waiting();
        if since.is_some_and(|since| tab.shown_at.is_some_and(|shown| shown > since)) {
            tab.keyed_at.take();
            timing.echoed(at);
        }
    }
    if board.nav.chat.is_open() && board.terminal.is_none() && board.diff.is_none() {
        timing.chat_drawn(at);
    }
    // rune-kit's Diff says nothing of its scrolling, so a move of its rows is read as one.
    let rows_at = board.diff.as_ref().and_then(|_| {
        let rows = drawn
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("rows") && e.label.as_deref() == Some("Diff"))?;
        Some(rows.rect[1])
    });
    if rows_at.is_some() && timing.rows_at.is_some() && rows_at != timing.rows_at {
        timing.scrolled("diff", at);
    }
    timing.rows_at = rows_at;
    timing.frame(at);
    std::mem::take(&mut timing.marks)
}

fn chat_of(board: &mut App) -> &mut Chat {
    &mut board.chat
}

/// The Board page's pane: the open Run, else the board.
pub fn board_pane(board: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    record::view(board, k).unwrap_or_else(|| board::view_in(board, k, layer))
}

/// The chat as the window's trailing pane.
pub fn chat_pane(board: &App, k: &Kit) -> El {
    col()
        .padding(12.0)
        .grow(1.0)
        .min_h(0.0)
        .child(chat(&board.chat, chat_of, k))
}
