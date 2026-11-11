//! The Schedules page: every connected Machine's Schedules in one table, and pausing,
//! resuming, removing or moving the chosen one. A port of `desktop/src/shared/schedules.ts`,
//! `useSchedules` and `MoveScheduleDialog.vue`.

use super::common::{Told, Tone, muted, toasts, toned};
use crate::App;
use collie_desktop_protocol::generated::{
    Change, ChangeSchedulePayload, Last, LastOutcome, MoveSchedulePayload, Schedule,
    SchedulesSuccessItem,
};
use rune::{El, TextEdit, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, Cell, ControlSize, Dialog, Field, Kit, Select, Table, TableColumn,
    TableState, TextInput,
};
use std::borrow::Cow;

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
            None => expression,
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
    pub table: TableState,
    pub moving: Option<Moving>,
    pub told: Told,
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

    fn chosen(&self) -> Option<RowView> {
        let id = self.table.cursor()?;
        self.rows()
            .into_iter()
            .find(|r| format!("{}/{}", r.installation, r.name) == id)
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
        let state = &mut self.pages.schedules;
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

fn cell(row: &RowView, column: &str) -> Cell {
    match column {
        "name" => Cell::text(row.name.clone()),
        "machine" => Cell::text(row.machine.clone()).muted(),
        "workflow" => Cell::text(format!("{} in {}", row.workflow, row.checkout)).muted(),
        "when" => Cell::text(row.when.clone()),
        "next" => Cell::text(row.next.clone()).mono(),
        _ => Cell::text(row.last.clone()).muted(),
    }
}

fn actions(state: &Schedules, k: &Kit) -> El {
    let bar = row()
        .key("schedule-actions")
        .w_full()
        .h(32.0)
        .gap(8.0)
        .center_y();
    let refresh = Button::new("Refresh")
        .variant(ButtonVariant::Ghost)
        .control_size(ControlSize::Small)
        .on_press(|app: &mut App| app.read_schedules())
        .build(k)
        .key("schedules-refresh");
    let Some(chosen) = state.chosen() else {
        return bar
            .child(muted(k, "Choose a Schedule to pause, resume, remove or move it.").grow(1.0))
            .child(refresh);
    };
    let mut bar = bar.child(
        text(format!("{} on {}", chosen.name, chosen.machine))
            .font(k.ty.text_small_medium)
            .color(k.c.text_base)
            .truncate()
            .shrink(),
    );
    bar = bar.child(el().grow(1.0));
    for action in &chosen.actions {
        let (installation, name, action) =
            (chosen.installation.clone(), chosen.name.clone(), *action);
        bar = bar.child(
            Button::new(action.label())
                .variant(if action == Action::Remove {
                    ButtonVariant::Danger
                } else {
                    ButtonVariant::Outline
                })
                .control_size(ControlSize::Small)
                .on_press(move |app: &mut App| app.schedule_action(&installation, &name, action))
                .build(k)
                .key(action.key()),
        );
    }
    bar.child(refresh)
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
    let mut page = col()
        .key("schedules-page")
        .label("Schedules")
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .padding(20.0)
        .gap(14.0);
    if !state.listed {
        return page.child(muted(k, "Reading each Machine's Schedules…"));
    }
    let notes = state.machines.iter().filter_map(|m| {
        let view = machine_schedules(m);
        let tone = match view.state {
            Standing::Empty | Standing::Listed => Tone::Quiet,
            _ => Tone::Warn,
        };
        view.said
            .map(|said| toned(k, said, tone).key(format!("schedules-said-{}", m.profile)))
    });
    page = page
        .child(col().w_full().gap(4.0).children(notes))
        .child(actions(state, k));
    let rows = state.rows();
    if rows.is_empty() {
        return page;
    }
    let cells = rows.clone();
    page.child(
        Table::new(
            |app: &App| &app.pages.schedules.table,
            |app: &mut App| &mut app.pages.schedules.table,
            |app: &App| app.pages.schedules.rows().len(),
            |app: &App, i| {
                Cow::Owned(
                    app.pages
                        .schedules
                        .rows()
                        .get(i)
                        .map_or_else(String::new, |r| format!("{}/{}", r.installation, r.name)),
                )
            },
        )
        .name("Schedules")
        .column(TableColumn::new("name", "Schedule").flex(1.0).min(110.0))
        .column(
            TableColumn::new("machine", "Machine")
                .width(110.0)
                .min(80.0),
        )
        .column(
            TableColumn::new("workflow", "Workflow")
                .flex(1.4)
                .min(140.0),
        )
        .column(TableColumn::new("when", "When").flex(1.6).min(160.0))
        .column(TableColumn::new("next", "Next").flex(1.2).min(140.0))
        .column(TableColumn::new("last", "Last").flex(1.4).min(140.0))
        .cell(move |_: &App, i, column| {
            cells
                .get(i)
                .map_or_else(|| Cell::text(""), |row| cell(row, column))
        })
        .zebra(true)
        .build(app, k)
        .key("schedules")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .radius(k.radius.md)
        .border(1.0, k.c.border_muted)
        .clip_rounded(k.radius.md),
    )
}
