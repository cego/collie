//! An open Run's record: its tabs, read from `runDetail` as the host keeps sending it, its large
//! items read from `runFile` in parts, and the gestures sent from it on `act`.

pub mod act;
pub mod agents;
pub mod diff;
pub mod evidence;
pub mod review;
pub mod tabs;
mod view;
pub mod when;

use crate::flow::inspector::{self, PartTab, StepLog};
use crate::{App, flow};
use act::Notice;
use base64::Engine;
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::generated::{
    Detail, DetailFlow, Encoding, KeptRecord, Lane, Node, NodeRun, Review, RunDetailPayload,
    RunFile, RunFilePayload, Task, TerminalPayload, Verification,
};
use collie_desktop_terminal::view::Tab;
use review::{Anchor, Draft};
use rune::edit::TextEdit;
use serde_json::Value;
use std::collections::HashMap;
use tabs::{Landing, TabFacts};

pub use diff::DiffTab;
pub use view::view;

/// Opens a pane's terminal on the core, named for its Machine, as the `opened`th.
pub type GoTo = Box<dyn Fn(TerminalPayload, String, u64) -> Tab>;

/// The cols and rows a terminal opens at, until its layout says otherwise.
const OPEN_AT: (i64, i64) = (100, 30);

/// A large item of the record, as far as it has been read.
pub enum Item {
    Reading,
    Read(Vec<u8>),
    Image(rune::Image),
    Failed(String),
}

