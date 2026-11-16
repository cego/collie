//! What the Flow's inspector says of a Step: its facts, its timing, its notes, and which part
//! of its work it opens on. Copies of `inspectorOf` in `flow.ts`, `step-inspector.ts`,
//! `step-timing.ts` and `step-steering.ts`, which stay their owners.

use crate::record::when::{epoch_ms, minutes};
use collie_desktop_protocol::generated::{
    Agent, GlyphState, Node, NodeKind, NodeRun, Note, Place, Produces, Review, Verification, Wait,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Decision,
    Terminal,
    Why,
    Evidence,
    Log,
    Details,
}

fn open_question(node: &NodeRun) -> bool {
    node.questions
        .iter()
        .any(|q| q.open.unwrap_or(q.answered.is_none()))
}

/// The part a Step opens on: what it asks, its live work, why it failed, its proof, its log.
pub fn inspector_part(node: &NodeRun, live: bool) -> Part {
    if node.wait == Some(Wait::Proposal) || open_question(node) {
        return Part::Decision;
    }
    if live
        && (node.state == GlyphState::Running
            || matches!(node.wait, Some(Wait::Stalled | Wait::Parked | Wait::Usage)))
    {
        return Part::Terminal;
    }
    if node.state == GlyphState::Failed {
        return Part::Why;
    }
    if node.kind == NodeKind::Check || node.produces == Some(Produces::Evidence) {
        return Part::Evidence;
    }
    if node.log.flatten().is_none() {
        Part::Details
    } else {
        Part::Log
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartTab {
    pub value: Part,
    pub label: String,
}

/// Whether a Step's agent's terminal can be shown: its Machine is reached and the card lists its
/// agent, as `live` in `StepWork.vue`.
pub fn step_live(node: &NodeRun, reached: bool, agents: &[Agent]) -> bool {
    let agent = node.agent.clone().flatten();
    reached && agent.is_some_and(|agent| agents.iter().any(|one| one.name == agent))
}

/// Whether a Step is still at its work, so its agent's pane is drawn in its Terminal part.
pub fn at_work(node: &NodeRun) -> bool {
    matches!(
        node.state,
        GlyphState::Running | GlyphState::NeedsYou | GlyphState::Waiting
    )
}

pub fn inspector_parts(node: &NodeRun, live: bool, logs: usize, proofs: usize) -> Vec<PartTab> {
    let mut parts = Vec::new();
    if live {
        parts.push(PartTab {
            value: Part::Terminal,
            label: "Terminal".into(),
        });
    }
    if node.log.flatten().is_some() {
        parts.push(PartTab {
            value: Part::Log,
            label: format!("Log · {logs}"),
        });
    }
    if proofs > 0 {
        parts.push(PartTab {
            value: Part::Evidence,
            label: format!("Evidence · {proofs}"),
        });
    }
    parts
}

pub fn shown_part(chosen: Part, parts: &[PartTab]) -> Part {
    if parts.iter().any(|p| p.value == chosen) {
        chosen
    } else {
        parts.first().map_or(chosen, |p| p.value)
    }
}

pub fn quiet_work(node: &NodeRun) -> &'static str {
    if node.state == GlyphState::Expected {
        "This Step has not started yet."
    } else {
        "This Step left no terminal, log or evidence to show here."
    }
}

/// A Step's lines of the Run's log: from its start to the next Step's, of the tail shown.
#[derive(Debug, Clone, PartialEq)]
pub struct StepLog {
    pub text: Option<String>,
    pub count: usize,
    pub older: Option<&'static str>,
}

pub fn step_lines(
    tail: Option<&Review>,
    first: i64,
    start: Option<i64>,
    starts: &[i64],
) -> StepLog {
    let (Some(Review::Text(tail)), Some(start)) = (tail, start) else {
        return StepLog {
            text: None,
            count: 0,
            older: None,
        };
    };
    let all: Vec<&str> = if tail.text.is_empty() {
        Vec::new()
    } else {
        tail.text
            .strip_suffix('\n')
            .unwrap_or(&tail.text)
            .split('\n')
            .collect()
    };
    let next = starts.iter().copied().filter(|l| *l > start).min();
    let from = (start - first).max(0) as usize;
    let to = next.map_or(all.len(), |n| (n - first).max(0) as usize);
    let lines: Vec<&str> = all
        .get(from.min(all.len())..to.min(all.len()).max(from.min(all.len())))
        .unwrap_or(&[])
        .to_vec();
    StepLog {
        text: Some(if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        }),
        count: lines.len(),
        older: (first > start).then_some("Earlier lines are older than the log shown."),
    }
}

