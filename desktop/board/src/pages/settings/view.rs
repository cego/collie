//! The Settings page drawn: an index beside one scrolling column of titled sections.

use super::agents::{self, ChoiceSelect, Fallback};
use super::connections::{self, Card as ConnectionCard};
use super::model::{self, Row, Tone};
use super::registry::Kind;
use super::{Settings, Which};
use crate::App;
use crate::shell::Page;
use collie_desktop_protocol::generated::{Id, News};
use rune::{Color, El, Key, LiveRegion, ScrollSpec, TextEdit, Tx, col, el, row as across, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, Combobox, ComboboxOption, ComboboxState,
    ControlSize, Divider, Field, IconButton, Kit, SegmentedControl, Select, SelectAppearance,
    Spinner, Switch, TextArea, TextInput,
};
use serde_json::json;

const CONNECTION_WORDS: &str =
    "connections gitlab github gh linear host token helle slack credentials glab gitlab_host";
const OWN_WORDS: &str = "each machine's own projects.root chat_harness harnesses found remembered linear.team gitlab.assignee";
const ABOUT_WORDS: &str = "about version update collie desktop";

/// The width of every control beside a setting's words, so each row's control lines up.
const CONTROL: f32 = 260.0;

fn lead_of(group: &str) -> Option<&'static str> {
    match group {
        "Board" => {
            Some("Scope and density change the TUI's board; Desktop's board is not changed.")
        }
        "Chat" => Some(
            "The Flock chat in Desktop, and each Machine's Native chat. The Flock chat's harness, model and effort are picked in its composer, on this computer.",
        ),
        _ => None,
    }
}

/// What the search and the "Only what is set" switch leave shown.
struct Filter {
    query: String,
    only_set: bool,
}

impl Filter {
    fn of(page: &Settings) -> Filter {
        Filter {
            query: page.query.text.trim().to_lowercase(),
            only_set: page.only_set,
        }
    }
    fn filtering(&self) -> bool {
        !self.query.is_empty() || self.only_set
    }
    fn keeps(&self, row: &Row) -> bool {
        (!self.only_set || row.set)
            && format!("{} {} {}", row.label, row.key, row.description)
                .to_lowercase()
                .contains(&self.query)
    }
    fn names(&self, words: &str) -> bool {
        words.contains(&self.query)
    }
}

struct Shown {
    group: &'static str,
    set: usize,
    subs: Vec<(&'static str, Vec<Row>, bool, usize)>,
}

fn shown(page: &Settings, filter: &Filter) -> Vec<Shown> {
    page.sections(&[])
        .into_iter()
        .filter_map(|section| {
            let rows: Vec<Row> = section
                .rows
                .iter()
                .filter(|r| filter.keeps(r))
                .cloned()
                .collect();
            if rows.is_empty() {
                return None;
            }
            let mut subs: Vec<&'static str> = Vec::new();
            for r in &rows {
                if !subs.contains(&r.sub) {
                    subs.push(r.sub);
                }
            }
            Some(Shown {
                group: section.group,
                set: section.rows.iter().filter(|r| r.set).count(),
                subs: subs
                    .into_iter()
                    .map(|sub| {
                        let all = section.rows.iter().filter(|r| r.sub == sub).count();
                        let collapsed =
                            sub == "Advanced" && !page.advanced_open && !filter.filtering();
                        (
                            sub,
                            rows.iter().filter(|r| r.sub == sub).cloned().collect(),
                            collapsed,
                            all,
                        )
                    })
                    .collect(),
            })
        })
        .collect()
}

fn tone(k: &Kit, tone: Tone) -> Color {
    match tone {
        Tone::Ok => k.c.success.fg,
        Tone::Warn => k.c.warning.fg,
    }
}

fn muted(k: &Kit, s: impl Into<String>) -> El {
    text(s.into())
        .font(k.ty.text_small)
        .color(k.c.text_muted)
        .wrap()
        .w_full()
}

fn heading(k: &Kit, s: &str) -> El {
    text(s.to_string())
        .font(k.ty.ui_medium)
        .color(k.c.text_strong)
}

fn notice(k: &Kit, key: &str, title: &str, why: &str) -> El {
    col()
        .key(key.to_string())
        .role("alert")
        .label(title.to_string())
        .description(why.to_string())
        .gap(4.0)
        .padding(12.0)
        .radius(k.radius.md)
        .fill(k.c.warning.bg)
        .border(1.0, k.c.warning.border)
        .w_full()
        .child(
            text(title.to_string())
                .font(k.ty.small_medium)
                .color(k.c.warning.fg)
                .a11y_hidden(),
        )
        .child(
            text(why.to_string())
                .font(k.ty.text_small)
                .color(k.c.text_base)
                .wrap()
                .w_full()
                .a11y_hidden(),
        )
}

fn said_line(k: &Kit, key: String, said: &Result<String, String>) -> El {
    let (words, color, role) = match said {
        Ok(words) => (words.clone(), k.c.success.fg, "status"),
        Err(why) => (why.clone(), k.c.danger.fg, "alert"),
    };
    text(words)
        .key(key)
        .role(role)
        .font(k.ty.text_small)
        .color(color)
        .wrap()
        .w_full()
}

/// A card that groups rows, ruled between them.
fn panel(k: &Kit, key: String, rows: Vec<El>) -> El {
    let mut card = col()
        .key(key)
        .w_full()
        .radius(k.radius.lg)
        .fill(k.c.surface_raised_base)
        .border(1.0, k.c.border_weak);
    let n = rows.len();
    for (i, r) in rows.into_iter().enumerate() {
        card = card.child(r);
        if i + 1 < n {
            card = card.child(Divider::horizontal().build(k));
        }
    }
    card
}

fn select_toggle(key: String) -> impl Fn(&mut App) + Clone + 'static {
    move |app: &mut App| {
        let open = &mut app.pages.settings.open_select;
        *open = if open.as_deref() == Some(&key) {
            None
        } else {
            Some(key.clone())
        };
    }
}

fn select_close(app: &mut App) {
    app.pages.settings.open_select = None;
}

/// A Select of `options` as `(value, label, detail)`, choosing by value.
#[allow(clippy::too_many_arguments)]
fn choice_select(
    page: &Settings,
    k: &Kit,
    layer: &mut Vec<El>,
    key: String,
    name: &str,
    options: &[(String, String, Option<String>)],
    current: &str,
    placeholder: &str,
    disabled: bool,
    choose: impl Fn(&mut App, String) + Clone + 'static,
) -> El {
    let labels: Vec<String> = options.iter().map(|(_, l, _)| l.clone()).collect();
    let details: Vec<Option<String>> = options.iter().map(|(_, _, d)| d.clone()).collect();
    let current = options
        .iter()
        .find(|(v, _, _)| v == current)
        .map(|(_, l, _)| l.clone());
    let values: Vec<(String, String)> = options
        .iter()
        .map(|(v, l, _)| (l.clone(), v.clone()))
        .collect();
    // Its field is keyed `{key}-trigger`, which its list is anchored to: re-keying the field
    // would leave the list at the window's corner, so the key goes on a wrapper.
    let select = Select::new(key.clone(), &labels)
        .details(&details)
        .current(current.as_deref())
        .placeholder(placeholder)
        .label(name)
        .appearance(SelectAppearance::Field)
        .width(CONTROL)
        .open(page.open_select.as_deref() == Some(&key))
        .disabled(disabled)
        .on_toggle(select_toggle(key.clone()))
        .on_close(select_close)
        .on_choose(move |app: &mut App, label: &str, _: &mut Tx| {
            app.pages.settings.open_select = None;
            if let Some((_, value)) = values.iter().find(|(l, _)| l == label) {
                choose(app, value.clone());
            }
        })
        .build(k, layer);
    el().key(key).child(select)
}

/// Every option, a disabled one too: its detail says why it can't be chosen, and an empty
/// list says nothing.
fn select_options(select: &ChoiceSelect) -> Vec<(String, String, Option<String>)> {
    select
        .options
        .iter()
        .map(|o| (o.value.clone(), o.label.clone(), o.description.clone()))
        .collect()
}

