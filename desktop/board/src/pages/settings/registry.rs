//! Collie's settings as `src/settings.ts` lists them: key, kind, default, group and words.
//! A copy, kept to the TypeScript by `tests/settings.rs`; the core alone checks a value.

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Choice,
    Number,
    Text,
    Boolean,
    List,
    Json,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Choice => "choice",
            Kind::Number => "number",
            Kind::Text => "text",
            Kind::Boolean => "boolean",
            Kind::List => "list",
            Kind::Json => "json",
        }
    }
}

/// Where a setting is shown, in the order it is shown.
pub const GROUPS: [&str; 6] = [
    "Agents",
    "Runs",
    "Board",
    "Chat",
    "Notifications",
    "GitLab and credentials",
];

#[derive(Clone, Debug, PartialEq)]
pub struct Setting {
    pub key: String,
    pub kind: Kind,
    pub choices: Vec<String>,
    /// What a Run uses while it is unset, as text; empty where the harness decides.
    pub fallback: String,
    pub group: &'static str,
    pub label: String,
    pub description: String,
    /// `minutes`, `tokens` or `percent`.
    pub unit: Option<&'static str>,
    /// This Machine's alone: never shared with the Flock.
    pub machine: bool,
}

pub const HARNESS_NAMES: [&str; 4] = ["claude", "codex", "opencode", "pi"];

fn harness_title(harness: &str) -> &'static str {
    match harness {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        _ => "Pi",
    }
}

const NOTIFICATIONS: [(&str, &str, &str); 10] = [
    (
        "needs-you",
        "A Run needs you",
        "a Run stops to ask you something",
    ),
    ("run-done", "A Run finished", "a Run finishes well"),
    ("run-failed", "A Run failed", "a Run fails"),
    (
        "run-healed",
        "A Run was healed",
        "a Heal gets a parked Run moving before it needs you",
    ),
    (
        "mr-opened",
        "A merge request or pull request opened",
        "a Run opens a merge request or pull request",
    ),
    (
        "drift-unresolved",
        "Drift nobody settled",
        "a Run drifted from what it was asked and Collie could not correct it",
    ),
    (
        "correction-sent",
        "A correction was sent",
        "Collie corrects an agent by itself",
    ),
    (
        "proposal-pending",
        "Something waits for a yes",
        "something waits for your yes or no before anything else happens",
    ),
    (
        "slice-ready",
        "A slice to try",
        "a Run has a slice of work you can try",
    ),
    (
        "intent-changed",
        "The Intent changed",
        "a Run is given a new Intent",
    ),
];

struct Words {
    group: &'static str,
    label: String,
    description: String,
    unit: Option<&'static str>,
    machine: bool,
}

fn words(group: &'static str, label: impl Into<String>, description: impl Into<String>) -> Words {
    Words {
        group,
        label: label.into(),
        description: description.into(),
        unit: None,
        machine: false,
    }
}

impl Words {
    fn unit(mut self, unit: &'static str) -> Self {
        self.unit = Some(unit);
        self
    }
    fn machine(mut self) -> Self {
        self.machine = true;
        self
    }
}

fn of(key: impl Into<String>, kind: Kind, fallback: &str, w: Words) -> Setting {
    Setting {
        key: key.into(),
        kind,
        choices: Vec::new(),
        fallback: fallback.into(),
        group: w.group,
        label: w.label,
        description: w.description,
        unit: w.unit,
        machine: w.machine,
    }
}

fn choice(key: &str, choices: &[&str], fallback: &str, w: Words) -> Setting {
    Setting {
        choices: choices.iter().map(|c| c.to_string()).collect(),
        ..of(key, Kind::Choice, fallback, w)
    }
}

