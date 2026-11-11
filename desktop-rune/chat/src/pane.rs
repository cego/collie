//! The Flock chat as Rune draws it: `FlockChat.vue` and the pieces it is made of.

use crate::agui::{Message, Part, Role};
use crate::ansi::{AnsiSpan, Colour, ansi_spans};
use crate::attachments::{Attached, iso_of, pasted_paths, size_said};
use crate::chat::{
    self, Chat, Open, Setup, answer, choose_setting, clipboard_files, copy, follow, list_earlier,
    pick, pick_option, reconnect, reopen, retry, send, set_proactive, stage_image, stage_paths,
    stay,
};
use crate::choices::{
    ChoiceSelect, DEFAULT_CHAT_HARNESS, chat_selects, choice_notices, empty_change, typed_entry,
};
use crate::highlight::colours;
use crate::host::Host;
use crate::icons;
use crate::policy::confined_chat;
use crate::words::{about_line, earlier_note, harness_name, questions_of, tool_row};
use collie_desktop_protocol::generated::{
    About, Choice, Conversation, Found, SetSettingsPayload, StoreSource,
};
use rune::edit::TextEdit;
use rune::{Color, El, Key, LiveRegion, Span, col, el, icon, rich, row, text, text_input};
use rune_kit::markdown::Markdown;
use rune_kit::syntax::Highlighter;
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, Combobox, ComboboxOption, ComboboxState,
    ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem, Placement, Spinner,
};

fn composer<S: Host>(s: &mut S) -> &mut TextEdit {
    &mut s.chat_mut().composer
}

fn model_menu<S: Host>(s: &mut S) -> &mut ComboboxState {
    &mut s.chat_mut().model_menu
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// The Flock chat; its menus go on `layer`, the window's overlays.
pub fn chat<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let log = col()
        .key("chat-log")
        .role("log")
        .label("Flock chat")
        .gap(16.0)
        .px(16.0)
        .py(12.0)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(rune::ScrollSpec { stick_bottom: true })
        .children(log_entries::<S>(chat, k));
    col()
        .key("chat")
        .on_drop_files(|s: &mut S, files, _| stage_paths(s, files.to_vec(), Vec::new()))
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(header::<S>(chat, k, layer))
        .child(log)
        .child(
            text(chat.announcement.clone())
                .key("chat-announcement")
                .live_region(LiveRegion::Polite)
                .font(k.ty.text_xsmall)
                .color(Color::TRANSPARENT)
                .h(0.0),
        )
        .child(footer::<S>(chat, k, layer))
}

fn header<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let busy = chat.transcript.running || chat.desktop_speaking;
    let proactive = chat.proactive.unwrap_or(true);
    let said = if proactive {
        "Speaks first about News that matters"
    } else {
        "Waits to be asked"
    };
    let bell = IconButton::new(if proactive {
        &icons::BELL
    } else {
        &icons::BELL_OFF
    })
    .variant(IconButtonVariant::GhostMuted)
    .label(said)
    .help(said)
    .on_press(move |s: &mut S| set_proactive(s, !proactive))
    .build(k)
    .key("chat-proactive");
    let fresh = IconButton::new(&icons::NEW)
        .variant(IconButtonVariant::GhostMuted)
        .label("Start fresh")
        .help("Start fresh")
        .on_press(|s: &mut S| reopen(s, None))
        .build(k)
        .key("chat-new");
    let pop = chat.pop.as_ref().map(|_| {
        let (glyph, said) = if chat.popped {
            (&icons::POP_IN, "Put back beside the board")
        } else {
            (&icons::POP_OUT, "Pop out")
        };
        let popped = chat.popped;
        IconButton::new(glyph)
            .variant(IconButtonVariant::GhostMuted)
            .label(said)
            .help(said)
            .on_press(move |s: &mut S| {
                if let Some(pop) = &s.chat().pop {
                    pop(!popped);
                }
            })
            .build(k)
            .key("chat-pop")
    });
    row()
        .key("chat-header")
        .gap(2.0)
        .center_y()
        .w_full()
        .h(44.0)
        .pl(16.0)
        .pr(8.0)
        .child(icon(&icons::FLOCK, 16.0).color(k.c.icon_muted))
        .child(
            text("Flock chat")
                .role("heading")
                .level(2)
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .ml(6.0),
        )
        .children(busy.then(|| Spinner::new().size(14.0).build(k).ml(8.0)))
        .child(el().grow(1.0))
        .child(fresh)
        .child(bell)
        .child(earlier_menu::<S>(chat, k, layer))
        .children(pop)
}

