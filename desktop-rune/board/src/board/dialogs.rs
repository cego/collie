//! The board's dialogs: a Steer's or Follow-up's words, what a Run offers, a card's
//! questions, and a proposal to read before a yes.

use super::questionnaire::{Event, Where};
use super::{Dialog, Words, offer_key};
use crate::App;
use collie_desktop_protocol::generated::Question;
use rune::{El, LiveRegion, TextEdit, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog as Modal, Kit, TextArea, TextInput};

fn close(app: &mut App) {
    app.board.dialog = None;
}

fn words_edit(app: &mut App) -> &mut TextEdit {
    match &mut app.board.dialog {
        Some(Dialog::Words { edit, .. }) => edit,
        _ => unreachable!("a words dialog is open"),
    }
}

pub fn dialog(app: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(open) = &app.board.dialog else {
        return;
    };
    match open {
        Dialog::Words {
            kind, title, edit, ..
        } => {
            let empty = edit.text.trim().is_empty();
            let body = col()
                .gap(12.0)
                .padding(16.0)
                .pt(0.0)
                .child(
                    TextArea::new(edit)
                        .rows(4)
                        .label(title.clone())
                        .on_edit(words_edit)
                        .build(k)
                        .key("words"),
                )
                .child(
                    row().w_full().justify_end().child(
                        Button::new(match kind {
                            Words::Steer => "Steer",
                            Words::FollowUp => "Start follow-up",
                        })
                        .variant(ButtonVariant::Contrast)
                        .disabled(empty)
                        .on_press(App::send_words)
                        .build(k)
                        .key("send-words"),
                    ),
                );
            Modal::new("words", title.clone())
                .open(true)
                .fit()
                .child(body)
                .on_close(close)
                .build(k, layer);
        }
        Dialog::Offers {
            run,
            as_of,
            offers,
            picked,
            fields,
            ..
        } => {
            let mut body = col().gap(8.0).padding(16.0).pt(0.0).w_full();
            let title = match picked {
                Some(offer) => offer.title.clone(),
                None => format!("What next for {run}?"),
            };
            match (offers, picked) {
                (None, _) => {
                    body = body.child(
                        text("Asking what it offers…")
                            .font(k.ty.ui)
                            .color(k.c.text_muted)
                            .role("status"),
                    )
                }
                (Some(offers), None) => {
                    if offers.is_empty() {
                        body = body.child(
                            text("It offers nothing now.")
                                .font(k.ty.ui)
                                .color(k.c.text_muted),
                        );
                    }
                    for offer in offers {
                        let refused = app.refusal(offer.unavailable.as_deref(), *as_of);
                        let label = match &refused {
                            None => offer.title.clone(),
                            Some(why) => format!("{}: {why}", offer.title),
                        };
                        let chosen = offer.clone();
                        body = body.child(
                            Button::new(label)
                                .variant(ButtonVariant::Outline)
                                .disabled(refused.is_some())
                                .on_press(move |app: &mut App| app.pick_offer(chosen.clone()))
                                .build(k)
                                .key(format!("offer-{}", offer_key(offer)))
                                .w_full(),
                        );
                    }
                }
                (Some(_), Some(offer)) => match app.refusal(offer.unavailable.as_deref(), *as_of) {
                    Some(why) => body = body.child(text(why).font(k.ty.ui).color(k.c.text_muted)),
                    None => {
                        for (at, (name, required, edit)) in fields.iter().enumerate() {
                            body = body.child(
                                text(if *required {
                                    format!("{name} *")
                                } else {
                                    name.clone()
                                })
                                .font(k.ty.small_medium)
                                .color(k.c.text_muted)
                                .a11y_hidden(),
                            );
                            body = body.child(
                                TextInput::new(edit)
                                    .label(name.clone())
                                    .on_edit(move |app: &mut App| match &mut app.board.dialog {
                                        Some(Dialog::Offers { fields, .. }) => &mut fields[at].2,
                                        _ => unreachable!("an offers dialog is open"),
                                    })
                                    .on_submit(|app: &mut App, _: &mut rune::Tx| app.make_offer())
                                    .build(k)
                                    .key(format!("field-{name}")),
                            );
                        }
                        body = body.child(
                            row().w_full().justify_end().child(
                                Button::new(offer.title.clone())
                                    .variant(ButtonVariant::Contrast)
                                    .on_press(App::make_offer)
                                    .build(k)
                                    .key("invoke"),
                            ),
                        );
                    }
                },
            }
            Modal::new("offers", title)
                .open(true)
                .fit()
                .child(body)
                .on_close(close)
                .build(k, layer);
        }
        Dialog::Questions {
            card,
            installation,
            machine,
            title,
            sitting,
        } => {
            let open: Vec<Question> = app
                .placed_by(card)
                .map(|p| {
                    super::answers::open_questions(p.task)
                        .into_iter()
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            let now = super::answers::Now {
                installation,
                open: open.iter().collect(),
                answering: &app.board.answering,
            };
            let view = sitting.view(&now);
            let mut body = col()
                .key("question-dialog")
                .gap(12.0)
                .padding(16.0)
                .pt(0.0)
                .w_full();
            if let Some(question) = &view.question {
                body = body.child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .center_y()
                        .child(
                            text(format!("Question {} of {}", view.k, view.n))
                                .key("question-count")
                                .font(k.ty.ui_medium)
                                .color(k.c.text_base),
                        )
                        .child(el().grow(1.0))
                        .child(
                            text(format!("{} · {}", question.step, question.run))
                                .font(k.ty.small)
                                .color(k.c.text_faint)
                                .truncate()
                                .shrink(),
                        ),
                );
                body = body.child(form(app, k, installation, machine, question));
                if view.n > 1 {
                    body = body.child(
                        row()
                            .w_full()
                            .justify_between()
                            .child(
                                Button::new("Back")
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .disabled(!view.back)
                                    .on_press(|app: &mut App| app.move_sitting(-1))
                                    .build(k)
                                    .key("question-back"),
                            )
                            .child(
                                Button::new("Next")
                                    .variant(ButtonVariant::Ghost)
                                    .control_size(ControlSize::Small)
                                    .disabled(!view.next)
                                    .on_press(|app: &mut App| app.move_sitting(1))
                                    .build(k)
                                    .key("question-next"),
                            ),
                    );
                }
            }
            Modal::new("questions", title.clone())
                .open(true)
                .width(560.0)
                .fit()
                .child(scrolled(body))
                .on_close(close)
                .build(k, layer);
        }
        Dialog::Proposal { proposal, seen, .. } => {
            let mut steps = col().gap(6.0).pt(12.0);
            for (at, action) in proposal.actions.iter().enumerate() {
                let said = if action.allowed {
                    format!("{}. {}", at + 1, action.text)
                } else {
                    format!("{}. {} — needs your yes", at + 1, action.text)
                };
                steps = steps.child(
                    text(said)
                        .font(k.ty.ui)
                        .color(if action.allowed {
                            k.c.text_base
                        } else {
                            k.c.text_muted
                        })
                        .wrap()
                        .w_full(),
                );
            }
            let content = col()
                .key("proposal-content")
                .w_full()
                .max_h(360.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .on_drawn_layout(|app: &mut App, r: [f32; 4]| {
                    app.proposal_drawn(Some([r[1], r[3]]), None)
                })
                .child(
                    text(proposal.text.clone())
                        .font(k.ty.ui)
                        .color(k.c.text_base)
                        .wrap()
                        .selectable(true)
                        .w_full(),
                )
                .child(steps)
                .child(el().key("proposal-end").h(1.0).w_full().on_drawn_layout(
                    |app: &mut App, r: [f32; 4]| app.proposal_drawn(None, Some(r[1] + r[3])),
                ));
            let footer = row()
                .w_full()
                .gap(8.0)
                .center_y()
                .child(
                    text(if *seen {
                        format!("{} · {}", proposal.id, proposal.hash)
                    } else {
                        "Read to the end to confirm.".to_string()
                    })
                    .key("proposal-id")
                    .font(k.ty.small)
                    .color(k.c.text_faint)
                    .truncate()
                    .grow(1.0)
                    .shrink(),
                )
                .child(
                    Button::new("Decline")
                        .variant(ButtonVariant::Outline)
                        .on_press(|app: &mut App| app.decide(false))
                        .build(k)
                        .key("decline"),
                )
                .child(
                    Button::new("Confirm")
                        .variant(ButtonVariant::Contrast)
                        .disabled(!seen)
                        .on_press(|app: &mut App| app.decide(true))
                        .build(k)
                        .key("confirm"),
                );
            Modal::new("proposal", "What Collie proposes")
                .open(true)
                .width(600.0)
                .fit()
                .child(
                    col()
                        .gap(12.0)
                        .padding(16.0)
                        .pt(0.0)
                        .child(content)
                        .child(footer),
                )
                .on_close(close)
                .build(k, layer);
        }
    }
}

fn scrolled(body: El) -> El {
    col()
        .w_full()
        .max_h(560.0)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .child(body)
}

/// One question as a questionnaire: its options or its words, Submit, the status, and
/// the steering entry.
fn form(app: &App, k: &Kit, installation: &str, machine: &str, question: &Question) -> El {
    let asked = app.questionnaire_of(installation, question);
    let view = asked.view();
    let step = {
        let (installation, machine, question) = (
            installation.to_string(),
            machine.to_string(),
            question.clone(),
        );
        move |event: Event| {
            let (installation, machine, question) =
                (installation.clone(), machine.clone(), question.clone());
            move |app: &mut App| {
                app.step_question(&installation, &machine, &question, event.clone());
            }
        }
    };
    let mut form = col().key("questionnaire").gap(10.0).w_full().child(
        text(view.text.clone())
            .key("question-text")
            .font(k.ty.ui)
            .color(k.c.text_base)
            .wrap()
            .selectable(true)
            .w_full(),
    );
    if let Some(shortfall) = &view.shortfall {
        form = form.child(
            text(format!("⚠ {shortfall}"))
                .key("shortfall")
                .font(k.ty.small)
                .color(k.c.warning.fg)
                .wrap()
                .w_full(),
        );
    }
    let key = super::answers::answer_key(installation, &question.run, &question.id);
    let (typed_key, draft_key) = (format!("answer\u{0}{key}"), format!("steer\u{0}{key}"));
    let fed = |which: String, event: fn(String) -> Event| {
        let (installation, machine, question) = (
            installation.to_string(),
            machine.to_string(),
            question.clone(),
        );
        move |app: &mut App, _: &mut rune::Tx| {
            let words = app
                .board
                .edits
                .get(&which)
                .map(|e| e.text.clone())
                .unwrap_or_default();
            app.step_question(&installation, &machine, &question, event(words));
        }
    };
    let edit_or = |which: &str| {
        app.board
            .edits
            .get(which)
            .cloned()
            .unwrap_or_else(|| TextEdit::new(""))
    };
    if view.words {
        let edit = edit_or(&typed_key);
        form = form.child(
            row()
                .w_full()
                .gap(8.0)
                .child(
                    TextInput::new(&edit)
                        .label("Your answer")
                        .on_change(fed(typed_key.clone(), Event::Type))
                        .on_edit(edit_at(typed_key.clone()))
                        .on_submit({
                            let s = step(Event::Key {
                                key: "Enter".into(),
                                r#mod: false,
                                at: Where::Answer,
                            });
                            move |app: &mut App, _: &mut rune::Tx| s(app)
                        })
                        .build(k)
                        .key("answer")
                        .grow(1.0),
                )
                .child(
                    Button::new("Send")
                        .variant(ButtonVariant::Contrast)
                        .disabled(!view.submit)
                        .on_press(step(Event::Submit(super::new_request())))
                        .build(k)
                        .key("send-answer"),
                ),
        );
    } else {
        let mut options = col()
            .key("options")
            .role("radiogroup")
            .label(view.text.clone())
            .gap(6.0)
            .w_full();
        for (at, (one, checked)) in view.rows.iter().enumerate() {
            let detail = one.why.clone().or_else(|| one.detail.clone());
            let mut line = row().w_full().gap(8.0).center_y().child(
                el().size(14.0, 14.0)
                    .radius(7.0)
                    .border(
                        if *checked { 4.0 } else { 1.0 },
                        if *checked {
                            k.c.border_focus
                        } else {
                            k.c.border_strong
                        },
                    )
                    .a11y_hidden(),
            );
            line = line.child(
                text(one.title.clone())
                    .font(k.ty.ui_medium)
                    .color(k.c.text_base)
                    .wrap()
                    .grow(1.0)
                    .shrink(),
            );
            if one.recommended {
                line = line.child(
                    text("Recommended")
                        .font(k.ty.small_medium)
                        .color(k.c.text_accent),
                );
            }
            let mut option = col()
                .key(format!("option-{at}"))
                .w_full()
                .gap(2.0)
                .padding(10.0)
                .radius(6.0)
                .border(
                    1.0,
                    if *checked {
                        k.c.border_focus
                    } else {
                        k.c.border_weak
                    },
                )
                .fill(if *checked { k.c.layer_02 } else { k.c.layer_01 })
                .child(line)
                .children(detail.clone().map(|d| {
                    text(d)
                        .font(k.ty.small)
                        .color(k.c.text_muted)
                        .wrap()
                        .pl(22.0)
                        .w_full()
                }));
            if !one.disabled {
                option = option
                    .hover(k.c.surface_hover)
                    .on_press(step(Event::Pick(one.id.clone())));
            }
            options = options.child(
                option
                    .role("radio")
                    .label(one.title.clone())
                    .description(detail.unwrap_or_default())
                    .checked(*checked)
                    .disabled(one.disabled)
                    .focusable(!one.disabled),
            );
        }
        form = form.child(options).child(
            row().w_full().justify_end().child(
                Button::new("Submit answer")
                    .variant(ButtonVariant::Contrast)
                    .disabled(!view.submit)
                    .on_press(step(Event::Submit(super::new_request())))
                    .build(k)
                    .key("submit-answer"),
            ),
        );
    }
    form = form.child(
        text(view.status.clone().unwrap_or_default())
            .key("answer-state")
            .font(k.ty.small)
            .color(k.c.text_muted)
            .role("status")
            .label(view.status.clone().unwrap_or_default())
            .live_region(LiveRegion::Polite)
            .wrap()
            .w_full(),
    );
    let draft = edit_or(&draft_key);
    form.child(el().h(1.0).w_full().fill(k.c.border_weak).a11y_hidden())
        .child(
            col()
                .key("steering")
                .gap(6.0)
                .w_full()
                .child(
                    text("Or tell the agent something else instead")
                        .font(k.ty.small_medium)
                        .color(k.c.text_muted)
                        .a11y_hidden(),
                )
                .child(
                    TextInput::new(&draft)
                        .label("Or tell the agent something else instead")
                        .placeholder(
                            "It sets the question aside: the agent re-thinks and asks again.",
                        )
                        .disabled(view.steer_disabled)
                        .on_edit(edit_at(draft_key.clone()))
                        .on_change(fed(draft_key.clone(), Event::Draft))
                        .build(k)
                        .key("steer-text"),
                )
                .children(view.steer_why.clone().map(|why| {
                    text(why)
                        .font(k.ty.small)
                        .color(k.c.text_faint)
                        .wrap()
                        .w_full()
                }))
                .child(
                    row().w_full().justify_end().child(
                        Button::new(view.steer_label.clone())
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Small)
                            .disabled(!view.steer_send)
                            .on_press(step(Event::Steer(super::new_request())))
                            .build(k)
                            .key("steer-send"),
                    ),
                ),
        )
}

fn edit_at(which: String) -> impl for<'a> Fn(&'a mut App) -> &'a mut TextEdit {
    move |app| {
        app.board
            .edits
            .entry(which.clone())
            .or_insert_with(|| TextEdit::new(""))
    }
}
