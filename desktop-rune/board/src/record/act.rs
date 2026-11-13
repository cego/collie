//! A gesture on a record sent as one `act` request, said back in the record: what it did, or
//! why not, with Try again sending the same request. A copy of `actionRunner` in
//! `desktop/src/shared/actions.ts`.

use crate::App;
use crate::board::questionnaire::Event;
use collie_desktop_protocol::generated::Question;
use collie_desktop_protocol::generated::{ActPayload, ActPayloadAction};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

/// What the last gesture came to, shown under the record's header.
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub said: String,
    pub failed: bool,
    /// What Try again sends again, under the same request.
    pub again: Option<Sent>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sent {
    pub installation: String,
    pub action: ActPayloadAction,
    pub request: String,
    /// An offer's input, which the generated `Invoke` cannot carry.
    pub input: Option<serde_json::Value>,
    /// What follows once it is done, on every try.
    pub after: After,
}

/// What a gesture does once its action is done.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum After {
    #[default]
    Nothing,
    /// The review comment drafts it carried go, those edited since staying.
    ClearDrafts {
        run: (String, String),
        sent: Vec<super::review::Draft>,
    },
    /// Another action, sent as a gesture of its own.
    Then(Box<(ActPayloadAction, After)>),
}

/// A request id the host takes once, the same on every try of one gesture.
pub fn new_request() -> String {
    let random = |salt: u64| {
        let mut hash = RandomState::new().build_hasher();
        hash.write_u64(salt);
        hash.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        );
        hash.finish()
    };
    let (a, b) = (random(1), random(2));
    let b = (b & 0x0fff_3fff_ffff_ffff) | 0x4000_8000_0000_0000;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        a >> 32,
        (a >> 16) & 0xffff,
        b >> 48,
        (b >> 32) & 0xffff,
        b & 0xffff_ffff_ffff
    )
}

impl App {
    /// Sends `action` once, under a new request, and `after` once it is done.
    pub fn act_in_record(&mut self, installation: String, action: ActPayloadAction, after: After) {
        let sent = Sent {
            installation,
            action,
            request: new_request(),
            input: None,
            after,
        };
        self.act_again(sent);
    }

    /// Sends a gesture again, under its own request; the host takes it once.
    pub fn act_again(&mut self, sent: Sent) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let unsent = self.unsent();
        let payload = ActPayload {
            installation: sent.installation.clone(),
            action: sent.action.clone(),
            request: Some(Some(sent.request.clone())),
            unsent: unsent.map(Some),
        };
        let mut payload = serde_json::to_value(payload).unwrap_or_default();
        if let Some(input) = &sent.input {
            payload["action"]["input"] = input.clone();
        }
        self.record.sending = true;
        core.request(
            "act",
            payload,
            move |app: &mut App, answer: Result<String, _>| {
                app.record.sending = false;
                match answer {
                    Ok(said) => {
                        app.record.notice = Some(Notice {
                            said,
                            failed: false,
                            again: None,
                        });
                        app.after(sent.installation, sent.after);
                    }
                    Err(why) => {
                        app.record.notice = Some(Notice {
                            said: why.to_string(),
                            failed: true,
                            again: Some(sent),
                        })
                    }
                }
            },
        );
    }

    fn after(&mut self, installation: String, after: After) {
        match after {
            After::Nothing => {}
            After::ClearDrafts { run, sent } => {
                let drafts = self.record.drafts.entry(run).or_default();
                *drafts = super::review::clear_sent(drafts, &sent);
            }
            After::Then(next) => {
                let (action, after) = *next;
                self.act_in_record(installation, action, after);
            }
        }
    }
}

use super::{Form, Item};
use crate::flow::actions::{self, Effect};
use collie_desktop_protocol::generated::{
    Invoke, InvokeInput, InvokeTag, OffersSuccessItem, OpenLinkPayload, WithdrawNote,
    WithdrawNoteTag,
};

/// Whether every field an offer needs has words.
pub fn offer_ready(fields: &[(String, bool, rune::edit::TextEdit)]) -> bool {
    fields
        .iter()
        .all(|(_, required, edit)| !required || !edit.text.trim().is_empty())
}

