//! The Settings page: the Flock's settings, Record timing, the Connections and About.
//! The core checks every value (`parseSetting`); this page only says what it refused.

pub mod agents;
pub mod connections;
pub mod model;
pub mod registry;
pub mod time;
mod view;

pub use view::view;

use crate::App;
use crate::calls::{CallError, Stop};
use collie_desktop_protocol::generated::{
    CataloguesSuccessItem, ConnectionReadingsSuccessItem, CredentialsSuccess, FlockSettingsSuccess,
    Id, LostState, News, SettingsSuccess, SlackUserChannelsSuccessItem, SlackUserSuccess,
    UpdatesSuccess,
};
use model::{Reached, Row};
use rune::TextEdit;
use rune_kit::ComboboxState;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The two tokens Desktop keeps for every Machine, typed masked until revealed.
pub struct Token {
    pub edit: TextEdit,
    pub revealed: bool,
    pub saving: bool,
    pub said: Option<Result<String, String>>,
}

impl Default for Token {
    fn default() -> Self {
        Token {
            edit: TextEdit::new("").secure(),
            revealed: false,
            saving: false,
            said: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Gitlab,
    Helle,
}

/// An edit of the Flock's settings the core has not kept yet.
struct Pending {
    ask: u64,
    /// The settings it changes, which the Flock's settings show changed once it is kept.
    keys: Vec<String>,
    /// The rows that say how far it reached, once it is.
    saves: Vec<String>,
    /// That it is an agent choice, which the others wait for.
    choice: bool,
}

#[derive(Default)]
pub struct Settings {
    /// The Flock's settings as last read, and why the latest read failed.
    pub flock: Option<FlockSettingsSuccess>,
    pub trouble: Option<String>,
    pub desktop: Option<SettingsSuccess>,
    pub credentials: Option<CredentialsSuccess>,
    pub credentials_trouble: Option<String>,
    pub updates: Option<UpdatesSuccess>,
    pub updates_trouble: Option<String>,
    pub checking: bool,
    pub restart_refused: Option<String>,
    pub slack_user: Option<SlackUserSuccess>,
    /// The channels the human is in; `None` while they are not signed in to Slack.
    pub slack_yours: Option<Vec<SlackUserChannelsSuccessItem>>,
    pub slack_loading: bool,
    pub slack_busy: bool,
    pub slack_said: Option<Result<String, String>>,
    pub catalogues: Vec<CataloguesSuccessItem>,
    pub catalogue_problem: Option<String>,
    pub connections: Vec<ConnectionReadingsSuccessItem>,
    pub connections_trouble: Option<String>,
    pub connections_reading: bool,
    asked_connections: u64,
    asked_catalogues: u64,
    asked_slack: u64,

    pub query: TextEdit,
    pub only_set: bool,
    pub advanced_open: bool,
    /// What is typed into a row, by its id, until it is set.
    pub drafts: BTreeMap<String, TextEdit>,
    /// Why the core refused a row's latest edit, by its id.
    pub refusals: BTreeMap<String, String>,
    /// The rows edited since the page opened, which say how far the edit reached.
    pub saved: BTreeSet<String>,
    /// The rows whose edit the core is checking now.
    pub saving: BTreeSet<String>,
    /// Each edit sent of the Flock's settings, by its row's id, until the core has kept it.
    pending: BTreeMap<String, Pending>,
    asked_edits: u64,
    /// An agent choice is being saved; the others wait for it.
    pub choosing: bool,
    /// The open Select, by its key.
    pub open_select: Option<String>,
    pub combos: BTreeMap<String, ComboboxState>,

    /// The connection whose details are open.
    pub opened: Option<Id>,
    pub busy: Option<Id>,
    /// What came of a connection's latest action, by its id.
    pub done: BTreeMap<String, Result<String, String>>,
    pub gitlab: Token,
    pub helle: Token,
    /// Who Helle says the typed token belongs to, or why it refused it, for that token.
    pub helle_check: Option<(String, Result<String, String>)>,
    pub other_host: bool,
    pub host: TextEdit,
    pub host_saving: bool,
    pub host_said: Option<Result<String, String>>,

    streams: Vec<Stop>,
    /// The Machines page's count of onboardings moved on, as Connections were last read for it.
    pub onboardings_read: u64,
    /// The page's width as last laid out; a narrow page leaves its index out.
    pub width: f32,
}

impl Settings {
    /// The sidebar has opened this page: asks again for what it shows, which syncs every
    /// connected Machine's settings and so shows their edits.
    pub fn opened(app: &mut App) {
        let Some(core) = app.core.clone() else {
            return;
        };
        let page = &mut app.pages.settings;
        for stop in page.streams.drain(..) {
            stop();
        }
        page.saved.clear();
        page.refusals.clear();
        page.streams = vec![
            core.stream(
                "flockSettings",
                (),
                |app: &mut App, read: Result<FlockSettingsSuccess, CallError>| {
                    app.pages.settings.flock_read(read)
                },
            ),
            core.stream(
                "settings",
                (),
                |app: &mut App, read: Result<SettingsSuccess, CallError>| {
                    if let Ok(desktop) = read {
                        app.pages.settings.desktop = Some(desktop);
                    }
                },
            ),
            core.stream(
                "credentials",
                (),
                |app: &mut App, read: Result<CredentialsSuccess, CallError>| {
                    let page = &mut app.pages.settings;
                    match read {
                        Ok(held) => {
                            page.credentials = Some(held);
                            page.credentials_trouble = None;
                        }
                        Err(why) => page.credentials_trouble = Some(why.0),
                    }
                },
            ),
            core.stream(
                "updates",
                (),
                |app: &mut App, read: Result<UpdatesSuccess, CallError>| {
                    let page = &mut app.pages.settings;
                    match read {
                        Ok(news) => {
                            page.updates = Some(news);
                            page.updates_trouble = None;
                        }
                        Err(why) => page.updates_trouble = Some(why.0),
                    }
                },
            ),
            core.stream(
                "slackUser",
                (),
                |app: &mut App, read: Result<SlackUserSuccess, CallError>| {
                    if let Ok(state) = read {
                        app.pages.settings.slack_user = Some(state);
                    }
                },
            ),
        ];
        refresh_catalogues(app);
        app.pages.settings.onboardings_read = app.pages.machines.onboardings;
        refresh_connections(app);
        refresh_slack(app);
    }

    fn flock_read(&mut self, read: Result<FlockSettingsSuccess, CallError>) {
        match read {
            Ok(flock) => {
                self.kept(&flock);
                // A draft still showing the old value takes the new one.
                let before = self.sections(&[]);
                self.drafts.retain(|id, draft| {
                    before
                        .iter()
                        .flat_map(|s| &s.rows)
                        .find(|r| &r.id() == id)
                        .is_none_or(|r| draft.text != r.value)
                });
                self.flock = Some(flock);
                self.trouble = None;
            }
            Err(why) => self.trouble = Some(why.0),
        }
    }

    /// An edit the Flock's settings now show is saved, though the core still gives it to
    /// every Machine before it answers; how far it reached is said from their syncs.
    fn kept(&mut self, flock: &FlockSettingsSuccess) {
        let Some(before) = &self.flock else { return };
        let changed = |key: &String| before.settings.get(key) != flock.settings.get(key);
        let kept: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, edit)| edit.keys.iter().any(changed))
            .map(|(id, _)| id.clone())
            .collect();
        for id in kept {
            let Some(edit) = self.pending.remove(&id) else {
                continue;
            };
            self.saving.remove(&id);
            self.drafts.remove(&id);
            self.saved.extend(edit.saves);
            if edit.choice {
                self.choosing = false;
            }
        }
    }

