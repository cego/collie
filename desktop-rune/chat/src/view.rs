//! The Flock chat and a Run's Diff tab as Rune draws them.

use crate::agui::{Part, Role, Transcript};
use crate::highlight::syntect;
use crate::policy::{Opened, confined, opened};
use crate::review::{Draft, add_draft, compose, diff_anchor, remove_draft};
use collie_desktop_protocol::generated::SayPayload;
use rune::edit::TextEdit;
use rune::{El, col, row, text};
use rune_kit::diff::{DiffMode, DiffState, DiffView, FileDiff};
use rune_kit::markdown::Markdown;
use rune_kit::syntax::Highlighter;
use rune_kit::{Button, ButtonVariant, Kit, SegmentedControl, TextInput};

/// Sends a turn to the core, and gives back what cancels it.
pub type Say = Box<dyn Fn(SayPayload) -> Box<dyn FnOnce()>>;

#[derive(Default)]
pub struct Chat {
    pub transcript: Transcript,
    pub composer: TextEdit,
    /// Code blocks are coloured by syntect and two-face, not rune-kit's own highlighter.
    pub syntect: bool,
    pub say: Option<Say>,
    /// The last link pressed that agent markdown may open.
    pub opened: Option<Opened>,
    turn: Option<Box<dyn FnOnce()>>,
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
            self.turn = Some(say(SayPayload {
                text: said,
                about: None,
                now: None,
                attachments: None,
            }));
        }
    }

    pub fn cancel(&mut self) {
        if let Some(cancel) = self.turn.take() {
            cancel();
        }
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
    let composer = TextInput::new(&chat.composer)
        .placeholder("Ask the Flock")
        .on_edit(move |s: &mut S| &mut lens(s).composer)
        .on_submit(move |s: &mut S, _| lens(s).send())
        .build(k)
        .key("composer")
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
        .gap(12.0)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(
            col()
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
                .child(composer)
                .child(action)
                .child(colours),
        )
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