impl App {
    /// What pressing a Flow or lane action does: sends it, opens its form, or shows its part.
    pub fn run_effect(&mut self, effect: Effect) {
        // The board's own questions for the open Run, which carry Hold and steering.
        let on_board: Vec<Question> = match &self.record.open {
            Some(record) => self
                .machines
                .iter()
                .filter(|m| m.machine.installation == record.installation)
                .flat_map(|m| &m.cards)
                .flat_map(crate::board::answers::open_questions)
                .filter(|q| q.run == record.run)
                .cloned()
                .collect(),
            None => Vec::new(),
        };
        let Some(record) = &mut self.record.open else {
            return;
        };
        let installation = record.installation.clone();
        let revision = record.detail().and_then(|d| d.revision.clone());
        match effect {
            Effect::Write(write) => {
                let write = actions::shown_at(write, revision.as_ref());
                self.act_in_record(installation, write, After::Nothing);
            }
            Effect::Text {
                write,
                initial,
                retry,
                withdraw,
            } => {
                let title = match &write {
                    ActPayloadAction::FollowUp(_) => "Follow-up run".to_string(),
                    _ if retry.is_some() => "Retry with a note".into(),
                    ActPayloadAction::Deliver(d) if d.agent.is_some() => "Tell the agent".into(),
                    _ => "Note for the Step".into(),
                };
                record.form = Some(Form::Text {
                    title,
                    installation,
                    write,
                    retry,
                    withdraw,
                    edit: rune::edit::TextEdit::new(initial.unwrap_or_default()),
                });
            }
            Effect::Answer(questions) => {
                let run = questions.first().map(|q| q.run.clone()).unwrap_or_default();
                let questions = questions
                    .into_iter()
                    .map(|q| super::Asked {
                        board: on_board
                            .iter()
                            .find(|b| b.run == q.run && b.id == q.id)
                            .cloned(),
                        id: q.id,
                        asked: q.text,
                        options: q.options,
                        picked: None,
                        edit: rune::edit::TextEdit::default(),
                        sent: None,
                        steer: rune::edit::TextEdit::default(),
                    })
                    .collect();
                record.form = Some(Form::Answer {
                    installation,
                    run,
                    questions,
                    at: 0,
                })
            }
            Effect::Proposal(proposal) => {
                record.form = Some(Form::Proposal {
                    installation,
                    proposal,
                })
            }
            Effect::Terminal { agent, .. } => {
                record.picked = Some(agent);
                self.show_tab("terminal");
            }
            Effect::Part { part, .. } => self.show_tab(part),
            Effect::Url(url) => self.open_link_in_record(url),
            Effect::Run { run, machine } => {
                let machine = machine.unwrap_or_else(|| record.machine.clone());
                self.open_record(installation, run, machine, None);
            }
            Effect::Offer { run, offer } => self.open_offer(installation, run, offer),
        }
    }

