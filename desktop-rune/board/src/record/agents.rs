//! Who a record's terminal shows and its review comments go to, what each agent ran on, and how
//! a merge request is named: copies of `record-terminal.ts`, `run-agents.ts` and `readMrRef` and
//! `mrWords` in `src/board-model.ts`, which stay their owners.

use collie_desktop_protocol::generated::{Agent, DetailAgent};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTab {
    pub name: String,
    pub run: String,
    pub label: String,
    /// herdr's status, or `ended` for the agent shown once the board no longer lists it.
    pub state: String,
    pub now: Option<String>,
    pub shown: bool,
}

fn role_of(agent: &Agent) -> &str {
    agent.role.as_deref().unwrap_or(&agent.name)
}

/// The card's live agents, and the one `shown` kept while it is shown though it has ended.
/// Each is its role, numbered where several share one; its herdr name where it has none.
pub fn agent_tabs(agents: &[Agent], shown: Option<&Agent>) -> Vec<AgentTab> {
    let ended = shown.filter(|one| !agents.iter().any(|a| a.name == one.name));
    let listed: Vec<&Agent> = agents.iter().chain(ended).collect();
    let mut seen: Vec<(String, usize)> = Vec::new();
    listed
        .iter()
        .map(|agent| {
            let role = role_of(agent).to_string();
            let nth = match seen.iter_mut().find(|(r, _)| *r == role) {
                Some((_, n)) => {
                    *n += 1;
                    *n
                }
                None => {
                    seen.push((role.clone(), 1));
                    1
                }
            };
            let shared = listed.iter().filter(|one| role_of(one) == role).count() > 1;
            let is_ended = ended.is_some_and(|e| std::ptr::eq(e, *agent));
            AgentTab {
                name: agent.name.clone(),
                run: agent.run.clone(),
                label: if shared {
                    format!("{role} {nth}")
                } else {
                    role
                },
                state: if is_ended {
                    "ended".into()
                } else {
                    agent.status.clone()
                },
                now: agent.now.clone(),
                shown: shown.is_some_and(|s| s.name == agent.name),
            }
        })
        .collect()
}

/// Only the Run's own live launches, newest last even when reused under another Run.
pub fn recipients(launches: &[DetailAgent], live: &[Agent]) -> Vec<AgentTab> {
    let tabs = agent_tabs(live, None);
    let names: Vec<&str> = launches.iter().map(|l| l.agent.as_str()).collect();
    let latest = names
        .iter()
        .enumerate()
        .filter(|(at, name)| names.iter().rposition(|n| n == *name) == Some(*at))
        .map(|(_, name)| *name);
    latest
        .filter_map(|name| tabs.iter().find(|tab| tab.name == name).cloned())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryChoice {
    pub key: String,
    pub label: String,
    pub to: Option<String>,
    pub agent: Option<String>,
}

/// The first board protocol whose hosts take a delivery to a role or to no agent.
pub const ADDRESSED_DELIVERY: u32 = 4;

/// The names `--to` takes for a role, and the launch roles each covers (`ROLES` in
/// `src/steer-target.ts`).
const ROLES: [(&str, &[&str]); 3] = [
    ("builder", &["implementer"]),
    ("reviewer", &["reviewer"]),
    ("planner", &["planner"]),
];

/// Addressed hosts offer roles and agents; older hosts offer agents only, newest first. A
/// live preferred role goes first.
pub fn delivery_choices(
    launches: &[DetailAgent],
    live: &[Agent],
    protocol: Option<u32>,
    preferred: Option<&str>,
) -> Vec<DeliveryChoice> {
    let tabs = recipients(launches, live);
    if tabs.is_empty() {
        return Vec::new();
    }
    let by_name = tabs.iter().map(|tab| DeliveryChoice {
        key: tab.name.clone(),
        label: tab.label.clone(),
        to: None,
        agent: Some(tab.name.clone()),
    });
    let roles: Vec<&str> = tabs
        .iter()
        .filter_map(|tab| {
            live.iter()
                .find(|one| one.name == tab.name)?
                .role
                .as_deref()
        })
        .collect();
    let offered: Vec<DeliveryChoice> = match protocol {
        Some(p) if p >= ADDRESSED_DELIVERY => {
            let at_work = DeliveryChoice {
                key: "@work".into(),
                label: "The agent at work".into(),
                to: None,
                agent: None,
            };
            let by_role = ROLES
                .iter()
                .filter(|(_, covered)| covered.iter().any(|role| roles.contains(role)))
                .map(|(to, _)| DeliveryChoice {
                    key: format!("@{to}"),
                    label: format!("The {to}"),
                    to: Some((*to).into()),
                    agent: None,
                });
            std::iter::once(at_work)
                .chain(by_role)
                .chain(by_name)
                .collect()
        }
        _ => by_name.rev().collect(),
    };
    let first = preferred.and_then(|preferred| {
        offered.iter().position(|one| {
            one.to.as_deref() == Some(preferred)
                || one.agent.as_ref().is_some_and(|name| {
                    live.iter()
                        .any(|a| &a.name == name && a.role.as_deref() == Some(preferred))
                })
        })
    });
    match first {
        Some(at) => {
            let mut offered = offered;
            let one = offered.remove(at);
            std::iter::once(one).chain(offered).collect()
        }
        None => offered,
    }
}

/// The agent the tab opens on: one `blocked`, else one `working`, of the card's own Run first
/// and then the last listed.
pub fn at_work<'a>(agents: &'a [Agent], run: &str) -> Option<&'a Agent> {
    let blocked: Vec<&Agent> = agents.iter().filter(|a| a.status == "blocked").collect();
    let candidates = if blocked.is_empty() {
        agents.iter().filter(|a| a.status == "working").collect()
    } else {
        blocked
    };
    let own: Vec<&Agent> = candidates
        .iter()
        .copied()
        .filter(|a| a.run == run)
        .collect();
    if own.is_empty() {
        candidates.last().copied()
    } else {
        own.last().copied()
    }
}

