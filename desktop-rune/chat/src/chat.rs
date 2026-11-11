//! The Flock chat's state, and what each thing the human does asks of Desktop's core.

use crate::agui::{Part, Transcript};
use crate::attachments::{Attached, cap_refusal, pasted_name};
use crate::choices::{
    ChatStatus, Draft, Queued, SetChoice, chat_announcement, choice_notices, refusal_said,
    remember_choice, stay_on, stop_draft,
};
use crate::host::{Host, Stop, ask, listen};
use crate::images;
use crate::policy::{Opened, opened};
use crate::words::questions_of;
use base64::Engine;
use collie_desktop_protocol::generated::{
    About, AguiEvent, ChatChoicesSuccess, Choice, Conversation, ConversationsSuccess,
    DesktopTurnsSuccess, FlockSettingsSuccess, SayPayload, SetSettingsPayload, SettingsSuccess,
    SetupInventorySuccessItem, StagedOrRefusedItem, StagedOrRefusedItem0, TranscriptSuccessItem,
};
use rune::edit::TextEdit;
use rune::{Pixels, Tx};
use rune_kit::ComboboxState;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

/// Sends the `n`th turn somewhere other than the core's `say`, and gives back what cancels it.
pub type Say = Box<dyn Fn(SayPayload, u64) -> Box<dyn FnOnce()>>;

/// The menu of the chat's that is open, one at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Open {
    Earlier,
    Harness,
    Effort,
}

/// The standing-direction offer as the chat holds it.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Setup {
    #[default]
    None,
    Offered,
    /// The human asked what reading their messages would read; none until it is listed.
    Asked(Option<Vec<SetupInventorySuccessItem>>),
}

/// How many bytes of a pasted image go to the core in one `stage` call.
const PART: usize = 1024 * 1024;

#[derive(Default)]
pub struct Chat {
    pub transcript: Transcript,
    pub composer: TextEdit,
    /// Routes turns elsewhere than the core's `say`, as a recorder or a test does.
    pub say: Option<Say>,
    /// The last link pressed that agent markdown may open.
    pub opened: Option<Opened>,
    /// Opens the platform's dialog for several files; Rune's own picks one where it is unset.
    pub pick: Option<Box<dyn Fn()>>,
    /// The platform reports no file drops (Wayland in winit 0.30).
    pub drops_unavailable: bool,
    /// The files the next message carries.
    pub attached: Vec<Attached>,
    /// Each image chip's thumbnail, by its file's id.
    pub thumbs: HashMap<String, Pixels>,
    /// Why the last files given were not all taken.
    pub refused: Option<String>,
    /// The board's card the next message is about (ADR-0012).
    pub about: Option<About>,
    /// Messages said while a turn was under way, sent in order once it ends.
    pub queue: Vec<Queued>,
    /// The conversation has been read from the core at least once.
    pub loaded: bool,
    loading: bool,
    /// The conversation changed under the chat, so it is read again once no turn streams.
    stale: bool,
    /// Desktop is telling the chat about News of its own.
    pub desktop_speaking: bool,
    pub settings: Option<SettingsSuccess>,
    pub choices: Option<ChatChoicesSuccess>,
    remembered: Option<SetChoice>,
    /// Why the last thing the human did in the chat was refused or failed, until dismissed or
    /// another choice is made.
    pub failed: Option<String>,
    /// The chat speaks first about News that matters, unless the Flock's setting says not.
    pub proactive: Option<bool>,
    pub earlier: Option<Result<ConversationsSuccess, String>>,
    pub menu: Option<Open>,
    pub model_menu: ComboboxState,
    pub setup: Setup,
    /// What a screen reader is told of the reply and the notices, once each.
    pub announcement: String,
    status: ChatStatus,
    /// The options picked for each question the chat asks, by tool call and question.
    pub picked: HashMap<String, BTreeMap<String, Vec<String>>>,
    pub answered: HashSet<String>,
    /// The tool rows and thoughts the human opened.
    pub expanded: HashSet<String>,
    /// Why the chat's subscriptions stopped, until they are taken again.
    pub trouble: Option<String>,
    /// When the stopped subscriptions are taken again on their own (epoch ms).
    pub retry_at: Option<f64>,
    /// Failures in a row since the core last answered, for the wait before the next try.
    failures: u32,
    /// The whole seconds the reconnect notice last said were left.
    said_left: Option<i64>,
    /// The log is scrolled up from its latest message.
    pub away: bool,
    /// Where the log's viewport ends, in window points.
    log_bottom: f32,
    /// The chat is in its own window, and this pane stands aside.
    pub popped: bool,
    /// This is the chat in its own window, not the pane beside the board.
    pub alone: bool,
    /// Asks the app to show the chat in its own window, or back beside the board.
    pub pop: Option<Box<dyn Fn(bool)>>,
    /// The message whose words were copied last.
    pub copied: Option<String>,
    turn: Option<Box<dyn FnOnce()>>,
    turns: u64,
    /// The turn whose events are still heard; none once it is cancelled.
    live: Option<u64>,
    queued: u64,
    subscriptions: Vec<Stop>,
}

