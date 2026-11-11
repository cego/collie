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
    Category, DetailMr, EvidenceItem, Lane, Node, NodeRun, Review, VerificationResult,
};
use collie_desktop_terminal::view::{Link, rgb_of, terminal};
use rune::{El, Key, KeyEvent, ScrollSpec, SurfaceFit, Transition, Tx, col, row, text};
use rune_kit::markdown::Markdown;
use rune_kit::{Badge, Button, ButtonVariant, IconButton, Kit, TextArea, TextInput};

fn scrolled(key: &str, content: El) -> El {
    let scroller = col()
        .key(key.to_string())
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .scroll_anchor()
        .scroll_edge_fade(16.0)
        .child(content);
    collie_desktop_chat::glide::smooth::<App>(scroller, key)
}

fn heading(said: &str, k: &Kit) -> El {
    text(said.to_string())
        .font(k.ty.text_small_medium)
        .color(k.c.text_strong)
}

fn section(key: &str, said: &str, k: &Kit, body: impl IntoIterator<Item = El>) -> El {
    col()
        .key(key.to_string())
        .role("group")
        .label(said.to_string())
        .gap(8.0)
        .w_full()
        .child(heading(said, k))
        .children(body)
}

fn panel(k: &Kit) -> El {
    col()
        .gap(12.0)
        .padding(16.0)
        .w_full()
        .radius(k.radius.lg)
        .fill(k.c.layer_02)
        .border(1.0, k.c.border_weak)
}

fn quiet(said: impl Into<String>, k: &Kit) -> El {
    text(said.into())
        .font(k.ty.text_xsmall)
        .color(k.c.text_muted)
        .wrap()
        .w_full()
}

/// Prose is read at most this wide.
const READING_W: f32 = 920.0;

/// Sections one under another, a hairline between each.
fn ruled(into: El, sections: impl IntoIterator<Item = El>, k: &Kit) -> El {
    let mut into = into.gap(20.0);
    for (at, one) in sections.into_iter().enumerate() {
        if at > 0 {
            into = into.child(
                rune::el()
                    .h(1.0)
                    .w_full()
                    .fill(k.c.border_weak)
                    .a11y_hidden(),
            );
        }
        into = into.child(one);
    }
    into
}

/// The width of a fact's label, so a list of facts lines up.
const LABEL_W: f32 = 112.0;

fn fact(label: &str, value: impl Into<String>, k: &Kit) -> El {
    row()
        .gap(16.0)
        .w_full()
        .child(
            text(label.to_string())
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .w(LABEL_W)
                .truncate(),
        )
        .child(
            text(value.into())
                .font(k.ty.text_xsmall)
                .color(k.c.text_base)
                .wrap_anywhere()
                .grow(1.0)
                .min_w(0.0)
                .selectable(true),
        )
}

/// Facts one under another, their labels in one column.
fn facts(rows: impl IntoIterator<Item = El>) -> El {
    col().gap(6.0).w_full().children(rows)
}

/// A track of segments, as rune-kit's SegmentedControl draws one, its segments as wide as
/// their words.
fn segments(k: &Kit) -> El {
    row()
        .h(32.0)
        .padding(2.0)
        .gap(2.0)
        .center_y()
        .radius(8.0)
        .fill(k.c.layer_01)
        .box_shadow(rune::Shadow {
            spread: 0.5,
            color: k.c.border_base,
            ..Default::default()
        })
}

fn segment(said: String, chosen: bool, k: &Kit) -> El {
    let seg = row()
        .h(28.0)
        .px(12.0)
        .center()
        .radius(6.0)
        .focusable(true)
        .checked(chosen)
        .focus_selected(chosen)
        .child(
            text(said)
                .font(k.ty.ui)
                .color(if chosen {
                    k.c.text_strong
                } else {
                    k.c.text_muted
                })
                .a11y_hidden(),
        );
    if chosen {
        seg.fill(k.c.bg_base).box_shadow(rune::Shadow {
            spread: 0.5,
            color: k.c.border_strong,
            ..Default::default()
        })
    } else {
        seg.hover(k.c.hover)
    }
}

/// How a Run's status reads: settled, failed, asking or under way.
fn status_tone(status: &str, k: &Kit) -> rune_kit::StateColors {
    let said = status.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| said.contains(w));
    if has(&["fail", "died", "error"]) {
        k.c.danger
    } else if has(&["done", "complete", "succeed", "merged", "landed"]) {
        k.c.success
    } else if has(&[
        "wait", "need", "held", "hold", "pause", "suspend", "park", "ask",
    ]) {
        k.c.warning
    } else if has(&["run", "work", "pending", "start"]) {
        k.c.info
    } else {
        rune_kit::StateColors {
            bg: k.c.layer_03,
            fg: k.c.text_muted,
            border: k.c.border_base,
            icon: k.c.icon_muted,
        }
    }
}

/// A Run's status as a pill: a dot and its word, in its tone.
fn status_pill(status: &str, k: &Kit) -> El {
    let tone = status_tone(status, k);
    let mut word = status.to_string();
    if let Some(first) = word.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    row()
        .key("record-status")
        .role("status")
        .label(format!("Status: {status}"))
        .h(24.0)
        .px(10.0)
        .gap(6.0)
        .center_y()
        .radius(12.0)
        .fill(tone.bg)
        .border(1.0, tone.border)
        .child(
            rune::el()
                .size(7.0, 7.0)
                .radius(3.5)
                .fill(tone.icon)
                .a11y_hidden(),
        )
        .child(
            text(word)
                .font(k.ty.text_xsmall_medium)
                .color(tone.fg)
                .a11y_hidden(),
        )
}

/// A record's prose, a step smaller than a chat's so it sits under its section's heading.
fn markdown(source: &str, k: &Kit) -> El {
    let body = rune::TextStyle {
        line_height: 20.0,
        ..k.ty.text_small
    };
    let heading = |size: f32| rune::TextStyle {
        size,
        weight: 600.0,
        line_height: size + 8.0,
        ..body
    };
    let style = rune_kit::MarkdownStyle::from_kit(k)
        .body_font(body)
        .heading_font(1, heading(16.0))
        .heading_font(2, heading(14.0))
        .heading_font(3, heading(13.0))
        .list(16.0, 4.0);
    Markdown::new(source.to_string())
        .selectable(true)
        .style(style)
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

/// A draft as the diff draws it under its line, with Edit and Remove; being edited, its words.
pub fn draft_note(app: &App, draft: &Draft, k: &Kit) -> El {
    let editing = app
        .record
        .open
        .as_ref()
        .filter(|r| r.editing.as_deref() == Some(draft.id.as_str()));
    let body = match editing {
        Some(record) => draft_editor(record, &draft.id, k),
        None => text(draft.text.clone())
            .font(k.ty.small)
            .color(k.c.text_base)
            .wrap()
            .grow(1.0)
            .min_w(0.0),
    };
    let (edit, gone) = (draft.id.clone(), draft.id.clone());
    row()
        .key(format!("note-{}", draft.id))
        .gap(8.0)
        .padding(8.0)
        .w_full()
        .items_start()
        .radius(k.radius.sm)
        .fill(k.c.layer_03)
        .on_press(|_: &mut App| {})
        .child(text("Draft").font(k.ty.small_medium).color(k.c.info.icon))
        .child(
            col()
                .gap(4.0)
                .grow(1.0)
                .min_w(0.0)
                .child(body)
                .children(editing.is_none().then(|| {
                    row()
                        .gap(2.0)
                        .ml(-10.0)
                        .child(
                            Button::new("Edit")
                                .variant(ButtonVariant::Ghost)
                                .on_press(move |app: &mut App| app.edit_draft(&edit))
                                .build(k)
                                .key(format!("note-edit-{}", draft.id)),
                        )
                        .child(
                            Button::new("Remove")
                                .variant(ButtonVariant::Ghost)
                                .on_press(move |app: &mut App| app.remove_draft(&gone))
                                .build(k)
                                .key(format!("note-remove-{}", draft.id)),
                        )
                })),
        )
}

/// A draft's words open to edit: Save, or Escape and Cancel to leave them as they were.
fn draft_editor(record: &Record, id: &str, k: &Kit) -> El {
    col()
        .gap(6.0)
        .w_full()
        .child(
            TextInput::new(&record.comment)
                .width(None)
                .label("Edit the comment")
                .on_edit(|app: &mut App| {
                    &mut app.record.open.as_mut().expect("an open record").comment
                })
                .on_submit(|app: &mut App, _| app.save_draft_edit())
                .on_key(|app: &mut App, ev: &KeyEvent, tx: &mut Tx| app.comment_key(ev, tx))
                .build(k)
                .key(format!("draft-text-{id}")),
        )
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new("Save")
                        .variant(ButtonVariant::Submit)
                        .on_press(App::save_draft_edit)
                        .build(k)
                        .key(format!("draft-save-{id}")),
                )
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .on_press(App::close_comment)
                        .build(k)
                        .key(format!("draft-cancel-{id}")),
                ),
        )
}