    /// Notes an edit sent for row `id`; its answer is the latest one's only while it is.
    fn sent(&mut self, id: &str, keys: Vec<String>, saves: Vec<String>, choice: bool) -> u64 {
        self.asked_edits += 1;
        let ask = self.asked_edits;
        self.saving.insert(id.into());
        self.pending.insert(
            id.into(),
            Pending {
                ask,
                keys,
                saves,
                choice,
            },
        );
        ask
    }

    /// Whether `ask` is row `id`'s edit still waiting; it no longer is once answered.
    fn settle(&mut self, id: &str, ask: u64) -> bool {
        if self.pending.get(id).is_none_or(|edit| edit.ask != ask) {
            return false;
        }
        let edit = self.pending.remove(id);
        self.saving.remove(id);
        if edit.is_some_and(|e| e.choice) {
            self.choosing = false;
        }
        true
    }

    /// Whether the Flock's settings can be read now; an edit made otherwise would be blind.
    pub fn readable(&self) -> bool {
        self.flock.is_some() && self.trouble.is_none()
    }

    pub fn sections(&self, _machines: &[Reached]) -> Vec<model::Section> {
        let empty = FlockSettingsSuccess {
            settings: Default::default(),
            synced: None,
        };
        let desktop = self.desktop.clone().unwrap_or(SettingsSuccess {
            proactive: None,
            gitlab_host: None,
            machine_rule: None,
            zoom: None,
            chat_harness: None,
            chat_model: None,
            chat_effort: None,
            chat_width: None,
            record_timing: None,
            setup_not_now: None,
            setup_never: None,
        });
        model::sections(
            self.flock.as_ref().unwrap_or(&empty),
            &desktop,
            time::now_ms(),
            time::local_offset(),
        )
    }