fn combo_state(page: &Settings, key: &str) -> ComboboxState {
    page.combos.get(key).cloned().unwrap_or_default()
}

/// A searchable list of `options`, which also offers whatever id is typed.
#[allow(clippy::too_many_arguments)]
fn combo(
    page: &Settings,
    k: &Kit,
    layer: &mut Vec<El>,
    key: &'static str,
    name: &str,
    options: &[agents::ChoiceOption],
    current: Option<&str>,
    placeholder: &str,
    disabled: bool,
    choose: impl Fn(&mut App, &str) + 'static,
) -> El {
    let state = combo_state(page, key);
    let mut listed: Vec<ComboboxOption> = options
        .iter()
        .map(|o| ComboboxOption {
            id: o.value.clone(),
            label: o.label.clone(),
            detail: o.description.clone().unwrap_or_default(),
            disabled: o.disabled,
        })
        .collect();
    let typed = state.search().text.trim();
    if !typed.is_empty() && !listed.iter().any(|o| o.id == typed) {
        listed.push(ComboboxOption::new(typed, format!("Use {typed}")));
    }
    let built = Combobox::new(key, &state, &listed, move |app: &mut App| {
        app.pages.settings.combos.entry(key.into()).or_default()
    })
    .label(name)
    .current(current)
    .placeholder(placeholder)
    .search_placeholder("Search, or type an id")
    .width(CONTROL)
    .disabled(disabled)
    .on_choose(move |app: &mut App, id: &str, _: &mut Tx| {
        if let Some(state) = app.pages.settings.combos.get_mut(key) {
            state.close();
        }
        choose(app, id)
    })
    .build(k, layer);
    el().key(key).w(CONTROL).child(built)
}

/// The colour a row's line under its control is said in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Said {
    Plain,
    Ok,
    Warn,
    Error,
    Info,
}

fn paint(k: &Kit, said: Said) -> Color {
    match said {
        Said::Plain => k.c.text_faint,
        Said::Ok => k.c.success.fg,
        Said::Warn => k.c.warning.fg,
        Said::Error => k.c.danger.fg,
        Said::Info => k.c.info.fg,
    }
}

/// What a row says under its control: how far its latest edit reached, else whose it is;
/// and whether the core is checking it now.
fn meta_of(app: &App, page: &Settings, row: &Row) -> (String, Said, bool) {
    let id = row.id();
    if page.saving.contains(&id) {
        return ("Saving…".into(), Said::Plain, true);
    }
    if page.saved.contains(&id) {
        if !row.shared {
            return ("Saved on this computer".into(), Said::Ok, false);
        }
        return match model::flock_reach(page.readable(), &super::reached(app)) {
            Ok(said) => (
                said.said,
                match said.tone {
                    Tone::Ok => Said::Ok,
                    Tone::Warn => Said::Warn,
                },
                false,
            ),
            Err(refused) => (refused, Said::Error, false),
        };
    }
    if page.dirty(row) {
        return if row.multiline {
            (
                "Edited, not set yet · Ctrl+Enter sets it".into(),
                Said::Warn,
                false,
            )
        } else {
            (
                "Enter sets it · Esc puts it back".into(),
                Said::Plain,
                false,
            )
        };
    }
    match &row.edit {
        Some(edit) if edit.starts_with("Taken from") => (edit.clone(), Said::Info, false),
        Some(edit) => (
            format!("{edit} · {}", row.default_said.to_lowercase()),
            Said::Plain,
            false,
        ),
        None => (row.default_said.clone(), Said::Plain, false),
    }
}

fn draft_edit(page: &Settings, row: &Row) -> TextEdit {
    page.drafts
        .get(&row.id())
        .cloned()
        .unwrap_or_else(|| TextEdit::new(row.value.clone()))
}

fn draft_access(row: &Row) -> impl for<'a> Fn(&'a mut App) -> &'a mut TextEdit + 'static {
    let (id, value) = (row.id(), row.value.clone());
    move |app: &mut App| {
        app.pages
            .settings
            .drafts
            .entry(id.clone())
            .or_insert_with(|| TextEdit::new(value.clone()))
    }
}

fn set_draft(row: &Row) -> impl Fn(&mut App) + Clone + 'static {
    let row = row.clone();
    move |app: &mut App| {
        let typed = app.pages.settings.draft_of(&row);
        super::set(app, &row, &typed);
    }
}

fn escape_reverts(row: &Row) -> impl Fn(&mut App, &rune::KeyEvent, &mut Tx) -> bool + 'static {
    let row = row.clone();
    move |app: &mut App, key: &rune::KeyEvent, _: &mut Tx| {
        if key.key == Key::Escape {
            app.pages.settings.revert(&row);
            return true;
        }
        false
    }
}

/// The typed field of a text, number, list or JSON row, and its Set button.
fn text_control(page: &Settings, row: &Row, k: &Kit) -> El {
    let id = row.id();
    let edit = draft_edit(page, row);
    let refused = page.refusals.contains_key(&id);
    let dirty = page.dirty(row);
    let saving = page.saving.contains(&id);
    let set = Button::new(if saving { "Setting…" } else { "Set" })
        .variant(if dirty {
            ButtonVariant::Contrast
        } else {
            ButtonVariant::Outline
        })
        .disabled(!dirty || saving)
        .on_press(set_draft(row))
        .build(k)
        .key(format!("{id}-set"))
        .label(format!("Set {}", row.label));
    if row.multiline {
        let discard = dirty.then(|| {
            let r = row.clone();
            Button::new("Discard edit")
                .variant(ButtonVariant::Ghost)
                .on_press(move |app: &mut App| app.pages.settings.revert(&r))
                .build(k)
                .key(format!("{}-discard", row.id()))
        });
        let setter = set_draft(row);
        let area = TextArea::new(&edit)
            .label(row.label.clone())
            .placeholder(if row.kind == Kind::Json {
                "{\"*\": {\"env\": {\"NAME\": \"value\"}}}"
            } else {
                "Frontend work is on the laptop, everything else is on the vm"
            })
            .width(None)
            .auto_grow(3, 14)
            .invalid(refused)
            .on_edit(draft_access(row))
            .on_change(forget_on_change(row))
            .on_submit(move |app: &mut App, _: &mut Tx| setter(app))
            .on_key(escape_reverts(row))
            .build(k)
            .key(id.clone());
        let help = (row.key == "standing_direction").then(|| {
            Button::new("Help me write it")
                .icon(&crate::icons::SPARKLES)
                .variant(ButtonVariant::Outline)
                .on_press(|app: &mut App| app.open_standing_setup())
                .build(k)
                .key("standing-setup-help")
        });
        return col().gap(8.0).w_full().child(area).child(
            across()
                .gap(8.0)
                .w_full()
                .center_y()
                .children(help)
                .child(el().grow(1.0))
                .children(discard)
                .child(set),
        );
    }
    let setter = set_draft(row);
    let mut input = TextInput::new(&edit)
        .label(row.label.clone())
        .placeholder(if row.kind == Kind::List {
            "none, or a, b".to_string()
        } else {
            row.fallback.clone()
        })
        .width(None)
        .invalid(refused)
        .on_edit(draft_access(row))
        .on_change(forget_on_change(row))
        .on_submit(move |app: &mut App, _: &mut Tx| setter(app))
        .on_key(escape_reverts(row));
    if let Some(unit) = row.unit {
        input = input.trailing(
            text(unit)
                .font(k.ty.text_small)
                .color(k.c.text_faint)
                .a11y_hidden(),
        );
    }
    across()
        .gap(8.0)
        .w_full()
        .center_y()
        .child(el().grow(1.0).shrink().child(input.build(k).key(id)))
        .child(set)
}

fn forget_on_change(row: &Row) -> impl Fn(&mut App, &mut Tx) + 'static {
    let id = row.id();
    move |app: &mut App, _: &mut Tx| {
        let page = &mut app.pages.settings;
        page.refusals.remove(&id);
        page.saved.remove(&id);
    }
}

