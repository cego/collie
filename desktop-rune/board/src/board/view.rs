//! The Board drawn: the header sentence, the board's own trouble, alerts, then the sections
//! of cards, as `FlockBoard.vue` and `BoardCard.vue` lay them out, in Rune's own look.

use super::cards::{self, CardAction};
use super::model::{Placed, Section, fold_finished, fold_waiting, not_live_title, section_of};
use super::{answers, as_of_said, dialogs};
use crate::record::flow_of;
use crate::shell::Page;
use crate::{App, flow, icons};
use collie_desktop_protocol::generated::{Decision, GlyphState, LostState, State};
use rune::{Color, El, Icon, Key, LiveRegion, col, el, icon, row, text};
use rune_kit::{
    Button, ButtonVariant, Collapsible, ControlSize, IconButton, IconButtonVariant, Kit, Menu,
    MenuItem, Toast, ToastRegion,
};
use std::collections::HashMap;

const CARD_MIN: f32 = 300.0;
const GAP: f32 = 12.0;
const PAD: f32 = 24.0;

/// The board with its overlays in the window's own layer.
pub fn view_in(app: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    let board = &app.board;
    let placed = app.placed();
    let ids = card_ids(&placed);
    let mrs: HashMap<String, Vec<cards::FlockMr>> = cards::flock_mrs(&placed).into_iter().collect();
    let columns = if board.width > 0.0 {
        (((board.width - 2.0 * PAD + GAP) / (CARD_MIN + GAP)).floor() as usize).max(1)
    } else {
        3
    };
    let draw = |cards: &[&Placed<'_>], layer: &mut Vec<El>| {
        grid(
            cards
                .iter()
                .map(|p| card(app, k, p, &ids[&p.key], mrs.get(&p.key), layer))
                .collect(),
            columns,
        )
    };

    let mut body = col().key("board-body").w_full().gap(20.0);
    body = body.child(header(app, k, &placed));
    body = body.children(trouble(app, k));
    let connecting = !board.flock.heard
        && app.machines.is_empty()
        && board.trouble.is_none()
        && app.ended.is_none();
    if connecting {
        body = body.child(
            text("Connecting…")
                .key("connecting")
                .font(k.ty.ui)
                .color(k.c.text_muted)
                .role("status"),
        );
    } else {
        body = body.children(alerts(app, k));
        if placed.is_empty() {
            body = body.child(
                text("Nothing on the board yet.")
                    .key("board-empty")
                    .font(k.ty.ui)
                    .color(k.c.text_muted),
            );
        }
        let now = board.now();
        for section in Section::ALL {
            let all: Vec<Placed<'_>> = placed
                .iter()
                .filter(|p| section_of(p.task) == section)
                .cloned()
                .collect();
            if all.is_empty() {
                continue;
            }
            let mut part = col()
                .key(section.key())
                .role("group")
                .label(format!("{}, {}", section.label(), all.len()))
                .gap(10.0)
                .w_full();
            match section {
                Section::Finished => {
                    let (unseen, seen) = fold_finished(&all);
                    part = part.child(section_heading(k, section, all.len()));
                    if !unseen.is_empty() {
                        part = part.child(draw(&unseen, layer));
                    }
                    if !seen.is_empty() {
                        let open = board.finished_open;
                        let title = if unseen.is_empty() {
                            format!("{} finished", seen.len())
                        } else {
                            format!("{} seen", seen.len())
                        };
                        part = part.child(fold(
                            k,
                            "finished-seen",
                            title,
                            open,
                            |app: &mut App| app.board.finished_open ^= true,
                            open.then(|| draw(&seen, layer)),
                        ));
                    }
                }
                Section::Waiting => {
                    let (recent, older) = fold_waiting(&all, now);
                    part = part
                        .child(section_heading(k, section, recent.len()))
                        .child(draw(&recent, layer));
                    if !older.is_empty() {
                        let open = board.older_open;
                        part = part.child(fold(
                            k,
                            "waiting-older",
                            format!("{} older than a week", older.len()),
                            open,
                            |app: &mut App| app.board.older_open ^= true,
                            open.then(|| draw(&older, layer)),
                        ));
                    }
                }
                _ => {
                    let every: Vec<&Placed<'_>> = all.iter().collect();
                    part = part
                        .child(section_heading(k, section, all.len()))
                        .child(draw(&every, layer));
                }
            }
            body = body.child(part);
        }
    }

    let scroll = col()
        .key("board-scroll")
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .padding(PAD)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .on_layout(|app: &mut App, rect: [f32; 4]| {
            if (app.board.width - rect[2]).abs() > 0.5 {
                app.board.width = rect[2];
            }
        })
        .on_press(|app: &mut App| {
            app.gesture(super::clicks::Gesture::Click(
                super::clicks::Landed::Background,
            ))
        })
        .role("main")
        .label("Board")
        .children(app.flow.as_ref().map(|map| flow::flow_map(map, flow_of, k)))
        .child(body);
    dialogs::dialog(app, k, layer);
    if !board.notices.is_empty() {
        layer.push(notices(app, k));
    }
    col()
        .key("board")
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .on_key(|app: &mut App, key: &rune::KeyEvent, _| {
            if key.key != Key::Escape {
                return false;
            }
            let overlay = app.board.dialog.is_some() || app.board.menu.is_some();
            app.gesture(super::clicks::Gesture::Escape {
                overlay,
                typing: false,
            });
            !overlay
        })
        .child(scroll)
}

