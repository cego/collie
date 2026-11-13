//! The Board drawn: the header sentence, the board's own trouble, alerts, then the sections
//! of cards, as `FlockBoard.vue` and `BoardCard.vue` lay them out, in Rune's own look.

use super::cards::{self, CardAction};
use super::model::{
    self, Placed, Section, fold_finished, fold_waiting, not_live_title, section_of,
};
use super::{answers, as_of_said, dialogs};
use crate::record::flow_of;
use crate::record::tabs::recovery_of;
use crate::shell::Page;
use crate::{App, flow, icons};
use collie_desktop_chat::glide::smooth;
use collie_desktop_protocol::generated::{Decision, GlyphState, LostState, State, Task};
use rune::{Color, El, Icon, Key, LiveRegion, col, el, icon, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Loader, Menu, MenuItem,
    StateColors, Toast, ToastRegion,
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

    let mut body = col().key("board-body").w_full().gap(28.0);
    if board.columns.replace(columns) != columns {
        body = body.instant_changes();
    }
    let connecting = !board.flock.heard
        && app.machines.is_empty()
        && board.trouble.is_none()
        && app.ended.is_none();
    if connecting {
        body = body.child(connecting_placeholder(app, k));
    } else {
        let reaching = model::reaching(&app.machines, &board.flock);
        let mut top = col().w_full().gap(10.0).child(header(app, k, &placed));
        if let Some(said) = model::reaching_said(&reaching, app.offset()) {
            top = top.child(reaching_line(k, said));
        }
        top = top.children(trouble(app, k)).children(alerts(app, k));
        body = body.child(top);
        if placed.is_empty() && reaching.is_empty() {
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
                    let open = board.finished_open;
                    let toggle = |app: &mut App| app.board.finished_open ^= true;
                    if unseen.is_empty() {
                        part = part.child(disclosure(
                            k,
                            "finished-seen",
                            section_title(k, section, all.len(), None),
                            format!("{} finished", seen.len()),
                            open,
                            toggle,
                        ));
                    } else {
                        part = part
                            .child(section_heading(
                                k,
                                section,
                                all.len(),
                                Some(format!("{} unseen", unseen.len())),
                            ))
                            .child(draw(&unseen, layer));
                        if !seen.is_empty() {
                            let title = format!("{} seen", seen.len());
                            part = part.child(disclosure(
                                k,
                                "finished-seen",
                                fold_title(k, &title),
                                title,
                                open,
                                toggle,
                            ));
                        }
                    }
                    if open && !seen.is_empty() {
                        part = part.child(draw(&seen, layer));
                    }
                }
                Section::Waiting => {
                    let (recent, older) = fold_waiting(&all, now);
                    part = part.child(section_heading(k, section, recent.len(), None));
                    if !recent.is_empty() {
                        part = part.child(draw(&recent, layer));
                    }
                    if !older.is_empty() {
                        let open = board.older_open;
                        let title = format!("{} older than a week", older.len());
                        part = part.child(disclosure(
                            k,
                            "waiting-older",
                            fold_title(k, &title),
                            title,
                            open,
                            |app: &mut App| app.board.older_open ^= true,
                        ));
                        if open {
                            part = part.child(draw(&older, layer));
                        }
                    }
                }
                _ => {
                    let every: Vec<&Placed<'_>> = all.iter().collect();
                    part = part
                        .child(section_heading(k, section, all.len(), None))
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
        .pt(20.0)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .scroll_anchor()
        .scroll_edge_fade(16.0)
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
        .children(
            app.flow
                .as_ref()
                .map(|map| flow::flow_map(map, flow_of, App::step_chosen, k)),
        )
        .child(body);
    let scroll = smooth::<App>(scroll, "board-scroll");
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

/// Before the core has said anything: that the board is coming.
fn connecting_placeholder(app: &App, k: &Kit) -> El {
    col()
        .w_full()
        .pt(140.0)
        .gap(12.0)
        .items_center()
        .child(collie_desktop_theme::mark(&app.chat.logo, 48.0).mb(4.0))
        .child(Loader::new().size(20.0).build(k).a11y_hidden())
        .child(
            text("Connecting to your Flock…")
                .key("connecting")
                .font(k.ty.ui_medium)
                .color(k.c.text_base)
                .role("status")
                .live_region(LiveRegion::Polite),
        )
        .child(
            text("Each Machine's saved board shows as soon as Desktop reads it.")
                .font(k.ty.small)
                .color(k.c.text_faint),
        )
}

/// Which Machines are still being reached, said quietly over what they last showed.
fn reaching_line(k: &Kit, said: String) -> El {
    row()
        .key("reaching")
        .w_full()
        .gap(8.0)
        .center_y()
        .role("status")
        .label(said.clone())
        .live_region(LiveRegion::Polite)
        .child(Loader::new().size(13.0).build(k).a11y_hidden())
        .child(
            text(said)
                .font(k.ty.small)
                .color(k.c.text_muted)
                .truncate()
                .grow(1.0)
                .shrink()
                .a11y_hidden(),
        )
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

/// The element id of the card keyed `key`, as the board draws it.
pub(super) fn card_id(app: &App, key: &str) -> Option<String> {
    card_ids(&app.placed()).remove(key)
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
        k.c.text_base
    };
    row()
        .key("board-header")
        .w_full()
        .center_y()
        .gap(8.0)
        .children(urgent.then(|| {
            icon(&icons::WARNING, 15.0)
                .color(k.c.warning.fg)
                .a11y_hidden()
        }))
        .child(
            text(said.clone())
                .key("header")
                .font(k.ty.body_medium)
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
        .fill(k.alpha(k.c.warning.bg, 0.45))
        .border(1.0, k.alpha(k.c.warning.border, 0.55))
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
            k.c.warning.fg,
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
            k.c.warning.fg,
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
            k.c.warning.fg,
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
            let machine = profile.to_string();
            Button::new("Onboard")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |app: &mut App| app.onboard_on(&machine, None))
                .build(k)
                .key(format!("onboard-{profile}"))
        });
        all.push(callout(
            k,
            format!("lost-{profile}"),
            glyph,
            k.c.warning.fg,
            not_live_title(&lost.state, &lost.name),
            lost.reason.clone(),
            onboard,
        ));
    }
    all
}

