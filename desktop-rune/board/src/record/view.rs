//! The open record as Rune draws it: its header, how current it is, what the last gesture came
//! to, its tabs, and the tab shown.

use super::agents::{agent_tabs, mr_words, ran_on, read_mr_ref};
use super::evidence::{plan_progress, sort_evidence};
use super::review::{Anchor, Draft, add_draft, edit_draft, plan_anchor, remove_draft};
use super::tabs::{self, KeyAction, KeyFacts, Landing, SummarySection, Tab, Target};
use super::when::{now, when_of};
use super::{Form, Item, Record};
use crate::flow::actions::{ActionView, Tone, lane_actions, next_move, step_actions};
use crate::flow::inspector::{self, Part};
use crate::{App, flow, icons};
use collie_desktop_protocol::generated::{
    Category, DetailMr, EvidenceItem, GlyphState, Lane, Node, NodeRun, Review, VerificationResult,
};
use collie_desktop_terminal::view::terminal;
use rune::{El, Key, KeyEvent, ScrollSpec, SurfaceFit, Tx, col, row, spacer, text};
use rune_kit::markdown::Markdown;
use rune_kit::{Badge, BadgeVariant, Button, ButtonVariant, IconButton, Kit, TextArea, TextInput};

fn scrolled(content: El) -> El {
    col()
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(content)
}

fn heading(said: &str, k: &Kit) -> El {
    text(said.to_string())
        .font(k.ty.small_medium)
        .color(k.c.text_muted)
}

fn section(key: &str, said: &str, k: &Kit, body: impl IntoIterator<Item = El>) -> El {
    col()
        .key(key.to_string())
        .role("group")
        .label(said.to_string())
        .gap(6.0)
        .w_full()
        .child(heading(said, k))
        .children(body)
}

fn panel(k: &Kit) -> El {
    col()
        .gap(8.0)
        .padding(12.0)
        .w_full()
        .radius(k.radius.md)
        .fill(k.c.layer_02)
        .border(1.0, k.c.border_base)
}

fn quiet(said: impl Into<String>, k: &Kit) -> El {
    text(said.into())
        .font(k.ty.small)
        .color(k.c.text_muted)
        .wrap()
        .w_full()
}

fn fact(label: &str, value: impl Into<String>, k: &Kit) -> El {
    row()
        .gap(12.0)
        .w_full()
        .child(
            text(label.to_string())
                .font(k.ty.small)
                .color(k.c.text_muted)
                .w(140.0),
        )
        .child(
            text(value.into())
                .font(k.ty.small)
                .color(k.c.text_base)
                .wrap()
                .grow(1.0)
                .min_w(0.0)
                .selectable(true),
        )
}

fn markdown(source: &str, k: &Kit) -> El {
    Markdown::new(source.to_string())
        .selectable(true)
        .build(k)
        .w_full()
}

fn mono(said: &str, key: &str, k: &Kit) -> El {
    text(said.to_string())
        .key(key.to_string())
        .font(k.ty.mono)
        .color(k.c.text_base)
        .wrap_anywhere()
        .selectable(true)
        .w_full()
}

fn slug(said: &str) -> String {
    said.chars()
        .filter_map(|c| match c {
            c if c.is_ascii_alphanumeric() => Some(c.to_ascii_lowercase()),
            ' ' | '-' | '_' | '.' | '/' | ':' => Some('-'),
            _ => None,
        })
        .collect()
}

fn glyph_color(state: &GlyphState, k: &Kit) -> rune::Color {
    match state {
        GlyphState::Done => k.c.success.icon,
        GlyphState::Running => k.c.info.icon,
        GlyphState::NeedsYou => k.c.warning.icon,
        GlyphState::Failed | GlyphState::Stopped => k.c.danger.icon,
        _ => k.c.text_faint,
    }
}

/// Where a draft is, as the composer and the drafts list say it.
pub fn anchor_said(anchor: &Anchor) -> String {
    match anchor {
        Anchor::Plan { file, .. } => format!("On {file}"),
        Anchor::Diff {
            path,
            first,
            last,
            side,
            ..
        } => {
            let lines = if first == last {
                format!("line {first}")
            } else {
                format!("lines {first}–{last}")
            };
            let was = if *side == rune_kit::diff::Side::Old {
                ", as it was"
            } else {
                ""
            };
            format!("On {path}, {lines}{was}")
        }
    }
}

/// A draft as the diff draws it under its line.
pub fn draft_note(draft: &Draft, k: &Kit) -> El {
    row()
        .key(format!("note-{}", draft.id))
        .gap(8.0)
        .padding(8.0)
        .w_full()
        .radius(k.radius.sm)
        .fill(k.c.layer_03)
        .child(text("Draft").font(k.ty.small_medium).color(k.c.info.icon))
        .child(
            text(draft.text.clone())
                .font(k.ty.small)
                .color(k.c.text_base)
                .wrap()
                .grow(1.0)
                .min_w(0.0),
        )
}

/// The open record, or none while no Run is open.
pub fn view(app: &App, k: &Kit) -> Option<El> {
    let record = app.record.open.as_ref()?;
    let tabs = app.record_tabs();
    let shown = tabs::tab_shown(&tabs, record.chosen.as_deref());
    let keys = |app: &mut App, ev: &KeyEvent, tx: &mut Tx| {
        let Key::Text(typed) = &ev.key else {
            return false;
        };
        let tabs = app.record_tabs();
        let shown = app.record_tab();
        let facts = KeyFacts {
            key: typed,
            ctrl_or_meta: ev.mods.cmd || ev.mods.ctrl || ev.mods.logo,
            in_field: false,
            tab: &shown,
        };
        match tabs::key_action(&facts) {
            Some(KeyAction::PreviousTab | KeyAction::NextTab) => {
                let step = if tabs::key_action(&facts) == Some(KeyAction::NextTab) {
                    1
                } else {
                    -1
                };
                match tabs::tab_beside(&tabs, &shown, step) {
                    Some(next) => {
                        app.show_tab(&next);
                        true
                    }
                    None => false,
                }
            }
            Some(KeyAction::NextFile) => {
                app.file_step(1, tx);
                true
            }
            Some(KeyAction::PreviousFile) => {
                app.file_step(-1, tx);
                true
            }
            None => false,
        }
    };
    let body = match shown.as_str() {
        "flow" => flow_tab(app, record, k),
        "summary" => scrolled(summary_tab(app, record, k)),
        "plan" => plan_tab(app, record, k),
        "review" => scrolled(review_tab(app, record, k)),
        "diff" => with_drafts(app, record, super::diff::view(app, k), k),
        "evidence" => scrolled(evidence_tab(record, k)),
        "log" => log_tab(record, k),
        "terminal" => terminal_tab(app, record, k),
        "facts" => scrolled(facts_tab(record, k)),
        mr => scrolled(mr_tab(record, mr, k)),
    };
    Some(
        col()
            .key("record")
            .role("group")
            .label(format!("Run {}", record.run))
            .padding(16.0)
            .gap(10.0)
            .grow(1.0)
            .min_h(0.0)
            .min_w(0.0)
            .on_key(keys)
            .child(header(app, record, k))
            .children(standing(app, record, k))
            .children(notice(app, k))
            .child(tab_bar(&tabs, &shown, k))
            .child(
                col()
                    .key(format!("tabpanel-{shown}"))
                    .role("tabpanel")
                    .grow(1.0)
                    .min_h(0.0)
                    .w_full()
                    .child(body),
            ),
    )
}