impl Chat {
    /// Makes the chip the board's selection, or clears it.
    pub fn choose(&mut self, about: Option<About>) {
        self.about = about;
    }

    /// The log's viewport was laid out ending at `bottom`.
    pub fn log_laid_out(&mut self, bottom: f32) {
        self.log_bottom = bottom;
    }

    /// The log's end was laid out at `end`; says whether that moves it into or out of view.
    pub fn end_laid_out(&mut self, end: f32) -> bool {
        // A little slack, so a fraction of a line under the edge still counts as the latest.
        let away = end > self.log_bottom + 24.0;
        let changed = away != self.away;
        self.away = away;
        changed
    }

    /// The whole seconds until the subscriptions are taken again, as the notice says them.
    pub fn retry_in(&self, now: f64) -> Option<i64> {
        self.retry_at
            .map(|at| ((at - now) / 1000.0).ceil().max(0.0) as i64)
    }

    pub fn settings(&self) -> SettingsSuccess {
        self.settings.clone().unwrap_or(SettingsSuccess {
            proactive: None,
            gitlab_host: None,
            machine_rule: None,
            zoom: None,
            chat_harness: None,
            chat_model: None,
            chat_effort: None,
            chat_width: None,
            record_timing: None,
            setup_not_now: None,
            setup_never: None,
        })
    }

    /// The draft as the composer holds it: words, files and chip.
    fn draft(&self) -> Draft {
        Draft {
            text: self.composer.text.trim().to_string(),
            files: self.attached.clone(),
            about: self.about.clone(),
        }
    }

    fn clear_draft(&mut self) {
        self.composer.clear();
        self.attached.clear();
        self.about = None;
        self.refused = None;
    }

    /// Starts a turn of the human's message; the core's `say` carries it unless `say` routes it.
    fn begin(&mut self, draft: Draft, now: bool) -> Option<(SayPayload, u64)> {
        self.transcript
            .said_with(&draft.text, draft.files.clone(), draft.about.clone());
        self.turns += 1;
        self.live = Some(self.turns);
        let payload = SayPayload {
            text: draft.text,
            about: draft.about,
            now: Some(now),
            attachments: Some(draft.files.iter().map(|f| f.id.clone()).collect())
                .filter(|a: &Vec<String>| !a.is_empty()),
        };
        match &self.say {
            Some(say) => {
                self.turn = Some(say(payload, self.turns));
                None
            }
            None => Some((payload, self.turns)),
        }
    }

    /// Says the composer's message through `say`, queued while a turn is under way.
    pub fn send(&mut self) {
        let draft = self.draft();
        if draft.text.is_empty() && draft.files.is_empty() {
            return;
        }
        self.clear_draft();
        if self.transcript.running {
            self.enqueue(draft);
        } else {
            self.begin(draft, false);
        }
    }

    fn enqueue(&mut self, draft: Draft) {
        self.queued += 1;
        self.queue.push(Queued {
            id: self.queued,
            text: draft.text,
            files: draft.files,
            about: draft.about,
        });
    }