/// The fallbacks, in order, each moved or removed in place, and a list to add one from.
fn fallbacks_control(app: &App, page: &Settings, row: &Row, k: &Kit, layer: &mut Vec<El>) -> El {
    let busy = page.choosing || page.saving.contains(&row.id());
    let values = agents::fallback_values(&row.value);
    let n = values.len();
    let mut list = col()
        .key("fallbacks")
        .role("list")
        .label("Fall back to")
        .gap(6.0)
        .w_full();
    if values.is_empty() {
        list = list.child(muted(
            k,
            "None: a step whose Subscription is used up waits for the reset.",
        ));
    }
    for (at, value) in values.iter().enumerate() {
        let act =
            |glyph: &'static rune::Icon, name: String, key: String, change: Fallback, off: bool| {
                let row = row.clone();
                IconButton::new(glyph)
                    .label(name)
                    .disabled(off || busy)
                    .on_press(move |app: &mut App| {
                        let next = agents::change_fallbacks(&row.value, &change);
                        super::choose_fallbacks(app, &row, &next)
                    })
                    .build(k)
                    .key(key)
            };
        list = list.child(
            across()
                .key(format!("fallback-{at}"))
                .role("listitem")
                .label(value.clone())
                .gap(8.0)
                .px(10.0)
                .py(6.0)
                .w_full()
                .center_y()
                .radius(k.radius.md)
                .border(1.0, k.c.border_weak)
                .child(
                    text(format!("{}", at + 1))
                        .font(k.ty.text_small)
                        .color(k.c.text_faint)
                        .a11y_hidden(),
                )
                .child(
                    text(value.clone())
                        .font(k.ty.mono)
                        .color(k.c.text_base)
                        .grow(1.0)
                        .shrink()
                        .truncate()
                        .a11y_hidden(),
                )
                .child(act(
                    k.glyph.chevron_up,
                    format!("Move {value} up"),
                    format!("fallback-{at}-up"),
                    Fallback::Up(at),
                    at == 0,
                ))
                .child(act(
                    k.glyph.chevron_down,
                    format!("Move {value} down"),
                    format!("fallback-{at}-down"),
                    Fallback::Down(at),
                    at + 1 == n,
                ))
                .child(act(
                    k.glyph.close,
                    format!("Remove {value}"),
                    format!("fallback-{at}-remove"),
                    Fallback::Remove(at),
                    false,
                )),
        );
    }
    let options = agents::fallback_options(&row.value, &page.catalogues, &super::profiles(app));
    let adding = row.clone();
    let add = combo(
        page,
        k,
        layer,
        "fallback-add",
        "Add a fallback",
        &options,
        None,
        "Add a fallback…",
        busy,
        move |app: &mut App, id: &str| {
            if id.is_empty() {
                return;
            }
            let next = agents::change_fallbacks(&adding.value, &Fallback::Add(id.into()));
            super::choose_fallbacks(app, &adding, &next)
        },
    );
    col().gap(8.0).w_full().child(list).child(add).child(muted(
        k,
        "The first with usage left runs the step. A typed entry is harness/model.",
    ))
}

/// The control drawn beside a row's words, where it fits there.
fn inline_control(
    app: &App,
    page: &Settings,
    row: &Row,
    k: &Kit,
    layer: &mut Vec<El>,
) -> Option<El> {
    let id = row.id();
    match row.key.as_str() {
        "harness" | "model" | "effort" => {
            let selects = agent_selects(app, page);
            let disabled = page.choosing;
            let key = row.key.clone();
            let off: Vec<String> = [&selects.harness, &selects.effort]
                .iter()
                .flat_map(|s| s.options.iter().filter(|o| o.disabled))
                .map(|o| o.value.clone())
                .collect();
            let chosen = move |app: &mut App, value: String| {
                if !off.contains(&value) {
                    super::choose_agent(app, &key, &value, false)
                }
            };
            let control = match row.key.as_str() {
                "harness" => choice_select(
                    page,
                    k,
                    layer,
                    id,
                    &row.label,
                    &select_options(&selects.harness),
                    &selects.harness.value,
                    &selects.harness.label,
                    disabled,
                    chosen,
                ),
                "effort" => choice_select(
                    page,
                    k,
                    layer,
                    id,
                    &row.label,
                    &select_options(&selects.effort),
                    &selects.effort.value,
                    &selects.effort.label,
                    disabled || selects.effort.disabled,
                    chosen,
                ),
                _ => combo(
                    page,
                    k,
                    layer,
                    "flock-model",
                    &row.label,
                    &selects.model.options,
                    Some(&selects.model.value),
                    &selects.model.label,
                    disabled,
                    move |app: &mut App, value: &str| chosen(app, value.into()),
                ),
            };
            let warning = selects.model.warning.filter(|_| row.key == "model");
            Some(
                col()
                    .gap(4.0)
                    .w(CONTROL)
                    .child(control)
                    .children(warning.map(|w| {
                        text(w)
                            .role("status")
                            .font(k.ty.text_small)
                            .color(k.c.warning.fg)
                            .wrap()
                            .w_full()
                    })),
            )
        }
        "fallbacks" | "release.approval_channel" | "slack.notification_channel" => None,
        _ => match row.kind {
            Kind::Boolean => {
                let on = row.effective() == "true";
                let r = row.clone();
                Some(
                    Switch::new(on)
                        .label(row.label.clone())
                        .hide_label()
                        .disabled(page.saving.contains(&id))
                        .on_toggle(move |app: &mut App| {
                            let on = r.effective() == "true";
                            super::set(app, &r, if on { "false" } else { "true" })
                        })
                        .build(k)
                        .key(id),
                )
            }
            Kind::Choice if row.choices.len() <= 6 => {
                let r = row.clone();
                Some(
                    SegmentedControl::new(
                        &row.choices,
                        row.choices.iter().position(|c| c == row.effective()),
                    )
                    .label(row.label.clone())
                    .fit()
                    .on_pick(move |app: &mut App, at: usize, _: &mut Tx| {
                        if let Some(choice) = r.choices.get(at) {
                            super::set(app, &r, choice)
                        }
                    })
                    .build(k)
                    .key(id),
                )
            }
            Kind::Choice => {
                let r = row.clone();
                let options: Vec<(String, String, Option<String>)> = row
                    .choices
                    .iter()
                    .map(|c| (c.clone(), c.clone(), None))
                    .collect();
                Some(choice_select(
                    page,
                    k,
                    layer,
                    id,
                    &row.label,
                    &options,
                    &row.value,
                    &row.fallback,
                    false,
                    move |app: &mut App, v: String| super::set(app, &r, &v),
                ))
            }
            Kind::Text | Kind::Number | Kind::List
                if !row.multiline && row.sub != "Who does the work" =>
            {
                Some(text_control(page, row, k).w(CONTROL))
            }
            _ => None,
        },
    }
}

fn destination_control(
    page: &Settings,
    row: &Row,
    k: &Kit,
    layer: &mut Vec<El>,
    key: String,
) -> El {
    let dest = connections::destination(&row.key, &row.value, page.slack_yours.as_deref());
    let options: Vec<(String, String, Option<String>)> = dest
        .options
        .iter()
        .map(|(v, l)| (v.clone(), l.clone(), None))
        .collect();
    let r = row.clone();
    col()
        .gap(4.0)
        .w_full()
        .child(choice_select(
            page,
            k,
            layer,
            key,
            &row.label,
            &options,
            &row.value,
            &options[0].1,
            dest.disabled,
            move |app: &mut App, v: String| super::choose_destination(app, &r, &v),
        ))
        .children(dest.hint.map(|hint| muted(k, hint)))
}