impl Item {
    pub fn text(&self) -> Option<String> {
        match self {
            Item::Read(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }
}

/// The form a Flow action opens, filled before it is sent.
// One form is open at a time, so its largest variant costs nothing worth a box.
#[allow(clippy::large_enum_variant)]
pub enum Form {
    /// A note, a word to an agent, or a follow-up Run's ask.
    Text {
        title: String,
        installation: String,
        write: collie_desktop_protocol::generated::ActPayloadAction,
        /// The Run resumed once the note is delivered.
        retry: Option<String>,
        /// The note this one replaces, withdrawn first.
        withdraw: Option<String>,
        edit: TextEdit,
    },
    /// A Step's open questions, each answered on its own by an option or in words, one at a time.
    Answer {
        installation: String,
        run: String,
        questions: Vec<Asked>,
        /// The question shown.
        at: usize,
    },
    /// What a Step's Start offers, asked of the Run now, and the inputs it takes.
    Offer {
        installation: String,
        run: String,
        /// The offer the Step named, by key or id.
        chosen: String,
        /// None until the Run has said what it offers.
        offer: Option<collie_desktop_protocol::generated::OffersSuccessItem>,
        fields: Vec<(String, bool, TextEdit)>,
    },
    /// A proposal waiting for a yes or a no.
    Proposal {
        installation: String,
        proposal: collie_desktop_protocol::generated::Proposal,
    },
}

/// One question of an answer form, and what was sent for it once it was.
pub struct Asked {
    pub id: String,
    pub asked: String,
    pub options: Vec<collie_desktop_protocol::generated::QuestionOption>,
    pub picked: Option<String>,
    pub edit: TextEdit,
    pub sent: Option<String>,
    /// The question as the board has it, when it does: then it is answered through the
    /// board's questionnaire, with Hold and steering, as `FlowDecision.vue` substitutes it.
    pub board: Option<collie_desktop_protocol::generated::Question>,
    /// Words for the agent instead of an answer.
    pub steer: TextEdit,
}

pub struct Record {
    pub installation: String,
    pub run: String,
    pub machine: String,
    /// The `opened` count it was opened under; answers for an earlier one are dropped.
    pub serial: u64,
    pub kept: Option<KeptRecord>,
    /// Why the record stopped coming, once it has.
    pub ended: Option<String>,
    pub chosen: Option<String>,
    pub items: HashMap<String, Item>,
    /// The plan file shown on Plan.
    pub plan_file: Option<String>,
    /// A followed location the diff does not show, read-only.
    pub source: Option<Landing>,
    /// The agent picked on Terminal.
    pub picked: Option<String>,
    /// The inspector part chosen on Flow.
    pub part: Option<flow::inspector::Part>,
    /// The span selected in a plan file, which the composer comments on.
    pub anchor: Option<Anchor>,
    pub comment: TextEdit,
    /// The draft whose words the composer is editing.
    pub editing: Option<String>,
    /// The delivery choice picked for review comments.
    pub to: Option<String>,
    pub form: Option<Form>,
    /// Whether the log was read whole, past what the record carries.
    pub whole_log: bool,
    /// Items to open aside once read.
    pub opening: Vec<String>,
    /// The run or link of the selected Step the inspector shows, by id.
    pub entry: Option<String>,
    /// The record's drawn width, which decides whether the drafts sit beside a tab or under it.
    pub width: f32,
    /// Whether the Run's active Step is chosen on Flow once its Flow is read.
    pub at_active: bool,
    /// The evidence items opened under their rows: a check's output, a kept log, a note.
    pub expanded: Vec<String>,
}

impl Record {
    fn new(installation: String, run: String, machine: String, serial: u64) -> Record {
        Record {
            installation,
            run,
            machine,
            serial,
            kept: None,
            ended: None,
            chosen: None,
            items: HashMap::new(),
            plan_file: None,
            source: None,
            picked: None,
            part: None,
            anchor: None,
            comment: TextEdit::default(),
            editing: None,
            to: None,
            form: None,
            whole_log: false,
            opening: Vec::new(),
            entry: None,
            width: 0.0,
            at_active: false,
            expanded: Vec::new(),
        }
    }

    pub fn detail(&self) -> Option<&Detail> {
        self.kept.as_ref()?.detail.as_ref()
    }

    pub fn key(&self) -> (String, String) {
        (self.installation.clone(), self.run.clone())
    }
}

/// The records Desktop holds: the open one, and each Run's review comment drafts and viewed
/// files, kept while the app runs (ADR-0051).
#[derive(Default)]
pub struct Records {
    pub open: Option<Record>,
    pub drafts: HashMap<(String, String), Vec<Draft>>,
    /// Each Run's viewed files, by path, with the tick of the change seen.
    pub viewed: HashMap<(String, String), diff::Ticks>,
    /// Counts the drafts made, for their ids.
    pub made: u64,
    pub notice: Option<Notice>,
    pub sending: bool,
    /// The agent the open terminal shows: the one asked for, then the one the core focused.
    pub terminal_agent: Option<String>,
    /// The cols and rows the last terminal was laid out at, which the next one opens at.
    pub terminal_size: Option<(u16, u16)>,
    /// What became of the files last given to the pane.
    pub terminal_said: Option<String>,
    /// The tab the record a card opens now opens on; its first tab when none.
    open_on: Option<&'static str>,
    images: Option<rune::ImageCache>,
}

impl Records {
    pub fn drafts_of(&self, record: &Record) -> &[Draft] {
        self.drafts.get(&record.key()).map_or(&[], Vec::as_slice)
    }
}

/// What the Flow's inspector shows: the Step chosen, else the Run's current one; the run or
/// link of it picked; and the part of its work shown.
pub struct StepWork<'a> {
    pub spot: flow::Spot,
    pub parent: &'a Node,
    pub node: NodeRun,
    pub lane: Option<&'a Lane>,
    /// Whether its agent's terminal can be shown.
    pub live: bool,
    pub log: StepLog,
    pub proofs: Vec<&'a Verification>,
    pub parts: Vec<PartTab>,
    pub part: inspector::Part,
}

/// What decides a record's tabs; its Flow is the last one sent, as a later record may leave it out.
fn facts_of(record: &Record, live: bool, flow: bool, mr: Option<String>) -> TabFacts {
    let Some(detail) = record.detail() else {
        return TabFacts {
            terminal: tabs::offers_terminal(live, record.chosen.as_deref()),
            ..TabFacts::default()
        };
    };
    let mrs = tabs::mr_tabs_of(detail.mrs.as_ref());
    TabFacts {
        flow,
        loaded: true,
        plan: detail.plan.is_some(),
        review_text: matches!(detail.review, Review::Text(_)),
        findings: !detail.findings.is_empty(),
        target: matches!(&record.source, Some(Landing::Source { tab: "review", .. })),
        diff: detail.diff.as_ref().is_some_and(|d| !d.files.is_empty()),
        terminal: tabs::offers_terminal(live, record.chosen.as_deref()),
        mr: detail.mr.as_ref().map(|_| tabs::mr_tab(mr.as_deref())),
        mrs,
        pending: detail.pending.clone().unwrap_or_default(),
    }
}

impl App {
    /// Goes to a Run's pane: its record, on Terminal.
    pub fn go_to_pane(&mut self, installation: String, run: String, machine: String) {
        self.open_record(installation, run, machine, Some("terminal"));
    }