fn earlier_menu<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let open = chat.menu == Some(Open::Earlier);
    let trigger = IconButton::new(&icons::HISTORY)
        .variant(IconButtonVariant::GhostMuted)
        .label("Earlier conversations")
        .help("Earlier conversations")
        .expanded(open)
        .on_press(move |s: &mut S| {
            if open {
                s.chat_mut().menu = None;
            } else {
                list_earlier(s);
            }
        })
        .build(k)
        .key("chat-earlier");
    let mut menu = Menu::new("chat-earlier-menu")
        .trigger(trigger)
        .open(open)
        .placement(Placement::BottomEnd)
        .min_width(280.0)
        .on_close(|s: &mut S| s.chat_mut().menu = None);
    let set = chat
        .settings()
        .chat_harness
        .unwrap_or_else(|| DEFAULT_CHAT_HARNESS.into());
    match &chat.earlier {
        None => menu = menu.item(MenuItem::new("Reading the conversations…").disabled(true)),
        Some(Err(why)) => menu = menu.item(MenuItem::new(why.clone()).disabled(true)),
        Some(Ok(listed)) if listed.earlier.is_empty() => {
            menu = menu.item(MenuItem::new("No earlier conversations").disabled(true));
        }
        Some(Ok(listed)) => {
            menu = menu.group_label("Earlier conversations");
            for one in &listed.earlier {
                let conversation = Conversation {
                    session: one.session.clone(),
                    harness: one.harness.clone(),
                };
                let when = iso_of(one.at);
                menu = menu.item(
                    MenuItem::new(one.title.clone())
                        .description(format!(
                            "{} · {} {}",
                            harness_name(&one.harness),
                            &when[..10],
                            &when[11..16]
                        ))
                        .on_select(move |s: &mut S| reopen(s, Some(conversation.clone()))),
                );
            }
            if let Some(note) = earlier_note(&listed.earlier, &set) {
                menu = menu.separator().group_label(note);
            }
        }
    }
    menu.build(k, layer)
}

fn log_entries<S: Host>(chat: &Chat, k: &Kit) -> Vec<El> {
    let mut entries = Vec::new();
    let messages = &chat.transcript.messages;
    if messages.is_empty() && !chat.transcript.running {
        entries.push(if chat.loaded {
            empty(k)
        } else {
            row()
                .key("chat-loading")
                .role("status")
                .label("Reading the conversation")
                .gap(8.0)
                .center_y()
                .child(Spinner::new().size(14.0).build(k))
                .child(
                    text("Reading the conversation…")
                        .font(k.ty.small)
                        .color(k.c.text_muted),
                )
        });
    }
    let last = messages.len().saturating_sub(1);
    for (at, m) in messages.iter().enumerate() {
        let live = chat.transcript.running && at == last;
        entries.push(message::<S>(chat, k, m, live));
    }
    if chat.desktop_speaking {
        entries.push(
            row()
                .key("chat-desktop-speaking")
                .role("status")
                .gap(8.0)
                .center_y()
                .child(Badge::new("Desktop").variant(BadgeVariant::Subtle).build(k))
                .child(
                    text("is telling the chat what it noticed…")
                        .font(k.ty.small)
                        .color(k.c.text_muted),
                ),
        );
    }
    if let Some(why) = &chat.transcript.error {
        entries.push(failed::<S>(chat, k, why));
    }
    if let Some(why) = &chat.trouble {
        entries.push(notice(
            k,
            "chat-trouble",
            &icons::ALERT,
            k.c.warning,
            "Desktop is reconnecting to its chat",
            Some(why),
            Some(
                Button::new("Retry now")
                    .control_size(ControlSize::Regular)
                    .variant(ButtonVariant::Outline)
                    .on_press(|s: &mut S| reconnect(s))
                    .build(k)
                    .key("chat-retry-now"),
            ),
        ));
    }
    if let Some(card) = setup::<S>(chat, k) {
        entries.push(card);
    }
    for queued in &chat.queue {
        let id = queued.id;
        let said = match (queued.text.is_empty(), queued.files.len()) {
            (false, _) => queued.text.clone(),
            (true, 1) => queued.files[0].name.clone(),
            (true, n) => format!("{n} files"),
        };
        entries.push(
            row()
                .key(format!("chat-queued-{id}"))
                .gap(8.0)
                .center_y()
                .self_end()
                .max_w(360.0)
                .px(12.0)
                .py(8.0)
                .radius(8.0)
                .border(1.0, k.c.border_base)
                .child(
                    text(said)
                        .font(k.ty.body)
                        .color(k.c.text_muted)
                        .wrap()
                        .shrink(),
                )
                .child(Badge::new("Queued").variant(BadgeVariant::Subtle).build(k))
                .child(
                    IconButton::new(&icons::CLOSE)
                        .variant(IconButtonVariant::GhostMuted)
                        .control_size(ControlSize::Small)
                        .label("Don't send")
                        .on_press(move |s: &mut S| s.chat_mut().unqueue(id))
                        .build(k)
                        .key(format!("chat-unqueue-{id}")),
                ),
        );
    }
    entries
}

fn empty(k: &Kit) -> El {
    col()
        .key("chat-empty")
        .gap(8.0)
        .items_center()
        .w_full()
        .pt(48.0)
        .child(
            el().size(40.0, 40.0)
                .radius(20.0)
                .fill(k.c.layer_02)
                .center()
                .child(icon(&icons::FLOCK, 20.0).color(k.c.icon_muted)),
        )
        .child(
            text("Ask about the Flock")
                .font(k.ty.ui_medium)
                .color(k.c.text_strong),
        )
        .child(
            text("The chat sees every Machine's board. Ask what needs you, or select a card to ask about it.")
                .font(k.ty.small)
                .color(k.c.text_muted)
                .wrap()
                .max_w(300.0)
                .align(rune::Align::Center),
        )
}

