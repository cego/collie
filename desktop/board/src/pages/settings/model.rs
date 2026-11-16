//! What Settings shows of each setting, ported from `desktop/src/shared/flock-settings.ts`.

use super::registry::{self, Kind, Setting};
use super::time::when_of;
use collie_desktop_protocol::generated::{FlockSettingsSuccess, SettingsSuccess};

/// One setting as Settings shows it, its value and default in its unit.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub group: &'static str,
    /// The sub-group it is shown under within its group, empty for none.
    pub sub: &'static str,
    pub label: String,
    pub description: String,
    pub kind: Kind,
    pub choices: Vec<String>,
    /// What it is set to, empty where it is unset.
    pub value: String,
    /// What a Run uses while it is unset.
    pub fallback: String,
    pub unit: Option<&'static str>,
    pub default_said: String,
    pub set: bool,
    /// Whose edit it is and when, or the Machine it was taken from over a different value.
    pub edit: Option<String>,
    /// Every Machine's, or this computer's alone.
    pub shared: bool,
    pub multiline: bool,
    /// What its value brings about, stated rather than confirmed.
    pub hint: Option<String>,
}

impl Row {
    /// A stable id for the row's controls.
    pub fn id(&self) -> String {
        format!(
            "{}-{}",
            if self.shared { "flock" } else { "desktop" },
            self.key.replace('.', "-")
        )
    }

    /// What it is, or what it falls back to while unset.
    pub fn effective(&self) -> &str {
        if self.value.is_empty() {
            &self.fallback
        } else {
            &self.value
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub group: &'static str,
    pub rows: Vec<Row>,
}

/// The sub-groups within a group, in the canvas's order.
pub const SUBS: [&str; 6] = [
    "Who does the work",
    "What agents may do",
    "Context and patience",
    "Advanced",
    "Release approvals",
    "Toasts",
];

fn sub_of(key: &str) -> &'static str {
    match key {
        "harness" | "model" | "effort" | "fallbacks" => SUBS[0],
        "permissions" | "trust" => SUBS[1],
        "compact_at_tokens" | "claude_auto_compact_window" | "quiet_ms" | "idle_close_ms" => {
            SUBS[2]
        }
        "agent_profile" | "claude_subagents" => SUBS[3],
        _ if key.starts_with("models.") => SUBS[3],
        _ if key.starts_with("release.") => SUBS[4],
        _ if key.starts_with("notifications.") => SUBS[5],
        _ => "",
    }
}

fn sub_rank(sub: &str) -> i32 {
    SUBS.iter()
        .position(|s| *s == sub)
        .map_or(-1, |at| at as i32)
}

fn unset_said(key: &str) -> Option<&'static str> {
    match key {
        "machine_rule" => Some("Unset: no rule"),
        "standing_direction" => Some("Unset: nothing kept"),
        "release.approval_channel" => Some("Unset: shares nothing"),
        "slack.notification_channel" => Some("Unset: toasts only"),
        _ => None,
    }
}

fn default_said(setting: &Setting, fallback: &str) -> String {
    if let Some(said) = unset_said(&setting.key) {
        return said.into();
    }
    match setting.kind {
        Kind::List | Kind::Json => "Default: none".into(),
        _ if fallback.is_empty() => "Unset: the harness decides".into(),
        Kind::Boolean => format!("Default: {}", if fallback == "true" { "on" } else { "off" }),
        _ => match setting.unit {
            Some(unit) => format!("Default: {fallback} {unit}"),
            None => format!("Default: {fallback}"),
        },
    }
}

/// What a value brings about, said on its row.
pub fn consequence_of(key: &str, value: &str) -> Option<String> {
    match (key, value) {
        ("permissions", "bypass") => {
            return Some(
                "No one reviews an agent's tool calls: every Machine's agents run what they choose."
                    .into(),
            );
        }
        ("compact_at_tokens", "0") => {
            return Some("Compaction between pieces of work is off.".into());
        }
        ("quiet_ms", "0") => {
            return Some("A quiet agent is never nudged; it waits as long as it takes.".into());
        }
        _ => {}
    }
    if key != "models.pi" {
        return None;
    }
    let bare = value
        .split(", ")
        .find(|model| !model.is_empty() && !model.contains('/'))?;
    Some(format!(
        "Pi runs a model written provider/model, such as openai-codex/gpt-6.1-sol, so it cannot run \"{bare}\"."
    ))
}

fn row_of(setting: &Setting) -> Row {
    Row {
        key: setting.key.clone(),
        group: setting.group,
        sub: sub_of(&setting.key),
        label: setting.label.clone(),
        description: setting.description.clone(),
        kind: setting.kind,
        choices: setting.choices.clone(),
        value: String::new(),
        fallback: String::new(),
        unit: setting.unit,
        default_said: String::new(),
        set: false,
        edit: None,
        shared: true,
        multiline: false,
        hint: None,
    }
}