fn setting_row(app: &App, page: &Settings, row: &Row, k: &Kit, layer: &mut Vec<El>) -> El {
    let id = row.id();
    let mut words = across()
        .gap(8.0)
        .center_y()
        .flex_wrap()
        .child(
            text(row.label.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .a11y_hidden(),
        )
        .child(
            text(row.key.clone())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .a11y_hidden(),
        );
    if !row.shared {
        words = words.child(
            Badge::new("This computer")
                .variant(BadgeVariant::Subtle)
                .build(k),
        );
    }
    let about = col()
        .gap(4.0)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .child(words)
        .child(muted(k, row.description.clone()).a11y_hidden());
    // Every row's control keeps one column at the right.
    let mut head = across().gap(24.0).w_full().items_start().child(about);
    if let Some(control) = inline_control(app, page, row, k, layer) {
        head = head.child(across().w(CONTROL).justify_end().child(control));
    }
    let block = match row.key.as_str() {
        "fallbacks" => Some(fallbacks_control(app, page, row, k, layer)),
        "release.approval_channel" | "slack.notification_channel" => {
            Some(destination_control(page, row, k, layer, id.clone()))
        }
        _ if row.multiline
            && row.sub != "Who does the work"
            && matches!(
                row.kind,
                Kind::Text | Kind::Number | Kind::List | Kind::Json
            ) =>
        {
            Some(text_control(page, row, k))
        }
        _ => None,
    };
    let refusal = page.refusals.get(&id).map(|why| {
        across()
            .key(format!("{id}-error"))
            .role("alert")
            .label(why.clone())
            .gap(6.0)
            .w_full()
            .child(
                text(why.clone())
                    .font(k.ty.text_small)
                    .color(k.c.danger.fg)
                    .wrap()
                    .w_full()
                    .a11y_hidden(),
            )
    });
    let hint = row.hint.clone().map(|hint| {
        text(hint)
            .key(format!("{id}-hint"))
            .font(k.ty.text_small)
            .color(k.c.warning.fg)
            .wrap()
            .w_full()
            .padding(8.0)
            .radius(k.radius.md)
            .fill(k.c.warning.bg)
    });
    let (said, marker, saving) = meta_of(app, page, row);
    let reset = (row.set && !page.dirty(row)).then(|| {
        let r = row.clone();
        Button::new("Reset to default")
            .variant(ButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .disabled(page.choosing || page.saving.contains(&id))
            .on_press(move |app: &mut App| super::reset(app, &r))
            .build(k)
            .key(format!("{id}-reset"))
            .label(format!("Reset {} to default", row.label))
    });
    let meta = across()
        .key(format!("{id}-meta"))
        .gap(8.0)
        .min_h(24.0)
        .w_full()
        .center_y()
        .live_region(LiveRegion::Polite)
        .children(saving.then(|| Spinner::new().size(12.0).build(k)))
        .child(
            text(said)
                .key(format!("{id}-said"))
                .font(k.ty.text_xsmall)
                .color(paint(k, marker))
                .grow(1.0)
                .shrink()
                .wrap(),
        )
        .children(reset);
    col()
        .key(format!("setting-{id}"))
        .role("group")
        .label(row.label.clone())
        .description(row.description.clone())
        .gap(8.0)
        .px(16.0)
        .py(14.0)
        .w_full()
        .child(head)
        .children(block)
        .children(refusal)
        .children(hint)
        .child(meta)
}

thread_local! {
    /// The view run under way, and the agent selects worked out in it.
    static RUN: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static SELECTS: std::cell::RefCell<Option<(u64, agents::AgentSelects)>> =
        const { std::cell::RefCell::new(None) };
}

/// The agent selects, merged from every catalogue once a view run rather than once a row.
fn agent_selects(app: &App, page: &Settings) -> agents::AgentSelects {
    let run = RUN.get();
    if let Some((at, selects)) = SELECTS.with_borrow(Clone::clone)
        && at == run
    {
        return selects;
    }
    let selects = agents::agent_selects(
        &page.catalogues,
        &super::profiles(app),
        &page.agent_settings(),
        super::time::now_ms(),
        super::time::local_offset(),
    );
    SELECTS.set(Some((run, selects.clone())));
    selects
}

fn section_view(app: &App, page: &Settings, shown: &Shown, k: &Kit, layer: &mut Vec<El>) -> El {
    let lead = if shown.group == "Agents" {
        let selects = agent_selects(app, page);
        Some(format!(
            "What every step's agent runs on, unless it names its own. {}",
            page.catalogue_problem.clone().unwrap_or(selects.lead)
        ))
    } else {
        lead_of(shown.group).map(String::from)
    };
    let mut out = col()
        .key(format!("settings-{}", shown.group))
        .role("group")
        .label(shown.group)
        .gap(10.0)
        .w_full()
        .child(
            across()
                .gap(8.0)
                .center_y()
                .child(heading(k, shown.group))
                .children((shown.set > 0).then(|| {
                    text(format!("{} set", shown.set))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint)
                })),
        )
        .children(lead.map(|l| muted(k, l)));
    for (sub, rows, collapsed, all) in &shown.subs {
        if !sub.is_empty() {
            let toggle = (*sub == "Advanced" && !Filter::of(page).filtering()).then(|| {
                Button::new(if page.advanced_open {
                    "Hide".to_string()
                } else {
                    format!("Show {all} more")
                })
                .variant(ButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .expanded(!collapsed)
                .on_press(|app: &mut App| {
                    let page = &mut app.pages.settings;
                    page.advanced_open = !page.advanced_open
                })
                .build(k)
                .key(format!("settings-{}-advanced", shown.group))
            });
            out = out.child(
                across()
                    .gap(8.0)
                    .mt(4.0)
                    .center_y()
                    .child(
                        text(sub.to_uppercase())
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.text_faint),
                    )
                    .children(toggle),
            );
        }
        if !collapsed {
            let built: Vec<El> = rows
                .iter()
                .map(|r| setting_row(app, page, r, k, layer))
                .collect();
            out = out.child(panel(
                k,
                format!("settings-{}-{}", shown.group, sub.replace(' ', "-")),
                built,
            ));
        }
    }
    out
}

fn token_field(page: &Settings, k: &Kit, which: Which) -> El {
    let (token, name, key, placeholder, save) = match which {
        Which::Gitlab => (
            &page.gitlab,
            "gitlab",
            "GitLab token",
            format!(
                "The token {} made",
                page.credentials
                    .as_ref()
                    .map_or("GitLab".to_string(), |c| c.host.clone())
            ),
            if page
                .credentials
                .as_ref()
                .is_some_and(|c| c.gitlab.is_some())
            {
                "Renew"
            } else {
                "Save"
            },
        ),
        Which::Helle => (
            &page.helle,
            "helle",
            "Helle token",
            "Helle token".to_string(),
            "Save",
        ),
    };
    let revealed = token.revealed;
    let reveal = IconButton::new(if revealed {
        k.glyph.eye_off
    } else {
        k.glyph.eye
    })
    .label(if revealed {
        format!("Hide the {key}")
    } else {
        format!("Show the {key}")
    })
    .on_press(move |app: &mut App| {
        let t = match which {
            Which::Gitlab => &mut app.pages.settings.gitlab,
            Which::Helle => &mut app.pages.settings.helle,
        };
        t.revealed = !t.revealed;
    })
    .build(k)
    .key(format!("reveal-{name}"));
    let input = TextInput::new(&token.edit)
        .secure()
        .revealed(revealed)
        .label(key)
        .placeholder(placeholder)
        .width(None)
        .trailing(reveal)
        .on_edit(move |app: &mut App| match which {
            Which::Gitlab => &mut app.pages.settings.gitlab.edit,
            Which::Helle => &mut app.pages.settings.helle.edit,
        })
        .on_change(move |app: &mut App, _: &mut Tx| {
            if which == Which::Helle {
                super::check_helle(app)
            }
        })
        .on_submit(move |app: &mut App, _: &mut Tx| {
            if super::token_accepted(&app.pages.settings, which) {
                super::save_token(app, which)
            }
        })
        .build(k)
        .key(format!("{name}-token"));
    let saving = token.saving;
    let button = Button::new(if saving { "Saving…" } else { save })
        .variant(ButtonVariant::Contrast)
        .disabled(saving || !super::token_accepted(page, which))
        .on_press(move |app: &mut App| super::save_token(app, which))
        .build(k)
        .key(format!("save-{name}"))
        .label(format!("{save} the {key}"));
    let check = match which {
        Which::Helle => page
            .helle_check
            .as_ref()
            .filter(|(t, _)| t == page.helle.edit.text.trim())
            .map(|(_, said)| {
                said_line(
                    k,
                    "helle-check".into(),
                    &said.clone().map(|owner| format!("Belongs to {owner}")),
                )
            }),
        Which::Gitlab => None,
    };
    col()
        .gap(6.0)
        .w_full()
        .child(
            across()
                .gap(8.0)
                .w_full()
                .center_y()
                .child(el().grow(1.0).shrink().child(input))
                .children(saving.then(|| Spinner::new().size(14.0).build(k)))
                .child(button),
        )
        .children(check)
        .children(
            token
                .said
                .as_ref()
                .map(|said| said_line(k, format!("{name}-said"), said)),
        )
}

fn gitlab_details(page: &Settings, k: &Kit) -> Vec<El> {
    let Some(credentials) = page.credentials.as_ref() else {
        return Vec::new();
    };
    let kept = match &credentials.gitlab {
        Some(g) => match &g.expires {
            Some(expires) => format!("Token expires {expires}"),
            None => "Token kept on this computer".into(),
        },
        None => "No token kept yet".into(),
    };
    let url = credentials.token_page.clone();
    let typed = page.host.text.trim().to_string();
    let mut out = vec![
        muted(k, format!("{} · {kept}", credentials.host)).key("gitlab-kept"),
        across()
            .gap(8.0)
            .flex_wrap()
            .child(
                Button::new("Make one on GitLab")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(move |app: &mut App| {
                        super::fire(app, "openLink", json!({ "url": url }))
                    })
                    .build(k)
                    .key("token-page"),
            )
            .child(
                Button::new("Paste from clipboard")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .disabled(page.gitlab.saving)
                    .on_press_tx(|_: &mut App, tx| {
                        tx.read_clipboard(|app: &mut App, held, _| {
                            super::paste_gitlab(app, held.text())
                        });
                    })
                    .build(k)
                    .key("paste-gitlab"),
            )
            .child(
                Button::new("Use another GitLab…")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .expanded(page.other_host)
                    .on_press(|app: &mut App| {
                        let page = &mut app.pages.settings;
                        page.other_host = !page.other_host
                    })
                    .build(k)
                    .key("other-host"),
            ),
    ];
    if page.other_host {
        let host_input = TextInput::new(&page.host)
            .label("GitLab host")
            .placeholder(credentials.host.clone())
            .width(None)
            .on_edit(|app: &mut App| &mut app.pages.settings.host)
            .on_submit(|app: &mut App, _: &mut Tx| super::save_host(app))
            .build(k)
            .key("gitlab-host");
        let field = Field::new()
            .label("GitLab host")
            .control(
                across()
                    .gap(8.0)
                    .w_full()
                    .child(el().grow(1.0).shrink().child(host_input))
                    .child(
                        Button::new(if page.host_saving {
                            "Saving…"
                        } else {
                            "Use this GitLab"
                        })
                        .variant(ButtonVariant::Contrast)
                        .disabled(typed.is_empty() || page.host_saving)
                        .on_press(super::save_host)
                        .build(k)
                        .key("save-gitlab-host"),
                    ),
            )
            .build(k);
        out.push(field);
        if !typed.is_empty() && typed != credentials.host {
            out.push(
                text(format!(
                    "Changing GitLab forgets the token made for {}. Make one on the new host after.",
                    credentials.host
                ))
                .font(k.ty.text_small)
                .color(k.c.warning.fg)
                .wrap()
                .w_full(),
            );
        }
        out.extend(
            page.host_said
                .as_ref()
                .map(|said| said_line(k, "gitlab-host-said".into(), said)),
        );
    }
    out.push(
        Field::new()
            .label("Token")
            .control(token_field(page, k, Which::Gitlab))
            .build(k),
    );
    out
}

fn helle_details(k: &Kit, page: &Settings) -> Vec<El> {
    const COMMAND: &str = "/helle token";
    let step = |n: &str, rest: El| {
        across()
            .gap(8.0)
            .center_y()
            .child(
                text(n.to_string())
                    .font(k.ty.text_small)
                    .color(k.c.text_faint),
            )
            .child(rest)
    };
    vec![
        muted(
            k,
            "Paste once. Desktop gives the token to every Machine's credentials file, readable by its owner alone.",
        ),
        col()
            .key("helle-guide")
            .role("list")
            .label("Making a Helle token")
            .gap(6.0)
            .child(step(
                "1.",
                Button::new("Open Slack")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .on_press(|app: &mut App| super::fire(app, "openSlack", json!(null)))
                    .build(k)
                    .key("helle-slack"),
            ))
            .child(step(
                "2.",
                across()
                    .gap(6.0)
                    .center_y()
                    .child(text("Run").font(k.ty.text_small).color(k.c.text_base))
                    .child(text(COMMAND).font(k.ty.mono).color(k.c.text_strong))
                    .child(
                        IconButton::new(k.glyph.copy)
                            .label(format!("Copy {COMMAND}"))
                            .on_press_tx(|_: &mut App, tx| tx.copy(COMMAND))
                            .build(k)
                            .key("helle-copy"),
                    ),
            ))
            .child(step(
                "3.",
                text("Press Create new token and label it, for example “Collie”.")
                    .font(k.ty.text_small)
                    .color(k.c.text_base),
            ))
            .child(step(
                "4.",
                text("Paste the token here.")
                    .font(k.ty.text_small)
                    .color(k.c.text_base),
            )),
        Field::new()
            .label("Token")
            .control(token_field(page, k, Which::Helle))
            .build(k),
    ]
}

fn slack_details(app: &App, page: &Settings, k: &Kit, layer: &mut Vec<El>) -> Vec<El> {
    let state = page.slack_user.as_ref();
    let signed = state.and_then(|s| s.signed_in.as_ref());
    let trouble = state.and_then(|s| s.trouble.clone());
    let mut out = Vec::new();
    if let (Some(who), None) = (signed, &trouble) {
        out.push(
            text(format!("Posts as {} in {}", who.user, who.team))
                .key("slack-user-identity")
                .font(k.ty.ui)
                .color(k.c.text_base),
        );
    }
    if let Some(trouble) = &trouble {
        out.push(
            text(trouble.clone())
                .role("status")
                .font(k.ty.text_small)
                .color(k.c.warning.fg)
                .wrap()
                .w_full(),
        );
    }
    if signed.is_none() || trouble.is_some() {
        out.push(
            Button::new(if page.slack_busy {
                "Signing in…"
            } else {
                "Sign in to Slack"
            })
            .variant(ButtonVariant::Contrast)
            .disabled(page.slack_busy)
            .on_press(|app: &mut App| super::sign_in_slack(app, false))
            .build(k)
            .key("sign-in-slack-user"),
        );
        out.push(muted(
            k,
            "Opens Slack in your browser. Approval requests and notifications are then posted as you.",
        ));
    }
    out.extend(
        page.slack_said
            .as_ref()
            .map(|said| said_line(k, "slack-said".into(), said)),
    );
    if let Some(row) = page.row("slack.notification_channel") {
        out.push(
            Field::new()
                .label("Post notifications to")
                .prefix("The toasts you keep on, under Notifications, also go here.")
                .control(destination_control(
                    page,
                    &row,
                    k,
                    layer,
                    "slack-notify-in-card".into(),
                ))
                .build(k),
        );
        if let Some(why) = page.refusals.get(&row.id()) {
            out.push(said_line(k, "slack-notify-error".into(), &Err(why.clone())));
        }
        let (said, marker, _) = meta_of(app, page, &row);
        out.push(
            text(said)
                .role("status")
                .font(k.ty.text_xsmall)
                .color(paint(k, marker)),
        );
    }
    out.push(
        across()
            .gap(8.0)
            .child(
                Button::new(if page.slack_loading {
                    "Refreshing…"
                } else {
                    "Refresh Slack"
                })
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(page.slack_loading)
                .on_press(|app: &mut App| {
                    super::refresh_connections(app);
                    super::refresh_slack(app)
                })
                .build(k)
                .key("refresh-slack"),
            )
            .children(signed.map(|_| {
                Button::new("Sign out")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .disabled(page.slack_busy)
                    .on_press(|app: &mut App| super::sign_in_slack(app, true))
                    .build(k)
                    .key("sign-out-slack-user")
            })),
    );
    out.push(muted(k, "Talking to Collie in Slack is not built."));
    out
}

fn connection_card(page: &Settings, card: &ConnectionCard, uses: &str, k: &Kit) -> El {
    let key = connections::id_name(&card.id);
    let opened = page.opened.as_ref() == Some(&card.id);
    let busy = page.busy.as_ref() == Some(&card.id);
    let primary = card.primary.as_ref().map(|p| {
        let c = card.clone();
        Button::new(p.label().to_string())
            .variant(ButtonVariant::Contrast)
            .control_size(ControlSize::Small)
            .disabled(page.busy.is_some())
            .on_press(move |app: &mut App| super::connect(app, &c))
            .build(k)
            .key(format!("connect-{key}"))
    });
    let id = card.id.clone();
    let details = Button::new(if opened { "Close" } else { "Details" })
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Small)
        .expanded(opened)
        .on_press(move |app: &mut App| {
            let page = &mut app.pages.settings;
            page.opened = if page.opened.as_ref() == Some(&id) {
                None
            } else {
                Some(id.clone())
            };
        })
        .build(k)
        .key(format!("details-{key}"))
        .label(format!("{} details", card.name));
    let state = Badge::new(card.state.clone())
        .variant(if card.needs_you {
            BadgeVariant::Subtle
        } else {
            BadgeVariant::Accent
        })
        .build(k);
    col()
        .key(format!("connection-{key}"))
        .role("group")
        .label(format!("{}: {}", card.name, card.state))
        .gap(6.0)
        .padding(12.0)
        .w(232.0)
        .min_h(168.0)
        .radius(k.radius.lg)
        .fill(k.c.surface_raised_base)
        .border(
            1.0,
            if opened {
                k.c.border_focus
            } else {
                k.c.border_weak
            },
        )
        .child(
            across()
                .gap(8.0)
                .w_full()
                .center_y()
                .justify_between()
                .child(heading(k, card.name))
                .child(state),
        )
        .child(
            text(
                card.account
                    .clone()
                    .unwrap_or_else(|| "No account connected".into()),
            )
            .font(k.ty.text_small)
            .color(k.c.text_base)
            .truncate()
            .w_full(),
        )
        .child(
            text(card.where_.clone())
                .font(k.ty.text_xsmall)
                .color(if card.needs_you {
                    k.c.warning.fg
                } else {
                    k.c.text_muted
                })
                .wrap()
                .w_full(),
        )
        .child(
            text(format!("Used by {uses}"))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .wrap()
                .w_full(),
        )
        .children(
            page.done
                .get(key)
                .map(|said| said_line(k, format!("connection-{key}-said"), said)),
        )
        .child(el().grow(1.0))
        .child(
            across()
                .gap(8.0)
                .center_y()
                .children(busy.then(|| Spinner::new().size(14.0).build(k)))
                .children(primary)
                .child(details),
        )
}