/// A notice in the log or above the message box: an icon, a title, what it says, an action.
fn notice(
    k: &Kit,
    key: &str,
    glyph: &'static rune::Icon,
    tone: rune_kit::StateColors,
    title: &str,
    said: Option<&str>,
    action: Option<El>,
) -> El {
    let words = col()
        .gap(2.0)
        .grow(1.0)
        .shrink()
        .child(
            text(title.to_string())
                .font(k.ty.small_medium)
                .color(tone.fg)
                .wrap(),
        )
        .children(said.map(|said| {
            text(said.to_string())
                .font(k.ty.small)
                .color(k.c.text_base)
                .wrap()
                .selectable(true)
        }))
        .a11y_hidden();
    row()
        .key(key.to_string())
        .role("alert")
        .label(match said {
            Some(said) => format!("{title}. {said}"),
            None => title.to_string(),
        })
        .gap(8.0)
        .w_full()
        .px(12.0)
        .py(10.0)
        .radius(8.0)
        .fill(tone.bg)
        .border(1.0, tone.border)
        .child(icon(glyph, 16.0).color(tone.icon).mt(1.0))
        .child(words)
        .children(action)
}

fn failed<S: Host>(chat: &Chat, k: &Kit, why: &str) -> El {
    let again = chat.transcript.last_said().map(|_| {
        Button::new("Try again")
            .icon(&icons::RETRY)
            .control_size(ControlSize::Regular)
            .variant(ButtonVariant::Outline)
            .on_press(|s: &mut S| retry(s))
            .build(k)
            .key("chat-try-again")
    });
    notice(
        k,
        "chat-error",
        &icons::ALERT,
        k.c.danger,
        "The reply failed",
        Some(why),
        again,
    )
}

fn markdown<S: Host>(k: &Kit, said: &str, live: bool) -> El {
    Markdown::new(confined_chat(said))
        .streaming(live)
        .selectable(true)
        .highlighter(Highlighter::new(colours))
        .on_link(|s: &mut S, url: &str| follow(s, url))
        .build(k)
}

fn about_badge<S: Host>(k: &Kit, about: &About) -> El {
    let line = about_line(about);
    let opened = about.clone();
    row()
        .key("chat-about")
        .role("button")
        .label(format!("About {line}"))
        .help(line.clone())
        .focusable(true)
        .on_press(move |s: &mut S| s.open_about(&opened))
        .self_start()
        .max_w(320.0)
        .gap(4.0)
        .center_y()
        .px(8.0)
        .h(22.0)
        .radius(6.0)
        .fill(k.c.layer_03)
        .child(
            text(line)
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_muted)
                .truncate()
                .a11y_hidden(),
        )
}

fn message<S: Host>(chat: &Chat, k: &Kit, m: &Message, live: bool) -> El {
    let key = format!("message-{}", m.id);
    if let Some(said) = m.desktop_said() {
        return col()
            .key(key)
            .role("article")
            .label("Desktop noticed")
            .gap(6.0)
            .w_full()
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .border(1.0, k.c.border_base)
            .child(Badge::new("Desktop").variant(BadgeVariant::Subtle).build(k))
            .child(markdown::<S>(k, said, false));
    }
    let parts = m.parts.iter().enumerate().map(|(at, p)| match p {
        Part::Text(said) => markdown::<S>(k, said, live),
        Part::Attached(file) => chip::<S>(chat, k, file, false),
        Part::Thinking(thought) => thinking::<S>(chat, k, &format!("{}-{at}", m.id), thought),
        Part::ToolCall {
            id,
            name,
            arguments,
            output,
        } => tool::<S>(chat, k, id, name, arguments, output.as_deref()),
    });
    let words = m.text();
    let copier = (!words.is_empty() && !live).then(|| {
        let copied = chat.copied.as_deref() == Some(m.id.as_str());
        let id = m.id.clone();
        IconButton::new(if copied { &icons::CHECK } else { &icons::COPY })
            .variant(IconButtonVariant::GhostMuted)
            .control_size(ControlSize::Small)
            .label(if copied { "Copied" } else { "Copy message" })
            .help("Copy message")
            .on_press_tx(move |s: &mut S, tx| copy(s, tx, &id, words.clone()))
            .build(k)
            .key(format!("copy-{}", m.id))
    });
    match m.role {
        Role::User => col()
            .key(key)
            .role("article")
            .label("You said")
            .gap(4.0)
            .w_full()
            .items_end()
            .child(
                col()
                    .gap(8.0)
                    .max_w(360.0)
                    .px(12.0)
                    .py(8.0)
                    .radius(12.0)
                    .fill(k.c.layer_02)
                    .children(m.about.as_ref().map(|a| about_badge::<S>(k, a)))
                    .children(parts),
            )
            .children(copier),
        Role::Assistant => col()
            .key(key)
            .role("article")
            .label("The chat said")
            .gap(10.0)
            .w_full()
            .children(parts)
            .children(copier.map(|c| row().child(c))),
    }
}

