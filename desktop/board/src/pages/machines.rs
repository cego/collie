//! The Machines page: each route Desktop reaches a Machine by, whether it is In sync with
//! Desktop, its onboarding, and what each keeps for itself; adding, removing, onboarding,
//! syncing and cleaning one up. The spec is `MachinesPage.vue` and its dialogs.

use super::cleanup::{self, Cleanup};
use super::common::{Told, Tone, muted, panel, status, toasts, toned};
use super::flock::{Fold, MachineRow, RowState, route_said, settled};
use super::in_sync::{DesktopHolds, Verdict, build_of, flock_in_sync, in_sync, syncable};
use super::onboard;
use crate::calls::Stop;
use crate::{App, Shown};
use collie_desktop_protocol::generated::{
    AddMachinePayload, CredentialsSuccess, FlockItem, LostState, News, SyncNowSuccess,
    UpdatesSuccess,
};
use rune::{El, TextEdit, col, el, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Field, Kit, TextInput};
use serde_json::json;

/// What Add Machine asks for.
#[derive(Default)]
pub struct Adding {
    pub target: TextEdit,
    pub label: TextEdit,
    pub session: TextEdit,
    /// The core is saving it; the dialog stays until it answers.
    pub busy: bool,
    /// Why the core refused it, said in the dialog.
    pub refused: Option<String>,
}

impl Adding {
    /// What Add Machine sends, trimmed, once every field is filled.
    pub fn to_add(&self) -> Option<AddMachinePayload> {
        let [target, label, session] =
            [&self.target, &self.label, &self.session].map(|edit| edit.text.trim().to_string());
        (!target.is_empty() && !label.is_empty() && !session.is_empty()).then_some(
            AddMachinePayload {
                target,
                label,
                session,
            },
        )
    }
}

#[derive(Default)]
pub struct Machines {
    /// Every `flock` item folded, as the Machines page needs them.
    pub flock: Fold,
    /// Desktop's own version, once `updates` has said it.
    pub version: Option<String>,
    stops: Vec<Stop>,
    pub cleanup: Cleanup,
    pub adding: Option<Adding>,
    /// The onboarding the dialog shows, by job.
    pub job: Option<String>,
    /// A login code being pasted.
    pub code: TextEdit,
    pub told: Told,
    /// Counts each onboarding run that has moved on, which Settings reads its Connections again on.
    pub onboardings: u64,
}

impl Machines {
    /// Hears a `flock` item; the board hands each one here as it folds it.
    pub fn heard(&mut self, item: &FlockItem) {
        if let FlockItem::Onboarding(one) = item {
            let before = self.flock.job(&one.job).map(|o| (o.run.at, o.run.ready));
            if before != Some((one.run.at, one.run.ready)) {
                self.onboardings += 1;
            }
        }
        self.flock.apply(item);
    }

    /// The sidebar has opened this page.
    pub fn opened(app: &mut App) {
        app.listen_machines();
    }

    /// What Desktop holds for every Machine, once its version and the board's `credentials` have said.
    fn holds(&self, app: &App) -> Option<DesktopHolds> {
        Some(DesktopHolds {
            version: self.version.clone()?,
            credentials: credentials_held(app.board.credentials.as_ref()?),
        })
    }
}

/// Each route as the page lists it; before the page has heard any, what the board knows.
pub fn rows(app: &App) -> Vec<MachineRow> {
    let fold = &app.pages.machines.flock;
    if !fold.routes.is_empty() {
        return fold.rows();
    }
    app.machines.iter().map(|shown| bare(app, shown)).collect()
}

fn bare(app: &App, shown: &Shown) -> MachineRow {
    let state = match (app.lost_of(&shown.machine.profile), shown.as_of) {
        (Some(lost), _) => RowState::NotLive(lost.clone()),
        (None, Some(_)) => RowState::Connecting,
        (None, None) => RowState::Live,
    };
    let mut row = MachineRow::bare(&shown.machine.profile, &shown.machine.name, state);
    row.target = shown.machine.target.clone();
    row.settings = app.board.flock.synced.get(&shown.machine.profile).cloned();
    row
}

fn credentials_held(held: &CredentialsSuccess) -> Vec<&'static str> {
    let mut credentials = Vec::new();
    if held.gitlab.is_some() {
        credentials.push("gitlab");
    }
    if held.helle {
        credentials.push("helle");
    }
    credentials
}

