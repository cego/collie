//! One question as a questionnaire: what is checked, what Submit and the steering entry send,
//! and the status line. `desktop/src/shared/questionnaire.ts` stays its owner.

use collie_desktop_protocol::generated::Question;
use serde_json::{Value, json};

/// The row id of Hold the Run, which no host option can take.
pub const HOLD: &str = "\u{0}hold";

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Open,
    Sending,
    Answered(String),
    Held,
    Steered,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub request: String,
    pub sends: String,
    /// The value answered, or none for a steer.
    pub answer: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Questionnaire {
    pub question: Question,
    pub checked: Option<String>,
    pub focus: usize,
    /// A value input's words.
    pub typed: String,
    pub draft: String,
    pub pending: Option<Pending>,
    pub status: Status,
    pub on_board: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Where {
    Group,
    Steer,
    Answer,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Seen(Option<Box<Question>>),
    Pick(String),
    Key {
        key: String,
        r#mod: bool,
        at: Where,
    },
    Type(String),
    Draft(String),
    Submit(String),
    Steer(String),
    Trying(String),
    Replied {
        request: String,
        outcome: Result<(), (bool, String)>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Does {
    /// An `act` action to send under `request`.
    Send {
        request: String,
        action: Value,
    },
    Submit,
    Steer,
    Close,
    Swallow,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    pub title: String,
    pub detail: Option<String>,
    pub recommended: bool,
    pub disabled: bool,
    pub why: Option<String>,
}

pub fn rows_of(question: &Question) -> Vec<Row> {
    let mut rows: Vec<Row> = question
        .options
        .iter()
        .map(|o| Row {
            id: o.id.clone(),
            title: o.title.clone(),
            detail: o.detail.clone().or_else(|| o.subtitle.clone()),
            recommended: o.recommended == Some(true),
            disabled: false,
            why: None,
        })
        .collect();
    if let Some(hold) = &question.hold
        && !question.options.is_empty()
    {
        rows.push(Row {
            id: HOLD.into(),
            title: "Hold the Run".into(),
            detail: Some("Answers nothing; the question stays open until you release.".into()),
            recommended: false,
            disabled: !hold.offered,
            why: hold.why.clone(),
        });
    }
    rows
}

impl Questionnaire {
    pub fn new(question: Question) -> Questionnaire {
        Questionnaire {
            question,
            checked: None,
            focus: 0,
            typed: String::new(),
            draft: String::new(),
            pending: None,
            status: Status::Open,
            on_board: true,
        }
    }

    fn in_flight(&self) -> bool {
        self.status == Status::Sending
    }

    fn settled(&self) -> bool {
        !self.on_board || matches!(self.status, Status::Answered(_))
    }

    fn submission(&self) -> Option<String> {
        if self.in_flight() || self.settled() {
            return None;
        }
        if self.question.options.is_empty() {
            let words = self.typed.trim();
            return (!words.is_empty()).then(|| words.to_string());
        }
        self.checked.clone()
    }

    /// The agent steering redirects: absent where the question says nothing of one.
    fn target(&self) -> (Option<Option<String>>, Option<String>) {
        match &self.question.steer {
            None => (None, None),
            Some(steer) => (Some(steer.agent.clone()), steer.why.clone()),
        }
    }

    fn steerable(&self) -> bool {
        !self.in_flight()
            && !self.settled()
            && !matches!(self.target().0, Some(None))
            && !self.draft.trim().is_empty()
    }

    fn sent(&mut self, sends: String, answer: Option<String>, request: String) -> String {
        let kept = match &self.pending {
            Some(p) if p.sends == sends => p.request.clone(),
            _ => request,
        };
        self.pending = Some(Pending {
            request: kept.clone(),
            sends,
            answer,
        });
        self.status = Status::Sending;
        kept
    }

    fn action_for(&self, value: &str) -> Value {
        let run = &self.question.run;
        if value == HOLD {
            json!({"_tag": "Control", "runId": run, "control": "hold", "set": true,
                "reason": format!("held at question {}", self.question.id)})
        } else {
            json!({"_tag": "Answer", "runId": run, "decision": self.question.id, "value": value})
        }
    }

    fn title_of(&self, value: &str) -> String {
        self.question
            .options
            .iter()
            .find(|o| o.id == value)
            .map_or_else(|| value.to_string(), |o| o.title.clone())
    }

    fn moved(&mut self, to: impl Fn(&[Row], usize) -> usize) {
        let rows = rows_of(&self.question);
        if rows.iter().all(|r| r.disabled) {
            return;
        }
        let from = rows
            .iter()
            .position(|r| Some(&r.id) == self.checked.as_ref())
            .unwrap_or(self.focus);
        let at = to(&rows, from);
        self.checked = Some(rows[at].id.clone());
        self.focus = at;
    }

    fn keyed(&mut self, key: &str, r#mod: bool, at: Where) -> Option<Does> {
        if key == "Escape" {
            return Some(Does::Close);
        }
        if at == Where::Steer {
            return (key == "Enter").then(|| {
                if r#mod && self.steerable() {
                    Does::Steer
                } else {
                    Does::Swallow
                }
            });
        }
        if key == "Enter" {
            return ((r#mod || at == Where::Answer) && self.submission().is_some())
                .then_some(Does::Submit);
        }
        if at == Where::Answer || self.in_flight() || self.settled() {
            return None;
        }
        let step = |by: isize| {
            move |rows: &[Row], from: usize| {
                let n = rows.len() as isize;
                let mut at = from as isize;
                loop {
                    at = (at + by + n) % n;
                    if !rows[at as usize].disabled {
                        return at as usize;
                    }
                }
            }
        };
        match key {
            "ArrowDown" | "ArrowRight" => self.moved(step(1)),
            "ArrowUp" | "ArrowLeft" => self.moved(step(-1)),
            "Home" => self.moved(|rows, _| rows.iter().position(|r| !r.disabled).unwrap_or(0)),
            "End" => self.moved(|rows, _| rows.iter().rposition(|r| !r.disabled).unwrap_or(0)),
            " " => {
                if let Some(row) = rows_of(&self.question).get(self.focus)
                    && !row.disabled
                {
                    self.checked = Some(row.id.clone());
                }
            }
            _ => {}
        }
        None
    }

    fn seen(&mut self, question: Option<Question>) {
        let Some(question) = question else {
            self.on_board = false;
            return;
        };
        if question.run != self.question.run || question.id != self.question.id {
            *self = Questionnaire::new(question);
            return;
        }
        let rows = rows_of(&question);
        let kept = rows
            .iter()
            .any(|r| Some(&r.id) == self.checked.as_ref() && !r.disabled);
        self.question = question;
        self.on_board = true;
        if !kept {
            self.checked = None;
        }
        self.focus = self.focus.min(rows.len().saturating_sub(1));
    }

    /// This questionnaire after one event, and what that event asks Desktop to do.
    pub fn step(&mut self, event: Event) -> Option<Does> {
        match event {
            Event::Seen(question) => {
                self.seen(question.map(|q| *q));
                None
            }
            Event::Pick(id) => {
                let rows = rows_of(&self.question);
                if let Some(at) = rows.iter().position(|r| r.id == id)
                    && !rows[at].disabled
                    && !self.in_flight()
                    && !self.settled()
                {
                    self.checked = Some(id);
                    self.focus = at;
                }
                None
            }
            Event::Key { key, r#mod, at } => self.keyed(&key, r#mod, at),
            Event::Type(text) => {
                self.typed = text;
                None
            }
            Event::Draft(text) => {
                self.draft = text;
                None
            }
            Event::Submit(request) => {
                let value = self.submission()?;
                let action = self.action_for(&value);
                let request = self.sent(format!("answer:{value}"), Some(value), request);
                Some(Does::Send { request, action })
            }
            Event::Steer(request) => {
                if !self.steerable() {
                    return None;
                }
                let text = self.draft.trim().to_string();
                let request = self.sent(format!("steer:{text}"), None, request);
                let run = &self.question.run;
                let action = match self.target().0.flatten() {
                    Some(agent) => {
                        json!({"_tag": "Deliver", "runId": run, "agent": agent, "text": text})
                    }
                    None => json!({"_tag": "Deliver", "runId": run, "text": text}),
                };
                Some(Does::Send { request, action })
            }
            Event::Trying(request) => {
                if self.pending.as_ref().is_some_and(|p| p.request == request) {
                    self.status = Status::Sending;
                }
                None
            }
            Event::Replied { request, outcome } => {
                let pending = self.pending.clone().filter(|p| p.request == request)?;
                match outcome {
                    Err((refused, reason)) => {
                        if refused {
                            self.pending = None;
                        }
                        self.status = Status::Failed(reason);
                    }
                    Ok(()) => {
                        self.pending = None;
                        match pending.answer {
                            None => {
                                self.draft.clear();
                                self.status = Status::Steered;
                            }
                            Some(answer) if answer == HOLD => self.status = Status::Held,
                            Some(answer) => self.status = Status::Answered(self.title_of(&answer)),
                        }
                    }
                }
                None
            }
        }
    }

    pub fn view(&self) -> QuestionnaireView {
        let (agent, why) = self.target();
        let status = match &self.status {
            Status::Open => (!self.on_board).then(|| "No longer open".to_string()),
            Status::Sending => Some("Sending…".into()),
            Status::Answered(title) => Some(format!("Answered: {title}")),
            Status::Held => Some(if self.on_board {
                "Run held · question still open".into()
            } else {
                "No longer open".into()
            }),
            Status::Steered => Some(format!(
                "Sent to {}; the question is set aside",
                agent
                    .clone()
                    .flatten()
                    .unwrap_or_else(|| "the Run's agent".into())
            )),
            Status::Failed(reason) => Some(reason.clone()),
        };
        QuestionnaireView {
            text: self.question.text.clone(),
            shortfall: self.question.shortfall.clone(),
            words: self.question.options.is_empty(),
            rows: rows_of(&self.question)
                .into_iter()
                .map(|r| {
                    let checked = Some(&r.id) == self.checked.as_ref();
                    (r, checked)
                })
                .collect(),
            focus: self.focus,
            typed: self.typed.clone(),
            submit: self.submission().is_some(),
            steer_disabled: matches!(agent, Some(None)),
            steer_why: why,
            steer_send: self.steerable(),
            steer_label: match agent.flatten() {
                Some(agent) => format!("Send to {agent}"),
                None => "Send".into(),
            },
            status,
            sending: self.in_flight(),
            settled: self.settled() && !self.in_flight(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionnaireView {
    pub text: String,
    pub shortfall: Option<String>,
    /// A value input: a text answer instead of rows.
    pub words: bool,
    pub rows: Vec<(Row, bool)>,
    pub focus: usize,
    pub typed: String,
    pub submit: bool,
    pub steer_disabled: bool,
    pub steer_why: Option<String>,
    pub steer_send: bool,
    pub steer_label: String,
    pub status: Option<String>,
    pub sending: bool,
    /// Answered, or gone from the board: nothing more to send.
    pub settled: bool,
}
