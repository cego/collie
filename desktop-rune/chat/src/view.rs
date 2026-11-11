//! The Flock chat and a Run's Diff tab as Rune draws them.

use crate::agui::{Part, Role, Transcript};
use crate::highlight::syntect;
use crate::policy::{Opened, confined, opened};
use crate::review::{Draft, add_draft, compose, diff_anchor, remove_draft};
use collie_desktop_protocol::generated::{AguiEvent, SayPayload};
use rune::edit::TextEdit;
use rune::{ClipboardContent, El, FileDialogOptions, col, row, text, text_input};
use rune_kit::diff::{DiffMode, DiffState, DiffView, FileDiff};
use rune_kit::markdown::Markdown;
use rune_kit::syntax::Highlighter;
use rune_kit::{Button, ButtonVariant, Kit, SegmentedControl, TextInput};
use std::path::PathBuf;

/// Sends the `n`th turn to the core, and gives back what cancels it.
pub type Say = Box<dyn Fn(SayPayload, u64) -> Box<dyn FnOnce()>>;

#[derive(Default)]
pub struct Chat {
    pub transcript: Transcript,
    pub composer: TextEdit,
    /// Code blocks are coloured by syntect and two-face, not rune-kit's own highlighter.
    pub syntect: bool,
    pub say: Option<Say>,
    /// The last link pressed that agent markdown may open.
    pub opened: Option<Opened>,
    /// Hands files to the main process's `stagePaths`.
    pub stage: Option<Box<dyn Fn(Vec<PathBuf>)>>,
    /// The platform reports no file drops (Wayland in winit 0.30).
    pub drops_unavailable: bool,
    /// What `stagePaths` copied in, for the next turn.
    pub attached: Vec<String>,
    turn: Option<Box<dyn FnOnce()>>,
    turns: u64,
    /// The turn whose events are still heard; none once it is cancelled.
    live: Option<u64>,
}

impl Chat {
    pub fn send(&mut self) {
        let said = self.composer.text.trim().to_string();
        if said.is_empty() || self.transcript.running {
            return;
        }
        self.transcript.say(&said);
        self.composer.clear();
        if let Some(say) = &self.say {
            self.turns += 1;
            self.live = Some(self.turns);
            self.turn = Some(say(
                SayPayload {
                    text: said,
                    about: None,
                    now: None,
                    attachments: Some(std::mem::take(&mut self.attached)).filter(|a| !a.is_empty()),
                },
                self.turns,
            ));
        }
    }

    pub fn stage(&self, paths: Vec<PathBuf>) {
        if let (Some(stage), false) = (&self.stage, paths.is_empty()) {
            stage(paths);
        }
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
        true
    }

    pub fn cancel(&mut self) {
        if let Some(cancel) = self.turn.take() {
            cancel();
        }
        self.live = None;
        self.transcript.stop();
    }
}

fn highlighter(chat: &Chat) -> Highlighter {
    if chat.syntect {
        Highlighter::new(syntect)
    } else {
        Highlighter::builtin()
    }
}

fn part<S: 'static>(
    k: &Kit,
    chat: &Chat,
    lens: fn(&mut S) -> &mut Chat,
    part: &Part,
    live: bool,
) -> El {
    match part {
        Part::Text(said) => Markdown::new(confined(said))
            .streaming(live)
            .highlighter(highlighter(chat))
            .on_link(move |s: &mut S, url: &str| lens(s).opened = opened(url))
            .build(k),
        Part::Thinking(thought) => text(thought.clone())
            .font(k.ty.body)
            .color(k.c.text_muted)
            .wrap()
            .max_lines(3)
            .w_full(),
        Part::ToolCall {
            id,
            name,
            arguments,
            output,
        } => col()
            .key(format!("tool-{id}"))
            .gap(4.0)
            .padding(8.0)
            .radius(6.0)
            .fill(k.c.layer_01)
            .child(
                text(name.clone())
                    .font(k.ty.ui_medium)
                    .color(k.c.text_strong),
            )
            .child(
                text(arguments.clone())
                    .font(k.ty.mono)
                    .color(k.c.text_muted)
                    .wrap()
                    .w_full(),
            )
            .children(output.iter().map(|out| {
                text(out.clone())
                    .font(k.ty.mono)
                    .color(k.c.text_base)
                    .wrap()
                    .max_lines(8)
                    .w_full()
            })),
    }
}

