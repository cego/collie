//! What the Machines page knows of each route: a port of `applyItem` and `machineRows` in
//! `desktop/src/shared/flock.ts`, less the cards the board draws. The TypeScript stays its
//! owner.

use collie_desktop_protocol::generated::{
    Credential, FlockItem, Link, LinkState, LostMachine, LostState, Message, Onboarding, Reading,
    Route, Run, RunStep, Status, Transport, Values, Waits,
};
use std::collections::{BTreeMap, HashMap};

/// A Machine its host has spoken for, by installation.
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub installation: String,
    pub profile: String,
    pub route: Option<Route>,
    /// Since when it is no longer live; `None` while it is.
    pub as_of: Option<f64>,
    pub build: Option<String>,
    pub development: Option<String>,
}

/// Whether a Machine has a credential Desktop holds, and why its last give failed.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    pub given: bool,
    pub failed: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Fold {
    /// Every route, by herdr profile, in the order Desktop opened them.
    pub routes: Vec<LostMachine>,
    pub seen: Vec<Seen>,
    pub lost: HashMap<String, (LostState, String)>,
    pub onboarding: HashMap<String, Onboarding>,
    pub onboarded: HashMap<String, Run>,
    pub doctored: HashMap<String, Run>,
    pub synced: HashMap<String, Option<String>>,
    pub definitions: HashMap<String, Option<String>>,
    pub own: HashMap<String, Reading>,
    pub given: HashMap<String, BTreeMap<&'static str, Held>>,
    pub links: HashMap<String, Link>,
}

fn credential(c: &Credential) -> &'static str {
    match c {
        Credential::Gitlab => "gitlab",
        Credential::Helle => "helle",
        Credential::Slack => "slack",
    }
}

/// A reading with no values keeps the values read before, unless the host can't say them.
pub fn keep_own(reading: Reading, before: Option<&Reading>) -> Reading {
    match before {
        Some(before)
            if reading.values.is_none() && !reading.unsupported && before.values.is_some() =>
        {
            Reading {
                values: before.values.clone(),
                at: before.at,
                ..reading
            }
        }
        _ => reading,
    }
}

impl Fold {
    fn removed(&mut self, profile: &str) {
        self.routes.retain(|r| r.profile != profile);
        self.lost.remove(profile);
        self.onboarded.remove(profile);
        self.doctored.remove(profile);
        self.synced.remove(profile);
        self.own.remove(profile);
        self.definitions.remove(profile);
        self.given.remove(profile);
        self.links.remove(profile);
        self.seen.retain(|s| s.profile != profile);
    }

    /// Dims whatever `profile` showed live, as of `at`.
    fn dimmed(&mut self, profile: &str, at: f64) {
        for seen in self.seen.iter_mut() {
            if seen.profile == profile && seen.as_of.is_none() {
                seen.as_of = Some(at);
            }
        }
    }