fn news_said(news: &News) -> (String, bool) {
    match news {
        News::Checking(_) => ("Checking for updates…".into(), true),
        News::UpToDate(now) => (format!("Desktop {} is up to date", now.version), true),
        News::Downloading(next) => (format!("Downloading Desktop {}…", next.version), true),
        News::Ready(next) => (
            format!("Desktop {} is ready; restart to install it", next.version),
            true,
        ),
        News::Refused(refused) => (
            format!(
                "Desktop {} was refused: {}",
                refused.version, refused.reason
            ),
            false,
        ),
        News::Failed(failed) => (failed.reason.clone(), false),
        News::Never(never) => (never.reason.clone(), false),
    }
}

fn told(app: &mut App) -> &mut Told {
    &mut app.pages.machines.told
}

impl App {
    /// Hears Desktop's version, once, for the In sync verdicts.
    pub fn listen_machines(&mut self) {
        let Some(core) = &self.core else { return };
        if !self.pages.machines.stops.is_empty() {
            return;
        }
        let updates = core.stream(
            "updates",
            (),
            |app: &mut App, said: Result<UpdatesSuccess, _>| {
                if let Ok(said) = said {
                    app.pages.machines.version = Some(said.version);
                }
            },
        );
        self.pages.machines.stops = vec![updates];
    }

    pub fn open_add_machine(&mut self) {
        let mut adding = Adding {
            session: TextEdit::new("default"),
            ..Adding::default()
        };
        adding.target.focused = true;
        self.pages.machines.adding = Some(adding);
    }

    /// Saves the Machine typed in herdr, then onboards it: the dialog closes on the core's
    /// yes and shows its onboarding, or keeps what was typed and says why not.
    pub fn add_machine(&mut self) {
        let Some(adding) = self.pages.machines.adding.as_mut() else {
            return;
        };
        let Some(payload) = adding.to_add().filter(|_| !adding.busy) else {
            return;
        };
        let Some(core) = &self.core else { return };
        adding.busy = true;
        adding.refused = None;
        core.request("addMachine", payload, |app: &mut App, job| {
            let machines = &mut app.pages.machines;
            match (job, machines.adding.as_mut()) {
                (Ok(job), _) => {
                    machines.adding = None;
                    machines.job = Some(job);
                }
                (Err(why), Some(adding)) => {
                    adding.busy = false;
                    adding.refused = Some(why.0);
                }
                (Err(why), None) => told(app).say(why.0, false),
            }
        });
    }

    /// Removes a route from herdr's list; nothing on its Machine is stopped or uninstalled.
    pub fn remove_machine(&mut self, profile: &str) {
        let Some(core) = &self.core else { return };
        core.request(
            "removeMachine",
            json!({ "profile": profile }),
            |app: &mut App, said: Result<String, _>| match said {
                Ok(said) => told(app).say(said, true),
                Err(why) => told(app).say(why.0, false),
            },
        );
    }

    /// Does for a lagging Machine what connecting would, and says what it did.
    pub fn sync_now(&mut self, profile: &str) {
        let Some(core) = &self.core else { return };
        core.request(
            "syncNow",
            json!({ "profile": profile }),
            |app: &mut App, said: Result<SyncNowSuccess, _>| match said {
                Ok(said) => told(app).say(said.said, !said.failed),
                Err(why) => told(app).say(why.0, false),
            },
        );
    }

    pub fn check_for_updates(&mut self) {
        let Some(core) = &self.core else { return };
        core.request(
            "checkForUpdates",
            (),
            |app: &mut App, news: Result<News, _>| {
                let (said, ok) = match news {
                    Ok(news) => news_said(&news),
                    Err(why) => (why.0, false),
                };
                told(app).say(said, ok);
            },
        );
    }
}

/// How many Machines Desktop reaches now, and each it doesn't, in words: `1 of 2 Machines
/// reached · vm is connecting`.
pub fn reach(rows: &[MachineRow]) -> (String, Tone) {
    if rows.is_empty() {
        return ("No Machines yet".into(), Tone::Quiet);
    }
    let live = rows.iter().filter(|r| r.state.is_live()).count();
    let plural = if rows.len() == 1 { "" } else { "s" };
    let mut said = vec![format!("{live} of {} Machine{plural} reached", rows.len())];
    let mut tone = Tone::Ok;
    for row in rows {
        match &row.state {
            RowState::Live => {}
            RowState::Connecting => {
                said.push(format!("{} is connecting", row.name));
                if tone == Tone::Ok {
                    tone = Tone::Quiet;
                }
            }
            RowState::NotLive(state) => {
                said.push(format!(
                    "{}: {}",
                    row.name,
                    super::flock::not_live_said(state).to_lowercase()
                ));
                tone = Tone::Warn;
            }
        }
    }
    (said.join(" · "), tone)
}