    pub fn row(&self, key: &str) -> Option<Row> {
        self.sections(&[])
            .into_iter()
            .flat_map(|s| s.rows)
            .find(|r| r.key == key)
    }

    /// The agent choice every step runs on, as set or as it falls back.
    pub fn agent_settings(&self) -> agents::AgentSettings {
        let value = |key: &str| {
            self.row(key)
                .map_or(String::new(), |r| r.effective().into())
        };
        agents::AgentSettings {
            harness: value("harness"),
            model: value("model"),
            effort: value("effort"),
        }
    }

    /// What is typed in the row, or its value while nothing is.
    pub fn draft_of(&self, row: &Row) -> String {
        self.drafts
            .get(&row.id())
            .map_or(row.value.clone(), |d| d.text.clone())
    }

    pub fn dirty(&self, row: &Row) -> bool {
        self.draft_of(row) != row.value
    }

    fn forget(&mut self, id: &str) {
        self.refusals.remove(id);
        self.saved.remove(id);
    }

    /// Puts a row's draft back to its value, keeping the field's focus.
    pub fn revert(&mut self, row: &Row) {
        let id = row.id();
        if let Some(draft) = self.drafts.get_mut(&id) {
            draft.replace_text(row.value.clone());
        }
        self.forget(&id);
    }
}

/// Each Machine on the board, as an edit's reach is said of it.
pub fn reached(app: &App) -> Vec<Reached> {
    app.machines
        .iter()
        .map(|m| Reached {
            name: m.machine.name.clone(),
            live: app.is_live(m),
            synced: app.board.flock.synced.get(&m.machine.profile).cloned(),
        })
        .collect()
}

fn profiles(app: &App) -> Vec<String> {
    app.machines
        .iter()
        .map(|m| m.machine.profile.clone())
        .collect()
}

pub fn refresh_catalogues(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    page.asked_catalogues += 1;
    let asked = page.asked_catalogues;
    core.request(
        "catalogues",
        (),
        move |app: &mut App, read: Result<Vec<CataloguesSuccessItem>, CallError>| {
            let machines: Vec<(String, String, bool)> = app
                .machines
                .iter()
                .map(|m| {
                    (
                        m.machine.profile.clone(),
                        m.machine.name.clone(),
                        app.is_live(m),
                    )
                })
                .collect();
            let page = &mut app.pages.settings;
            if asked != page.asked_catalogues {
                return;
            }
            match read {
                Ok(fresh) => {
                    page.catalogues =
                        agents::remember_catalogues(&page.catalogues, &fresh, &machines);
                    page.catalogue_problem = None;
                }
                Err(why) => page.catalogue_problem = Some(why.0),
            }
        },
    );
}

/// An onboarding that moved on, such as Linear's setup ending, may have connected something.
pub fn onboarding_moved(app: &mut App) {
    let moved = app.pages.machines.onboardings;
    if app.pages.settings.onboardings_read != moved {
        app.pages.settings.onboardings_read = moved;
        refresh_connections(app);
    }
}

pub fn refresh_connections(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    page.asked_connections += 1;
    page.connections_reading = true;
    let asked = page.asked_connections;
    core.request(
        "connectionReadings",
        (),
        move |app: &mut App, read: Result<Vec<ConnectionReadingsSuccessItem>, CallError>| {
            let page = &mut app.pages.settings;
            if asked != page.asked_connections {
                return;
            }
            page.connections_reading = false;
            match read {
                Ok(readings) => {
                    page.connections = readings;
                    page.connections_trouble = None;
                }
                Err(why) => page.connections_trouble = Some(why.0),
            }
        },
    );
}

