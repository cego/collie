//! The Flock the board draws: `applyItem` and the board model of `desktop/src/shared/flock.ts`
//! and `src/board-model.ts` (sections, order, folds, the header sentence). The TypeScript stays
//! their owner; this is a faithful copy.

use collie_desktop_protocol::generated::{
    Credential, FlockItem, Herd, Link, LostMachine, LostState, Machine, Message, Onboarding, Part,
    Reading, Run, State, Task,
};
use std::collections::HashMap;

/// A Machine as its host last told it: who it is, its Herds, its Tasks in order, and since
/// when that is no longer live, if it is not.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub machine: Machine,
    pub herds: Vec<Herd>,
    pub cards: Vec<Task>,
    pub as_of: Option<f64>,
    pub build: Option<String>,
    pub development: Option<String>,
    /// The board protocol its latest Snapshot spoke; none for a saved board.
    pub protocol: Option<i64>,
    pub files: bool,
}

/// A route that is not live: the name it is known by, why, in which state.
#[derive(Debug, Clone, PartialEq)]
pub struct LostRoute {
    pub name: String,
    pub state: LostState,
    pub reason: String,
}

/// Whether a Machine has a credential Desktop holds, and why its last give failed.
#[derive(Debug, Clone, PartialEq)]
pub struct GivenOne {
    pub given: bool,
    pub failed: Option<String>,
}

/// Entries kept in the order first set, as a JavaScript `Map` keeps them.
#[derive(Debug, Clone, PartialEq)]
pub struct Ordered<V>(pub Vec<(String, V)>);

impl<V> Default for Ordered<V> {
    fn default() -> Self {
        Ordered(Vec::new())
    }
}

impl<V> Ordered<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn set(&mut self, key: &str, value: V) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some((_, v)) => *v = value,
            None => self.0.push((key.to_string(), value)),
        }
    }
    pub fn remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }
    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(k, _)| k.as_str())
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Everything of the Flock but its Machines' boards (`App::machines`), by herdr profile
/// unless said otherwise.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Flock {
    pub lost: Ordered<LostRoute>,
    /// Every notice so far, oldest first.
    pub notices: Vec<String>,
    pub routes: Ordered<LostMachine>,
    /// Each onboarding the view started, by job.
    pub onboarding: Ordered<Onboarding>,
    pub onboarded: Ordered<Run>,
    pub doctored: Ordered<Run>,
    /// How each route's latest settings sync ended: `None` where it synced, else why not.
    pub synced: Ordered<Option<String>>,
    pub own: Ordered<Reading>,
    pub definitions: Ordered<Option<String>>,
    pub given: Ordered<Vec<(Credential, GivenOne)>>,
    pub links: Ordered<Link>,
    /// Whether any item has been heard since the subscription started.
    pub heard: bool,
}

fn removed(machines: &mut Vec<Shown>, flock: &mut Flock, profile: &str) {
    flock.routes.remove(profile);
    flock.lost.remove(profile);
    flock.onboarded.remove(profile);
    flock.doctored.remove(profile);
    flock.synced.remove(profile);
    flock.own.remove(profile);
    flock.definitions.remove(profile);
    flock.given.remove(profile);
    flock.links.remove(profile);
    machines.retain(|shown| shown.machine.profile != profile);
}

