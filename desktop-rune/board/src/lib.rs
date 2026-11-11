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

use collie_desktop_chat::host::{Done, Each, Stop};
use collie_desktop_chat::{Chat, Host};
use collie_desktop_protocol::generated::{About, AguiEvent};
use collie_desktop_terminal::view::Tab;
use rune::{El, col};
use rune_kit::Kit;
use serde_json::Value;

pub use board::Shown;
pub use record::{DiffTab, GoTo, run_diff, run_file};

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
    pub diff: Option<DiffTab>,
    pub flow: Option<flow::FlowMap>,
    stop_record: Option<Box<dyn FnOnce()>>,
    /// The open Run's record, and each Run's review comment drafts and viewed files.
    pub record: record::Records,
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

    /// Opens the chat on the core, once the app has one.
    pub fn open_chat(&mut self) {
        collie_desktop_chat::chat::open(self);
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

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl Host for App {
    fn chat(&self) -> &Chat {
        &self.chat
    }

    fn chat_mut(&mut self) -> &mut Chat {
        &mut self.chat
    }

    fn request(&self, tag: &str, payload: Value, done: Done<App>) {
        if let Some(core) = &self.core {
            core.request(
                tag,
                payload,
                move |app, answer: Result<Value, calls::CallError>| {
                    done(app, answer.map_err(|e| e.0))
                },
            );
        }
    }

    fn stream(&self, tag: &str, payload: Value, mut each: Each<App>) -> Option<Stop> {
        let core = self.core.as_ref()?;
        Some(core.stream(
            tag,
            payload,
            move |app, value: Result<Value, calls::CallError>| each(app, value.map_err(|e| e.0)),
        ))
    }

    fn heard_chunk(&mut self, turn: u64) {
        self.timing
            .get_mut()
            .chunk(&format!("turn-{turn}"), epoch_ms());
    }

    fn popped(&mut self, out: bool) {
        self.nav.chat.set_open(!out);
    }

    fn open_about(&mut self, about: &About) -> Option<String> {
        let Some(card) = self.placed_at(&about.machine, &about.task) else {
            return Some("That Task is no longer on the board".into());
        };
        let key = card.key;
        self.gesture(board::clicks::Gesture::Name(key));
        None
    }
}

/// The Board page's pane: the open Run, else the board.
pub fn board_pane(board: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    record::view(board, k).unwrap_or_else(|| board::view_in(board, k, layer))
}

/// The chat as the window's trailing pane, its menus on the window's `layer`.
pub fn chat_pane_in(board: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    col()
        .grow(1.0)
        .min_h(0.0)
        .child(collie_desktop_chat::pane::chat::<App>(
            &board.chat,
            k,
            layer,
        ))
}