fn connections_view(app: &App, page: &Settings, k: &Kit, layer: &mut Vec<El>) -> El {
    let cards = super::connection_cards(app);
    let workflows = connections::workflows(&page.connections);
    let mut out = col()
        .key("connections")
        .role("group")
        .label("Connections")
        .gap(12.0)
        .w_full()
        .child(
            across()
                .gap(8.0)
                .w_full()
                .center_y()
                .justify_between()
                .child(heading(k, "Connections"))
                .child(
                    across()
                        .gap(6.0)
                        .center_y()
                        .children(
                            page.connections_reading
                                .then(|| Spinner::new().size(12.0).build(k)),
                        )
                        .child(
                            Button::new("Refresh")
                                .variant(ButtonVariant::GhostMuted)
                                .control_size(ControlSize::Small)
                                .disabled(page.connections_reading)
                                .on_press(super::refresh_connections)
                                .build(k)
                                .key("refresh-connections")
                                .label("Refresh Connections"),
                        ),
                ),
        )
        .child(muted(
            k,
            "The services your Flock reaches, as which account, and on which Machines. Use a login a Machine already has everywhere, or connect where none is found.",
        ))
        .children(page.connections_trouble.as_ref().map(|why| {
            notice(k, "connections-trouble", "Connections could not be read", why)
        }))
        .children(page.credentials_trouble.as_ref().map(|why| {
            notice(
                k,
                "credentials-trouble",
                "Desktop could not read its credentials",
                why,
            )
        }))
        .child(
            across()
                .key("connection-cards")
                .gap(12.0)
                .flex_wrap()
                .w_full()
                .children(cards.iter().map(|card| {
                    let used: Vec<String> = connections::uses(&card.id, &workflows)
                        .into_iter()
                        .map(|u| u.id)
                        .collect();
                    let used = if used.is_empty() {
                        "no declared workflow".to_string()
                    } else {
                        used.join(", ")
                    };
                    connection_card(page, card, &used, k)
                })),
        );
    let Some(card) = page
        .opened
        .as_ref()
        .and_then(|id| cards.iter().find(|c| &c.id == id))
    else {
        return out;
    };
    let mut details: Vec<El> = vec![heading(k, &format!("{} · {}", card.name, card.state))];
    if card.id == Id::Slack {
        details.extend(slack_details(app, page, k, layer));
    }
    let uses = connections::uses(&card.id, &workflows);
    if !uses.is_empty() {
        details.push(
            col()
                .key("connection-uses")
                .role("table")
                .label(format!("Workflows that declare {}", card.name))
                .gap(4.0)
                .w_full()
                .children(uses.iter().map(|u| {
                    across()
                        .role("row")
                        .label(format!(
                            "{} {} {}; without it: {}",
                            u.id, u.declares, u.with, u.without
                        ))
                        .gap(12.0)
                        .w_full()
                        .child(
                            text(u.id.clone())
                                .font(k.ty.small_medium)
                                .color(k.c.text_strong)
                                .w(140.0)
                                .a11y_hidden(),
                        )
                        .child(
                            text(u.declares)
                                .font(k.ty.text_small)
                                .color(k.c.text_muted)
                                .w(60.0)
                                .a11y_hidden(),
                        )
                        .child(
                            text(u.with.clone())
                                .font(k.ty.text_small)
                                .color(k.c.text_base)
                                .grow(1.0)
                                .shrink()
                                .wrap()
                                .a11y_hidden(),
                        )
                        .child(
                            text(u.without.clone())
                                .font(k.ty.text_small)
                                .color(k.c.text_muted)
                                .grow(1.0)
                                .shrink()
                                .wrap()
                                .a11y_hidden(),
                        )
                })),
        );
    }
    details.push(
        col()
            .key("connection-machines")
            .role("list")
            .label(format!("{} on each Machine", card.name))
            .gap(6.0)
            .w_full()
            .children(card.machines.iter().map(|m| {
                let (detail, fix) = match (&m.problem, &m.reading) {
                    (Some(problem), _) => (problem.clone(), None),
                    (None, Some(collie_desktop_protocol::generated::ConnectionReading::Ok(ok))) => {
                        (ok.detail.clone(), None)
                    }
                    (None, Some(collie_desktop_protocol::generated::ConnectionReading::ConnectionReading1(r))) => {
                        (r.detail.clone(), Some(r.fix.clone()))
                    }
                    (None, None) => ("Not read yet".into(), None),
                };
                col()
                    .role("listitem")
                    .label(format!("{}: {detail}", m.name))
                    .gap(2.0)
                    .w_full()
                    .child(
                        across()
                            .gap(12.0)
                            .w_full()
                            .justify_between()
                            .child(text(m.name.clone()).font(k.ty.small_medium).color(k.c.text_strong).a11y_hidden())
                            .child(text(detail).font(k.ty.text_small).color(k.c.text_muted).shrink().wrap().a11y_hidden()),
                    )
                    .children(fix.map(|fix| {
                        text(fix)
                            .font(k.ty.text_xsmall)
                            .color(k.c.text_faint)
                            .wrap()
                            .w_full()
                            .a11y_hidden()
                    }))
            })),
    );
    match card.id {
        Id::Gitlab => details.extend(gitlab_details(page, k)),
        Id::Helle => details.extend(helle_details(k, page)),
        Id::Github => details.push(muted(
            k,
            "gh keeps the login on each Machine. If gh is missing, install it there, then try again. After finishing the browser login, refresh Connections.",
        )),
        Id::Linear => details.push(muted(
            k,
            "Setup adds the Linear MCP and opens its browser login. A remembered team belongs to that Machine; renovate asks through Linear when it needs one.",
        )),
        Id::Slack => {}
    }
    out = out.child(
        col()
            .key("connection-details")
            .role("region")
            .label(format!("{} details", card.name))
            .gap(14.0)
            .padding(16.0)
            .w_full()
            .radius(k.radius.lg)
            .border(1.0, k.c.border_weak)
            .fill(k.c.surface_raised_base)
            .children(details),
    );
    out
}