fn thinking<S: Host>(chat: &Chat, k: &Kit, key: &str, thought: &str) -> El {
    let key = format!("thought-{key}");
    let open = chat.expanded.contains(&key);
    let toggled = key.clone();
    let head = row()
        .key(format!("{key}-toggle"))
        .role("button")
        .label("Thinking")
        .expanded(open)
        .focusable(true)
        .on_press(move |s: &mut S| s.chat_mut().toggle(&toggled))
        .gap(6.0)
        .center_y()
        .h(24.0)
        .child(icon(&icons::THOUGHT, 14.0).color(k.c.icon_faint))
        .child(
            text("Thinking")
                .font(k.ty.small)
                .color(k.c.text_faint)
                .a11y_hidden(),
        )
        .child(
            icon(
                if open {
                    &icons::CHEVRON_DOWN
                } else {
                    &icons::CHEVRON
                },
                12.0,
            )
            .color(k.c.icon_faint),
        );
    col().key(key).w_full().child(head).children(open.then(|| {
        text(thought.to_string())
            .font(k.ty.small)
            .color(k.c.text_muted)
            .wrap_anywhere()
            .selectable(true)
            .w_full()
            .pl(20.0)
    }))
}

fn tool<S: Host>(
    chat: &Chat,
    k: &Kit,
    id: &str,
    name: &str,
    args: &str,
    output: Option<&str>,
) -> El {
    let running = chat.transcript.running;
    if name == "AskUserQuestion" && output.is_none() && running && !questions_of(args).is_empty() {
        return question::<S>(chat, k, id, args);
    }
    let row_said = tool_row(name, args);
    let key = format!("tool-{id}");
    let open = chat.expanded.contains(&key);
    let toggled = key.clone();
    let waiting = output.is_none() && running;
    let head = row()
        .key(format!("{key}-toggle"))
        .role("button")
        .label(format!("{}: {}", row_said.tool, row_said.summary))
        .expanded(open)
        .focusable(true)
        .on_press(move |s: &mut S| s.chat_mut().toggle(&toggled))
        .gap(8.0)
        .center_y()
        .w_full()
        .h(30.0)
        .px(10.0)
        .child(icon(&icons::TOOL, 14.0).color(k.c.icon_muted))
        .child(
            text(row_said.tool.clone())
                .font(k.ty.small_medium)
                .color(k.c.text_base)
                .a11y_hidden(),
        )
        .child(
            text(row_said.summary.clone())
                .font(k.ty.small)
                .color(k.c.text_muted)
                .truncate()
                .shrink()
                .grow(1.0)
                .a11y_hidden(),
        )
        .children(
            row_said
                .machine
                .clone()
                .map(|machine| Badge::new(machine).variant(BadgeVariant::Subtle).build(k)),
        )
        .children(waiting.then(|| Spinner::new().size(12.0).build(k)))
        .child(
            icon(
                if open {
                    &icons::CHEVRON_DOWN
                } else {
                    &icons::CHEVRON
                },
                12.0,
            )
            .color(k.c.icon_faint),
        );
    let body = open.then(|| {
        let pretty = serde_json::from_str::<serde_json::Value>(args)
            .ok()
            .and_then(|v| serde_json::to_string_pretty(&v).ok())
            .unwrap_or_else(|| args.to_string());
        col()
            .key(format!("{key}-detail"))
            .gap(8.0)
            .w_full()
            .px(10.0)
            .pb(10.0)
            .children(
                (!args.trim().is_empty())
                    .then(|| code_box(k, "Input", text(pretty).font(k.ty.mono))),
            )
            .children(output.map(|out| code_box(k, "Output", ansi(k, out))))
    });
    col()
        .key(key)
        .w_full()
        .radius(8.0)
        .border(1.0, k.c.border_weak)
        .fill(k.c.layer_01)
        .child(head)
        .children(body)
}

fn code_box(k: &Kit, title: &str, body: El) -> El {
    col()
        .gap(4.0)
        .w_full()
        .child(
            text(title.to_string())
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_faint),
        )
        .child(
            col()
                .w_full()
                .max_h(240.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .padding(8.0)
                .radius(6.0)
                .fill(k.c.bg_deep)
                .child(
                    body.color(k.c.text_base)
                        .wrap_anywhere()
                        .selectable(true)
                        .w_full(),
                ),
        )
}

fn theme_colour(k: &Kit, n: u8) -> Color {
    match n % 8 {
        0 => k.c.text_faint,
        1 => k.c.danger.fg,
        2 => k.c.success.fg,
        3 => k.c.warning.fg,
        4 | 6 => k.c.info.fg,
        5 => k.c.text_accent,
        _ => k.c.text_strong,
    }
}