pub fn chat<S: 'static>(chat: &Chat, lens: fn(&mut S) -> &mut Chat, k: &Kit) -> El {
    let last = chat.transcript.messages.len().saturating_sub(1);
    let messages = chat
        .transcript
        .messages
        .iter()
        .enumerate()
        .map(|(at, message)| {
            let live = chat.transcript.running && at == last;
            let bubble = col()
                .key(format!("message-{at}"))
                .role("article")
                .gap(8.0)
                .padding(12.0)
                .radius(8.0)
                .w_full()
                .children(message.parts.iter().map(|p| part(k, chat, lens, p, live)));
            match message.role {
                Role::User => bubble.fill(k.c.layer_02),
                Role::Assistant => bubble,
            }
        });
    let error = chat.transcript.error.iter().map(|why| {
        text(why.clone())
            .key("chat-error")
            .role("alert")
            .label(why.clone())
            .color(k.c.text_strong)
            .wrap()
            .w_full()
    });
    let attach = Button::new("Attach files")
        .variant(ButtonVariant::Ghost)
        .on_press_tx(move |_: &mut S, tx| {
            tx.open_file(FileDialogOptions::default(), move |s: &mut S, chosen, _| {
                if let Ok(Some(path)) = chosen {
                    lens(s).stage(vec![path]);
                }
            })
        })
        .build(k)
        .key("attach");
    let drops_unavailable = chat.drops_unavailable.then(|| {
        let said = "Dropping files isn't available here. Attach or paste them instead.";
        text(said)
            .key("drops-unavailable")
            .role("status")
            .label(said)
            .font(k.ty.small)
            .color(k.c.text_muted)
            .wrap()
            .grow(1.0)
    });
    // rune-kit's TextInput hides its field, so `on_input_paste` needs Rune's own.
    let composer = text_input(&chat.composer, k.ty.ui_compact)
        .single_line()
        .placeholder("Ask the Flock", k.c.text_faint)
        .label("Ask the Flock")
        .color(k.c.text_base)
        .caret(k.c.text_base, k.selection())
        .on_edit(move |s: &mut S| &mut lens(s).composer)
        .on_submit(move |s: &mut S, _| lens(s).send())
        .on_input_paste(move |s: &mut S, pasted, _| {
            let paths = pasted_paths(pasted);
            let staged = !paths.is_empty();
            lens(s).stage(paths);
            staged
        })
        .key("composer")
        .padding(6.0)
        .radius(6.0)
        .fill(k.c.layer_01)
        .grow(1.0);
    let action = if chat.transcript.running {
        Button::new("Stop")
            .variant(ButtonVariant::Danger)
            .on_press(move |s: &mut S| lens(s).cancel())
            .build(k)
            .key("stop")
    } else {
        Button::new("Send")
            .on_press(move |s: &mut S| lens(s).send())
            .build(k)
            .key("send")
    };
    let colours = SegmentedControl::new(&["rune-kit", "syntect"], Some(chat.syntect as usize))
        .label("Code colours")
        .on_pick(move |s: &mut S, at, _| lens(s).syntect = at == 1)
        .build(k)
        .key("highlighter");
    col()
        .key("chat")
        .on_drop_files(move |s: &mut S, files, _| lens(s).stage(files.to_vec()))
        .gap(12.0)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(
            col()
                .key("chat-log")
                .role("log")
                .label("Flock chat")
                .gap(8.0)
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: true })
                .children(messages)
                .children(error),
        )
        .child(
            row()
                .gap(8.0)
                .center_y()
                .w_full()
                .child(attach)
                .child(composer)
                .child(action),
        )
        .child(
            row()
                .gap(8.0)
                .center_y()
                .w_full()
                .justify_end()
                .children(drops_unavailable)
                .child(colours),
        )
}

