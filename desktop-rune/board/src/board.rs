//! The Board: the Flock's Tasks in today's sections, the header sentence, the alerts, and what
//! a card offers. The logic is a copy of Desktop's view logic (`desktop/src/shared/flock.ts`,
//! `board-clicks.ts`, `pending-answer.ts`, `questionnaire.ts`, `card-mrs.ts`, `actions.ts`
//! and the board model in `src/board-model.ts`); the TypeScript stays its owner.

pub mod answers;
pub mod cards;
pub mod clicks;
mod dialogs;
pub mod model;
pub mod offer_form;
pub mod questionnaire;
pub(crate) mod view;

use collie_desktop_protocol::generated::{About, LostState};
pub use model::{Flock, Placed, Shown};
pub use view::{view, view_in};

use crate::App;
use crate::calls::{CallError, Failure, Stop};
use answers::{Answering, Sitting, answer_key, open_questions};
use cards::CardAction;
use clicks::{BoardState, Gesture, Landed};
use collie_desktop_protocol::generated::{
    CredentialsSuccess, FlockItem, OffersSuccessItem, Proposal, Question,
};
use questionnaire::{Does, Event, Questionnaire};
use rune::TextEdit;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Why the board's own subscription failed, which try comes next, and when (epoch ms).
#[derive(Debug, Clone, PartialEq)]
pub struct Trouble {
    pub said: String,
    pub attempt: u32,
    pub at: f64,
}

/// What came of an action, said for a while; a failure can be tried again.
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub id: u64,
    pub title: String,
    pub ok: bool,
    again: Option<Again>,
    pub shown: crate::toasts::Shown,
}

#[derive(Debug, Clone, PartialEq)]
struct Again {
    installation: String,
    action: Value,
    request: String,
    unsent: Option<String>,
    tried: Tried,
}

/// Who hears how a try went.
#[derive(Debug, Clone, PartialEq)]
enum Tried {
    Plain,
    /// A questionnaire's send; `send` is the answer's, where it is one.
    Question {
        installation: String,
        question: Box<Question>,
        send: Option<u64>,
    },
}

/// Words a Steer or a Follow-up needs before it can be sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Words {
    Steer,
    FollowUp,
}

/// The board's one open dialog.
pub enum Dialog {
    Words {
        /// The card it was opened on, by key.
        card: String,
        kind: Words,
        installation: String,
        run: String,
        title: String,
        edit: TextEdit,
        as_of: Option<f64>,
    },
    Offers {
        card: String,
        installation: String,
        run: String,
        as_of: Option<f64>,
        /// The offer a button named already, by its key.
        chosen: Option<String>,
        offers: Option<Vec<OffersSuccessItem>>,
        picked: Option<OffersSuccessItem>,
        fields: Vec<offer_form::OfferEntry>,
    },
    Questions {
        card: String,
        installation: String,
        machine: String,
        title: String,
        sitting: Sitting,
    },
    /// A card's running check: what it is doing and its last lines, read off the live card.
    Check { card: String },
    Proposal {
        card: String,
        installation: String,
        proposal: Proposal,
        as_of: Option<f64>,
        /// A yes is consent to what was read, so it waits until all of it has been on screen.
        seen: bool,
        shown: [f32; 2],
        end: f32,
    },
}

#[derive(Default)]
pub struct Board {
    /// The Flock but its Machines' boards, which are `App::machines`.
    pub flock: Flock,
    /// The card whose record the board opened, by key.
    pub opened: Option<String>,
    pub trouble: Option<Trouble>,
    pub credentials: Option<CredentialsSuccess>,
    pub answering: Answering,
    /// Each question's questionnaire, by `answer_key`.
    pub asking: HashMap<String, Questionnaire>,
    /// A question's typed answer and steering words, by `answer_key` and which.
    pub edits: HashMap<String, TextEdit>,
    /// The keys of the questions the last board showed open; none before the first board.
    on_board: Option<HashSet<String>>,
    sends: u64,
    pub dialog: Option<Dialog>,
    /// The card whose actions menu is open, by key.
    pub menu: Option<String>,
    pub notices: Vec<Notice>,
    told: usize,
    pub finished_open: bool,
    pub older_open: bool,
    /// The board's width, for its columns.
    pub width: f32,
    /// The columns last drawn, so a change of them lands at once rather than springing.
    pub columns: std::cell::Cell<usize>,
    /// A fixed now for tests; the wall clock otherwise.
    pub clock: Option<f64>,
    /// Minutes east of UTC, for a test; this computer's own otherwise.
    pub utc_offset: Option<i32>,
    flock_stop: Arc<Mutex<Option<Stop>>>,
    /// The subscription whose values count; a newer one makes an older one's late values moot.
    flock_attempt: Arc<AtomicU64>,
    failures: u32,
    /// Subscriptions the core cut off in a row since the last value.
    renewals: u32,
    credentials_stop: Option<Stop>,
}