/// A tool's output with its terminal colours (`AnsiText.vue`).
fn ansi(k: &Kit, out: &str) -> El {
    let runs: Vec<AnsiSpan> = ansi_spans(out);
    let mut all = String::new();
    let mut spans = Vec::new();
    for run in runs {
        let (start, end) = (all.len(), all.len() + run.text.len());
        all.push_str(&run.text);
        let mut span = Span::new(start, end).mono();
        let style = run.style;
        if style.bold {
            span = span.bold();
        }
        if style.italic {
            span = span.italic();
        }
        let colour = |c: Colour| match c {
            Colour::Theme(n) => theme_colour(k, n),
            Colour::Rgb(r, g, b) => {
                rune::color::hex(&format!("#{r:02x}{g:02x}{b:02x}")).unwrap_or(k.c.text_base)
            }
        };
        if let Some(fg) = style.fg {
            span = span.color(colour(fg));
        } else if style.dim {
            span = span.color(k.c.text_muted);
        }
        if let Some(bg) = style.bg {
            span = span.bg(colour(bg), 0.0);
        }
        if style.underline {
            span = span.underline(k.c.text_base);
        }
        spans.push(span);
    }
    rich(all, spans).font(k.ty.mono)
}

/// The chat's question, answered here (`ChatQuestion.vue`).
fn question<S: Host>(chat: &Chat, k: &Kit, id: &str, args: &str) -> El {
    let questions = questions_of(args);
    let answered = chat.answered.contains(id);
    let picks = chat.picked.get(id);
    let single = questions.len() == 1 && !questions[0].multi_select;
    let mut card = col()
        .key(format!("question-{id}"))
        .role("group")
        .label("The chat asks")
        .gap(12.0)
        .w_full()
        .padding(12.0)
        .radius(10.0)
        .border(1.0, k.c.info.border)
        .fill(k.c.info.bg);
    for (qi, q) in questions.iter().enumerate() {
        let picked = picks.and_then(|p| p.get(&q.question));
        let options = q.options.iter().enumerate().map(|(oi, option)| {
            let on = picked.is_some_and(|p| p.contains(&option.label));
            let (tool_id, args, question, label) = (
                id.to_string(),
                args.to_string(),
                q.question.clone(),
                option.label.clone(),
            );
            let mut button = row()
                .key(format!("question-{id}-{qi}-{oi}"))
                .role(if q.multi_select { "checkbox" } else { "radio" })
                .label(option.label.clone())
                .checked(on)
                .focusable(!answered)
                .disabled(answered)
                .on_press(move |s: &mut S| pick_option(s, &tool_id, &args, &question, &label))
                .gap(8.0)
                .w_full()
                .px(10.0)
                .py(8.0)
                .radius(6.0)
                .border(
                    1.0,
                    if on {
                        k.c.border_focus
                    } else {
                        k.c.border_base
                    },
                )
                .fill(if on { k.c.layer_03 } else { k.c.layer_01 })
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .shrink()
                        .child(
                            text(option.label.clone())
                                .font(k.ty.small_medium)
                                .color(k.c.text_strong)
                                .wrap(),
                        )
                        .children(
                            option
                                .description
                                .clone()
                                .map(|d| text(d).font(k.ty.small).color(k.c.text_muted).wrap()),
                        )
                        .a11y_hidden(),
                );
            if let Some(d) = &option.description {
                button = button.description(d.clone());
            }
            button
        });
        card = card.child(
            col()
                .key(format!("question-{id}-{qi}"))
                .role(if q.multi_select {
                    "group"
                } else {
                    "radiogroup"
                })
                .label(q.question.clone())
                .gap(6.0)
                .w_full()
                .children((!q.header.is_empty()).then(|| {
                    text(q.header.to_uppercase())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.info.fg)
                }))
                .child(
                    text(q.question.clone())
                        .font(k.ty.body_medium)
                        .color(k.c.text_strong)
                        .wrap(),
                )
                .children(options),
        );
    }
    let ready = chat.answers(id, args).is_some();
    if !single {
        let (tool_id, args) = (id.to_string(), args.to_string());
        card = card.child(
            row().w_full().justify_end().child(
                Button::new(if answered { "Answered" } else { "Answer" })
                    .control_size(ControlSize::Regular)
                    .variant(ButtonVariant::Submit)
                    .disabled(answered || !ready)
                    .on_press(move |s: &mut S| answer(s, &tool_id, &args))
                    .build(k)
                    .key(format!("question-{id}-answer")),
            ),
        );
    }
    card
}