/// A section's name and how many cards it holds, in its tone.
fn section_title(k: &Kit, section: Section, count: usize, note: Option<String>) -> El {
    let tone = match section {
        Section::NeedsYou => k.c.warning,
        Section::ReadyToShip | Section::Waiting => collie_desktop_theme::tones(k.dark).ready,
        Section::Working => k.c.info,
        Section::Finished => k.c.success,
    };
    row()
        .gap(8.0)
        .center_y()
        .a11y_hidden()
        .child(text(section.label()).font(k.ty.ui_medium).color(tone.fg))
        .child(
            el().px(6.0)
                .h(18.0)
                .radius(9.0)
                .fill(tone.bg)
                .center()
                .child(
                    text(count.to_string())
                        .font(k.ty.text_xsmall_medium)
                        .color(tone.fg),
                ),
        )
        .children(note.map(|note| text(note).font(k.ty.small).color(k.c.info.fg)))
}

fn section_heading(k: &Kit, section: Section, count: usize, note: Option<String>) -> El {
    row()
        .h(28.0)
        .center_y()
        .child(section_title(k, section, count, note))
}

/// A fold's own title, quieter than a section's.
fn fold_title(k: &Kit, title: &str) -> El {
    text(title.to_string())
        .font(k.ty.small_medium)
        .color(k.c.text_muted)
        .a11y_hidden()
}