/// The board, its overlays drawn over it alone.
pub fn view(app: &App, k: &Kit) -> El {
    let mut layer = Vec::new();
    let board = view_in(app, k, &mut layer);
    el().key("board-root")
        .w_full()
        .h_full()
        .child(board.w_full().h_full())
        .children(layer)
}

/// Each card's element id: `card-<task id>`, or with its installation where two Machines
/// share a task id.
fn card_ids(placed: &[Placed<'_>]) -> HashMap<String, String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for p in placed {
        *counts.entry(p.task.id.as_str()).or_default() += 1;
    }
    placed
        .iter()
        .map(|p| {
            let id = if counts[p.task.id.as_str()] > 1 {
                format!("card-{}-{}", p.installation, p.task.id)
            } else {
                format!("card-{}", p.task.id)
            };
            (p.key.clone(), id)
        })
        .collect()
}

fn grid(cards: Vec<El>, columns: usize) -> El {
    let mut rows = col().gap(GAP).w_full();
    let mut cards = cards.into_iter().peekable();
    let mut at = 0;
    while cards.peek().is_some() {
        let line: Vec<El> = cards.by_ref().take(columns).collect();
        rows = rows.child(
            el().key(format!("row-{at}"))
                .w_full()
                .equal_columns(columns)
                .gap(GAP)
                .items_start()
                .children(line),
        );
        at += 1;
    }
    rows
}