    pub fn apply(&mut self, item: &FlockItem) {
        match item {
            FlockItem::Notice(_) => {}
            FlockItem::Routed(routed) => {
                let machine = routed.machine.clone();
                match self
                    .routes
                    .iter_mut()
                    .find(|r| r.profile == machine.profile)
                {
                    Some(known) => *known = machine,
                    None => self.routes.push(machine),
                }
            }
            FlockItem::Onboarding(one) => {
                self.onboarded
                    .insert(one.machine.profile.clone(), one.run.clone());
                self.onboarding.insert(one.job.clone(), one.clone());
            }
            FlockItem::Doctored(one) => {
                self.doctored
                    .insert(one.machine.profile.clone(), one.run.clone());
            }
            FlockItem::Synced(one) => {
                let part = match one.part {
                    collie_desktop_protocol::generated::Part::Settings => &mut self.synced,
                    collie_desktop_protocol::generated::Part::Definitions => &mut self.definitions,
                };
                part.insert(one.machine.profile.clone(), one.failed.clone());
            }
            FlockItem::Linked(one) => {
                self.links
                    .insert(one.machine.profile.clone(), one.link.clone());
            }
            FlockItem::OwnRead(one) => {
                let profile = one.machine.profile.clone();
                let kept = keep_own(one.reading.clone(), self.own.get(&profile));
                self.own.insert(profile, kept);
            }
            FlockItem::Given(one) => {
                self.given
                    .entry(one.machine.profile.clone())
                    .or_default()
                    .insert(
                        credential(&one.credential),
                        Held {
                            given: one.given,
                            failed: one.failed.clone(),
                        },
                    );
            }
            FlockItem::Routes(routes) => {
                let mut shown: Vec<String> =
                    self.routes.iter().map(|r| r.profile.clone()).collect();
                shown.extend(self.lost.keys().cloned());
                shown.extend(self.seen.iter().map(|s| s.profile.clone()));
                for profile in shown {
                    if !routes.profiles.contains(&profile) {
                        self.removed(&profile);
                    }
                }
            }
            FlockItem::Removed(one) => self.removed(&one.machine.profile),
            FlockItem::Saved(saved) => {
                if self
                    .seen
                    .iter()
                    .any(|s| s.installation == saved.machine.installation)
                {
                    return;
                }
                self.seen.push(Seen {
                    installation: saved.machine.installation.clone(),
                    profile: saved.machine.profile.clone(),
                    route: saved.machine.route.clone(),
                    as_of: Some(saved.at),
                    build: saved.build.clone().flatten(),
                    development: saved.development.clone().flatten(),
                });
            }
            FlockItem::Merged(merged) => {
                self.lost.remove(&merged.machine.profile);
            }
            FlockItem::Lost(lost) => {
                self.lost.insert(
                    lost.machine.profile.clone(),
                    (lost.state.clone(), lost.reason.clone()),
                );
                self.dimmed(&lost.machine.profile, lost.at);
            }
            FlockItem::Reconnecting(again) => self.dimmed(&again.machine.profile, again.at),
            FlockItem::MachineMessage(said) => {
                let machine = &said.machine;
                if matches!(said.message, Message::UnknownMessage(_)) {
                    return;
                }
                let at = self
                    .seen
                    .iter()
                    .position(|s| s.installation == machine.installation);
                let known = at.map(|i| self.seen[i].clone());
                let (build, development) = match &said.message {
                    Message::Snapshot(snapshot) => {
                        (Some(snapshot.build.clone()), snapshot.development.clone())
                    }
                    _ => (
                        known.as_ref().and_then(|k| k.build.clone()),
                        known.as_ref().and_then(|k| k.development.clone()),
                    ),
                };
                let seen = Seen {
                    installation: machine.installation.clone(),
                    profile: machine.profile.clone(),
                    route: machine.route.clone(),
                    as_of: None,
                    build,
                    development,
                };
                match at {
                    Some(i) => self.seen[i] = seen,
                    None => self.seen.push(seen),
                }
                self.lost.remove(&machine.profile);
            }
        }
    }

    /// Every route as the Machines page lists it, in the order Desktop opened them.
    pub fn rows(&self) -> Vec<MachineRow> {
        self.routes
            .iter()
            .map(|route| {
                let profile = &route.profile;
                let mut seen: Vec<&Seen> =
                    self.seen.iter().filter(|s| &s.profile == profile).collect();
                let shown = match seen.iter().find(|s| s.as_of.is_none()) {
                    Some(live) => Some(*live),
                    None => {
                        seen.sort_by(|a, b| b.as_of.partial_cmp(&a.as_of).unwrap());
                        seen.first().copied()
                    }
                };
                let live = shown.is_some_and(|s| s.as_of.is_none());
                let lost = self.lost.get(profile);
                let link = self.links.get(profile);
                let transport = link
                    .filter(|l| l.state == LinkState::Live)
                    .and_then(|l| l.transport.clone().flatten());
                let waits = link
                    .and_then(|l| l.waits.clone().flatten())
                    .map(|Waits::SshConnection| WAITS_SAID.to_string());
                MachineRow {
                    profile: profile.clone(),
                    name: route.name.clone(),
                    target: route.target.clone(),
                    route: if live {
                        shown.and_then(|s| s.route.clone())
                    } else {
                        None
                    },
                    state: if live {
                        RowState::Live
                    } else {
                        lost.map_or(RowState::Connecting, |(state, _)| {
                            RowState::NotLive(state.clone())
                        })
                    },
                    onboarded: standing(self.onboarded.get(profile), self.doctored.get(profile)),
                    build: shown.and_then(|s| s.build.clone()),
                    development: shown.and_then(|s| s.development.clone()),
                    settings: self.synced.get(profile).cloned(),
                    definitions: self.definitions.get(profile).cloned(),
                    credentials: self.given.get(profile).cloned().unwrap_or_default(),
                    reason: if live {
                        None
                    } else {
                        lost.map(|(_, why)| why.clone())
                    }
                    .or(waits),
                    transport_reason: if transport == Some(Transport::Ssh) {
                        link.and_then(|l| l.direct.clone().flatten())
                    } else {
                        None
                    },
                    transport,
                }
            })
            .collect()
    }