    pub fn unqueue(&mut self, id: u64) {
        self.queue.retain(|q| q.id != id);
    }

    /// Applies an event of the `turn`th turn, unless that turn was cancelled or replaced;
    /// says whether it did.
    pub fn heard(&mut self, turn: u64, event: Result<AguiEvent, String>) -> bool {
        if self.live != Some(turn) {
            return false;
        }
        match event {
            Ok(event) => self.transcript.apply(event),
            Err(error) => {
                self.transcript.error = Some(error);
                self.transcript.running = false;
            }
        }
        if !self.transcript.running {
            self.turn = None;
        }
        true
    }

    /// Ends the turn under way where the human stopped it; what came stays.
    pub fn cancel(&mut self) {
        if let Some(cancel) = self.turn.take() {
            cancel();
        }
        self.live = None;
        self.transcript.stop();
    }

    /// Stop: the reply ends, and what was queued comes back to the composer.
    pub fn stop(&mut self) {
        let before = self.status();
        let recovered = stop_draft(&self.queue, self.draft());
        self.queue.clear();
        self.composer = TextEdit::new(&recovered.text);
        self.composer.focused = true;
        self.attached = recovered.files;
        self.about = recovered.about;
        self.cancel();
        self.announce_after(Some(before), true);
    }

    pub fn remove_file(&mut self, id: &str) {
        self.attached.retain(|f| f.id != id);
        self.thumbs.remove(id);
    }

    /// The reply and notices as a screen reader is told of them.
    fn status(&self) -> ChatStatus {
        let notices = choice_notices(&self.settings(), self.choices.as_ref());
        ChatStatus {
            replying: self.transcript.running,
            notices: notices
                .waiting
                .map(|w| w.text)
                .into_iter()
                .chain(notices.reply.map(|r| r.text))
                .collect(),
        }
    }

    fn announce_after(&mut self, before: Option<ChatStatus>, stopped: bool) {
        let after = self.status();
        let said = chat_announcement(before.as_ref(), &after, stopped);
        if !said.is_empty() {
            self.announcement = said;
        }
        self.status = after;
    }

    /// Announces what changed since the last announcement.
    pub fn announce(&mut self) {
        let before = self.status.clone();
        self.announce_after(Some(before), false);
    }

    /// Files the core copied in, held to the message's cap.
    fn took(&mut self, staged: Vec<StagedOrRefusedItem>, also: Vec<String>) {
        let mut said = also;
        for item in staged {
            match item {
                StagedOrRefusedItem::StagedOrRefusedItem1(no) => said.push(no.refused),
                StagedOrRefusedItem::StagedOrRefusedItem0(file) => {
                    if let Some(why) = cap_refusal(&self.attached, &file.name, file.size) {
                        said.push(why);
                        continue;
                    }
                    self.hold(&file, None);
                }
            }
        }
        self.refused = (!said.is_empty()).then(|| said.join(" "));
    }

    fn hold(&mut self, file: &StagedOrRefusedItem0, bytes: Option<&[u8]>) {
        if self.attached.iter().any(|f| f.id == file.id) {
            return;
        }
        if file.media_type.starts_with("image/") {
            let read = bytes
                .map(<[u8]>::to_vec)
                .or_else(|| std::fs::read(&file.path).ok());
            if let Some((w, h, rgba)) = read.as_deref().and_then(images::thumbnail) {
                let pixels = Pixels::new();
                pixels.set(w, h, rgba);
                self.thumbs.insert(file.id.clone(), pixels);
            }
        }
        self.attached.push(Attached::from(file));
    }

    /// A tool row or thought opened or closed.
    pub fn toggle(&mut self, key: &str) {
        if !self.expanded.remove(key) {
            self.expanded.insert(key.into());
        }
    }

    /// Picks `label` for `question` of the tool call `id`: one only, or one more of many.
    pub fn pick_option(&mut self, id: &str, question: &str, label: &str, many: bool) {
        let picks = self.picked.entry(id.into()).or_default();
        let now = picks.entry(question.into()).or_default();
        if !many {
            *now = vec![label.into()];
        } else if let Some(at) = now.iter().position(|l| l == label) {
            now.remove(at);
        } else {
            now.push(label.into());
        }
    }