/// The open record, or none while no Run is open.
pub fn view(app: &App, k: &Kit) -> Option<El> {
    let record = app.record.open.as_ref()?;
    let tabs = app.record_tabs();
    let shown = tabs::tab_shown(&tabs, record.chosen.as_deref());
    let keys = |app: &mut App, ev: &KeyEvent, tx: &mut Tx| {
        if app.comment_key(ev, tx) {
            return true;
        }
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
        "summary" => scrolled("summary-scroll", summary_tab(app, record, k)),
        "plan" => plan_tab(app, record, k),
        "review" => scrolled("review-scroll", review_tab(app, record, k)),
        "diff" => with_drafts(app, record, super::diff::view(app, k), k),
        "evidence" => scrolled("evidence-scroll", evidence_tab(record, k)),
        "log" => log_tab(record, k),
        "terminal" => terminal_tab(app, record, k),
        "facts" => scrolled("facts-scroll", facts_tab(record, k)),
        mr => scrolled("mr-scroll", mr_tab(record, mr, k)),
    };
    let mut panel = col()
        .key(format!("tabpanel-{shown}"))
        .role("tabpanel")
        .grow(1.0)
        .min_h(0.0)
        .w_full();
    // A pane is shown the frame it is asked for, as Ghostty shows one.
    if shown == "terminal" {
        panel = panel.transition(Transition::none());
    }
    Some(
        col()
            .key("record")
            .role("group")
            .label(format!("Run {}", record.run))
            // Go to pane opens the record on its pane at once.
            .transition(Transition::none())
            .padding(20.0)
            .pt(16.0)
            .gap(14.0)
            .grow(1.0)
            .min_h(0.0)
            .min_w(0.0)
            .on_layout(|app: &mut App, rect: [f32; 4]| {
                if let Some(record) = &mut app.record.open
                    && (record.width - rect[2]).abs() > 0.5
                {
                    record.width = rect[2];
                }
            })
            .on_key(keys)
            .child(header(app, record, k))
            .children(standing(app, record, k))
            .children(notice(app, k))
            .child(tab_bar(&tabs, &shown, k))
            .child(panel.child(body)),
    )
}

fn header(app: &App, record: &Record, k: &Kit) -> El {
    let detail = record.detail();
    let task = app.task_of_record();
    let title = task
        .map(|t| t.name.clone())
        .or_else(|| detail.map(|d| d.title.clone()))
        .unwrap_or_else(|| record.run.clone());
    let workflow = detail
        .map(|d| d.title.clone())
        .filter(|workflow| *workflow != title);
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
    let status = detail.map(|d| status_pill(&d.status, k));
    let has_workflow = workflow.is_some();
    let dot = || {
        text("·")
            .font(k.ty.text_xsmall)
            .color(k.c.text_faint)
            .a11y_hidden()
    };
    let meta = row()
        .key("record-meta")
        .gap(6.0)
        .center_y()
        .min_w(0.0)
        .children(workflow.map(|w| {
            text(w)
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_muted)
                .truncate()
        }))
        .children(has_workflow.then(dot))
        .child(
            text(record.run.clone())
                .key("record-run")
                .font(k.ty.mono)
                .color(k.c.text_muted)
                .selectable(true),
        )
        .child(dot())
        .child(
            row()
                .gap(4.0)
                .center_y()
                .child(rune::icon(&icons::MACHINE, 12.0).color(k.c.icon_muted))
                .child(
                    text(record.machine.clone())
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted),
                ),
        );
    row()
        .key("record-header")
        .gap(12.0)
        .center_y()
        .w_full()
        .child(back)
        .child(
            col()
                .gap(3.0)
                .grow(1.0)
                .min_w(0.0)
                .child(
                    text(title)
                        .key("record-title")
                        .role("heading")
                        .font(rune::TextStyle {
                            size: 17.0,
                            line_height: 24.0,
                            ..k.ty.body_medium
                        })
                        .color(k.c.text_strong)
                        .truncate(),
                )
                .child(meta)
                .children(started_by.map(|said| {
                    text(said)
                        .key("requested-by")
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted)
                })),
        )
        .children(status)
}

/// What a record the host sent without its details says, as `RunRecord.vue` does.
const NOT_THERE: &str = "This Run's details are not on its Machine.";

/// `reading` while the record is still coming; once it came without its details, that.
fn unread(record: &Record, reading: &str, k: &Kit) -> El {
    if record.kept.is_some() && record.detail().is_none() {
        quiet(NOT_THERE, k).key("record-not-there")
    } else {
        quiet(reading.to_string(), k)
    }
}

/// Whether the record is current: still reading, no longer coming, or from a Machine out of
/// reach.
fn standing(app: &App, record: &Record, k: &Kit) -> Option<El> {
    let said = if let Some(why) = &record.ended {
        format!("The record stopped coming: {why}")
    } else if record.kept.is_none() {
        "Reading the record…".into()
    } else if record.detail().is_none() {
        NOT_THERE.into()
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
        segment(label, chosen, k)
            .on_press_tx(move |app: &mut App, tx| app.show_tab_tx(&value, tx))
            .key(format!("tab-{}", tab.value))
            .role("tab")
            .label(if tab.loading {
                format!("{}, still coming", tab.label)
            } else {
                tab.label.clone()
            })
    });
    row().w_full().child(
        segments(k)
            .key("record-tabs")
            .role("tablist")
            .label("Record")
            .focus_group()
            .children(tabs),
    )
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
        Some(caption) => col().gap(4.0).child(button).child(
            text(caption.clone())
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted),
        ),
        None => button,
    }
}

