//! The board's dialogs: a Steer's or Follow-up's words, what a Run offers, a card's
//! questions, and a proposal to read before a yes.

use super::questionnaire::{Event, Where};
use super::{Dialog, Words, offer_form, offer_key};
use crate::App;
use collie_desktop_protocol::generated::Question;
use rune::{El, LiveRegion, TextEdit, col, el, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog as Modal, Kit, TextArea, TextInput};

fn close(app: &mut App) {
    app.board.dialog = None;
}

/// A dialog's body, which gives focus back to its card when it closes: whatever opened it,
/// a menu's item or the card's own button, may be gone by then.
fn returns_to(app: &App, card: &str, body: El) -> El {
    match super::view::card_id(app, card) {
        Some(id) => body.focus_return(id),
        None => body,
    }
}

fn offer_entries(app: &mut App) -> &mut Vec<offer_form::OfferEntry> {
    match &mut app.board.dialog {
        Some(Dialog::Offers { fields, .. }) => fields,
        _ => unreachable!("an offers dialog is open"),
    }
}

fn project_name_edit(app: &mut App) -> &mut TextEdit {
    match &mut app.board.dialog {
        Some(Dialog::NewProject { edit }) => edit,
        _ => unreachable!("a new project dialog is open"),
    }
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
        Dialog::NewProject { edit } => {
            let empty = edit.text.trim().is_empty();
            let body = col()
                .gap(12.0)
                .padding(16.0)
                .pt(0.0)
                .child(
                    TextInput::new(edit)
                        .label("Project name")
                        .placeholder("Payments")
                        .width(None)
                        .on_edit(project_name_edit)
                        .on_submit(|app: &mut App, _: &mut rune::Tx| app.create_project())
                        .build(k)
                        .key("project-name"),
                )
                .child(
                    row().w_full().justify_end().child(
                        Button::new("Create Project")
                            .variant(ButtonVariant::Contrast)
                            .disabled(empty)
                            .on_press(App::create_project)
                            .build(k)
                            .key("create-project"),
                    ),
                );
            Modal::new("new-project", "New Project".to_string())
                .open(true)
                .fit()
                .child(body)
                .on_close(close)
                .build(collie_desktop_theme::dialog(k.dark), layer);
        }
        Dialog::FileTasks => {
            let many = app.machines.len() > 1;
            let mut body = col()
                .gap(8.0)
                .padding(16.0)
                .pt(0.0)
                .child(
                    text("Every Task joins the Project you chose, whichever Machine owns it.")
                        .key("file-note")
                        .font(k.ty.small)
                        .color(k.c.text_muted)
                        .wrap()
                        .w_full(),
                )
                .child(
                    Button::new("No Project")
                        .variant(ButtonVariant::Ghost)
                        .expanded(true)
                        .help("Leave these Tasks outside every Project")
                        .on_press(|app: &mut App| app.file_into(None))
                        .build(k)
                        .key("file-none"),
                );
            for target in app.filing_targets() {
                let key = format!("file-into-{}-{}", target.installation, target.id);
                let name = if many {
                    format!("{} · {}", target.name, target.installation)
                } else {
                    target.name.clone()
                };
                body = body.child(
                    Button::new(name)
                        .variant(ButtonVariant::Ghost)
                        .expanded(true)
                        .on_press(move |app: &mut App| app.file_into(Some(target.clone())))
                        .build(k)
                        .key(key),
                );
            }
            Modal::new("file-tasks", "File into a Project".to_string())
                .open(true)
                .fit()
                .child(body)
                .on_close(close)
                .build(collie_desktop_theme::dialog(k.dark), layer);
        }
        Dialog::Queued {
            card,
            instruction,
            workflows,
            chosen,
            checkout,
            inputs,
            why,
            ..
        } => {
            let mut body = col()
                .gap(12.0)
                .padding(16.0)
                .pt(0.0)
                .child(
                    text(instruction.clone())
                        .key("queued-instruction")
                        .font(k.ty.body)
                        .color(k.c.text_base)
                        .wrap()
                        .w_full(),
                )
                .child(
                    text("Workflow")
                        .role("heading")
                        .key("queued-workflow-heading")
                        .font(k.ty.small_medium)
                        .color(k.c.text_muted),
                );
            match workflows {
                Some(startable) if startable.is_empty() => {
                    body = body.child(
                        text("This Machine has no Workflow to start.")
                            .key("queued-none")
                            .font(k.ty.small)
                            .color(k.c.text_muted),
                    );
                }
                Some(startable) => {
                    for one in startable {
                        let pick = one.id.clone();
                        body = body.child(
                            Button::new(one.title.clone())
                                .variant(if chosen.as_deref() == Some(one.id.as_str()) {
                                    ButtonVariant::Contrast
                                } else {
                                    ButtonVariant::Ghost
                                })
                                .expanded(true)
                                .on_press(move |app: &mut App| app.choose_workflow(&pick))
                                .build(k)
                                .key(format!("queued-workflow-{}", one.id)),
                        );
                    }
                }
                None => {
                    body = body.child(
                        text("Reading this Machine's Workflows…")
                            .key("queued-reading")
                            .role("status")
                            .font(k.ty.small)
                            .color(k.c.text_muted),
                    );
                }
            }
            for (name, edit) in inputs {
                let wanted = name.clone();
                body = body.child(
                    TextInput::new(edit)
                        .label(name.clone())
                        .width(None)
                        .on_edit(move |app: &mut App| match &mut app.board.dialog {
                            Some(Dialog::Queued { inputs, .. }) => inputs
                                .iter_mut()
                                .find(|(one, _)| *one == wanted)
                                .map(|(_, edit)| edit)
                                .unwrap_or_else(|| unreachable!("a field drawn from this dialog")),
                            _ => unreachable!("a queued Task's dialog is open"),
                        })
                        .build(k)
                        .key(format!("queued-input-{name}")),
                );
            }
            body = body
                .child(
                    TextInput::new(checkout)
                        .label("Checkout")
                        .placeholder(crate::board::PROJECTS_ROOT_OPTION)
                        .width(None)
                        .on_edit(|app: &mut App| match &mut app.board.dialog {
                            Some(Dialog::Queued { checkout, .. }) => checkout,
                            _ => unreachable!("a queued Task's dialog is open"),
                        })
                        .on_submit(|app: &mut App, _: &mut rune::Tx| app.start_queued())
                        .build(k)
                        .key("queued-checkout"),
                )
                .children(why.clone().map(|why| {
                    text(why)
                        .key("queued-why")
                        .role("alert")
                        .font(k.ty.small)
                        .color(k.c.danger.fg)
                        .wrap()
                        .w_full()
                }));
            let ready = chosen.is_some()
                && !checkout.text.trim().is_empty()
                && inputs.iter().all(|(_, edit)| !edit.text.trim().is_empty());
            body = body.child(
                row().w_full().justify_end().child(
                    Button::new("Start in Task")
                        .variant(ButtonVariant::Contrast)
                        .disabled(!ready)
                        .on_press(App::start_queued)
                        .build(k)
                        .key("queued-start"),
                ),
            );
            Modal::new("queued-task", "Queued Task".to_string())
                .open(true)
                .fit()
                .child(returns_to(app, card, body))
                .on_close(close)
                .build(collie_desktop_theme::dialog(k.dark), layer);
        }
        Dialog::Words {
            card,
            kind,
            title,
            edit,
            ..
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
                .child(returns_to(app, card, body))
                .on_close(close)
                .build(collie_desktop_theme::dialog(k.dark), layer);
        }
        Dialog::Offers {
            card,
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
                        body = body.children(offer.confirm.clone().map(|confirm| {
                            text(confirm)
                                .key("offer-confirm")
                                .font(k.ty.ui)
                                .color(k.c.text_base)
                                .wrap()
                                .w_full()
                        }));
                        body = body.children(offer_form::controls(
                            fields,
                            offer_entries,
                            App::make_offer,
                            "field-",
                            k,
                        ));
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
                .child(returns_to(app, card, body))
                .on_close(close)
                .build(collie_desktop_theme::dialog(k.dark), layer);
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
                .build(collie_desktop_theme::dialog(k.dark), layer);
        }
        Dialog::Check { card } => check_output(app, k, card, layer),
        Dialog::Proposal {
            card,
            proposal,
            seen,
            ..
        } => {
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
                .on_drawn_layout_tx(|app: &mut App, r: [f32; 4], tx: &mut rune::Tx| {
                    if !app.proposal_drawn(Some([r[1], r[3]]), None) {
                        tx.live_only();
                    }
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
                .child(el().key("proposal-end").h(1.0).w_full().on_drawn_layout_tx(
                    |app: &mut App, r: [f32; 4], tx: &mut rune::Tx| {
                        if !app.proposal_drawn(None, Some(r[1] + r[3])) {
                            tx.live_only();
                        }
                    },
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
                .child(returns_to(
                    app,
                    card,
                    col()
                        .gap(12.0)
                        .padding(16.0)
                        .pt(0.0)
                        .child(content)
                        .child(footer),
                ))
                .on_close(close)
                .build(collie_desktop_theme::dialog(k.dark), layer);
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
    let status = text(view.status.clone().unwrap_or_default())
        .key("answer-state")
        .font(k.ty.small)
        .color(k.c.text_muted)
        .role("status")
        .label(view.status.clone().unwrap_or_default())
        .live_region(LiveRegion::Polite)
        .wrap()
        .grow(1.0)
        .shrink();
    let footer = |button: El| {
        row()
            .w_full()
            .gap(12.0)
            .center_y()
            .child(status)
            .child(button)
    };
    if view.words {
        let edit = edit_or(&typed_key);
        form = form
            .child(
                TextInput::new(&edit)
                    .label("Your answer")
                    .placeholder("Your answer")
                    .width(None)
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
                    .key("answer"),
            )
            .child(footer(
                Button::new("Send answer")
                    .variant(ButtonVariant::Contrast)
                    .disabled(!view.submit)
                    .on_press(step(Event::Submit(super::new_request())))
                    .build(k)
                    .key("send-answer"),
            ));
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
                .fill(if *checked {
                    k.c.layer_02
                } else {
                    k.c.surface_raised
                })
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
        form = form.child(options).child(footer(
            Button::new("Submit answer")
                .variant(ButtonVariant::Contrast)
                .disabled(!view.submit)
                .on_press(step(Event::Submit(super::new_request())))
                .build(k)
                .key("submit-answer"),
        ));
    }
    let draft = edit_or(&draft_key);
    let explained = view
        .steer_why
        .clone()
        .unwrap_or_else(|| "The question is set aside: the agent re-thinks and asks again.".into());
    form.child(el().h(1.0).w_full().fill(k.c.border_weak).a11y_hidden())
        .child(
            col()
                .key("steering")
                .gap(8.0)
                .w_full()
                .child(
                    text("Or tell the agent something else instead")
                        .font(k.ty.small_medium)
                        .color(k.c.text_muted)
                        .a11y_hidden(),
                )
                .child(
                    TextArea::new(&draft)
                        .label("Or tell the agent something else instead")
                        .placeholder("What should it do instead?")
                        .width(None)
                        .auto_grow(2, 6)
                        .disabled(view.steer_disabled)
                        .on_edit(edit_at(draft_key.clone()))
                        .on_change(fed(draft_key.clone(), Event::Draft))
                        .on_submit({
                            let s = step(Event::Steer(super::new_request()));
                            move |app: &mut App, _: &mut rune::Tx| s(app)
                        })
                        .build(k)
                        .key("steer-text"),
                )
                .child(
                    row()
                        .w_full()
                        .gap(12.0)
                        .center_y()
                        .child(
                            text(explained)
                                .key("steer-why")
                                .font(k.ty.small)
                                .color(k.c.text_faint)
                                .wrap()
                                .grow(1.0)
                                .shrink(),
                        )
                        .child(
                            Button::new(view.steer_label.clone())
                                .variant(ButtonVariant::Outline)
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

/// A card's running check as the card says it now: its sentence and the last lines it wrote.
fn check_output(app: &App, k: &Kit, card: &str, layer: &mut Vec<El>) {
    let placed = app.placed_by(card);
    let check = placed.as_ref().and_then(|p| p.task.check.clone().flatten());
    let name = placed
        .as_ref()
        .map_or_else(String::new, |p| p.task.name.clone());
    let mut body = col().gap(10.0).padding(16.0).pt(0.0).w_full();
    match &check {
        Some(check) => {
            body = body.child(
                text(check.sentence.clone())
                    .key("check-sentence")
                    .font(k.ty.ui)
                    .color(k.c.text_base)
                    .role("status")
                    .live_region(LiveRegion::Polite)
                    .wrap()
                    .w_full(),
            );
            let lines = if check.last_lines.is_empty() {
                "It has written nothing yet.".to_string()
            } else {
                check.last_lines.join("\n")
            };
            body = body.child(
                col()
                    .key("check-lines")
                    .w_full()
                    .max_h(320.0)
                    .padding(10.0)
                    .radius(6.0)
                    .fill(k.c.layer_02)
                    .border(1.0, k.c.border_weak)
                    .scroll(rune::ScrollSpec { stick_bottom: true })
                    .label("Its last lines")
                    .child(
                        text(lines)
                            .font(k.ty.mono)
                            .color(k.c.text_muted)
                            .wrap()
                            .selectable(true)
                            .w_full(),
                    ),
            );
            if let Some(log) = &check.log {
                body = body.child(
                    text(format!("Written to {log} on its Machine"))
                        .key("check-log")
                        .font(k.ty.small)
                        .color(k.c.text_faint)
                        .selectable(true)
                        .wrap()
                        .w_full(),
                );
            }
        }
        None => {
            body = body.child(
                text("Its check has ended; the record has what came of it.")
                    .key("check-ended")
                    .font(k.ty.ui)
                    .color(k.c.text_muted)
                    .role("status")
                    .wrap()
                    .w_full(),
            );
        }
    }
    let live = placed.as_ref().is_some_and(|p| p.as_of.is_none());
    let opens = card.to_string();
    body = body.child(
        row().w_full().justify_end().child(
            Button::new("Open record")
                .variant(ButtonVariant::Outline)
                .disabled(!live)
                .on_press(move |app: &mut App| {
                    app.board.dialog = None;
                    app.open_card(&opens);
                })
                .build(k)
                .key("check-open-record"),
        ),
    );
    let title = match &check {
        Some(check) => format!("{} · {name}", check.name),
        None => name,
    };
    Modal::new("check-output", title)
        .open(true)
        .width(640.0)
        .fit()
        .child(returns_to(app, card, body))
        .on_close(close)
        .build(collie_desktop_theme::dialog(k.dark), layer);
}