    /// Asks the Run what it offers now, as the board's Start does: its module's decision at
    /// this moment, not the Step's; one that takes nothing is made at once.
    fn open_offer(&mut self, installation: String, run: String, chosen: String) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let Some(record) = &mut self.record.open else {
            return;
        };
        let payload = serde_json::json!({"installation": installation, "runId": run});
        record.form = Some(Form::Offer {
            installation,
            run,
            chosen,
            offer: None,
            fields: Vec::new(),
        });
        core.request(
            "offers",
            payload,
            |app: &mut App, read: Result<Vec<OffersSuccessItem>, crate::calls::CallError>| {
                let Some(record) = &mut app.record.open else {
                    return;
                };
                let Some(Form::Offer {
                    chosen,
                    offer,
                    fields,
                    ..
                }) = &mut record.form
                else {
                    return;
                };
                let failed = |said: String| Notice {
                    said,
                    failed: true,
                    again: None,
                };
                let named = match read {
                    Ok(read) => read
                        .into_iter()
                        .find(|o| crate::board::offer_key(o) == *chosen || o.id == *chosen),
                    Err(why) => {
                        record.form = None;
                        app.record.notice = Some(failed(why.0));
                        return;
                    }
                };
                let Some(named) = named else {
                    record.form = None;
                    app.record.notice = Some(failed("The Run no longer offers this.".into()));
                    return;
                };
                *fields = crate::board::offer_fields(named.arguments.as_ref())
                    .into_iter()
                    .map(|(name, required)| (name, required, rune::edit::TextEdit::default()))
                    .collect();
                let at_once = fields.is_empty() && named.unavailable.is_none();
                *offer = Some(named);
                if at_once {
                    app.make_offer_in_record();
                }
            },
        );
    }

    /// Makes the picked offer with what was typed, once every field it needs has words.
    pub fn make_offer_in_record(&mut self) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let Some(Form::Offer {
            offer: Some(offer),
            fields,
            ..
        }) = &record.form
        else {
            return;
        };
        if offer.unavailable.is_some() || !offer_ready(fields) {
            return;
        }
        let Some(Form::Offer {
            installation,
            run,
            offer: Some(offer),
            fields,
            ..
        }) = record.form.take()
        else {
            return;
        };
        let typed: Vec<(String, String)> = fields
            .into_iter()
            .map(|(name, _, edit)| (name, edit.text.clone()))
            .collect();
        let sent = Sent {
            installation,
            action: ActPayloadAction::Invoke(Invoke {
                tag: InvokeTag::Invoke,
                run_id: offer.run.clone().unwrap_or(run),
                offer: offer.id.clone(),
                input: InvokeInput {},
            }),
            request: new_request(),
            input: Some(crate::board::offer_input(offer.arguments.as_ref(), &typed)),
            after: After::Nothing,
        };
        self.act_again(sent);
    }

    /// The board's question at `at` of the answer form, with its installation and Machine.
    fn board_question(&self, at: usize) -> Option<(String, String, Question)> {
        let record = self.record.open.as_ref()?;
        let Some(Form::Answer { questions, .. }) = &record.form else {
            return None;
        };
        let question = questions.get(at)?.board.clone()?;
        Some((
            record.installation.clone(),
            record.machine.clone(),
            question,
        ))
    }

    /// Whether the answer form's question `at` has nothing more to send: answered, or gone.
    pub fn question_settled(&self, at: usize) -> bool {
        match self.board_question(at) {
            Some((installation, _, question)) => {
                self.questionnaire_of(&installation, &question)
                    .view()
                    .settled
            }
            None => self
                .record
                .open
                .as_ref()
                .and_then(|r| match &r.form {
                    Some(Form::Answer { questions, .. }) => questions.get(at),
                    _ => None,
                })
                .is_none_or(|q| q.sent.is_some()),
        }
    }

    /// The question the answer form shows: the one chosen, or once it is answered the next
    /// still open; none once every one is, and the form is done.
    pub fn question_shown(&self) -> Option<usize> {
        let Some(Form::Answer { questions, at, .. }) =
            self.record.open.as_ref().and_then(|r| r.form.as_ref())
        else {
            return None;
        };
        let n = questions.len();
        (0..n)
            .map(|step| (at + step) % n)
            .find(|i| !self.question_settled(*i))
    }

    /// Feeds the board's questionnaire for the question shown one event.
    fn step_shown(&mut self, event: Event) {
        let Some(at) = self.question_shown() else {
            return;
        };
        let Some((installation, machine, question)) = self.board_question(at) else {
            return;
        };
        self.step_question(&installation, &machine, &question, event);
    }

    /// Picks a row of the question shown, Hold the Run among them.
    pub fn pick_in_record(&mut self, id: String) {
        self.step_shown(Event::Pick(id));
    }

    /// Answers the question shown with the row picked or the words typed.
    pub fn answer_in_record(&mut self) {
        let Some(at) = self.question_shown() else {
            return;
        };
        if self.board_question(at).is_none() {
            self.send_form(None);
            return;
        }
        let typed = self.typed_at(at, |q| &q.edit);
        self.step_shown(Event::Type(typed));
        self.step_shown(Event::Submit(new_request()));
    }

    /// Sends the steering words to the agent instead of an answer.
    pub fn steer_in_record(&mut self) {
        let Some(at) = self.question_shown() else {
            return;
        };
        // Words left in the field are sent; with none, the words kept from a send that failed.
        let draft = self.typed_at(at, |q| &q.steer);
        if !draft.trim().is_empty() {
            self.step_shown(Event::Draft(draft));
        }
        self.step_shown(Event::Steer(new_request()));
        let sending = self
            .board_question(at)
            .is_some_and(|(i, _, q)| self.questionnaire_of(&i, &q).view().sending);
        if sending
            && let Some(Form::Answer { questions, .. }) =
                self.record.open.as_mut().and_then(|r| r.form.as_mut())
        {
            questions[at].steer = rune::edit::TextEdit::default();
        }
    }

    fn typed_at(&self, at: usize, field: fn(&super::Asked) -> &rune::edit::TextEdit) -> String {
        match self.record.open.as_ref().and_then(|r| r.form.as_ref()) {
            Some(Form::Answer { questions, .. }) => questions
                .get(at)
                .map(|q| field(q).text.clone())
                .unwrap_or_default(),
            _ => String::new(),
        }
    }

    /// Shows the answer form's question `at`.
    pub fn show_question(&mut self, to: usize) {
        if let Some(Form::Answer { questions, at, .. }) =
            self.record.open.as_mut().and_then(|r| r.form.as_mut())
            && to < questions.len()
        {
            *at = to;
        }
    }

    /// Edits a note already sent: it is withdrawn, and the new words delivered in its place.
    pub fn edit_note(&mut self, run: String, step: String, note: String, text: String) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        record.form = Some(Form::Text {
            title: "Edit note".into(),
            installation: record.installation.clone(),
            write: actions::deliver(&run, Some(step), None, None, ""),
            retry: None,
            withdraw: Some(note),
            edit: rune::edit::TextEdit::new(text),
        });
    }

    pub fn withdraw_note(&mut self, run: String, note: String) {
        let Some(record) = &self.record.open else {
            return;
        };
        let installation = record.installation.clone();
        let action = ActPayloadAction::WithdrawNote(WithdrawNote {
            tag: WithdrawNoteTag::WithdrawNote,
            run_id: run,
            note,
        });
        self.act_in_record(installation, action, After::Nothing);
    }

    /// Sends the open form; `retry` sends the note and then resumes the Run.
    pub fn send_form(&mut self, value: Option<String>) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let revision = record.detail().and_then(|d| d.revision.clone());
        let Some(form) = record.form.take() else {
            return;
        };
        match form {
            Form::Text {
                installation,
                write,
                retry,
                withdraw,
                edit,
                ..
            } => {
                let said = edit.text.trim().to_string();
                if said.is_empty() {
                    record.form = Some(Form::Text {
                        title: String::new(),
                        installation,
                        write,
                        retry,
                        withdraw,
                        edit,
                    });
                    return;
                }
                let write = actions::shown_at(actions::with_text(&write, &said), revision.as_ref());
                let after = match retry {
                    Some(run) => After::Then(Box::new((actions::resume(&run), After::Nothing))),
                    None => After::Nothing,
                };
                match withdraw {
                    Some(note) => {
                        let run = match &write {
                            ActPayloadAction::Deliver(d) => d.run_id.clone(),
                            _ => String::new(),
                        };
                        let first = ActPayloadAction::WithdrawNote(WithdrawNote {
                            tag: WithdrawNoteTag::WithdrawNote,
                            run_id: run,
                            note,
                        });
                        self.act_in_record(
                            installation,
                            first,
                            After::Then(Box::new((write, after))),
                        );
                    }
                    None => self.act_in_record(installation, write, after),
                }
            }
            Form::Answer {
                installation,
                run,
                mut questions,
                at,
            } => {
                let Some(one) = questions.get_mut(at) else {
                    return;
                };
                let typed = Some(one.edit.text.trim().to_string()).filter(|t| !t.is_empty());
                let Some(said) = value.or(typed).or(one.picked.clone()) else {
                    record.form = Some(Form::Answer {
                        installation,
                        run,
                        questions,
                        at,
                    });
                    return;
                };
                let action = actions::answer(&run, &one.id, &said);
                one.sent = Some(said);
                // Each question is its own answer: the form stays on the next one still open.
                let n = questions.len();
                let next = (1..n)
                    .map(|step| (at + step) % n)
                    .find(|i| questions[*i].sent.is_none());
                if let Some(next) = next {
                    record.form = Some(Form::Answer {
                        installation: installation.clone(),
                        run,
                        questions,
                        at: next,
                    });
                }
                self.act_in_record(installation, action, After::Nothing);
            }
            form @ Form::Offer { .. } => {
                record.form = Some(form);
                self.make_offer_in_record();
            }
            Form::Proposal {
                installation,
                proposal,
            } => {
                let action = if value.as_deref() == Some("decline") {
                    actions::decline(&proposal)
                } else {
                    actions::confirm(&proposal)
                };
                self.act_in_record(installation, action, After::Nothing);
            }
        }
    }

    /// Sends the Run's review comment drafts as one message, to the agent or role chosen
    /// (ADR-0051); they go once the host has taken it.
    pub fn send_review(&mut self) {
        let Some(record) = &self.record.open else {
            return;
        };
        let drafts = self.record.drafts_of(record).to_vec();
        if drafts.is_empty() {
            return;
        }
        let choice = self.delivery_choice();
        let revision = record.detail().and_then(|d| d.revision.clone());
        let (agent, to) = choice.map_or((None, None), |c| (c.agent, c.to));
        let text = super::review::compose(&drafts);
        let write = actions::shown_at(
            actions::deliver(&record.run, None, agent, to, &text),
            revision.as_ref(),
        );
        let after = After::ClearDrafts {
            run: record.key(),
            sent: drafts,
        };
        self.act_in_record(record.installation.clone(), write, after);
    }

    /// The delivery choices for the open record's review comments, and the one picked.
    pub fn delivery_choices(&self) -> Vec<super::agents::DeliveryChoice> {
        let Some(record) = &self.record.open else {
            return Vec::new();
        };
        let launches = record
            .detail()
            .and_then(|d| d.agents.clone().flatten())
            .unwrap_or_default();
        let live = self
            .task_of_record()
            .map(|t| t.agents.clone())
            .unwrap_or_default();
        let planner = record.chosen.as_deref() == Some("plan");
        super::agents::delivery_choices(&launches, &live, None, planner.then_some("planner"))
    }

    pub fn delivery_choice(&self) -> Option<super::agents::DeliveryChoice> {
        let choices = self.delivery_choices();
        let picked = self.record.open.as_ref().and_then(|r| r.to.clone());
        choices
            .iter()
            .find(|c| Some(&c.key) == picked.as_ref())
            .or(choices.first())
            .cloned()
    }

    /// Asks the core to open a link in the browser.
    pub fn open_link_in_record(&mut self, url: String) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let serial = self.record.open.as_ref().map(|record| record.serial);
        core.request(
            "openLink",
            OpenLinkPayload { url },
            move |app: &mut App, done: Result<serde_json::Value, _>| {
                if app.record.open.as_ref().map(|record| record.serial) != serial {
                    return;
                }
                if let Err(why) = done {
                    app.record.notice = Some(Notice {
                        said: why.to_string(),
                        failed: true,
                        again: None,
                    });
                }
            },
        );
    }

    /// Opens an evidence file in the browser: read, written aside (a report confined first),
    /// and opened from there.
    pub fn open_aside(&mut self, item: String) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        if !record.opening.contains(&item) {
            record.opening.push(item.clone());
        }
        match record.items.get(&item) {
            Some(Item::Read(_)) => self.opened_aside(&item),
            Some(Item::Reading) => {}
            _ => self.reread_item(&item),
        }
    }

    pub(super) fn opened_aside(&mut self, item: &str) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let Some(at) = record.opening.iter().position(|one| one == item) else {
            return;
        };
        record.opening.remove(at);
        let Some(Item::Read(bytes)) = record.items.get(item) else {
            return;
        };
        let name = item.split_once(':').map_or(item, |(_, name)| name);
        let path = super::evidence::aside(&record.installation, &record.run, name);
        let bytes = if super::evidence::is_report(name) {
            super::evidence::confined(&String::from_utf8_lossy(bytes)).into_bytes()
        } else {
            bytes.clone()
        };
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&path, bytes));
        match written {
            Ok(()) => self.open_link_in_record(format!("file://{}", path.display())),
            Err(why) => {
                self.record.notice = Some(Notice {
                    said: format!("{name} could not be written aside to open: {why}"),
                    failed: true,
                    again: None,
                })
            }
        }
    }
}