    /// The answers to the questions of tool call `id`, once each has a pick.
    pub fn answers(&self, id: &str, args: &str) -> Option<BTreeMap<String, String>> {
        let picks = self.picked.get(id)?;
        questions_of(args)
            .iter()
            .map(|q| {
                let picked = picks.get(&q.question).filter(|p| !p.is_empty())?;
                Some((q.question.clone(), picked.join(", ")))
            })
            .collect()
    }
}

/// The turns the chat started that the core's `say` carries.
fn start<S: Host>(s: &mut S, begun: Option<(SayPayload, u64)>) {
    let Some((payload, turn)) = begun else {
        return;
    };
    let stop = listen(
        s,
        "say",
        payload,
        move |s: &mut S, event: Result<AguiEvent, String>| heard(s, turn, event),
    );
    s.chat_mut().turn = stop.map(|stop| stop as Box<dyn FnOnce()>);
}

/// An event of the `turn`th turn; once the turn ends, the next queued message goes.
pub fn heard<S: Host>(s: &mut S, turn: u64, event: Result<AguiEvent, String>) {
    let chunk = matches!(event, Ok(AguiEvent::TextMessageContent(_)));
    let chat = s.chat_mut();
    let was = chat.status.clone();
    if !chat.heard(turn, event) {
        return;
    }
    if chunk {
        s.heard_chunk(turn);
    }
    let chat = s.chat_mut();
    chat.announce_after(Some(was), false);
    if !chat.transcript.running {
        next_queued(s);
        maybe_reload(s);
    }
}

fn next_queued<S: Host>(s: &mut S) {
    let chat = s.chat_mut();
    if chat.transcript.running || chat.queue.is_empty() {
        return;
    }
    let next = chat.queue.remove(0);
    let begun = chat.begin(
        Draft {
            text: next.text,
            files: next.files,
            about: next.about,
        },
        false,
    );
    start(s, begun);
}

/// Sends the composer's message: queued while a turn is under way, or `now`, interrupting it.
pub fn send<S: Host>(s: &mut S, now: bool) {
    let chat = s.chat_mut();
    let draft = chat.draft();
    if draft.text.is_empty() && draft.files.is_empty() {
        return;
    }
    let before = chat.status.clone();
    chat.clear_draft();
    // Send may have been pressed, so the next message is typed without a click first.
    chat.composer.focused = true;
    if chat.transcript.running && !now {
        chat.enqueue(draft);
        return;
    }
    if chat.transcript.running {
        chat.cancel();
    }
    let begun = chat.begin(draft, now);
    chat.announce_after(Some(before), false);
    start(s, begun);
}

/// Sends the failed turn's message again.
pub fn retry<S: Host>(s: &mut S) {
    let chat = s.chat_mut();
    let Some(last) = chat.transcript.last_said().cloned() else {
        return;
    };
    if chat.transcript.running {
        return;
    }
    let files = last
        .parts
        .iter()
        .filter_map(|p| match p {
            Part::Attached(file) => Some(file.clone()),
            _ => None,
        })
        .collect();
    let begun = chat.begin(
        Draft {
            text: last.text(),
            files,
            about: last.about.clone(),
        },
        false,
    );
    start(s, begun);
}