/// The map is this wide or wider: the Step's details sit beside its work.
const SIDE_BY_SIDE: f32 = 760.0;
/// The Step's details column, beside its work.
const CONTEXT_W: f32 = 320.0;

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
        row().key("lane-actions").gap(6.0).center_y().children(
            lane_actions(lane, live)
                .iter()
                .map(|a| action_button(a, format!("lane-{}", slug(&a.label)), k)),
        )
    });
    let next = next_move(&map.flow).and_then(|next| {
        let node = crate::flow::actions::as_run(next.node);
        let action = crate::flow::actions::flow_action(&next.action, &node, next.lane, live)?;
        let tone = match action.tone {
            Tone::Error => k.c.danger,
            Tone::Warning => k.c.warning,
            Tone::Neutral => k.c.info,
        };
        Some(
            row()
                .key("next-move")
                .gap(12.0)
                .center_y()
                .padding(12.0)
                .grow(1.0)
                .min_w(0.0)
                .radius(k.radius.md)
                .fill(tone.bg)
                .border(1.0, tone.border)
                .child(crate::flow::glyph::glyph(&next.node.state, 18.0, k))
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(
                            text(format!("Next: {}", next.node.title))
                                .font(k.ty.text_small_medium)
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
        .filter(|_| next.is_none())
        .map(|n| {
            row()
                .key("flow-notice")
                .grow(1.0)
                .min_w(0.0)
                .padding(10.0)
                .radius(k.radius.md)
                .fill(k.c.warning.bg)
                .child(
                    text(n)
                        .font(k.ty.text_xsmall)
                        .color(k.c.warning.fg)
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0),
                )
        });
    let lead = next.or(notice).unwrap_or_else(|| {
        text(if map.selected.is_some() {
            ""
        } else {
            "Choose a Step to see its work. Arrow keys move between Steps and Runs."
        })
        .font(k.ty.text_xsmall)
        .color(k.c.text_faint)
        .grow(1.0)
        .min_w(0.0)
    });
    let toolbar = row()
        .key("flow-toolbar")
        .gap(12.0)
        .center_y()
        .w_full()
        .child(lead)
        .children(lane_row);
    let inspector = inspector_view(app, record, map, k);
    let form = form_view(app, record, k);
    let inspected = inspector.is_some();
    let tab = col()
        .key("flow-tab")
        .gap(20.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .scroll_anchor()
        .scroll_edge_fade(16.0)
        .child(toolbar)
        .child(flow::flow_map(map, super::flow_of, k))
        .children(inspector)
        .children(form.filter(|_| !inspected));
    collie_desktop_chat::glide::smooth::<App>(tab, "flow-tab")
}

/// The selected Step's details: its state, what it is for, its actions, facts and notes.
fn step_context(
    app: &App,
    record: &Record,
    spot: &flow::Spot,
    parent: &Node,
    node: &NodeRun,
    lane: Option<&Lane>,
    k: &Kit,
) -> El {
    let live = app.record_live();
    let now = now();
    let entries = inspector::entries_of(parent);
    let timing = inspector::step_timing(node, &parent.runs, now);
    let status = inspector::status_of(node, timing.as_deref());
    let found = inspector::facts_of(node, |iso| when_of(iso, now));
    let steering = inspector::step_steering(node);
    let actions = lane
        .map(|lane| step_actions(node, lane, live))
        .unwrap_or_default();
    let state = crate::flow::written(&node.state).replace('-', " ");
    let close = IconButton::new(&icons::CLOSE)
        .label("Close the Step's details")
        .on_press(|app: &mut App| {
            if let Some(map) = &mut app.flow {
                map.selected = None;
            }
            if let Some(record) = &mut app.record.open {
                record.entry = None;
                record.part = None;
            }
        })
        .build(k)
        .key("inspector-close");
    let title = row()
        .gap(10.0)
        .center_y()
        .w_full()
        .child(crate::flow::glyph::glyph(&node.state, 18.0, k))
        .child(
            col()
                .gap(1.0)
                .grow(1.0)
                .min_w(0.0)
                .child(
                    text(node.title.clone())
                        .key("inspector-title")
                        .font(k.ty.body_medium)
                        .color(k.c.text_strong)
                        .truncate(),
                )
                .child(
                    text(match &status {
                        Some(said) => format!("{state} · {said}"),
                        None => state.clone(),
                    })
                    .key("inspector-status")
                    .font(k.ty.text_xsmall)
                    .color(crate::flow::glyph::tone(&node.state, k))
                    .wrap()
                    .w_full(),
                ),
        )
        .children(steering.badge.clone().map(|b| Badge::new(b).build(k)))
        .children(map_selected(app).then_some(close));
    let purpose = (!node.description.trim().is_empty()).then(|| {
        text(node.description.trim().to_string())
            .key("inspector-purpose")
            .font(k.ty.text_small)
            .color(k.c.text_base)
            .wrap()
            .w_full()
    });
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
        col()
            .key(format!("note-{}", note.id))
            .gap(6.0)
            .padding(10.0)
            .w_full()
            .radius(k.radius.sm)
            .fill(k.c.layer_01)
            .child(
                text(note.text.clone())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_base)
                    .wrap()
                    .w_full(),
            )
            .child(
                row()
                    .gap(4.0)
                    .center_y()
                    .w_full()
                    .child(
                        text(format!("{} · {} · {read}", note.by, when_of(&note.at, now)))
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint)
                            .grow(1.0)
                            .min_w(0.0)
                            .truncate(),
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
                    })),
            )
    });
    let notes: Vec<El> = notes.collect();
    let entry_rows = (!entries.is_empty()).then(|| {
        section(
            "inspector-entries",
            "Runs",
            k,
            [row()
                .gap(4.0)
                .flex_wrap()
                .w_full()
                .children(entries.iter().map(|one| {
                    let id = one.id.clone();
                    let chosen = record.entry.as_deref() == Some(one.id.as_str());
                    row()
                        .key(format!("entry-{}", one.id))
                        .role("button")
                        .label(one.title.clone())
                        .focusable(true)
                        .checked(chosen)
                        .h(26.0)
                        .px(8.0)
                        .gap(6.0)
                        .center_y()
                        .radius(k.radius.sm)
                        .fill(if chosen { k.c.layer_03 } else { k.c.layer_01 })
                        .border(
                            1.0,
                            if chosen {
                                k.c.border_strong
                            } else {
                                k.c.border_weak
                            },
                        )
                        .hover(k.c.surface_hover)
                        .on_press(move |app: &mut App| {
                            if let Some(record) = &mut app.record.open {
                                record.entry = if record.entry.as_deref() == Some(id.as_str()) {
                                    None
                                } else {
                                    Some(id.clone())
                                };
                            }
                        })
                        .child(crate::flow::glyph::glyph(&one.state, 12.0, k))
                        .child(
                            text(one.title.clone())
                                .font(k.ty.text_xsmall)
                                .color(k.c.text_base)
                                .a11y_hidden(),
                        )
                }))],
        )
    });
    let action_row = (!actions.is_empty()).then(|| {
        row().key("step-actions").gap(6.0).flex_wrap().children(
            actions
                .iter()
                .map(|a| action_button(a, format!("action-{}", slug(&a.label)), k)),
        )
    });
    let fact_rows = (!found.is_empty()).then(|| {
        facts(found.iter().map(|f| fact(&f.label, f.value.clone(), k))).key("inspector-facts")
    });
    let rule = || {
        rune::el()
            .h(1.0)
            .w_full()
            .fill(k.c.border_weak)
            .a11y_hidden()
    };
    col()
        .key("inspector-context")
        .gap(14.0)
        .w_full()
        .child(title)
        .children(purpose)
        .children(action_row)
        .children(fact_rows.map(|f| col().gap(14.0).w_full().child(rule()).child(f)))
        .children(entry_rows)
        .children(pause)
        .children((!notes.is_empty()).then(|| section("inspector-notes", "Notes", k, notes)))
}

