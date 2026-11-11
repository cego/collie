//! The Schedules page: every connected Machine's Schedules in one table, and pausing,
//! resuming, removing or moving the chosen one. A port of `desktop/src/shared/schedules.ts`,
//! `useSchedules` and `MoveScheduleDialog.vue`.

use super::clock::{Zone, epoch_ms, reset_in, when_of};
use super::common::{Told, Tone, muted, toasts, toned};
use crate::App;
use collie_desktop_protocol::generated::{
    Change, ChangeSchedulePayload, Last, LastOutcome, MoveSchedulePayload, Schedule,
    SchedulesSuccessItem,
};
use rune::{El, TextEdit, col, el, row, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, Dialog, Divider, Field, Kit, Select,
    Spinner, TextInput,
};

pub const UPGRADE_SAID: &str = "Can't list its Schedules; upgrade this Machine.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Pause,
    Resume,
    Remove,
    Move,
}

impl Action {
    pub fn label(self) -> &'static str {
        match self {
            Action::Pause => "Pause",
            Action::Resume => "Resume",
            Action::Remove => "Remove",
            Action::Move => "Move to…",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Action::Pause => "schedule-pause",
            Action::Resume => "schedule-resume",
            Action::Remove => "schedule-remove",
            Action::Move => "schedule-move",
        }
    }
}

/// What a row's action asks: a change sent as `changeSchedule`'s payload, or the move dialog.
#[derive(Debug, Clone, PartialEq)]
pub enum Ask {
    Move { from: String, name: String },
    Change(ChangeSchedulePayload),
}