fn flock_row(flock: &FlockSettingsSuccess, setting: &Setting, now: f64, offset: i64) -> Row {
    let held = flock.settings.get(&setting.key);
    let value = held.map_or(String::new(), |h| registry::text_of(h.value.as_ref()));
    let edit = match held {
        Some(held) if !value.is_empty() => Some(if held.differed {
            format!(
                "Taken from {} over a different value at the first sync",
                held.from
            )
        } else {
            format!(
                "Last edit: {} · {}",
                held.from,
                when_of(&held.at, now, offset)
            )
        }),
        _ => None,
    };
    let fallback = registry::shown(&setting.key, &setting.fallback);
    Row {
        value: registry::shown(&setting.key, &value),
        default_said: default_said(setting, &fallback),
        fallback,
        set: !value.is_empty(),
        edit,
        shared: true,
        multiline: setting.kind == Kind::Json
            || matches!(setting.key.as_str(), "machine_rule" | "standing_direction"),
        hint: consequence_of(&setting.key, &value),
        ..row_of(setting)
    }
}

/// Record timing, the one of Desktop's own settings Rune draws by. Zoom is not shown: Rune
/// has no app-wide scale for it to change.
fn record_timing(desktop: &SettingsSuccess) -> Row {
    let setting = Setting {
        key: "record_timing".into(),
        kind: Kind::Choice,
        choices: vec!["off".into(), "on".into()],
        fallback: "off".into(),
        group: "Board",
        label: "Record timing".into(),
        description: "Logs how long each record took to open, and Desktop's launch, terminal, chat and scrolling, to record-timing.log in Desktop's state directory.".into(),
        unit: None,
        machine: false,
    };
    let value = if desktop.record_timing == Some(true) {
        "on"
    } else {
        "off"
    };
    let set = value != setting.fallback;
    Row {
        value: value.into(),
        fallback: setting.fallback.clone(),
        default_said: default_said(&setting, &setting.fallback),
        set,
        edit: set.then(|| "Saved on this computer".into()),
        shared: false,
        ..row_of(&setting)
    }
}

/// Every setting of Collie's and Desktop's own, under its group in order, but the GitLab
/// host, which Settings keeps beside its token, and each Machine's own. An edit is said at
/// `now`, `offset` minutes east of UTC.
pub fn sections(
    flock: &FlockSettingsSuccess,
    desktop: &SettingsSuccess,
    now: f64,
    offset: i64,
) -> Vec<Section> {
    let mut rows = vec![record_timing(desktop)];
    rows.extend(
        registry::settings()
            .iter()
            .filter(|s| s.key != "gitlab_host" && !s.machine)
            .map(|s| flock_row(flock, s, now, offset)),
    );
    registry::GROUPS
        .iter()
        .filter_map(|group| {
            let mut placed: Vec<Row> = rows.iter().filter(|r| r.group == *group).cloned().collect();
            placed.sort_by_key(|r| sub_rank(r.sub));
            (!placed.is_empty()).then_some(Section {
                group,
                rows: placed,
            })
        })
        .collect()
}

/// A Machine as an edit's reach is told: its name, whether it is live, and how its latest
/// settings sync ended (`None` before any, `Some(None)` synced, `Some(Some(why))` failed).
#[derive(Clone, Debug, PartialEq)]
pub struct Reached {
    pub name: String,
    pub live: bool,
    pub synced: Option<Option<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Warn,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Said {
    pub said: String,
    pub tone: Tone,
}

fn missed(m: &Reached) -> bool {
    !m.live || !matches!(m.synced, Some(None))
}

fn listed(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// How far an edit of the Flock's settings reached, or why it is not sent: one made while
/// the Flock's settings cannot be read would be made blind.
pub fn flock_reach(readable: bool, machines: &[Reached]) -> Result<Said, String> {
    if !readable {
        return Err("Not set: the Flock's settings could not be read".into());
    }
    let behind: Vec<String> = machines
        .iter()
        .filter(|m| missed(m))
        .map(|m| m.name.clone())
        .collect();
    if behind.is_empty() {
        return Ok(Said {
            said: format!("Given to all {} Machines", machines.len()),
            tone: Tone::Ok,
        });
    }
    Ok(Said {
        said: format!(
            "Given to {} of {} · {} {}",
            machines.len() - behind.len(),
            machines.len(),
            listed(&behind),
            if behind.len() == 1 {
                "gets it when it connects"
            } else {
                "get it when they connect"
            }
        ),
        tone: Tone::Warn,
    })
}

pub fn sync_pill(readable: bool, machines: &[Reached]) -> Said {
    if !readable {
        return Said {
            said: "Showing the Flock's settings as last read".into(),
            tone: Tone::Warn,
        };
    }
    let behind: Vec<&Reached> = machines.iter().filter(|m| missed(m)).collect();
    if behind.is_empty() {
        return Said {
            said: format!("In sync with all {} Machines", machines.len()),
            tone: Tone::Ok,
        };
    }
    let lagging: Vec<String> = behind
        .iter()
        .map(|m| {
            format!(
                "{} {}",
                m.name,
                if m.live { "behind" } else { "out of reach" }
            )
        })
        .collect();
    Said {
        said: format!(
            "In sync with {} of {} · {}",
            machines.len() - behind.len(),
            machines.len(),
            listed(&lagging)
        ),
        tone: Tone::Warn,
    }
}