fn keep_own(reading: Reading, before: Option<&Reading>) -> Reading {
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

/// One `flock` item folded into the Machines and the rest of the Flock, as `applyItem` does.
pub fn apply_item(machines: &mut Vec<Shown>, flock: &mut Flock, item: FlockItem) {
    flock.heard = true;
    match item {
        FlockItem::Notice(notice) => flock.notices.push(notice.text),
        FlockItem::Routed(routed) => flock
            .routes
            .set(&routed.machine.profile.clone(), routed.machine),
        FlockItem::Onboarding(onboarding) => {
            flock
                .onboarded
                .set(&onboarding.machine.profile, onboarding.run.clone());
            flock.onboarding.set(&onboarding.job.clone(), onboarding);
        }
        FlockItem::Doctored(doctored) => {
            flock.doctored.set(&doctored.machine.profile, doctored.run)
        }
        FlockItem::Synced(synced) => match synced.part {
            Part::Settings => flock.synced.set(&synced.machine.profile, synced.failed),
            Part::Definitions => flock
                .definitions
                .set(&synced.machine.profile, synced.failed),
        },
        FlockItem::Linked(linked) => flock.links.set(&linked.machine.profile, linked.link),
        FlockItem::OwnRead(read) => {
            let kept = keep_own(read.reading, flock.own.get(&read.machine.profile));
            flock.own.set(&read.machine.profile, kept);
        }
        FlockItem::Given(given) => {
            let profile = given.machine.profile;
            let mut had = flock.given.get(&profile).cloned().unwrap_or_default();
            let one = GivenOne {
                given: given.given,
                failed: given.failed,
            };
            match had.iter_mut().find(|(c, _)| *c == given.credential) {
                Some((_, was)) => *was = one,
                None => had.push((given.credential, one)),
            }
            flock.given.set(&profile, had);
        }
        FlockItem::Routes(routes) => {
            let mut shown: Vec<String> = flock.routes.keys().map(String::from).collect();
            shown.extend(flock.lost.keys().map(String::from));
            shown.extend(machines.iter().map(|m| m.machine.profile.clone()));
            let mut done = Vec::new();
            for profile in shown {
                if !routes.profiles.contains(&profile) && !done.contains(&profile) {
                    removed(machines, flock, &profile);
                    done.push(profile);
                }
            }
        }
        FlockItem::Removed(gone) => removed(machines, flock, &gone.machine.profile),
        FlockItem::Saved(saved) => {
            if machines
                .iter()
                .any(|m| m.machine.installation == saved.machine.installation)
            {
                return;
            }
            machines.push(Shown {
                machine: saved.machine,
                herds: saved.herds,
                cards: saved.tasks,
                as_of: Some(saved.at),
                build: saved.build.flatten(),
                development: saved.development.flatten(),
                protocol: None,
                files: false,
            });
        }
        FlockItem::Merged(merged) => flock.lost.remove(&merged.machine.profile),
        FlockItem::Lost(lost) => {
            flock.lost.set(
                &lost.machine.profile,
                LostRoute {
                    name: lost.machine.name.clone(),
                    state: lost.state,
                    reason: lost.reason,
                },
            );
            dim(machines, &lost.machine.profile, lost.at);
        }
        FlockItem::Reconnecting(again) => dim(machines, &again.machine.profile, again.at),
        FlockItem::MachineMessage(said) => {
            let machine = said.machine;
            let at = machines
                .iter()
                .position(|m| m.machine.installation == machine.installation);
            let known = at.map(|at| machines[at].clone());
            let mut cards = known.as_ref().map(|k| k.cards.clone()).unwrap_or_default();
            let (mut herds, mut build, mut development, mut protocol, mut files) = match &known {
                Some(k) => (
                    k.herds.clone(),
                    k.build.clone(),
                    k.development.clone(),
                    k.protocol,
                    k.files,
                ),
                None => (Vec::new(), None, None, None, false),
            };
            match said.message {
                Message::UnknownMessage(_) => return,
                Message::Snapshot(snapshot) => {
                    cards = snapshot.tasks;
                    herds = snapshot.herds;
                    build = Some(snapshot.build);
                    development = snapshot.development;
                    protocol = Some(snapshot.protocol);
                    files = snapshot.files == Some(true);
                }
                Message::Upsert(upsert) => {
                    match cards.iter_mut().find(|c| c.id == upsert.task.id) {
                        Some(card) => *card = upsert.task,
                        None => cards.push(upsert.task),
                    }
                }
                Message::Remove(remove) => cards.retain(|c| c.id != remove.id),
            }
            flock.lost.remove(&machine.profile);
            let shown = Shown {
                machine,
                herds,
                cards,
                as_of: None,
                build,
                development,
                protocol,
                files,
            };
            match at {
                Some(at) => machines[at] = shown,
                None => machines.push(shown),
            }
        }
    }
}

/// A lost or reopened route dims each live Machine it was showing, as of `at`.
fn dim(machines: &mut [Shown], profile: &str, at: f64) {
    for known in machines.iter_mut() {
        if known.machine.profile == profile && known.as_of.is_none() {
            known.as_of = Some(at);
        }
    }
}

/// Each Machine's display name by installation: its own, or with how it is reached where two
/// share one; a saved board told apart from a live Machine reached the same way.
pub fn shown_names(machines: &[Shown]) -> HashMap<String, String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for m in machines {
        *counts.entry(m.machine.name.as_str()).or_default() += 1;
    }
    let mut names: HashMap<String, String> = machines
        .iter()
        .map(|m| {
            let name = if counts[m.machine.name.as_str()] > 1 {
                format!(
                    "{} ({})",
                    m.machine.name,
                    m.machine.target.as_deref().unwrap_or("local")
                )
            } else {
                m.machine.name.clone()
            };
            (m.machine.installation.clone(), name)
        })
        .collect();
    let mut shown: HashMap<String, usize> = HashMap::new();
    for name in names.values() {
        *shown.entry(name.clone()).or_default() += 1;
    }
    for m in machines {
        let name = names[&m.machine.installation].clone();
        if m.as_of.is_some() && shown[&name] > 1 {
            let bare = name.strip_suffix(')').unwrap_or(&name);
            names.insert(m.machine.installation.clone(), format!("{bare}, saved)"));
        }
    }
    names
}