/// Reads the conversation from the core and subscribes to what changes it.
pub fn open<S: Host>(s: &mut S) {
    if !s.chat().subscriptions.is_empty() {
        return;
    }
    let chat = s.chat_mut();
    chat.trouble = None;
    chat.retry_at = None;
    chat.said_left = None;
    let mut subscriptions = Vec::new();
    subscriptions.extend(listen(s, "settings", (), |s: &mut S, v| {
        held(s, v, |chat, settings: SettingsSuccess| {
            chat.settings = Some(settings);
            chat.remembered = remember_choice(
                chat.remembered.take(),
                &chat.settings(),
                chat.choices.as_ref(),
            );
            chat.announce();
        });
    }));
    subscriptions.extend(listen(s, "chatChoices", (), |s: &mut S, v| {
        held(s, v, |chat, choices: ChatChoicesSuccess| {
            chat.remembered =
                remember_choice(chat.remembered.take(), &chat.settings(), Some(&choices));
            chat.choices = Some(choices);
            chat.announce();
        });
    }));
    subscriptions.extend(listen(s, "flockSettings", (), |s: &mut S, v| {
        held(s, v, |chat, flock: FlockSettingsSuccess| {
            let set = flock.settings.get("flock_chat.proactive");
            chat.proactive = Some(set.and_then(|s| s.value.as_ref()) != Some(&Value::Bool(false)));
        });
    }));
    subscriptions.extend(listen(s, "conversationChanges", (), |s: &mut S, v| {
        if held(s, v, |chat, _: String| chat.stale = true) {
            maybe_reload(s);
        }
    }));
    subscriptions.extend(listen(s, "desktopTurns", (), |s: &mut S, v| {
        if held(s, v, |chat, turn: DesktopTurnsSuccess| {
            chat.desktop_speaking = turn == DesktopTurnsSuccess::Started;
            if !chat.desktop_speaking {
                chat.stale = true;
            }
        }) {
            maybe_reload(s);
        }
    }));
    subscriptions.extend(listen(s, "setupOffer", (), |s: &mut S, v| {
        held(s, v, |chat, offered: bool| {
            chat.setup = match (offered, &chat.setup) {
                (false, _) => Setup::None,
                (true, Setup::None) => Setup::Offered,
                (true, kept) => kept.clone(),
            };
        });
    }));
    subscriptions.extend(listen(
        s,
        "setupChosen",
        (),
        |s: &mut S, v: Result<Option<Choice>, String>| {
            if let Ok(Some(_)) = v {
                take_setup(s);
            }
        },
    ));
    s.chat_mut().subscriptions = subscriptions;
    reload(s);
}

/// What a subscription told, applied; or why it stopped, kept for the chat to say.
fn held<S: Host, A>(s: &mut S, value: Result<A, String>, apply: impl FnOnce(&mut Chat, A)) -> bool {
    match value {
        Ok(value) => {
            s.chat_mut().failures = 0;
            apply(s.chat_mut(), value);
            true
        }
        Err(why) => {
            let chat = s.chat_mut();
            chat.retry_at = Some(epoch_ms() + backoff(chat.failures));
            chat.failures += 1;
            chat.trouble = Some(why);
            false
        }
    }
}

