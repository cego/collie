//! An open Run: its pane's terminal, its Flow map and its diff.

use crate::{App, flow};
use base64::Engine;
use collie_desktop_chat::view::{DiffTab, diff_tab};
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::generated::{
    DetailFlow, Encoding, KeptRecord, RunDetailPayload, RunFile, RunFilePayload, TerminalPayload,
};
use collie_desktop_terminal::view::{Tab, terminal};
use rune::{El, col, row};
use rune_kit::{Button, Kit};
use serde_json::Value;

/// Opens a pane's terminal on the core, named for its Machine, as the `opened`th.
pub type GoTo = Box<dyn Fn(TerminalPayload, String, u64) -> Tab>;

pub type LoadDiff = Box<dyn Fn(String, String, u64)>;
pub type ReadRecord = Box<dyn Fn(String, String, u64) -> Box<dyn FnOnce()>>;

/// The cols and rows a terminal opens at, until its layout says otherwise.
const OPEN_AT: (i64, i64) = (100, 30);

impl App {
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

    /// Shows a diff read for the `opened`th pane, while that pane is still the open one.
    pub fn diff_read(&mut self, opened: u64, patch: &str) {
        if opened == self.opened && self.terminal.is_some() {
            self.diff = Some(DiffTab::new(rune_kit::diff::parse(patch)));
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

fn tab_of(board: &mut App) -> Option<&mut Tab> {
    board.terminal.as_mut()
}

pub(crate) fn flow_of(board: &mut App) -> &mut flow::FlowMap {
    board.flow.as_mut().expect("a Flow map")
}

fn diff_of(board: &App) -> &DiffTab {
    board.diff.as_ref().expect("an open diff")
}

fn diff_of_mut(board: &mut App) -> &mut DiffTab {
    board.diff.as_mut().expect("an open diff")
}

/// The open Run: its diff, else its pane; none while no Run is open.
pub fn view(board: &App, k: &Kit) -> Option<El> {
    if board.diff.is_some() {
        let back = Button::new("Back to the pane")
            .on_press(|board: &mut App| board.diff = None)
            .build(k)
            .key("close-diff");
        return Some(
            col()
                .padding(16.0)
                .gap(8.0)
                .grow(1.0)
                .min_h(0.0)
                .child(back)
                .child(diff_tab(board, diff_of, diff_of_mut, k)),
        );
    }
    if let Some(tab) = &board.terminal {
        let back = Button::new("Back to the board")
            .on_press(App::back)
            .build(k)
            .key("back");
        let diff = Button::new("Diff")
            .on_press(App::show_diff)
            .build(k)
            .key("open-diff");
        return Some(
            col()
                .padding(16.0)
                .gap(8.0)
                .grow(1.0)
                .min_h(0.0)
                .child(row().gap(8.0).child(back).child(diff))
                .children(
                    board
                        .flow
                        .as_ref()
                        .map(|map| flow::flow_map(map, flow_of, k)),
                )
                .child(terminal(tab, tab_of)),
        );
    }
    None
}