/// A row that opens and closes what follows it, with a chevron that says which.
fn disclosure(
    k: &Kit,
    key: &str,
    title: El,
    label: String,
    open: bool,
    toggle: impl Fn(&mut App) + 'static,
) -> El {
    let chevron = if open {
        &icons::CHEVRON_DOWN
    } else {
        &icons::CHEVRON_RIGHT
    };
    row()
        .key(key.to_string())
        .role("button")
        .label(label)
        .expanded(open)
        .focusable(true)
        .focus_ring(2.0, 1.0, k.c.border_focus)
        .gap(6.0)
        .h(28.0)
        .pl(4.0)
        .pr(10.0)
        // The chevron hangs in the margin, so the title lines up with the sections' own.
        .ml(-24.0)
        .radius(6.0)
        .center_y()
        .hover(k.c.hover)
        .on_press(toggle)
        .child(icon(chevron, 14.0).color(k.c.icon_muted).a11y_hidden())
        .child(title)
}
/// A Step's glyph and its tone, as `FlowGlyph.vue` draws it.
fn glyph_of(k: &Kit, state: &GlyphState) -> (&'static Icon, Color) {
    match state {
        GlyphState::Done => (&icons::STEP_DONE, k.c.success.fg),
        GlyphState::Running => (&icons::STEP_RUNNING, k.c.info.fg),
        GlyphState::NeedsYou => (&icons::STEP_NEEDS_YOU, k.c.warning.fg),
        GlyphState::Failed => (&icons::STEP_FAILED, k.c.danger.fg),
        GlyphState::Waiting => (&icons::STEP_WAITING, k.c.text_muted),
        GlyphState::Stopped => (&icons::STEP_STOPPED, k.c.text_muted),
        GlyphState::NotRun => (&icons::STEP_NOT_RUN, k.c.text_faint),
        GlyphState::Expected => (&icons::STEP_EXPECTED, k.c.text_faint),
    }
}

fn dot(k: &Kit, state: &GlyphState) -> El {
    let (glyph, color) = glyph_of(k, state);
    icon(glyph, 13.0).color(color)
}
/// A card state's tone, as today's badge colours it: warning, info, success, error or none.
fn state_tone<'k>(k: &'k Kit, state: &State) -> Option<&'k StateColors> {
    match state {
        State::Blocked => Some(&k.c.warning),
        State::Active => Some(&k.c.info),
        State::Failed => Some(&k.c.danger),
        State::Done => Some(&k.c.success),
        State::Quiet | State::Stopped | State::Abandoned => None,
    }
}

/// A small soft pill: a card's state, or Unseen.
fn pill(k: &Kit, key: &str, said: &str, tone: Option<&StateColors>) -> El {
    let (fill, ink) = match tone {
        Some(tone) => (tone.bg, tone.fg),
        None => (k.c.layer_02, k.c.text_muted),
    };
    el().key(key.to_string())
        .h(18.0)
        .px(6.0)
        .radius(4.0)
        .fill(fill)
        .center()
        .child(text(said.to_string()).font(k.ty.small_medium).color(ink))
}