/// The checks recorded for a Step, and for one item or round of it where one is picked.
pub fn step_evidence<'a>(
    checks: &'a [Verification],
    step: &str,
    picked: Option<&NodeRun>,
) -> Vec<&'a Verification> {
    checks
        .iter()
        .filter(|one| {
            if one.step.clone().flatten().as_deref() != Some(step) {
                return false;
            }
            let Some(picked) = picked else { return true };
            let place = one.place.clone().flatten().map(|place| match place {
                Place::Place0(p) => format!("Round {}", p.round),
                Place::Place1(p) => p.item,
            });
            place == picked.place
        })
        .collect()
}

/// How long a Step has run, took, or usually takes.
pub fn step_timing(node: &NodeRun, runs: &[NodeRun], now: f64) -> Option<String> {
    let usual = node.usual.flatten();
    let Some(started) = &node.started else {
        return usual.map(|u| format!("usually {}", minutes(u)));
    };
    let elapsed = match &node.ended {
        None => {
            let active = runs
                .iter()
                .rev()
                .find(|r| r.state == GlyphState::Running)
                .and_then(|r| r.started.as_deref())
                .unwrap_or(started);
            let since = epoch_ms(active).map_or(0.0, |at| (now - at).max(0.0));
            format!("{} so far", minutes(since))
        }
        Some(ended) => {
            let took = epoch_ms(ended)
                .zip(epoch_ms(started))
                .map_or(0.0, |(e, s)| e - s);
            format!("{} total", minutes(took))
        }
    };
    Some(match usual {
        None => elapsed,
        Some(u) => {
            let usually = minutes(u);
            format!(
                "{elapsed}, usually {}",
                usually.strip_suffix(" min").unwrap_or(&usually)
            )
        }
    })
}

fn is_duration(part: &str) -> bool {
    if part == "under a minute" {
        return true;
    }
    let words: Vec<&str> = part.split(' ').collect();
    let num = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    matches!(words.as_slice(), [n, "min"] | [n, "h"] if num(n))
        || matches!(words.as_slice(), [h, "h", m, "min"] if num(h) && num(m))
}

/// The host's words for a Step, less what its timing and warning already say.
pub fn status_of(node: &NodeRun, timing: Option<&str>) -> Option<String> {
    let long = node.long.flatten().unwrap_or(false);
    let said = node.said.clone().unwrap_or_default();
    let parts: Vec<&str> = said
        .split(" · ")
        .filter(|p| !p.is_empty() && !is_duration(p) && !(long && *p == "Longer than usual"))
        .chain(timing)
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    pub label: String,
    pub value: String,
}

pub fn facts_of(node: &NodeRun, when: impl Fn(&str) -> String) -> Vec<Fact> {
    let fact = |label: &str, value: Option<String>| {
        value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .map(|value| Fact {
                label: label.into(),
                value,
            })
    };
    let mut facts: Vec<Fact> = [
        fact("Role", node.role.clone()),
        fact("Agent", node.agent.clone().flatten()),
        fact("Model", node.ran_on.clone()),
        node.started
            .as_deref()
            .and_then(|at| fact("Started", Some(when(at)))),
        node.ended
            .as_deref()
            .and_then(|at| fact("Ended", Some(when(at)))),
    ]
    .into_iter()
    .flatten()
    .collect();
    for (i, attempt) in node.attempts.iter().enumerate().skip(1) {
        let cause = match &attempt.cause {
            Some(c) => crate::flow::written(c),
            None => "retried".into(),
        };
        facts.push(Fact {
            label: format!("Attempt {}", i + 1),
            value: format!("{cause} · {}", when(&attempt.at)),
        });
    }
    for q in &node.questions {
        if let Some(answered) = &q.answered {
            let by =
                q.by.as_ref()
                    .map(|b| format!(" by {b}"))
                    .unwrap_or_default();
            facts.push(Fact {
                label: "Answered".into(),
                value: format!("{}{by}", when(answered)),
            });
        }
    }
    facts
}

pub struct Steering {
    pub pause: Option<String>,
    pub badge: Option<String>,
    pub notes: Vec<Note>,
    pub retry_text: String,
}

pub fn step_steering(node: &NodeRun) -> Steering {
    let notes = node.notes.clone().flatten().unwrap_or_default();
    let unread = notes.iter().filter(|n| n.read.is_none()).count();
    Steering {
        pause: node
            .pause
            .clone()
            .flatten()
            .map(|p| format!("Pauses before {}, as {} asked", node.title, p.by)),
        badge: (unread > 0)
            .then(|| format!("{unread} {}", if unread == 1 { "note" } else { "notes" })),
        notes,
        retry_text: node.why.clone().flatten().unwrap_or_default(),
    }
}

/// A Step's runs and links, which the inspector lists under it.
pub fn entries_of(node: &Node) -> Vec<NodeRun> {
    node.runs
        .iter()
        .cloned()
        .chain(node.links.clone().flatten().unwrap_or_default())
        .collect()
}