fn map_selected(app: &App) -> bool {
    app.flow.as_ref().is_some_and(|m| m.selected.is_some())
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
    let steering = inspector::step_steering(&node);
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
    let part_tabs = (parts.len() > 1).then(|| {
        segments(k)
            .key("inspector-parts")
            .role("tablist")
            .label("Step's work")
            .focus_group()
            .children(parts.iter().map(|p| {
                let value = p.value;
                segment(p.label.clone(), value == part, k)
                    .on_press(move |app: &mut App| {
                        if let Some(record) = &mut app.record.open {
                            record.part = Some(value);
                        }
                    })
                    .key(format!("part-{}", slug(&format!("{value:?}"))))
                    .role("tab")
                    .label(p.label.clone())
            }))
    });
    let work = match part {
        Part::Terminal => {
            let agent = node.agent.clone().flatten();
            row()
                .gap(12.0)
                .center_y()
                .padding(14.0)
                .w_full()
                .radius(k.radius.md)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak)
                .child(rune::icon(&icons::TERMINAL, 16.0).color(k.c.icon_muted))
                .child(
                    text(match &agent {
                        Some(agent) => format!("{agent} is working in its terminal."),
                        None => "Its work is in the Run's terminal.".into(),
                    })
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_muted)
                    .grow(1.0)
                    .min_w(0.0),
                )
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
                .gap(6.0)
                .w_full()
                .children(log.older.map(|o| quiet(o, k)))
                .child(
                    col()
                        .w_full()
                        .max_h(420.0)
                        .padding(12.0)
                        .radius(k.radius.md)
                        .fill(k.c.layer_01)
                        .border(1.0, k.c.border_weak)
                        .scroll(ScrollSpec { stick_bottom: true })
                        .child(mono(lines, "inspector-log", k)),
                ),
            None => quiet(inspector::quiet_work(&node), k),
        },
        Part::Evidence if !proofs.is_empty() => col()
            .gap(2.0)
            .w_full()
            .children(proofs.iter().map(|v| verification_row(v, record, k))),
        Part::Why => col()
            .gap(6.0)
            .w_full()
            .child(heading("Why it failed", k))
            .child(
                col()
                    .w_full()
                    .padding(12.0)
                    .radius(k.radius.md)
                    .fill(k.c.danger.bg)
                    .border(1.0, k.c.danger.border)
                    .child(mono(&steering.retry_text, "inspector-why", k)),
            ),
        Part::Decision if record.form.is_none() => {
            quiet("It waits for an answer: press Answer or Review.", k)
        }
        Part::Decision => rune::el(),
        _ => quiet(inspector::quiet_work(&node), k),
    };
    let form = form_view(app, record, k);
    let work = col()
        .key("inspector-work")
        .role("region")
        .label("Step work")
        .gap(12.0)
        .grow(1.0)
        .min_w(0.0)
        .children(form)
        .children(part_tabs.map(|tabs| row().child(tabs)))
        .child(work);
    let context = step_context(app, record, &spot, parent, &node, lane, k);
    let beside = map.width >= SIDE_BY_SIDE;
    let body = if beside {
        row()
            .gap(24.0)
            .w_full()
            .child(context.w(CONTEXT_W))
            .child(rune::el().w(1.0).fill(k.c.border_weak).a11y_hidden())
            .child(work)
    } else {
        col().gap(16.0).w_full().child(context).child(work)
    };
    Some(
        panel(k)
            .key("inspector")
            .role("group")
            .label(format!("Step {}", node.title))
            .child(body),
    )
}

fn form_view(app: &App, record: &Record, k: &Kit) -> Option<El> {
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
                        .width(None)
                        .placeholder("Say what you want")
                        .label(title.clone())
                        .auto_grow(4, 10)
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
        // Every question answered, or gone from the board: the form is done.
        Form::Answer { questions, .. } => {
            answer_form(app, record, questions, app.question_shown()?, cancel, k)
        }
        Form::Offer { offer, fields, .. } => offer_form(offer.as_ref(), fields, cancel, k),
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

/// The questions of a Step one at a time, "Question k of n" with Back and Next when there are
/// several, each answered by an option or in words and sent on its own.
/// A Step's Start: what it starts, why it cannot now, and the inputs it takes, as the board's
/// offers dialog asks them.
fn offer_form(
    offer: Option<&collie_desktop_protocol::generated::OffersSuccessItem>,
    fields: &[(String, bool, rune::edit::TextEdit)],
    cancel: El,
    k: &Kit,
) -> El {
    let Some(offer) = offer else {
        return col()
            .gap(12.0)
            .child(quiet("Asking the Run what it offers…", k).key("offer-reading"))
            .child(row().child(cancel));
    };
    let ready = offer.unavailable.is_none() && super::act::offer_ready(fields);
    col()
        .key("offer")
        .gap(12.0)
        .w_full()
        .child(
            col()
                .gap(2.0)
                .child(
                    text(offer.title.clone())
                        .key("offer-title")
                        .role("heading")
                        .font(k.ty.ui_medium)
                        .color(k.c.text_strong),
                )
                .child(quiet(format!("Starts {}", offer.workflow), k)),
        )
        .children(offer.unavailable.clone().map(|why| {
            text(why)
                .key("offer-unavailable")
                .role("status")
                .font(k.ty.text_xsmall)
                .color(k.c.warning.fg)
                .wrap()
                .w_full()
        }))
        .children(
            fields
                .iter()
                .enumerate()
                .map(|(i, (name, required, edit))| {
                    col()
                        .gap(4.0)
                        .w_full()
                        .child(
                            text(if *required {
                                name.clone()
                            } else {
                                format!("{name} (optional)")
                            })
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.text_muted),
                        )
                        .child(
                            TextInput::new(edit)
                                .width(None)
                                .label(name.clone())
                                .on_edit(move |app: &mut App| {
                                    match app.record.open.as_mut().and_then(|r| r.form.as_mut()) {
                                        Some(Form::Offer { fields, .. }) => &mut fields[i].2,
                                        _ => unreachable!("an offer form is open"),
                                    }
                                })
                                .build(k)
                                .key(format!("offer-field-{name}")),
                        )
                }),
        )
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new("Start")
                        .variant(ButtonVariant::Submit)
                        .disabled(!ready)
                        .on_press(|app: &mut App| app.make_offer_in_record())
                        .build(k)
                        .key("offer-start"),
                )
                .child(cancel),
        )
}

fn edit_of(app: &mut App) -> &mut rune::edit::TextEdit {
    match app.record.open.as_mut().and_then(|r| r.form.as_mut()) {
        Some(Form::Answer { questions, at, .. }) => &mut questions[*at].edit,
        _ => unreachable!("an answer form is open"),
    }
}

fn steer_of(app: &mut App) -> &mut rune::edit::TextEdit {
    let shown = app.question_shown().unwrap_or_default();
    match app.record.open.as_mut().and_then(|r| r.form.as_mut()) {
        Some(Form::Answer { questions, .. }) => &mut questions[shown].steer,
        _ => unreachable!("an answer form is open"),
    }
}

fn answer_form(
    app: &App,
    record: &Record,
    questions: &[super::Asked],
    at: usize,
    cancel: El,
    k: &Kit,
) -> El {
    let Some(one) = questions.get(at) else {
        return col();
    };
    let n = questions.len();
    let left = (0..n).filter(|i| !app.question_settled(*i)).count();
    let step = row()
        .key("question-step")
        .gap(4.0)
        .center_y()
        .w_full()
        .child(
            text(if n > 1 {
                format!("Question {} of {n}", at + 1)
            } else {
                "Question".into()
            })
            .key("question-count")
            .role("status")
            .font(k.ty.text_xsmall_medium)
            .color(k.c.warning.fg),
        )
        .children((n > 1).then(|| {
            text(format!(" · {left} still open"))
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .grow(1.0)
        }))
        .children((n > 1).then(|| {
            row()
                .gap(2.0)
                .child(
                    IconButton::new(&icons::BACK)
                        .label("Previous question")
                        .disabled(at == 0)
                        .on_press(move |app: &mut App| app.show_question(at.saturating_sub(1)))
                        .build(k)
                        .key("question-back"),
                )
                .child(
                    IconButton::new(&icons::FORWARD)
                        .label("Next question")
                        .disabled(at + 1 >= n)
                        .on_press(move |app: &mut App| app.show_question(at + 1))
                        .build(k)
                        .key("question-next"),
                )
        }));
    let asked = col()
        .key(format!("question-{}", one.id))
        .gap(12.0)
        .w_full()
        .child(step)
        .child(markdown(&one.asked, k));
    if let Some(question) = &one.board {
        let view = app.questionnaire_of(&record.installation, question).view();
        return board_question(asked, &view, one, left, cancel, k);
    }
    if let Some(sent) = &one.sent {
        return asked.child(
            row()
                .key("question-sent")
                .role("status")
                .gap(8.0)
                .center_y()
                .child(crate::flow::glyph::glyph(
                    &collie_desktop_protocol::generated::GlyphState::Done,
                    14.0,
                    k,
                ))
                .child(
                    text(format!("Answered: {sent}"))
                        .font(k.ty.text_small)
                        .color(k.c.text_base)
                        .wrap()
                        .grow(1.0)
                        .min_w(0.0),
                ),
        );
    }
    let options = (!one.options.is_empty()).then(|| {
        col()
            .key("question-options")
            .role("radiogroup")
            .label(one.asked.clone())
            .focus_group()
            .gap(10.0)
            .w_full()
            .children(one.options.iter().map(|option| {
                let id = option.id.clone();
                let chosen = one.picked.as_deref() == Some(option.id.as_str());
                let mut said = option.title.clone();
                if option.recommended == Some(true) {
                    said.push_str(" · Recommended");
                }
                let mut item =
                    rune_kit::RadioItem::new(said, chosen).on_select(move |app: &mut App| {
                        if let Some(Form::Answer { questions, at, .. }) =
                            app.record.open.as_mut().and_then(|r| r.form.as_mut())
                        {
                            questions[*at].picked = Some(id.clone());
                            questions[*at].edit = rune::edit::TextEdit::default();
                        }
                    });
                if let Some(about) = option.subtitle.clone().or(option.detail.clone()) {
                    item = item.description(about);
                }
                item.build(k).key(format!("option-{}", option.id))
            }))
    });
    let ready = one.picked.is_some() || !one.edit.text.trim().is_empty();
    asked
        .children(options)
        .child(
            TextInput::new(&one.edit)
                .width(None)
                .placeholder(if one.options.is_empty() {
                    "Your answer"
                } else {
                    "Or answer in your own words"
                })
                .label("Answer in your own words")
                .on_edit(edit_of)
                .build(k)
                .key("form-answer-text"),
        )
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new(if left > 1 {
                        "Answer and next"
                    } else {
                        "Answer"
                    })
                    .variant(ButtonVariant::Submit)
                    .disabled(!ready)
                    .on_press(|app: &mut App| app.answer_in_record())
                    .build(k)
                    .key("form-send"),
                )
                .child(cancel),
        )
}