/// A Task as the board draws it: keyed across the Flock, and where it is when that matters.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed<'a> {
    /// `installation:task id`.
    pub key: String,
    pub installation: &'a str,
    /// Its Machine's display name.
    pub machine: String,
    pub task: &'a Task,
    pub place: String,
    /// When its Machine was last live, where it is not now; its actions are off until it is.
    pub as_of: Option<f64>,
}

pub fn card_key(installation: &str, task: &str) -> String {
    format!("{installation}:{task}")
}

/// Every Task of the Flock in the board's own order, and where it is: its Machine once there
/// is more than one, and its Herd only when its Machine runs several.
pub fn placed(machines: &[Shown]) -> Vec<Placed<'_>> {
    let names = shown_names(machines);
    let mut all = Vec::new();
    for shown in machines {
        let installation = shown.machine.installation.as_str();
        let machine = names[installation].clone();
        for task in &shown.cards {
            let herd = if shown.herds.len() > 1 {
                shown
                    .herds
                    .iter()
                    .find(|h| Some(&h.id) == task.herd.as_ref())
            } else {
                None
            };
            let parts: Vec<String> = [
                (machines.len() > 1).then(|| machine.clone()),
                herd.map(|h| h.name.clone().unwrap_or_else(|| h.id.clone())),
            ]
            .into_iter()
            .flatten()
            .collect();
            all.push(Placed {
                key: card_key(installation, &task.id),
                installation,
                machine: machine.clone(),
                task,
                place: parts.join(" · "),
                as_of: shown.as_of,
            });
        }
    }
    sort_board(&mut all);
    all
}

/// The board's four sections, in the order it draws them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    NeedsYou,
    Waiting,
    Working,
    Finished,
}

impl Section {
    pub const ALL: [Section; 4] = [
        Section::NeedsYou,
        Section::Waiting,
        Section::Working,
        Section::Finished,
    ];
    pub fn label(self) -> &'static str {
        match self {
            Section::NeedsYou => "Needs you",
            Section::Waiting => "Waiting on you",
            Section::Working => "Working",
            Section::Finished => "Finished",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Section::NeedsYou => "needs-you",
            Section::Waiting => "waiting",
            Section::Working => "working",
            Section::Finished => "finished",
        }
    }
    fn rank(self) -> usize {
        Section::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }
}

/// A decision beats liveness, liveness beats history, and history is split by whether the
/// work landed.
pub fn section_of(task: &Task) -> Section {
    match task.state {
        State::Blocked => Section::NeedsYou,
        State::Active | State::Quiet => Section::Working,
        _ if task.landed => Section::Finished,
        _ => Section::Waiting,
    }
}

fn state_rank(state: &State) -> usize {
    match state {
        State::Blocked => 0,
        State::Active => 1,
        State::Quiet => 2,
        State::Failed => 3,
        State::Stopped => 4,
        State::Abandoned => 5,
        State::Done => 6,
    }
}