/// The files a paste carries: the clipboard's own list, or text that is only `file://` URIs.
pub fn pasted_paths(pasted: &ClipboardContent) -> Vec<PathBuf> {
    if !pasted.files().is_empty() {
        return pasted.files().to_vec();
    }
    let uris: Vec<&str> = pasted
        .text()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let paths: Vec<PathBuf> = uris
        .iter()
        .filter_map(|uri| uri.trim().strip_prefix("file://"))
        .map(|path| PathBuf::from(percent_decoded(path)))
        .collect();
    if paths.len() == uris.len() {
        paths
    } else {
        Vec::new()
    }
}

fn percent_decoded(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[at], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub struct DiffTab {
    pub state: DiffState,
    pub drafts: Vec<Draft>,
    pub comment: TextEdit,
    /// Counts the drafts made, for their ids.
    pub made: u64,
    /// The Delivery text the drafts compose, once asked for.
    pub delivery: Option<String>,
}

impl DiffTab {
    pub fn new(files: Vec<FileDiff>) -> DiffTab {
        DiffTab {
            state: DiffState::new(files),
            drafts: Vec::new(),
            comment: TextEdit::default(),
            made: 0,
            delivery: None,
        }
    }

    pub fn add_comment(&mut self) {
        let said = self.comment.text.trim().to_string();
        let Some(anchor) = diff_anchor(&self.state).filter(|_| !said.is_empty()) else {
            return;
        };
        self.made += 1;
        let draft = Draft {
            id: self.made.to_string(),
            anchor,
            text: said,
        };
        self.drafts = add_draft(&self.drafts, draft);
        self.comment.clear();
        self.state.set_selection(None);
    }
}

pub fn diff_tab<S: 'static>(
    s: &S,
    get: fn(&S) -> &DiffTab,
    get_mut: fn(&mut S) -> &mut DiffTab,
    k: &Kit,
) -> El {
    let tab = get(s);
    let split = tab.state.mode() == DiffMode::Split;
    let mode = SegmentedControl::new(&["Unified", "Split"], Some(split as usize))
        .label("Layout")
        .on_pick(move |s: &mut S, at, _| {
            get_mut(s).state.set_mode(if at == 1 {
                DiffMode::Split
            } else {
                DiffMode::Unified
            })
        })
        .build(k);
    let diff = DiffView::new(
        move |s: &S| &get(s).state,
        move |s: &mut S| &mut get_mut(s).state,
    )
    .on_select(move |s: &mut S, range, _| get_mut(s).state.set_selection(range))
    .key("diff")
    .build(s, k);
    let comment = TextInput::new(&tab.comment)
        .placeholder("Comment on the selected lines")
        .on_edit(move |s: &mut S| &mut get_mut(s).comment)
        .on_submit(move |s: &mut S, _| get_mut(s).add_comment())
        .build(k)
        .grow(1.0);
    let add = Button::new("Add comment")
        .on_press(move |s: &mut S| get_mut(s).add_comment())
        .build(k)
        .key("add-comment");
    let drafts = tab.drafts.iter().map(|draft| {
        let id = draft.id.clone();
        row()
            .key(format!("draft-{}", draft.id))
            .gap(8.0)
            .center_y()
            .w_full()
            .child(
                text(draft.text.clone())
                    .wrap()
                    .grow(1.0)
                    .color(k.c.text_base),
            )
            .child(
                Button::new("Remove")
                    .variant(ButtonVariant::Ghost)
                    .on_press(move |s: &mut S| {
                        let tab = get_mut(s);
                        tab.drafts = remove_draft(&tab.drafts, &id);
                    })
                    .build(k),
            )
    });
    let send = Button::new("Compose")
        .on_press(move |s: &mut S| {
            let tab = get_mut(s);
            tab.delivery = Some(compose(&tab.drafts));
        })
        .build(k)
        .key("compose");
    let delivery = tab.delivery.iter().map(|said| {
        text(said.clone())
            .key("delivery")
            .label(said.clone())
            .font(k.ty.mono)
            .color(k.c.text_base)
            .wrap()
            .w_full()
    });
    col()
        .gap(8.0)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(mode)
        .child(diff)
        .child(row().gap(8.0).center_y().w_full().child(comment).child(add))
        .children(drafts)
        .child(send)
        .children(delivery)
}