/// The agent the tab asks for: the one picked, else the agent at work; none for the Run's
/// newest.
pub fn asked_for(agents: &[Agent], run: &str, picked: Option<&str>) -> Option<AgentTab> {
    let tabs = agent_tabs(agents, None);
    if let Some(picked) = picked {
        return Some(
            tabs.into_iter()
                .find(|t| t.name == picked)
                .unwrap_or(AgentTab {
                    name: picked.into(),
                    run: run.into(),
                    label: picked.into(),
                    state: "ended".into(),
                    now: None,
                    shown: false,
                }),
        );
    }
    let busy = at_work(agents, run)?;
    tabs.into_iter().find(|t| t.name == busy.name)
}

fn choice_said(harness: &str, model: Option<&str>, effort: Option<&str>) -> String {
    let effort = effort.map(|e| format!(" {e}")).unwrap_or_default();
    format!("{harness}/{}{effort}", model.unwrap_or("default"))
}

/// What an agent ran on: `claude/opus xhigh`, or `codex/default (fell back from claude/opus:
/// session 100%)`.
pub fn ran_on(agent: &DetailAgent) -> String {
    let on = choice_said(
        &agent.harness,
        agent.model.as_deref(),
        agent.effort.as_deref(),
    );
    let why = agent.why.clone().unwrap_or_default();
    match (&agent.from, &agent.why) {
        (Some(from), _) => format!(
            "{on} (fell back from {}: {why})",
            choice_said(&from.harness, Some(&from.model), from.effort.as_deref())
        ),
        (None, Some(why)) => format!("{on} ({why})"),
        (None, None) => on,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MrRef {
    pub project: Option<String>,
    pub iid: String,
}

fn github(project: Option<&str>) -> bool {
    project
        .and_then(|p| p.split('/').next())
        .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// An `mr:` target, a merge or pull request URL, or GitHub's `owner/repo#30`; none for
/// anything else.
pub fn read_mr_ref(text: &str) -> Option<MrRef> {
    let said = text.trim();
    if let Some(target) = said.strip_prefix("mr:") {
        let at = target.rfind(['!', '#']);
        let (project, sign, iid) = match at {
            Some(at) => (&target[..at], &target[at..at + 1], &target[at + 1..]),
            None => ("", "", target),
        };
        if !digits(iid) || project.contains([' ', ',']) {
            return None;
        }
        if project.is_empty() {
            let _ = sign;
            return Some(MrRef {
                project: None,
                iid: iid.into(),
            });
        }
        return ((sign == "#") == github(Some(project))).then(|| MrRef {
            project: Some(project.into()),
            iid: iid.into(),
        });
    }
    let bare = said
        .strip_prefix("https://")
        .or_else(|| said.strip_prefix("http://"))
        .unwrap_or(said);
    let number = |rest: &str| -> Option<String> {
        let iid: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let after = rest[iid.len()..].chars().next();
        (!iid.is_empty() && after.is_none_or(|c| matches!(c, '/' | '?' | '#'))).then_some(iid)
    };
    if let Some(at) = bare.find("/-/merge_requests/") {
        let project = &bare[..at];
        let iid = number(&bare[at + "/-/merge_requests/".len()..])?;
        return (project.contains('/') && !project.contains(' ')).then(|| MrRef {
            project: Some(project.into()),
            iid,
        });
    }
    let lower = bare.to_ascii_lowercase();
    if lower.starts_with("github.com/") {
        let parts: Vec<&str> = bare.splitn(5, '/').collect();
        if parts.len() == 5 && parts[3] == "pull" {
            return Some(MrRef {
                project: Some(parts[..3].join("/")),
                iid: number(parts[4])?,
            });
        }
    }
    let (repo, iid) = said.split_once('#')?;
    let owned = repo.split('/').count() == 2
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'));
    (owned && digits(iid)).then(|| MrRef {
        project: Some(format!("github.com/{repo}")),
        iid: iid.into(),
    })
}

pub struct MrWords {
    pub noun: &'static str,
    pub checks: &'static str,
    pub sign: char,
    /// `project!42`, the project's last segment and its number.
    pub short: String,
}

pub fn mr_words(mr: &MrRef) -> MrWords {
    let github = github(mr.project.as_deref());
    let sign = if github { '#' } else { '!' };
    let last = mr
        .project
        .as_deref()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("");
    MrWords {
        noun: if github {
            "pull request"
        } else {
            "merge request"
        },
        checks: if github { "checks" } else { "pipeline" },
        sign,
        short: format!("{last}{sign}{}", mr.iid),
    }
}

pub fn capital(said: &str) -> String {
    let mut chars = said.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