fn header(app: &App, record: &Record, k: &Kit) -> El {
    let detail = record.detail();
    let task = app.task_of_record();
    let title = task
        .map(|t| t.name.clone())
        .or_else(|| detail.map(|d| d.title.clone()))
        .unwrap_or_else(|| record.run.clone());
    let mut under = vec![record.run.clone(), record.machine.clone()];
    if let Some(detail) = detail
        && detail.title != title
    {
        under.insert(0, detail.title.clone());
    }
    let started_by = detail
        .and_then(|d| d.requested_by.clone().flatten())
        .map(|by| {
            format!(
                "Started by {} of {} on {}",
                by.agent, by.run, by.machine.name
            )
        });
    let back = IconButton::new(&icons::BACK)
        .label("Back to the board")
        .on_press(App::back)
        .build(k)
        .key("back");
    let status = detail.map(|d| {
        Badge::new(d.status.clone())
            .variant(BadgeVariant::Subtle)
            .build(k)
    });
    row()
        .key("record-header")
        .gap(10.0)
        .center_y()
        .w_full()
        .child(back)
        .child(
            col()
                .gap(2.0)
                .grow(1.0)
                .min_w(0.0)
                .child(
                    text(title)
                        .key("record-title")
                        .font(k.ty.body_medium)
                        .color(k.c.text_strong)
                        .truncate(),
                )
                .child(
                    text(under.join(" · "))
                        .font(k.ty.small)
                        .color(k.c.text_muted)
                        .truncate(),
                )
                .children(started_by.map(|said| {
                    text(said)
                        .key("requested-by")
                        .font(k.ty.small)
                        .color(k.c.text_muted)
                })),
        )
        .children(status)
}

/// Whether the record is current: still reading, no longer coming, or from a Machine out of
/// reach.
fn standing(app: &App, record: &Record, k: &Kit) -> Option<El> {
    let said = if let Some(why) = &record.ended {
        format!("The record stopped coming: {why}")
    } else if record.kept.is_none() {
        "Reading the record…".into()
    } else if !app.record_live() {
        let as_of = record.kept.as_ref().and_then(|kept| kept.as_of);
        match as_of {
            Some(ms) => format!(
                "Not current: showing what it last said, as of {}",
                when_of(&iso_of(ms), now())
            ),
            None => "Not current: its Machine is out of reach.".into(),
        }
    } else {
        return None;
    };
    let alert = record.ended.is_some();
    Some(
        text(said)
            .key("record-standing")
            .role(if alert { "alert" } else { "status" })
            .font(k.ty.small)
            .color(if alert {
                k.c.danger.icon
            } else {
                k.c.text_muted
            }),
    )
}

/// An instant in milliseconds as ISO 8601, for `when_of`.
fn iso_of(ms: f64) -> String {
    let seconds = (ms / 1000.0).floor() as i64;
    let days = seconds.div_euclid(86_400);
    let of_day = seconds.rem_euclid(86_400);
    let (y, m, d) = {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        (
            if month <= 2 {
                yoe + era * 400 + 1
            } else {
                yoe + era * 400
            },
            month,
            day,
        )
    };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

fn notice(app: &App, k: &Kit) -> Option<El> {
    if app.record.sending {
        return Some(
            text("Sending…")
                .key("record-notice")
                .role("status")
                .font(k.ty.small)
                .color(k.c.text_muted),
        );
    }
    let notice = app.record.notice.as_ref()?;
    let again = notice.again.clone().map(|sent| {
        Button::new("Try again")
            .variant(ButtonVariant::Outline)
            .on_press(move |app: &mut App| app.act_again(sent.clone()))
            .build(k)
            .key("notice-again")
    });
    let dismiss = IconButton::new(&icons::CLOSE)
        .label("Dismiss")
        .on_press(|app: &mut App| app.record.notice = None)
        .build(k)
        .key("notice-dismiss");
    Some(
        row()
            .key("record-notice")
            .role(if notice.failed { "alert" } else { "status" })
            .label(notice.said.clone())
            .gap(8.0)
            .center_y()
            .padding(8.0)
            .w_full()
            .radius(k.radius.sm)
            .fill(k.c.layer_02)
            .child(
                text(notice.said.clone())
                    .font(k.ty.small)
                    .color(if notice.failed {
                        k.c.danger.icon
                    } else {
                        k.c.text_base
                    })
                    .wrap()
                    .grow(1.0)
                    .min_w(0.0),
            )
            .children(again)
            .child(dismiss),
    )
}

fn tab_bar(tabs: &[Tab], shown: &str, k: &Kit) -> El {
    let tabs = tabs.iter().map(|tab| {
        let chosen = tab.value == shown;
        let value = tab.value.clone();
        let label = if tab.loading {
            format!("{} …", tab.label)
        } else {
            tab.label.clone()
        };
        Button::new(label)
            .variant(if chosen {
                ButtonVariant::Neutral
            } else {
                ButtonVariant::GhostMuted
            })
            .on_press(move |app: &mut App| app.show_tab(&value))
            .build(k)
            .key(format!("tab-{}", tab.value))
            .role("tab")
            .label(if tab.loading {
                format!("{}, still coming", tab.label)
            } else {
                tab.label.clone()
            })
            .checked(chosen)
            .focus_selected(chosen)
    });
    row()
        .key("record-tabs")
        .role("tablist")
        .label("Record")
        .focus_group()
        .gap(2.0)
        .w_full()
        .children(tabs)
}

fn action_button(action: &ActionView, key: String, k: &Kit) -> El {
    let effect = action.effect.clone();
    let variant = match action.tone {
        Tone::Neutral => ButtonVariant::Outline,
        Tone::Warning => ButtonVariant::Warning,
        Tone::Error => ButtonVariant::Danger,
    };
    let button = Button::new(action.label.clone())
        .variant(variant)
        .on_press(move |app: &mut App| app.run_effect(effect.clone()))
        .build(k)
        .key(key);
    match &action.caption {
        Some(caption) => col()
            .gap(2.0)
            .child(button)
            .child(text(caption.clone()).font(k.ty.small).color(k.c.text_muted)),
        None => button,
    }
}

fn flow_tab(app: &App, record: &Record, k: &Kit) -> El {
    let Some(map) = &app.flow else {
        return quiet("This Run has no Flow.", k);
    };
    let live = app.record_live();
    let lane = map
        .flow
        .lanes
        .iter()
        .find(|l| l.run == record.run)
        .or(map.flow.lanes.first());
    let lane_row = lane.map(|lane| {
        row().key("lane-actions").gap(6.0).children(
            lane_actions(lane, live)
                .iter()
                .map(|a| action_button(a, format!("lane-{}", slug(&a.label)), k)),
        )
    });
    let next = next_move(&map.flow).and_then(|next| {
        let node = crate::flow::actions::as_run(next.node);
        let action = crate::flow::actions::flow_action(&next.action, &node, next.lane, live)?;
        Some(
            row()
                .key("next-move")
                .gap(10.0)
                .center_y()
                .padding(10.0)
                .w_full()
                .radius(k.radius.md)
                .fill(k.c.layer_02)
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(
                            text(format!("Next: {}", next.node.title))
                                .font(k.ty.ui_medium)
                                .color(k.c.text_strong),
                        )
                        .children(next.notice.map(|n| quiet(n, k))),
                )
                .child(action_button(&action, "next-action".into(), k)),
        )
    });
    let notice = map
        .flow
        .notice
        .clone()
        .flatten()
        .filter(|_| next_move(&map.flow).is_none());
    col()
        .key("flow-tab")
        .gap(12.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .children(notice.map(|n| quiet(n, k)))
        .children(next)
        .child(
            row()
                .gap(12.0)
                .w_full()
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .child(flow::flow_map(map, super::flow_of, k)),
                )
                .children(lane_row),
        )
        .children(inspector_view(app, record, map, k))
        .children(form_view(record, k))
}