/// Every setting, in `src/settings.ts`'s order.
pub fn settings() -> Vec<Setting> {
    use Kind::*;
    let mut all = vec![
        choice(
            "harness",
            &HARNESS_NAMES,
            "claude",
            words(
                "Agents",
                "Harness",
                "The coding agent every step runs in, unless the step names its own.",
            ),
        ),
        of(
            "model",
            Text,
            "opus",
            words(
                "Agents",
                "Model",
                "The model every step's agent uses, unless the step names its own.",
            ),
        ),
        of(
            "effort",
            Text,
            "",
            words(
                "Agents",
                "Reasoning effort",
                "How hard every step's agent thinks, unless the step names its own. Unset leaves it to the harness.",
            ),
        ),
    ];
    for harness in HARNESS_NAMES {
        let title = harness_title(harness);
        all.push(of(
            format!("models.{harness}"),
            List,
            "",
            words(
                "Agents",
                format!("More {title} models"),
                format!(
                    "Model names {title} is allowed to run beyond the ones Collie knows, separated by commas."
                ),
            ),
        ));
    }
    all.extend([
        of(
            "fallbacks",
            List,
            "",
            words(
                "Agents",
                "Fall back to",
                "When the agent a step would run on has used up its subscription, the step runs on the first of these with usage left: a harness, or harness/model, in order. Empty keeps it waiting for the reset.",
            ),
        ),
        choice(
            "permissions",
            &["auto", "bypass", "harness"],
            "auto",
            words(
                "Agents",
                "Tool permissions",
                "Who decides whether an agent's tool call runs: the harness's own review (auto), no one (bypass), or a prompt in the agent's pane (harness).",
            ),
        ),
        choice(
            "trust",
            &["auto", "never"],
            "auto",
            words(
                "Agents",
                "Trust new folders",
                "Whether Collie trusts a folder the harness has not been trusted with yet (auto), or leaves the harness to ask (never).",
            ),
        ),
        of(
            "compact_at_tokens",
            Number,
            "150000",
            words(
                "Agents",
                "Compact at",
                "A reused agent whose context reaches this many tokens is asked to compact before its next piece of work. 0 turns compaction off.",
            )
            .unit("tokens"),
        ),
        of(
            "claude_auto_compact_window",
            Text,
            "400000",
            words(
                "Agents",
                "Claude Code's auto-compact window",
                "Where Claude Code compacts by itself: a whole number of tokens from 100000 to 1000000, or auto for the model's own window. Claude Code agents only, from the next one started.",
            )
            .unit("tokens"),
        ),
        choice(
            "terminal_backend",
            &["herdr", "core"],
            "herdr",
            words(
                "Agents",
                "Terminal backend",
                "Where this Machine starts its next agents: herdr, or herdr-core. Agents already running finish where they started. This Machine only.",
            )
            .machine(),
        ),
        of(
            "quiet_ms",
            Number,
            "600000",
            words(
                "Agents",
                "Quiet before a nudge",
                "An agent that produces nothing this long is nudged, nudged again at double and given up on at triple. 0 waits as long as it takes.",
            )
            .unit("minutes"),
        ),
        of(
            "idle_close_ms",
            Number,
            "3600000",
            words(
                "Agents",
                "Close an idle agent after",
                "An agent of a finished Run that has been idle this long since the Run finished is closed, unless something still needs it. 0 never closes one.",
            )
            .unit("minutes"),
        ),
        of(
            "agent_profile",
            Json,
            "",
            words(
                "Agents",
                "Agent profile",
                "Per role, or \"*\" for any role without its own: env for every harness, a value or {\"file\": \"<0600 path>\"}, and claude settings merged into Collie's own. Empty launches agents as Collie always has.",
            ),
        ),
        of(
            "claude_subagents",
            Json,
            "",
            words(
                "Agents",
                "Claude subagents",
                "Claude's nested agents: enabled, model, forceModel, cacheTtl (5m or 1h), maxDepth and maxConcurrent. Empty keeps native behavior.",
            ),
        ),
        of(
            "worktrees_directory",
            Text,
            "~/.collie/worktrees",
            words(
                "Runs",
                "Worktrees",
                "Where Collie makes a Run's checkout, under the repository's name and the branch's. A checkout made elsewhere before is found where it is. This Machine only.",
            )
            .machine(),
        ),
        of(
            "max_iterations",
            Number,
            "5",
            words(
                "Runs",
                "Rounds of review",
                "How many review-and-fix rounds a Run goes before it stops and asks you.",
            ),
        ),
        of(
            "handoff_timeout_ms",
            Number,
            "7200000",
            words(
                "Runs",
                "Wait for you",
                "How long a step waits for you after its agent hands off, before it gives up.",
            )
            .unit("minutes"),
        ),
        of(
            "memory_hold",
            Number,
            "10",
            words(
                "Runs",
                "Hold new work below free memory",
                "While available memory is under this percent of the Machine's total, or memory pressure is high, a new agent, Check pass or collie verify waits. 0 never holds, and turns the pressure rule off too.",
            )
            .unit("percent"),
        ),
        of(
            "recovery.resume",
            Boolean,
            "true",
            words(
                "Runs",
                "Resume cleared parks",
                "Whether the host resumes a parked Run once its read-only recheck clears. Off still records rechecks.",
            ),
        ),
        of(
            "recovery.heal",
            Boolean,
            "true",
            words(
                "Runs",
                "Heal parks before they need you",
                "Whether a park that needs you first gets one Heal: a Run of the healer workflow that may only message the parked Run's agents and resume it. Off sends the park to you at once.",
            ),
        ),
        of(
            "release.share_for_approval",
            Boolean,
            "false",
            words(
                "Runs",
                "Ask before sharing a merge request for approval",
                "Whether a release Run waiting on a teammate's approval asks you to post its merge request in the approval channel.",
            ),
        ),
        of(
            "release.approval_channel",
            Text,
            "",
            words(
                "Runs",
                "Slack channel for approval requests",
                "The Slack channel a release Run posts its merge request in for approval. Empty shares nothing. Earlier #names work until picked again.",
            ),
        ),
        of(
            "slack.notification_channel",
            Text,
            "",
            words(
                "Notifications",
                "Post notifications to",
                "The toasts you keep on also go to this Slack channel, posted as you. Empty keeps toasts only.",
            ),
        ),
        choice(
            "scope",
            &["local", "all"],
            "local",
            words(
                "Board",
                "Board scope",
                "Whether the TUI's board opens on this workspace's Runs (local) or every workspace's (all). Desktop's board is not changed.",
            ),
        ),
        choice(
            "density",
            &["comfortable", "compact"],
            "comfortable",
            words(
                "Board",
                "Card density",
                "How many cards the TUI's board fits across where its pane is wide enough. Desktop's board is not changed.",
            ),
        ),
        of(
            "board_quiet_ms",
            Number,
            "300000",
            words(
                "Board",
                "Quiet Run",
                "How long a running Run may write nothing before its card calls it quiet.",
            )
            .unit("minutes"),
        ),
        of(
            "run_model",
            Boolean,
            "true",
            words(
                "Board",
                "Run model",
                "Whether the host keeps every Run in memory and serves the board from it. Off reads every Run from disk on each change, as before. Read when the host starts.",
            ),
        ),
        of(
            "flock_chat.proactive",
            Boolean,
            "true",
            words(
                "Chat",
                "Flock chat speaks first",
                "Whether the Flock chat starts a turn about News that matters, as the bell in its header does.",
            ),
        ),
        of(
            "machine_rule",
            Text,
            "",
            words(
                "Chat",
                "Machine rule",
                "Which Machine each kind of work goes to, in your own words. The Flock chat starts work where it says, and asks where it does not say.",
            ),
        ),
        of(
            "standing_direction",
            Text,
            "",
            words(
                "Chat",
                "Standing direction",
                "What every chat keeps of how you like to work, in your own words, up to 4,000 characters. It goes with every message as something you said earlier, never as your go.",
            ),
        ),
        of(
            "proactive",
            Boolean,
            "true",
            words(
                "Chat",
                "Native chat speaks first",
                "Whether each Machine's Native chat starts a turn when a Run stops, asks or goes round. The Flock chat has its own switch.",
            ),
        ),
        choice(
            "questions",
            &["focus", "notify"],
            "focus",
            words(
                "Notifications",
                "A new question",
                "Left over from the TUI's Collie tab, which a question once brought to the front; changes nothing.",
            ),
        ),
    ]);
    for (kind, label, when) in NOTIFICATIONS {
        all.push(of(
            format!("notifications.{kind}"),
            Boolean,
            "true",
            words("Notifications", label, format!("A toast when {when}.")),
        ));
    }
    all.push(of(
        "gitlab_host",
        Text,
        "gitlab.cego.dk",
        words(
            "GitLab and credentials",
            "GitLab host",
            "The GitLab every Machine is onboarded and checked against, and the one its token is made on.",
        ),
    ));
    all
}