/// A question the board has, as its questionnaire has it: its options and Hold the Run, or a
/// value typed; the words for the agent instead; and how the last send went.
fn board_question(
    asked: El,
    view: &crate::board::questionnaire::QuestionnaireView,
    one: &super::Asked,
    left: usize,
    cancel: El,
    k: &Kit,
) -> El {
    use crate::board::questionnaire::HOLD;
    let open = !view.sending && !view.settled;
    let shortfall = view
        .shortfall
        .clone()
        .map(|said| quiet(said, k).key("question-shortfall"));
    let options = (!view.words).then(|| {
        col()
            .key("question-options")
            .role("radiogroup")
            .label(view.text.clone())
            .focus_group()
            .gap(10.0)
            .w_full()
            .children(view.rows.iter().map(|(row, checked)| {
                let id = row.id.clone();
                let mut said = row.title.clone();
                if row.recommended {
                    said.push_str(" · Recommended");
                }
                let mut item = rune_kit::RadioItem::new(said, *checked)
                    .disabled(row.disabled || !open)
                    .on_select(move |app: &mut App| app.pick_in_record(id.clone()));
                if let Some(about) = row
                    .why
                    .clone()
                    .filter(|_| row.disabled)
                    .or(row.detail.clone())
                {
                    item = item.description(about);
                }
                let key = if row.id == HOLD {
                    "option-hold".to_string()
                } else {
                    format!("option-{}", row.id)
                };
                item.build(k).key(key)
            }))
    });
    let typed = view.words.then(|| {
        TextInput::new(&one.edit)
            .width(None)
            .placeholder("Your answer")
            .label("Your answer")
            .disabled(!open)
            .on_edit(edit_of)
            .on_submit(|app: &mut App, _: &mut Tx| app.answer_in_record())
            .build(k)
            .key("form-answer-text")
    });
    let ready = open
        && if view.words {
            !one.edit.text.trim().is_empty()
        } else {
            view.submit
        };
    let held = view
        .rows
        .iter()
        .any(|(row, checked)| *checked && row.id == HOLD);
    let answer = row()
        .gap(8.0)
        .child(
            Button::new(if held {
                "Hold the Run"
            } else if left > 1 {
                "Answer and next"
            } else {
                "Answer"
            })
            .variant(ButtonVariant::Submit)
            .disabled(!ready)
            .on_press(|app: &mut App| app.answer_in_record())
            .build(k)
            .key("form-send"),
        )
        .child(cancel);
    let steer_ready = !view.steer_disabled && !view.sending && !view.settled;
    let words = !one.steer.text.trim().is_empty();
    // A steer that failed keeps its words in the questionnaire; Send tries them again.
    let again = !words && view.steer_send;
    let steering = col()
        .key("form-steer")
        .gap(6.0)
        .w_full()
        .child(
            text("Or tell the agent instead")
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_muted),
        )
        .child(
            row()
                .gap(8.0)
                .center_y()
                .w_full()
                .child(
                    TextInput::new(&one.steer)
                        .width(None)
                        .placeholder("What should it do?")
                        .label("Words for the agent instead of an answer")
                        .disabled(!steer_ready)
                        .on_edit(steer_of)
                        .on_submit(|app: &mut App, _: &mut Tx| app.steer_in_record())
                        .build(k)
                        .key("form-steer-text")
                        .grow(1.0)
                        .min_w(0.0),
                )
                .child(
                    Button::new(if again {
                        "Try again".to_string()
                    } else {
                        view.steer_label.clone()
                    })
                    .variant(ButtonVariant::Outline)
                    .disabled(!steer_ready || !(words || again))
                    .on_press(|app: &mut App| app.steer_in_record())
                    .build(k)
                    .key("form-steer-send"),
                ),
        )
        .children(
            view.steer_why
                .clone()
                .filter(|_| view.steer_disabled)
                .map(|why| quiet(why, k).key("form-steer-why")),
        );
    let status = view.status.clone().map(|said| {
        text(said)
            .key("form-status")
            .role("status")
            .live_region(rune::LiveRegion::Polite)
            .font(k.ty.text_small)
            .color(k.c.text_base)
            .wrap()
            .w_full()
    });
    asked
        .children(shortfall)
        .children(options)
        .children(typed)
        .child(answer)
        .children(status)
        .child(steering)
}