pub fn refresh_slack(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    page.asked_slack += 1;
    page.slack_loading = true;
    let asked = page.asked_slack;
    core.request(
        "slackUserChannels",
        (),
        move |app: &mut App, read: Result<Vec<SlackUserChannelsSuccessItem>, CallError>| {
            let page = &mut app.pages.settings;
            if asked != page.asked_slack {
                return;
            }
            page.slack_loading = false;
            page.slack_yours = read.ok();
        },
    );
}

/// The Board's Machines as Connections reads them.
pub fn connection_cards(app: &App) -> Vec<connections::Card> {
    let machines: Vec<connections::Machine> = app
        .machines
        .iter()
        .map(|m| connections::Machine {
            profile: &m.machine.profile,
            name: &m.machine.name,
            live: app.is_live(m),
            reason: app.lost_of(&m.machine.profile).map(|lost| match lost {
                LostState::Unreachable => "Out of reach",
                LostState::Sso => "Waiting for SSO",
                LostState::NoCollie => "Collie isn't installed",
                LostState::UpdateDesktop => "Update Desktop",
            }),
        })
        .collect();
    connections::cards(&connections::machines_read(
        &machines,
        &app.pages.settings.connections,
    ))
}

/// Sets a row to `typed`, in its unit; empty unsets it.
pub fn set(app: &mut App, row: &Row, typed: &str) {
    let id = row.id();
    let Some(core) = app.core.clone() else {
        return;
    };
    let readable = app.pages.settings.readable();
    let machines = reached(app);
    let page = &mut app.pages.settings;
    page.forget(&id);
    if row.shared {
        if let Err(refused) = model::flock_reach(readable, &machines) {
            page.refusals.insert(id, refused);
            return;
        }
        let ask = page.sent(&id, vec![row.key.clone()], vec![id.clone()], false);
        core.request(
            "setFlockSetting",
            json!({ "key": row.key, "value": registry::stored(&row.key, typed) }),
            move |app: &mut App, said: Result<String, CallError>| {
                app.pages.settings.answered(&id, ask, said.map(|_| ()))
            },
        );
    } else {
        let ask = page.sent(&id, Vec::new(), vec![id.clone()], false);
        let on = typed == "on";
        core.request(
            "setSettings",
            json!({ "recordTiming": on }),
            move |app: &mut App, kept: Result<SettingsSuccess, CallError>| {
                let page = &mut app.pages.settings;
                let kept = kept.map(|desktop| {
                    page.desktop = Some(desktop);
                });
                page.answered(&id, ask, kept)
            },
        );
    }
}

impl Settings {
    fn answered(&mut self, id: &str, ask: u64, said: Result<(), CallError>) {
        let waiting = self.settle(id, ask);
        match said {
            Ok(()) if waiting => {
                self.drafts.remove(id);
                self.saved.insert(id.into());
            }
            Ok(()) => {}
            Err(why) => {
                self.saved.remove(id);
                self.refusals.insert(id.into(), why.0);
            }
        }
    }
}

/// Chooses the harness, model or effort every step runs on, saved with whatever it changes.
pub fn choose_agent(app: &mut App, key: &str, value: &str, reset: bool) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let readable = app.pages.settings.readable();
    let machines = reached(app);
    let profiles = profiles(app);
    let page = &mut app.pages.settings;
    if page.choosing {
        return;
    }
    let Some(row) = page.row(key) else {
        return;
    };
    let id = row.id();
    page.forget(&id);
    if let Err(refused) = model::flock_reach(readable, &machines) {
        page.refusals.insert(id, refused);
        return;
    }
    let value = if reset {
        row.fallback.clone()
    } else if key == "model" && value.is_empty() {
        agents::DEFAULT_MODEL.to_string()
    } else {
        value.to_string()
    };
    let changes: Vec<Value> = agents::agent_changes(
        &page.catalogues,
        &profiles,
        &page.agent_settings(),
        key,
        &value,
    )
    .into_iter()
    .map(|(k, v)| {
        let v = if reset && k == key { String::new() } else { v };
        json!({ "key": k, "value": v })
    })
    .collect();
    let ids: Vec<String> = ["harness", "model", "effort"]
        .iter()
        .filter_map(|k| page.row(k).map(|r| r.id()))
        .collect();
    let keys = changes
        .iter()
        .filter_map(|c| c["key"].as_str().map(String::from))
        .collect();
    page.choosing = true;
    let ask = page.sent(&id, keys, ids.clone(), true);
    core.request(
        "setFlockSettings",
        json!({ "changes": changes }),
        move |app: &mut App, said: Result<String, CallError>| {
            let page = &mut app.pages.settings;
            let waiting = page.settle(&id, ask);
            match said {
                Ok(_) if waiting => page.saved.extend(ids),
                Ok(_) => {}
                Err(why) => {
                    page.refusals.insert(id, why.0);
                }
            }
        },
    );
}