    /// The onboarding a job shows, once its first step is told.
    pub fn job(&self, job: &str) -> Option<&Onboarding> {
        self.onboarding.get(job)
    }

    pub fn own_of(&self, profile: &str) -> Option<&Reading> {
        self.own.get(profile)
    }
}

const WAITS_SAID: &str =
    "Its link waits on an SSH connection, which Desktop opens when it next connects.";

#[derive(Debug, Clone, PartialEq)]
pub enum RowState {
    Live,
    Connecting,
    NotLive(LostState),
}

impl RowState {
    pub fn is_live(&self) -> bool {
        *self == RowState::Live
    }

    /// The state in words: `Connecting`, or why it isn't live.
    pub fn said(&self) -> &'static str {
        match self {
            RowState::Live => "Live",
            RowState::Connecting => "Connecting",
            RowState::NotLive(state) => not_live_said(state),
        }
    }
}

pub fn not_live_said(state: &LostState) -> &'static str {
    match state {
        LostState::Unreachable => "Out of reach",
        LostState::Sso => "Waiting for SSO",
        LostState::NoCollie => "Collie isn't installed",
        LostState::UpdateDesktop => "Update Desktop",
    }
}

/// A route as the Machines page lists it: how it stands now, and how onboarded it is.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineRow {
    pub profile: String,
    pub name: String,
    pub target: Option<String>,
    pub route: Option<Route>,
    pub state: RowState,
    pub onboarded: Option<Run>,
    pub build: Option<String>,
    pub development: Option<String>,
    /// How its latest settings sync ended, `Some(None)` where it synced; `None` until one has.
    pub settings: Option<Option<String>>,
    pub definitions: Option<Option<String>>,
    pub credentials: BTreeMap<&'static str, Held>,
    pub reason: Option<String>,
    pub transport: Option<Transport>,
    pub transport_reason: Option<String>,
}

impl MachineRow {
    /// A row with only a name and a state, as the board's narrow fold knows a Machine.
    pub fn bare(profile: &str, name: &str, state: RowState) -> MachineRow {
        MachineRow {
            profile: profile.into(),
            name: name.into(),
            target: None,
            route: None,
            state,
            onboarded: None,
            build: None,
            development: None,
            settings: None,
            definitions: None,
            credentials: BTreeMap::new(),
            reason: None,
            transport: None,
            transport_reason: None,
        }
    }
}

/// How the Machines page names a row's route: a paired link says which way it goes.
pub fn route_said(route: &Route, transport: Option<&Transport>) -> String {
    match (route, transport) {
        (Route::Ssh, _) => "SSH".into(),
        (Route::Link, None) => "Paired link".into(),
        (Route::Link, Some(Transport::Ssh)) => "Paired link · over SSH".into(),
        (Route::Link, Some(Transport::Direct)) => "Paired link · direct".into(),
    }
}

/// What a step may end as and leave the human nothing to do.
pub fn settled(status: &Status) -> bool {
    matches!(status, Status::Done | Status::InPlace | Status::Skipped)
}

/// The default steps a Machine may go without.
pub const SKIPPABLE: [&str; 2] = ["helle", "linear"];

