//! A card's questions and the answers in flight: `desktop/src/shared/pending-answer.ts`,
//! which stays its owner.

use collie_desktop_protocol::generated::{Decision, Question, Task};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct InFlight {
    /// The option's title or the typed value.
    pub shown: String,
    pub machine: String,
    /// Whether the host has replied that it took it.
    pub confirmed: bool,
    /// Which send this is, so a try of one a newer answer replaced changes nothing.
    pub send: u64,
}

/// View-wide, by `answer_key`; nothing here is written to a host.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Answering {
    pub answers: HashMap<String, InFlight>,
    pub latest: HashMap<String, u64>,
}

pub fn answer_key(installation: &str, run: &str, question: &str) -> String {
    format!("{installation}\u{0}{run}\u{0}{question}")
}

impl Answering {
    /// A new answer to a question, sending, which replaces any earlier one to it.
    pub fn sent(&mut self, key: &str, shown: String, machine: String, send: u64) {
        self.answers.insert(
            key.into(),
            InFlight {
                shown,
                machine,
                confirmed: false,
                send,
            },
        );
        self.latest.insert(key.into(), send);
    }

    /// A try of send `send` starting (`None`), confirmed, or failed.
    pub fn tried(&mut self, key: &str, send: u64, done: Option<bool>) {
        if self.latest.get(key) != Some(&send) {
            return;
        }
        match done {
            Some(false) => {
                self.answers.remove(key);
            }
            _ => {
                if let Some(one) = self.answers.get_mut(key) {
                    one.confirmed = done == Some(true);
                }
            }
        }
    }

    /// Drops what is held for each question no Task on the Flock's board has open.
    pub fn settled<'a>(&mut self, board: impl IntoIterator<Item = (&'a str, &'a Task)>) {
        let open: Vec<String> = board
            .into_iter()
            .flat_map(|(installation, task)| {
                open_questions(task)
                    .into_iter()
                    .map(move |q| answer_key(installation, &q.run, &q.id))
            })
            .collect();
        self.answers.retain(|key, _| open.contains(key));
        self.latest.retain(|key, _| open.contains(key));
    }
}

/// A card's open questions; an older host lists none, so its question decision stands alone.
pub fn open_questions(task: &Task) -> Vec<&Question> {
    match (&task.questions, &task.decision) {
        (Some(questions), _) => questions.iter().collect(),
        (None, Some(Decision::Question(question))) => vec![question],
        _ => Vec::new(),
    }
}

fn sending_said(answer: &InFlight) -> String {
    if answer.confirmed {
        format!(
            "Answered {}; waiting for {}'s board",
            answer.shown, answer.machine
        )
    } else {
        format!("Sending {} to {}…", answer.shown, answer.machine)
    }
}

/// The card's question block: the text, and the Answer button's label or the pending line.
#[derive(Debug, Clone, PartialEq)]
pub struct CardQuestion {
    pub text: String,
    pub label: Option<String>,
    pub pending: Option<String>,
}