/// The standing-direction offer, and what reading would read once asked (`StandingSetupDialog`).
fn setup<S: Host>(chat: &Chat, k: &Kit) -> Option<El> {
    let declines = || {
        [
            Button::new("Don't ask again")
                .control_size(ControlSize::Regular)
                .variant(ButtonVariant::Ghost)
                .on_press(|s: &mut S| chat::decline_setup(s, true))
                .build(k)
                .key("setup-never"),
            Button::new("Not now")
                .control_size(ControlSize::Regular)
                .variant(ButtonVariant::Ghost)
                .on_press(|s: &mut S| chat::decline_setup(s, false))
                .build(k)
                .key("setup-not-now"),
        ]
    };
    let card = |body: Vec<El>, actions: Vec<El>| {
        col()
            .key("setup")
            .role("group")
            .label("Tell Collie how you work")
            .gap(8.0)
            .w_full()
            .px(12.0)
            .py(10.0)
            .radius(8.0)
            .border(1.0, k.c.border_base)
            .child(
                text("Tell Collie how you work")
                    .font(k.ty.ui_medium)
                    .color(k.c.text_strong),
            )
            .children(body)
            .child(
                row()
                    .gap(6.0)
                    .w_full()
                    .justify_end()
                    .flex_wrap()
                    .children(actions),
            )
    };
    let muted = |said: &str| {
        text(said.to_string())
            .font(k.ty.small)
            .color(k.c.text_muted)
            .wrap()
            .w_full()
    };
    match &chat.setup {
        Setup::None => None,
        Setup::Offered => {
            let mut actions: Vec<El> = declines().into();
            actions.push(
                Button::new("Let's write it")
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut S| chat::ask_setup(s))
                    .build(k)
                    .key("setup-open"),
            );
            Some(card(
                vec![muted(
                    "A Standing direction goes with every message to the chat, in your words.",
                )],
                actions,
            ))
        }
        Setup::Asked(found) => {
            let mut body = vec![muted(
                "Collie can draft your Standing direction from the messages you typed to your coding agents, or ask you five questions instead. Nothing is saved until you accept the draft.",
            )];
            match found {
                None => body.push(muted("Looking for your sessions…")),
                Some(computers) => {
                    for computer in computers {
                        let mut lines = vec![
                            text(computer.computer.clone())
                                .font(k.ty.small_medium)
                                .color(k.c.text_base),
                        ];
                        match &computer.problem {
                            Some(problem) => lines.push(
                                text(problem.clone())
                                    .font(k.ty.small)
                                    .color(k.c.warning.fg)
                                    .wrap(),
                            ),
                            None => {
                                for store in &computer.stores {
                                    let source = match store.source {
                                        StoreSource::ClaudeCode => "Claude Code",
                                        StoreSource::Codex => "Codex",
                                        StoreSource::Pi => "Pi",
                                        StoreSource::Opencode => "OpenCode",
                                        StoreSource::Collie => "Collie's records",
                                    };
                                    let said = match store.found {
                                        Found::Read => format!(
                                            "{source}: {} {} in {}",
                                            store.sessions,
                                            if store.source == StoreSource::Collie {
                                                "entries"
                                            } else {
                                                "sessions"
                                            },
                                            store.r#where
                                        ),
                                        Found::Missing | Found::Unreadable => format!(
                                            "{source}: {}{}",
                                            if store.found == Found::Missing {
                                                "missing"
                                            } else {
                                                "unreadable"
                                            },
                                            store
                                                .why
                                                .as_ref()
                                                .map(|w| format!(": {w}"))
                                                .unwrap_or_default()
                                        ),
                                    };
                                    lines.push(muted(&format!("• {said}")).pl(8.0));
                                }
                            }
                        }
                        body.push(col().gap(2.0).w_full().children(lines));
                    }
                }
            }
            body.push(muted(
                "What is read goes to the Flock chat's model provider, for this one conversation. Your consent is not kept: the next setup asks again.",
            ));
            let mut actions: Vec<El> = declines().into();
            actions.push(
                Button::new("Ask me five questions instead")
                    .control_size(ControlSize::Regular)
                    .variant(ButtonVariant::Outline)
                    .on_press(|s: &mut S| chat::choose_setup(s, Choice::Ask))
                    .build(k)
                    .key("setup-ask"),
            );
            actions.push(
                Button::new("Read my messages")
                    .control_size(ControlSize::Regular)
                    .disabled(found.is_none())
                    .on_press(|s: &mut S| chat::choose_setup(s, Choice::Read))
                    .build(k)
                    .key("setup-read"),
            );
            Some(card(body, actions))
        }
    }
}

/// An attached file: its thumbnail or glyph, name and size, and a remove where it is pending.
fn chip<S: Host>(chat: &Chat, k: &Kit, file: &Attached, removable: bool) -> El {
    let thumb = match chat.thumbs.get(&file.id) {
        Some(pixels) => el().size(28.0, 28.0).radius(4.0).pixels(pixels),
        None => el()
            .size(28.0, 28.0)
            .radius(4.0)
            .fill(k.c.layer_03)
            .center()
            .child(icon(&icons::FILE, 14.0).color(k.c.icon_muted)),
    };
    let id = file.id.clone();
    row()
        .key(format!(
            "{}-{}",
            if removable { "file" } else { "attached" },
            file.id
        ))
        .role("group")
        .label(format!("{}, {}", file.name, size_said(file.size)))
        .gap(8.0)
        .center_y()
        .max_w(260.0)
        .pl(4.0)
        .pr(if removable { 2.0 } else { 10.0 })
        .py(4.0)
        .radius(8.0)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(thumb.a11y_hidden())
        .child(
            col()
                .shrink()
                .child(
                    text(file.name.clone())
                        .font(k.ty.small_medium)
                        .color(k.c.text_base)
                        .truncate_middle(),
                )
                .child(
                    text(size_said(file.size))
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                )
                .a11y_hidden(),
        )
        .children(removable.then(|| {
            IconButton::new(&icons::CLOSE)
                .variant(IconButtonVariant::GhostMuted)
                .control_size(ControlSize::Small)
                .label(format!("Remove {}", file.name))
                .on_press(move |s: &mut S| s.chat_mut().remove_file(&id))
                .build(k)
                .key(format!("file-{}-remove", file.id))
        }))
}

