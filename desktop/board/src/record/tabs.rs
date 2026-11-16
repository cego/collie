//! A record's tabs, the one shown, where a jump lands, its keys, and what its Summary says:
//! a copy of `desktop/src/shared/record.ts`, which stays their owner.

use super::agents::{capital, mr_words, read_mr_ref};
use collie_desktop_protocol::generated::{
    Category, Detail, DetailMr2, Input, Kind, Outcome, Park, PendingItem, Replie,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tab {
    pub label: String,
    pub value: String,
    /// The host is still sending its part.
    pub loading: bool,
}

impl Tab {
    fn new(label: &str, value: &str) -> Tab {
        Tab {
            label: label.into(),
            value: value.into(),
            loading: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TabFacts {
    pub flow: bool,
    /// Whether the Run's details are loaded; every tab but Log, Terminal and Facts needs them.
    pub loaded: bool,
    pub plan: bool,
    pub review_text: bool,
    pub findings: bool,
    /// A followed location, which Review shows read-only where there is no diff.
    pub target: bool,
    pub diff: bool,
    pub terminal: bool,
    /// The merge request's tab label, where there is one.
    pub mr: Option<String>,
    /// A tab for each of several merge requests, in place of `mr`'s.
    pub mrs: Vec<Tab>,
    /// The parts the host is still sending: each one's tab is shown loading until it comes.
    pub pending: Vec<PendingItem>,
}

pub fn record_tabs(facts: &TabFacts) -> Vec<Tab> {
    let loaded = facts.loaded;
    let coming = |part: &PendingItem| loaded && facts.pending.contains(part);
    let mut present: Vec<(bool, Tab, Option<PendingItem>)> = vec![
        (loaded && facts.flow, Tab::new("Flow", "flow"), None),
        (loaded, Tab::new("Summary", "summary"), None),
        (
            loaded && facts.plan,
            Tab::new("Plan", "plan"),
            Some(PendingItem::Texts),
        ),
        (
            loaded && (facts.review_text || facts.findings || facts.target),
            Tab::new("Review", "review"),
            Some(PendingItem::Texts),
        ),
        (
            loaded && facts.diff,
            Tab::new("Diff", "diff"),
            Some(PendingItem::Diff),
        ),
        (loaded, Tab::new("Evidence", "evidence"), None),
        (loaded, Tab::new("Artefacts", "artefacts"), None),
        (true, Tab::new("Log", "log"), Some(PendingItem::Tail)),
        (facts.terminal, Tab::new("Terminal", "terminal"), None),
    ];
    if facts.mrs.is_empty() {
        let label = facts.mr.clone().unwrap_or_default();
        present.push((
            loaded && facts.mr.is_some(),
            Tab::new(&label, "mr"),
            Some(PendingItem::Mr),
        ));
    } else {
        present.extend(facts.mrs.iter().map(|tab| (loaded, tab.clone(), None)));
    }
    present.push((true, Tab::new("Facts", "facts"), None));
    present
        .into_iter()
        .filter_map(|(shown, tab, part)| match part {
            Some(part) if coming(&part) => Some(Tab {
                loading: true,
                ..tab
            }),
            _ => shown.then_some(tab),
        })
        .collect()
}

/// A merge request's tab label from its reference, as `links.ts`' `mrTab` words it.
pub fn mr_tab(mr: Option<&str>) -> String {
    let noun = mr
        .and_then(read_mr_ref)
        .map_or("merge request", |found| mr_words(&found).noun);
    capital(noun)
}

/// A tab per merge request where the record has several, by its MR id; none otherwise.
pub fn mr_tabs_of(mrs: Option<&Vec<DetailMr2>>) -> Vec<Tab> {
    match mrs {
        Some(mrs) if mrs.len() >= 2 => mrs
            .iter()
            .map(|one| {
                let tab = mr_tab(Some(&one.mr));
                let found = read_mr_ref(&one.mr).or_else(|| read_mr_ref(&format!("mr:{}", one.id)));
                Tab {
                    label: match found {
                        Some(found) => format!("{tab} {}", mr_words(&found).short),
                        None => tab,
                    },
                    value: format!("mr:{}", one.id),
                    loading: false,
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The chosen tab while it is present, else the first.
pub fn tab_shown(tabs: &[Tab], chosen: Option<&str>) -> String {
    tabs.iter()
        .find(|tab| Some(tab.value.as_str()) == chosen)
        .or(tabs.first())
        .map(|tab| tab.value.clone())
        .unwrap_or_else(|| "log".into())
}

/// Terminal fills the record and keeps the keys.
const UNSCROLLED: &str = "terminal";

/// The tab one step from the one shown, skipping Terminal, whose pane keeps the keys.
pub fn tab_beside(tabs: &[Tab], shown: &str, step: isize) -> Option<String> {
    let stops: Vec<&Tab> = tabs
        .iter()
        .filter(|tab| tab.value != UNSCROLLED || tab.value == shown)
        .collect();
    let at = stops.iter().position(|tab| tab.value == shown)? as isize;
    let next = at + step;
    (next >= 0)
        .then(|| stops.get(next as usize).map(|tab| tab.value.clone()))
        .flatten()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    PreviousTab,
    NextTab,
    NextFile,
    PreviousFile,
}

pub struct KeyFacts<'a> {
    /// The character typed.
    pub key: &'a str,
    pub ctrl_or_meta: bool,
    pub in_field: bool,
    pub tab: &'a str,
}

pub fn key_action(facts: &KeyFacts) -> Option<KeyAction> {
    if facts.ctrl_or_meta || facts.in_field || facts.tab == UNSCROLLED {
        return None;
    }
    let on_diff = facts.tab == "diff";
    match facts.key {
        "[" => Some(KeyAction::PreviousTab),
        "]" => Some(KeyAction::NextTab),
        "j" if on_diff => Some(KeyAction::NextFile),
        "k" if on_diff => Some(KeyAction::PreviousFile),
        _ => None,
    }
}

/// Where a finding points: a file, and a line in it as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub file: String,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Landing {
    /// A line of a file in the diff.
    Line { file: String, line: u32 },
    /// A file of the diff, as a whole.
    File { file: String },
    /// A file the diff does not show, read-only in the tab named.
    Source {
        tab: &'static str,
        file: String,
        line: Option<u32>,
    },
}

impl Landing {
    pub fn tab(&self) -> &'static str {
        match self {
            Landing::Source { tab, .. } => tab,
            _ => "diff",
        }
    }
}

/// `diff` is the paths of the diff's files, or none where the Run has no diff.
pub fn landing_of(target: &Target, diff: Option<&[String]>) -> Landing {
    let Target { file, line } = target.clone();
    match diff {
        None => Landing::Source {
            tab: "review",
            file,
            line,
        },
        Some(paths) if !paths.contains(&file) => Landing::Source {
            tab: "diff",
            file,
            line,
        },
        Some(_) => match line {
            Some(line) => Landing::Line { file, line },
            None => Landing::File { file },
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SummarySection {
    Status(String),
    Attention {
        category: Category,
        explanation: String,
    },
    Outcome(Box<Outcome>),
    Inputs(Vec<Input>),
    Replies(Vec<Replie>),
}

fn says_something(outcome: &Outcome) -> bool {
    !outcome.gaps.is_empty()
        || outcome.kind.is_some()
        || outcome.obstacle.is_some()
        || outcome.next.is_some()
        || outcome.delivered.is_some()
        || outcome.measurement.clone().flatten().is_some()
}

/// In order, each left out when it has nothing to say; the status always says something.
pub fn summary_of(detail: &Detail) -> Vec<SummarySection> {
    let mut sections = vec![SummarySection::Status(detail.status.clone())];
    if detail.attention.category != Category::None {
        sections.push(SummarySection::Attention {
            category: detail.attention.category.clone(),
            explanation: detail.attention.explanation.clone(),
        });
    }
    if says_something(&detail.outcome) {
        sections.push(SummarySection::Outcome(Box::new(detail.outcome.clone())));
    }
    if !detail.inputs.is_empty() {
        sections.push(SummarySection::Inputs(detail.inputs.clone()));
    }
    if let Some(replies) = detail.replies.clone().flatten().filter(|r| !r.is_empty()) {
        sections.push(SummarySection::Replies(replies));
    }
    sections
}

/// Whether a record's terminal is offered: while its Machine is reached, and while it is the
/// tab shown, so a dropped connection says why rather than taking the pane away.
pub fn offers_terminal(live: bool, chosen: Option<&str>) -> bool {
    live || chosen == Some("terminal")
}

/// Followed to its end unless the human scrolled up to read.
pub fn log_following(scroll_top: f32, client_height: f32, scroll_height: f32) -> bool {
    scroll_top + client_height >= scroll_height - 2.0
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    pub park: Option<String>,
    pub history: Vec<String>,
}

pub fn recovery_of(park: Option<&Park>, recovery: Option<&[String]>, limit: usize) -> Recovery {
    let history = recovery.unwrap_or_default();
    Recovery {
        park: park.map(park_line),
        history: history[history.len().saturating_sub(limit)..].to_vec(),
    }
}

/// `parkLine` in `src/park-cause.ts`.
pub fn park_line(park: &Park) -> String {
    let cause = serde_json::to_value(&park.cause)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let kind = match park.kind {
        Kind::AsksAgent => "Collie asks its agent",
        Kind::Rechecks => "Collie rechecks",
        Kind::NeedsYou => "needs you",
    };
    format!("Parked: {cause} · {kind}")
}