fn inspector_view(app: &App, record: &Record, map: &flow::FlowMap, k: &Kit) -> Option<El> {
    let spot = map.selected.clone().or_else(|| {
        map.flow.current.as_ref().map(|c| flow::Spot {
            run: c.run.clone(),
            node: c.node.clone(),
        })
    })?;
    let parent: &Node = flow::node_at(&map.flow, &spot)?;
    let entries = inspector::entries_of(parent);
    let node: NodeRun = record
        .entry
        .as_ref()
        .and_then(|id| entries.iter().find(|e| &e.id == id).cloned())
        .unwrap_or_else(|| crate::flow::actions::as_run(parent));
    let lane: Option<&Lane> = map.flow.lanes.iter().find(|l| l.run == spot.run);
    let live = app.record_live();
    let detail = record.detail();
    let now = now();
    let timing = inspector::step_timing(&node, &parent.runs, now);
    let status = inspector::status_of(&node, timing.as_deref());
    let facts = inspector::facts_of(&node, |iso| when_of(iso, now));
    let steering = inspector::step_steering(&node);
    let actions = lane
        .map(|lane| step_actions(&node, lane, live))
        .unwrap_or_default();
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
    let proofs = inspector::step_evidence(checks, &parent.id, record.entry.as_ref().map(|_| &node));
    let parts = inspector::inspector_parts(&node, live, log.count, proofs.len());
    let chosen = record
        .part
        .unwrap_or_else(|| inspector::inspector_part(&node, live));
    let part = inspector::shown_part(chosen, &parts);
    let title = row()
        .gap(8.0)
        .center_y()
        .child(
            text("●")
                .font(k.ty.small)
                .color(glyph_color(&node.state, k)),
        )
        .child(
            text(node.title.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong),
        )
        .children(steering.badge.clone().map(|b| Badge::new(b).build(k)))
        .child(spacer())
        .children(status.map(|s| text(s).font(k.ty.small).color(k.c.text_muted)));
    let purpose = (!node.description.trim().is_empty()).then(|| quiet(node.description.trim(), k));
    let facts = col()
        .gap(2.0)
        .children(facts.iter().map(|f| fact(&f.label, f.value.clone(), k)));
    let pause = steering.pause.clone().map(|p| quiet(p, k));
    let run = spot.run.clone();
    let notes = steering.notes.iter().map(|note| {
        let (edit_run, edit_step, id, said) = (
            run.clone(),
            parent.id.clone(),
            note.id.clone(),
            note.text.clone(),
        );
        let (gone_run, gone_id) = (run.clone(), note.id.clone());
        let read = note.read.as_ref().map_or("unread".to_string(), |at| {
            format!("read {}", when_of(at, now))
        });
        row()
            .key(format!("note-{}", note.id))
            .gap(8.0)
            .center_y()
            .w_full()
            .child(
                col()
                    .gap(2.0)
                    .grow(1.0)
                    .min_w(0.0)
                    .child(
                        text(note.text.clone())
                            .font(k.ty.small)
                            .color(k.c.text_base)
                            .wrap(),
                    )
                    .child(
                        text(format!("{} · {} · {read}", note.by, when_of(&note.at, now)))
                            .font(k.ty.small)
                            .color(k.c.text_faint),
                    ),
            )
            .children(note.read.is_none().then(|| {
                Button::new("Edit")
                    .variant(ButtonVariant::Ghost)
                    .on_press(move |app: &mut App| {
                        app.edit_note(
                            edit_run.clone(),
                            edit_step.clone(),
                            id.clone(),
                            said.clone(),
                        )
                    })
                    .build(k)
                    .key(format!("note-edit-{}", note.id))
            }))
            .children(note.read.is_none().then(|| {
                Button::new("Withdraw")
                    .variant(ButtonVariant::Ghost)
                    .on_press(move |app: &mut App| {
                        app.withdraw_note(gone_run.clone(), gone_id.clone())
                    })
                    .build(k)
                    .key(format!("note-withdraw-{}", note.id))
            }))
    });
    let entry_rows = (!entries.is_empty()).then(|| {
        row()
            .key("inspector-entries")
            .gap(4.0)
            .flex_wrap()
            .children(entries.iter().map(|one| {
                let id = one.id.clone();
                let chosen = record.entry.as_deref() == Some(one.id.as_str());
                Button::new(one.title.clone())
                    .variant(if chosen {
                        ButtonVariant::Neutral
                    } else {
                        ButtonVariant::Ghost
                    })
                    .on_press(move |app: &mut App| {
                        if let Some(record) = &mut app.record.open {
                            record.entry = if record.entry.as_deref() == Some(id.as_str()) {
                                None
                            } else {
                                Some(id.clone())
                            };
                        }
                    })
                    .build(k)
                    .key(format!("entry-{}", one.id))
                    .checked(chosen)
            }))
    });
    let action_row = (!actions.is_empty()).then(|| {
        row().key("step-actions").gap(6.0).flex_wrap().children(
            actions
                .iter()
                .map(|a| action_button(a, format!("action-{}", slug(&a.label)), k)),
        )
    });
    let part_tabs = (parts.len() > 1).then(|| {
        row()
            .key("inspector-parts")
            .role("tablist")
            .label("Step's work")
            .gap(2.0)
            .children(parts.iter().map(|p| {
                let value = p.value;
                Button::new(p.label.clone())
                    .variant(if value == part {
                        ButtonVariant::Neutral
                    } else {
                        ButtonVariant::GhostMuted
                    })
                    .on_press(move |app: &mut App| {
                        if let Some(record) = &mut app.record.open {
                            record.part = Some(value);
                        }
                    })
                    .build(k)
                    .key(format!("part-{}", slug(&format!("{value:?}"))))
                    .role("tab")
                    .checked(value == part)
            }))
    });
    let work = match part {
        Part::Terminal => {
            let agent = node.agent.clone().flatten();
            row()
                .gap(8.0)
                .center_y()
                .child(quiet("Its terminal is on the Terminal tab.", k))
                .child(
                    Button::new("Watch it")
                        .variant(ButtonVariant::Outline)
                        .on_press(move |app: &mut App| {
                            if let Some(agent) = &agent {
                                app.pick_agent(agent.clone());
                            }
                            app.show_tab("terminal");
                        })
                        .build(k)
                        .key("inspector-terminal"),
                )
        }
        Part::Log => match &log.text {
            Some(lines) => col()
                .gap(4.0)
                .children(log.older.map(|o| quiet(o, k)))
                .child(mono(lines, "inspector-log", k)),
            None => quiet(inspector::quiet_work(&node), k),
        },
        Part::Evidence if !proofs.is_empty() => col()
            .gap(4.0)
            .children(proofs.iter().map(|v| verification_row(v, k))),
        Part::Why => quiet(steering.retry_text.clone(), k),
        Part::Decision => quiet("It waits for an answer: press Answer or Review above.", k),
        _ => quiet(inspector::quiet_work(&node), k),
    };
    Some(
        panel(k)
            .key("inspector")
            .role("group")
            .label(format!("Step {}", node.title))
            .child(title)
            .children(purpose)
            .children(entry_rows)
            .children(action_row)
            .children(pause)
            .children(notes)
            .child(facts)
            .children(part_tabs)
            .child(work),
    )
}