pub fn card_question(task: &Task, installation: &str, state: &Answering) -> Option<CardQuestion> {
    let Some(Decision::Question(decision)) = &task.decision else {
        return None;
    };
    let open = open_questions(task);
    let answer_of = |q: &Question| state.answers.get(&answer_key(installation, &q.run, &q.id));
    let unanswered: Vec<&&Question> = open.iter().filter(|q| answer_of(q).is_none()).collect();
    let text = unanswered
        .first()
        .map(|q| q.text.clone())
        .or_else(|| open.first().map(|q| q.text.clone()))
        .unwrap_or_else(|| decision.text.clone());
    if !unanswered.is_empty() || open.is_empty() {
        return Some(CardQuestion {
            text,
            label: Some(if unanswered.len() > 1 {
                format!("Answer {} questions…", unanswered.len())
            } else {
                "Answer…".into()
            }),
            pending: None,
        });
    }
    let answers: Vec<&InFlight> = open.iter().filter_map(|q| answer_of(q)).collect();
    let machine = &answers[0].machine;
    let pending = if answers.len() == 1 {
        sending_said(answers[0])
    } else if answers.iter().any(|a| !a.confirmed) {
        format!("Sending {} answers to {machine}…", answers.len())
    } else {
        format!(
            "Answered {} questions; waiting for {machine}'s board",
            answers.len()
        )
    };
    Some(CardQuestion {
        text,
        label: None,
        pending: Some(pending),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    Unanswered,
    Answered { said: String, sending: bool },
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Was {
    Unanswered,
    Answered,
    Gone,
}

impl Condition {
    fn kind(&self) -> Was {
        match self {
            Condition::Unanswered => Was::Unanswered,
            Condition::Answered { .. } => Was::Answered,
            Condition::Gone => Was::Gone,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SittingEntry {
    /// As last seen on the board, so it is still drawn after it leaves.
    pub question: Question,
    pub seen: Option<InFlight>,
    pub was: Was,
}

/// One opening of the question dialog: its questions, which never leave it, and where it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Sitting {
    pub entries: Vec<SittingEntry>,
    pub cursor: usize,
}

/// The board and the answers as they stand.
pub struct Now<'a> {
    pub installation: &'a str,
    pub open: Vec<&'a Question>,
    pub answering: &'a Answering,
}

fn same(one: &Question, other: &Question) -> bool {
    one.run == other.run && one.id == other.id
}

fn condition_of(entry: &SittingEntry, now: &Now) -> Condition {
    let open = now.open.iter().any(|q| same(q, &entry.question));
    let answer = now.answering.answers.get(&answer_key(
        now.installation,
        &entry.question.run,
        &entry.question.id,
    ));
    match (open, answer) {
        (true, Some(answer)) => Condition::Answered {
            said: sending_said(answer),
            sending: !answer.confirmed,
        },
        (true, None) => Condition::Unanswered,
        (false, _) => match &entry.seen {
            Some(seen) if seen.confirmed => Condition::Answered {
                said: format!("Answered {}", seen.shown),
                sending: false,
            },
            _ => Condition::Gone,
        },
    }
}

fn refreshed(entries: &[SittingEntry], now: &Now) -> Vec<SittingEntry> {
    let mut all: Vec<SittingEntry> = entries.to_vec();
    for q in &now.open {
        if !entries.iter().any(|e| same(&e.question, q)) {
            all.push(SittingEntry {
                question: (*q).clone(),
                seen: None,
                was: Was::Gone,
            });
        }
    }
    all.into_iter()
        .map(
            |entry| match now.open.iter().find(|q| same(q, &entry.question)) {
                None => entry,
                Some(question) => SittingEntry {
                    seen: now
                        .answering
                        .answers
                        .get(&answer_key(now.installation, &question.run, &question.id))
                        .cloned(),
                    question: (*question).clone(),
                    was: entry.was,
                },
            },
        )
        .collect()
}

fn settled_was(entries: Vec<SittingEntry>, now: &Now) -> Vec<SittingEntry> {
    entries
        .into_iter()
        .map(|entry| {
            let was = condition_of(&entry, now).kind();
            SittingEntry { was, ..entry }
        })
        .collect()
}

impl Sitting {
    /// The card's open questions, on the first that is unanswered.
    pub fn starts(now: &Now) -> Sitting {
        let entries = settled_was(refreshed(&[], now), now);
        let cursor = entries
            .iter()
            .position(|e| e.was == Was::Unanswered)
            .unwrap_or(0);
        Sitting { entries, cursor }
    }

    /// The board or the answers changed: arrivals join, and from a question it cannot answer
    /// the dialog moves to the first that has just become answerable.
    pub fn sees(&self, now: &Now) -> Sitting {
        let entries = refreshed(&self.entries, now);
        let move_to = match entries.get(self.cursor) {
            Some(current) if condition_of(current, now) != Condition::Unanswered => {
                entries.iter().position(|e| {
                    e.was != Was::Unanswered && condition_of(e, now) == Condition::Unanswered
                })
            }
            _ => None,
        };
        Sitting {
            entries: settled_was(entries, now),
            cursor: move_to.unwrap_or(self.cursor),
        }
    }

    /// The question at the cursor was just answered: on to the next unanswered, wrapping.
    pub fn answered(&self, now: &Now) -> Sitting {
        let entries = settled_was(refreshed(&self.entries, now), now);
        let n = entries.len();
        let next = (0..n)
            .map(|at| (self.cursor + 1 + at) % n)
            .find(|at| entries[*at].was == Was::Unanswered);
        Sitting {
            entries,
            cursor: next.unwrap_or(self.cursor),
        }
    }

    /// Back (-1) or Next (1), which never wrap.
    pub fn moved(&self, by: isize) -> Sitting {
        let last = self.entries.len().saturating_sub(1) as isize;
        Sitting {
            entries: self.entries.clone(),
            cursor: (self.cursor as isize + by).clamp(0, last) as usize,
        }
    }

    pub fn view(&self, now: &Now) -> SittingView {
        let entry = self.entries.get(self.cursor);
        let conditions: Vec<Condition> =
            self.entries.iter().map(|e| condition_of(e, now)).collect();
        SittingView {
            k: self.cursor + 1,
            n: self.entries.len(),
            question: entry.map(|e| e.question.clone()),
            condition: entry.map(|e| condition_of(e, now)),
            back: self.cursor > 0,
            next: self.cursor + 1 < self.entries.len(),
            done: conditions.iter().all(|c| match c {
                Condition::Gone => true,
                Condition::Answered { sending, .. } => !sending,
                Condition::Unanswered => false,
            }),
        }
    }
}

/// What the dialog draws: "Question k of N", the question, its condition, and whether done.
#[derive(Debug, Clone, PartialEq)]
pub struct SittingView {
    pub k: usize,
    pub n: usize,
    pub question: Option<Question>,
    pub condition: Option<Condition>,
    pub back: bool,
    pub next: bool,
    pub done: bool,
}