fn footer<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let settings = chat.settings();
    let notices = choice_notices(&settings, chat.choices.as_ref());
    let waiting = notices.waiting.map(|w| {
        notice(
            k,
            "chat-switch-waiting",
            &icons::INFO,
            k.c.info,
            &w.text,
            None,
            Some(
                Button::new(w.stay_label)
                    .control_size(ControlSize::Regular)
                    .variant(ButtonVariant::Outline)
                    .on_press(|s: &mut S| stay(s))
                    .build(k)
                    .key("chat-stay"),
            ),
        )
        .role("status")
    });
    let reply = notices.reply.map(|r| {
        row()
            .key("chat-reply-choice")
            .role("status")
            .gap(8.0)
            .w_full()
            .px(12.0)
            .py(8.0)
            .radius(8.0)
            .fill(k.c.layer_02)
            .child(icon(&icons::INFO, 14.0).color(k.c.icon_muted).mt(1.0))
            .child(
                text(format!(
                    "This reply finishes on {}. Your next message runs on {}.",
                    r.current, r.next
                ))
                .font(k.ty.small)
                .color(k.c.text_base)
                .wrap()
                .shrink(),
            )
    });
    let refused_choice = chat.choice_refused.as_ref().map(|why| {
        notice(
            k,
            "chat-choice-refused",
            &icons::ALERT,
            k.c.danger,
            why,
            None,
            Some(
                IconButton::new(&icons::CLOSE)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .label("Dismiss")
                    .on_press(|s: &mut S| s.chat_mut().choice_refused = None)
                    .build(k)
                    .key("chat-choice-dismiss"),
            ),
        )
    });
    col()
        .key("chat-footer")
        .gap(8.0)
        .w_full()
        .px(12.0)
        .pt(8.0)
        .pb(12.0)
        .children(refused_choice)
        .children(waiting)
        .children(reply)
        .child(prompt::<S>(chat, k, layer))
}

fn prompt<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let running = chat.transcript.running;
    let about = chat.about.as_ref().map(|about| {
        row()
            .key("chat-chip")
            .role("group")
            .label(format!("About: {}", about_line(about)))
            .gap(2.0)
            .center_y()
            .max_w(320.0)
            .pl(8.0)
            .pr(2.0)
            .h(26.0)
            .radius(6.0)
            .fill(k.c.info.bg)
            .child(
                text(format!("About: {}", about_line(about)))
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.info.fg)
                    .truncate()
                    .shrink(),
            )
            .child(
                IconButton::new(&icons::CLOSE)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .label("Clear")
                    .on_press(|s: &mut S| s.chat_mut().choose(None))
                    .build(k)
                    .key("chat-chip-clear"),
            )
    });
    let files = chat.attached.iter().map(|f| chip::<S>(chat, k, f, true));
    let has_chips = about.is_some() || !chat.attached.is_empty();
    let chips = has_chips.then(|| {
        row()
            .key("chat-chips")
            .gap(6.0)
            .w_full()
            .flex_wrap()
            .children(about)
            .children(files)
    });
    let refused = chat.refused.as_ref().map(|why| {
        text(why.clone())
            .key("chat-refused")
            .role("alert")
            .label(why.clone())
            .font(k.ty.small)
            .color(k.c.danger.fg)
            .wrap()
            .w_full()
    });
    let field = text_input(&chat.composer, k.ty.body)
        .key("composer")
        .label("Message the Flock chat")
        .placeholder(
            if running {
                "Enter queues it, Ctrl+Enter sends it now"
            } else {
                "Ask about the Flock"
            },
            k.c.text_faint,
        )
        .color(k.c.text_base)
        .caret(k.c.text_base, k.selection())
        .w_full()
        .on_edit(composer::<S>)
        .on_submit(|s: &mut S, _| send(s, false))
        .on_input_key(|s: &mut S, key, _| {
            let now = key.key == Key::Enter && key.mods.cmd;
            if now {
                send(s, true);
            }
            now
        })
        .on_input_paste(|s: &mut S, pasted, _| {
            let paths = pasted_paths(pasted);
            if !paths.is_empty() {
                stage_paths(s, paths, Vec::new());
                return true;
            }
            if let Some(image) = pasted.image() {
                stage_image(s, image.png().to_vec(), &iso_of(now_ms()));
                return true;
            }
            if pasted.text().is_empty() {
                clipboard_files(s);
                return true;
            }
            false
        });
    let field = rune::auto_grow(field, 2, 10);
    let attach_help = if chat.drops_unavailable {
        "Attach files. Dropping files isn't available here; attach or paste them instead."
    } else {
        "Attach files"
    };
    let attach = IconButton::new(&icons::CLIP)
        .variant(IconButtonVariant::GhostMuted)
        .label("Attach files")
        .help(attach_help)
        .on_press_tx(|s: &mut S, tx| pick(s, tx))
        .build(k)
        .key("attach");
    let action = if running {
        IconButton::new(&icons::STOP)
            .variant(IconButtonVariant::Contrast)
            .label("Stop the reply")
            .help("Stop the reply")
            .on_press(|s: &mut S| s.chat_mut().stop())
            .build(k)
            .key("stop")
    } else {
        let empty = chat.composer.text.trim().is_empty() && chat.attached.is_empty();
        IconButton::new(&icons::SEND)
            .variant(IconButtonVariant::Submit)
            .label("Send")
            .help("Send")
            .disabled(empty)
            .on_press(|s: &mut S| send(s, false))
            .build(k)
            .key("send")
    };
    col()
        .key("chat-prompt")
        .gap(6.0)
        .w_full()
        .padding(8.0)
        .radius(12.0)
        .fill(k.c.layer_01)
        .border(
            1.0,
            if chat.composer.focused {
                k.c.border_strong
            } else {
                k.c.border_base
            },
        )
        .children(chips)
        .children(refused)
        .child(field.px(4.0))
        .child(
            row()
                .key("chat-prompt-footer")
                .gap(4.0)
                .center_y()
                .w_full()
                .flex_wrap()
                .child(choices::<S>(chat, k, layer))
                .child(
                    row()
                        .gap(4.0)
                        .center_y()
                        .grow(1.0)
                        .justify_end()
                        .child(attach)
                        .child(action),
                ),
        )
}

