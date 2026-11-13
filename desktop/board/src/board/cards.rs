//! What a card shows and offers: its actions (`cardActions`, `primaryAction`,
//! `dispositionActions` in `src/board-model.ts`), its merge requests (`card-mrs.ts`) and its
//! Flow strip (`flow-strip.ts`). The TypeScript stays their owner.

use super::model::{Placed, can_resume, is_settled};
use collie_desktop_protocol::generated::{
    Action, Flow, Glyph, GlyphState, Mr, MrState, Offer, State, Task,
};

/// A merge request reference: `host/group/project` (none for an old bare iid) and its number.
#[derive(Debug, Clone, PartialEq)]
pub struct MrRef {
    pub project: Option<String>,
    pub iid: String,
}

impl MrRef {
    pub fn github(&self) -> bool {
        self.project
            .as_deref()
            .and_then(|p| p.split('/').next())
            .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
    }
    fn sign(&self) -> char {
        if self.github() { '#' } else { '!' }
    }
    /// `group/project` of `host/group/project`.
    fn path(&self) -> String {
        let project = self.project.clone().unwrap_or_default();
        match project.split_once('/') {
            Some((host, rest)) if host.contains('.') && !host.starts_with('.') => rest.into(),
            _ => project,
        }
    }
    pub fn label(&self) -> String {
        match &self.project {
            None => self.iid.clone(),
            Some(_) => format!("{}{}{}", self.path(), self.sign(), self.iid),
        }
    }
    pub fn short(&self) -> String {
        let project = self.project.clone().unwrap_or_default();
        let last = project.rsplit('/').next().unwrap_or_default();
        format!("{last}{}{}", self.sign(), self.iid)
    }
    pub fn url(&self) -> Option<String> {
        let project = self.project.as_ref()?;
        let way = if self.github() {
            "pull"
        } else {
            "-/merge_requests"
        };
        Some(format!("https://{project}/{way}/{}", self.iid))
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn word(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// The one reading of a merge request reference: an `mr:` target, a merge or pull request
/// URL, or GitHub's `owner/repo#30`; none for anything else.
pub fn read_mr_ref(text: &str) -> Option<MrRef> {
    let said = text.trim();
    if let Some(target) = said.strip_prefix("mr:") {
        if digits(target) {
            return Some(MrRef {
                project: None,
                iid: target.into(),
            });
        }
        let at = target.rfind(['!', '#'])?;
        let (project, sign, iid) = (&target[..at], &target[at..at + 1], &target[at + 1..]);
        if !digits(iid) || project.contains(|c: char| c.is_whitespace() || c == ',') {
            return None;
        }
        if project.is_empty() {
            return Some(MrRef {
                project: None,
                iid: iid.into(),
            });
        }
        let one = MrRef {
            project: Some(project.into()),
            iid: iid.into(),
        };
        return ((sign == "#") == one.github()).then_some(one);
    }
    let bare = said
        .strip_prefix("https://")
        .or_else(|| said.strip_prefix("http://"))
        .unwrap_or(said);
    let tail_number = |rest: &str| -> Option<String> {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        digits(&rest[..end]).then(|| rest[..end].to_string())
    };
    if bare.len() > 11 && bare[..11].eq_ignore_ascii_case("github.com/") {
        let parts: Vec<&str> = bare.splitn(5, '/').collect();
        if parts.len() >= 5
            && parts[3].eq_ignore_ascii_case("pull")
            && [parts[1], parts[2]]
                .iter()
                .all(|p| !p.is_empty() && !p.contains(char::is_whitespace))
            && let Some(iid) = tail_number(parts[4])
        {
            return Some(MrRef {
                project: Some(format!("{}/{}/{}", parts[0], parts[1], parts[2])),
                iid,
            });
        }
    }
    if let Some(at) = bare.find("/-/merge_requests/") {
        let project = &bare[..at];
        let host_ok = project
            .split_once('/')
            .is_some_and(|(h, rest)| !h.is_empty() && !rest.is_empty());
        if host_ok
            && !project.contains(char::is_whitespace)
            && let Some(iid) = tail_number(&bare[at + "/-/merge_requests/".len()..])
        {
            return Some(MrRef {
                project: Some(project.into()),
                iid,
            });
        }
    }
    let (repo, iid) = said.split_once('#')?;
    let (owner, name) = repo.split_once('/')?;
    (word(owner) && word(name) && digits(iid)).then(|| MrRef {
        project: Some(format!("github.com/{repo}")),
        iid: iid.into(),
    })
}

/// A merge request's one identity, `host/project!42` in lower case; none where no host can
/// be told.
pub fn mr_id(text: &str) -> Option<String> {
    let said = text.trim();
    let one = read_mr_ref(said).or_else(|| {
        (!said.starts_with("mr:"))
            .then(|| read_mr_ref(&format!("mr:{said}")))
            .flatten()
    })?;
    let project = one.project.clone()?;
    let host = project.split('/').next().unwrap_or_default();
    host.contains('.')
        .then(|| format!("{project}{}{}", one.sign(), one.iid).to_lowercase())
}

pub fn mr_state_said(state: &MrState) -> &'static str {
    match state {
        MrState::Open => "open",
        MrState::Merged => "merged",
        MrState::Closed => "closed",
        MrState::OnStage => "on-stage",
        MrState::InProd => "in-prod",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Merged,
    Abandoned,
    Superseded,
}

impl Disposition {
    pub fn said(self) -> &'static str {
        match self {
            Disposition::Merged => "merged",
            Disposition::Abandoned => "abandoned",
            Disposition::Superseded => "superseded",
        }
    }
}

/// One thing a card can be asked for.
#[derive(Debug, Clone, PartialEq)]
pub enum CardAction {
    GoToTab,
    Steer,
    Attach,
    OpenMr {
        mr: MrRef,
        named: Option<String>,
    },
    Offer(Offer),
    CheckOutput,
    Offers,
    Resume,
    FollowUp,
    Hold {
        set: bool,
    },
    Stop,
    Dispose {
        disposition: Disposition,
        r#ref: String,
        named: Option<String>,
    },
    Acknowledge,
}

/// The Open action's label, in the merge request's own forge's words.
pub fn open_mr_label(mr: &MrRef, primary: bool, named: Option<&str>) -> String {
    let github = mr.github();
    match (named, primary) {
        (Some(named), _) => format!("{} {named}", if github { "Open PR" } else { "Open MR" }),
        (None, true) => (if github { "Open PR" } else { "Open MR" }).into(),
        (None, false) => (if github {
            "Open pull request"
        } else {
            "Open merge request"
        })
        .into(),
    }
}

pub fn dispose_label(disposition: Disposition, named: Option<&str>) -> String {
    match named {
        None => format!("Mark {}", disposition.said()),
        Some(named) => format!("Mark {} {named}", disposition.said()),
    }
}

fn mr_ref_of(task: &Task) -> Option<MrRef> {
    task.mr.as_deref().and_then(read_mr_ref)
}

fn dispose(task: &Task, disposition: Disposition) -> CardAction {
    let r#ref = match (disposition, mr_ref_of(task)) {
        (Disposition::Abandoned, _) | (_, None) => String::new(),
        (_, Some(mr)) => mr.short(),
    };
    CardAction::Dispose {
        disposition,
        r#ref,
        named: None,
    }
}

fn several(task: &Task) -> &[Mr] {
    match &task.mrs {
        Some(mrs) if mrs.len() > 1 => mrs,
        _ => &[],
    }
}

fn open_each(one: &Mr) -> CardAction {
    let recorded = read_mr_ref(&one.mr).filter(|r| r.project.is_some());
    let mr = recorded
        .or_else(|| read_mr_ref(&format!("mr:{}", one.id)))
        .unwrap_or(MrRef {
            project: None,
            iid: one.id.clone(),
        });
    CardAction::OpenMr {
        mr,
        named: Some(one.short.clone()),
    }
}

fn dispose_each(one: &Mr, disposition: Disposition) -> CardAction {
    CardAction::Dispose {
        disposition,
        r#ref: one.id.clone(),
        named: Some(one.short.clone()),
    }
}

/// What this Task can be asked for, in the order a menu shows it.
pub fn card_actions(task: &Task) -> Vec<CardAction> {
    let mut actions = vec![CardAction::GoToTab];
    let settled = is_settled(&task.state);
    if !settled {
        actions.extend([CardAction::Steer, CardAction::Attach]);
    }
    let several = several(task);
    if !several.is_empty() {
        actions.extend(several.iter().map(open_each));
    } else if let Some(mr) = mr_ref_of(task) {
        actions.push(CardAction::OpenMr { mr, named: None });
    }
    actions.extend(
        task.offers
            .as_deref()
            .unwrap_or(task.offer.as_slice())
            .iter()
            .cloned()
            .map(CardAction::Offer),
    );
    if matches!(task.check, Some(Some(_))) {
        actions.push(CardAction::CheckOutput);
    }
    actions.push(CardAction::Offers);
    if can_resume(&task.state) {
        actions.push(CardAction::Resume);
    }
    if task.state == State::Done {
        actions.push(CardAction::FollowUp);
    }
    if !settled {
        actions.push(CardAction::Hold {
            set: task.held.is_none(),
        });
        actions.push(CardAction::Stop);
    }
    actions
}

pub fn ships_by_merge(task: &Task) -> bool {
    task.shipping == Some(Some(Action::Merge))
}

/// The one action that ends a card's wait, drawn first on it.
pub fn primary_action(task: &Task) -> Option<CardAction> {
    if task.decision.is_some() {
        return None;
    }
    if matches!(task.state, State::Active | State::Quiet) {
        return Some(CardAction::GoToTab);
    }
    if task.unseen == Some(true) {
        return Some(CardAction::Acknowledge);
    }
    if task.landed {
        return None;
    }
    if ships_by_merge(task) && task.offer.is_some() {
        return task.offer.clone().map(CardAction::Offer);
    }
    if task.plan_ready {
        return task.offer.clone().map(CardAction::Offer);
    }
    if can_resume(&task.state) {
        return Some(CardAction::Resume);
    }
    let several = several(task);
    if !several.is_empty() {
        if let Some(closed) = several
            .iter()
            .find(|one| one.state == Some(MrState::Closed) && one.disposition.is_none())
        {
            return Some(dispose_each(closed, Disposition::Superseded));
        }
        let first = several.iter().find(|one| one.ready).unwrap_or(&several[0]);
        return Some(open_each(first));
    }
    if task.mr_state == Some(MrState::Closed) {
        return Some(dispose(task, Disposition::Superseded));
    }
    mr_ref_of(task).map(|mr| CardAction::OpenMr { mr, named: None })
}

/// What became of the work, for any settled Task.
pub fn disposition_actions(task: &Task) -> Vec<CardAction> {
    if !is_settled(&task.state) {
        return Vec::new();
    }
    let several = several(task);
    if !several.is_empty() {
        return several
            .iter()
            .flat_map(|one| {
                let mut kinds = vec![Disposition::Merged, Disposition::Abandoned];
                if one.state == Some(MrState::Closed) {
                    kinds.push(Disposition::Superseded);
                }
                kinds.into_iter().map(|kind| dispose_each(one, kind))
            })
            .collect();
    }
    let mut kinds = vec![Disposition::Merged, Disposition::Abandoned];
    if task.mr_state == Some(MrState::Closed) {
        kinds.push(Disposition::Superseded);
    }
    kinds.into_iter().map(|kind| dispose(task, kind)).collect()
}

/// One of a Task's merge requests: its state, whether it is ready to release at which head,
/// and what it waits on.
pub fn mr_readiness(one: &Mr, mrs: &[Mr]) -> String {
    let waits: Vec<String> = one
        .waits_on
        .iter()
        .map(|id| {
            mrs.iter()
                .find(|other| &other.id == id)
                .map_or_else(|| id.clone(), |other| other.short.clone())
        })
        .collect();
    let head = one
        .head
        .as_ref()
        .map(|h| format!(" at {}", h.chars().take(8).collect::<String>()))
        .unwrap_or_default();
    let mut parts = vec![
        one.state
            .as_ref()
            .map_or("not watched", mr_state_said)
            .to_string(),
        if one.ready {
            format!("ready to release{head}")
        } else {
            "not ready to release".into()
        },
    ];
    if !waits.is_empty() {
        parts.push(format!("waits on {}", waits.join(", ")));
    }
    parts.join(", ")
}

/// A merge request as a card lists it, with its own Open.
#[derive(Debug, Clone, PartialEq)]
pub struct CardMr {
    pub id: String,
    pub line: String,
    pub open: Option<(String, String)>,
}

/// An older host's single merge request, as the list would have named it.
fn scalar_of(task: &Task) -> Vec<Mr> {
    let (Some(text), Some(one)) = (task.mr.as_ref(), mr_ref_of(task)) else {
        return Vec::new();
    };
    vec![Mr {
        id: mr_id(text).unwrap_or_else(|| text.clone()),
        mr: text.clone(),
        label: one.label(),
        short: one.short(),
        url: one.url(),
        run: task.run.clone(),
        state: task.mr_state.clone(),
        checks: task.checks.clone().flatten(),
        head: None,
        ready: task.ready.unwrap_or(false),
        disposition: task.disposition.clone(),
        waits_on: Vec::new(),
        settled: None,
    }]
}

pub fn card_mrs(task: &Task) -> Vec<CardMr> {
    let mrs = task.mrs.clone().unwrap_or_else(|| scalar_of(task));
    let several = mrs.len() > 1;
    mrs.iter()
        .map(|one| {
            let found = read_mr_ref(&one.mr).or_else(|| read_mr_ref(&format!("mr:{}", one.id)));
            let url = one
                .url
                .clone()
                .or_else(|| found.as_ref().and_then(MrRef::url));
            CardMr {
                id: one.id.clone(),
                line: format!("{} · {}", one.short, mr_readiness(one, &mrs)),
                open: found.zip(url).map(|(mr, url)| {
                    (
                        open_mr_label(&mr, false, several.then_some(one.short.as_str())),
                        url,
                    )
                }),
            }
        })
        .collect()
}

/// A Machine's card holding a merge request, which a link opens.
#[derive(Debug, Clone, PartialEq)]
pub struct MrLink {
    pub key: String,
    pub machine: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FlockMr {
    pub mr: CardMr,
    pub links: Vec<MrLink>,
}

/// The merge requests each card draws, by card key: one several cards hold is drawn once, on
/// the first in board order, with a link to each; a card draws its own only where it has
/// several or another Machine holds one too.
pub fn flock_mrs(placed: &[Placed<'_>]) -> Vec<(String, Vec<FlockMr>)> {
    let mut shown: Vec<FlockMr> = Vec::new();
    let mut first_on: Vec<(String, Vec<String>)> = Vec::new();
    let mut held: Vec<(String, usize)> = Vec::new();
    for one in placed {
        let mrs = card_mrs(one.task);
        held.push((one.key.clone(), mrs.len()));
        for mr in mrs {
            let link = MrLink {
                key: one.key.clone(),
                machine: one.machine.clone(),
            };
            match shown.iter_mut().find(|s| s.mr.id == mr.id) {
                None => {
                    match first_on.iter_mut().find(|(k, _)| *k == one.key) {
                        Some((_, ids)) => ids.push(mr.id.clone()),
                        None => first_on.push((one.key.clone(), vec![mr.id.clone()])),
                    }
                    shown.push(FlockMr {
                        mr,
                        links: vec![link],
                    });
                }
                Some(seen) => {
                    if !seen.links.iter().any(|l| l.key == one.key) {
                        seen.links.push(link);
                    }
                }
            }
        }
    }
    first_on
        .into_iter()
        .filter_map(|(key, ids)| {
            let rows: Vec<FlockMr> = ids
                .iter()
                .filter_map(|id| shown.iter().find(|s| &s.mr.id == id).cloned())
                .collect();
            let count = held.iter().find(|(k, _)| *k == key).map_or(0, |(_, n)| *n);
            (count > 1 || rows.iter().any(|r| r.links.len() > 1)).then_some((key, rows))
        })
        .collect()
}

/// A card's Flow strip: the Run's glyphs (done Steps folded past ten), the release's, and
/// what it is at.
#[derive(Debug, Clone, PartialEq)]
pub struct CardFlow {
    /// Each glyph, and how many done Steps it stands for where it folds them.
    pub run: Vec<(Glyph, Option<usize>)>,
    pub release: Vec<Glyph>,
    pub label: String,
    pub name: String,
}

pub fn card_flow(flow: Option<&Flow>) -> Option<CardFlow> {
    let flow = flow?;
    let end = flow
        .glyphs
        .len()
        .saturating_sub(flow.release.max(0.0) as usize);
    let run = &flow.glyphs[..end];
    let done = run.iter().filter(|g| g.state == GlyphState::Done).count();
    let glyphs: Vec<(Glyph, Option<usize>)> = if run.len() <= 10 {
        run.iter().map(|g| (g.clone(), None)).collect()
    } else {
        let mut folded = false;
        run.iter()
            .filter_map(|g| {
                if g.state != GlyphState::Done {
                    return Some((g.clone(), None));
                }
                if folded {
                    return None;
                }
                folded = true;
                Some((
                    Glyph {
                        title: format!("{done} done"),
                        state: GlyphState::Done,
                    },
                    Some(done),
                ))
            })
            .collect()
    };
    let (label, name) = match &flow.current {
        None if done == run.len() => (
            "Done".to_string(),
            format!("Flow: {} of {} Steps done.", run.len(), run.len()),
        ),
        // No Step is under way, yet not every Step is done: say how far it got, not "Done".
        None => (
            format!("{done} of {} Steps done", run.len()),
            format!(
                "Flow: no Step under way. {done} of {} Steps done.",
                run.len()
            ),
        ),
        Some(current) => {
            let parts: Vec<&str> = [Some(current.title.as_str()), current.said.as_deref()]
                .into_iter()
                .flatten()
                .filter(|p| !p.is_empty())
                .collect();
            (
                parts.join(" · "),
                format!(
                    "Flow: {}. {done} of {} Steps done.",
                    parts.join(", "),
                    run.len()
                ),
            )
        }
    };
    Some(CardFlow {
        run: glyphs,
        release: flow.glyphs[end..].to_vec(),
        label,
        name,
    })
}

/// How a card's state reads, and its tone.
pub fn state_label(state: &State) -> &'static str {
    match state {
        State::Blocked => "Needs you",
        State::Active => "Working",
        State::Quiet => "Quiet",
        State::Failed => "Failed",
        State::Stopped => "Stopped",
        State::Abandoned => "Abandoned",
        State::Done => "Done",
    }
}

/// `repo · branch`: the project's last part and the branch.
pub fn repo_and_branch(task: &Task) -> String {
    [
        task.project.rsplit('/').next().filter(|p| !p.is_empty()),
        task.branch.as_deref().filter(|b| !b.is_empty()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}