    /// Opens a card's record as the gesture that opened it asked: its first tab, unless Go to
    /// pane or the Flow strip asked for another.
    pub fn open_placed(&mut self, installation: String, run: String, machine: String) {
        let tab = self.record.open_on;
        self.open_record(installation, run, machine, tab);
    }

    /// Opens a card's record on its Flow, the Run's active Step chosen, its details shown and
    /// scrolled to; the card is chosen and seen as its name opens it.
    pub fn open_card_at_flow(&mut self, key: &str) {
        self.record.open_on = Some("flow");
        self.open_card(key);
        self.record.open_on = None;
        self.show_active_step();
    }

    /// Opens a card's record on its Terminal, or shows that tab if the record is open.
    pub fn open_card_at_pane(&mut self, key: &str) {
        self.record.open_on = Some("terminal");
        self.open_card(key);
        self.record.open_on = None;
        if self.record.open.is_some() && self.record_tab() != "terminal" {
            self.show_tab("terminal");
        }
    }

    /// Shows Flow with the Run's active Step chosen, now or once the Flow is read.
    fn show_active_step(&mut self) {
        if self.record.open.is_none() {
            return;
        }
        if self.record_tab() == "diff" {
            self.diff_left();
        }
        self.show_tab("flow");
        match &mut self.flow {
            Some(map) => {
                map.open_active();
                self.step_chosen();
            }
            None => {
                if let Some(record) = &mut self.record.open {
                    record.at_active = true;
                }
            }
        }
    }

    /// Opens a Run's record on `tab`, or on its first tab.
    pub fn open_record(
        &mut self,
        installation: String,
        run: String,
        machine: String,
        tab: Option<&str>,
    ) {
        self.close_record();
        self.opened += 1;
        self.open_run = Some((installation.clone(), run.clone()));
        let mut record = Record::new(installation.clone(), run.clone(), machine, self.opened);
        record.chosen = tab.map(String::from);
        self.record.open = Some(record);
        self.record.notice = None;
        if let Some(core) = self.core.clone() {
            let serial = self.opened;
            let payload = RunDetailPayload {
                installation,
                run_id: run,
            };
            let stop = core.stream(
                "runDetail",
                payload,
                move |app: &mut App, heard: Result<KeptRecord, _>| {
                    app.record_heard(serial, heard.map_err(|e| e.to_string()))
                },
            );
            self.stop_record = Some(stop);
        }
        self.tab_opened();
    }

    /// Closes the open record and leaves its terminal.
    fn close_record(&mut self) {
        self.leave_terminal();
        if let Some(stop) = self.stop_record.take() {
            stop();
        }
        self.record.open = None;
        self.open_run = None;
        self.diff = None;
        self.flow = None;
    }

    pub fn back(&mut self) {
        self.close_record();
    }

    /// A record the host sent for the `serial`th open Run, or why it stopped.
    pub fn record_heard(&mut self, serial: u64, heard: Result<KeptRecord, String>) {
        let Some(record) = self.record.open.as_mut().filter(|r| r.serial == serial) else {
            return;
        };
        match heard {
            Ok(kept) => {
                let flow = kept.detail.as_ref().and_then(|d| d.flow.clone().flatten());
                record.kept = Some(kept);
                if let Some(flow) = flow {
                    self.flow_read(serial, flow);
                }
                self.diff_files_changed();
                self.tab_opened();
            }
            Err(why) => record.ended = Some(why),
        }
    }

    /// The Flow of the `opened`th record's Run.
    pub fn flow_read(&mut self, opened: u64, read: DetailFlow) {
        if !self.current(opened) {
            return;
        }
        let map = match &mut self.flow {
            Some(map) => {
                map.set(read);
                map
            }
            None => self.flow.insert(flow::FlowMap::new(read)),
        };
        if let Some(record) = self.record.open.as_mut().filter(|r| r.at_active) {
            record.at_active = false;
            record.part = None;
            map.open_active();
        }
    }

    /// Whether `opened` is the open record's count, or its terminal's.
    pub fn current(&self, opened: u64) -> bool {
        self.record
            .open
            .as_ref()
            .is_some_and(|r| r.serial == opened || opened == self.opened)
    }

    /// The board's card for the open record's Run, where its Machine lists it.
    pub fn task_of_record(&self) -> Option<&Task> {
        let record = self.record.open.as_ref()?;
        self.machines
            .iter()
            .filter(|m| m.machine.installation == record.installation)
            .flat_map(|m| &m.cards)
            .find(|task| {
                task.run == record.run
                    || task.runs.contains(&record.run)
                    || task
                        .children
                        .iter()
                        .any(|child| child.run.as_deref() == Some(record.run.as_str()))
            })
    }