fn summary_tab(app: &App, record: &Record, k: &Kit) -> El {
    let Some(detail) = record.detail() else {
        return unread(record, "Reading the record…", k);
    };
    let sections = tabs::summary_of(detail).into_iter().map(|one| match one {
        SummarySection::Status(status) => section(
            "summary-status",
            "Status",
            k,
            [text(status)
                .font(k.ty.text_small)
                .color(k.c.text_base)
                .wrap()
                .w_full()],
        ),
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
            let part = |label: &str, body: El| {
                col()
                    .gap(4.0)
                    .w_full()
                    .child(
                        text(label.to_string())
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_muted),
                    )
                    .child(body)
            };
            let mut said = Vec::new();
            said.extend(outcome.kind.map(|v| {
                row().child(
                    Badge::new(v)
                        .variant(rune_kit::BadgeVariant::Subtle)
                        .build(k),
                )
            }));
            said.extend(
                outcome
                    .measurement
                    .flatten()
                    .map(|v| part("Measured", markdown(&v, k))),
            );
            if !outcome.gaps.is_empty() {
                let gaps = outcome
                    .gaps
                    .iter()
                    .map(|g| format!("- {g}"))
                    .collect::<Vec<_>>();
                said.push(part("Still to prove", markdown(&gaps.join("\n"), k)));
            }
            said.extend(
                outcome
                    .obstacle
                    .map(|v| part("In its way", markdown(&v, k))),
            );
            said.extend(outcome.next.map(|v| part("Next", markdown(&v, k))));
            said.extend(
                outcome
                    .delivered
                    .map(|v| part("Delivered", markdown(&v, k))),
            );
            section("summary-outcome", "Outcome", k, said)
        }
        SummarySection::Inputs(inputs) => section(
            "summary-inputs",
            "Inputs",
            k,
            [facts(
                inputs.iter().map(|i| fact(&i.name, i.value.clone(), k)),
            )],
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
            [facts(detail.steps.iter().map(|s| {
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
            }))],
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
    ruled(
        col().key("summary").max_w(READING_W).w_full(),
        sections.chain(steps).chain(attachments),
        k,
    )
}

/// A file's size as it is said.
fn size_of(bytes: i64) -> String {
    if bytes >= 1 << 20 {
        format!("{:.1} MB", bytes as f64 / (1 << 20) as f64)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

/// Open, which shows a file of the record in the browser.
fn open_button(item: &str, name: &str, record: &Record, k: &Kit) -> El {
    let opening = item.to_string();
    let reading = record.opening.iter().any(|one| one == item);
    Button::new(if reading { "Opening…" } else { "Open" })
        .variant(ButtonVariant::Ghost)
        .icon(&icons::OPEN_ASIDE)
        .on_press(move |app: &mut App| app.open_aside(opening.clone()))
        .build(k)
        .key(format!("open-{}", slug(item)))
        .label(format!("Open {name} in the browser"))
}

/// A file of the record with its size, and Open, which shows it in the browser.
fn file_row(item: &str, name: &str, bytes: i64, record: &Record, k: &Kit) -> El {
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
        .child(text(size_of(bytes)).font(k.ty.small).color(k.c.text_faint))
        .child(open_button(item, name, record, k))
}

/// A kept log or note, read under its row as it is opened, and still opened in the browser.
fn text_file_row(item: &str, name: &str, bytes: i64, record: &Record, k: &Kit) -> El {
    let size = size_of(bytes);
    evidence_text(
        EvidenceRow {
            key: format!("file-{}", slug(item)),
            item: item.to_string(),
            label: format!("{name}, {size}"),
            parts: vec![
                text(name.to_string())
                    .font(k.ty.mono)
                    .color(k.c.text_base)
                    .truncate()
                    .grow(1.0)
                    .min_w(0.0),
                text(size).font(k.ty.small).color(k.c.text_faint),
            ],
            aside: Some(open_button(item, name, record, k)),
        },
        record,
        k,
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
        record.comment = rune::edit::TextEdit::default();
        record.anchor = None;
    }

    /// A span selected in a plan file opens the comment box on it, focused, keeping what was
    /// typed; a press that selects nothing closes an empty one.
    pub fn choose_plan_span(&mut self, anchor: Option<Anchor>) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        match anchor {
            Some(anchor) => {
                record.anchor = Some(anchor);
                record.editing = None;
                record.comment.focused = true;
            }
            None if record.comment.text.trim().is_empty() => record.anchor = None,
            None => {}
        }
    }

    /// Closes the plan's comment box and any draft being edited, saving nothing.
    pub fn close_comment(&mut self) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        if record.anchor.is_none() && record.editing.is_none() {
            return;
        }
        record.anchor = None;
        record.editing = None;
        record.comment = rune::edit::TextEdit::default();
    }

    /// Escape closes a comment box or a draft's edit; Shift and Cmd-C go to the diff, which
    /// extends a selection by a Shift-press and copies its lines.
    pub fn comment_key(&mut self, ev: &KeyEvent, tx: &mut Tx) -> bool {
        let on_diff = self.record_tab() == "diff";
        if on_diff
            && (matches!(ev.key, Key::Modifier { .. }) || ev.is_command('c'))
            && let Some(tab) = &mut self.diff
        {
            return tab.state.key(ev, tx);
        }
        if ev.key != Key::Escape {
            return false;
        }
        let editing = self
            .record
            .open
            .as_ref()
            .is_some_and(|r| r.anchor.is_some() || r.editing.is_some());
        let writing = on_diff
            && self
                .diff
                .as_ref()
                .is_some_and(|t| t.writing.is_some() || t.state.selection().is_some());
        if editing {
            self.close_comment();
        } else if writing {
            self.close_diff_comment();
        }
        // Otherwise it closes the form open on Flow, as stable's dialogs close.
        let form = !editing
            && !writing
            && self
                .record
                .open
                .as_mut()
                .and_then(|r| r.form.take())
                .is_some();
        editing || writing || form
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
        // A draft emptied is removed, as it would say nothing.
        *drafts = if said.is_empty() {
            remove_draft(drafts, &id)
        } else {
            edit_draft(drafts, &id, &said)
        };
        record.comment = rune::edit::TextEdit::default();
        self.refresh_annotations();
    }

    /// Opens a draft's words to edit, focused.
    pub fn edit_draft(&mut self, id: &str) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let Some(said) = self
            .record
            .drafts
            .get(&record.key())
            .and_then(|d| d.iter().find(|d| d.id == id))
            .map(|d| d.text.clone())
        else {
            return;
        };
        record.anchor = None;
        record.editing = Some(id.into());
        record.comment = rune::edit::TextEdit::new(said);
        record.comment.focused = true;
    }

    pub fn remove_draft(&mut self, id: &str) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        if record.editing.as_deref() == Some(id) {
            record.editing = None;
            record.comment = rune::edit::TextEdit::default();
        }
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
        return unread(record, "Reading the plan…", k);
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
                    let selected = change
                        .selection()
                        .map(|s| s.text().to_string())
                        .unwrap_or_default();
                    app.choose_plan_span(plan_anchor(&at, &selected));
                })
        }
    };
    let composer = record
        .anchor
        .as_ref()
        .filter(|_| record.editing.is_none())
        .map(|anchor| plan_composer(record, anchor, k));
    let content = col()
        .gap(8.0)
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .children(composer)
        .child(scrolled("plan-scroll", shown));
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

/// The comment box on a span of a plan file: where it is, its quote, the words, Comment and
/// Cancel. Enter saves it and Escape closes it.
fn plan_composer(record: &Record, anchor: &Anchor, k: &Kit) -> El {
    let quote = match anchor {
        Anchor::Plan { quote, .. } => quote.trim().to_string(),
        Anchor::Diff { .. } => String::new(),
    };
    let ready = !record.comment.text.trim().is_empty();
    col()
        .key("plan-composer")
        .role("group")
        .label(anchor_said(anchor).replacen("On ", "Comment on ", 1))
        .gap(8.0)
        .padding(10.0)
        .w_full()
        .radius(k.radius.md)
        .fill(k.c.layer_02)
        .border(1.0, k.c.border_base)
        .child(
            text(anchor_said(anchor).replacen("On ", "Comment on ", 1))
                .font(k.ty.small)
                .color(k.c.text_muted),
        )
        .children((!quote.is_empty()).then(|| {
            row()
                .gap(8.0)
                .w_full()
                .child(rune::el().w(2.0).self_stretch().fill(k.c.border_strong))
                .child(
                    text(quote)
                        .font(k.ty.small)
                        .color(k.c.text_muted)
                        .wrap()
                        .max_lines(3)
                        .grow(1.0)
                        .min_w(0.0),
                )
        }))
        .child(
            TextInput::new(&record.comment)
                .width(None)
                .placeholder("Say what should change")
                .label("Comment on the selection")
                .on_edit(|app: &mut App| {
                    &mut app.record.open.as_mut().expect("an open record").comment
                })
                .on_submit(|app: &mut App, _| app.add_plan_comment())
                .on_key(|app: &mut App, ev: &KeyEvent, tx: &mut Tx| app.comment_key(ev, tx))
                .build(k)
                .key("plan-comment")
                .w_full(),
        )
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new("Comment")
                        .variant(ButtonVariant::Submit)
                        .disabled(!ready)
                        .on_press(App::add_plan_comment)
                        .build(k)
                        .key("add-plan-comment"),
                )
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .on_press(App::close_comment)
                        .build(k)
                        .key("cancel-plan-comment"),
                ),
        )
}

/// The record's width from which the drafts sit beside the tab they comment on.
pub(super) const BESIDE_W: f32 = 1100.0;