/// `min(1 s × 2^failures, 60 s)`, as `backoff` in `src/peers-model.ts`.
pub fn backoff(failures: u32) -> f64 {
    (1000.0 * 2f64.powi(failures.min(16) as i32)).min(60_000.0)
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// The app's clock at `now` (epoch ms): stopped subscriptions are taken again once their wait
/// is over. Says whether anything the chat shows changed.
pub fn tick<S: Host>(s: &mut S, now: f64) -> bool {
    let chat = s.chat_mut();
    if chat.trouble.is_none() {
        return false;
    }
    if chat.retry_at.is_some_and(|at| at <= now) {
        reconnect(s);
        return true;
    }
    let left = chat.retry_in(now);
    let changed = left != chat.said_left;
    chat.said_left = left;
    changed
}

/// Subscribes again after the subscriptions stopped.
pub fn reconnect<S: Host>(s: &mut S) {
    for stop in std::mem::take(&mut s.chat_mut().subscriptions) {
        stop();
    }
    open(s);
}

/// Ends the chat's subscriptions and any turn, as its window closes.
pub fn close<S: Host>(s: &mut S) {
    let chat = s.chat_mut();
    for stop in std::mem::take(&mut chat.subscriptions) {
        stop();
    }
    chat.cancel();
}

fn maybe_reload<S: Host>(s: &mut S) {
    let chat = s.chat();
    if chat.stale && !chat.transcript.running && !chat.desktop_speaking {
        reload(s);
    }
}

/// The conversation as the core keeps it.
pub fn reload<S: Host>(s: &mut S) {
    let chat = s.chat_mut();
    if chat.loading {
        return;
    }
    chat.loading = true;
    chat.stale = false;
    ask(
        s,
        "transcript",
        (),
        |s: &mut S, read: Result<Vec<TranscriptSuccessItem>, String>| {
            let chat = s.chat_mut();
            chat.loading = false;
            match read {
                Ok(items) if !chat.transcript.running => {
                    chat.transcript.replace(items);
                    chat.loaded = true;
                }
                Ok(_) => chat.stale = true,
                Err(why) => {
                    chat.loaded = true;
                    chat.trouble = Some(why);
                }
            }
            maybe_reload(s);
        },
    );
}

/// Lists the earlier conversations, as the history menu opens.
pub fn list_earlier<S: Host>(s: &mut S) {
    let chat = s.chat_mut();
    chat.menu = Some(Open::Earlier);
    chat.earlier = None;
    ask(
        s,
        "conversations",
        (),
        |s: &mut S, listed: Result<ConversationsSuccess, String>| {
            s.chat_mut().earlier = Some(listed);
        },
    );
}

/// Makes that conversation current, or a fresh one, and shows it.
pub fn reopen<S: Host>(s: &mut S, conversation: Option<Conversation>) {
    let chat = s.chat_mut();
    chat.menu = None;
    chat.cancel();
    chat.queue.clear();
    ask(
        s,
        "reopen",
        json!({ "conversation": conversation }),
        |s: &mut S, done: Result<Value, String>| match done {
            Ok(_) => {
                let chat = s.chat_mut();
                chat.transcript = Transcript::default();
                chat.loaded = false;
                chat.stale = true;
                reload(s);
            }
            Err(why) => s.chat_mut().failed = Some(why),
        },
    );
}

/// Saves a harness, model or effort choice; why not, where the core refuses it.
pub fn choose_setting<S: Host>(s: &mut S, change: SetSettingsPayload) {
    let chat = s.chat_mut();
    chat.failed = None;
    chat.menu = None;
    chat.model_menu.close();
    chat.composer.focused = true;
    ask(
        s,
        "setSettings",
        change,
        |s: &mut S, saved: Result<SettingsSuccess, String>| {
            let chat = s.chat_mut();
            match saved {
                Ok(settings) => chat.settings = Some(settings),
                Err(why) => chat.failed = Some(refusal_said(&why)),
            }
        },
    );
}

/// Stay on the conversation's harness, with the choice last seen there.
pub fn stay<S: Host>(s: &mut S) {
    let Some(choices) = s.chat().choices.as_ref() else {
        return;
    };
    let change = stay_on(choices, s.chat().remembered.as_ref());
    choose_setting(s, change);
}

pub fn set_proactive<S: Host>(s: &mut S, proactive: bool) {
    let was = s.chat().proactive;
    s.chat_mut().proactive = Some(proactive);
    ask(
        s,
        "setFlockSetting",
        json!({ "key": "flock_chat.proactive", "value": proactive.to_string() }),
        move |s: &mut S, said: Result<String, String>| {
            if let Err(why) = said {
                let chat = s.chat_mut();
                chat.proactive = was;
                chat.failed = Some(why);
            }
        },
    );
}

/// Answers the question the chat asked in tool call `id`.
pub fn answer<S: Host>(s: &mut S, id: &str, args: &str) {
    let Some(answers) = s.chat().answers(id, args) else {
        return;
    };
    s.chat_mut().answered.insert(id.into());
    let id = id.to_string();
    ask(
        s,
        "answer",
        json!({ "toolCallId": id, "answers": answers }),
        move |s: &mut S, done: Result<Value, String>| {
            if let Err(why) = done {
                let chat = s.chat_mut();
                chat.answered.remove(&id);
                chat.failed = Some(why);
            }
        },
    );
}

/// Picks an option; one question with one choice is answered by the pick.
pub fn pick_option<S: Host>(s: &mut S, id: &str, args: &str, question: &str, label: &str) {
    let questions = questions_of(args);
    let many = questions
        .iter()
        .find(|q| q.question == question)
        .is_some_and(|q| q.multi_select);
    s.chat_mut().pick_option(id, question, label, many);
    if questions.len() == 1 && !many {
        answer(s, id, args);
    }
}

/// Opens a link agent markdown may open, through the core.
pub fn follow<S: Host>(s: &mut S, url: &str) {
    let Some(target) = opened(url) else {
        return;
    };
    s.chat_mut().opened = Some(target.clone());
    if let Opened::Web(url) = target {
        ask(
            s,
            "openLink",
            json!({ "url": url }),
            |s: &mut S, done: Result<Value, String>| {
                if let Err(why) = done {
                    s.chat_mut().failed = Some(why);
                }
            },
        );
    }
}

/// Files named by path, as a dialog, a file manager or a drop gives them.
pub fn stage_paths<S: Host>(s: &mut S, paths: Vec<PathBuf>, also: Vec<String>) {
    if paths.is_empty() {
        if !also.is_empty() {
            s.chat_mut().refused = Some(also.join(" "));
        }
        return;
    }
    let paths: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    ask(
        s,
        "stagePaths",
        json!({ "paths": paths }),
        move |s: &mut S, staged: Result<Vec<StagedOrRefusedItem>, String>| match staged {
            Ok(staged) => s.chat_mut().took(staged, also),
            Err(why) => s.chat_mut().refused = Some(why),
        },
    );
}

/// The files a dialog lets the human choose: several through the platform's, else one.
pub fn pick<S: Host>(s: &mut S, tx: &mut Tx) {
    if let Some(pick) = &s.chat().pick {
        pick();
        return;
    }
    let options = rune::FileDialogOptions {
        title: "Attach files".into(),
        ..Default::default()
    };
    tx.open_file(options, |s: &mut S, chosen, _| match chosen {
        Ok(Some(path)) => stage_paths(s, vec![path], Vec::new()),
        Ok(None) => {}
        Err(why) => s.chat_mut().refused = Some(why.to_string()),
    });
}

/// What the platform's dialog chose.
pub fn picked<S: Host>(s: &mut S, chosen: Result<Vec<PathBuf>, String>) {
    match chosen {
        Ok(paths) => stage_paths(s, paths, Vec::new()),
        Err(why) => s.chat_mut().refused = Some(why),
    }
}

/// A pasted image, staged in parts with a copy scaled for the model where it is large.
pub fn stage_image<S: Host>(s: &mut S, png: Vec<u8>, at_iso: &str) {
    let name = pasted_name(at_iso, "image/png");
    if let Some(why) = cap_refusal(&s.chat().attached, &name, png.len() as f64) {
        s.chat_mut().refused = Some(why);
        return;
    }
    s.chat_mut().refused = None;
    let key = format!("{}-{}", at_iso, png.len());
    send_part(s, key, name, png, 0, None);
}

fn send_part<S: Host>(
    s: &mut S,
    key: String,
    name: String,
    bytes: Vec<u8>,
    offset: usize,
    scaled_of: Option<String>,
) {
    let end = (offset + PART).min(bytes.len());
    let content = base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end]);
    let mut payload = json!({
        "key": key, "name": name, "mediaType": "image/png", "size": bytes.len(),
        "offset": offset, "content": content,
    });
    if let Some(of) = &scaled_of {
        payload["scaledOf"] = json!(of);
    }
    ask(
        s,
        "stage",
        payload,
        move |s: &mut S, staged: Result<Option<StagedOrRefusedItem0>, String>| match staged {
            Err(_) => s.chat_mut().refused = Some(format!("{name} could not be attached")),
            Ok(None) if end < bytes.len() => send_part(s, key, name, bytes, end, scaled_of),
            Ok(None) => s.chat_mut().refused = Some(format!("{name} could not be attached")),
            Ok(Some(staged)) if scaled_of.is_none() => {
                if let Some(smaller) = images::scaled_png(&bytes) {
                    let key = format!("{key}-scaled");
                    send_part(
                        s,
                        key,
                        staged.name.clone(),
                        smaller,
                        0,
                        Some(staged.id.clone()),
                    );
                }
                s.chat_mut().hold(&staged, Some(&bytes));
            }
            Ok(Some(_)) => {}
        },
    );
}