fn header(app: &App, k: &Kit, placed: &[Placed<'_>]) -> El {
    let tasks: Vec<_> = placed.iter().map(|p| p.task).collect();
    let (said, urgent) = super::model::header_sentence(&tasks, Some(app.board.now()));
    let said = if app.board.flock.heard || !app.machines.is_empty() {
        said
    } else {
        String::new()
    };
    let color = if urgent {
        k.c.warning.fg
    } else {
        k.c.text_muted
    };
    let font = if urgent { k.ty.ui_medium } else { k.ty.ui };
    row()
        .key("board-header")
        .w_full()
        .center_y()
        .gap(8.0)
        .children(urgent.then(|| {
            icon(&icons::WARNING, 14.0)
                .color(k.c.warning.icon)
                .a11y_hidden()
        }))
        .child(
            text(said.clone())
                .key("header")
                .font(font)
                .color(color)
                .role("status")
                .label(said)
                .live_region(LiveRegion::Polite)
                .truncate(),
        )
}

fn callout(
    k: &Kit,
    key: String,
    glyph: &'static Icon,
    tone: Color,
    title: String,
    description: String,
    action: Option<El>,
) -> El {
    let words = col()
        .grow(1.0)
        .shrink()
        .gap(2.0)
        .child(
            text(title.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .wrap()
                .w_full(),
        )
        .children((!description.is_empty()).then(|| {
            text(description.clone())
                .font(k.ty.ui)
                .color(k.c.text_muted)
                .wrap()
                .w_full()
        }));
    row()
        .key(key)
        .role("alert")
        .label(title)
        .description(description)
        .w_full()
        .items_start()
        .gap(10.0)
        .padding(12.0)
        .radius(8.0)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(
            el().size(16.0, 18.0)
                .center()
                .child(icon(glyph, 16.0).color(tone))
                .a11y_hidden(),
        )
        .child(words)
        .children(action)
}

/// The board's own subscription in trouble, or ended.
fn trouble(app: &App, k: &Kit) -> Vec<El> {
    let retry = |k: &Kit| {
        Button::new("Retry now")
            .variant(ButtonVariant::Outline)
            .control_size(ControlSize::Small)
            .on_press(App::retry_flock)
            .build(k)
            .key("retry-now")
    };
    if let Some(trouble) = &app.board.trouble {
        let seconds = ((trouble.at - app.board.now()) / 1000.0).ceil();
        let when = if seconds > 0.0 {
            format!("Trying again in {seconds} s.")
        } else {
            "Trying again now.".to_string()
        };
        return vec![callout(
            k,
            "retrying".into(),
            &icons::REFRESH,
            k.c.warning.icon,
            "Desktop is reconnecting to its Flock; showing what it last had".into(),
            format!("{}. {when}", trouble.said),
            Some(retry(k)),
        )];
    }
    match &app.ended {
        Some(why) => vec![callout(
            k,
            "flock-ended".into(),
            &icons::REFRESH,
            k.c.warning.icon,
            "Desktop stopped hearing from its Flock; showing what it last had".into(),
            why.trim_end_matches('.').to_string(),
            Some(retry(k)),
        )],
        None => Vec::new(),
    }
}

fn alerts(app: &App, k: &Kit) -> Vec<El> {
    let mut all = Vec::new();
    if let Some(expires) = app.renew_by() {
        all.push(callout(
            k,
            "renew-gitlab".into(),
            &icons::KEY,
            k.c.warning.icon,
            format!("The GitLab token expires on {expires}"),
            "Make a new one and Renew it, and every Machine gets it.".into(),
            Some(
                Button::new("Renew")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(|app: &mut App| app.open_page(Page::Settings))
                    .build(k)
                    .key("renew"),
            ),
        ));
    }
    for (profile, lost) in app.board.flock.lost.iter() {
        let glyph = match lost.state {
            LostState::Unreachable => &icons::UNPLUG,
            LostState::Sso => &icons::KEY,
            LostState::NoCollie | LostState::UpdateDesktop => &icons::WARNING,
        };
        let onboard = (lost.state == LostState::NoCollie).then(|| {
            Button::new("Onboard")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(|app: &mut App| app.open_page(Page::Machines))
                .build(k)
                .key(format!("onboard-{profile}"))
        });
        all.push(callout(
            k,
            format!("lost-{profile}"),
            glyph,
            k.c.warning.icon,
            not_live_title(&lost.state, &lost.name),
            lost.reason.clone(),
            onboard,
        ));
    }
    all
}

fn section_heading(k: &Kit, section: Section, count: usize) -> El {
    let tone = match section {
        Section::NeedsYou => k.c.warning.fg,
        _ => k.c.text_muted,
    };
    row()
        .gap(8.0)
        .center_y()
        .a11y_hidden()
        .child(text(section.label()).font(k.ty.small_medium).color(tone))
        .child(
            text(count.to_string())
                .font(k.ty.small)
                .color(k.c.text_faint),
        )
}

fn fold(
    k: &Kit,
    key: &str,
    title: String,
    open: bool,
    toggle: impl Fn(&mut App) + 'static,
    inside: Option<El>,
) -> El {
    let mut fold = Collapsible::new(title, open).ghost().on_toggle(toggle);
    if let Some(inside) = inside {
        fold = fold.child(inside);
    }
    fold.build(k).key(key.to_string())
}

fn glyph_color(k: &Kit, state: &GlyphState) -> (Color, bool) {
    match state {
        GlyphState::Done => (k.c.success.icon, true),
        GlyphState::Running => (k.c.info.icon, true),
        GlyphState::NeedsYou => (k.c.warning.icon, true),
        GlyphState::Failed => (k.c.danger.icon, true),
        GlyphState::Waiting => (k.c.text_muted, true),
        GlyphState::Stopped => (k.c.text_muted, false),
        GlyphState::NotRun | GlyphState::Expected => (k.c.text_faint, false),
    }
}

fn dot(k: &Kit, state: &GlyphState) -> El {
    let (color, filled) = glyph_color(k, state);
    let d = el().size(7.0, 7.0).radius(3.5);
    if filled {
        d.fill(color)
    } else {
        d.border(1.0, color)
    }
}

fn state_tone(k: &Kit, state: &State) -> Color {
    match state {
        State::Blocked => k.c.warning.icon,
        State::Active => k.c.info.icon,
        State::Quiet => k.c.text_muted,
        State::Failed => k.c.danger.icon,
        State::Done => k.c.success.icon,
        State::Stopped | State::Abandoned => k.c.text_faint,
    }
}

/// A card action as this board does it, or none where Desktop has no way to yet.
fn label_of(action: &CardAction, primary: bool) -> Option<String> {
    Some(match action {
        CardAction::GoToTab => "Go to pane".into(),
        CardAction::CheckOutput | CardAction::Attach => return None,
        CardAction::Steer => "Steer…".into(),
        CardAction::OpenMr { mr, named } => {
            mr.url()?;
            cards::open_mr_label(mr, primary, named.as_deref())
        }
        CardAction::Offer(offer) => offer.title.clone(),
        CardAction::Offers => "What it offers…".into(),
        CardAction::Resume => (if primary { "Resume" } else { "Resume run" }).into(),
        CardAction::FollowUp => "Follow-up run".into(),
        CardAction::Hold { set } => (if *set { "Hold run" } else { "Release hold" }).into(),
        CardAction::Stop => "Stop run".into(),
        CardAction::Dispose {
            disposition, named, ..
        } => cards::dispose_label(*disposition, named.as_deref()),
        CardAction::Acknowledge => "Acknowledge".into(),
    })
}

fn small_button(label: String, variant: ButtonVariant) -> Button {
    Button::new(label)
        .variant(variant)
        .control_size(ControlSize::Small)
}

fn card(
    app: &App,
    k: &Kit,
    p: &Placed<'_>,
    id: &str,
    mrs: Option<&Vec<cards::FlockMr>>,
    layer: &mut Vec<El>,
) -> El {
    let task = p.task;
    let key = p.key.clone();
    let live = p.as_of.is_none();
    let selected = app.board.selected.as_deref() == Some(key.as_str());
    let c = &k.c;

    // The name, the state and what the card can be asked for.
    let mut badges = row().gap(6.0).center_y();
    if task.unseen == Some(true) {
        badges = badges.child(
            text("Unseen")
                .key("unseen")
                .font(k.ty.small_medium)
                .color(c.info.fg)
                .role("status")
                .label("Unseen"),
        );
    }
    let menu_actions: Vec<(CardAction, String)> = cards::card_actions(task)
        .into_iter()
        .chain(cards::disposition_actions(task))
        .filter_map(|a| label_of(&a, false).map(|l| (a, l)))
        .collect();
    let open = app.board.menu.as_deref() == Some(key.as_str());
    let trigger = IconButton::new(&icons::MORE)
        .variant(IconButtonVariant::Ghost)
        .control_size(ControlSize::Small)
        .label(format!("Actions for {}", task.name))
        .disabled(!live)
        .expanded(open)
        .on_press({
            let key = key.clone();
            move |app: &mut App| {
                app.board.menu = if app.board.menu.as_deref() == Some(key.as_str()) {
                    None
                } else {
                    Some(key.clone())
                }
            }
        })
        .build(k)
        .key(format!("{id}-menu"));
    let mut menu = Menu::new(format!("{id}-actions"))
        .trigger(trigger)
        .open(open)
        .placement(rune_kit::Placement::BottomEnd)
        .on_close(|app: &mut App| app.board.menu = None);
    for (action, label) in menu_actions {
        let key = key.clone();
        menu = menu.item(
            MenuItem::new(label)
                .danger(action == CardAction::Stop)
                .on_select(move |app: &mut App| app.do_action(&key, &action)),
        );
    }
    let menu = menu.build(k, layer);
    let title = row()
        .w_full()
        .items_start()
        .gap(8.0)
        .child(
            el().size(8.0, 18.0)
                .center()
                .child(
                    el().size(8.0, 8.0)
                        .radius(4.0)
                        .fill(state_tone(k, &task.state)),
                )
                .a11y_hidden(),
        )
        .child(
            text(task.name.clone())
                .key("name")
                .font(k.ty.ui_medium)
                .color(c.text_base)
                .wrap()
                .max_lines(2)
                .grow(1.0)
                .shrink()
                .a11y_hidden(),
        )
        .child(badges)
        .child(
            text(cards::state_label(&task.state))
                .key("state")
                .font(k.ty.small)
                .color(c.text_faint)
                .a11y_hidden(),
        )
        .child(menu);

    let mut card = col()
        .w_full()
        .gap(8.0)
        .padding(12.0)
        .radius(8.0)
        .fill(if task.state == State::Blocked {
            k.alpha(c.warning.bg, 0.5)
        } else {
            c.layer_01
        })
        .border(
            if selected { 1.5 } else { 1.0 },
            if selected {
                c.border_focus
            } else if task.state == State::Blocked {
                c.warning.border
            } else {
                c.border_weak
            },
        )
        .hover(c.surface_hover)
        .child(title);
    let place = cards::repo_and_branch(task);
    if !place.is_empty() {
        card = card.child(
            text(place)
                .key("repo")
                .font(k.ty.small)
                .color(c.text_faint)
                .truncate()
                .w_full(),
        );
    }
    card = card.child(
        text(task.sentence.clone())
            .key("sentence")
            .font(k.ty.ui)
            .color(c.text_muted)
            .wrap()
            .max_lines(3)
            .w_full(),
    );

    // Its merge requests, where it has several or another Machine holds one too.
    if let Some(mrs) = mrs {
        let mut list = col().key("mrs").gap(4.0).w_full();
        for (at, one) in mrs.iter().enumerate() {
            let mut line = row()
                .key(format!("mr-{at}"))
                .w_full()
                .gap(6.0)
                .center_y()
                .child(
                    text(one.mr.line.clone())
                        .font(k.ty.small)
                        .color(c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .shrink(),
                );
            if let Some((label, url)) = &one.mr.open {
                let url = url.clone();
                line = line.child(
                    small_button(label.clone(), ButtonVariant::GhostMuted)
                        .on_press(move |app: &mut App| app.open_link(url.clone()))
                        .build(k)
                        .key(format!("{id}-mr-{at}-open")),
                );
            }
            if one.links.len() > 1 {
                for link in &one.links {
                    let to = link.key.clone();
                    line = line.child(
                        small_button(format!("on {}", link.machine), ButtonVariant::GhostFaint)
                            .on_press(move |app: &mut App| app.open_card(&to))
                            .build(k),
                    );
                }
            }
            list = list.child(line);
        }
        card = card.child(list);
    }

    // Its Flow strip, which opens its record.
    if let Some(strip) = cards::card_flow(task.flow.as_ref()) {
        let glyphs = row()
            .gap(3.0)
            .center_y()
            .a11y_hidden()
            .children(strip.run.iter().map(|(g, folded)| {
                match folded {
                    Some(n) => row()
                        .gap(3.0)
                        .center_y()
                        .child(dot(k, &g.state))
                        .child(text(format!("{n}")).font(k.ty.small).color(c.text_faint)),
                    None => dot(k, &g.state).help(g.title.clone()),
                }
            }))
            .children((!strip.release.is_empty()).then(|| {
                row()
                    .gap(3.0)
                    .ml(6.0)
                    .center_y()
                    .children(strip.release.iter().map(|g| dot(k, &g.state)))
            }));
        let open = key.clone();
        card = card.child(
            row()
                .key(format!("{id}-flow"))
                .w_full()
                .gap(8.0)
                .center_y()
                .radius(4.0)
                .focusable(live)
                .on_press(move |app: &mut App| app.open_card(&open))
                .role("button")
                .label(strip.name.clone())
                .child(glyphs)
                .child(
                    text(strip.label)
                        .font(k.ty.small)
                        .color(c.text_muted)
                        .truncate()
                        .grow(1.0)
                        .shrink()
                        .a11y_hidden(),
                ),
        );
    }
    if let Some(held) = &task.held {
        card = card.child(
            text(held.clone())
                .key("held")
                .font(k.ty.small)
                .color(c.text_muted)
                .wrap()
                .w_full(),
        );
    }
    if let Some(drift) = &task.drift {
        card = card.child(
            text(drift.clone())
                .key("drift")
                .font(k.ty.small)
                .color(c.warning.fg)
                .wrap()
                .w_full(),
        );
    }

    // What it asks: questions, or a proposal to review.
    if let Some(asked) = answers::card_question(task, p.installation, &app.board.answering) {
        let mut block = col().key("question").gap(6.0).w_full().child(
            text(asked.text)
                .font(k.ty.ui_medium)
                .color(c.text_base)
                .wrap()
                .max_lines(2)
                .w_full(),
        );
        block = match (asked.pending, asked.label) {
            (Some(pending), _) => block.child(
                text(pending)
                    .key("pending-answer")
                    .font(k.ty.small)
                    .color(c.text_muted)
                    .role("status")
                    .live_region(LiveRegion::Polite)
                    .wrap()
                    .w_full(),
            ),
            (None, Some(label)) => {
                let key = key.clone();
                block.child(
                    small_button(label, ButtonVariant::Neutral)
                        .disabled(!live)
                        .on_press(move |app: &mut App| app.answer_questions(&key))
                        .build(k)
                        .key(format!("{id}-answer")),
                )
            }
            (None, None) => block,
        };
        card = card.child(block);
    } else if let Some(Decision::Proposal(proposal)) = &task.decision {
        let key = key.clone();
        card = card.child(
            col()
                .key("proposal")
                .gap(6.0)
                .w_full()
                .child(
                    text(proposal.text.clone())
                        .font(k.ty.ui_medium)
                        .color(c.text_base)
                        .wrap()
                        .max_lines(2)
                        .w_full(),
                )
                .child(
                    small_button("Review…".into(), ButtonVariant::Neutral)
                        .disabled(!live)
                        .on_press(move |app: &mut App| app.review(&key))
                        .build(k)
                        .key(format!("{id}-review")),
                ),
        );
    }

    // Where it is, how old, as of when, its agents; and the one action that ends its wait.
    let agents = match task.agents.len() {
        0 => None,
        1 => Some("1 agent".to_string()),
        n => Some(format!("{n} agents")),
    };
    let offset = app.board.utc_offset.unwrap_or_else(super::local_offset);
    let foot: Vec<String> = [
        (!p.place.is_empty()).then(|| p.place.clone()),
        Some(task.age.clone()),
        p.as_of.map(|at| as_of_said(at, offset)),
        agents,
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut footer = row().key("footer").w_full().gap(8.0).center_y().child(
        text(foot.join(" · "))
            .key("facts")
            .font(k.ty.small)
            .color(c.text_faint)
            .truncate()
            .grow(1.0)
            .shrink(),
    );
    if let Some((action, label)) =
        cards::primary_action(task).and_then(|a| label_of(&a, true).map(|l| (a, l)))
    {
        let key = key.clone();
        footer = footer.child(
            small_button(label, ButtonVariant::Outline)
                .disabled(!live)
                .on_press(move |app: &mut App| app.do_action(&key, &action))
                .build(k)
                .key(format!("{id}-primary")),
        );
    }
    card = card.child(footer);

    let (press, double, enter) = (key.clone(), key.clone(), key.clone());
    let card = card
        .key(id.to_string())
        .on_press(move |app: &mut App| app.click_card(&press, false))
        .on_double_press(move |app: &mut App| app.click_card(&double, true))
        .focusable(true)
        .on_key(move |app: &mut App, pressed: &rune::KeyEvent, _| {
            if pressed.key == Key::Enter && app.placed_by(&enter).is_some_and(|p| p.as_of.is_none())
            {
                app.open_card(&enter);
                return true;
            }
            false
        })
        .role("button")
        .label(task.name.clone())
        .description(task.sentence.clone())
        .checked(selected);
    if live { card } else { card.opacity(0.55) }
}

fn notices(app: &App, k: &Kit) -> El {
    let mut region = ToastRegion::new();
    for notice in &app.board.notices {
        let id = notice.id;
        let mut toast = Toast::new(format!("notice-{id}"), notice.title.clone())
            .on_close(move |app: &mut App| app.dismiss(id));
        if !notice.ok {
            toast = toast
                .lead(icon(&icons::WARNING, 16.0).color(k.c.danger.icon))
                .action(k, "Try again", true, move |app: &mut App, _| {
                    app.try_again(id)
                });
        }
        region = region.toast(toast.build(k));
    }
    region.build(k)
}