fn form_view(record: &Record, k: &Kit) -> Option<El> {
    let form = record.form.as_ref()?;
    let cancel = Button::new("Cancel")
        .variant(ButtonVariant::Ghost)
        .on_press(|app: &mut App| {
            if let Some(record) = &mut app.record.open {
                record.form = None;
            }
        })
        .build(k)
        .key("form-cancel");
    let body = match form {
        Form::Text {
            title, edit, retry, ..
        } => {
            let send = if retry.is_some() {
                "Send and retry"
            } else {
                "Send"
            };
            col()
                .gap(8.0)
                .child(
                    text(title.clone())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_strong),
                )
                .child(
                    TextArea::new(edit)
                        .placeholder("Say what you want")
                        .label(title.clone())
                        .rows(4)
                        .on_edit(|app: &mut App| {
                            match app.record.open.as_mut().and_then(|r| r.form.as_mut()) {
                                Some(Form::Text { edit, .. }) => edit,
                                _ => unreachable!("a text form is open"),
                            }
                        })
                        .build(k)
                        .key("form-text"),
                )
                .child(
                    row()
                        .gap(8.0)
                        .child(
                            Button::new(send)
                                .variant(ButtonVariant::Submit)
                                .on_press(|app: &mut App| app.send_form(None))
                                .build(k)
                                .key("form-send"),
                        )
                        .child(cancel),
                )
        }
        Form::Answer {
            asked,
            options,
            picked,
            edit,
            ..
        } => col()
            .gap(8.0)
            .child(markdown(asked, k))
            .children(options.iter().map(|option| {
                let id = option.id.clone();
                let chosen = picked.as_deref() == Some(option.id.as_str());
                let mut said = option.title.clone();
                if option.recommended == Some(true) {
                    said.push_str(" (recommended)");
                }
                col()
                    .gap(2.0)
                    .child(
                        Button::new(said)
                            .variant(if chosen {
                                ButtonVariant::Contrast
                            } else {
                                ButtonVariant::Outline
                            })
                            .on_press(move |app: &mut App| {
                                if let Some(Form::Answer { picked, .. }) =
                                    app.record.open.as_mut().and_then(|r| r.form.as_mut())
                                {
                                    *picked = Some(id.clone());
                                }
                            })
                            .build(k)
                            .key(format!("option-{}", option.id))
                            .checked(chosen),
                    )
                    .children(option.subtitle.clone().map(|s| quiet(s, k)))
            }))
            .child(
                TextInput::new(edit)
                    .placeholder("Or answer in your own words")
                    .label("Answer in your own words")
                    .on_edit(|app: &mut App| {
                        match app.record.open.as_mut().and_then(|r| r.form.as_mut()) {
                            Some(Form::Answer { edit, .. }) => edit,
                            _ => unreachable!("an answer form is open"),
                        }
                    })
                    .build(k)
                    .key("form-answer-text"),
            )
            .child(
                row()
                    .gap(8.0)
                    .child(
                        Button::new("Answer")
                            .variant(ButtonVariant::Submit)
                            .disabled(picked.is_none() && edit.text.trim().is_empty())
                            .on_press(|app: &mut App| app.send_form(None))
                            .build(k)
                            .key("form-send"),
                    )
                    .child(cancel),
            ),
        Form::Proposal { proposal, .. } => col().gap(8.0).child(markdown(&proposal.text, k)).child(
            row()
                .gap(8.0)
                .child(
                    Button::new("Confirm")
                        .variant(ButtonVariant::Submit)
                        .on_press(|app: &mut App| app.send_form(Some("confirm".into())))
                        .build(k)
                        .key("form-confirm"),
                )
                .child(
                    Button::new("Decline")
                        .variant(ButtonVariant::Outline)
                        .on_press(|app: &mut App| app.send_form(Some("decline".into())))
                        .build(k)
                        .key("form-decline"),
                )
                .child(cancel),
        ),
    };
    Some(
        panel(k)
            .key("flow-form")
            .role("group")
            .label("Action")
            .child(body),
    )
}