fn subscribe_flock(core: &crate::calls::Core<App>, attempt: u64) -> Stop {
    core.stream_until(
        "flock",
        (),
        move |app: &mut App, item: Result<FlockItem, CallError>| app.flock_heard(attempt, item),
        move |app: &mut App| app.flock_ended(attempt),
    )
}

/// `min(1 s × 2^failures, 60 s)`, as `backoff` in `src/peers-model.ts`.
pub fn backoff(failures: u32) -> f64 {
    (1000.0 * 2f64.powi(failures.min(16) as i32)).min(60_000.0)
}

/// A gesture's request, sent again on every Try again.
pub fn new_request() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    let (a, b) = (h.finish(), {
        h.write_u8(1);
        h.finish()
    });
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        a >> 32,
        (a >> 16) & 0xffff,
        a & 0xfff,
        0x8000 | (b >> 48 & 0x3fff),
        b & 0xffff_ffff_ffff
    )
}

impl Board {
    pub fn now(&self) -> f64 {
        self.clock.unwrap_or_else(collie_desktop_protocol::epoch_ms)
    }
}

/// `as of 14:05`, in this computer's time.
pub fn as_of_said(at: f64, offset_minutes: i32) -> String {
    let minutes = ((at / 60_000.0).floor() as i64 + offset_minutes as i64).rem_euclid(24 * 60);
    format!("as of {:02}:{:02}", minutes / 60, minutes % 60)
}

/// Minutes east of UTC here, read once.
pub fn local_offset() -> i32 {
    static OFFSET: std::sync::OnceLock<i32> = std::sync::OnceLock::new();
    // std has no time zones; `date` says this computer's offset as `+0100`.
    *OFFSET.get_or_init(|| {
        std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()
            .and_then(|out| {
                let said = String::from_utf8(out.stdout).ok()?;
                let said = said.trim();
                let sign = if said.starts_with('-') { -1 } else { 1 };
                let digits = said.trim_start_matches(['+', '-']);
                let hours: i32 = digits.get(..2)?.parse().ok()?;
                let minutes: i32 = digits.get(2..4)?.parse().ok()?;
                Some(sign * (hours * 60 + minutes))
            })
            .unwrap_or(0)
    })
}

