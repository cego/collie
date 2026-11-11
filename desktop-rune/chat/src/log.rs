//! The chat's log: each message, its tool rows and thoughts, the question the chat asks, and
//! the notices between them (`FlockChat.vue`'s list, `ChatToolRow.vue`, `ChatQuestion.vue`).

use crate::agui::{Message, Part, Role};
use crate::ansi::{AnsiSpan, Colour, ansi_spans};
use crate::attachments::{Attached, size_said};
use crate::chat::{self, Chat, Setup, answer, copy, follow, pick_option, reconnect, retry};
use crate::highlight::colours;
use crate::host::Host;
use crate::icons;
use crate::policy::confined_chat;
use crate::words::{about_line, questions_of, tool_row};
use collie_desktop_protocol::generated::{About, Choice, Found, StoreSource};
use rune::{Color, El, Span, TextStyle, col, el, icon, rich, row, text};
use rune_kit::markdown::{Markdown, MarkdownStyle};
use rune_kit::syntax::Highlighter;
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit,
    Spinner,
};

/// Agent markdown as the chat sets it: the body's size, calmer bold and headings sized for a
/// side pane rather than a page.
pub(crate) fn chat_style(k: &Kit) -> MarkdownStyle {
    let body = TextStyle {
        line_height: 22.0,
        ..k.ty.body
    };
    let heading = |size, line_height| TextStyle {
        size,
        line_height,
        weight: 600.0,
        ..body
    };
    MarkdownStyle::from_kit(k)
        .body_font(body)
        .heading_font(1, heading(16.0, 24.0))
        .heading_font(2, heading(15.0, 22.0))
        .heading_font(3, heading(14.0, 22.0))
        .strong_weight(600.0)
        .list(18.0, 4.0)
}

fn markdown<S: Host>(k: &Kit, said: &str, live: bool) -> El {
    Markdown::new(confined_chat(said))
        .style(chat_style(k))
        .streaming(live)
        .selectable(true)
        .highlighter(Highlighter::new(colours))
        .on_link(|s: &mut S, url: &str| follow(s, url))
        .build(k)
}