    /// Whether the open record's Machine is reached; one the board does not list is taken as
    /// reached, so the host says why where it is not.
    pub fn record_live(&self) -> bool {
        let Some(record) = &self.record.open else {
            return false;
        };
        self.machines
            .iter()
            .find(|m| m.machine.installation == record.installation)
            .is_none_or(|m| self.is_live(m))
    }

    /// Why a gesture could not go now, sent along so the host can say so.
    pub fn unsent(&self) -> Option<String> {
        (!self.record_live()).then(|| "its Machine is out of reach".to_string())
    }

    pub fn record_tabs(&self) -> Vec<tabs::Tab> {
        let Some(record) = &self.record.open else {
            return Vec::new();
        };
        let mr = self.task_of_record().and_then(|task| task.mr.clone());
        let mut tabs = tabs::record_tabs(&facts_of(
            record,
            self.record_live(),
            self.flow.is_some(),
            mr,
        ));
        // A diff read whole, as `diff_read` hands one, is shown before the record says it has one.
        if self.diff.is_some() && !tabs.iter().any(|t| t.value == "diff") {
            let at = tabs.iter().position(|t| t.value == "log").unwrap_or(0);
            tabs.insert(
                at,
                tabs::Tab {
                    label: "Diff".into(),
                    value: "diff".into(),
                    loading: false,
                },
            );
        }
        tabs
    }

    /// The tab shown on the open record.
    pub fn record_tab(&self) -> String {
        let chosen = self.record.open.as_ref().and_then(|r| r.chosen.as_deref());
        tabs::tab_shown(&self.record_tabs(), chosen)
    }

    /// Shows `tab`; a comment box or a draft's edit open on the tab left closes, saving nothing.
    pub fn show_tab(&mut self, tab: &str) {
        if self.record_tab() != tab {
            self.close_comment();
            self.close_diff_comment();
        }
        if let Some(record) = &mut self.record.open {
            record.chosen = Some(tab.into());
        }
        self.tab_opened();
    }

    /// Shows `tab`; back on Diff, the file read last is scrolled to again.
    pub fn show_tab_tx(&mut self, tab: &str, tx: &mut rune::Tx) {
        let was = self.record_tab();
        if was == "diff" && tab != "diff" {
            self.diff_left();
        }
        self.show_tab(tab);
        if tab == "diff" && was != "diff" {
            self.diff_returned(tx);
        }
    }

    /// Reads what the tab shown needs and has not got: its terminal, its diff, its plan file.
    fn tab_opened(&mut self) {
        self.sync_pane();
        match self.record_tab().as_str() {
            "diff" => self.read_diff(),
            "plan" => self.read_plan_file(),
            "evidence" => self.read_shots(),
            _ => {}
        }
    }

    /// The Flow Step whose work the inspector shows, and which part of it.
    pub fn step_work(&self) -> Option<StepWork<'_>> {
        let record = self.record.open.as_ref()?;
        let map = self.flow.as_ref()?;
        let spot = map.selected.clone().or_else(|| {
            map.flow.current.as_ref().map(|c| flow::Spot {
                run: c.run.clone(),
                node: c.node.clone(),
            })
        })?;
        let parent = flow::node_at(&map.flow, &spot)?;
        let node = record
            .entry
            .as_ref()
            .and_then(|id| {
                inspector::entries_of(parent)
                    .into_iter()
                    .find(|e| &e.id == id)
            })
            .unwrap_or_else(|| flow::actions::as_run(parent));
        let lane = map.flow.lanes.iter().find(|l| l.run == spot.run);
        let agents = self
            .task_of_record()
            .map_or(&[][..], |t| t.agents.as_slice());
        let live = inspector::step_live(&node, self.record_live(), agents);
        let detail = record.detail();
        let starts: Vec<i64> = map
            .flow
            .lanes
            .iter()
            .flat_map(|l| &l.nodes)
            .filter_map(|n| n.log.flatten())
            .collect();
        let log = inspector::step_lines(
            detail.and_then(|d| d.tail.as_ref()),
            detail.and_then(|d| d.log_start.flatten()).unwrap_or(0),
            node.log.flatten(),
            &starts,
        );
        let checks = detail.map(|d| d.verifications.as_slice()).unwrap_or(&[]);
        let picked = record.entry.as_ref().map(|_| &node);
        let proofs = inspector::step_evidence(checks, &parent.id, picked);
        let parts = inspector::inspector_parts(&node, live, log.count, proofs.len());
        let chosen = record
            .part
            .unwrap_or_else(|| inspector::inspector_part(&node, live));
        let part = inspector::shown_part(chosen, &parts);
        Some(StepWork {
            spot,
            parent,
            node,
            lane,
            live,
            log,
            proofs,
            parts,
            part,
        })
    }