pub fn setting_of(key: &str) -> Option<Setting> {
    settings().into_iter().find(|s| s.key == key)
}

fn per(key: &str) -> Option<f64> {
    setting_of(key)
        .filter(|s| s.unit == Some("minutes"))
        .map(|_| 60_000.0)
}

fn number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// A stored value as typed in its unit: a duration in minutes, decimals only where needed.
pub fn shown(key: &str, stored: &str) -> String {
    match (per(key), stored.trim().parse::<f64>()) {
        (Some(per), Ok(ms)) if !stored.trim().is_empty() => number(ms / per),
        _ => stored.to_string(),
    }
}

/// What is typed in a row's unit, as the text the core's check takes: minutes as whole
/// milliseconds. Anything else goes as typed, for the core to accept or refuse.
pub fn stored(key: &str, typed: &str) -> String {
    let said = typed.trim();
    match (per(key), said.parse::<f64>()) {
        (Some(per), Ok(minutes)) if minutes.is_finite() && minutes >= 0.0 => {
            number((minutes * per).round())
        }
        _ => said.to_string(),
    }
}

/// A held value as one line of text, as `settingText` writes it.
pub fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map(number).unwrap_or_else(|| n.to_string()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(", "),
        Some(Value::Object(_)) => String::new(),
    }
}
