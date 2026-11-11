//! What a Step's and a lane's actions are called and what each does: a copy of
//! `desktop/src/shared/flow-actions.ts`, which stays their owner.

use collie_desktop_protocol::generated::{
    ActPayloadAction, Answer, AnswerTag, Confirm, ConfirmTag, Control, ControlControl, ControlTag,
    Decline, DeclineTag, Deliver, DeliverTag, DetailFlow, FollowUp, FollowUpTag, GlyphState, Lane,
    LaneAction, Node, NodeRun, Primary, Proposal, QuestionOption, Resume, ResumeTag, Revision,
};

/// A Step as its inspector acts on it: a lane's node, or one of its runs.
pub fn as_run(node: &Node) -> NodeRun {
    let value = serde_json::to_value(node).unwrap_or_default();
    serde_json::from_value(value).expect("a node is a run with more fields")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    pub run: String,
    pub id: String,
    pub step: String,
    pub text: String,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Write(ActPayloadAction),
    Text {
        write: ActPayloadAction,
        initial: Option<String>,
        /// The Run resumed once the note is delivered.
        retry: Option<String>,
        /// The note this one replaces.
        withdraw: Option<String>,
    },
    Answer(Question),
    Proposal(Proposal),
    Terminal {
        run: String,
        agent: String,
    },
    Part {
        run: String,
        part: &'static str,
    },
    Url(String),
    Run {
        run: String,
        machine: Option<String>,
    },
    Offer {
        run: String,
        offer: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionView {
    pub label: String,
    pub tone: Tone,
    pub caption: Option<String>,
    pub effect: Effect,
}

fn shown(label: impl Into<String>, effect: Effect) -> Option<ActionView> {
    Some(ActionView {
        label: label.into(),
        tone: Tone::Neutral,
        caption: None,
        effect,
    })
}

/// A hold or a note with the record revision it was pressed at, which the host checks.
pub fn shown_at(action: ActPayloadAction, revision: Option<&Revision>) -> ActPayloadAction {
    match (action, revision) {
        (ActPayloadAction::Control(c), Some(r)) => ActPayloadAction::Control(Control {
            shown: Some(r.clone()),
            ..c
        }),
        (ActPayloadAction::Deliver(d), Some(r)) => ActPayloadAction::Deliver(Deliver {
            shown: Some(r.clone()),
            ..d
        }),
        (action, _) => action,
    }
}

pub fn control(
    run: &str,
    control: ControlControl,
    set: bool,
    before: Option<String>,
) -> ActPayloadAction {
    ActPayloadAction::Control(Control {
        tag: ControlTag::Control,
        run_id: run.into(),
        control,
        set,
        reason: None,
        before: before.map(Some),
        shown: None,
    })
}

pub fn deliver(
    run: &str,
    step: Option<String>,
    agent: Option<String>,
    to: Option<String>,
    text: &str,
) -> ActPayloadAction {
    ActPayloadAction::Deliver(Deliver {
        tag: DeliverTag::Deliver,
        run_id: run.into(),
        step: step.map(Some),
        agent,
        to,
        text: text.into(),
        shown: None,
    })
}

pub fn resume(run: &str) -> ActPayloadAction {
    ActPayloadAction::Resume(Resume {
        tag: ResumeTag::Resume,
        run_id: run.into(),
    })
}

/// The text a form writes into its action.
pub fn with_text(action: &ActPayloadAction, text: &str) -> ActPayloadAction {
    match action.clone() {
        ActPayloadAction::Deliver(d) => ActPayloadAction::Deliver(Deliver {
            text: text.into(),
            ..d
        }),
        ActPayloadAction::FollowUp(f) => ActPayloadAction::FollowUp(FollowUp {
            text: text.into(),
            ..f
        }),
        ActPayloadAction::Answer(a) => ActPayloadAction::Answer(Answer {
            value: text.into(),
            ..a
        }),
        other => other,
    }
}

pub fn answer(run: &str, decision: &str, value: &str) -> ActPayloadAction {
    ActPayloadAction::Answer(Answer {
        tag: AnswerTag::Answer,
        run_id: run.into(),
        decision: Some(decision.into()),
        value: value.into(),
    })
}

pub fn confirm(proposal: &Proposal) -> ActPayloadAction {
    ActPayloadAction::Confirm(Confirm {
        tag: ConfirmTag::Confirm,
        proposal: proposal.id.clone(),
        hash: proposal.hash.clone(),
    })
}

pub fn decline(proposal: &Proposal) -> ActPayloadAction {
    ActPayloadAction::Decline(Decline {
        tag: DeclineTag::Decline,
        proposal: proposal.id.clone(),
        hash: proposal.hash.clone(),
    })
}

pub fn retry_caption(lane: &Lane, node: &NodeRun) -> String {
    let kept: Vec<&str> = lane
        .nodes
        .iter()
        .filter(|one| one.state == GlyphState::Done && one.id != node.id)
        .map(|one| one.title.as_str())
        .collect();
    if kept.is_empty() {
        return format!("Runs {} again.", node.title);
    }
    let names = if kept.len() > 3 {
        format!("{} and {} more", kept[0], kept.len() - 1)
    } else {
        kept.join(" and ")
    };
    format!("Keeps {names} and runs {} again.", node.title)
}

pub fn flow_action(kind: &Primary, node: &NodeRun, lane: &Lane, live: bool) -> Option<ActionView> {
    let primary = node.primary.clone().flatten();
    let listed = node.actions.as_ref().is_some_and(|a| a.contains(kind));
    if !live || (primary.as_ref() != Some(kind) && !listed) {
        return None;
    }
    let run = lane.run.as_str();
    let step_id = lane
        .nodes
        .iter()
        .find(|one| one.id == node.id || one.runs.iter().any(|r| r.id == node.id))
        .map_or(node.id.clone(), |one| one.id.clone());
    let role = node.role.clone().unwrap_or_else(|| "agent".into());
    let agent = node.agent.clone().flatten();
    let link = node.link.clone().flatten();
    match kind {
        Primary::Pause => {
            let wanted = node.pause_target.clone().flatten();
            let target = lane.nodes.iter().find(|one| {
                one.id == wanted.clone().unwrap_or_else(|| step_id.clone())
                    || one.runs.iter().any(|r| Some(&r.id) == wanted.as_ref())
            });
            let (id, title, paused) = match target {
                Some(t) => (
                    t.id.clone(),
                    t.title.clone(),
                    t.pause.clone().flatten().is_some(),
                ),
                None => (
                    node.id.clone(),
                    node.title.clone(),
                    node.pause.clone().flatten().is_some(),
                ),
            };
            let label = if paused {
                "Don't pause".into()
            } else {
                format!("Pause before {title}")
            };
            shown(
                label,
                Effect::Write(control(run, ControlControl::Hold, !paused, Some(id))),
            )
        }
        Primary::Note | Primary::RetryNoted => {
            let noted = *kind == Primary::RetryNoted;
            shown(
                if noted {
                    "Retry with a note…".into()
                } else {
                    format!("Note for {}…", node.title)
                },
                Effect::Text {
                    write: deliver(run, Some(step_id), None, None, ""),
                    initial: noted.then(|| node.why.clone().flatten().unwrap_or_default()),
                    retry: noted.then(|| run.to_string()),
                    withdraw: None,
                },
            )
        }
        Primary::Log => shown(
            "Log",
            Effect::Part {
                run: run.into(),
                part: "log",
            },
        ),
        Primary::Evidence => shown(
            "Evidence",
            Effect::Part {
                run: run.into(),
                part: "evidence",
            },
        ),
        Primary::Retry => Some(ActionView {
            label: format!("Retry {}", node.title),
            tone: Tone::Error,
            caption: Some(retry_caption(lane, node)),
            effect: Effect::Write(resume(
                link.as_ref().and_then(|l| l.run.as_deref()).unwrap_or(run),
            )),
        }),
        Primary::Continue => shown(
            "Continue",
            Effect::Write(control(run, ControlControl::Hold, false, None)),
        ),
        Primary::Tell => shown(
            format!("Tell the {role}…"),
            Effect::Text {
                write: deliver(run, None, Some(agent?), None, ""),
                initial: None,
                retry: None,
                withdraw: None,
            },
        ),
        Primary::Terminal => shown(
            format!("Watch the {role}"),
            Effect::Terminal {
                run: run.into(),
                agent: agent?,
            },
        ),
        Primary::Answer => {
            let asked = node
                .questions
                .iter()
                .find(|q| q.id.is_some() && q.open.unwrap_or(q.answered.is_none()))?;
            Some(ActionView {
                label: "Answer".into(),
                tone: Tone::Warning,
                caption: None,
                effect: Effect::Answer(Question {
                    run: run.into(),
                    id: asked.id.clone()?,
                    step: node.title.clone(),
                    text: asked
                        .text
                        .clone()
                        .flatten()
                        .unwrap_or_else(|| asked.name.clone()),
                    options: asked.options.clone().flatten().unwrap_or_default(),
                }),
            })
        }
        Primary::Proposal => Some(ActionView {
            label: "Review".into(),
            tone: Tone::Warning,
            caption: None,
            effect: Effect::Proposal(node.proposal.clone().flatten()?),
        }),
        Primary::Open => {
            if let Some(linked) = link.as_ref().and_then(|l| l.run.clone()) {
                return shown(
                    format!("Open {}", node.title),
                    Effect::Run {
                        run: linked,
                        machine: link.and_then(|l| l.machine),
                    },
                );
            }
            let url = node.url.clone().flatten()?;
            shown(
                if node.id == "ci" {
                    "Open pipeline"
                } else {
                    "Open MR"
                },
                Effect::Url(url),
            )
        }
        Primary::Start => shown(
            node.title.clone(),
            Effect::Offer {
                run: run.into(),
                offer: node.id.strip_prefix("offer:").unwrap_or(&node.id).into(),
            },
        ),
    }
}

/// The Step's primary action first, then the rest it lists, each once.
pub fn step_actions(node: &NodeRun, lane: &Lane, live: bool) -> Vec<ActionView> {
    let mut kinds: Vec<Primary> = node.primary.clone().flatten().into_iter().collect();
    for kind in node.actions.clone().unwrap_or_default() {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
        .iter()
        .filter_map(|kind| flow_action(kind, node, lane, live))
        .collect()
}

pub fn lane_action(kind: &LaneAction, lane: &Lane, live: bool) -> Option<ActionView> {
    if !live || !lane.actions.as_ref().is_some_and(|a| a.contains(kind)) {
        return None;
    }
    let run = lane.run.as_str();
    match kind {
        LaneAction::Hold => shown(
            "Hold run",
            Effect::Write(control(run, ControlControl::Hold, true, None)),
        ),
        LaneAction::Release => shown(
            "Release hold",
            Effect::Write(control(run, ControlControl::Hold, false, None)),
        ),
        LaneAction::Stop => shown(
            "Stop run",
            Effect::Write(control(run, ControlControl::Stop, true, None)),
        ),
        LaneAction::Resume => shown("Resume", Effect::Write(resume(run))),
        LaneAction::FollowUp => shown(
            "Follow-up run",
            Effect::Text {
                write: ActPayloadAction::FollowUp(FollowUp {
                    tag: FollowUpTag::FollowUp,
                    run_id: run.into(),
                    text: String::new(),
                }),
                initial: None,
                retry: None,
                withdraw: None,
            },
        ),
    }
}

pub fn lane_actions(lane: &Lane, live: bool) -> Vec<ActionView> {
    lane.actions
        .clone()
        .unwrap_or_default()
        .iter()
        .filter_map(|kind| lane_action(kind, lane, live))
        .collect()
}

/// The Flow's next move: the current Step's primary action, with the Flow's notice.
pub struct NextMove<'a> {
    pub lane: &'a Lane,
    pub node: &'a Node,
    pub action: Primary,
    pub notice: Option<String>,
}

pub fn next_move(flow: &DetailFlow) -> Option<NextMove<'_>> {
    let current = flow.current.as_ref()?;
    let lane = flow.lanes.iter().find(|l| l.run == current.run)?;
    let node = lane.nodes.iter().find(|n| n.id == current.node)?;
    Some(NextMove {
        lane,
        node,
        action: node.primary.clone().flatten()?,
        notice: flow.notice.clone().flatten(),
    })
}
