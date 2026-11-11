//! The message box under the log: the card and files it carries, the words, the harness,
//! model and effort it runs on, and Send or Stop (`UChatPrompt` in `FlockChat.vue`,
//! `ChatChoiceSelect.vue`, `ChatModelSelect.vue`).

use crate::attachments::{iso_of, pasted_paths};
use crate::chat::{
    Chat, Open, choose_setting, clipboard_files, pick, send, stage_image, stage_paths, stay,
};
use crate::choices::{
    ChoiceSelect, chat_selects, choice_notices, empty_change, reply_button, typed_entry,
};
use crate::host::Host;
use crate::icons;
use crate::log::{chip, notice};
use crate::words::about_line;
use collie_desktop_protocol::generated::SetSettingsPayload;
use rune::edit::TextEdit;
use rune::{El, Key, icon, row, text, text_input};
use rune_kit::{
    Button, ButtonVariant, Combobox, ComboboxOption, ComboboxState, ControlSize, IconButton,
    IconButtonVariant, Kit, Menu, MenuItem, Placement,
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

/// What stands under the log: notices about the next message's choices, then the message box.
pub(crate) fn footer<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
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
                    .control_size(ControlSize::Small)
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
            .radius(10.0)
            .fill(k.c.layer_01)
            .border(1.0, k.c.border_weak)
            .child(icon(&icons::INFO, 14.0).color(k.c.icon_muted).mt(2.0))
            .child(
                text(format!(
                    "This reply finishes on {}. Your next message runs on {}.",
                    r.current, r.next
                ))
                .font(k.ty.text_xsmall)
                .color(k.c.text_base)
                .wrap()
                .shrink(),
            )
    });
    let failed = chat.failed.as_ref().map(|why| {
        notice(
            k,
            "chat-failed",
            &icons::ALERT,
            k.c.danger,
            why,
            None,
            Some(
                Button::new("Dismiss")
                    .control_size(ControlSize::Small)
                    .variant(ButtonVariant::Ghost)
                    .on_press(|s: &mut S| s.chat_mut().failed = None)
                    .build(k)
                    .key("chat-failed-dismiss"),
            ),
        )
    });
    rune::col()
        .key("chat-footer")
        .gap(8.0)
        .w_full()
        .px(12.0)
        .pt(4.0)
        .pb(12.0)
        .children(failed)
        .children(waiting)
        .children(reply)
        .child(prompt::<S>(chat, k, layer))
}

fn about_chip<S: Host>(chat: &Chat, k: &Kit) -> Option<El> {
    let about = chat.about.as_ref()?;
    let line = about_line(about);
    Some(
        row()
            .key("chat-chip")
            .role("group")
            .label(format!("About: {line}"))
            .gap(4.0)
            .center_y()
            .max_w(320.0)
            .pl(8.0)
            .pr(2.0)
            .h(26.0)
            .radius(8.0)
            .fill(k.c.info.bg)
            .border(1.0, k.c.info.border)
            .child(icon(&icons::CARD, 12.0).color(k.c.info.icon))
            .child(
                text(line)
                    .font(k.ty.text_xsmall_medium)
                    .color(k.c.info.fg)
                    .truncate()
                    .shrink()
                    .a11y_hidden(),
            )
            .child(
                IconButton::new(&icons::CLOSE)
                    .variant(IconButtonVariant::GhostMuted)
                    .control_size(ControlSize::Small)
                    .label("Clear")
                    .help("Don't send it about this card")
                    .on_press(|s: &mut S| s.chat_mut().choose(None))
                    .build(k)
                    .key("chat-chip-clear"),
            ),
    )
}