/// Saves the fallbacks list as `value`, one change at a time.
pub fn choose_fallbacks(app: &mut App, row: &Row, value: &str) {
    let page = &app.pages.settings;
    if page.choosing || page.saving.contains(&row.id()) {
        return;
    }
    set(app, row, value);
}

/// Resets a row to its default, as the core unsets it.
pub fn reset(app: &mut App, row: &Row) {
    match row.key.as_str() {
        "harness" | "model" | "effort" => choose_agent(app, &row.key, "", true),
        _ => set(app, row, ""),
    }
}

/// Picks a Slack destination, refused here only where the human can't pick at all.
pub fn choose_destination(app: &mut App, row: &Row, value: &str) {
    let page = &mut app.pages.settings;
    match connections::pick_destination(value, page.slack_yours.as_deref()) {
        Ok(value) => set(app, row, &value),
        Err(refused) => {
            page.refusals.insert(row.id(), refused);
        }
    }
}

pub fn save_token(app: &mut App, which: Which) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    let token = match which {
        Which::Gitlab => &mut page.gitlab,
        Which::Helle => &mut page.helle,
    };
    let typed = token.edit.text.trim().to_string();
    if typed.is_empty() || token.saving {
        return;
    }
    token.saving = true;
    token.said = None;
    let tag = match which {
        Which::Gitlab => "saveGitlab",
        Which::Helle => "saveHelle",
    };
    core.request(
        tag,
        json!({ "token": typed }),
        move |app: &mut App, said: Result<String, CallError>| {
            let kept = said.is_ok();
            let page = &mut app.pages.settings;
            let token = match which {
                Which::Gitlab => &mut page.gitlab,
                Which::Helle => &mut page.helle,
            };
            token.saving = false;
            token.said = Some(said.map_err(|why| why.0));
            if kept {
                token.edit.clear();
                refresh_connections(app);
            }
        },
    );
}

pub fn paste_gitlab(app: &mut App, text: &str) {
    if app.pages.settings.gitlab.saving {
        return;
    }
    app.pages.settings.gitlab.edit.text = text.to_string();
    save_token(app, Which::Gitlab);
}

/// Asks Helle whose the typed token is; an answer for a token since changed is dropped.
pub fn check_helle(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    let typed = page.helle.edit.text.trim().to_string();
    page.helle_check = None;
    if typed.is_empty() {
        return;
    }
    let asked = typed.clone();
    core.request(
        "checkHelle",
        json!({ "token": typed }),
        move |app: &mut App, owner: Result<String, CallError>| {
            let page = &mut app.pages.settings;
            if page.helle.edit.text.trim() == asked {
                page.helle_check = Some((asked, owner.map_err(|why| why.0)));
            }
        },
    );
}

/// Whether Save may keep the typed token: Helle's only once Helle owns to it.
pub fn token_accepted(page: &Settings, which: Which) -> bool {
    match which {
        Which::Gitlab => !page.gitlab.edit.text.trim().is_empty(),
        Which::Helle => {
            let typed = page.helle.edit.text.trim();
            !typed.is_empty() && matches!(&page.helle_check, Some((t, Ok(_))) if t == typed)
        }
    }
}

pub fn save_host(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    let host = page.host.text.trim().to_string();
    if host.is_empty() || page.host_saving {
        return;
    }
    page.host_saving = true;
    page.host_said = None;
    core.request(
        "saveGitlabHost",
        json!({ "host": host }),
        |app: &mut App, said: Result<String, CallError>| {
            let kept = said.is_ok();
            let page = &mut app.pages.settings;
            page.host_saving = false;
            page.host_said = Some(said.map_err(|why| why.0));
            if kept {
                page.host.clear();
                refresh_connections(app);
            }
        },
    );
}