fn summary_tab(app: &App, record: &Record, k: &Kit) -> El {
    let Some(detail) = record.detail() else {
        return quiet("Reading the record…", k);
    };
    let sections = tabs::summary_of(detail).into_iter().map(|one| match one {
        SummarySection::Status(status) => {
            section("summary-status", "Status", k, [quiet(status, k)])
        }
        SummarySection::Attention {
            category,
            explanation,
        } => {
            let said = match category {
                Category::Question => "Waiting for an answer",
                Category::Drift => "Drifting",
                Category::Completed => "Done",
                Category::Interrupted => "Interrupted",
                Category::None => "",
            };
            section("summary-attention", said, k, [markdown(&explanation, k)])
        }
        SummarySection::Outcome(outcome) => {
            let outcome = *outcome;
            let mut said = Vec::new();
            said.extend(outcome.kind.map(|v| fact("Kind", v, k)));
            said.extend(outcome.delivered.map(|v| fact("Delivered", v, k)));
            said.extend(outcome.gaps.iter().map(|g| fact("Gap", g.clone(), k)));
            said.extend(outcome.obstacle.map(|v| fact("Obstacle", v, k)));
            said.extend(outcome.next.map(|v| fact("Next", v, k)));
            said.extend(
                outcome
                    .measurement
                    .flatten()
                    .map(|v| fact("Measured", v, k)),
            );
            section("summary-outcome", "Outcome", k, said)
        }
        SummarySection::Inputs(inputs) => section(
            "summary-inputs",
            "Inputs",
            k,
            inputs
                .iter()
                .map(|i| fact(&i.name, i.value.clone(), k))
                .collect::<Vec<_>>(),
        ),
        SummarySection::Replies(replies) => section(
            "summary-replies",
            "Replies",
            k,
            replies
                .iter()
                .map(|r| {
                    col()
                        .gap(2.0)
                        .child(
                            text(format!("{} · {}", r.mr, when_of(&r.at, now())))
                                .font(k.ty.small)
                                .color(k.c.text_faint),
                        )
                        .child(markdown(&r.body, k))
                })
                .collect::<Vec<_>>(),
        ),
    });
    let steps = (!detail.steps.is_empty()).then(|| {
        section(
            "summary-steps",
            "Steps",
            k,
            detail
                .steps
                .iter()
                .map(|s| {
                    let took = s
                        .took
                        .clone()
                        .map(|t| format!(" · {t}"))
                        .unwrap_or_default();
                    fact(
                        &s.id,
                        format!(
                            "{}{took}{}",
                            s.status,
                            if s.note.is_empty() {
                                String::new()
                            } else {
                                format!(" · {}", s.note)
                            }
                        ),
                        k,
                    )
                })
                .collect::<Vec<_>>(),
        )
    });
    let attachments = detail
        .attachments
        .clone()
        .flatten()
        .filter(|a| !a.is_empty())
        .map(|list| {
            section(
                "summary-attachments",
                "Attachments",
                k,
                list.iter()
                    .map(|a| {
                        file_row(
                            &format!("attachment:{}", a.name),
                            &a.name,
                            a.size,
                            record,
                            k,
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        });
    let _ = app;
    col()
        .key("summary")
        .gap(16.0)
        .w_full()
        .children(sections)
        .children(steps)
        .children(attachments)
}

/// A file of the record with its size, and Open, which shows it in the browser.
fn file_row(item: &str, name: &str, bytes: i64, record: &Record, k: &Kit) -> El {
    let opening = item.to_string();
    let reading = record.opening.iter().any(|one| one == item);
    let size = if bytes >= 1 << 20 {
        format!("{:.1} MB", bytes as f64 / (1 << 20) as f64)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    };
    row()
        .key(format!("file-{}", slug(item)))
        .gap(8.0)
        .center_y()
        .w_full()
        .child(
            text(name.to_string())
                .font(k.ty.mono)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(text(size).font(k.ty.small).color(k.c.text_faint))
        .child(
            Button::new(if reading { "Opening…" } else { "Open" })
                .variant(ButtonVariant::Ghost)
                .icon(&icons::OPEN_ASIDE)
                .on_press(move |app: &mut App| app.open_aside(opening.clone()))
                .build(k)
                .key(format!("open-{}", slug(item)))
                .label(format!("Open {name} in the browser")),
        )
}

fn plan_text(record: &Record, file: &str) -> Option<Result<String, String>> {
    let detail = record.detail()?;
    let plan = detail.plan.as_ref()?;
    if file == "SPEC.md" {
        if let Some(whole) = record.items.get("plan:SPEC.md").and_then(Item::text) {
            return Some(Ok(whole));
        }
        return match &plan.spec {
            Review::Text(t) => Some(Ok(t.text.clone())),
            Review::None(none) => Some(Err(none.reason.clone())),
        };
    }
    match record.items.get(&format!("plan:{file}"))? {
        Item::Read(bytes) => Some(Ok(String::from_utf8_lossy(bytes).into_owned())),
        Item::Failed(why) => Some(Err(why.clone())),
        _ => None,
    }
}

impl App {
    /// Reads the plan file shown, and the whole spec where the record carries it cut.
    pub(super) fn read_plan_file(&mut self) {
        let Some(record) = &self.record.open else {
            return;
        };
        let file = record.plan_file.clone().unwrap_or_else(|| "SPEC.md".into());
        let cut = record
            .detail()
            .and_then(|d| d.plan.as_ref())
            .is_some_and(|p| matches!(&p.spec, Review::Text(t) if t.truncated));
        if file != "SPEC.md" || cut {
            self.read_item(&format!("plan:{file}"));
        }
    }

    pub fn show_plan_file(&mut self, file: String) {
        if let Some(record) = &mut self.record.open {
            record.plan_file = Some(file);
            record.anchor = None;
        }
        self.read_plan_file();
    }

    /// Makes the comment written a draft about the span selected in a plan file.
    pub fn add_plan_comment(&mut self) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let said = record.comment.text.trim().to_string();
        let Some(anchor) = record.anchor.clone().filter(|_| !said.is_empty()) else {
            return;
        };
        self.record.made += 1;
        let draft = Draft {
            id: format!("d{}", self.record.made),
            anchor,
            text: said,
        };
        let drafts = self.record.drafts.entry(record.key()).or_default();
        *drafts = add_draft(drafts, draft);
        record.comment.clear();
        record.anchor = None;
    }

    /// Writes the composer's words into the draft being edited.
    pub fn save_draft_edit(&mut self) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let Some(id) = record.editing.take() else {
            return;
        };
        let said = record.comment.text.trim().to_string();
        let drafts = self.record.drafts.entry(record.key()).or_default();
        *drafts = edit_draft(drafts, &id, &said);
        record.comment.clear();
        self.refresh_annotations();
    }

    pub fn remove_draft(&mut self, id: &str) {
        let Some(record) = &self.record.open else {
            return;
        };
        let drafts = self.record.drafts.entry(record.key()).or_default();
        *drafts = remove_draft(drafts, id);
        self.refresh_annotations();
    }

    fn refresh_annotations(&mut self) {
        let Some(record) = &self.record.open else {
            return;
        };
        let drafts = self
            .record
            .drafts
            .get(&record.key())
            .cloned()
            .unwrap_or_default();
        if let Some(tab) = &mut self.diff {
            tab.annotate(&drafts);
        }
    }

    /// Follows a finding to where it points: the diff's line or file, or the file read-only.
    pub fn follow(&mut self, target: Target, tx: &mut Tx) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let paths: Option<Vec<String>> = record
            .detail()
            .and_then(|d| d.diff.as_ref())
            .map(|d| d.files.iter().map(|f| f.path.clone()).collect());
        let landing = tabs::landing_of(&target, paths.as_deref());
        let tab = landing.tab();
        match &landing {
            Landing::Source { file, .. } => {
                record.source = Some(landing.clone());
                let item = format!("file:{file}");
                self.show_tab(tab);
                self.read_item(&item);
            }
            Landing::Line { file, line } => {
                let (file, line) = (file.clone(), *line);
                self.show_tab("diff");
                self.go_to_file(&file, Some(line), tx);
            }
            Landing::File { file } => {
                let file = file.clone();
                self.show_tab("diff");
                self.go_to_file(&file, None, tx);
            }
        }
    }
}

fn plan_tab(app: &App, record: &Record, k: &Kit) -> El {
    let Some(plan) = record.detail().and_then(|d| d.plan.as_ref()) else {
        return quiet("Reading the plan…", k);
    };
    let file = record.plan_file.clone().unwrap_or_else(|| "SPEC.md".into());
    let entry = |path: String, said: String, done: Option<bool>| {
        let chosen = path == file;
        let open = path.clone();
        let mark = match done {
            Some(true) => "✓ ",
            Some(false) => "○ ",
            None => "",
        };
        row()
            .key(format!("plan-file-{}", slug(&path)))
            .role("button")
            .label(said.clone())
            .focusable(true)
            .gap(6.0)
            .center_y()
            .w_full()
            .px(8.0)
            .py(5.0)
            .radius(k.radius.sm)
            .fill(if chosen { k.c.layer_03 } else { k.c.layer_01 })
            .on_press(move |app: &mut App| app.show_plan_file(open.clone()))
            .child(
                text(mark.trim().to_string())
                    .font(k.ty.small)
                    .color(k.c.text_muted)
                    .w(12.0),
            )
            .child(
                text(said)
                    .font(k.ty.small)
                    .color(if chosen {
                        k.c.text_strong
                    } else {
                        k.c.text_base
                    })
                    .truncate()
                    .grow(1.0)
                    .min_w(0.0),
            )
            .checked(chosen)
    };
    let files = col()
        .key("plan-files")
        .role("group")
        .label("Plan files")
        .gap(2.0)
        .w(240.0)
        .children(plan_progress(&plan.tickets).map(|p| {
            text(p)
                .key("plan-progress")
                .font(k.ty.small)
                .color(k.c.text_muted)
        }))
        .child(entry("SPEC.md".into(), "Spec".into(), None))
        .children(
            plan.tickets
                .iter()
                .map(|t| entry(format!("issues/{}", t.file), t.title.clone(), Some(t.done))),
        );
    let shown = match plan_text(record, &file) {
        None => quiet("Reading…", k),
        Some(Err(why)) => quiet(format!("{file} could not be read: {why}"), k),
        Some(Ok(source)) => {
            let at = file.clone();
            Markdown::new(source)
                .selectable(true)
                .build(k)
                .w_full()
                .key("plan-text")
                .on_selection_change(move |app: &mut App, change, _| {
                    if change.dragging() {
                        return;
                    }
                    let Some(record) = &mut app.record.open else {
                        return;
                    };
                    let selected = change
                        .selection()
                        .map(|s| s.text().to_string())
                        .unwrap_or_default();
                    if let Some(anchor) = plan_anchor(&at, &selected) {
                        record.anchor = Some(anchor);
                    }
                })
        }
    };
    let composer = record
        .anchor
        .as_ref()
        .filter(|_| record.editing.is_none())
        .map(|anchor| {
            row()
                .key("plan-composer")
                .gap(8.0)
                .center_y()
                .w_full()
                .child(
                    text(anchor_said(anchor))
                        .font(k.ty.small)
                        .color(k.c.text_muted),
                )
                .child(
                    TextInput::new(&record.comment)
                        .placeholder("Comment on the selection")
                        .label("Comment on the selection")
                        .on_edit(|app: &mut App| {
                            &mut app.record.open.as_mut().expect("an open record").comment
                        })
                        .on_submit(|app: &mut App, _| app.add_plan_comment())
                        .build(k)
                        .key("plan-comment")
                        .grow(1.0),
                )
                .child(
                    Button::new("Add comment")
                        .on_press(App::add_plan_comment)
                        .build(k)
                        .key("add-plan-comment"),
                )
        });
    let content = col()
        .gap(8.0)
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .children(composer)
        .child(scrolled(shown));
    with_drafts(
        app,
        record,
        row()
            .gap(16.0)
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .child(files)
            .child(content),
        k,
    )
}

/// A tab with the Run's review comment drafts beside it, while it has any.
fn with_drafts(app: &App, record: &Record, tab: El, k: &Kit) -> El {
    let drafts = app.record.drafts_of(record);
    if drafts.is_empty() {
        return tab;
    }
    row()
        .gap(12.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .child(col().grow(1.0).min_w(0.0).min_h(0.0).child(tab))
        .child(review_panel(app, record, drafts, k))
}

/// The drafts, who they go to, and Send: one message, as ADR-0051 has it.
fn review_panel(app: &App, record: &Record, drafts: &[Draft], k: &Kit) -> El {
    let rows = drafts.iter().map(|draft| {
        let (edit, gone, said) = (draft.id.clone(), draft.id.clone(), draft.text.clone());
        let editing = record.editing.as_deref() == Some(draft.id.as_str());
        let body = if editing {
            col()
                .gap(6.0)
                .child(
                    TextArea::new(&record.comment)
                        .label("Edit the comment")
                        .rows(3)
                        .on_edit(|app: &mut App| {
                            &mut app.record.open.as_mut().expect("an open record").comment
                        })
                        .build(k)
                        .key(format!("draft-text-{}", draft.id)),
                )
                .child(
                    Button::new("Save")
                        .on_press(App::save_draft_edit)
                        .build(k)
                        .key(format!("draft-save-{}", draft.id)),
                )
        } else {
            text(draft.text.clone())
                .font(k.ty.small)
                .color(k.c.text_base)
                .wrap()
                .w_full()
        };
        col()
            .key(format!("draft-{}", draft.id))
            .role("group")
            .label(format!("Draft {}", anchor_said(&draft.anchor)))
            .gap(4.0)
            .padding(8.0)
            .w_full()
            .radius(k.radius.sm)
            .fill(k.c.layer_03)
            .child(
                text(anchor_said(&draft.anchor))
                    .font(k.ty.small)
                    .color(k.c.text_muted)
                    .truncate(),
            )
            .child(body)
            .child(
                row()
                    .gap(4.0)
                    .child(
                        Button::new("Edit")
                            .variant(ButtonVariant::Ghost)
                            .on_press(move |app: &mut App| {
                                if let Some(record) = &mut app.record.open {
                                    record.editing = Some(edit.clone());
                                    record.comment = rune::edit::TextEdit::new(said.clone());
                                }
                            })
                            .build(k)
                            .key(format!("draft-edit-{}", draft.id)),
                    )
                    .child(
                        Button::new("Remove")
                            .variant(ButtonVariant::Ghost)
                            .on_press(move |app: &mut App| app.remove_draft(&gone))
                            .build(k)
                            .key(format!("draft-remove-{}", draft.id)),
                    ),
            )
    });
    let choices = app.delivery_choices();
    let picked = app.delivery_choice();
    let to = (choices.len() > 1).then(|| {
        col().gap(4.0).child(heading("Send to", k)).child(
            row()
                .key("deliver-to")
                .role("radiogroup")
                .label("Send to")
                .gap(4.0)
                .flex_wrap()
                .children(choices.iter().map(|c| {
                    let key = c.key.clone();
                    let chosen = picked.as_ref().is_some_and(|p| p.key == c.key);
                    Button::new(c.label.clone())
                        .variant(if chosen {
                            ButtonVariant::Neutral
                        } else {
                            ButtonVariant::Ghost
                        })
                        .on_press(move |app: &mut App| {
                            if let Some(record) = &mut app.record.open {
                                record.to = Some(key.clone());
                            }
                        })
                        .build(k)
                        .key(format!("deliver-to-{}", slug(&c.key)))
                        .role("radio")
                        .checked(chosen)
                })),
        )
    });
    let count = drafts.len();
    let send = Button::new(if count == 1 {
        "Send 1 comment".to_string()
    } else {
        format!("Send {count} comments")
    })
    .variant(ButtonVariant::Submit)
    .disabled(app.record.sending)
    .on_press(App::send_review)
    .build(k)
    .key("send-review");
    col()
        .key("review-comments")
        .role("group")
        .label("Review comments")
        .gap(8.0)
        .padding(12.0)
        .w(300.0)
        .min_h(0.0)
        .radius(k.radius.md)
        .fill(k.c.layer_02)
        .border(1.0, k.c.border_base)
        .child(heading("Review comments", k))
        .child(
            col()
                .gap(6.0)
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .children(rows),
        )
        .children(to)
        .child(send)
}

fn review_tab(app: &App, record: &Record, k: &Kit) -> El {
    let Some(detail) = record.detail() else {
        return quiet("Reading the review…", k);
    };
    let review = match &detail.review {
        Review::Text(t) => Some(section("review-text", "Review", k, [markdown(&t.text, k)])),
        Review::None(_) => None,
    };
    let findings = (!detail.findings.is_empty()).then(|| {
        section(
            "findings",
            "Findings",
            k,
            detail
                .findings
                .iter()
                .enumerate()
                .map(|(at, f)| {
                    let place = f.file.clone().map(|file| {
                        let line = f.line.map(|l| l as u32);
                        let said = match line {
                            Some(l) => format!("{file}:{l}"),
                            None => file.clone(),
                        };
                        let target = Target { file, line };
                        Button::new(said)
                            .variant(ButtonVariant::Ghost)
                            .on_press_tx(move |app: &mut App, tx| app.follow(target.clone(), tx))
                            .build(k)
                            .key(format!("finding-go-{at}"))
                    });
                    col()
                        .key(format!("finding-{at}"))
                        .gap(2.0)
                        .padding(8.0)
                        .w_full()
                        .radius(k.radius.sm)
                        .fill(k.c.layer_02)
                        .child(
                            row()
                                .gap(8.0)
                                .center_y()
                                .child(Badge::new(f.severity.clone()).build(k))
                                .child(
                                    text(f.title.clone())
                                        .font(k.ty.ui_medium)
                                        .color(k.c.text_strong)
                                        .wrap()
                                        .grow(1.0)
                                        .min_w(0.0),
                                )
                                .children(place),
                        )
                        .children(f.detail.clone().map(|d| markdown(&d, k)))
                })
                .collect::<Vec<_>>(),
        )
    });
    let source = match &record.source {
        Some(Landing::Source { file, line, .. }) => Some(source_file(record, file, *line, k)),
        _ => None,
    };
    let _ = app;
    col()
        .key("review")
        .gap(16.0)
        .w_full()
        .children(source)
        .children(review)
        .children(findings)
}

/// A file as it is now, read-only, its line numbered and the one followed marked.
fn source_file(record: &Record, file: &str, line: Option<u32>, k: &Kit) -> El {
    let body = match record.items.get(&format!("file:{file}")) {
        Some(Item::Read(bytes)) => {
            let said = String::from_utf8_lossy(bytes);
            col().children(said.lines().enumerate().map(|(at, one)| {
                let n = at as u32 + 1;
                let here = Some(n) == line;
                row()
                    .key(format!("source-line-{n}"))
                    .gap(12.0)
                    .fill(if here { k.c.layer_03 } else { k.c.layer_01 })
                    .child(
                        text(format!("{n:>4}"))
                            .font(k.ty.mono)
                            .color(k.c.text_faint),
                    )
                    .child(
                        text(one.to_string())
                            .font(k.ty.mono)
                            .color(k.c.text_base)
                            .wrap_anywhere()
                            .grow(1.0)
                            .min_w(0.0),
                    )
            }))
        }
        Some(Item::Failed(why)) => quiet(format!("{file} could not be read: {why}"), k),
        _ => quiet("Reading…", k),
    };
    let said = match line {
        Some(l) => format!("{file}:{l}, as it is now"),
        None => format!("{file}, as it is now"),
    };
    section("source-file", &said, k, [body])
}

fn verification_row(v: &collie_desktop_protocol::generated::Verification, k: &Kit) -> El {
    let passed = v.result == VerificationResult::Pass;
    let expected = crate::flow::written(&v.expect);
    let (mark, color) = match (&v.result, expected.as_str()) {
        (VerificationResult::Pass, "pass") | (VerificationResult::Fail, "fail") => {
            ("✓", k.c.success.icon)
        }
        (VerificationResult::Unstable, _) => ("~", k.c.warning.icon),
        _ => ("✗", k.c.danger.icon),
    };
    let result = crate::flow::written(&v.result);
    let by = crate::flow::written(&v.by);
    row()
        .key(format!("check-{}", v.id))
        .role("group")
        .label(format!("{}: {result}, expected {expected}", v.name))
        .gap(8.0)
        .center_y()
        .w_full()
        .child(text(mark).font(k.ty.ui_medium).color(color).w(14.0))
        .child(
            text(v.name.clone())
                .font(k.ty.mono)
                .color(k.c.text_base)
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        )
        .child(
            text(format!(
                "{result}{} · exit {} · by {by} · {}",
                if passed || expected != "pass" {
                    format!(", expected {expected}")
                } else {
                    String::new()
                },
                v.exit,
                when_of(&v.at, now())
            ))
            .font(k.ty.small)
            .color(k.c.text_muted),
        )
}

fn image_box(record: &Record, item: &EvidenceItem, k: &Kit) -> El {
    let key = format!("evidence:{}", item.name);
    let shot = match record.items.get(&key) {
        Some(Item::Image(image)) => rune::el()
            .pixels_fit(image.pixels(), SurfaceFit::Fit)
            .w_full()
            .h(240.0),
        Some(Item::Failed(why)) => quiet(why.clone(), k),
        _ => quiet("Reading…", k),
    };
    col()
        .key(format!("shot-{}", slug(&item.name)))
        .role("img")
        .label(item.name.clone())
        .gap(4.0)
        .grow(1.0)
        .min_w(0.0)
        .child(shot)
        .child(
            text(item.name.clone())
                .font(k.ty.small)
                .color(k.c.text_muted)
                .truncate(),
        )
}

impl App {
    /// Reads the images the Evidence tab draws.
    pub(super) fn read_shots(&mut self) {
        let Some(detail) = self.record.open.as_ref().and_then(Record::detail) else {
            return;
        };
        let shots: Vec<String> = detail
            .evidence
            .iter()
            .filter(|e| super::evidence::is_image(&e.name))
            .map(|e| format!("evidence:{}", e.name))
            .collect();
        for shot in shots {
            self.read_item(&shot);
        }
    }
}

fn evidence_tab(record: &Record, k: &Kit) -> El {
    let Some(detail) = record.detail() else {
        return quiet("Reading the evidence…", k);
    };
    let sorted = sort_evidence(&detail.evidence);
    let checks = (!detail.verifications.is_empty()).then(|| {
        section(
            "checks",
            "Checks",
            k,
            detail
                .verifications
                .iter()
                .map(|v| verification_row(v, k))
                .collect::<Vec<_>>(),
        )
    });
    let gallery = (!sorted.gallery.is_empty()).then(|| {
        section(
            "gallery",
            "Screenshots",
            k,
            sorted
                .gallery
                .iter()
                .map(|one| {
                    let shots: Vec<&EvidenceItem> = [&one.before, &one.after, &one.alone]
                        .into_iter()
                        .flatten()
                        .collect();
                    row()
                        .key(format!("gallery-{}", slug(&one.key)))
                        .gap(12.0)
                        .w_full()
                        .children(shots.into_iter().map(|s| image_box(record, s, k)))
                })
                .collect::<Vec<_>>(),
        )
    });
    let listed = |key: &str, said: &str, files: &[EvidenceItem], prefix: &str| {
        (!files.is_empty()).then(|| {
            section(
                key,
                said,
                k,
                files
                    .iter()
                    .map(|f| file_row(&format!("{prefix}:{}", f.name), &f.name, f.bytes, record, k))
                    .collect::<Vec<_>>(),
            )
        })
    };
    let reports = listed(
        "reports",
        "Reports, opened sandboxed in the browser",
        &sorted.reports,
        "evidence",
    );
    let videos = listed("videos", "Videos", &sorted.videos, "evidence");
    let files = listed("evidence-files", "Files", &sorted.files, "evidence");
    let handoffs = detail.handoff_files.clone().flatten().unwrap_or_default();
    let handoffs = listed("handoff-files", "Handoff files", &handoffs, "handoff");
    let m = &detail.outcome.metrics;
    let mut metrics = vec![fact("Rework", format!("{}", m.rework), k)];
    metrics.extend(
        m.time_to_first_evidence
            .map(|t| fact("First evidence", super::when::minutes(t), k)),
    );
    metrics.extend(m.halts.iter().map(|h| fact("Halt", h.clone(), k)));
    metrics.extend(m.obstacles.iter().map(|o| fact("Obstacle", o.clone(), k)));
    let empty = checks.is_none()
        && gallery.is_none()
        && reports.is_none()
        && videos.is_none()
        && files.is_none()
        && handoffs.is_none();
    col()
        .key("evidence")
        .gap(16.0)
        .w_full()
        .children(empty.then(|| quiet("This Run has recorded no evidence yet.", k)))
        .children(checks)
        .children(gallery)
        .children(reports)
        .children(videos)
        .children(files)
        .children(handoffs)
        .child(section("metrics", "Metrics", k, metrics))
}

fn log_tab(record: &Record, k: &Kit) -> El {
    let whole = record.items.get("log");
    let tail = record.detail().and_then(|d| d.tail.as_ref());
    let (said, cut) = match (whole, tail) {
        (Some(Item::Read(bytes)), _) => (String::from_utf8_lossy(bytes).into_owned(), None),
        (Some(Item::Reading), Some(Review::Text(t))) => {
            (t.text.clone(), Some("This is cut short; reading the rest…"))
        }
        (Some(Item::Failed(_)), Some(Review::Text(t))) => (
            t.text.clone(),
            Some("This is cut short; the rest could not be read."),
        ),
        (_, Some(Review::Text(t))) => (t.text.clone(), t.truncated.then_some("")),
        (_, Some(Review::None(none))) => return quiet(none.reason.clone(), k),
        (_, None) => return quiet("Reading the log…", k),
    };
    let more = cut.map(|note| {
        if note.is_empty() {
            Button::new("Read the whole log")
                .variant(ButtonVariant::Outline)
                .on_press(|app: &mut App| app.read_item("log"))
                .build(k)
                .key("log-whole")
        } else {
            quiet(note, k).role("status")
        }
    });
    col()
        .key("log")
        .gap(8.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .children(more)
        .child(
            col()
                .key("log-text")
                .grow(1.0)
                .min_h(0.0)
                .w_full()
                .padding(8.0)
                .radius(k.radius.sm)
                .fill(k.c.layer_02)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(mono(&said, "log-lines", k)),
        )
}

fn terminal_tab(app: &App, record: &Record, k: &Kit) -> El {
    let agents = app
        .task_of_record()
        .map(|t| t.agents.clone())
        .unwrap_or_default();
    let shown = app.record.terminal_agent.clone();
    let shown_agent = agents.iter().find(|a| Some(&a.name) == shown.as_ref());
    let tabs = agent_tabs(&agents, shown_agent);
    let switcher = (tabs.len() > 1).then(|| {
        row()
            .key("agent-tabs")
            .role("tablist")
            .label("Agents")
            .gap(2.0)
            .children(tabs.iter().map(|tab| {
                let name = tab.name.clone();
                let chosen = Some(&tab.name) == shown.as_ref();
                Button::new(format!("{} · {}", tab.label, tab.state))
                    .variant(if chosen {
                        ButtonVariant::Neutral
                    } else {
                        ButtonVariant::GhostMuted
                    })
                    .on_press(move |app: &mut App| app.pick_agent(name.clone()))
                    .build(k)
                    .key(format!("agent-{}", tab.name))
                    .role("tab")
                    .label(match &tab.now {
                        Some(now) => format!("{}, {}: {now}", tab.label, tab.state),
                        None => format!("{}, {}", tab.label, tab.state),
                    })
                    .checked(chosen)
            }))
    });
    let away = (!app.record_live()).then(|| {
        quiet(
            "Its Machine is out of reach; this is what the pane last drew.",
            k,
        )
        .role("status")
    });
    let pane = match &app.terminal {
        Some(tab) => terminal(tab, |app: &mut App| app.terminal.as_mut()),
        None => quiet("Opening the terminal…", k),
    };
    let _ = record;
    col()
        .key("terminal-tab")
        .gap(8.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .children(switcher)
        .children(away)
        .child(pane)
}

fn facts_tab(record: &Record, k: &Kit) -> El {
    let Some(detail) = record.detail() else {
        return col()
            .gap(4.0)
            .child(fact("Run", record.run.clone(), k))
            .child(fact("Machine", record.machine.clone(), k));
    };
    let mut rows = vec![
        fact("Run", detail.id.clone(), k),
        fact("Machine", record.machine.clone(), k),
        fact("Directory", detail.dir.clone(), k),
        fact("Status", detail.status.clone(), k),
    ];
    rows.extend(
        detail
            .started_by
            .clone()
            .flatten()
            .map(|s| fact("Started by", s, k)),
    );
    if detail.finished_at > 0.0 {
        rows.push(fact(
            "Finished",
            when_of(&iso_of(detail.finished_at), now()),
            k,
        ));
    }
    rows.extend(
        detail
            .revision
            .as_ref()
            .map(|r| fact("Revision", format!("{} · {}", r.epoch, r.seq), k)),
    );
    rows.extend(
        detail
            .diff
            .as_ref()
            .map(|d| fact("Diff base", d.base.clone(), k)),
    );
    rows.extend(
        detail
            .handoffs
            .iter()
            .map(|h| fact("Handoff", h.clone(), k)),
    );
    let agents = detail.agents.clone().flatten().unwrap_or_default();
    let agents = (!agents.is_empty()).then(|| {
        section(
            "facts-agents",
            "Agents",
            k,
            agents
                .iter()
                .enumerate()
                .map(|(at, a)| {
                    fact(&a.operation, format!("{} · {}", ran_on(a), a.agent), k)
                        .key(format!("agent-row-{at}"))
                })
                .collect::<Vec<_>>(),
        )
    });
    let steering = (!detail.steering.is_empty()).then(|| {
        section(
            "facts-steering",
            "Steering",
            k,
            detail
                .steering
                .iter()
                .map(|s| {
                    let said = s
                        .narrative
                        .clone()
                        .unwrap_or_else(|| format!("{} · {}", s.readiness, s.significance));
                    fact(&s.kind, format!("{said} · {}", when_of(&s.at, now())), k)
                })
                .collect::<Vec<_>>(),
        )
    });
    col()
        .key("facts")
        .gap(16.0)
        .w_full()
        .child(col().gap(4.0).children(rows))
        .children(agents)
        .children(steering)
}

fn mr_tab(record: &Record, tab: &str, k: &Kit) -> El {
    let Some(detail) = record.detail() else {
        return quiet("Reading…", k);
    };
    let panel_of: Option<DetailMr> = match tab.strip_prefix("mr:") {
        Some(id) => detail
            .mrs
            .as_ref()
            .and_then(|mrs| mrs.iter().find(|m| m.id == id))
            .and_then(|m| m.panel.clone()),
        None => detail.mr.clone(),
    };
    match panel_of {
        None => quiet("Not read yet.", k),
        Some(DetailMr::Unavailable(none)) => quiet(none.reason, k),
        Some(DetailMr::Details(mr)) => mr_panel(&mr, k),
    }
}

fn mr_panel(mr: &collie_desktop_protocol::generated::Details, k: &Kit) -> El {
    let reference = super::agents::MrRef {
        project: mr.project.clone(),
        iid: mr.iid.clone(),
    };
    let words = read_mr_ref(&mr.url).map_or_else(|| mr_words(&reference), |found| mr_words(&found));
    let url = mr.url.clone();
    let mut rows = vec![
        fact("State", mr.state.clone(), k),
        fact("Author", mr.author.clone(), k),
        fact(
            "Branches",
            format!("{} → {}", mr.source_branch, mr.target_branch),
            k,
        ),
        fact(
            &super::agents::capital(words.checks),
            mr.pipeline.clone(),
            k,
        ),
        fact("Approvals", mr.approvals.clone(), k),
        fact(
            "Threads",
            if mr.unresolved {
                "Unresolved".to_string()
            } else {
                "Resolved".into()
            },
            k,
        ),
        fact("Notes", format!("{}", mr.notes), k),
    ];
    if !mr.assignees.is_empty() {
        rows.push(fact("Assignees", mr.assignees.join(", "), k));
    }
    if let Some(merged) = &mr.merged_at {
        rows.push(fact("Merged", when_of(merged, now()), k));
    }
    if mr.auto_merge == Some(true) {
        rows.push(fact("Auto-merge", "On", k));
    }
    panel(k)
        .key("mr-panel")
        .role("group")
        .label(format!(
            "{} {}{}",
            super::agents::capital(words.noun),
            words.sign,
            mr.iid
        ))
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(
                    text(format!("{}{}", words.sign, mr.iid))
                        .font(k.ty.ui_medium)
                        .color(k.c.text_muted),
                )
                .child(
                    text(mr.title.clone())
                        .font(k.ty.ui_medium)
                        .color(k.c.text_strong)
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    Button::new("Open")
                        .variant(ButtonVariant::Outline)
                        .icon(&icons::OPEN_ASIDE)
                        .on_press(move |app: &mut App| app.open_link_in_record(url.clone()))
                        .build(k)
                        .key("mr-open")
                        .label(format!("Open the {} in the browser", words.noun)),
                ),
        )
        .child(col().gap(4.0).children(rows))
}