/// The In sync sentence, which leaves a Machine still connecting out, and says so.
pub fn in_sync_said(rows: &[MachineRow], holds: &DesktopHolds) -> (String, usize) {
    let (said, lagging) = flock_in_sync(rows, holds);
    let connecting = rows.iter().any(|r| r.state == RowState::Connecting);
    if lagging == 0 && connecting {
        return (
            said.replacen("Every Machine is", "Every Machine reached is", 1),
            0,
        );
    }
    (said, lagging)
}

fn small(label: &str, variant: ButtonVariant) -> Button {
    Button::new(label)
        .variant(variant)
        .control_size(ControlSize::Small)
}

fn verdict_word(state: &Verdict) -> (&'static str, Tone) {
    match state {
        Verdict::InSync => ("In sync", Tone::Ok),
        Verdict::Behind => ("Behind", Tone::Warn),
        Verdict::Connecting => ("Connecting", Tone::Quiet),
        Verdict::NotLive(state) => (super::flock::not_live_said(state), Tone::Warn),
    }
}

fn machine(k: &Kit, row: &MachineRow, holds: &DesktopHolds) -> El {
    let verdict = in_sync(row, holds);
    let (word, tone) = verdict_word(&verdict.state);
    let mut where_ = vec![row.target.clone().unwrap_or_else(|| "this computer".into())];
    if let Some(route) = &row.route {
        where_.push(route_said(route, row.transport.as_ref()));
    }
    let header = rune::row()
        .w_full()
        .gap(10.0)
        .center_y()
        .child(
            text(row.name.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .a11y_hidden(),
        )
        .child(
            text(where_.join(" · "))
                .font(k.ty.text_small)
                .color(k.c.text_muted)
                .truncate()
                .shrink(),
        )
        .child(el().grow(1.0))
        .child(status(k, word, tone).key("state"));
    let mut body = panel(
        k,
        format!("machine-{}", row.profile),
        format!("{}: {word}", row.name),
    )
    .child(header);
    if let Some(reason) = &row.reason {
        body = body.child(toned(k, reason.clone(), Tone::Warn).key("reason"));
    }
    if let Some(reason) = &row.transport_reason {
        // Why its paired link runs over SSH; the core keeps it while the link does.
        body = body.child(muted(k, format!("Not direct: {reason}")).key("transport-reason"));
    }
    for lag in &verdict.behind {
        body = body.child(toned(k, lag.said.clone(), Tone::Warn));
        if lag.part == super::in_sync::Part::Onboarding {
            body = body.child(onboard::steps(
                k,
                "missing",
                &row.profile,
                &lag.steps,
                true,
                None,
            ));
        }
    }
    match &row.onboarded {
        Some(run) if run.ready == Some(true) => {
            body = body.child(toned(k, "Onboarded", Tone::Ok).key("onboarded"));
        }
        Some(run) if run.ready == Some(false) && verdict.state != Verdict::Behind => {
            let missing: Vec<_> = run
                .steps
                .iter()
                .filter(|s| !settled(&s.status))
                .cloned()
                .collect();
            body = body
                .child(toned(k, "Not onboarded yet:", Tone::Warn))
                .child(onboard::steps(
                    k,
                    "missing",
                    &row.profile,
                    &missing,
                    true,
                    None,
                ));
        }
        _ => {}
    }
    let mut actions = rune::row().w_full().gap(8.0).center_y().child(
        text(build_of(row))
            .key("build")
            .font(k.ty.text_small)
            .color(k.c.text_faint)
            .grow(1.0)
            .shrink()
            .truncate(),
    );
    let profile = row.profile.clone();
    if syncable(&verdict) {
        let profile = profile.clone();
        actions = actions.child(
            small("Sync now", ButtonVariant::Warning)
                .on_press(move |app: &mut App| app.sync_now(&profile))
                .build(k)
                .key("sync-now"),
        );
    }
    if row.state == RowState::NotLive(LostState::UpdateDesktop) {
        actions = actions.child(
            small("Check for updates", ButtonVariant::Outline)
                .on_press(|app: &mut App| app.check_for_updates())
                .build(k)
                .key("check-updates"),
        );
    }
    if row.target.is_some() {
        let profile = profile.clone();
        actions = actions.child(
            small("Remove", ButtonVariant::Outline)
                .on_press(move |app: &mut App| app.remove_machine(&profile))
                .build(k)
                .key("remove"),
        );
    }
    actions = actions.child(
        small("Onboard", ButtonVariant::Neutral)
            .on_press(move |app: &mut App| app.onboard_on(&profile, None))
            .build(k)
            .key("onboard"),
    );
    body.child(actions)
}

fn add_dialog(app: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(adding) = &app.pages.machines.adding else {
        return;
    };
    let field = |label: &str, edit: &TextEdit, lens: fn(&mut App) -> &mut TextEdit, key: &str| {
        Field::new()
            .label(label)
            .control(
                TextInput::new(edit)
                    .width(None)
                    .label(label)
                    .on_edit(lens)
                    .on_submit(|app: &mut App, _| app.add_machine())
                    .build(k)
                    .key(key.to_string()),
            )
            .build(k)
    };
    fn adding_of(app: &mut App) -> &mut Adding {
        app.pages
            .machines
            .adding
            .get_or_insert_with(Adding::default)
    }
    let body = col()
        .key("add-form")
        .w_full()
        .px(16.0)
        .pb(16.0)
        .gap(12.0)
        .child(field(
            "SSH target",
            &adding.target,
            |app| &mut adding_of(app).target,
            "add-target",
        ))
        .child(muted(k, "As ssh reaches it, such as mk@vm-mk.example"))
        .child(
            rune::row()
                .w_full()
                .gap(10.0)
                .child(
                    field(
                        "Label",
                        &adding.label,
                        |app| &mut adding_of(app).label,
                        "add-label",
                    )
                    .grow(1.0),
                )
                .child(
                    field(
                        "herdr session",
                        &adding.session,
                        |app| &mut adding_of(app).session,
                        "add-session",
                    )
                    .grow(1.0),
                ),
        )
        .children(adding.refused.as_ref().map(|why| {
            toned(k, why.clone(), Tone::Bad)
                .key("add-refused")
                .role("alert")
                .label(why.clone())
        }))
        .child(
            rune::row().w_full().child(el().grow(1.0)).child(
                Button::new(if adding.busy {
                    "Adding…"
                } else {
                    "Add Machine"
                })
                .variant(ButtonVariant::Contrast)
                .disabled(adding.busy || adding.to_add().is_none())
                .on_press(|app: &mut App| app.add_machine())
                .build(k)
                .key("add-submit"),
            ),
        );
    Dialog::new("add-machine", "Add Machine")
        .description("Saves it in herdr, then onboards it.")
        .width(480.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|app: &mut App| app.pages.machines.adding = None)
        .build(collie_desktop_theme::dialog(k.dark), layer);
}

pub fn view(app: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    let machines = &app.pages.machines;
    let rows = rows(app);
    let holds = machines.holds(app);
    let (reached, reach_tone) = reach(&rows);
    let synced = holds.as_ref().map(|holds| in_sync_said(&rows, holds));
    let line = |key: &str, said: String, tone: Tone, font, color| {
        rune::row()
            .key(key.to_string())
            .role("status")
            .label(said.clone())
            .w_full()
            .gap(8.0)
            .items_start()
            .child(
                el().mt(6.0)
                    .size(7.0, 7.0)
                    .radius(3.5)
                    .fill(super::common::tone_color(k, tone))
                    .a11y_hidden(),
            )
            .child(
                text(said)
                    .font(font)
                    .color(color)
                    .wrap()
                    .grow(1.0)
                    .shrink()
                    .a11y_hidden(),
            )
    };
    let mut summary = col().grow(1.0).shrink().min_w(0.0).gap(6.0).child(line(
        "reach",
        reached,
        reach_tone,
        k.ty.body_medium,
        k.c.text_strong,
    ));
    if let Some((said, lagging)) = synced {
        let tone = if lagging == 0 { Tone::Ok } else { Tone::Warn };
        summary = summary.child(line("in-sync", said, tone, k.ty.text_small, k.c.text_muted));
    }
    let top = rune::row()
        .w_full()
        .gap(16.0)
        .items_start()
        .child(summary)
        .child(
            rune::row()
                .gap(8.0)
                .child(
                    Button::new("Clean up…")
                        .variant(ButtonVariant::Outline)
                        .on_press(|app: &mut App| {
                            app.open_cleanup(collie_desktop_protocol::epoch_ms())
                        })
                        .build(k)
                        .key("clean-up"),
                )
                .child(
                    Button::new("Add Machine")
                        .variant(ButtonVariant::Contrast)
                        .on_press(|app: &mut App| app.open_add_machine())
                        .build(k)
                        .key("add-machine"),
                ),
        );
    let holds = holds.unwrap_or(DesktopHolds {
        version: String::new(),
        credentials: vec![],
    });
    let list = col()
        .key("machines")
        .w_full()
        .gap(12.0)
        .children(rows.iter().map(|row| machine(k, row, &holds)));
    add_dialog(app, k, layer);
    cleanup::dialog(app, &rows, k, layer);
    toasts(app, &machines.told, told, k, layer);
    super::common::page("machines-page", "Machines", vec![top, list])
}