/// A paste of the clipboard's files when the paste itself named none.
pub fn clipboard_files<S: Host>(s: &mut S) {
    ask(
        s,
        "clipboardFiles",
        (),
        |s: &mut S, staged: Result<Vec<StagedOrRefusedItem>, String>| match staged {
            Ok(staged) => s.chat_mut().took(staged, Vec::new()),
            Err(why) => s.chat_mut().refused = Some(why),
        },
    );
}

/// "Not now", or "Don't ask again" `for_good`.
pub fn decline_setup<S: Host>(s: &mut S, for_good: bool) {
    s.chat_mut().setup = Setup::None;
    ask(
        s,
        "declineSetup",
        json!({ "forGood": for_good }),
        |s: &mut S, done: Result<Value, String>| {
            if let Err(why) = done {
                s.chat_mut().failed = Some(why);
            }
        },
    );
}

/// Shows what reading the human's messages would read.
pub fn ask_setup<S: Host>(s: &mut S) {
    s.chat_mut().setup = Setup::Asked(None);
    ask(
        s,
        "setupInventory",
        (),
        |s: &mut S, found: Result<Vec<SetupInventorySuccessItem>, String>| {
            let chat = s.chat_mut();
            if !matches!(chat.setup, Setup::Asked(_)) {
                return;
            }
            match found {
                Ok(found) => chat.setup = Setup::Asked(Some(found)),
                Err(why) => {
                    chat.setup = Setup::Offered;
                    chat.failed = Some(why);
                }
            }
        },
    );
}