/// The log's entries, oldest first, and what stands under the last message.
pub(crate) fn entries<S: Host>(chat: &Chat, k: &Kit) -> Vec<El> {
    let mut entries = Vec::new();
    let messages = &chat.transcript.messages;
    if messages.is_empty() && !chat.transcript.running {
        entries.push(if chat.loaded { empty(k) } else { loading(k) });
    }
    let last = messages.len().saturating_sub(1);
    for (at, m) in messages.iter().enumerate() {
        let live = chat.transcript.running && at == last;
        entries.push(message::<S>(chat, k, m, live, at == last));
    }
    if working(chat) {
        entries.push(
            row()
                .key("chat-working")
                .role("status")
                .label("Working")
                .gap(8.0)
                .center_y()
                .h(24.0)
                .child(Spinner::new().size(12.0).build(k))
                .child(
                    text("Working…")
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted)
                        .a11y_hidden(),
                ),
        );
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
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_muted),
                ),
        );
    }
    if let Some(why) = &chat.transcript.error {
        entries.push(failed::<S>(chat, k, why));
    }
    if let Some(why) = &chat.trouble {
        let said = match chat.retry_in(epoch_ms()) {
            Some(0) => format!("{}. Trying again now.", why.trim_end_matches('.')),
            Some(left) => format!("{}. Trying again in {left} s.", why.trim_end_matches('.')),
            None => why.clone(),
        };
        entries.push(notice(
            k,
            "chat-trouble",
            &icons::RETRY,
            k.c.warning,
            "Desktop is reconnecting to its chat",
            Some(&said),
            Some(
                Button::new("Retry now")
                    .control_size(ControlSize::Small)
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
        entries.push(queued_row::<S>(k, queued));
    }
    entries
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// A reply is under way with nothing streaming into view: before its first words, while a
/// tool runs, or between parts.
fn working(chat: &Chat) -> bool {
    if !chat.transcript.running {
        return false;
    }
    match chat.transcript.messages.last() {
        Some(m) if m.role == Role::Assistant => match m.parts.last() {
            Some(Part::Text(said)) => said.trim().is_empty(),
            Some(Part::Thinking(_)) => false,
            // A call still waiting spins on its own row.
            Some(Part::ToolCall { output, .. }) => output.is_some(),
            _ => true,
        },
        _ => true,
    }
}

fn queued_row<S: Host>(k: &Kit, queued: &crate::choices::Queued) -> El {
    let id = queued.id;
    let said = match (queued.text.is_empty(), queued.files.len()) {
        (false, _) => queued.text.clone(),
        (true, 1) => queued.files[0].name.clone(),
        (true, n) => format!("{n} files"),
    };
    row()
        .key(format!("chat-queued-{id}"))
        .gap(8.0)
        .center_y()
        .self_end()
        .max_w(380.0)
        .pl(12.0)
        .pr(4.0)
        .py(6.0)
        .radius(12.0)
        .border(1.0, k.c.border_base)
        .child(
            text(said)
                .font(k.ty.text_small)
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
                .help("Don't send")
                .on_press(move |s: &mut S| s.chat_mut().unqueue(id))
                .build(k)
                .key(format!("chat-unqueue-{id}")),
        )
}

/// What stands in the log while there is nothing in it: a glyph, a title and a line.
fn placeholder(k: &Kit, key: &str, mark: El, title: &str, said: &str) -> El {
    col()
        .key(key.to_string())
        .gap(6.0)
        .items_center()
        .w_full()
        .pt(72.0)
        .px(24.0)
        .child(
            el().size(40.0, 40.0)
                .radius(12.0)
                .fill(collie_desktop_theme::tones(k.dark).brand.bg)
                .border(1.0, collie_desktop_theme::tones(k.dark).brand.border)
                .center()
                .child(mark)
                .mb(6.0),
        )
        .child(
            text(title.to_string())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong),
        )
        .child(
            text(said.to_string())
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .wrap()
                .max_w(280.0)
                .align(rune::Align::Center),
        )
}

fn empty(k: &Kit) -> El {
    placeholder(
        k,
        "chat-empty",
        icon(&collie_desktop_theme::MARK, 24.0).color(collie_desktop_theme::tones(k.dark).brand.fg),
        "Ask about the Flock",
        "The chat sees every Machine's board. Ask what needs you, or select a card to ask about it.",
    )
}

fn loading(k: &Kit) -> El {
    placeholder(
        k,
        "chat-loading",
        Spinner::new().size(16.0).build(k),
        "Reading the conversation",
        "The chat picks up where it left off.",
    )
    .role("status")
    .label("Reading the conversation")
}

/// A notice in the log or above the message box: an icon, a title, what it says, an action.
pub(crate) fn notice(
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
                .font(k.ty.text_small_medium)
                .color(k.c.text_strong)
                .wrap(),
        )
        .children(said.map(|said| {
            text(said.to_string())
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .wrap()
                .selectable(true)
        }))
        .a11y_hidden();
    let body = row()
        .gap(10.0)
        .w_full()
        .child(icon(glyph, 16.0).color(tone.icon).mt(2.0))
        .child(words);
    col()
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
        .radius(10.0)
        .fill(tone.bg)
        .border(1.0, tone.border)
        .child(body)
        .children(action.map(|a| row().w_full().justify_end().pl(26.0).child(a)))
}

fn failed<S: Host>(chat: &Chat, k: &Kit, why: &str) -> El {
    let again = chat.transcript.last_said().map(|_| {
        Button::new("Try again")
            .icon(&icons::RETRY)
            .control_size(ControlSize::Small)
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
        .self_end()
        .max_w(320.0)
        .gap(4.0)
        .center_y()
        .px(8.0)
        .h(22.0)
        .radius(6.0)
        .fill(k.c.info.bg)
        .hover(k.c.hover)
        .child(icon(&icons::CARD, 12.0).color(k.c.info.icon))
        .child(
            text(line)
                .font(k.ty.text_xsmall_medium)
                .color(k.c.info.fg)
                .truncate()
                .shrink()
                .a11y_hidden(),
        )
}

fn copier<S: Host>(chat: &Chat, k: &Kit, m: &Message) -> El {
    let copied = chat.copied.as_deref() == Some(m.id.as_str());
    let (id, words) = (m.id.clone(), m.text());
    IconButton::new(if copied { &icons::CHECK } else { &icons::COPY })
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label(if copied { "Copied" } else { "Copy message" })
        .help("Copy message")
        .on_press_tx(move |s: &mut S, tx| copy(s, tx, &id, words.clone()))
        .build(k)
        .key(format!("copy-{}", m.id))
}

/// A message's parts as they read: each tool call's row, or a run of finished ones gathered
/// under one line.
enum Block<'a> {
    Part(usize, &'a Part),
    Tools(usize, Vec<&'a Part>),
}

fn blocks(parts: &[Part], live: bool) -> Vec<Block<'_>> {
    let mut blocks = Vec::new();
    let mut at = 0;
    while at < parts.len() {
        let end = parts[at..]
            .iter()
            .position(|p| !matches!(p, Part::ToolCall { .. }))
            .map_or(parts.len(), |n| at + n);
        // The run a reply is still making stays open, so its tools are seen as they run.
        let still_running = live && end == parts.len();
        if end - at >= 2 && !still_running {
            blocks.push(Block::Tools(at, parts[at..end].iter().collect()));
            at = end;
        } else {
            blocks.push(Block::Part(at, &parts[at]));
            at += 1;
        }
    }
    blocks
}

fn part<S: Host>(chat: &Chat, k: &Kit, m: &Message, at: usize, p: &Part, live: bool) -> El {
    match p {
        Part::Text(said) => markdown::<S>(k, said, live),
        Part::Attached(file) => chip::<S>(chat, k, file, false),
        Part::Thinking(thought) => {
            let still = live && at + 1 == m.parts.len();
            thinking::<S>(chat, k, &format!("{}-{at}", m.id), thought, still)
        }
        Part::ToolCall {
            id,
            name,
            arguments,
            output,
        } => tool::<S>(chat, k, id, name, arguments, output.as_deref()),
    }
}

fn message<S: Host>(chat: &Chat, k: &Kit, m: &Message, live: bool, last: bool) -> El {
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
            .radius(10.0)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak)
            .child(
                row()
                    .gap(6.0)
                    .center_y()
                    .child(icon(&icons::INFO, 13.0).color(k.c.icon_muted))
                    .child(
                        text("Desktop noticed")
                            .font(k.ty.text_xsmall_medium)
                            .color(k.c.text_muted),
                    ),
            )
            .child(markdown::<S>(k, said, false));
    }
    let words = !m.text().is_empty() && !live;
    match m.role {
        Role::User => {
            let parts = m
                .parts
                .iter()
                .enumerate()
                .map(|(at, p)| part::<S>(chat, k, m, at, p, false));
            col()
                .key(key)
                .role("article")
                .label("You said")
                .gap(4.0)
                .w_full()
                .items_end()
                .hover_group()
                .children(m.about.as_ref().map(|a| about_badge::<S>(k, a)))
                .child(
                    row()
                        .gap(4.0)
                        .items_end()
                        .justify_end()
                        .w_full()
                        .children(words.then(|| copier::<S>(chat, k, m).group_opacity(0.0, 1.0)))
                        .child(
                            col()
                                .gap(8.0)
                                .max_w(380.0)
                                .shrink()
                                .px(14.0)
                                .py(9.0)
                                .radius(14.0)
                                .fill(collie_desktop_theme::tones(k.dark).brand.bg)
                                .children(parts),
                        ),
                )
        }
        Role::Assistant => {
            let parts = blocks(&m.parts, live).into_iter().map(|b| match b {
                Block::Part(at, p) => part::<S>(chat, k, m, at, p, live),
                Block::Tools(at, run) => tools::<S>(chat, k, &format!("{}-{at}", m.id), &run),
            });
            // The latest reply keeps its copy button in view; earlier ones show it on hover.
            let copy = words.then(|| {
                let c = copier::<S>(chat, k, m).ml(-6.0);
                if last { c } else { c.group_opacity(0.0, 1.0) }
            });
            col()
                .key(key)
                .role("article")
                .label("The chat said")
                .gap(10.0)
                .w_full()
                .hover_group()
                .children(parts)
                .children(copy.map(|c| row().h(24.0).mt(-8.0).child(c)))
        }
    }
}

fn disclosure_chevron(k: &Kit, open: bool) -> El {
    icon(
        if open {
            &icons::CHEVRON_DOWN
        } else {
            &icons::CHEVRON
        },
        12.0,
    )
    .color(k.c.icon_faint)
}

fn thinking<S: Host>(chat: &Chat, k: &Kit, key: &str, thought: &str, still: bool) -> El {
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
        .pr(6.0)
        .radius(6.0)
        .hover_group()
        .children((!still).then(|| icon(&icons::THOUGHT, 14.0).color(k.c.icon_faint)))
        .children(still.then(|| Spinner::new().size(12.0).build(k)))
        .child(
            text(if still { "Thinking…" } else { "Thinking" })
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .group_color(k.c.text_base)
                .a11y_hidden(),
        )
        .child(disclosure_chevron(k, open));
    col().key(key).w_full().child(head).children(open.then(|| {
        row()
            .w_full()
            .pl(6.0)
            .pt(2.0)
            .child(el().w(2.0).fill(k.c.border_weak).radius(1.0))
            .child(
                text(thought.to_string())
                    .font(k.ty.text_xsmall)
                    .color(k.c.text_muted)
                    .wrap_anywhere()
                    .selectable(true)
                    .grow(1.0)
                    .shrink()
                    .pl(12.0),
            )
    }))
}

/// A run of finished tool calls, as one line until opened.
fn tools<S: Host>(chat: &Chat, k: &Kit, key: &str, run: &[&Part]) -> El {
    let key = format!("tools-{key}");
    let open = chat.expanded.contains(&key);
    let toggled = key.clone();
    let mut names: Vec<String> = Vec::new();
    for p in run {
        if let Part::ToolCall {
            name, arguments, ..
        } = p
        {
            let said = tool_row(name, arguments).tool;
            if !names.contains(&said) {
                names.push(said);
            }
        }
    }
    let used = format!("Used {} tools", run.len());
    let head = row()
        .key(format!("{key}-toggle"))
        .role("button")
        .label(format!("{used}: {}", names.join(", ")))
        .expanded(open)
        .focusable(true)
        .on_press(move |s: &mut S| s.chat_mut().toggle(&toggled))
        .gap(8.0)
        .center_y()
        .w_full()
        .h(28.0)
        .px(8.0)
        .radius(6.0)
        .hover(k.c.hover)
        .child(icon(&icons::TOOL, 13.0).color(k.c.icon_faint))
        .child(
            text(used)
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_base)
                .a11y_hidden(),
        )
        .child(
            text(names.join(", "))
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .truncate()
                .shrink()
                .grow(1.0)
                .a11y_hidden(),
        )
        .child(disclosure_chevron(k, open));
    let rows = open.then(|| {
        col()
            .key(format!("{key}-rows"))
            .w_full()
            .pl(12.0)
            .children(run.iter().filter_map(|p| match p {
                Part::ToolCall {
                    id,
                    name,
                    arguments,
                    output,
                } => Some(tool::<S>(chat, k, id, name, arguments, output.as_deref())),
                _ => None,
            }))
    });
    col().key(key).w_full().ml(-8.0).child(head).children(rows)
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
        .h(28.0)
        .px(8.0)
        .radius(6.0)
        .hover(k.c.hover)
        .child(if waiting {
            Spinner::new().size(12.0).build(k)
        } else {
            icon(&icons::TOOL, 13.0).color(k.c.icon_faint)
        })
        .child(
            text(row_said.tool.clone())
                .font(k.ty.text_xsmall_medium)
                .color(k.c.text_base)
                .a11y_hidden(),
        )
        .children(
            row_said
                .machine
                .clone()
                .map(|machine| Badge::new(machine).variant(BadgeVariant::Subtle).build(k)),
        )
        .child(
            text(row_said.summary.clone())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .truncate()
                .shrink()
                .grow(1.0)
                .a11y_hidden(),
        )
        .child(disclosure_chevron(k, open));
    let body = open.then(|| {
        let pretty = serde_json::from_str::<serde_json::Value>(args)
            .ok()
            .and_then(|v| serde_json::to_string_pretty(&v).ok())
            .unwrap_or_else(|| args.to_string());
        col()
            .key(format!("{key}-detail"))
            .gap(8.0)
            .w_full()
            .pl(29.0)
            .pr(8.0)
            .pt(2.0)
            .pb(8.0)
            .children(
                (!args.trim().is_empty())
                    .then(|| code_box(k, "Input", text(pretty).font(k.ty.mono))),
            )
            .child(match output {
                Some(out) => code_box(k, "Output", ansi(k, out)),
                None => code_box(
                    k,
                    "Output",
                    text("No result yet.")
                        .font(k.ty.text_xsmall)
                        .color(k.c.text_faint),
                ),
            })
    });
    col().key(key).w_full().ml(-8.0).child(head).children(body)
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
                .radius(8.0)
                .fill(k.c.bg_deep)
                .border(1.0, k.c.border_weak)
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
        .gap(14.0)
        .w_full()
        .padding(14.0)
        .radius(12.0)
        .border(1.0, k.c.border_base)
        .fill(k.c.layer_01);
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
            let mark = el()
                .size(14.0, 14.0)
                .radius(if q.multi_select { 4.0 } else { 7.0 })
                .border(
                    if on { 4.5 } else { 1.0 },
                    if on {
                        k.c.border_focus
                    } else {
                        k.c.border_strong
                    },
                )
                .mt(2.0)
                .a11y_hidden();
            let mut button =
                row()
                    .key(format!("question-{id}-{qi}-{oi}"))
                    .role(if q.multi_select { "checkbox" } else { "radio" })
                    .label(option.label.clone())
                    .checked(on)
                    .focusable(!answered)
                    .disabled(answered)
                    .on_press(move |s: &mut S| pick_option(s, &tool_id, &args, &question, &label))
                    .gap(10.0)
                    .w_full()
                    .px(10.0)
                    .py(8.0)
                    .radius(8.0)
                    .border(
                        1.0,
                        if on {
                            k.c.border_focus
                        } else {
                            k.c.border_weak
                        },
                    )
                    .fill(if on { k.c.layer_02 } else { k.c.layer_01 })
                    .hover(k.c.hover)
                    .child(mark)
                    .child(
                        col()
                            .gap(2.0)
                            .grow(1.0)
                            .shrink()
                            .child(
                                text(option.label.clone())
                                    .font(k.ty.text_small_medium)
                                    .color(k.c.text_strong)
                                    .wrap(),
                            )
                            .children(option.description.clone().map(|d| {
                                text(d).font(k.ty.text_xsmall).color(k.c.text_muted).wrap()
                            }))
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
                        .color(k.c.text_faint)
                }))
                .child(
                    text(q.question.clone())
                        .font(k.ty.body_medium)
                        .color(k.c.text_strong)
                        .wrap()
                        .mb(4.0),
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
                .control_size(ControlSize::Small)
                .variant(ButtonVariant::GhostMuted)
                .on_press(|s: &mut S| chat::decline_setup(s, true))
                .build(k)
                .key("setup-never"),
            Button::new("Not now")
                .control_size(ControlSize::Small)
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
            .padding(14.0)
            .radius(12.0)
            .fill(k.c.layer_01)
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
                    .pt(4.0)
                    .children(actions),
            )
    };
    let muted = |said: &str| {
        text(said.to_string())
            .font(k.ty.text_xsmall)
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
                    .control_size(ControlSize::Small)
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
                                .font(k.ty.text_xsmall_medium)
                                .color(k.c.text_base),
                        ];
                        match &computer.problem {
                            Some(problem) => lines.push(
                                text(problem.clone())
                                    .font(k.ty.text_xsmall)
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
                    .control_size(ControlSize::Small)
                    .variant(ButtonVariant::Outline)
                    .on_press(|s: &mut S| chat::choose_setup(s, Choice::Ask))
                    .build(k)
                    .key("setup-ask"),
            );
            actions.push(
                Button::new("Read my messages")
                    .control_size(ControlSize::Small)
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
pub(crate) fn chip<S: Host>(chat: &Chat, k: &Kit, file: &Attached, removable: bool) -> El {
    let thumb = match chat.thumbs.get(&file.id) {
        Some(pixels) => el().size(28.0, 28.0).radius(6.0).pixels(pixels),
        None => el()
            .size(28.0, 28.0)
            .radius(6.0)
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
        .radius(10.0)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_weak)
        .child(thumb.a11y_hidden())
        .child(
            col()
                .shrink()
                .child(
                    text(file.name.clone())
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_base)
                        .truncate_middle(),
                )
                .child(
                    text(size_said(file.size))
                        .font(k.ty.small)
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