pub fn schedule_ask(installation: &str, name: &str, action: Action) -> Ask {
    let change = match action {
        Action::Move => {
            return Ask::Move {
                from: installation.into(),
                name: name.into(),
            };
        }
        Action::Pause => Change::Pause,
        Action::Resume => Change::Resume,
        Action::Remove => Change::Remove,
    };
    Ask::Change(ChangeSchedulePayload {
        installation: installation.into(),
        change,
        name: name.into(),
        request: None,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowView {
    pub installation: String,
    pub machine: String,
    pub name: String,
    pub workflow: String,
    pub checkout: String,
    /// `every day at 07:00 (0 7 * * * Europe/Copenhagen)`.
    pub when: String,
    /// `next …`, or `paused`.
    pub next: String,
    pub last: String,
    pub actions: Vec<Action>,
    /// What `when`, `next` and `last` are made of, for the page to say on its own clock.
    pub cron_words: Option<String>,
    pub expression: String,
    pub paused: bool,
    pub next_at: Option<String>,
    pub last_at: Option<(String, String)>,
}

/// When a Schedule fires next, on this computer's clock: `05:00 · in 3h 0m`.
pub fn next_said(row: &RowView, now: f64, zone: &Zone) -> String {
    if row.paused {
        return "Paused".into();
    }
    match row.next_at.as_deref() {
        None => "When its Run ends".into(),
        Some(iso) => match epoch_ms(iso) {
            Some(ms) => format!("{} · {}", when_of(ms, now, zone), reset_in(iso, now)),
            None => iso.to_string(),
        },
    }
}

/// What its last occurrence came to, on this computer's clock: `14 Oct, 05:00 · run-1 complete`.
pub fn last_said(row: &RowView, now: f64, zone: &Zone) -> String {
    match &row.last_at {
        None => "Nothing yet".into(),
        Some((iso, said)) => match epoch_ms(iso) {
            Some(ms) => format!("{} · {said}", when_of(ms, now, zone)),
            None => format!("{iso} · {said}"),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Listed,
    Empty,
    Upgrade,
    Unreachable,
    Problem,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MachineView {
    pub state: Standing,
    pub said: Option<String>,
    pub rows: Vec<RowView>,
}

const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

fn number(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())
}

/// A cron expression in words, for the shapes people write; `None` for the rest.
pub fn cron_words(cron: &str) -> Option<String> {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    let [minute, hour, day, month, weekday] = parts[..] else {
        return None;
    };
    if day != "*" || month != "*" {
        return None;
    }
    if let Some(step) = minute.strip_prefix("*/").filter(|s| number(s))
        && hour == "*"
        && weekday == "*"
    {
        return Some(format!("every {step} minutes"));
    }
    if !number(minute) {
        return None;
    }
    let mm = format!("{minute:0>2}");
    if hour == "*" && weekday == "*" {
        return Some(format!("every hour at :{mm}"));
    }
    if !number(hour) {
        return None;
    }
    let at = format!("at {hour:0>2}:{mm}");
    match weekday {
        "*" => Some(format!("every day {at}")),
        "1-5" => Some(format!("weekdays {at}")),
        day if number(day) => {
            let named = DAYS[(day.parse::<usize>().ok()?) % 7];
            Some(format!("every {named} {at}"))
        }
        _ => None,
    }
}

fn outcome_said(last: &Last) -> String {
    match &last.outcome {
        LastOutcome::Run(run) => format!("{} {}", run.run, run.status),
        LastOutcome::WaitingForRun(run) => format!("waiting for {} ({})", run.run, run.status),
        LastOutcome::WaitingForHerdr(_) => "waiting for herdr".into(),
        LastOutcome::Refused(refused) => format!("refused: {}", refused.reason),
    }
}

/// What one Schedule's last occurrence came to, in a few words.
pub fn last_line(last: Option<&Last>) -> String {
    let Some(last) = last else {
        return "nothing yet".into();
    };
    let said = match &last.outcome {
        LastOutcome::Run(run) => format!("{} {}", run.run, run.status),
        LastOutcome::WaitingForRun(run) => format!("waiting for {} ({})", run.run, run.status),
        LastOutcome::WaitingForHerdr(_) => "waiting for herdr".into(),
        LastOutcome::Refused(refused) => format!("refused: {}", refused.reason),
    };
    format!("{} {said}", last.occurrence)
}

fn row_of(machine: &SchedulesSuccessItem, entry: &Schedule) -> RowView {
    let expression = format!("{} {}", entry.cron, entry.tz);
    RowView {
        installation: machine.installation.clone(),
        machine: machine.name.clone(),
        name: entry.name.clone(),
        workflow: entry.workflow.clone(),
        checkout: entry.checkout.clone(),
        when: match cron_words(&entry.cron) {
            None => expression.clone(),
            Some(words) => format!("{words} ({expression})"),
        },
        next: if entry.paused {
            "paused".into()
        } else {
            format!(
                "next {}",
                entry.next.as_deref().unwrap_or("when its Run ends")
            )
        },
        last: last_line(entry.last.as_ref()),
        cron_words: cron_words(&entry.cron),
        expression,
        paused: entry.paused,
        next_at: entry.next.clone(),
        last_at: entry
            .last
            .as_ref()
            .map(|last| (last.occurrence.clone(), outcome_said(last))),
        actions: vec![
            if entry.paused {
                Action::Resume
            } else {
                Action::Pause
            },
            Action::Remove,
            Action::Move,
        ],
    }
}

/// A Machine's Schedules, or why it lists none.
pub fn machine_schedules(machine: &SchedulesSuccessItem) -> MachineView {
    let none = |state, said: String| MachineView {
        state,
        said: Some(said),
        rows: vec![],
    };
    if machine.unreachable {
        let why = machine
            .problem
            .as_ref()
            .map_or_else(String::new, |p| format!(" ({p})"));
        return none(
            Standing::Unreachable,
            format!(
                "{} is unreachable{why}; its Schedules still fire there while its host runs.",
                machine.name
            ),
        );
    }
    if let Some(problem) = &machine.problem {
        let state = if problem == UPGRADE_SAID {
            Standing::Upgrade
        } else {
            Standing::Problem
        };
        return none(state, problem.clone());
    }
    if machine.schedules.is_empty() {
        return MachineView {
            state: Standing::Empty,
            said: Some(format!(
                "No Schedules on {}. Ask the Flock chat to add one.",
                machine.name
            )),
            rows: vec![],
        };
    }
    MachineView {
        state: Standing::Listed,
        said: None,
        rows: machine
            .schedules
            .iter()
            .map(|entry| row_of(machine, entry))
            .collect(),
    }
}

/// Moving a Schedule: the Machine it goes to and its checkout there.
#[derive(Default)]
pub struct Moving {
    pub from: String,
    pub name: String,
    pub to: Option<String>,
    pub checkout: TextEdit,
    pub choosing: bool,
}

#[derive(Default)]
pub struct Schedules {
    pub machines: Vec<SchedulesSuccessItem>,
    /// Whether the first listing has come.
    pub listed: bool,
    asks: u64,
    /// The Machines live when the latest listing was asked for; another set asks again.
    asked_live: Option<String>,
    pub moving: Option<Moving>,
    pub told: Told,
}

/// The Machines live now, as a listing of Schedules is asked of them.
fn live_set(app: &App) -> String {
    let mut live: Vec<&str> = app
        .machines
        .iter()
        .filter(|m| app.is_live(m))
        .map(|m| m.machine.installation.as_str())
        .collect();
    live.sort_unstable();
    live.join(" ")
}

impl Schedules {
    /// The sidebar has opened this page.
    pub fn opened(app: &mut App) {
        app.read_schedules();
    }

    /// Every listed Schedule, Machine by Machine.
    pub fn rows(&self) -> Vec<RowView> {
        self.machines
            .iter()
            .flat_map(|m| machine_schedules(m).rows)
            .collect()
    }

    /// The other reachable Machines a Schedule on `from` can move to: installation and name.
    pub fn targets(&self, from: &str) -> Vec<(String, String)> {
        self.machines
            .iter()
            .filter(|m| !m.unreachable && m.problem.is_none() && m.installation != from)
            .map(|m| (m.installation.clone(), m.name.clone()))
            .collect()
    }
}

fn schedules(app: &mut App) -> &mut Schedules {
    &mut app.pages.schedules
}

impl App {
    /// Asks each connected Machine's host for its Schedules; an older ask never wins.
    pub fn read_schedules(&mut self) {
        let Some(core) = &self.core else { return };
        let live = live_set(self);
        let state = &mut self.pages.schedules;
        state.asked_live = Some(live);
        state.asks += 1;
        let ask = state.asks;
        core.request(
            "schedules",
            (),
            move |app: &mut App, listed: Result<Vec<SchedulesSuccessItem>, _>| {
                let state = schedules(app);
                if state.asks != ask {
                    return;
                }
                match listed {
                    Ok(machines) => {
                        state.machines = machines;
                        state.listed = true;
                    }
                    Err(why) => state.told.say(why.0, false),
                }
            },
        );
    }

    /// The page has drawn with `live` Machines; one that came or went since the listing
    /// was asked for has Schedules of its own, so every Machine is asked again.
    /// Reads the schedules again where the Machines live now differ from those asked; whether
    /// it did.
    pub fn schedules_reach(&mut self, live: &str) -> bool {
        let state = &self.pages.schedules;
        let stale = self.nav.page == crate::shell::Page::Schedules
            && state
                .asked_live
                .as_deref()
                .is_some_and(|asked| asked != live);
        if stale {
            self.read_schedules();
        }
        stale
    }

    fn schedule_said(&mut self, said: Result<String, crate::calls::CallError>) {
        match said {
            Ok(said) => schedules(self).told.say(said, true),
            Err(why) => schedules(self).told.say(why.0, false),
        }
        self.read_schedules();
    }

    /// A row's action: a change asked of its Machine's host, or the move dialog.
    pub fn schedule_action(&mut self, installation: &str, name: &str, action: Action) {
        match schedule_ask(installation, name, action) {
            Ask::Move { from, name } => {
                let to = self
                    .pages
                    .schedules
                    .targets(&from)
                    .first()
                    .map(|t| t.0.clone());
                self.pages.schedules.moving = Some(Moving {
                    from,
                    name,
                    to,
                    ..Moving::default()
                });
            }
            Ask::Change(payload) => {
                let Some(core) = &self.core else { return };
                core.request("changeSchedule", payload, |app: &mut App, said| {
                    app.schedule_said(said)
                });
            }
        }
    }

    /// Moves the Schedule the dialog names to the Machine chosen there.
    pub fn move_schedule(&mut self) {
        let Some(moving) = self.pages.schedules.moving.take() else {
            return;
        };
        let Some(to) = moving.to else { return };
        let Some(core) = &self.core else { return };
        let payload = MoveSchedulePayload {
            from: moving.from,
            to,
            name: moving.name,
            checkout: Some(Some(moving.checkout.text.trim().to_string())),
            request: None,
        };
        core.request("moveSchedule", payload, |app: &mut App, said| {
            app.schedule_said(said)
        });
    }
}

fn move_dialog(state: &Schedules, k: &Kit, layer: &mut Vec<El>) {
    let Some(moving) = &state.moving else { return };
    let targets = state.targets(&moving.from);
    let body = if targets.is_empty() {
        col()
            .px(16.0)
            .pb(16.0)
            .child(muted(k, "No other Machine is reachable to move it to."))
    } else {
        let names: Vec<String> = targets.iter().map(|t| t.1.clone()).collect();
        let current = moving
            .to
            .as_ref()
            .and_then(|to| targets.iter().find(|t| &t.0 == to))
            .map(|t| t.1.clone());
        let chosen = targets.clone();
        let select = Select::new("move-to", &names)
            .label("Machine")
            .current(current.as_deref())
            .open(moving.choosing)
            .on_toggle(|app: &mut App| {
                if let Some(m) = &mut app.pages.schedules.moving {
                    m.choosing = !m.choosing;
                }
            })
            .on_close(|app: &mut App| {
                if let Some(m) = &mut app.pages.schedules.moving {
                    m.choosing = false;
                }
            })
            .on_choose(move |app: &mut App, name: &str, _| {
                if let Some(m) = &mut app.pages.schedules.moving {
                    m.to = chosen.iter().find(|t| t.1 == name).map(|t| t.0.clone());
                    m.choosing = false;
                }
            })
            .build(k, layer)
            .key("move-to");
        col()
            .key("move-form")
            .w_full()
            .px(16.0)
            .pb(16.0)
            .gap(12.0)
            .child(Field::new().label("Machine").control(select).build(k))
            .child(
                Field::new()
                    .label("Checkout there")
                    .control(
                        TextInput::new(&moving.checkout)
                            .label("Checkout there")
                            .placeholder("The same path")
                            .on_edit(|app: &mut App| {
                                &mut app
                                    .pages
                                    .schedules
                                    .moving
                                    .get_or_insert_with(Moving::default)
                                    .checkout
                            })
                            .on_submit(|app: &mut App, _| app.move_schedule())
                            .build(k)
                            .key("move-checkout"),
                    )
                    .build(k),
            )
            .child(muted(
                k,
                "Its absolute path on that Machine, where it differs; empty keeps the same path.",
            ))
            .child(
                row().w_full().child(el().grow(1.0)).child(
                    Button::new("Move")
                        .variant(ButtonVariant::Contrast)
                        .disabled(moving.to.is_none())
                        .on_press(|app: &mut App| app.move_schedule())
                        .build(k)
                        .key("move-submit"),
                ),
            )
    };
    Dialog::new("move-schedule", format!("Move {} to…", moving.name))
        .width(460.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|app: &mut App| app.pages.schedules.moving = None)
        .build(k, layer);
}

fn action_button(k: &Kit, row: &RowView, action: Action) -> El {
    let (installation, name) = (row.installation.clone(), row.name.clone());
    Button::new(action.label())
        .variant(if action == Action::Remove {
            ButtonVariant::GhostMuted
        } else {
            ButtonVariant::Ghost
        })
        .control_size(ControlSize::Small)
        .on_press(move |app: &mut App| app.schedule_action(&installation, &name, action))
        .build(k)
        .key(action.key())
        .label(format!(
            "{} {}",
            action.label().trim_end_matches('…'),
            row.name
        ))
}

/// One fact of a Schedule: a faint caption over its value.
fn fact(k: &Kit, caption: &str, value: String, sub: Option<String>) -> El {
    col()
        .w_frac(1.0 / 3.0)
        .min_w(0.0)
        .pr(12.0)
        .gap(2.0)
        .role("group")
        .label(format!("{caption}: {value}"))
        .child(
            text(caption.to_string())
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_faint)
                .a11y_hidden(),
        )
        .child(
            text(value)
                .font(k.ty.text_small)
                .color(k.c.text_base)
                .wrap()
                .w_full()
                .a11y_hidden(),
        )
        .children(sub.map(|sub| {
            text(sub)
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .wrap_anywhere()
                .w_full()
                .a11y_hidden()
        }))
}

fn schedule_row(k: &Kit, row: &RowView, now: f64, zone: &Zone) -> El {
    let title = rune::row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(
            text(row.name.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .truncate()
                .shrink(),
        )
        .children(row.paused.then(|| {
            Badge::new("Paused")
                .variant(BadgeVariant::Subtle)
                .build(k)
                .key("paused")
        }))
        .child(el().grow(1.0))
        .children(row.actions.iter().map(|a| action_button(k, row, *a)));
    let when = match &row.cron_words {
        Some(words) => {
            let mut chars = words.chars();
            let first = chars.next().map(|c| c.to_uppercase().to_string());
            first.unwrap_or_default() + chars.as_str()
        }
        None => row.expression.clone(),
    };
    col()
        .key(format!("schedule-{}", row.name))
        .role("listitem")
        .label(format!("{} on {}", row.name, row.machine))
        .w_full()
        .px(16.0)
        .py(12.0)
        .gap(8.0)
        .child(title)
        .child(
            text(format!("{} in {}", row.workflow, row.checkout))
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .truncate()
                .w_full(),
        )
        .child(
            rune::row()
                .w_full()
                .items_start()
                .child(fact(
                    k,
                    "Runs",
                    when,
                    row.cron_words.as_ref().map(|_| row.expression.clone()),
                ))
                .child(fact(k, "Next", next_said(row, now, zone), None))
                .child(fact(k, "Last", last_said(row, now, zone), None)),
        )
}

fn machine_section(k: &Kit, machine: &SchedulesSuccessItem, now: f64, zone: &Zone) -> El {
    let view = machine_schedules(machine);
    let count = match view.state {
        Standing::Listed => {
            let n = view.rows.len();
            format!("{n} Schedule{}", if n == 1 { "" } else { "s" })
        }
        Standing::Empty => "No Schedules".into(),
        Standing::Upgrade => "Needs an upgrade".into(),
        Standing::Unreachable => "Out of reach".into(),
        Standing::Problem => "Not listed".into(),
    };
    let tone = match view.state {
        Standing::Listed | Standing::Empty => Tone::Quiet,
        _ => Tone::Warn,
    };
    let head = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(
            text(machine.name.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong),
        )
        .child(
            text(count)
                .font(k.ty.text_small)
                .color(if tone == Tone::Warn {
                    k.c.warning.fg
                } else {
                    k.c.text_faint
                }),
        );
    let mut body = col()
        .key("list")
        .role("list")
        .label(format!("{}'s Schedules", machine.name))
        .w_full()
        .radius(k.radius.lg)
        .fill(k.c.surface_raised_base)
        .border(1.0, k.c.border_weak);
    if view.rows.is_empty() {
        let said = view.said.unwrap_or_default();
        body = body.child(
            col()
                .w_full()
                .px(16.0)
                .py(14.0)
                .child(toned(k, said, tone).key(format!("schedules-said-{}", machine.profile))),
        );
    }
    let n = view.rows.len();
    for (i, one) in view.rows.iter().enumerate() {
        body = body.child(schedule_row(k, one, now, zone));
        if i + 1 < n {
            body = body.child(Divider::horizontal().build(k));
        }
    }
    col()
        .key(format!("schedules-{}", machine.installation))
        .role("group")
        .label(machine.name.clone())
        .w_full()
        .gap(8.0)
        .child(head)
        .child(body)
}

pub fn view(app: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    let state = &app.pages.schedules;
    move_dialog(state, k, layer);
    toasts(
        &state.told,
        |app: &mut App| &mut app.pages.schedules.told,
        k,
        layer,
    );
    let live = live_set(app);
    let reach = live.clone();
    let marker = el()
        .key(format!("schedules-reach-{live}"))
        .w_full()
        .h(0.0)
        // It moves with every frame of a scroll, which asks nothing new.
        .on_layout_tx(move |app: &mut App, _, tx| {
            if !app.schedules_reach(&reach) {
                tx.live_only();
            }
        });
    let header = row()
        .w_full()
        .gap(16.0)
        .items_start()
        .child(
            col()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .gap(4.0)
                .child(
                    text("Each Machine's Schedules")
                        .role("heading")
                        .font(k.ty.body_medium)
                        .color(k.c.text_strong),
                )
                .child(muted(
                    k,
                    "A Schedule is a saved start its Machine's host fires on time, even while Desktop is closed. Ask the Flock chat to add one.",
                )),
        )
        .child(
            Button::new("Refresh")
                .icon(&crate::icons::REFRESH)
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(|app: &mut App| app.read_schedules())
                .build(k)
                .key("schedules-refresh"),
        );
    let mut children = vec![header];
    if !state.listed {
        children.push(
            row()
                .gap(8.0)
                .center_y()
                .child(Spinner::new().size(12.0).build(k))
                .child(muted(k, "Reading each Machine's Schedules…")),
        );
    } else {
        let now = collie_desktop_protocol::epoch_ms();
        let zone = Zone::here();
        children.extend(
            state
                .machines
                .iter()
                .map(|m| machine_section(k, m, now, &zone)),
        );
    }
    col()
        .key("schedules-page")
        .label("Schedules")
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .child(marker)
        .child(super::common::page(
            "schedules-scroll",
            "Schedules",
            children,
        ))
}