/// Nothing is driving it any more, so there is nothing to stop, steer or answer.
pub fn is_settled(state: &State) -> bool {
    matches!(
        state,
        State::Done | State::Failed | State::Stopped | State::Abandoned
    )
}

/// It ended without finishing, so it can be taken up again where it stopped.
pub fn can_resume(state: &State) -> bool {
    matches!(state, State::Failed | State::Stopped | State::Abandoned)
}

/// The sections, the state order inside Needs you, what is ready to release, then whatever
/// changed last.
pub fn sort_board(placed: &mut [Placed<'_>]) {
    placed.sort_by(|a, b| {
        let (a, b) = (a.task, b.task);
        let (sa, sb) = (section_of(a), section_of(b));
        sa.rank()
            .cmp(&sb.rank())
            .then_with(|| {
                if sa == Section::NeedsYou {
                    state_rank(&a.state).cmp(&state_rank(&b.state))
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then_with(|| b.ready.unwrap_or(false).cmp(&a.ready.unwrap_or(false)))
            .then_with(|| {
                let (ta, tb) = (a.ended.unwrap_or(a.at), b.ended.unwrap_or(b.at));
                tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
            })
    });
}

/// Waiting on you shows a week open.
pub const WAIT_FOLD_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

fn older(task: &Task, now: f64) -> bool {
    !task.ready.unwrap_or(false) && task.ended.unwrap_or(task.at) < now - WAIT_FOLD_MS
}

/// Waiting on you split at a week: `(recent, older)`; ready work never folds.
pub fn fold_waiting<'a, 'b>(
    waiting: &'b [Placed<'a>],
    now: f64,
) -> (Vec<&'b Placed<'a>>, Vec<&'b Placed<'a>>) {
    waiting.iter().partition(|p| !older(p.task, now))
}

/// Finished split by whether a report in it is still unseen: `(unseen, seen)`.
pub fn fold_finished<'a, 'b>(
    finished: &'b [Placed<'a>],
) -> (Vec<&'b Placed<'a>>, Vec<&'b Placed<'a>>) {
    finished.iter().partition(|p| p.task.unseen == Some(true))
}

/// The one sentence over the board, and whether anything in it wants a human. Waiting on
/// you counts the week's endings.
pub fn header_sentence(tasks: &[&Task], now: Option<f64>) -> (String, bool) {
    let needs = tasks
        .iter()
        .filter(|t| section_of(t) == Section::NeedsYou)
        .count();
    let working: Vec<_> = tasks
        .iter()
        .filter(|t| section_of(t) == Section::Working)
        .collect();
    let quiet = working.iter().filter(|t| t.state == State::Quiet).count();
    let opening = match needs {
        0 => "Nothing needs you.".to_string(),
        1 => "One task is waiting on you.".to_string(),
        n => format!("{n} tasks are waiting on you."),
    };
    let gone = if quiet == 0 {
        String::new()
    } else {
        format!(", {quiet} gone quiet")
    };
    let waiting: Vec<_> = tasks
        .iter()
        .filter(|t| section_of(t) == Section::Waiting)
        .filter(|t| now.is_none_or(|now| !older(t, now)))
        .collect();
    let ready = waiting.iter().filter(|t| t.ready == Some(true)).count();
    let mut held = Vec::new();
    if ready > 0 {
        held.push(format!("{ready} ready to release"));
    }
    if waiting.len() != ready {
        held.push(format!("{} waiting on you", waiting.len() - ready));
    }
    let in_hand = if held.is_empty() {
        String::new()
    } else {
        format!(" {}.", held.join(", "))
    };
    (
        format!("{opening}{in_hand} {} working{gone}.", working.len()),
        needs > 0,
    )
}

/// How the board's alert says a route is not live.
pub fn not_live_title(state: &LostState, name: &str) -> String {
    match state {
        LostState::Unreachable => format!("{name} is out of reach"),
        LostState::Sso => format!("Waiting for SSO login on {name}"),
        LostState::NoCollie => format!("Collie isn't installed on {name}"),
        LostState::UpdateDesktop => format!("Update Desktop to see {name}"),
    }
}