fn about_view(page: &Settings, k: &Kit) -> El {
    let mut out = col()
        .key("about")
        .role("group")
        .label("About")
        .gap(10.0)
        .w_full()
        .child(heading(k, "About"));
    if let Some(why) = &page.updates_trouble {
        out = out.child(notice(
            k,
            "updates-trouble",
            "Desktop could not hear about its updates; showing what it last heard",
            why,
        ));
    }
    let Some(updates) = &page.updates else {
        return out.child(muted(k, "Reading Desktop's version…"));
    };
    let ready = matches!(updates.news, News::Ready(_));
    let working = page.checking || matches!(updates.news, News::Checking(_) | News::Downloading(_));
    let action = if ready {
        Button::new("Restart Collie")
            .variant(ButtonVariant::Contrast)
            .control_size(ControlSize::Small)
            .on_press(super::restart)
            .build(k)
            .key("restart-desktop")
    } else {
        Button::new(if working {
            "Checking…"
        } else {
            "Check for updates"
        })
        .variant(ButtonVariant::Outline)
        .control_size(ControlSize::Small)
        .disabled(working || matches!(updates.news, News::Never(_)))
        .on_press(super::check_for_updates)
        .build(k)
        .key("check-for-updates")
    };
    out.child(panel(
        k,
        "desktop-version".into(),
        vec![
            col()
                .gap(6.0)
                .px(16.0)
                .py(14.0)
                .w_full()
                .child(
                    across()
                        .gap(8.0)
                        .w_full()
                        .center_y()
                        .child(
                            text(format!("Collie {}", updates.version))
                                .font(k.ty.ui_medium)
                                .color(k.c.text_strong)
                                .grow(1.0),
                        )
                        .children(working.then(|| Spinner::new().size(12.0).build(k)))
                        .child(action),
                )
                .child(
                    text(super::update_said(&updates.news, &updates.version))
                        .key("update-state")
                        .role("status")
                        .font(k.ty.text_small)
                        .color(k.c.text_muted)
                        .wrap()
                        .w_full(),
                )
                .children(
                    page.restart_refused
                        .as_ref()
                        .map(|why| said_line(k, "restart-refused".into(), &Err(why.clone()))),
                ),
        ],
    ))
}

