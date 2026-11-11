//! The Flock chat as Rune draws it: `FlockChat.vue`'s header, its log and the message box.

use crate::attachments::iso_of;
use crate::chat::{Chat, Open, list_earlier, pop, reopen, set_proactive, stage_paths};
use crate::choices::DEFAULT_CHAT_HARNESS;
use crate::composer::footer;
use crate::host::Host;
use crate::icons;
use crate::log::entries;
use crate::words::{earlier_note, harness_name};
use collie_desktop_protocol::generated::Conversation;
use rune::{Color, El, LiveRegion, col, el, icon, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, Kit, Menu, MenuItem,
    Placement, Spinner,
};

/// The Flock chat; its menus go on `layer`, the window's overlays.
pub fn chat<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let base = col()
        .key("chat")
        .on_drop_files(|s: &mut S, files, _| stage_paths(s, files.to_vec(), Vec::new()))
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .fill(k.c.bg_base)
        .child(header::<S>(chat, k, layer));
    if elsewhere(chat) {
        return base.child(popped::<S>(k));
    }
    base.child(log::<S>(chat, k))
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

/// The conversation is in its own window, and this pane only says so: the window in
/// `chat.alone` shows it however it was popped.
fn elsewhere(chat: &Chat) -> bool {
    chat.popped && chat.pop.is_some() && !chat.alone
}

fn log<S: Host>(chat: &Chat, k: &Kit) -> El {
    let end =
        el().key("chat-log-end")
            .w_full()
            .h(1.0)
            .on_layout_tx(|s: &mut S, [_, y, _, _], tx| {
                if !s.chat_mut().end_laid_out(y) {
                    tx.live_only();
                }
            });
    let scroller = col()
        .key("chat-log")
        .role("log")
        .label("Flock chat")
        .gap(18.0)
        .px(16.0)
        .pt(12.0)
        .pb(16.0)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(rune::ScrollSpec { stick_bottom: true })
        .scroll_edge_fade(16.0)
        .on_layout_tx(|s: &mut S, [_, y, _, h], tx| {
            s.chat_mut().log_laid_out(y + h);
            tx.live_only();
        })
        .children(entries::<S>(chat, k))
        .child(end);
    let jump = chat.away.then(|| {
        row()
            .w_full()
            .justify_center()
            .pin(Some(0.0), None, Some(0.0), Some(12.0))
            .child(
                row()
                    .key("chat-jump")
                    .role("button")
                    .label("Jump to latest")
                    .focusable(true)
                    .on_press_tx(|_: &mut S, tx| tx.scroll_to_bottom("chat-log"))
                    .gap(6.0)
                    .center_y()
                    .h(28.0)
                    .pl(10.0)
                    .pr(12.0)
                    .radius(14.0)
                    .fill(k.c.surface_raised)
                    .border(1.0, k.c.border_base)
                    .shadow(4.0, 12.0, k.c.black.alpha(0.18))
                    .hover(k.c.hover)
                    .child(icon(&icons::ARROW_DOWN, 13.0).color(k.c.icon_base))
                    .child(
                        text(if chat.transcript.running {
                            "Jump to the reply"
                        } else {
                            "Jump to latest"
                        })
                        .font(k.ty.text_xsmall_medium)
                        .color(k.c.text_base)
                        .a11y_hidden(),
                    ),
            )
    });
    col()
        .key("chat-log-frame")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(scroller)
        .children(jump)
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
    let pops = chat.pop.as_ref().map(|_| {
        let (glyph, said) = if chat.popped {
            (&icons::POP_IN, "Put back beside the board")
        } else {
            (&icons::POP_OUT, "Pop out")
        };
        let out = !chat.popped;
        IconButton::new(glyph)
            .variant(IconButtonVariant::GhostMuted)
            .label(said)
            .help(if out && chat.transcript.running {
                "Pop out, once the reply ends"
            } else {
                said
            })
            .disabled(out && chat.transcript.running)
            .on_press(move |s: &mut S| pop(s, out))
            .build(k)
            .key("chat-pop")
    });
    let head = row()
        .key("chat-header")
        .gap(2.0)
        .center_y()
        .w_full()
        .h(44.0)
        .pl(16.0)
        .pr(8.0)
        .child(
            text("Flock chat")
                .role("heading")
                .level(2)
                .font(k.ty.ui_medium)
                .color(k.c.text_strong),
        )
        .children(busy.then(|| Spinner::new().size(12.0).build(k).ml(8.0)))
        .child(el().grow(1.0));
    // The conversation's own controls are in its window while it is popped out.
    let here = (!elsewhere(chat)).then(|| [fresh, bell, earlier_menu::<S>(chat, k, layer)]);
    head.children(here.into_iter().flatten()).children(pops)
}

/// What the pane beside the board shows while the chat is in its own window.
fn popped<S: Host>(k: &Kit) -> El {
    col()
        .key("chat-popped")
        .role("status")
        .label("The chat is in its own window")
        .grow(1.0)
        .w_full()
        .items_center()
        .gap(6.0)
        .pt(96.0)
        .px(24.0)
        .child(
            el().size(40.0, 40.0)
                .radius(12.0)
                .fill(k.c.layer_02)
                .border(1.0, k.c.border_weak)
                .center()
                .mb(6.0)
                .child(icon(&icons::WINDOW, 18.0).color(k.c.icon_muted)),
        )
        .child(
            text("The chat is in its own window")
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .a11y_hidden(),
        )
        .child(
            text("Its conversation carries on there.")
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .a11y_hidden(),
        )
        .child(
            Button::new("Put it back here")
                .icon(&icons::POP_IN)
                .control_size(ControlSize::Small)
                .variant(ButtonVariant::Outline)
                .on_press(|s: &mut S| pop(s, false))
                .build(k)
                .key("chat-pop-in")
                .mt(10.0),
        )
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
        .min_width(300.0)
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
