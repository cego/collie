//! Whether each Machine is In sync with Desktop, and the Flock's line about it: a port of
//! `desktop/src/shared/in-sync.ts`.

use super::flock::{MachineRow, RowState, settled};
use collie_desktop_protocol::generated::{LostState, RunStep};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Version,
    Settings,
    Definitions,
    Credentials,
    Onboarding,
}

impl Part {
    fn word(self) -> &'static str {
        match self {
            Part::Version => "version",
            Part::Settings => "settings",
            Part::Definitions => "definitions",
            Part::Credentials => "credentials",
            Part::Onboarding => "onboarding",
        }
    }
}

/// What a Machine lags on, in words, with the steps that fix onboarding.
#[derive(Debug, Clone, PartialEq)]
pub struct Lag {
    pub part: Part,
    pub said: String,
    pub steps: Vec<RunStep>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    InSync,
    Behind,
    Connecting,
    NotLive(LostState),
}

#[derive(Debug, Clone, PartialEq)]
pub struct InSync {
    pub state: Verdict,
    pub behind: Vec<Lag>,
}

/// What Desktop gives its Flock; a version that isn't a release asks nothing of one.
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopHolds {
    pub version: String,
    /// `gitlab`, `helle`, `slack`.
    pub credentials: Vec<&'static str>,
}

fn lacks(credential: &str) -> (&'static str, &'static str) {
    match credential {
        "gitlab" => ("the GitLab token", "GitLab token"),
        "helle" => ("Helle's token", "Helle token"),
        _ => ("your Slack sign-in", "Slack sign-in"),
    }
}

fn release(version: &str) -> Option<Vec<u64>> {
    let parts: Vec<u64> = version
        .split('.')
        .map(|p| {
            p.parse()
                .ok()
                .filter(|_| p.chars().all(|c| c.is_ascii_digit()))
        })
        .collect::<Option<_>>()?;
    (parts.len() == 3).then_some(parts)
}

fn lags(row: &MachineRow, desktop: &DesktopHolds) -> Vec<Lag> {
    let mut behind = Vec::new();
    if let (Some(build), None) = (&row.build, &row.development)
        && let (Some(a), Some(b)) = (release(build), release(&desktop.version))
        && a < b
    {
        behind.push(Lag {
            part: Part::Version,
            said: format!("Runs Collie {build}; Desktop is {}", desktop.version),
            steps: vec![],
        });
    }
    if let Some(Some(failed)) = &row.settings {
        behind.push(Lag {
            part: Part::Settings,
            said: format!("Settings didn't sync: {failed}"),
            steps: vec![],
        });
    }
    if let Some(Some(failed)) = &row.definitions {
        let by_hand = if row.development.is_some() {
            " (a development checkout, updated by hand)"
        } else {
            ""
        };
        behind.push(Lag {
            part: Part::Definitions,
            said: format!("Definitions didn't sync: {failed}{by_hand}"),
            steps: vec![],
        });
    }
    for credential in &desktop.credentials {
        let Some(held) = row.credentials.get(credential) else {
            continue;
        };
        if held.given {
            continue;
        }
        let said = format!("Lacks {}", lacks(credential).0);
        behind.push(Lag {
            part: Part::Credentials,
            said: match &held.failed {
                None => said,
                Some(why) => format!("{said}: {why}"),
            },
            steps: vec![],
        });
    }
    if let Some(run) = row.onboarded.as_ref().filter(|r| r.ready == Some(false)) {
        let missing: Vec<RunStep> = run
            .steps
            .iter()
            .filter(|s| !settled(&s.status))
            .cloned()
            .collect();
        let titles = missing
            .iter()
            .map(|s| s.title.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let why = if titles.is_empty() {
            run.reason
                .clone()
                .unwrap_or_else(|| "doctor says it isn't ready".into())
        } else {
            titles
        };
        behind.push(Lag {
            part: Part::Onboarding,
            said: format!("Not onboarded: {why}"),
            steps: missing,
        });
    }
    behind
}

/// A part not known yet is not behind.
pub fn in_sync(row: &MachineRow, desktop: &DesktopHolds) -> InSync {
    match &row.state {
        RowState::Connecting => InSync {
            state: Verdict::Connecting,
            behind: vec![],
        },
        RowState::NotLive(state) => InSync {
            state: Verdict::NotLive(state.clone()),
            behind: vec![],
        },
        RowState::Live => {
            let behind = lags(row, desktop);
            InSync {
                state: if behind.is_empty() {
                    Verdict::InSync
                } else {
                    Verdict::Behind
                },
                behind,
            }
        }
    }
}

/// Whether Sync now is offered: onboarding has its own steps.
pub fn syncable(verdict: &InSync) -> bool {
    verdict.behind.iter().any(|l| l.part != Part::Onboarding)
}

/// The Collie a Machine's row says it runs.
pub fn build_of(row: &MachineRow) -> String {
    match (&row.development, &row.build) {
        (Some(development), _) => format!("development build {development}"),
        (None, Some(build)) => format!("Collie {build}"),
        (None, None) => "Build not known yet".into(),
    }
}

/// The Machines page's top line, and how many Machines aren't in sync, connecting ones aside.
pub fn flock_in_sync(rows: &[MachineRow], desktop: &DesktopHolds) -> (String, usize) {
    let lagging: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            let verdict = in_sync(row, desktop);
            match verdict.state {
                Verdict::InSync | Verdict::Connecting => None,
                Verdict::Behind => {
                    let mut parts: Vec<&str> = Vec::new();
                    for lag in &verdict.behind {
                        if !parts.contains(&lag.part.word()) {
                            parts.push(lag.part.word());
                        }
                    }
                    Some(format!("{}: behind on {}", row.name, parts.join(" and ")))
                }
                Verdict::NotLive(state) => Some(format!(
                    "{}: {}",
                    row.name,
                    super::flock::not_live_said(&state)
                )),
            }
        })
        .collect();
    let mut said = vec![if lagging.is_empty() {
        format!("Every Machine is in sync with Desktop {}", desktop.version)
    } else {
        format!(
            "Not in sync with Desktop {}: {}",
            desktop.version,
            lagging.join("; ")
        )
    }];
    said.extend(
        ["gitlab", "helle"]
            .into_iter()
            .filter(|c| !desktop.credentials.contains(c))
            .map(|c| format!("Desktop has no {} to give", lacks(c).1)),
    );
    (said.join(". "), lagging.len())
}