/// Each Machine's own settings, one row a Machine, as `MachineOwnTable.vue` lays them out.
fn own_view(app: &App, k: &Kit) -> El {
    let readings: std::collections::HashMap<String, collie_desktop_protocol::generated::Reading> =
        app.board
            .flock
            .own
            .iter()
            .map(|(profile, reading)| (profile.to_string(), reading.clone()))
            .collect();
    let owned = crate::pages::flock::own_rows(
        &crate::pages::machines::rows(app),
        &readings,
        collie_desktop_protocol::epoch_ms(),
        &crate::pages::clock::Zone::here(),
    );
    const COLUMNS: [(&str, f32); 6] = [
        ("Machine", 0.19),
        ("Settings sync", 0.19),
        ("projects.root", 0.16),
        ("chat_harness", 0.13),
        ("Harnesses found", 0.14),
        ("Remembered", 0.19),
    ];
    let cell = |at: usize, body: El| {
        col()
            .w_frac(COLUMNS[at].1)
            .min_w(0.0)
            .px(12.0)
            .py(10.0)
            .gap(2.0)
            .child(body)
    };
    let small =
        |s: String, color: Color| text(s).font(k.ty.text_small).color(color).wrap().w_full();
    let mono = |s: String, color: Color| {
        text(s)
            .font(k.ty.mono)
            .color(color)
            .wrap_anywhere()
            .w_full()
            .selectable(true)
            .selection_color(k.selection())
    };
    let none = || small("—".into(), k.c.text_faint);
    let header = COLUMNS.iter().enumerate().fold(
        across().w_full().role("row").fill(k.c.surface_raised_base),
        |row, (at, (title, _))| {
            row.child(
                cell(
                    at,
                    text(title.to_string())
                        .role("columnheader")
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_faint),
                )
                .py(8.0),
            )
        },
    );
    let mut table = col()
        .key("own-table")
        .role("table")
        .label("What each Machine keeps for itself")
        .w_full()
        .radius(k.radius.lg)
        .border(1.0, k.c.border_weak)
        .clip_rounded(k.radius.lg)
        .child(header)
        .child(Divider::horizontal().build(k));
    if owned.is_empty() {
        table = table.child(
            el().px(12.0)
                .py(12.0)
                .child(muted(k, "No Machines yet. Open Machines to add one.")),
        );
    }
    let n = owned.len();
    for (i, one) in owned.iter().enumerate() {
        let value = |v: &Option<String>| match v {
            None => none(),
            Some(v) if v == "Not set" => small(v.clone(), k.c.text_faint),
            Some(v) => mono(v.clone(), k.c.text_base),
        };
        let remembered = if one.remembered.is_empty() {
            none()
        } else {
            col().w_full().gap(2.0).children(
                one.remembered
                    .iter()
                    .map(|(key, v)| mono(format!("{key} = {v}"), k.c.text_muted)),
            )
        };
        let line = across()
            .key(format!("own-{}", one.profile))
            .role("row")
            .label(format!("{}: {}", one.name, one.sync))
            .w_full()
            .items_start()
            .child(cell(
                0,
                col()
                    .w_full()
                    .gap(2.0)
                    .child(
                        text(one.name.clone())
                            .font(k.ty.ui_medium)
                            .color(k.c.text_strong)
                            .truncate(),
                    )
                    .child(small(one.where_.clone(), k.c.text_faint)),
            ))
            .child(cell(
                1,
                col()
                    .w_full()
                    .gap(2.0)
                    .child(
                        across()
                            .gap(6.0)
                            .center_y()
                            .child(el().size(7.0, 7.0).radius(3.5).fill(if one.sync_ok {
                                k.c.success.icon
                            } else {
                                k.c.warning.icon
                            }))
                            .child(text(one.sync).font(k.ty.text_small_medium).color(
                                if one.sync_ok {
                                    k.c.text_base
                                } else {
                                    k.c.warning.fg
                                },
                            )),
                    )
                    .children(
                        one.detail
                            .clone()
                            .map(|d| small(d, k.c.text_faint).key("own-detail")),
                    ),
            ))
            .child(cell(2, value(&one.projects_root)))
            .child(cell(3, value(&one.chat_harness)))
            .child(cell(
                4,
                if one.harnesses.is_empty() {
                    none()
                } else {
                    small(one.harnesses.join(", "), k.c.text_muted)
                },
            ))
            .child(cell(5, remembered));
        table = table.child(line);
        if i + 1 < n {
            table = table.child(Divider::horizontal().build(k));
        }
    }
    col()
        .key("machine-own")
        .role("group")
        .label("Each Machine's own")
        .gap(10.0)
        .w_full()
        .child(
            across()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(heading(k, "Each Machine's own").grow(1.0))
                .child(
                    Button::new("Open Machines")
                        .variant(ButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .on_press(|app: &mut App| app.open_page(Page::Machines))
                        .build(k)
                        .key("open-machines"),
                ),
        )
        .child(muted(
            k,
            "Kept in each Machine's config.json, not shared: where its projects live, its Native chat's harness, its terminal backend, its worktrees and the answers it remembered. Edit them in that Machine's TUI Settings.",
        ))
        .child(table)
}