/// How onboarded a route is: doctor's reading, less a step its latest onboarding skipped and
/// with a default step onboarding left unsettled; or that onboarding where it is newer.
fn standing(onboarding: Option<&Run>, doctor: Option<&Run>) -> Option<Run> {
    let Some(doctor) = doctor.filter(|d| onboarding.is_none_or(|o| o.at <= d.at)) else {
        return onboarding.cloned();
    };
    let skipped: Vec<&str> = onboarding
        .map(|o| {
            o.steps
                .iter()
                .filter(|s| s.status == Status::Skipped)
                .map(|s| s.step.as_str())
                .collect()
        })
        .unwrap_or_default();
    let left: Vec<RunStep> = onboarding
        .map(|o| {
            o.steps
                .iter()
                .filter(|s| {
                    SKIPPABLE.contains(&s.step.as_str())
                        && !doctor.steps.iter().any(|d| d.step == s.step)
                        && !settled(&s.status)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let steps: Vec<RunStep> = doctor
        .steps
        .iter()
        .filter(|s| !skipped.contains(&s.step.as_str()))
        .cloned()
        .chain(left)
        .collect();
    Some(Run {
        ready: Some(steps.is_empty()),
        steps,
        ..doctor.clone()
    })
}

/// A Machine's own settings as a row of the table: how its settings sync stands and what it
/// keeps for itself.
#[derive(Debug, Clone, PartialEq)]
pub struct OwnRow {
    pub profile: String,
    pub name: String,
    pub where_: String,
    pub sync: &'static str,
    pub sync_ok: bool,
    pub detail: Option<String>,
    pub at: Option<f64>,
    pub projects_root: Option<String>,
    pub chat_harness: Option<String>,
    pub harnesses: Vec<String>,
    pub remembered: Vec<(String, String)>,
}

/// Each Machine's own settings, as `machineOwnRows` says them.
pub fn own_rows(
    rows: &[MachineRow],
    readings: &HashMap<String, Reading>,
    now: f64,
    zone: &super::clock::Zone,
) -> Vec<OwnRow> {
    rows.iter()
        .map(|machine| {
            let read = readings.get(&machine.profile);
            let values: Option<&Values> = read.and_then(|r| r.values.as_ref());
            let (sync, sync_ok) = match (&machine.state, &machine.settings) {
                (RowState::Connecting, _) => ("Connecting", false),
                (RowState::NotLive(_), _) => ("Out of reach", false),
                (RowState::Live, None) => ("Not read yet", false),
                (RowState::Live, Some(None)) => ("In sync", true),
                (RowState::Live, Some(Some(_))) => ("Behind", false),
            };
            let problem = read.and_then(|r| r.problem.clone());
            let stale = !machine.state.is_live() || problem.is_some();
            let detail = if read.is_some_and(|r| r.unsupported) {
                Some(format!(
                    "Not known: {} runs Collie {}",
                    machine.name,
                    machine.build.as_deref().unwrap_or("(version not known)")
                ))
            } else if values.is_some() && stale {
                let last = super::clock::when_of(read.unwrap().at, now, zone);
                Some(match &problem {
                    None => format!("Last read {last}"),
                    Some(why) => format!("Last read {last} · {why}"),
                })
            } else {
                problem
                    .or_else(|| machine.settings.clone().flatten())
                    .or_else(|| values.is_none().then(|| "Not read yet".to_string()))
            };
            OwnRow {
                profile: machine.profile.clone(),
                name: machine.name.clone(),
                where_: machine
                    .target
                    .clone()
                    .unwrap_or_else(|| "This computer".into()),
                sync,
                sync_ok,
                detail,
                at: values.map(|_| read.unwrap().at),
                projects_root: values
                    .map(|v| v.projects_root.clone().unwrap_or_else(|| "Not set".into())),
                chat_harness: values
                    .map(|v| v.chat_harness.clone().unwrap_or_else(|| "Not set".into())),
                harnesses: values.map(|v| v.harnesses.clone()).unwrap_or_default(),
                remembered: values
                    .map(|v| {
                        v.remembered
                            .iter()
                            .map(|r| (r.key.clone(), r.value.clone()))
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect()
}