fn prompt<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let running = chat.transcript.running;
    let about = about_chip::<S>(chat, k);
    let files = chat.attached.iter().map(|f| chip::<S>(chat, k, f, true));
    let has_chips = about.is_some() || !chat.attached.is_empty();
    let chips = has_chips.then(|| {
        row()
            .key("chat-chips")
            .gap(6.0)
            .w_full()
            .flex_wrap()
            .px(4.0)
            .children(about)
            .children(files)
    });
    let refused = chat.refused.as_ref().map(|why| {
        text(why.clone())
            .key("chat-refused")
            .role("alert")
            .label(why.clone())
            .font(k.ty.text_xsmall)
            .color(k.c.danger.fg)
            .wrap()
            .w_full()
            .px(4.0)
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
        .color(k.c.text_strong)
        .caret(k.c.text_base, k.selection())
        .w_full()
        .on_edit(composer::<S>)
        .on_submit(|s: &mut S, tx| {
            send(s, false);
            tx.scroll_to_bottom("chat-log");
        })
        .on_input_key(|s: &mut S, key, tx| {
            let now = key.key == Key::Enter && key.mods.cmd;
            if now {
                send(s, true);
                tx.scroll_to_bottom("chat-log");
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
    let button = reply_button(running, chat.desktop_speaking);
    let action = if button.stops {
        IconButton::new(&icons::STOP)
            .variant(IconButtonVariant::Contrast)
            .label(button.name)
            .help(button.name)
            .on_press(|s: &mut S| crate::chat::stop(s))
            .build(k)
            .key("stop")
    } else {
        let empty = chat.composer.text.trim().is_empty() && chat.attached.is_empty();
        IconButton::new(&icons::SEND)
            .variant(IconButtonVariant::Submit)
            .label(button.name)
            .help(if running {
                "Send: it waits for the reply under way"
            } else {
                "Send"
            })
            .disabled(empty)
            .on_press_tx(|s: &mut S, tx| {
                send(s, false);
                tx.scroll_to_bottom("chat-log");
            })
            .build(k)
            .key("send")
    };
    rune::col()
        .key("chat-prompt")
        .gap(4.0)
        .w_full()
        .pt(8.0)
        .px(6.0)
        .pb(6.0)
        .radius(14.0)
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
        .child(field.px(8.0).pb(4.0))
        .child(
            row()
                .key("chat-prompt-footer")
                .gap(4.0)
                .items_end()
                .w_full()
                .child(choices::<S>(chat, k, layer))
                .child(row().gap(2.0).center_y().child(attach).child(action)),
        )
}

fn choices<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>) -> El {
    let selects = chat_selects(&chat.settings(), chat.choices.as_ref());
    row()
        .key("chat-choices")
        .gap(2.0)
        .center_y()
        .flex_wrap()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
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

/// A select's trigger: its value and a chevron, quiet until hovered, as OpenCode's prompt
/// draws its agent and model.
fn choice_trigger(k: &Kit, key: &str, select: &ChoiceSelect, open: bool) -> El {
    let ink = if select.disabled {
        k.c.text_faint
    } else if open {
        k.c.text_strong
    } else {
        k.c.text_muted
    };
    row()
        .key(key.to_string())
        .role("button")
        .label(select.name.clone())
        .help(select.name.clone())
        .focusable(!select.disabled)
        .disabled(select.disabled)
        .expanded(open)
        .gap(3.0)
        .center_y()
        .h(28.0)
        .pl(8.0)
        .pr(5.0)
        .radius(8.0)
        .min_w(0.0)
        .shrink()
        .fill(if open {
            k.c.layer_03
        } else {
            rune::Color::TRANSPARENT
        })
        .hover(if select.disabled {
            rune::Color::TRANSPARENT
        } else {
            k.c.hover
        })
        .hover_group()
        .child(
            // The menu and the name say a value is the default; the trigger keeps to the value.
            text(
                select
                    .label
                    .strip_prefix("Default · ")
                    .unwrap_or(&select.label)
                    .to_string(),
            )
            .font(k.ty.text_xsmall_medium)
            .color(ink)
            .group_color(if select.disabled {
                ink
            } else {
                k.c.text_strong
            })
            .truncate()
            .shrink()
            .a11y_hidden(),
        )
        .children(
            (!select.disabled).then(|| icon(&icons::CHEVRON_DOWN, 12.0).color(k.c.icon_faint)),
        )
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
    let mut trigger = choice_trigger(k, key, select, open);
    if !select.disabled {
        trigger = trigger.on_press(move |s: &mut S| {
            let chat = s.chat_mut();
            chat.model_menu.close();
            chat.menu = (!open).then_some(which);
        });
    }
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

/// The model select, which takes an id typed into its search (`ChatModelSelect.vue`). A row's
/// detail is its description, else its id where the label hides it, so either finds it.
fn model<S: Host>(chat: &Chat, k: &Kit, layer: &mut Vec<El>, select: &ChoiceSelect) -> El {
    let mut options: Vec<ComboboxOption> = select
        .options
        .iter()
        .map(|o| ComboboxOption {
            id: o.value.clone(),
            label: o.label.clone(),
            detail: model_detail(o),
            disabled: o.disabled,
        })
        .collect();
    if let Some(typed) = typed_entry(&chat.model_menu.search.text, select) {
        options.push(ComboboxOption::new(typed.value, typed.label));
    }
    let trigger = choice_trigger(k, "chat-model", select, chat.model_menu.open);
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
    .width(300.0)
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

fn model_detail(option: &crate::choices::ChoiceOption) -> String {
    let id = &option.value;
    let hidden = !id.is_empty() && !option.label.to_lowercase().contains(&id.to_lowercase());
    match (&option.description, hidden) {
        (Some(d), true) => format!("{d} · {id}"),
        (Some(d), false) => d.clone(),
        (None, true) => id.clone(),
        (None, false) => String::new(),
    }
}