    /// The agent whose pane the Flow draws in its Step's Terminal part, while that Step works.
    pub fn step_pane(&self) -> Option<String> {
        if self.record_tab() != "flow" {
            return None;
        }
        let work = self.step_work()?;
        let drawn =
            work.part == inspector::Part::Terminal && work.live && inspector::at_work(&work.node);
        work.node.agent.flatten().filter(|_| drawn)
    }

    /// Whether a pane is shown: on the Terminal tab, or in a Flow Step's Terminal part.
    pub fn pane_shown(&self) -> bool {
        self.record.open.is_some()
            && (self.record_tab() == "terminal" || self.step_pane().is_some())
    }

    /// Holds a pane exactly while one is shown, on the agent it shows; gives it back otherwise.
    pub fn sync_pane(&mut self) {
        if self.record.open.is_some() && self.record_tab() == "terminal" {
            self.open_terminal();
            return;
        }
        let Some(agent) = self.step_pane() else {
            self.leave_terminal();
            self.record.terminal_agent = None;
            return;
        };
        let same = self.terminal.is_some()
            && self.record.terminal_agent.as_deref() == Some(agent.as_str());
        if let Some(record) = &mut self.record.open {
            record.picked = Some(agent);
        }
        if !same {
            self.attach_terminal();
        }
    }

    /// Another Step was chosen on Flow: it opens on its own part, as `StepWork.vue` does.
    pub fn step_chosen(&mut self) {
        if let Some(record) = &mut self.record.open {
            record.part = None;
        }
        self.sync_pane();
    }

    /// Shows `part` of the chosen Step's work.
    pub fn choose_part(&mut self, part: inspector::Part) {
        if let Some(record) = &mut self.record.open {
            record.part = Some(part);
        }
        self.sync_pane();
    }

    /// Shows the Step's run or link `entry`, or the Step itself again.
    pub fn choose_entry(&mut self, entry: Option<String>) {
        if let Some(record) = &mut self.record.open {
            record.entry = entry;
        }
        self.sync_pane();
    }

    /// Opens the shown record's terminal, unless one is open: an agent that starts or stops
    /// work leaves the pane shown where it is, as Desktop does.
    pub fn open_terminal(&mut self) {
        if self.terminal.is_none() {
            self.attach_terminal();
        }
    }

    /// Opens the shown record's terminal again, on the agent picked or the one at work.
    pub fn reconnect(&mut self) {
        self.attach_terminal();
    }

    /// Gives the open terminal's pane back, keeping its size for the next.
    fn leave_terminal(&mut self) {
        if let Some(open) = self.terminal.take() {
            self.record.terminal_size = Some(open.size());
            open.leave();
        }
    }

    /// Asks for the agent's own Run's pane, as `askedFor` does: an agent of a Run under the
    /// card's is found only under its own. Only while a pane is shown, so none is attached unseen.
    fn attach_terminal(&mut self) {
        if !self.pane_shown() {
            return;
        }
        let Some(record) = &self.record.open else {
            return;
        };
        if self.go_to.is_none() {
            return;
        }
        let asked = self.task_of_record().and_then(|task| {
            agents::asked_for(&task.agents, &record.run, record.picked.as_deref())
        });
        let (cols, rows) = self
            .terminal
            .as_ref()
            .map(Tab::size)
            .or(self.record.terminal_size)
            .map_or(OPEN_AT, |(cols, rows)| (cols.into(), rows.into()));
        let payload = TerminalPayload {
            installation: record.installation.clone(),
            run_id: asked
                .as_ref()
                .map_or_else(|| record.run.clone(), |tab| tab.run.clone()),
            agent: asked.as_ref().map(|tab| tab.name.clone()),
            cols,
            rows,
        };
        let machine = record.machine.clone();
        self.leave_terminal();
        self.opened += 1;
        let Some(go_to) = &self.go_to else { return };
        self.terminal = Some(go_to(payload, machine, self.opened));
        self.record.terminal_agent = asked.map(|tab| tab.name);
        self.record.terminal_said = None;
    }

