//! The spike's board: each Machine `flock` names, its status and its cards; pressing a card goes
//! to its pane's terminal.
//! The fold is a narrow copy of `applyItem` in `desktop/src/shared/flock.ts`, enough to
//! draw; the TypeScript stays its owner.

use base64::Engine;
pub mod flow;
pub mod notify;
pub mod timing;

use collie_desktop_chat::view::{Chat, DiffTab, chat, diff_tab};
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::generated::{
    AguiEvent, DetailFlow, Encoding, FlockItem, KeptRecord, LostState, Message, RunDetailPayload,
    RunFile, RunFilePayload, Task, TerminalPayload,
};
use collie_desktop_terminal::view::{Tab, terminal};
use rune::{Cx, El, col, row, text};
use rune_kit::{Badge, Button, Card, Kit};
use serde_json::Value;

/// A Machine as the board shows it, by herdr profile.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub installation: Option<String>,
    pub profile: String,
    pub name: String,
    pub cards: Vec<Task>,
    /// Since when its board is no longer live; `None` while it is.
    pub as_of: Option<f64>,
    pub lost: Option<LostState>,
}

impl Shown {
    pub fn status(&self) -> &'static str {
        match (&self.lost, self.as_of) {
            (Some(LostState::Unreachable), _) => "Out of reach",
            (Some(LostState::Sso), _) => "Waiting for SSO",
            (Some(LostState::NoCollie), _) => "Collie isn't installed",
            (Some(LostState::UpdateDesktop), _) => "Update Desktop",
            (None, Some(_)) => "Showing what it last said",
            (None, None) => "Live",
        }
    }

    fn label(&self) -> String {
        let cards = match self.cards.len() {
            0 => "no cards".to_string(),
            1 => "1 card".to_string(),
            n => format!("{n} cards"),
        };
        format!("{}: {}, {cards}", self.name, self.status())
    }
}

/// Opens a pane's terminal on the core, named for its Machine, as the `opened`th.
pub type GoTo = Box<dyn Fn(TerminalPayload, String, u64) -> Tab>;

#[derive(Default)]
pub struct Board {
    pub machines: Vec<Shown>,
    /// Why the board stopped hearing from the core, once it has.
    pub ended: Option<String>,
    pub terminal: Option<Tab>,
    /// Counts the terminals opened, so a closed one's late frames are dropped.
    pub opened: u64,
    pub go_to: Option<GoTo>,
    pub chat: Chat,
    pub chatting: bool,
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
}

pub type LoadDiff = Box<dyn Fn(String, String, u64)>;
pub type ReadRecord = Box<dyn Fn(String, String, u64) -> Box<dyn FnOnce()>>;

/// The cols and rows a terminal opens at, until its layout says otherwise.
const OPEN_AT: (i64, i64) = (100, 30);

impl Board {
    pub fn go_to_pane(&mut self, installation: String, run: String, machine: String) {
        let Some(go_to) = &self.go_to else { return };
        if let Some(open) = self.terminal.take() {
            open.leave();
        }
        let payload = TerminalPayload {
            installation,
            run_id: run,
            agent: None,
            cols: OPEN_AT.0,
            rows: OPEN_AT.1,
        };
        self.opened += 1;
        self.open_run = Some((payload.installation.clone(), payload.run_id.clone()));
        if let Some(stop) = self.stop_record.take() {
            stop();
        }
        self.flow = None;
        if let Some(read) = &self.read_record {
            let run = (payload.installation.clone(), payload.run_id.clone());
            self.stop_record = Some(read(run.0, run.1, self.opened));
        }
        self.terminal = Some(go_to(payload, machine, self.opened));
    }

    pub fn back(&mut self) {
        if let Some(open) = self.terminal.take() {
            open.leave();
        }
        self.open_run = None;
        self.diff = None;
    }

    pub fn show_diff(&mut self) {
        if let (Some(load), Some((installation, run))) = (&self.load_diff, &self.open_run) {
            load(installation.clone(), run.clone(), self.opened);
        }
    }

    /// A `say` event heard at `at`; text content of the live turn starts a chat mark.
    pub fn chat_heard(&mut self, turn: u64, event: Result<AguiEvent, String>, at: f64) {
        let content = matches!(&event, Ok(AguiEvent::TextMessageContent(_)));
        if self.chat.heard(turn, event) && content {
            self.timing.get_mut().chunk(&format!("turn-{turn}"), at);
        }
    }

    /// Shows a diff read for the `opened`th pane, while that pane is still the open one.
    /// The Flow of the `opened`th pane's Run, kept on the board after Back until another opens.
    pub fn flow_read(&mut self, opened: u64, read: DetailFlow) {
        if opened != self.opened {
            return;
        }
        match &mut self.flow {
            Some(map) => map.set(read),
            None => self.flow = Some(flow::FlowMap::new(read)),
        }
    }