/// A card action as this board does it, or none where Desktop has no way to yet.
fn label_of(task: &Task, action: &CardAction, primary: bool) -> Option<String> {
    Some(match action {
        CardAction::GoToTab => "Go to pane".into(),
        CardAction::CheckOutput => "Check output…".into(),
        CardAction::Attach => "Attach files…".into(),
        CardAction::Steer => "Steer…".into(),
        CardAction::OpenMr { mr, named } => {
            mr.url()?;
            cards::open_mr_label(mr, primary, named.as_deref())
        }
        CardAction::Offer(offer)
            if primary && cards::ships_by_merge(task) && offer.unavailable.is_none() =>
        {
            "Merge".into()
        }
        CardAction::Offer(offer) => offer.unavailable.as_ref().map_or_else(
            || offer.title.clone(),
            |why| format!("{} — {why}", offer.title),
        ),
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

pub(crate) fn recovery_list(k: &Kit, key: String, lines: Vec<String>) -> El {
    col()
        .key(key)
        .role("list")
        .label("Recovery history")
        .gap(2.0)
        .w_full()
        .children(lines.into_iter().map(|line| {
            text(line.clone())
                .role("listitem")
                .label(line)
                .font(k.ty.small)
                .color(k.c.text_muted)
                .wrap()
                .w_full()
        }))
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
    let selected = app
        .chat
        .about
        .as_ref()
        .is_some_and(|about| about.machine == p.machine && about.task == task.id);
    let c = &k.c;

    // What the card can be asked for, behind its menu.
    let menu_actions: Vec<(CardAction, String)> = cards::card_actions(task)
        .into_iter()
        .chain(cards::disposition_actions(task))
        .filter_map(|a| label_of(task, &a, false).map(|l| (a, l)))
        .collect();
    let open = app.board.menu.as_deref() == Some(key.as_str());
    let trigger = IconButton::new(&icons::MORE)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label(format!("Actions for {}", task.name))
        .help("Actions")
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
        let item = MenuItem::new(label)
            .danger(action == CardAction::Stop)
            .disabled(matches!(&action, CardAction::Offer(offer) if offer.unavailable.is_some()));
        menu = menu.item(if action == CardAction::Attach {
            item.on_select_tx(move |app: &mut App, tx| {
                app.attach_to(&key);
                collie_desktop_chat::chat::pick(app, tx);
            })
        } else {
            item.on_select(move |app: &mut App| app.do_action(&key, &action))
        });
    }
    let menu = menu.build(k, layer);

    // Its name, then how it stands and where its work is.
    let mut status = row().key("status").w_full().gap(6.0).center_y().child(pill(
        k,
        "state",
        cards::state_label(&task.state),
        state_tone(k, &task.state),
    ));
    if task.unseen == Some(true) {
        status = status.child(
            pill(k, "unseen", "Unseen", Some(&c.info))
                .role("status")
                .label("Unseen"),
        );
    }
    let place = cards::repo_and_branch(task);
    if !place.is_empty() {
        status = status.child(
            text(place)
                .key("repo")
                .font(k.ty.small)
                .color(c.text_faint)
                .truncate()
                .grow(1.0)
                .shrink(),
        );
    }
    let head = row()
        .w_full()
        .items_start()
        .gap(6.0)
        .child(
            col()
                .grow(1.0)
                .shrink()
                .gap(6.0)
                .child({
                    // The name always opens its record, a saved card's too, as stable's does.
                    let opens = key.clone();
                    el().key(format!("{id}-name"))
                        .w_full()
                        .radius(4.0)
                        .hover(c.hover)
                        .cursor(rune::Cursor::Pointer)
                        .focusable(true)
                        .focus_ring(2.0, 0.0, c.border_focus)
                        .role("button")
                        .label(task.name.clone())
                        .on_press(move |app: &mut App| app.open_card(&opens))
                        .child(
                            text(task.name.clone())
                                .key("name")
                                .font(k.ty.ui_medium)
                                .color(c.text_strong)
                                .wrap()
                                .max_lines(2)
                                .w_full()
                                .a11y_hidden(),
                        )
                })
                .child(status.a11y_hidden()),
        )
        .child(el().mt(-3.0).mr(-4.0).child(menu));

    let (fill, edge) = if task.state == State::Blocked {
        // Opaque, so the card's shadow does not show through its wash.
        (
            collie_desktop_theme::flat(c.warning.bg.alpha(0.5), c.surface_raised),
            k.alpha(c.warning.border, 0.7),
        )
    } else {
        (c.surface_raised, c.border_weak)
    };
    let mut card = col()
        .w_full()
        .min_w(0.0)
        .gap(10.0)
        .pt(12.0)
        .px(14.0)
        .pb(10.0)
        .radius(10.0)
        .fill(fill)
        .border(
            if selected { 1.5 } else { 1.0 },
            if selected { c.border_focus } else { edge },
        )
        // A card sits a step above the board it is laid on.
        .shadow(1.0, 3.0, c.black.alpha(if k.dark { 0.3 } else { 0.07 }))
        .hover(c.surface_hover)
        .focus_ring(2.0, 2.0, c.border_focus)
        .child(head)
        .child(
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
        let mut list = col().key("mrs").gap(6.0).w_full();
        for (at, one) in mrs.iter().enumerate() {
            let mut line = row()
                .key(format!("mr-{at}"))
                .w_full()
                .gap(6.0)
                .center_y()
                .child(
                    text(one.mr.line.clone())
                        .font(k.ty.small.lh(16.0))
                        .color(c.text_muted)
                        .wrap()
                        .max_lines(2)
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
            .gap(2.0)
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
                    .gap(2.0)
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
                .h(26.0)
                .px(6.0)
                .ml(-6.0)
                .center_y()
                .radius(6.0)
                .hover(c.hover)
                .focusable(live)
                .focus_ring(2.0, 0.0, c.border_focus)
                .on_press(move |app: &mut App| app.open_card_at_flow(&open))
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

    let recovery = recovery_of(
        task.park.as_ref().and_then(Option::as_ref),
        task.recovery.as_deref(),
        2,
    );
    if let Some(park) = recovery.park {
        card = card.child(
            text(park.clone())
                .key(format!("{id}-park"))
                .label(park)
                .font(k.ty.small)
                .color(c.text_muted)
                .wrap()
                .w_full(),
        );
    }
    if !recovery.history.is_empty() {
        card = card.child(recovery_list(k, format!("{id}-recovery"), recovery.history));
    }

    // What it asks: questions, or a proposal to review.
    let asks = |key: &str, said: String| {
        col().key(key.to_string()).gap(8.0).w_full().child(
            text(said)
                .font(k.ty.ui_medium)
                .color(c.text_base)
                .wrap()
                .max_lines(2)
                .w_full(),
        )
    };
    if let Some(asked) = answers::card_question(task, p.installation, &app.board.answering) {
        let mut block = asks("question", asked.text);
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
                // In a row, so it is as wide as its label, not the card.
                block.child(
                    row().child(
                        small_button(label, ButtonVariant::Contrast)
                            .disabled(!live)
                            .on_press(move |app: &mut App| app.answer_questions(&key))
                            .build(k)
                            .key(format!("{id}-answer")),
                    ),
                )
            }
            (None, None) => block,
        };
        card = card.child(block);
    } else if let Some(Decision::Proposal(proposal)) = &task.decision {
        let key = key.clone();
        card = card.child(
            asks("proposal", proposal.text.clone()).child(
                row().child(
                    small_button("Review…".into(), ButtonVariant::Contrast)
                        .disabled(!live)
                        .on_press(move |app: &mut App| app.review(&key))
                        .build(k)
                        .key(format!("{id}-review")),
                ),
            ),
        );
    }

    // Where it is, how old, as of when, its agents; and the one action that ends its wait.
    let agents = match task.agents.len() {
        0 => None,
        1 => Some("1 agent".to_string()),
        n => Some(format!("{n} agents")),
    };
    let foot: Vec<String> = [
        (!p.place.is_empty()).then(|| p.place.clone()),
        Some(task.age.clone()),
        p.as_of.map(|at| as_of_said(at, app.offset())),
        agents,
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut footer = row()
        .key("footer")
        .w_full()
        .min_h(28.0)
        .gap(8.0)
        .center_y()
        .child(
            text(foot.join(" · "))
                .key("facts")
                .font(k.ty.small)
                .color(c.text_faint)
                .truncate()
                .grow(1.0)
                .shrink(),
        );
    if let Some((action, label)) =
        cards::primary_action(task).and_then(|a| label_of(task, &a, true).map(|l| (a, l)))
    {
        let key = key.clone();
        let mut button = small_button(label, ButtonVariant::Neutral).disabled(
            !live || matches!(&action, CardAction::Offer(offer) if offer.unavailable.is_some()),
        );
        if action == CardAction::GoToTab {
            button = button.icon(&icons::PANE);
        }
        footer = footer.child(
            button
                .on_press(move |app: &mut App| app.do_action(&key, &action))
                .build(k)
                .key(format!("{id}-primary")),
        );
    }
    // Pinned to the card's foot, so a row of cards ends level.
    card = card.child(
        col()
            .w_full()
            .grow(1.0)
            .child(el().grow(1.0).a11y_hidden())
            .child(el().h(1.0).w_full().fill(c.border_weak).a11y_hidden())
            .child(footer.pt(8.0)),
    );

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
    if live { card } else { card.opacity(0.6) }
}

fn notices(app: &App, k: &Kit) -> El {
    let mut region = ToastRegion::new();
    for notice in &app.board.notices {
        let id = notice.id;
        let mut toast = Toast::new(format!("notice-{id}"), notice.title.clone())
            .on_close(move |app: &mut App| app.dismiss(id));
        if !notice.ok {
            toast = toast.lead(icon(&icons::WARNING, 16.0).color(k.c.danger.icon));
        }
        if notice.again.is_some() {
            toast = toast.action(k, "Try again", true, move |app: &mut App, _| {
                app.try_again(id)
            });
        }
        region = region.toast(
            toast
                .build(k)
                .on_hover_change(move |app: &mut App, inside, _| app.hold_notice(id, inside)),
        );
    }
    crate::toasts::beside_chat(app, region.build(k))
}