    /// Switches the terminal to another of the Task's agents.
    pub fn pick_agent(&mut self, agent: String) {
        if let Some(record) = &mut self.record.open {
            record.picked = Some(agent);
        }
        self.reconnect();
    }

    /// Reads `item` of the open record once, in parts from offset 0, as `run_file` does.
    pub fn read_item(&mut self, item: &str) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        if record.items.contains_key(item) {
            return;
        }
        record.items.insert(item.into(), Item::Reading);
        let (installation, run) = (record.installation.clone(), record.run.clone());
        self.read_part(installation, run, item.to_string(), Vec::new());
    }

    /// Opens `item` under its Evidence row, read the first time, or closes it.
    pub fn toggle_evidence(&mut self, item: &str) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        if let Some(at) = record.expanded.iter().position(|one| one == item) {
            record.expanded.remove(at);
            return;
        }
        record.expanded.push(item.into());
        // One that could not be read is tried again as it is opened again.
        if matches!(record.items.get(item), Some(Item::Failed(_))) {
            self.reread_item(item);
        } else {
            self.read_item(item);
        }
    }

    /// Reads `item` again, as when the host has changed it.
    pub fn reread_item(&mut self, item: &str) {
        if let Some(record) = &mut self.record.open {
            record.items.remove(item);
        }
        self.read_item(item);
    }

    fn read_part(&mut self, installation: String, run: String, item: String, bytes: Vec<u8>) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let payload = RunFilePayload {
            installation: installation.clone(),
            run_id: run.clone(),
            r#ref: item.clone(),
            offset: Some(Some(bytes.len() as i64)),
        };
        core.request(
            "runFile",
            payload,
            move |app: &mut App, part: Result<RunFile, _>| {
                if app
                    .record
                    .open
                    .as_ref()
                    .is_none_or(|r| r.run != run || r.installation != installation)
                {
                    return;
                }
                match part_read(bytes, part.map_err(|e| e.to_string())) {
                    Part::Whole(whole) => app.item_read(&item, whole),
                    Part::More(bytes) => app.read_part(installation, run, item, bytes),
                }
            },
        );
    }

    fn item_read(&mut self, item: &str, whole: Result<Vec<u8>, String>) {
        let image = whole
            .as_ref()
            .ok()
            .filter(|_| evidence::is_image(item))
            .cloned();
        let read = match (whole, image) {
            (Err(why), _) => Item::Failed(why),
            (Ok(_), Some(bytes)) => {
                let cache = self
                    .record
                    .images
                    .get_or_insert_with(|| rune::ImageCache::new(std::sync::Arc::new(|| {})));
                let image = cache.load(bytes);
                // Decoded here, on the view's thread, so the frame after draws it.
                match image.wait() {
                    Ok(_) => Item::Image(image),
                    Err(why) => Item::Failed(format!("This image could not be read: {why}")),
                }
            }
            (Ok(bytes), None) => Item::Read(bytes),
        };
        if let Some(record) = &mut self.record.open {
            record.items.insert(item.into(), read);
        }
        if item.starts_with("diff:") {
            self.diff_part_read(item);
        }
        self.opened_aside(item);
    }
}

/// What the parts read so far come to: the whole item or why not, or its bytes to read on from.
enum Part {
    Whole(Result<Vec<u8>, String>),
    More(Vec<u8>),
}

fn part_read(mut bytes: Vec<u8>, part: Result<RunFile, String>) -> Part {
    let part = match part {
        Ok(part) => part,
        Err(why) => return Part::Whole(Err(why)),
    };
    if matches!(part.encoding, Encoding::Utf8) && bytes.is_empty() {
        return Part::Whole(Ok(part.content.into_bytes()));
    }
    let read = match base64::engine::general_purpose::STANDARD.decode(part.content) {
        Ok(read) => read,
        Err(e) => return Part::Whole(Err(format!("This part could not be decoded: {e}"))),
    };
    let done = read.is_empty();
    bytes.extend(read);
    if done || bytes.len() as i64 >= part.size {
        Part::Whole(Ok(bytes))
    } else {
        Part::More(bytes)
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
        match part_read(bytes, Ok(part)) {
            Part::Whole(whole) => return whole.ok().and_then(|b| String::from_utf8(b).ok()),
            Part::More(more) => bytes = more,
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

pub(crate) fn flow_of(board: &mut App) -> &mut flow::FlowMap {
    board.flow.as_mut().expect("a Flow map")
}