fn index_view(shown: &[Shown], connections: Option<usize>, own: bool, about: bool, k: &Kit) -> El {
    let entry = |label: String, target: String, trailing: Option<(String, Color)>| {
        let key = format!("index-{target}");
        across()
            .key(key)
            .role("link")
            .label(label.clone())
            .focusable(true)
            .h(28.0)
            .px(8.0)
            .gap(8.0)
            .w_full()
            .center_y()
            .radius(k.radius.md)
            .hover(k.c.hover)
            .press(k.c.pressed)
            .on_press_tx(move |_: &mut App, tx: &mut Tx| tx.scroll_into_view(target.clone()))
            .child(
                text(label)
                    .font(k.ty.ui_compact)
                    .color(k.c.text_base)
                    .grow(1.0)
                    .truncate()
                    .a11y_hidden(),
            )
            .children(trailing.map(|(t, c)| text(t).font(k.ty.text_xsmall).color(c).a11y_hidden()))
    };
    let caption = |s: &str| {
        text(s.to_uppercase())
            .font(k.ty.text_xsmall_medium)
            .color(k.c.text_faint)
            .px(8.0)
            .pt(8.0)
            .pb(4.0)
    };
    let mut out = col()
        .key("settings-index")
        .role("navigation")
        .label("Settings sections")
        .w(196.0)
        .gap(2.0)
        .py(16.0)
        .px(8.0)
        .child(caption("Every Machine"));
    for s in shown {
        out = out.child(entry(
            s.group.to_string(),
            format!("settings-{}", s.group),
            (s.set > 0).then(|| (format!("{} set", s.set), k.c.text_faint)),
        ));
    }
    if let Some(need) = connections {
        out = out.child(entry(
            "Connections".into(),
            "connections".into(),
            (need > 0).then(|| (format!("{need} need you"), k.c.warning.fg)),
        ));
    }
    if own || about {
        out = out.child(caption("Elsewhere"));
    }
    if own {
        out = out.child(entry(
            "Each Machine's own".into(),
            "machine-own".into(),
            None,
        ));
    }
    if about {
        out = out.child(entry("About".into(), "about".into(), None));
    }
    out
}

pub fn view(app: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    RUN.set(RUN.get().wrapping_add(1));
    let page = &app.pages.settings;
    let filter = Filter::of(page);
    let shown = shown(page, &filter);
    let total: usize = page.sections(&[]).iter().map(|s| s.rows.len()).sum();
    let shown_count: usize = shown
        .iter()
        .flat_map(|s| &s.subs)
        .map(|(_, rows, _, _)| rows.len())
        .sum();
    let show_connections = !filter.only_set && filter.names(CONNECTION_WORDS);
    let show_own = !filter.only_set && filter.names(OWN_WORDS);
    let show_about = !filter.filtering() || filter.names(ABOUT_WORDS);
    let machines = super::reached(app);
    let pill = model::sync_pill(page.readable(), &machines);
    let need_you = super::connection_cards(app)
        .iter()
        .filter(|c| c.needs_you)
        .count();

    let search = TextInput::new(&page.query)
        .leading_icon(k.glyph.search)
        .placeholder("Find a setting by name, key or what it does")
        .label("Find a setting")
        .width(None)
        .clear_button()
        .on_edit(|app: &mut App| &mut app.pages.settings.query)
        .on_action(|app: &mut App, _: &mut Tx| app.pages.settings.query.clear())
        .build(k)
        .key("settings-search");
    let only_set = Switch::new(page.only_set)
        .label("Only what is set")
        .on_toggle(|app: &mut App| {
            let page = &mut app.pages.settings;
            page.only_set = !page.only_set
        })
        .build(k)
        .key("settings-only-set");
    let counted = text(if filter.filtering() {
        format!("{shown_count} of {total} settings shown")
    } else {
        format!("{total} settings")
    })
    .key("settings-count")
    .live_region(LiveRegion::Polite)
    .font(k.ty.text_small)
    .color(k.c.text_muted);
    let pill_el = across()
        .key("sync-pill")
        .role("status")
        .label(pill.said.clone())
        .gap(6.0)
        .center_y()
        .child(
            el().size(8.0, 8.0)
                .radius(4.0)
                .fill(tone(k, pill.tone))
                .a11y_hidden(),
        )
        .child(
            text(pill.said.clone())
                .font(k.ty.text_small)
                .color(tone(k, pill.tone))
                .a11y_hidden(),
        );
    let top = col()
        .gap(10.0)
        .w_full()
        .child(
            across()
                .gap(12.0)
                .w_full()
                .center_y()
                .child(el().grow(1.0).shrink().child(search))
                .child(only_set),
        )
        .child(
            across()
                .w_full()
                .center_y()
                .justify_between()
                .child(counted)
                .child(pill_el),
        );

    let mut main = col()
        .key("settings-main")
        .gap(28.0)
        .w_full()
        .max_w(820.0)
        .padding(24.0)
        .child(top);
    if let Some(why) = &page.trouble {
        main = main.child(notice(
            k,
            "settings-trouble",
            "The Flock's settings could not be read; showing what they last were",
            why,
        ));
    }
    if shown_count == 0 && !show_connections && !show_about && !show_own {
        main = main.child(
            col()
                .key("settings-none")
                .gap(8.0)
                .child(
                    text(format!("No setting matches “{}”.", page.query.text.trim()))
                        .font(k.ty.ui_medium)
                        .color(k.c.text_strong),
                )
                .child(
                    Button::new("Show every setting")
                        .variant(ButtonVariant::Outline)
                        .on_press(|app: &mut App| {
                            let page = &mut app.pages.settings;
                            page.query.clear();
                            page.only_set = false;
                        })
                        .build(k)
                        .key("settings-show-all"),
                ),
        );
    }
    if !shown.is_empty() || show_connections {
        let mut band = col()
            .key("band-flock")
            .role("group")
            .label("Every Machine")
            .gap(28.0)
            .w_full()
            .child(
                col()
                    .gap(6.0)
                    .w_full()
                    .child(
                        text("Every Machine")
                            .font(k.ty.body_medium)
                            .color(k.c.text_strong),
                    )
                    .child(muted(
                        k,
                        "The Flock's settings. Desktop gives each edit to every Machine through its host; an edit in any Machine's TUI counts the same. Each key is its latest edit, wherever it was made.",
                    ))
                    .children((page.readable() && pill.tone == Tone::Warn).then(|| {
                        muted(
                            k,
                            "A Machine out of reach gets every edit made meanwhile when it connects, unless it made a later one itself.",
                        )
                        .color(k.c.warning.fg)
                    })),
            );
        for s in &shown {
            band = band.child(section_view(app, page, s, k, layer));
        }
        if show_connections {
            band = band.child(connections_view(app, page, k, layer));
        }
        main = main.child(band);
    }
    if show_own {
        main = main.child(own_view(app, k));
    }
    if show_about {
        main = main.child(about_view(page, k));
    }

    let index = index_view(
        &shown,
        show_connections.then_some(need_you),
        show_own,
        show_about,
        k,
    );
    // Under this width the index would squeeze every setting's words; the search finds them.
    let narrow = page.width > 0.0 && page.width < 820.0;
    across()
        .key("settings-page")
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .items_start()
        .on_layout(|app: &mut App, [_, _, w, _]: [f32; 4]| {
            let page = &mut app.pages.settings;
            if (page.width - w).abs() > 1.0 {
                page.width = w;
            }
        })
        .children((!narrow).then_some(index))
        .child(
            el().key(format!(
                "settings-onboardings-{}",
                app.pages.machines.onboardings
            ))
            .size(0.0, 0.0)
            .on_layout(|app: &mut App, _| super::onboarding_moved(app)),
        )
        .child(collie_desktop_chat::glide::smooth::<App>(
            col()
                .key("settings-scroll")
                .grow(1.0)
                .min_h(0.0)
                .h_full()
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .scroll_edge_fade(16.0)
                .child(main),
            "settings-scroll",
        ))
}