fn choices<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let selects = chat_selects(&chat.settings(), chat.choices.as_ref());
    row()
        .key("chat-choices")
        .gap(2.0)
        .center_y()
        .flex_wrap()
        .child(choice_menu::<S>(
            chat,
            k,
            layer,
            Open::Harness,
            "chat-harness",
            &selects.harness,
            |v| SetSettingsPayload {
                chat_harness: Some(v),
                ..empty_change()
            },
        ))
        .child(model::<S>(chat, k, layer, &selects.model))
        .child(choice_menu::<S>(
            chat,
            k,
            layer,
            Open::Effort,
            "chat-effort",
            &selects.effort,
            |v| SetSettingsPayload {
                chat_effort: Some(v),
                ..empty_change()
            },
        ))
}

fn choice_trigger(select: &ChoiceSelect) -> Button {
    Button::new(select.label.clone())
        .control_size(ControlSize::Regular)
        .variant(ButtonVariant::Ghost)
        .help(select.name.clone())
        .disabled(select.disabled)
}

fn choice_menu<S: Host>(
    chat: &Chat,
    k: &Kit,
    layer: &mut Vec<El>,
    which: Open,
    key: &str,
    select: &ChoiceSelect,
    change: fn(String) -> SetSettingsPayload,
) -> El {
    let open = chat.menu == Some(which);
    let trigger = choice_trigger(select)
        .expanded(open)
        .on_press(move |s: &mut S| {
            let chat = s.chat_mut();
            chat.model_menu.close();
            chat.menu = (!open).then_some(which);
        })
        .build(k)
        .label(select.name.clone())
        .key(key.to_string());
    let mut menu = Menu::new(format!("{key}-menu"))
        .trigger(trigger)
        .open(open)
        .placement(Placement::TopStart)
        .min_width(220.0)
        .on_close(|s: &mut S| s.chat_mut().menu = None);
    for option in &select.options {
        let value = option.value.clone();
        let mut item = MenuItem::new(option.label.clone())
            .checked(option.value == select.value)
            .disabled(option.disabled)
            .on_select(move |s: &mut S| choose_setting(s, change(value.clone())));
        if let Some(d) = &option.description {
            item = item.description(d.clone());
        }
        menu = menu.item(item);
    }
    if let Some(warning) = &select.warning {
        menu = menu.separator().group_label(warning.clone());
    }
    if let Some(note) = &select.note {
        menu = menu.separator().group_label(note.clone());
    }
    menu.build(k, layer)
}

/// The model select, which takes an id typed into its search (`ChatModelSelect.vue`).
fn model<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>, select: &ChoiceSelect) -> El {
    let mut options: Vec<ComboboxOption> = select
        .options
        .iter()
        .map(|o| ComboboxOption {
            id: o.value.clone(),
            label: o.label.clone(),
            detail: o.description.clone().unwrap_or_default(),
            disabled: o.disabled,
        })
        .collect();
    if let Some(typed) = typed_entry(&chat.model_menu.search.text, select) {
        options.push(ComboboxOption::new(typed.value, typed.label));
    }
    let trigger = choice_trigger(select)
        .build(k)
        .label(select.name.clone())
        .key("chat-model");
    Combobox::new(
        "chat-model-menu",
        &chat.model_menu,
        &options,
        model_menu::<S>,
    )
    .label(select.name.clone())
    .current(Some(select.value.as_str()))
    .search_placeholder(if select.reading {
        "Reading the models…"
    } else {
        "Search or type a model id"
    })
    .empty_message(select.note.clone().unwrap_or_else(|| "No models".into()))
    .placement(Placement::TopStart)
    .disabled(select.disabled)
    .trigger(trigger)
    .on_choose(|s: &mut S, id: &str, _| {
        choose_setting(
            s,
            SetSettingsPayload {
                chat_model: Some(id.to_string()),
                ..empty_change()
            },
        )
    })
    .build(k, layer)
}