/// A tab with the Run's review comment drafts beside it, while it has any.
fn with_drafts(app: &App, record: &Record, tab: El, k: &Kit) -> El {
    let drafts = app.record.drafts_of(record);
    if drafts.is_empty() {
        return tab;
    }
    let tab = col().grow(1.0).min_w(0.0).min_h(0.0).child(tab);
    let panel = review_panel(app, record, drafts, k);
    // Too narrow to keep the tab readable beside them, the drafts sit under it.
    if record.width > 0.0 && record.width < BESIDE_W {
        return col()
            .gap(12.0)
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .child(tab)
            .child(panel.w_full().h(180.0));
    }
    row()
        .gap(12.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .child(tab)
        .child(panel.w(300.0))
}

/// The drafts, who they go to, and Send: one message, as ADR-0051 has it.
fn review_panel(app: &App, record: &Record, drafts: &[Draft], k: &Kit) -> El {
    // A diff's draft is edited under its line while the Diff is shown.
    let inline =
        |draft: &Draft| matches!(draft.anchor, Anchor::Diff { .. }) && app.record_tab() == "diff";
    let rows = drafts.iter().map(|draft| {
        let (edit, gone) = (draft.id.clone(), draft.id.clone());
        let editing = record.editing.as_deref() == Some(draft.id.as_str());
        let body = if editing && !inline(draft) {
            draft_editor(record, &draft.id, k)
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
                            .on_press(move |app: &mut App| app.edit_draft(&edit))
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
        return unread(record, "Reading the review…", k);
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

fn verification_row(
    v: &collie_desktop_protocol::generated::Verification,
    record: &Record,
    k: &Kit,
) -> El {
    use collie_desktop_protocol::generated::GlyphState;
    let passed = v.result == VerificationResult::Pass;
    let expected = crate::flow::written(&v.expect);
    let state = match (&v.result, expected.as_str()) {
        (VerificationResult::Pass, "pass") | (VerificationResult::Fail, "fail") => GlyphState::Done,
        (VerificationResult::Unstable, _) => GlyphState::NeedsYou,
        _ => GlyphState::Failed,
    };
    let result = crate::flow::written(&v.result);
    let by = crate::flow::written(&v.by);
    let title = text(v.name.clone())
        .font(k.ty.mono)
        .color(k.c.text_base)
        .truncate()
        .grow(1.0)
        .min_w(0.0);
    let verdict = text(format!(
        "{result}{}",
        if passed || expected != "pass" {
            format!(", expected {expected}")
        } else {
            String::new()
        }
    ))
    .font(k.ty.text_xsmall)
    .color(k.c.text_muted);
    let ran = text(format!(
        "exit {} · {by} · {}",
        v.exit,
        when_of(&v.at, now())
    ))
    .font(k.ty.text_xsmall)
    .color(k.c.text_faint)
    .w(170.0)
    .align(rune::Align::End);
    evidence_text(
        EvidenceRow {
            key: format!("check-{}", v.id),
            item: format!("verification:{}", v.id),
            label: format!("{}: {result}, expected {expected}", v.name),
            parts: vec![
                crate::flow::glyph::glyph(&state, 14.0, k),
                title,
                verdict,
                ran,
            ],
            aside: None,
        },
        record,
        k,
    )
}

/// A row of the Evidence tab whose item opens under it: a check's output, a kept log, a note.
struct EvidenceRow {
    key: String,
    item: String,
    label: String,
    parts: Vec<El>,
    /// Beside the row, outside its press: a file's Open.
    aside: Option<El>,
}

/// An `EvidenceText.vue`: the row opens and closes on a press, Space or Enter, reading its item
/// the first time; the text is monospace, selectable and scrolls within its box.
fn evidence_text(row_of: EvidenceRow, record: &Record, k: &Kit) -> El {
    let EvidenceRow {
        key,
        item,
        label,
        parts,
        aside,
    } = row_of;
    let open = record.expanded.contains(&item);
    let chevron = if open {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };
    let toggled = item.clone();
    let keyed = item.clone();
    let head = row()
        .key(key.clone())
        .role("button")
        .label(label)
        .expanded(open)
        .focusable(true)
        .focus_ring(2.0, 0.0, k.c.border_focus)
        .gap(10.0)
        .center_y()
        .h(32.0)
        .px(8.0)
        .grow(1.0)
        .min_w(0.0)
        .radius(k.radius.sm)
        .hover(k.c.surface_hover)
        .on_press(move |app: &mut App| app.toggle_evidence(&toggled))
        // Space presses it as any button; Enter too, as a disclosure takes it.
        .on_key(move |app: &mut App, ev: &KeyEvent, _: &mut Tx| {
            let enter = ev.key == Key::Enter && ev.mods == rune::Mods::default();
            if enter {
                app.toggle_evidence(&keyed);
            }
            enter
        })
        .child(
            rune::icon(chevron, 14.0)
                .color(k.c.icon_muted)
                .a11y_hidden(),
        )
        .children(parts);
    let line = row()
        .gap(4.0)
        .center_y()
        .w_full()
        .child(head)
        .children(aside);
    let body = open.then(|| {
        let said = match record.items.get(&item) {
            Some(Item::Read(bytes)) => {
                let plain = super::evidence::without_escapes(&String::from_utf8_lossy(bytes));
                if plain.trim().is_empty() {
                    quiet("It is empty.", k).key(format!("{key}-text"))
                } else {
                    mono(&plain, &format!("{key}-text"), k)
                }
            }
            Some(Item::Failed(why)) => {
                quiet(format!("Could not be read: {why}"), k).key(format!("{key}-failed"))
            }
            _ => quiet("Reading…", k)
                .role("status")
                .key(format!("{key}-reading")),
        };
        col()
            .key(format!("{key}-body"))
            .w_full()
            .max_h(360.0)
            .padding(10.0)
            .radius(k.radius.sm)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(said)
    });
    col()
        .key(format!("{key}-box"))
        .gap(4.0)
        .w_full()
        .child(line)
        .children(body)
}

fn image_box(record: &Record, item: &EvidenceItem, k: &Kit) -> El {
    let key = format!("evidence:{}", item.name);
    let shot = match record.items.get(&key) {
        Some(Item::Image(image)) => rune::el()
            .pixels_fit(image.pixels(), SurfaceFit::Fit)
            .w_full()
            .h(260.0)
            .radius(k.radius.md)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak),
        Some(Item::Failed(why)) => quiet(why.clone(), k),
        _ => quiet("Reading…", k),
    };
    col()
        .key(format!("shot-{}", slug(&item.name)))
        .role("img")
        .label(item.name.clone())
        .gap(6.0)
        .grow(1.0)
        .min_w(0.0)
        .child(shot)
        .child(
            text(item.name.clone())
                .font(k.ty.text_xsmall)
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
        return unread(record, "Reading the evidence…", k);
    };
    let sorted = sort_evidence(&detail.evidence);
    let checks = (!detail.verifications.is_empty()).then(|| {
        let n = detail.verifications.len();
        section(
            "checks",
            &format!("Checks · {n}"),
            k,
            [col().gap(0.0).w_full().children(
                detail
                    .verifications
                    .iter()
                    .map(|v| verification_row(v, record, k)),
            )],
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
    // Logs and notes open under their rows; reports and videos only in the browser.
    let listed = |key: &str, said: &str, files: &[EvidenceItem], prefix: &str, read: bool| {
        (!files.is_empty()).then(|| {
            section(
                key,
                said,
                k,
                files
                    .iter()
                    .map(|f| {
                        let item = format!("{prefix}:{}", f.name);
                        if read {
                            text_file_row(&item, &f.name, f.bytes, record, k)
                        } else {
                            file_row(&item, &f.name, f.bytes, record, k)
                        }
                    })
                    .collect::<Vec<_>>(),
            )
        })
    };
    let reports = listed(
        "reports",
        "Reports, opened sandboxed in the browser",
        &sorted.reports,
        "evidence",
        false,
    );
    let videos = listed("videos", "Videos", &sorted.videos, "evidence", false);
    let files = listed(
        "evidence-files",
        "Logs and files",
        &sorted.files,
        "evidence",
        true,
    );
    let handoffs = detail.handoff_files.clone().flatten().unwrap_or_default();
    let handoffs = listed("handoff-files", "Handoff notes", &handoffs, "handoff", true);
    let m = &detail.outcome.metrics;
    let mut metrics = vec![fact("Rework", format!("{}", m.rework), k)];
    let metrics_of = |rows: Vec<El>| [facts(rows)];
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
    let none = empty.then(|| quiet("This Run has recorded no evidence yet.", k));
    let parts = none
        .into_iter()
        .chain(checks)
        .chain(gallery)
        .chain(reports)
        .chain(videos)
        .chain(files)
        .chain(handoffs)
        .chain([section("metrics", "Metrics", k, metrics_of(metrics))]);
    ruled(col().key("evidence").w_full(), parts, k)
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
        (_, None) => return unread(record, "Reading the log…", k),
    };
    let more = cut.map(|note| {
        let bar = row().key("log-bar").gap(12.0).center_y().w_full().child(
            text("Showing the end of the log")
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .grow(1.0),
        );
        if note.is_empty() {
            bar.child(
                Button::new("Read the whole log")
                    .variant(ButtonVariant::Ghost)
                    .on_press(|app: &mut App| app.read_item("log"))
                    .build(k)
                    .key("log-whole"),
            )
        } else {
            bar.child(
                text(note)
                    .role("status")
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_muted),
            )
        }
    });
    col()
        .key("log")
        .gap(8.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .children(more)
        .child(collie_desktop_chat::glide::smooth::<App>(
            col()
                .key("log-text")
                .grow(1.0)
                .min_h(0.0)
                .w_full()
                .padding(12.0)
                .radius(k.radius.lg)
                .fill(k.c.layer_01)
                .border(1.0, k.c.border_weak)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(mono(&said, "log-lines", k)),
            "log-text",
        ))
}

fn terminal_tab(app: &App, record: &Record, k: &Kit) -> El {
    let agents = app
        .task_of_record()
        .map(|t| t.agents.clone())
        .unwrap_or_default();
    let shown = app.record.terminal_agent.clone();
    let shown_agent = agents.iter().find(|a| Some(&a.name) == shown.as_ref());
    let tabs = agent_tabs(&agents, shown_agent);
    let dot = |state: &str| {
        rune::el()
            .size(6.0, 6.0)
            .radius(3.0)
            .fill(status_tone(state, k).icon)
            .a11y_hidden()
    };
    let switcher = (tabs.len() > 1).then(|| {
        segments(k)
            .key("agent-tabs")
            .role("tablist")
            .label("Agents")
            .focus_group()
            .children(tabs.iter().map(|tab| {
                let name = tab.name.clone();
                let chosen = Some(&tab.name) == shown.as_ref();
                segment(tab.label.clone(), chosen, k)
                    .gap(6.0)
                    .child(dot(&tab.state))
                    .on_press(move |app: &mut App| app.pick_agent(name.clone()))
                    .key(format!("agent-{}", tab.name))
                    .role("tab")
                    .label(match &tab.now {
                        Some(now) => format!("{}, {}: {now}", tab.label, tab.state),
                        None => format!("{}, {}", tab.label, tab.state),
                    })
            }))
    });
    let one = (tabs.len() == 1).then(|| {
        let tab = &tabs[0];
        row()
            .key("agent-one")
            .gap(8.0)
            .center_y()
            .child(dot(&tab.state))
            .child(
                text(tab.label.clone())
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.text_base),
            )
            .child(
                text(match &tab.now {
                    Some(now) => format!("{} · {now}", tab.state),
                    None => tab.state.clone(),
                })
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .truncate()
                .min_w(0.0),
            )
    });
    let away = (!app.record_live()).then(|| {
        pill(
            "terminal-away",
            "Out of reach · last drawn",
            "Its Machine is out of reach; this is what the pane last drew.",
            k.c.warning,
            k,
        )
    });
    let link = app
        .terminal
        .as_ref()
        .map_or(Link::Connecting, |tab| tab.link());
    let (said, tone) = match &link {
        Link::Connecting => ("Connecting…", status_tone("", k)),
        Link::Live => ("Connected", k.c.success),
        Link::NoPane => ("No pane", k.c.warning),
        Link::Failed(_) => ("Not connected", k.c.danger),
        Link::Ended(_) => ("Disconnected", k.c.danger),
    };
    let status = pill("terminal-link", said, &format!("Pane: {said}"), tone, k);
    let place = app
        .terminal
        .as_ref()
        .and_then(|tab| tab.place())
        .map(|place| {
            text(place)
                .key("terminal-where")
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .truncate()
                .min_w(0.0)
        });
    let bar = row()
        .key("terminal-bar")
        .gap(12.0)
        .center_y()
        .w_full()
        .h(32.0)
        .children(switcher)
        .children(one)
        .children(place)
        .child(rune::spacer())
        .children(away)
        .child(status);
    let plain = |why: &str| crate::shell::panes::plainly(why, &record.machine);
    let why = match &link {
        Link::Failed(why) => Some(format!("Couldn't connect to the pane: {}", plain(why))),
        Link::Ended(why) => Some(format!("The pane disconnected: {}", plain(why))),
        Link::NoPane => Some("This Run has no live agent's pane to show here.".to_string()),
        Link::Connecting | Link::Live => None,
    };
    let ended = why.map(|why| {
        let danger = !matches!(link, Link::NoPane);
        row()
            .key("terminal-ended")
            .role(if danger { "alert" } else { "status" })
            .label(why.clone())
            .gap(12.0)
            .center_y()
            .w_full()
            .child(
                text(why)
                    .font(k.ty.small)
                    .color(if danger {
                        k.c.danger.fg
                    } else {
                        k.c.text_muted
                    })
                    .wrap()
                    .grow(1.0)
                    .min_w(0.0)
                    .a11y_hidden(),
            )
            .child(
                Button::new("Reconnect")
                    .variant(ButtonVariant::Outline)
                    .on_press(|app: &mut App| app.reconnect())
                    .build(k)
                    .key("terminal-reconnect"),
            )
    });
    let waiting = |key: &str, said: &str| {
        col()
            .key(key.to_string())
            .role("status")
            .label(said.to_string())
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .center()
            .gap(8.0)
            .child(rune::icon(&icons::TERMINAL, 20.0).color(k.c.icon_faint))
            .child(
                text(said.to_string())
                    .font(k.ty.small)
                    .color(k.c.text_muted)
                    .a11y_hidden(),
            )
    };
    let over = match &link {
        Link::Connecting => Some(waiting("terminal-connecting", "Connecting to the pane…")),
        Link::NoPane => Some(waiting("terminal-no-pane", "No pane to show")),
        Link::Failed(_) => Some(waiting("terminal-not-connected", "Not connected")),
        Link::Live | Link::Ended(_) => None,
    };
    let grid = app.terminal.as_ref().map(|tab| {
        // The pane sits on the record's own surface: what a program leaves default is the app's.
        tab.set_surface(rgb_of(k.c.text_base), rgb_of(k.c.bg_base));
        terminal(tab, |app: &mut App| app.terminal.as_mut())
    });
    col()
        .key("terminal-tab")
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .gap(8.0)
        .instant_changes()
        .transition(Transition::none())
        .child(bar)
        .children(ended)
        .child(
            col()
                .key("terminal-body")
                .grow(1.0)
                .min_h(0.0)
                .w_full()
                .children(grid)
                .children(over),
        )
}

/// A small rounded status, in `tone`.
fn pill(key: &str, said: &str, label: &str, tone: rune_kit::StateColors, k: &Kit) -> El {
    row()
        .key(key.to_string())
        .role("status")
        .label(label.to_string())
        .gap(6.0)
        .center_y()
        .h(22.0)
        .px(8.0)
        .radius(11.0)
        .fill(tone.bg)
        .child(
            text(said.to_string())
                .font(k.ty.text_xsmall_medium)
                .color(tone.fg)
                .a11y_hidden(),
        )
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
    ruled(
        col().key("facts").max_w(READING_W).w_full(),
        [facts(rows)].into_iter().chain(agents).chain(steering),
        k,
    )
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