    pub fn diff_read(&mut self, opened: u64, patch: &str) {
        if opened == self.opened && self.terminal.is_some() {
            self.diff = Some(DiffTab::new(rune_kit::diff::parse(patch)));
        }
    }

    fn at_profile(&mut self, profile: &str, name: &str) -> &mut Shown {
        let at = match self.machines.iter().position(|m| m.profile == profile) {
            Some(at) => at,
            None => {
                self.machines.push(Shown {
                    installation: None,
                    profile: profile.into(),
                    name: name.into(),
                    cards: Vec::new(),
                    as_of: None,
                    lost: None,
                });
                self.machines.len() - 1
            }
        };
        &mut self.machines[at]
    }

    pub fn apply(&mut self, item: FlockItem) {
        match item {
            FlockItem::MachineMessage(said) => {
                let machine = said.machine;
                let shown = self.at_profile(&machine.profile, &machine.name);
                shown.installation = Some(machine.installation);
                shown.name = machine.name;
                shown.as_of = None;
                shown.lost = None;
                match said.message {
                    Message::Snapshot(snapshot) => shown.cards = snapshot.tasks,
                    Message::Upsert(upsert) => {
                        match shown
                            .cards
                            .iter_mut()
                            .find(|card| card.id == upsert.task.id)
                        {
                            Some(card) => *card = upsert.task,
                            None => shown.cards.push(upsert.task),
                        }
                    }
                    Message::Remove(remove) => shown.cards.retain(|card| card.id != remove.id),
                    Message::UnknownMessage(_) => {}
                }
            }
            FlockItem::Lost(lost) => {
                let shown = self.at_profile(&lost.machine.profile, &lost.machine.name);
                shown.lost = Some(lost.state);
                shown.as_of.get_or_insert(lost.at);
            }
            FlockItem::Reconnecting(again) => {
                let shown = self.at_profile(&again.machine.profile, &again.machine.name);
                shown.as_of.get_or_insert(again.at);
            }
            FlockItem::Saved(saved) => {
                let shown = self.at_profile(&saved.machine.profile, &saved.machine.name);
                if shown.installation.is_none() {
                    shown.installation = Some(saved.machine.installation);
                    shown.cards = saved.tasks;
                    shown.as_of = Some(saved.at);
                }
            }
            FlockItem::Merged(merged) => self.machines.retain_mut(|m| {
                if m.profile == merged.machine.profile {
                    m.lost = None;
                }
                m.installation.is_some() || m.lost.is_some()
            }),
            FlockItem::Removed(removed) => self
                .machines
                .retain(|m| m.profile != removed.machine.profile),
            FlockItem::Routes(routes) => self
                .machines
                .retain(|m| routes.profiles.contains(&m.profile)),
            _ => {}
        }
    }
}

/// A large item of a Run's whole, its parts read from `offset` on as Desktop's view does.
pub fn run_file(client: &Client, installation: &str, run: &str, item: &str) -> Option<String> {
    let mut bytes = Vec::new();
    loop {
        let part: RunFile = client
            .request::<_, RunFile, Value>(
                "runFile",
                RunFilePayload {
                    installation: installation.into(),
                    run_id: run.into(),
                    r#ref: item.into(),
                    offset: Some(Some(bytes.len() as i64)),
                },
            )
            .ok()?;
        if matches!(part.encoding, Encoding::Utf8) && bytes.is_empty() {
            return Some(part.content);
        }
        let read = base64::engine::general_purpose::STANDARD
            .decode(part.content)
            .ok()?;
        let done = read.is_empty();
        bytes.extend(read);
        if done || bytes.len() as i64 >= part.size {
            return String::from_utf8(bytes).ok();
        }
    }
}

/// A Run's diff as one patch: its files from `runDetail`, each file's patch from `runFile`;
/// or why there is none.
pub fn run_diff(client: &Client, installation: &str, run: &str) -> Result<String, String> {
    let payload = RunDetailPayload {
        installation: installation.into(),
        run_id: run.into(),
    };
    // The record comes again as the host reads more of it; the diff comes after its detail.
    // ponytail: a Run with no branch waits until its record ends; show "no diff" if that bites.
    let mut records = client.stream::<_, KeptRecord, Value>("runDetail", payload);
    let files = loop {
        let kept = records
            .next()
            .ok_or("runDetail ended")?
            .map_err(|e| e.to_string())?;
        if let Some(diff) = kept.detail.and_then(|d| d.diff) {
            break diff.files;
        }
    };
    Ok(files
        .iter()
        .filter_map(|file| run_file(client, installation, run, &format!("diff:{}", file.path)))
        .collect())
}