/// The card's main action: reuse a login a Machine has, sign in, set up, or connect.
pub fn connect(app: &mut App, card: &connections::Card) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let token_page = app
        .pages
        .settings
        .credentials
        .as_ref()
        .map(|c| c.token_page.clone());
    let page = &mut app.pages.settings;
    let Some(primary) = card.primary.clone() else {
        return;
    };
    if page.busy.is_some() {
        return;
    }
    page.opened = Some(card.id.clone());
    let key = connections::id_name(&card.id).to_string();
    let (tag, payload) = match primary {
        connections::Primary::Connect { .. } => {
            if card.id == Id::Gitlab
                && let Some(url) = token_page
            {
                core.request(
                    "openLink",
                    json!({ "url": url }),
                    |_: &mut App, _: Result<Value, CallError>| {},
                );
            }
            return;
        }
        connections::Primary::Reuse { from, to, .. } => (
            "reuseConnection",
            json!({ "id": key, "from": from, "to": to }),
        ),
        connections::Primary::Login { to, .. } => ("githubLogin", json!({ "profile": to })),
        connections::Primary::Setup { to, .. } => ("linearSetup", json!({ "profile": to })),
    };
    page.busy = Some(card.id.clone());
    page.done.remove(&key);
    let linear = tag == "linearSetup";
    core.request(
        tag,
        payload,
        move |app: &mut App, said: Result<String, CallError>| {
            // Linear's setup is a job, shown as an onboarding is, wherever it was started.
            if let (true, Ok(job)) = (linear, &said) {
                app.pages.machines.job = Some(job.clone());
            }
            let page = &mut app.pages.settings;
            page.busy = None;
            let said = said.map_err(|why| why.0).map(|said| {
                if linear {
                    "Linear setup started; approve its login in your browser.".to_string()
                } else {
                    said
                }
            });
            page.done.insert(key, said);
            refresh_connections(app);
        },
    );
}

pub fn sign_in_slack(app: &mut App, out: bool) {
    let Some(core) = app.core.clone() else {
        return;
    };
    let page = &mut app.pages.settings;
    if page.slack_busy {
        return;
    }
    page.slack_busy = true;
    page.slack_said = None;
    core.request(
        if out {
            "signOutSlackUser"
        } else {
            "signInSlackUser"
        },
        (),
        |app: &mut App, said: Result<String, CallError>| {
            let changed = said.is_ok();
            let page = &mut app.pages.settings;
            page.slack_busy = false;
            page.slack_said = Some(said.map_err(|why| why.0));
            if changed {
                refresh_connections(app);
                refresh_slack(app);
            }
        },
    );
}

pub fn check_for_updates(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    app.pages.settings.checking = true;
    core.request(
        "checkForUpdates",
        (),
        |app: &mut App, news: Result<News, CallError>| {
            let page = &mut app.pages.settings;
            page.checking = false;
            match news {
                Ok(news) => {
                    if let Some(updates) = page.updates.as_mut() {
                        updates.news = news;
                    }
                }
                Err(why) => page.updates_trouble = Some(why.0),
            }
        },
    );
}

pub fn restart(app: &mut App) {
    let Some(core) = app.core.clone() else {
        return;
    };
    app.pages.settings.restart_refused = None;
    core.request(
        "restart",
        (),
        |app: &mut App, done: Result<Value, CallError>| {
            if let Err(why) = done {
                app.pages.settings.restart_refused = Some(why.0);
            }
        },
    );
}

pub fn fire(app: &App, tag: &str, payload: Value) {
    if let Some(core) = app.core.as_ref() {
        core.request(tag, payload, |_: &mut App, _: Result<Value, CallError>| {});
    }
}

/// What Desktop's latest look for its own update found, in a line.
pub fn update_said(news: &News, version: &str) -> String {
    match news {
        News::Checking(_) => "Checking for updates…".into(),
        News::UpToDate(_) => format!("Collie {version} is up to date"),
        News::Downloading(d) => format!("Downloading {}", d.version),
        News::Ready(r) => format!("Collie {} is ready, restart Desktop", r.version),
        News::Refused(r) => format!("Desktop {} was not installed: {}", r.version, r.reason),
        News::Failed(f) => format!("Could not check for updates: {}", f.reason),
        News::Never(n) => {
            let mut chars = n.reason.chars();
            match chars.next() {
                Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
                None => ".".into(),
            }
        }
    }
}