/// The human's choice of how to write the Standing direction, which the chat takes up.
pub fn choose_setup<S: Host>(s: &mut S, choice: Choice) {
    s.chat_mut().setup = Setup::None;
    ask(
        s,
        "chooseSetup",
        json!({ "choice": choice }),
        |s: &mut S, done: Result<Value, String>| {
            if let Err(why) = done {
                s.chat_mut().failed = Some(why);
            }
        },
    );
}

/// Takes the waiting setup choice, if this chat is the one to, and starts its conversation.
fn take_setup<S: Host>(s: &mut S) {
    ask(
        s,
        "takeSetup",
        (),
        |s: &mut S, taken: Result<Option<Choice>, String>| {
            let Ok(Some(choice)) = taken else {
                return;
            };
            let chat = s.chat_mut();
            chat.cancel();
            chat.queue.clear();
            chat.transcript = Transcript::default();
            chat.transcript.say("Help me write my Standing direction.");
            chat.turns += 1;
            let turn = chat.turns;
            chat.live = Some(turn);
            let stop = listen(
                s,
                "setUp",
                json!({ "choice": choice }),
                move |s: &mut S, event| heard(s, turn, event),
            );
            s.chat_mut().turn = stop.map(|stop| stop as Box<dyn FnOnce()>);
        },
    );
}

/// Shows the chat in its own window (`out`), or back beside the board; not while a reply
/// streams, which would be cut off.
pub fn pop<S: Host>(s: &mut S, out: bool) {
    let chat = s.chat_mut();
    if out && chat.transcript.running {
        return;
    }
    chat.menu = None;
    chat.model_menu.close();
    chat.popped = out;
    if let Some(pop) = &chat.pop {
        pop(out);
    }
    s.popped(out);
    if !out {
        reload(s);
    }
}

/// The chat's own window closed, so the chat is shown beside the board again.
pub fn came_back<S: Host>(s: &mut S) {
    if !s.chat().popped {
        return;
    }
    s.chat_mut().popped = false;
    s.popped(false);
    reload(s);
}

/// Copies a message's words.
pub fn copy<S: Host>(s: &mut S, tx: &mut Tx, id: &str, text: String) {
    tx.copy(text);
    s.chat_mut().copied = Some(id.into());
}
