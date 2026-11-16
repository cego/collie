//! The Clean up dialog: what a sweep would remove on each connected Machine, read on its own,
//! and each chosen Machine's sweep. A port of `desktop/src/shared/machine-cleanup.ts` and
//! `useCleanup`; the state lives on the Machines page, so a sweep outlives the dialog.

use super::clock::human_bytes;
use super::common::{Tone, muted, request_id, toned};
use super::flock::{MachineRow, RowState};
use crate::App;
use collie_desktop_protocol::generated::{
    CleanupSuccess, CleanupSuccessReport, KeepItem, LostState, SweepPayload,
};
use rune::{El, col, text};
use rune_kit::{Button, ButtonVariant, Checkbox, Collapsible, ControlSize, Dialog, Kit, Spinner};
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub type Report = CleanupSuccessReport;

/// One Machine's listing: out since a time in milliseconds, listed, or failed.
#[derive(Debug, Clone, PartialEq)]
pub enum Read {
    Reading {
        since: f64,
    },
    Listed {
        installation: String,
        report: Report,
    },
    Failed {
        problem: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Sweep {
    Running { request: String },
    Done { report: Report },
    Failed { request: String, reason: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub target: String,
    pub size: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub kind: String,
    pub count: usize,
    pub size: String,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub said: String,
    pub items: Vec<KeepItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowView {
    pub profile: String,
    pub name: String,
    pub said: String,
    /// That its host still sweeps where Desktop can't reach it.
    pub note: Option<String>,
    /// Why its sweep failed.
    pub reason: Option<String>,
    pub try_again: bool,
    pub read_again: bool,
    /// That `said` is why it can't be chosen or wasn't cleaned.
    pub warn: bool,
    pub choosable: bool,
    pub chosen: bool,
    pub bytes: f64,
    pub groups: Vec<Group>,
    pub kept: Option<Kept>,
    /// Its listing is still out.
    pub reading: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub rows: Vec<RowView>,
    pub choosable: Vec<String>,
    /// `2 Machines chosen · would free 4.1 GiB`.
    pub chosen: String,
    pub button: String,
    pub disabled: bool,
}

pub const UPGRADE_SAID: &str = "Can't list what it would clean up; upgrade this Machine.";
const STILL_SWEPT: &str = "Its host still cleans up there every ten minutes.";

fn groups_of(report: &Report) -> Vec<Group> {
    let mut by_kind: Vec<(
        String,
        f64,
        Vec<&collie_desktop_protocol::generated::RemoveItem>,
    )> = Vec::new();
    for item in &report.remove {
        match by_kind.iter_mut().find(|(kind, _, _)| *kind == item.kind) {
            Some((_, bytes, items)) => {
                *bytes += item.bytes;
                items.push(item);
            }
            None => by_kind.push((item.kind.clone(), item.bytes, vec![item])),
        }
    }
    // Stable sorts, largest first, as the TypeScript's.
    by_kind.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    by_kind
        .into_iter()
        .map(|(kind, bytes, mut items)| {
            items.sort_by(|a, b| b.bytes.partial_cmp(&a.bytes).unwrap());
            Group {
                kind,
                count: items.len(),
                size: human_bytes(bytes),
                items: items
                    .into_iter()
                    .map(|i| Item {
                        target: i.target.clone(),
                        size: human_bytes(i.bytes),
                        reason: i.reason.clone(),
                    })
                    .collect(),
            }
        })
        .collect()
}

fn kept_of(keep: &[KeepItem]) -> Option<Kept> {
    (!keep.is_empty()).then(|| Kept {
        said: format!("Kept {}", keep.len()),
        items: keep.to_vec(),
    })
}

fn row_of(
    shown: &MachineRow,
    read: Option<&Read>,
    sweep: Option<&Sweep>,
    now: f64,
    readable: bool,
) -> RowView {
    let base = |said: String| RowView {
        profile: shown.profile.clone(),
        name: shown.name.clone(),
        said,
        note: None,
        reason: None,
        try_again: false,
        read_again: false,
        warn: true,
        choosable: false,
        chosen: false,
        bytes: 0.0,
        groups: vec![],
        kept: None,
        reading: false,
    };
    match sweep {
        Some(Sweep::Running { .. }) => {
            let said = if shown.state.is_live() {
                "Cleaning…".to_string()
            } else {
                format!("Cleaning… waiting for {} to reconnect", shown.name)
            };
            return RowView {
                warn: false,
                reading: true,
                ..base(said)
            };
        }
        Some(Sweep::Failed { reason, .. }) => {
            return RowView {
                reason: Some(reason.clone()),
                try_again: true,
                ..base("Not cleaned".into())
            };
        }
        Some(Sweep::Done { report }) => {
            let said = if report.remove.is_empty() {
                "Nothing removed".into()
            } else {
                format!("Freed {}", human_bytes(report.bytes))
            };
            return RowView {
                groups: groups_of(report),
                kept: kept_of(&report.keep),
                warn: false,
                ..base(said)
            };
        }
        None => {}
    }
    if !shown.state.is_live() {
        let word = shown.state.said();
        let said = match &shown.reason {
            None => word.to_string(),
            Some(why) => format!("{word}: {why}"),
        };
        let still = matches!(
            shown.state,
            RowState::NotLive(LostState::Unreachable | LostState::Sso)
        );
        return RowView {
            note: still.then(|| STILL_SWEPT.to_string()),
            ..base(said)
        };
    }
    match read {
        Some(Read::Reading { since }) => RowView {
            reading: true,
            ..base(format!(
                "Reading… {} s",
                ((now - since) / 1000.0).floor().max(0.0)
            ))
        },
        None => RowView {
            read_again: readable,
            ..base("It wasn't connected when Cleanup read.".into())
        },
        Some(Read::Failed { problem }) => RowView {
            read_again: readable,
            ..base(problem.clone())
        },
        Some(Read::Listed { report, .. }) => {
            let said = if report.remove.is_empty() {
                "Nothing to remove now".into()
            } else {
                format!("Would free {}", human_bytes(report.bytes))
            };
            RowView {
                choosable: true,
                warn: false,
                groups: groups_of(report),
                kept: kept_of(&report.keep),
                bytes: report.bytes,
                ..base(said)
            }
        }
    }
}

/// The dialog over the Machines page's rows, joined to their reads and sweeps by profile.
/// `chosen` `None` chooses every Machine that can be; once any is swept, the choice is fixed.
pub fn cleanup_view(
    shown: &[MachineRow],
    reads: &HashMap<String, Read>,
    chosen: Option<&HashSet<String>>,
    sweeps: &HashMap<String, Sweep>,
    now: f64,
) -> View {
    let swept = !sweeps.is_empty();
    let rows: Vec<RowView> = shown
        .iter()
        .map(|one| {
            let read = reads.get(&one.profile);
            let listed = row_of(one, read, None, now, !swept);
            let row = row_of(one, read, sweeps.get(&one.profile), now, !swept);
            let picked = if swept {
                sweeps.contains_key(&one.profile)
            } else {
                listed.choosable && chosen.is_none_or(|c| c.contains(&one.profile))
            };
            RowView {
                choosable: !swept && row.choosable,
                chosen: picked,
                bytes: listed.bytes,
                ..row
            }
        })
        .collect();
    let picked: Vec<&RowView> = rows.iter().filter(|r| r.chosen).collect();
    let total = picked.iter().fold(0.0, |sum, r| sum + r.bytes);
    let machines = format!(
        "{} Machine{}",
        picked.len(),
        if picked.len() == 1 { "" } else { "s" }
    );
    View {
        choosable: rows
            .iter()
            .filter(|r| r.choosable)
            .map(|r| r.profile.clone())
            .collect(),
        chosen: format!("{machines} chosen · would free {}", human_bytes(total)),
        button: format!("Clean up {machines}"),
        disabled: swept || picked.is_empty(),
        rows,
    }
}

/// A sweep's end, in a line, and whether it went well.
pub fn swept_said(name: &str, sweep: &Sweep) -> (String, bool) {
    match sweep {
        Sweep::Done { report } => (
            format!("Cleaned up {name}: freed {}", human_bytes(report.bytes)),
            true,
        ),
        Sweep::Failed { reason, .. } => (format!("{name} not cleaned: {reason}"), false),
        Sweep::Running { .. } => (format!("Cleaning {name}…"), true),
    }
}

/// Every Machine that can be chosen, or none.
pub fn choose(view: &View, all: bool) -> HashSet<String> {
    if all {
        view.choosable.iter().cloned().collect()
    } else {
        HashSet::new()
    }
}

#[derive(Default)]
pub struct Cleanup {
    pub open: bool,
    /// By profile; a Machine not in it was not live when the dialog read.
    pub reads: HashMap<String, Read>,
    /// `None` chooses every Machine that can be.
    pub chosen: Option<HashSet<String>>,
    /// By profile, from the first press until the dialog reads again.
    pub sweeps: HashMap<String, Sweep>,
    /// By profile: the latest ask, the only one whose answer is kept.
    asks: HashMap<String, u64>,
    asked: u64,
    /// The groups opened to their items, by `profile kind`.
    pub expanded: HashSet<String>,
}

fn cleanup(app: &mut App) -> &mut Cleanup {
    &mut app.pages.machines.cleanup
}

impl App {
    /// Opens Clean up: shows the sweeps while any runs, else reads each live Machine afresh.
    pub fn open_cleanup(&mut self, now: f64) {
        let live: Vec<String> = super::machines::rows(self)
            .into_iter()
            .filter(|r| r.state.is_live())
            .map(|r| r.profile)
            .collect();
        let state = cleanup(self);
        state.open = true;
        if state
            .sweeps
            .values()
            .any(|s| matches!(s, Sweep::Running { .. }))
        {
            return;
        }
        state.asks.clear();
        state.reads.clear();
        state.chosen = None;
        state.sweeps.clear();
        for profile in live {
            self.cleanup_read(&profile, now);
        }
    }

    /// Asks what a sweep would remove on the Machine with `profile`.
    pub fn cleanup_read(&mut self, profile: &str, now: f64) {
        let state = cleanup(self);
        state.asked += 1;
        let ask = state.asked;
        state.asks.insert(profile.into(), ask);
        state
            .reads
            .insert(profile.into(), Read::Reading { since: now });
        let Some(core) = &self.core else { return };
        let profile = profile.to_string();
        core.request(
            "cleanup",
            json!({ "profile": profile }),
            move |app: &mut App, answer: Result<CleanupSuccess, _>| {
                let state = cleanup(app);
                if state.asks.get(&profile) != Some(&ask) {
                    return;
                }
                let read = match answer {
                    Ok(listed) => Read::Listed {
                        installation: listed.installation,
                        report: listed.report,
                    },
                    Err(why) => Read::Failed { problem: why.0 },
                };
                state.reads.insert(profile, read);
            },
        );
    }

    /// Sweeps every chosen Machine whose listing came back.
    pub fn cleanup_clean(&mut self, now: f64) {
        let rows = super::machines::rows(self);
        let state = &self.pages.machines.cleanup;
        let view = cleanup_view(
            &rows,
            &state.reads,
            state.chosen.as_ref(),
            &state.sweeps,
            now,
        );
        if view.disabled {
            return;
        }
        let sends: Vec<(String, String, String)> = view
            .rows
            .iter()
            .filter(|r| r.chosen)
            .filter_map(|r| match state.reads.get(&r.profile) {
                Some(Read::Listed { installation, .. }) => {
                    Some((r.profile.clone(), r.name.clone(), installation.clone()))
                }
                _ => None,
            })
            .collect();
        for (profile, name, installation) in sends {
            self.cleanup_send(profile, name, installation, request_id());
        }
    }

    /// Sweeps a Machine whose sweep failed again, under the same request.
    pub fn cleanup_try_again(&mut self, profile: &str) {
        let state = &self.pages.machines.cleanup;
        let (Some(Sweep::Failed { request, .. }), Some(Read::Listed { installation, .. })) =
            (state.sweeps.get(profile), state.reads.get(profile))
        else {
            return;
        };
        let name = super::machines::rows(self)
            .into_iter()
            .find(|r| r.profile == profile)
            .map_or_else(|| profile.to_string(), |r| r.name);
        let (installation, request) = (installation.clone(), request.clone());
        self.cleanup_send(profile.to_string(), name, installation, request);
    }

    fn cleanup_send(
        &mut self,
        profile: String,
        name: String,
        installation: String,
        request: String,
    ) {
        cleanup(self).sweeps.insert(
            profile.clone(),
            Sweep::Running {
                request: request.clone(),
            },
        );
        let Some(core) = &self.core else { return };
        let payload = SweepPayload {
            installation,
            machine: name.clone(),
            request: request.clone(),
        };
        core.request(
            "sweep",
            payload,
            move |app: &mut App, answer: Result<Report, _>| {
                let ended = match answer {
                    Ok(report) => Sweep::Done { report },
                    Err(why) => Sweep::Failed {
                        request,
                        reason: why.0,
                    },
                };
                let (said, ok) = swept_said(&name, &ended);
                let state = cleanup(app);
                state.sweeps.insert(profile, ended);
                // Once every sweep has cleaned, nothing is left to do in the dialog.
                if state
                    .sweeps
                    .values()
                    .all(|s| matches!(s, Sweep::Done { .. }))
                {
                    state.open = false;
                }
                app.pages.machines.told.say(said, ok);
            },
        );
    }

    fn cleanup_toggle(&mut self, profile: &str, now: f64) {
        let rows = super::machines::rows(self);
        let state = cleanup(self);
        let view = cleanup_view(
            &rows,
            &state.reads,
            state.chosen.as_ref(),
            &state.sweeps,
            now,
        );
        let mut picked: HashSet<String> = view
            .rows
            .iter()
            .filter(|r| r.chosen)
            .map(|r| r.profile.clone())
            .collect();
        if !picked.remove(profile) {
            picked.insert(profile.to_string());
        }
        state.chosen = Some(picked);
    }
}

fn small(label: &str) -> Button {
    Button::new(label)
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Small)
}

fn machine_row(k: &Kit, row: &RowView, expanded: &HashSet<String>) -> El {
    let profile = row.profile.clone();
    let check = Checkbox::new(row.chosen)
        .label(row.name.clone())
        .disabled(!row.choosable)
        .on_toggle(move |app: &mut App| app.cleanup_toggle(&profile, now()))
        .build(k)
        .key("chosen");
    let mut said = rune::row().gap(6.0).center_y();
    if row.reading {
        said = said.child(Spinner::new().size(12.0).build(k));
    }
    said = said.child(
        text(row.said.clone())
            .key("said")
            .font(k.ty.text_small)
            .color(if row.warn {
                k.c.warning.fg
            } else {
                k.c.text_base
            }),
    );
    let mut body = col()
        .key(format!("cleanup-{}", row.profile))
        .role("group")
        .label(format!("{}: {}", row.name, row.said))
        .w_full()
        .gap(6.0)
        .padding(12.0)
        .radius(k.radius.md)
        .fill(k.c.layer_02)
        .child(
            rune::row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(check)
                .child(rune::el().grow(1.0))
                .child(said),
        );
    if let Some(note) = &row.note {
        body = body.child(muted(k, note.clone()).key("note"));
    }
    if let Some(reason) = &row.reason {
        let mut line = rune::row()
            .w_full()
            .gap(8.0)
            .center_y()
            .child(toned(k, reason.clone(), Tone::Bad).key("reason").grow(1.0));
        if row.try_again {
            let profile = row.profile.clone();
            line = line.child(
                small("Try again")
                    .on_press(move |app: &mut App| app.cleanup_try_again(&profile))
                    .build(k)
                    .key("try-again"),
            );
        }
        body = body.child(line);
    }
    if row.read_again {
        let profile = row.profile.clone();
        body = body.child(
            rune::row().w_full().child(rune::el().grow(1.0)).child(
                small("Read again")
                    .on_press(move |app: &mut App| app.cleanup_read(&profile, now()))
                    .build(k)
                    .key("read-again"),
            ),
        );
    }
    for group in &row.groups {
        let id = format!("{} {}", row.profile, group.kind);
        let open = expanded.contains(&id);
        let items = group.items.iter().map(|item| {
            col()
                .gap(2.0)
                .pl(28.0)
                .child(super::common::code(k, item.target.clone()))
                .child(muted(k, format!("{} · {}", item.size, item.reason)))
        });
        let toggled = id.clone();
        let mut c = Collapsible::new(
            format!("{} · {} · {}", group.kind, group.count, group.size),
            open,
        )
        .ghost()
        .on_toggle(move |app: &mut App| toggle(&mut cleanup(app).expanded, &toggled));
        if open {
            c = c.child(col().gap(6.0).pb(4.0).children(items));
        }
        body = body.child(c.build(k).key(format!("kind-{}", group.kind)));
    }
    if let Some(kept) = &row.kept {
        let id = format!("{} kept", row.profile);
        let open = expanded.contains(&id);
        let toggled = id.clone();
        let mut c = Collapsible::new(kept.said.clone(), open)
            .ghost()
            .on_toggle(move |app: &mut App| toggle(&mut cleanup(app).expanded, &toggled));
        if open {
            c = c.child(
                col()
                    .gap(6.0)
                    .pb(4.0)
                    .children(kept.items.iter().map(|item| {
                        col()
                            .gap(2.0)
                            .pl(28.0)
                            .child(super::common::code(
                                k,
                                format!("{} {}", item.kind, item.target),
                            ))
                            .child(muted(k, item.reason.clone()))
                    })),
            );
        }
        body = body.child(c.build(k).key("kept"));
    }
    body
}

fn toggle(set: &mut HashSet<String>, id: &str) {
    if !set.remove(id) {
        set.insert(id.to_string());
    }
}

fn now() -> f64 {
    collie_desktop_protocol::epoch_ms()
}

/// The dialog, while it is open.
pub fn dialog(app: &App, rows: &[MachineRow], k: &Kit, layer: &mut Vec<El>) {
    let state = &app.pages.machines.cleanup;
    if !state.open {
        return;
    }
    let view = cleanup_view(
        rows,
        &state.reads,
        state.chosen.as_ref(),
        &state.sweeps,
        now(),
    );
    let none_choosable = view.choosable.is_empty();
    let pick = |label: &'static str, all: bool| {
        small(label)
            .disabled(none_choosable)
            .on_press(move |app: &mut App| {
                let rows = super::machines::rows(app);
                let state = cleanup(app);
                let view = cleanup_view(
                    &rows,
                    &state.reads,
                    state.chosen.as_ref(),
                    &state.sweeps,
                    now(),
                );
                state.chosen = Some(choose(&view, all));
            })
            .build(k)
            .key(if all { "cleanup-all" } else { "cleanup-none" })
    };
    let machines = col()
        .key("cleanup-rows")
        .w_full()
        .gap(10.0)
        .children(view.rows.iter().map(|r| machine_row(k, r, &state.expanded)));
    let body = col()
        .key("cleanup")
        .w_full()
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(
            rune::row()
                .gap(8.0)
                .child(pick("All", true))
                .child(pick("None", false)),
        )
        .child(
            col()
                .w_full()
                .max_h(420.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .child(machines),
        )
        .child(
            rune::row()
                .w_full()
                .gap(12.0)
                .center_y()
                .child(
                    text(view.chosen.clone())
                        .key("cleanup-total")
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base)
                        .grow(1.0),
                )
                .child(
                    Button::new(view.button.clone())
                        .variant(ButtonVariant::Contrast)
                        .disabled(view.disabled)
                        .on_press(|app: &mut App| app.cleanup_clean(now()))
                        .build(k)
                        .key("cleanup-clean"),
                ),
        );
    Dialog::new("cleanup", "Clean up")
        .description("What a sweep would remove on each connected Machine. Choose where to clean.")
        .width(640.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|app: &mut App| cleanup(app).open = false)
        .build(collie_desktop_theme::dialog(k.dark), layer);
}