/// The marks a frame drawn at `at` ends or starts, read from the board it drew.
pub fn frame_drawn(drawn: &rune::Runtime<Board>, at: f64) -> Vec<timing::Mark> {
    let board = &drawn.state;
    let mut timing = board.timing.borrow_mut();
    if board.machines.iter().any(|m| !m.cards.is_empty()) {
        timing.board_usable(at);
    }
    if let (Some(tab), Some((_, run))) = (&board.terminal, &board.open_run) {
        if let Some(keyed) = tab.keyed_at.filter(|keyed| *keyed > timing.key_seen) {
            timing.key_seen = keyed;
            timing.key(run, keyed);
        }
        let since = timing.key_waiting();
        if since.is_some_and(|since| tab.shown_at.is_some_and(|shown| shown > since)) {
            timing.echoed(at);
        }
    }
    timing.chat_drawn(at);
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

fn card(k: &Kit, shown: &Shown, task: &Task) -> El {
    // Card's own title neither wraps nor truncates, so the name is body text that wraps.
    let name = text(task.name.clone())
        .font(k.ty.body_medium)
        .color(k.c.text_base)
        .wrap()
        .w_full();
    let sentence = text(task.sentence.clone())
        .font(k.ty.body)
        .color(k.c.text_muted)
        .wrap()
        .max_lines(3)
        .w_full();
    let card = Card::new()
        .child(name)
        .child(sentence)
        .build(k)
        .key(format!("card-{}", task.id))
        .role("button")
        .label(task.name.clone())
        .w(280.0);
    match shown.installation.clone() {
        Some(installation) => {
            let (run, machine) = (task.run.clone(), shown.name.clone());
            card.focusable(true).on_press(move |board: &mut Board| {
                board.go_to_pane(installation.clone(), run.clone(), machine.clone())
            })
        }
        None => card,
    }
}

fn machine(k: &Kit, shown: &Shown) -> El {
    let heading = row()
        .gap(8.0)
        .center_y()
        .child(
            text(shown.name.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .a11y_hidden(),
        )
        .child(Badge::new(shown.status()).build(k));
    col()
        .key(format!("machine-{}", shown.profile))
        .role("group")
        .label(shown.label())
        .gap(8.0)
        .child(heading)
        .child(
            row()
                .flex_wrap()
                .items_start()
                .gap(8.0)
                .children(shown.cards.iter().map(|task| card(k, shown, task))),
        )
}

fn tab_of(board: &mut Board) -> Option<&mut Tab> {
    board.terminal.as_mut()
}

fn chat_of(board: &mut Board) -> &mut Chat {
    &mut board.chat
}

fn flow_of(board: &mut Board) -> &mut flow::FlowMap {
    board.flow.as_mut().expect("a Flow map")
}

fn diff_of(board: &Board) -> &DiffTab {
    board.diff.as_ref().expect("an open diff")
}

fn diff_of_mut(board: &mut Board) -> &mut DiffTab {
    board.diff.as_mut().expect("an open diff")
}

pub fn view(board: &Board, cx: &mut Cx<Board>) -> El {
    let k = Kit::neutral(cx.system_dark());
    if board.diff.is_some() {
        let back = Button::new("Back to the pane")
            .on_press(|board: &mut Board| board.diff = None)
            .build(&k)
            .key("close-diff");
        let body = col()
            .padding(16.0)
            .gap(8.0)
            .fill(k.c.bg_base)
            .child(back)
            .child(diff_tab(board, diff_of, diff_of_mut, &k));
        return rune_kit::root(body, []);
    }
    if let Some(tab) = &board.terminal {
        let back = Button::new("Back to the board")
            .on_press(Board::back)
            .build(&k)
            .key("back");
        let diff = Button::new("Diff")
            .on_press(Board::show_diff)
            .build(&k)
            .key("open-diff");
        let body = col()
            .padding(16.0)
            .gap(8.0)
            .fill(k.c.bg_base)
            .child(row().gap(8.0).child(back).child(diff))
            .children(
                board
                    .flow
                    .as_ref()
                    .map(|map| flow::flow_map(map, flow_of, &k)),
            )
            .child(terminal(tab, tab_of));
        return rune_kit::root(body, []);
    }
    let machines = board.machines.iter().map(|shown| machine(&k, shown));
    let ended = board
        .ended
        .iter()
        .map(|why| text(why.clone()).color(k.c.text_strong).role("alert"));
    let open_chat = Button::new(if board.chatting { "Close chat" } else { "Chat" })
        .on_press(|board: &mut Board| board.chatting = !board.chatting)
        .build(&k)
        .key("open-chat");
    let machines = col().gap(20.0).grow(1.0).children(ended).children(machines);
    let chat_panel = board.chatting.then(|| {
        col()
            .w(440.0)
            .self_stretch()
            .child(chat(&board.chat, chat_of, &k))
    });
    let body = col()
        .padding(16.0)
        .gap(12.0)
        .fill(k.c.bg_base)
        .child(open_chat)
        .children(
            board
                .flow
                .as_ref()
                .map(|map| flow::flow_map(map, flow_of, &k)),
        )
        .child(
            row()
                .gap(16.0)
                .items_start()
                .grow(1.0)
                .min_h(0.0)
                .child(machines)
                .children(chat_panel),
        );
    rune_kit::root(body, [])
}