/// Days from the epoch of a `YYYY-MM-DD` date, as GitLab gives a token's expiry.
fn epoch_day(date: &str) -> Option<i64> {
    let mut parts = date.get(..10)?.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Whether a token expiring on `expires` is due for renewal at `now`: within 14 days.
pub fn renewal_due(expires: Option<&str>, now: f64) -> bool {
    let Some(day) = expires.and_then(epoch_day) else {
        return false;
    };
    ((day as f64 * 86_400_000.0 - now) / 86_400_000.0).floor() < 14.0
}

/// An offer's key: its id, or `run:id` where another Run makes it.
pub fn offer_key(offer: &OffersSuccessItem) -> String {
    match &offer.run {
        Some(run) => format!("{run}:{}", offer.id),
        None => offer.id.clone(),
    }
}

/// An empty field that takes focus when its dialog opens.
fn focused_edit() -> TextEdit {
    let mut edit = TextEdit::new("");
    edit.focused = true;
    edit
}

impl App {
    /// One `flock` item: folded into the Flock, and what the board holds settled against it.
    pub fn apply(&mut self, item: FlockItem) {
        self.pages.machines.heard(&item);
        model::apply_item(&mut self.machines, &mut self.board.flock, item);
        self.settle_answers();
        self.read_credentials();
        let notices = self.board.flock.notices.len();
        let fresh: Vec<String> = self.board.flock.notices[self.board.told.min(notices)..].to_vec();
        for text in fresh {
            self.notify(text, true, None);
        }
        self.board.told = notices;
        self.settle_dialog();
        // A record closes when its card leaves the Flock.
        if let (Some(_), Some(key)) = (&self.open_run, self.board.opened.clone())
            && self.placed_by(&key).is_none()
        {
            self.gesture(Gesture::Close);
        }
    }

    /// The board's own subscription to `flock`, tried again after each failure and each end,
    /// folding into what it holds.
    pub fn follow_flock(&mut self) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let attempt = self.board.flock_attempt.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(stop) = self.board.flock_stop.lock().unwrap().take() {
            stop();
        }
        self.ended = None;
        *self.board.flock_stop.lock().unwrap() = Some(subscribe_flock(&core, attempt));
    }

    fn flock_heard(&mut self, attempt: u64, item: Result<FlockItem, CallError>) {
        if self.board.flock_attempt.load(Ordering::SeqCst) != attempt {
            return;
        }
        match item {
            Ok(item) => {
                self.board.trouble = None;
                self.board.failures = 0;
                self.board.renewals = 0;
                self.apply(item);
            }
            Err(error) => {
                let wait = backoff(self.board.failures);
                self.board.failures += 1;
                self.board.trouble = Some(Trouble {
                    said: error.0.trim_end_matches('.').to_string(),
                    attempt: self.board.failures,
                    at: self.board.now() + wait,
                });
                self.follow_flock_after(attempt, wait);
            }
        }
    }

    /// A host restarted under the core ends `flock` quietly, as Desktop's `retrying` takes
    /// it: followed again at once, and after a growing wait while it keeps ending unheard.
    fn flock_ended(&mut self, attempt: u64) {
        if self.board.flock_attempt.load(Ordering::SeqCst) != attempt {
            return;
        }
        let renewals = self.board.renewals;
        self.board.renewals += 1;
        if renewals == 0 {
            self.follow_flock();
        } else {
            self.follow_flock_after(attempt, backoff(renewals));
        }
    }

    fn follow_flock_after(&mut self, attempt: u64, wait: f64) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let (slot, counter) = (
            self.board.flock_stop.clone(),
            self.board.flock_attempt.clone(),
        );
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(wait as u64));
            // Retry now, or another subscription, came first.
            let next = attempt + 1;
            if counter
                .compare_exchange(attempt, next, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return;
            }
            *slot.lock().unwrap() = Some(subscribe_flock(&core, next));
        });
    }

    /// Retry now: a new subscription at once, whatever wait is under way.
    pub fn retry_flock(&mut self) {
        self.follow_flock();
    }

    /// Which credentials Desktop holds, read once the board has a core.
    fn read_credentials(&mut self) {
        if self.board.credentials_stop.is_some() {
            return;
        }
        let Some(core) = self.core.clone() else {
            return;
        };
        self.board.credentials_stop = Some(core.stream(
            "credentials",
            (),
            |app: &mut App, held: Result<CredentialsSuccess, CallError>| {
                if let Ok(held) = held {
                    app.board.credentials = Some(held);
                }
            },
        ));
    }

    /// The date the GitLab token expires on, while it is due for renewal.
    pub fn renew_by(&self) -> Option<String> {
        let expires = self
            .board
            .credentials
            .as_ref()?
            .gitlab
            .as_ref()?
            .expires
            .clone()?;
        renewal_due(Some(&expires), self.board.now()).then_some(expires)
    }

    /// Every card on the board, in its order.
    pub fn placed(&self) -> Vec<Placed<'_>> {
        model::placed(&self.machines)
    }

    pub fn placed_by(&self, key: &str) -> Option<Placed<'_>> {
        self.placed().into_iter().find(|p| p.key == key)
    }

    /// The selected card's key. The chat's chip is the selection (ADR-0012), so a chip whose
    /// card has left the board keeps a key no card has.
    pub fn selected_key(&self) -> Option<String> {
        let about = self.chat.about.as_ref()?;
        Some(
            self.placed_at(&about.machine, &about.task)
                .map(|p| p.key)
                .unwrap_or_else(|| format!("gone:{}:{}", about.machine, about.task)),
        )
    }

    pub fn placed_at(&self, machine: &str, task: &str) -> Option<Placed<'_>> {
        self.placed()
            .into_iter()
            .find(|p| p.machine == machine && p.task.id == task)
    }

    fn page(&self) -> Option<String> {
        self.open_run.as_ref().and(self.board.opened.clone())
    }

    /// Every board gesture, decided by `after_gesture` and applied to the selection and the
    /// open record.
    pub fn gesture(&mut self, done: Gesture) {
        let before = BoardState {
            selected: self.selected_key(),
            page: self.page(),
        };
        let after = clicks::after_gesture(&before, &done);
        match &after.selected {
            None if before.selected.is_some() => self.chat.choose(None),
            None => {}
            // Chosen again even when unchanged, so the chip follows the card's latest Run and name.
            Some(key) => {
                if let Some(card) = self.placed_by(key) {
                    let about = About {
                        machine: card.machine.clone(),
                        task: card.task.id.clone(),
                        run: card.task.run.clone(),
                        name: card.task.name.clone(),
                    };
                    self.chat.choose(Some(about));
                }
            }
        }
        if after.page == before.page {
            return;
        }
        let seen = clicks::seen_on_opening(&before, &after, |key| {
            self.placed_by(key)
                .is_some_and(|p| p.task.unseen == Some(true))
        });
        match after.page {
            None => {
                self.board.opened = None;
                self.back();
            }
            Some(key) => {
                let Some((installation, run, machine, as_of)) = self.placed_by(&key).map(|p| {
                    (
                        p.installation.to_string(),
                        p.task.run.clone(),
                        p.machine.clone(),
                        p.as_of,
                    )
                }) else {
                    return;
                };
                if seen {
                    self.act(
                        &installation,
                        json!({"_tag": "Seen", "runId": run}),
                        as_of,
                        None,
                    );
                }
                self.board.opened = Some(key);
                self.open_placed(installation, run, machine);
            }
        }
    }

    pub fn click_card(&mut self, key: &str, double: bool) {
        let as_of = self.placed_by(key).is_some_and(|p| p.as_of.is_some());
        let landed = Landed::Card {
            card: key.into(),
            as_of,
        };
        self.gesture(if double {
            Gesture::DoubleClick(landed)
        } else {
            Gesture::Click(landed)
        });
    }

    pub fn open_card(&mut self, key: &str) {
        self.gesture(Gesture::Name(key.into()));
    }

    /// Carries one board action to its card's Machine under one request, which Try again sends
    /// again; what came of it is said.
    pub fn act(
        &mut self,
        installation: &str,
        action: Value,
        as_of: Option<f64>,
        request: Option<String>,
    ) -> String {
        let request = request.unwrap_or_else(new_request);
        let unsent = as_of.map(|at| {
            format!(
                "its board is a saved one, {}",
                as_of_said(at, self.offset())
            )
        });
        self.send(Again {
            installation: installation.into(),
            action,
            request: request.clone(),
            unsent,
            tried: Tried::Plain,
        });
        request
    }

    pub(crate) fn offset(&self) -> i32 {
        self.board.utc_offset.unwrap_or_else(local_offset)
    }

    fn send(&mut self, again: Again) {
        let Some(core) = self.core.clone() else {
            return;
        };
        self.tried(&again.tried, &again.request, None);
        let mut payload = json!({
            "installation": again.installation,
            "action": again.action,
            "request": again.request,
        });
        if let Some(unsent) = &again.unsent {
            payload["unsent"] = Value::String(unsent.clone());
        }
        core.request_refusable(
            "act",
            payload,
            move |app: &mut App, answer: Result<String, Failure>| app.acted(again, answer),
        );
    }

    /// What came of an act is said; a host's refusal gets no Try again, since the same
    /// request would be refused again.
    fn acted(&mut self, again: Again, answer: Result<String, Failure>) {
        match answer {
            Ok(said) => {
                self.tried(&again.tried, &again.request, Some(Ok(())));
                self.notify(said, true, None);
            }
            Err(failed) => {
                self.tried(&again.tried, &again.request, Some(Err(failed.clone())));
                let again = (!failed.refused).then_some(again);
                self.notify(failed.said, false, again);
            }
        }
    }

    fn tried(&mut self, tried: &Tried, request: &str, done: Option<Result<(), Failure>>) {
        let Tried::Question {
            installation,
            question,
            send,
        } = tried
        else {
            return;
        };
        let key = answer_key(installation, &question.run, &question.id);
        if let Some(send) = send {
            self.board
                .answering
                .tried(&key, *send, done.as_ref().map(Result::is_ok));
        }
        let event = match done {
            None => Event::Trying(request.into()),
            Some(outcome) => Event::Replied {
                request: request.into(),
                outcome: outcome.map_err(|failed| (failed.refused, failed.said)),
            },
        };
        let mut asked = self.questionnaire_of(installation, question);
        let was_settled = asked.view().settled;
        asked.step(event);
        let settled = asked.view().settled;
        self.board.asking.insert(key, asked);
        self.sitting_sees();
        if settled && !was_settled {
            self.sitting_answered();
        }
    }

    fn notify(&mut self, title: String, ok: bool, again: Option<Again>) {
        // What went well is said once; the next news takes its place.
        self.board.notices.retain(|n| !n.ok);
        let id = self.board.notices.iter().map(|n| n.id).max().unwrap_or(0) + 1;
        self.board.notices.push(Notice {
            id,
            title,
            ok,
            again,
            shown: Default::default(),
        });
        let excess = self.board.notices.len().saturating_sub(3);
        self.board.notices.drain(..excess);
    }

    pub fn dismiss(&mut self, id: u64) {
        self.board.notices.retain(|n| n.id != id);
    }

    pub fn try_again(&mut self, id: u64) {
        let Some(at) = self.board.notices.iter().position(|n| n.id == id) else {
            return;
        };
        let notice = self.board.notices.remove(at);
        if let Some(again) = notice.again {
            self.send(again);
        }
    }

    /// A card's action, as this board does it.
    pub fn do_action(&mut self, key: &str, action: &CardAction) {
        self.board.menu = None;
        let Some(card) = self.placed_by(key) else {
            return;
        };
        let installation = card.installation.to_string();
        let (run, name, as_of, unseen) = (
            card.task.run.clone(),
            card.task.name.clone(),
            card.as_of,
            card.task.unseen == Some(true),
        );
        match action {
            CardAction::GoToTab => {
                if as_of.is_none() {
                    self.open_card_at_pane(key);
                }
            }
            CardAction::CheckOutput => {
                self.board.dialog = Some(Dialog::Check { card: key.into() });
            }
            CardAction::Attach => {
                self.attach_to(key);
                if let Some(pick) = &self.chat.pick {
                    pick();
                }
            }
            CardAction::Steer => {
                self.board.dialog = Some(Dialog::Words {
                    card: key.into(),
                    kind: Words::Steer,
                    installation,
                    run,
                    title: format!("What should {name} do?"),
                    edit: focused_edit(),
                    as_of,
                })
            }
            CardAction::FollowUp => {
                self.board.dialog = Some(Dialog::Words {
                    card: key.into(),
                    kind: Words::FollowUp,
                    installation,
                    run,
                    title: format!("What still needs doing on {name}?"),
                    edit: focused_edit(),
                    as_of,
                })
            }
            CardAction::OpenMr { mr, .. } => {
                if let Some(url) = mr.url() {
                    self.open_link(url);
                }
            }
            // An offer of another Run of the Task is that Run's to make.
            CardAction::Offer(offer) => {
                let run = offer.run.clone().unwrap_or(run);
                self.open_offers(key, installation, run, as_of, Some(offer.id.clone()))
            }
            CardAction::Offers => self.open_offers(key, installation, run, as_of, None),
            CardAction::Resume => {
                self.act(
                    &installation,
                    json!({"_tag": "Resume", "runId": run}),
                    as_of,
                    None,
                );
            }
            CardAction::Hold { set } => {
                self.act(
                    &installation,
                    json!({"_tag": "Control", "runId": run, "control": "hold", "set": set}),
                    as_of,
                    None,
                );
            }
            CardAction::Stop => {
                self.act(
                    &installation,
                    json!({"_tag": "Control", "runId": run, "control": "stop", "set": true}),
                    as_of,
                    None,
                );
            }
            CardAction::Dispose {
                disposition, r#ref, ..
            } => {
                self.act(
                    &installation,
                    json!({"_tag": "Dispose", "runId": run, "kind": disposition.said(), "ref": r#ref}),
                    as_of,
                    None,
                );
            }
            CardAction::Acknowledge => {
                if unseen {
                    self.act(
                        &installation,
                        json!({"_tag": "Seen", "runId": run}),
                        as_of,
                        None,
                    );
                }
            }
        }
    }

    /// Attaching is the chat's: the card becomes its chip and the chat opens, for the files
    /// its dialog picks.
    pub fn attach_to(&mut self, key: &str) {
        if self.selected_key().as_deref() != Some(key) {
            self.gesture(Gesture::Click(Landed::Card {
                card: key.into(),
                as_of: true,
            }));
        }
        self.nav.chat.set_open(true);
    }

    /// Why a Machine's route is not live, by herdr profile; none while it is.
    pub fn lost_of(&self, profile: &str) -> Option<&LostState> {
        self.board.flock.lost.get(profile).map(|lost| &lost.state)
    }

    /// Whether a Machine is live: its route reached and its board its own, not a saved one.
    pub fn is_live(&self, shown: &Shown) -> bool {
        self.lost_of(&shown.machine.profile).is_none() && shown.as_of.is_none()
    }

    pub fn open_link(&mut self, url: String) {
        if let Some(core) = &self.core {
            core.request(
                "openLink",
                json!({ "url": url }),
                |_: &mut App, _: Result<Value, CallError>| {},
            );
        }
    }

    /// Asks the Run what it offers now: its module's decision at this moment, not the card's.
    fn open_offers(
        &mut self,
        card: &str,
        installation: String,
        run: String,
        as_of: Option<f64>,
        chosen: Option<String>,
    ) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let payload = json!({"installation": installation, "runId": run});
        self.board.dialog = Some(Dialog::Offers {
            card: card.into(),
            installation,
            run,
            as_of,
            chosen,
            offers: None,
            picked: None,
            fields: Vec::new(),
        });
        core.request(
            "offers",
            payload,
            |app: &mut App, offers: Result<Vec<OffersSuccessItem>, CallError>| match offers {
                Ok(offers) => app.offers_read(offers),
                Err(failed) => {
                    app.board.dialog = None;
                    app.notify(failed.0, false, None);
                }
            },
        );
    }

    fn offers_read(&mut self, read: Vec<OffersSuccessItem>) {
        let Some(Dialog::Offers { offers, chosen, .. }) = &mut self.board.dialog else {
            return;
        };
        let named = chosen.as_ref().and_then(|chosen| {
            read.iter()
                .find(|o| &offer_key(o) == chosen || &o.id == chosen)
                .cloned()
        });
        *offers = Some(read);
        if let Some(named) = named {
            self.pick_offer(named);
        }
    }

    /// Why an offer cannot be made now, or none.
    pub fn refusal(&self, unavailable: Option<&str>, as_of: Option<f64>) -> Option<String> {
        unavailable.map(String::from).or_else(|| {
            as_of.map(|at| {
                format!(
                    "Not current: showing what it last said, {}",
                    as_of_said(at, self.offset())
                )
            })
        })
    }

    /// Picked, and made at once where it neither takes anything nor asks first; asked about
    /// otherwise.
    pub fn pick_offer(&mut self, offer: OffersSuccessItem) {
        let at_once = !offer_form::asks_before_taking(&offer);
        if let Some(Dialog::Offers { picked, fields, .. }) = &mut self.board.dialog {
            *fields = offer_form::entries_for(offer.arguments.as_ref());
            *picked = Some(offer);
        }
        if at_once {
            self.make_offer();
        }
    }

    pub fn make_offer(&mut self) {
        let Some(Dialog::Offers {
            as_of,
            picked: Some(offer),
            ..
        }) = &self.board.dialog
        else {
            return;
        };
        if self.refusal(offer.unavailable.as_deref(), *as_of).is_some() {
            return;
        }
        let Some(Dialog::Offers {
            installation,
            run,
            as_of,
            picked: Some(offer),
            fields,
            ..
        }) = &mut self.board.dialog
        else {
            return;
        };
        let Some(input) = offer_form::read_form(offer.arguments.as_ref(), fields) else {
            return;
        };
        let action = json!({
            "_tag": "Invoke",
            "runId": offer.run.clone().unwrap_or_else(|| run.clone()),
            "offer": offer.id,
            "input": input,
        });
        let (installation, as_of) = (installation.clone(), *as_of);
        self.board.dialog = None;
        self.act(&installation, action, as_of, None);
    }

    /// Sends a Steer's or a Follow-up's words, once there are some.
    pub fn send_words(&mut self) {
        let Some(Dialog::Words {
            kind,
            installation,
            run,
            edit,
            as_of,
            ..
        }) = &self.board.dialog
        else {
            return;
        };
        let text = edit.text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let tag = match kind {
            Words::Steer => "Steer",
            Words::FollowUp => "FollowUp",
        };
        let action = json!({"_tag": tag, "runId": run, "text": text});
        let (installation, as_of) = (installation.clone(), *as_of);
        self.board.dialog = None;
        self.act(&installation, action, as_of, None);
    }

    pub fn review(&mut self, key: &str) {
        let Some(card) = self.placed_by(key) else {
            return;
        };
        let Some(collie_desktop_protocol::generated::Decision::Proposal(proposal)) =
            card.task.decision.clone()
        else {
            return;
        };
        self.board.dialog = Some(Dialog::Proposal {
            card: key.into(),
            installation: card.installation.to_string(),
            proposal,
            as_of: card.as_of,
            seen: false,
            shown: [0.0, 0.0],
            end: f32::MAX,
        });
    }

    /// Where the proposal's text is shown, and where its end is: read to the end, it is seen.
    /// Whether this made the proposal read to its end.
    pub fn proposal_drawn(&mut self, shown: Option<[f32; 2]>, end: Option<f32>) -> bool {
        if let Some(Dialog::Proposal {
            seen,
            shown: at,
            end: last,
            ..
        }) = &mut self.board.dialog
        {
            if let Some(shown) = shown {
                *at = shown;
            }
            if let Some(end) = end {
                *last = end;
            }
            if !*seen && at[1] > 0.0 && *last <= at[0] + at[1] + 2.0 {
                *seen = true;
                return true;
            }
        }
        false
    }

    /// Confirm (`yes`) or Decline what was read, not whatever the card holds by now.
    pub fn decide(&mut self, yes: bool) {
        let Some(Dialog::Proposal { seen, .. }) = &self.board.dialog else {
            return;
        };
        if yes && !seen {
            return;
        }
        let Some(Dialog::Proposal {
            installation,
            proposal,
            as_of,
            ..
        }) = self.board.dialog.take()
        else {
            return;
        };
        let tag = if yes { "Confirm" } else { "Decline" };
        self.act(
            &installation,
            json!({"_tag": tag, "proposal": proposal.id, "hash": proposal.hash}),
            as_of,
            None,
        );
    }

    /// A dialog whose card has left the board closes, and a proposal's follows its card: a new
    /// one is read from the start, and one decided elsewhere is no longer asked.
    fn settle_dialog(&mut self) {
        let card = match &self.board.dialog {
            Some(
                Dialog::Words { card, .. }
                | Dialog::Offers { card, .. }
                | Dialog::Proposal { card, .. }
                | Dialog::Check { card },
            ) => card.clone(),
            _ => return,
        };
        let Some(placed) = self.placed_by(&card) else {
            self.board.dialog = None;
            return;
        };
        let now = match &placed.task.decision {
            Some(collie_desktop_protocol::generated::Decision::Proposal(p)) => Some(p.clone()),
            _ => None,
        };
        if let Some(Dialog::Proposal {
            proposal,
            seen,
            shown,
            end,
            ..
        }) = &mut self.board.dialog
        {
            match now {
                Some(now) if now.id == proposal.id => {
                    if now.hash != proposal.hash {
                        *proposal = now;
                        (*seen, *shown, *end) = (false, [0.0, 0.0], f32::MAX);
                    }
                }
                _ => self.board.dialog = None,
            }
        }
    }

    /// The question dialog for a card's open questions.
    pub fn answer_questions(&mut self, key: &str) {
        let Some(card) = self.placed_by(key) else {
            return;
        };
        let (installation, machine, title) = (
            card.installation.to_string(),
            card.machine.clone(),
            card.task.name.clone(),
        );
        let sitting = Sitting::starts(&answers::Now {
            installation: &installation,
            open: open_questions(card.task),
            answering: &self.board.answering,
        });
        self.board.dialog = Some(Dialog::Questions {
            card: key.into(),
            installation,
            machine,
            title,
            sitting,
        });
    }

    /// The questions a card has open now.
    fn open_of(&self, card: &str) -> Vec<Question> {
        self.placed_by(card)
            .map(|p| open_questions(p.task).into_iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The sitting sees the board and the answers as they now stand.
    fn sitting_sees(&mut self) {
        let Some(Dialog::Questions {
            card, installation, ..
        }) = &self.board.dialog
        else {
            return;
        };
        let open = self.open_of(card);
        let installation = installation.clone();
        let now_answering = self.board.answering.clone();
        if let Some(Dialog::Questions { sitting, .. }) = &mut self.board.dialog {
            let now = answers::Now {
                installation: &installation,
                open: open.iter().collect(),
                answering: &now_answering,
            };
            *sitting = sitting.sees(&now);
        }
    }

    pub fn move_sitting(&mut self, by: isize) {
        if let Some(Dialog::Questions { sitting, .. }) = &mut self.board.dialog {
            *sitting = sitting.moved(by);
        }
    }

    /// A question's questionnaire as it stands: one off the last board starts unseen.
    pub fn questionnaire_of(&self, installation: &str, question: &Question) -> Questionnaire {
        let key = answer_key(installation, &question.run, &question.id);
        if let Some(kept) = self.board.asking.get(&key) {
            return kept.clone();
        }
        let mut opened = Questionnaire::new(question.clone());
        if self
            .board
            .on_board
            .as_ref()
            .is_some_and(|keys| !keys.contains(&key))
        {
            opened.step(Event::Seen(None));
        }
        opened
    }

    /// Feeds a question's questionnaire one event, and carries what it sends.
    pub fn step_question(
        &mut self,
        installation: &str,
        machine: &str,
        question: &Question,
        event: Event,
    ) -> Option<Does> {
        let key = answer_key(installation, &question.run, &question.id);
        let mut asked = self.questionnaire_of(installation, question);
        let was_settled = asked.view().settled;
        let does = asked.step(event);
        self.board.asking.insert(key.clone(), asked);
        let does = match does {
            Some(Does::Submit) => {
                return self.step_question(
                    installation,
                    machine,
                    question,
                    Event::Submit(new_request()),
                );
            }
            Some(Does::Steer) => {
                return self.step_question(
                    installation,
                    machine,
                    question,
                    Event::Steer(new_request()),
                );
            }
            Some(Does::Close) => {
                self.board.dialog = None;
                return Some(Does::Close);
            }
            other => other,
        };
        if let Some(Does::Send { request, action }) = &does {
            let send = (action["_tag"] == "Answer").then(|| {
                self.board.sends += 1;
                let value = action["value"].as_str().unwrap_or_default();
                let shown = question
                    .options
                    .iter()
                    .find(|o| o.id == value)
                    .map_or_else(|| value.to_string(), |o| o.title.clone());
                self.board
                    .answering
                    .sent(&key, shown, machine.into(), self.board.sends);
                self.board.sends
            });
            let as_of = self
                .machines
                .iter()
                .find(|m| m.machine.installation == installation)
                .and_then(|m| m.as_of);
            let unsent = as_of.map(|at| {
                format!(
                    "its board is a saved one, {}",
                    as_of_said(at, self.offset())
                )
            });
            self.send(Again {
                installation: installation.into(),
                action: action.clone(),
                request: request.clone(),
                unsent,
                tried: Tried::Question {
                    installation: installation.into(),
                    question: Box::new(question.clone()),
                    send,
                },
            });
        }
        self.sitting_sees();
        // Answered: the dialog moves on to the next unanswered question.
        let settled = self
            .board
            .asking
            .get(&key)
            .is_some_and(|a| a.view().settled);
        if settled && !was_settled {
            self.sitting_answered();
        }
        does
    }

    fn sitting_answered(&mut self) {
        let Some(Dialog::Questions {
            card, installation, ..
        }) = &self.board.dialog
        else {
            return;
        };
        let open = self.open_of(card);
        let installation = installation.clone();
        let answering = self.board.answering.clone();
        let now = answers::Now {
            installation: &installation,
            open: open.iter().collect(),
            answering: &answering,
        };
        let Some(Dialog::Questions { sitting, .. }) = &mut self.board.dialog else {
            return;
        };
        *sitting = sitting.answered(&now);
        if sitting.view(&now).done {
            self.board.dialog = None;
        }
    }

    /// What is held for questions settles against every Task on the Flock's board.
    fn settle_answers(&mut self) {
        let placed = model::placed(&self.machines);
        let board: Vec<(&str, &collie_desktop_protocol::generated::Task)> =
            placed.iter().map(|p| (p.installation, p.task)).collect();
        let mut answering = std::mem::take(&mut self.board.answering);
        answering.settled(board.iter().copied());
        let open: HashMap<String, Question> = board
            .iter()
            .flat_map(|(installation, task)| {
                open_questions(task)
                    .into_iter()
                    .map(move |q| (answer_key(installation, &q.run, &q.id), q.clone()))
            })
            .collect();
        drop(placed);
        self.board.answering = answering;
        self.board.on_board = Some(open.keys().cloned().collect());
        for (key, asked) in self.board.asking.iter_mut() {
            let question = open.get(key).cloned();
            if question.as_ref() == Some(&asked.question) && asked.on_board {
                continue;
            }
            asked.step(Event::Seen(question.map(Box::new)));
        }
        self.sitting_sees();
    }
}
