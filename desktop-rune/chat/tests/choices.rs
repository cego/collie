//! `test/desktop-chat-choices.test.ts`: what the Flock chat's harness, model and effort run as,
//! and what its selects show.

use collie_desktop_chat::attachments::Attached;
use collie_desktop_chat::choices::{
    ChatStatus, ChoiceOption, ChoiceSelect, Draft, Notices, Queued, ReplyChoice, Waiting,
    chat_announcement, chat_selects, choice_notices, refusal_said, remember_choice, stay_on,
    stop_draft, typed_entry,
};
use collie_desktop_protocol::generated::{
    About, ChatChoicesSuccess, From as Resolved, Harnesse, Offered, SetSettingsPayload,
    SettingsSuccess,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn from<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn settings(value: Value) -> SettingsSuccess {
    from(value)
}

fn change(value: Value) -> SetSettingsPayload {
    from(value)
}

fn claude() -> Value {
    json!([
        {
            "id": "opus",
            "label": "Opus 5.5",
            "description": "For complex work and everyday tasks",
            "efforts": ["low", "medium", "high", "xhigh", "max"],
            "unsetEffort": "medium",
        },
        { "id": "sonnet", "label": "Sonnet 5.5", "efforts": ["low", "medium", "high"], "unsetEffort": "medium" },
        { "id": "claude-haiku-4-5", "label": "Haiku 4.5", "efforts": [], "unsetEffort": null },
    ])
}

fn account() -> ChatChoicesSuccess {
    from(json!({
        "heldOn": "claude",
        "runsOn": null,
        "turning": false,
        "harnesses": [
            {
                "harness": "claude",
                "label": "Claude Code",
                "installed": true,
                "offered": {
                    "from": "table",
                    "unset": { "harness": "claude", "model": "opus", "effort": "medium" },
                    "models": claude(),
                },
            },
            {
                "harness": "pi",
                "label": "Pi",
                "installed": false,
                "offered": {
                    "from": "table",
                    "unset": { "harness": "pi", "model": "openai-codex/gpt-6.1-sol", "effort": "low" },
                    "models": [
                        {
                            "id": "openai-codex/gpt-5.5",
                            "label": "openai-codex/gpt-5.5",
                            "efforts": ["low", "medium", "high", "xhigh"],
                            "unsetEffort": "xhigh",
                        },
                    ],
                },
            },
        ],
    }))
}

fn claude_offering(offered: Value) -> Harnesse {
    Harnesse {
        offered: from::<Offered>(offered),
        ..account().harnesses[0].clone()
    }
}

fn option(value: &str, label: &str) -> ChoiceOption {
    ChoiceOption::new(value, label)
}

fn described(value: &str, label: &str, description: &str) -> ChoiceOption {
    ChoiceOption {
        description: Some(description.into()),
        ..ChoiceOption::new(value, label)
    }
}

#[test]
fn a_waiting_harness_switch_offers_stay_with_this_windows_last_matching_choice_checked_like_any_choice()
 {
    let account = account();
    let set = settings(json!({ "proactive": true, "chatModel": "sonnet", "chatEffort": "high" }));
    let remembered = remember_choice(None, &set, Some(&account));
    let switched = settings(
        json!({ "proactive": true, "chatHarness": "pi", "chatModel": "openai-codex/gpt-5.5" }),
    );
    assert_eq!(
        choice_notices(&switched, Some(&account)).waiting,
        Some(Waiting {
            text: "Your next message starts a new conversation on Pi.".into(),
            stay_label: "Stay on Claude Code".into(),
        })
    );
    assert_eq!(
        remember_choice(remembered.clone(), &switched, Some(&account)),
        remembered
    );
    assert_eq!(
        stay_on(&account, remembered.as_ref()),
        change(json!({ "chatHarness": "claude", "chatModel": "sonnet", "chatEffort": "high" }))
    );
    assert_eq!(
        stay_on(
            &account,
            remember_choice(None, &switched, Some(&account)).as_ref()
        ),
        change(json!({ "chatHarness": "claude" }))
    );
    let unset = remember_choice(
        remembered.clone(),
        &settings(json!({ "proactive": true })),
        Some(&account),
    );
    assert_eq!(
        stay_on(&account, unset.as_ref()),
        change(json!({ "chatHarness": "claude", "chatModel": "", "chatEffort": "" }))
    );
    let on_pi = ChatChoicesSuccess {
        held_on: "pi".into(),
        ..account.clone()
    };
    assert_eq!(
        remember_choice(remembered.clone(), &set, Some(&on_pi)),
        None
    );
    assert_eq!(
        stay_on(&on_pi, remembered.as_ref()),
        change(json!({ "chatHarness": "pi" }))
    );
    assert_eq!(choice_notices(&set, Some(&account)).waiting, None);
}

#[test]
fn a_choice_during_a_reply_names_both_resolved_choices_with_offered_labels_and_suppresses_equivalent_defaults()
 {
    let running = ChatChoicesSuccess {
        turning: true,
        runs_on: Some(Resolved {
            harness: "claude".into(),
            model: "opus".into(),
            effort: Some("high".into()),
        }),
        ..account()
    };
    let notices =
        |set: Value, choices: &ChatChoicesSuccess| choice_notices(&settings(set), Some(choices));
    assert_eq!(
        notices(json!({ "proactive": true, "chatModel": "sonnet" }), &running).reply,
        Some(ReplyChoice {
            current: "Opus 5.5 · High".into(),
            next: "Sonnet 5.5 · Medium".into(),
            text: "This reply finishes on Opus 5.5 · High. Your next message runs on Sonnet 5.5 · Medium."
                .into(),
        })
    );
    assert_eq!(
        notices(json!({ "proactive": true, "chatEffort": "high" }), &running),
        Notices {
            waiting: None,
            reply: None
        }
    );
    assert_eq!(
        notices(
            json!({ "proactive": true, "chatModel": "default" }),
            &ChatChoicesSuccess {
                runs_on: Some(Resolved {
                    harness: "claude".into(),
                    model: "opus".into(),
                    effort: Some("medium".into()),
                }),
                ..running.clone()
            },
        )
        .reply,
        None
    );
    assert_eq!(
        notices(
            json!({ "proactive": true }),
            &ChatChoicesSuccess {
                turning: false,
                ..running.clone()
            }
        )
        .reply,
        None
    );
    assert_eq!(
        notices(
            json!({ "proactive": true }),
            &ChatChoicesSuccess {
                runs_on: None,
                ..running.clone()
            }
        )
        .reply,
        None
    );
    assert_eq!(
        choice_notices(&settings(json!({ "proactive": true })), None),
        Notices {
            waiting: None,
            reply: None
        }
    );
    assert_eq!(
        notices(
            json!({ "proactive": true, "chatModel": "claude-haiku-4-5" }),
            &running
        )
        .reply
        .map(|r| r.next),
        Some("Haiku 4.5".into())
    );
    let pi = ChatChoicesSuccess {
        harnesses: vec![
            account().harnesses[0].clone(),
            from(json!({
                "harness": "pi",
                "label": "Pi",
                "installed": true,
                "offered": {
                    "from": "harness",
                    "unset": { "harness": "pi", "model": "openai-codex/gpt-6.1-sol", "effort": "minimal" },
                    "models": [
                        {
                            "id": "openai-codex/gpt-6.1-sol",
                            "label": "GPT-6.1 Sol",
                            "efforts": ["minimal", "high"],
                            "unsetEffort": "minimal",
                        },
                    ],
                },
            })),
        ],
        ..running.clone()
    };
    assert_eq!(
        notices(json!({ "proactive": true, "chatHarness": "pi" }), &pi)
            .reply
            .map(|r| r.next),
        Some("GPT-6.1 Sol · Minimal".into())
    );
    // What `tableOffer("pi", { proactive: true }, NO_FLOCK_SETTINGS, {})` returns.
    let table = ChatChoicesSuccess {
        harnesses: vec![Harnesse {
            offered: from(json!({
                "from": "table",
                "unset": { "harness": "pi", "model": "default", "effort": "medium" },
                "models": [],
            })),
            ..account().harnesses[1].clone()
        }],
        ..running.clone()
    };
    assert_eq!(
        notices(json!({ "proactive": true, "chatHarness": "pi" }), &table)
            .reply
            .map(|r| r.next),
        Some("Pi's own · Medium".into())
    );
    let reading = ChatChoicesSuccess {
        harnesses: vec![claude_offering(json!({ "from": "reading" }))],
        ..running.clone()
    };
    assert_eq!(notices(json!({ "proactive": true }), &reading).reply, None);
}

#[test]
fn the_submit_state_and_one_polite_announcement_follow_the_humans_reply_stop_and_new_notices_without_announcing_completion()
 {
    let status = |replying: bool, notices: &[&str]| ChatStatus {
        replying,
        notices: notices.iter().map(|n| n.to_string()).collect(),
    };
    let ready = status(false, &[]);
    let replying = status(true, &[]);
    let waiting = "Your next message starts a new conversation on Pi.";
    let change =
        "This reply finishes on Opus 5.5 · High. Your next message runs on Sonnet 5.5 · Medium.";
    assert_eq!(chat_announcement(None, &ready, false), "");
    assert_eq!(
        chat_announcement(Some(&ready), &replying, false),
        "Replying…"
    );
    assert_eq!(chat_announcement(Some(&replying), &replying, false), "");
    assert_eq!(chat_announcement(Some(&replying), &ready, false), "");
    assert_eq!(
        chat_announcement(Some(&replying), &ready, true),
        "Reply stopped"
    );
    let switched = status(true, &[waiting, change]);
    assert_eq!(
        chat_announcement(Some(&replying), &switched, false),
        format!("{waiting} {change}")
    );
    assert_eq!(chat_announcement(Some(&switched), &switched, false), "");
    assert_eq!(
        chat_announcement(Some(&switched), &status(true, &[]), false),
        ""
    );
    assert_eq!(
        chat_announcement(None, &status(false, &[waiting]), false),
        waiting
    );
    assert_eq!(
        chat_announcement(Some(&ready), &switched, false),
        format!("Replying… {waiting} {change}")
    );
}

#[test]
fn stop_returns_queued_words_in_order_before_the_draft_all_files_once_and_the_earliest_card_only_when_the_chip_is_empty()
 {
    let file = |id: &str, name: &str, media_type: &str, size: f64| Attached {
        id: id.into(),
        name: name.into(),
        size,
        media_type: media_type.into(),
    };
    let first = file("a", "notes.txt", "text/plain", 10.0);
    let second = file("b", "screen.png", "image/png", 20.0);
    let held = file("c", "draft.txt", "text/plain", 5.0);
    let about = About {
        machine: "vm-mk".into(),
        task: "t-1".into(),
        run: "r-2".into(),
        name: "Fix board bugs".into(),
    };
    let later = About {
        task: "t-3".into(),
        name: "Later card".into(),
        ..about.clone()
    };
    let queue = vec![
        Queued {
            id: 1,
            text: "First question".into(),
            files: vec![],
            about: None,
        },
        Queued {
            id: 2,
            text: "Second\nquestion".into(),
            files: vec![first.clone()],
            about: Some(about.clone()),
        },
        Queued {
            id: 3,
            text: String::new(),
            files: vec![second.clone(), first.clone()],
            about: Some(later.clone()),
        },
    ];
    let draft = Draft {
        text: "Still typing…".into(),
        files: vec![first.clone(), held.clone()],
        about: None,
    };
    assert_eq!(
        stop_draft(&queue, draft.clone()),
        Draft {
            text: "First question\n\nSecond\nquestion\n\nStill typing…".into(),
            files: vec![first, second, held],
            about: Some(about),
        }
    );
    assert_eq!(
        stop_draft(
            &queue,
            Draft {
                about: Some(later.clone()),
                ..draft.clone()
            }
        )
        .about,
        Some(later)
    );
    assert_eq!(stop_draft(&[], draft.clone()), draft);
    // A queued message's `about` that is no card is carried as none.
    assert_eq!(
        stop_draft(
            &[Queued {
                id: 1,
                text: "Only question".into(),
                files: vec![],
                about: None,
            }],
            Draft::default()
        ),
        Draft {
            text: "Only question".into(),
            files: vec![],
            about: None,
        }
    );
}

#[test]
fn the_harness_select_names_each_harness_and_one_not_installed_is_disabled_saying_so() {
    let harness = chat_selects(&settings(json!({ "proactive": true })), Some(&account())).harness;
    assert_eq!(harness.value, "claude");
    assert_eq!(harness.label, "Claude Code");
    assert_eq!(
        harness.note.as_deref(),
        Some("Another harness starts a new conversation with your next message.")
    );
    assert!(!harness.disabled);
    assert_eq!(
        harness.options,
        vec![
            option("claude", "Claude Code"),
            ChoiceOption {
                disabled: true,
                ..described("pi", "Pi", "Not installed on this computer")
            },
        ]
    );
}

#[test]
fn the_model_select_starts_with_the_default_named_by_what_it_runs_as_then_the_offered_models_and_shows_a_set_model_nobody_offers()
 {
    let account = account();
    let model = chat_selects(&settings(json!({ "proactive": true })), Some(&account)).model;
    assert_eq!(
        model.options,
        vec![
            described(
                "",
                "Default · Opus 5.5",
                "What the chat runs with no model set"
            ),
            described("opus", "Opus 5.5", "For complex work and everyday tasks"),
            option("sonnet", "Sonnet 5.5"),
            option("claude-haiku-4-5", "Haiku 4.5"),
        ]
    );
    assert_eq!(
        (model.value.as_str(), model.label.as_str()),
        ("", "Default · Opus 5.5")
    );
    let typed = chat_selects(
        &settings(json!({ "proactive": true, "chatModel": "claude-opus-5" })),
        Some(&account),
    )
    .model;
    assert_eq!(
        (typed.value.as_str(), typed.label.as_str()),
        ("claude-opus-5", "claude-opus-5")
    );
    assert_eq!(
        typed.options.last(),
        Some(&option("claude-opus-5", "claude-opus-5"))
    );
    assert_eq!(
        chat_selects(
            &settings(json!({ "proactive": true, "chatHarness": "pi" })),
            Some(&account)
        )
        .model
        .options[0]
            .label,
        "Default · openai-codex/gpt-6.1-sol"
    );
}

#[test]
fn the_effort_select_starts_with_the_level_an_unset_effort_runs_at_then_follows_the_set_models_levels()
 {
    let account = account();
    let sonnet = chat_selects(
        &settings(json!({ "proactive": true, "chatModel": "sonnet", "chatEffort": "high" })),
        Some(&account),
    );
    assert_eq!(
        sonnet.effort.options,
        vec![
            described(
                "",
                "Default · Medium",
                "What the chat runs with no effort set"
            ),
            option("low", "Low"),
            option("medium", "Medium"),
            option("high", "High"),
        ]
    );
    assert_eq!(sonnet.effort.value, "high");
    assert_eq!(sonnet.effort.label, "High");
    assert_eq!(
        sonnet.effort.note.as_deref(),
        Some("The levels Sonnet 5.5 takes")
    );
    assert!(!sonnet.effort.disabled);
    assert_eq!(
        chat_selects(&settings(json!({ "proactive": true })), Some(&account))
            .effort
            .options
            .iter()
            .map(|o| o.label.as_str())
            .collect::<Vec<_>>(),
        [
            "Default · Medium",
            "Low",
            "Medium",
            "High",
            "Extra high",
            "Max"
        ]
    );
    let on_pi = |chat_model: Option<&str>| {
        let mut set = json!({ "proactive": true, "chatHarness": "pi" });
        if let Some(model) = chat_model {
            set["chatModel"] = model.into();
        }
        chat_selects(&settings(set), Some(&account)).effort.options[0]
            .label
            .clone()
    };
    assert_eq!(on_pi(Some("openai-codex/gpt-5.5")), "Default · Extra high");
    assert_eq!(on_pi(None), "Default · Low");
}

#[test]
fn a_model_that_lists_no_effort_disables_the_effort_select_which_reads_that_the_model_takes_none() {
    assert_eq!(
        chat_selects(
            &settings(json!({ "proactive": true, "chatModel": "claude-haiku-4-5" })),
            Some(&account())
        )
        .effort,
        ChoiceSelect {
            value: String::new(),
            label: "Haiku 4.5 takes no effort".into(),
            name: "Effort: none. Haiku 4.5 takes no effort".into(),
            options: vec![],
            note: None,
            reading: false,
            warning: None,
            disabled: true,
        }
    );
}

#[test]
fn the_accepted_default_model_id_uses_the_resolved_models_effort_choices() {
    let account = account();
    let selects = chat_selects(
        &settings(json!({ "proactive": true, "chatModel": "default" })),
        Some(&account),
    );
    assert_eq!(
        selects.effort.note.as_deref(),
        Some("The levels Opus 5.5 takes")
    );
    let pi = chat_selects(
        &settings(json!({ "proactive": true, "chatHarness": "pi", "chatModel": "default" })),
        Some(&account),
    );
    assert_eq!(
        pi.effort.note.as_deref(),
        Some("The levels openai-codex/gpt-6.1-sol takes")
    );
    assert_eq!(
        pi.effort.options.first().map(|o| o.label.as_str()),
        Some("Default · Low")
    );
}

#[test]
fn a_typed_model_keeps_the_tables_effort_choices_when_the_default_model_takes_none() {
    let choices = ChatChoicesSuccess {
        harnesses: vec![claude_offering(json!({
            "from": "table",
            "unset": { "harness": "claude", "model": "claude-haiku-4-5", "effort": null },
            "models": claude(),
        }))],
        ..account()
    };
    let effort = chat_selects(
        &settings(json!({ "proactive": true, "chatModel": "claude-opus-5" })),
        Some(&choices),
    )
    .effort;
    assert!(!effort.disabled);
    assert_eq!(
        effort
            .options
            .iter()
            .map(|o| o.value.as_str())
            .collect::<Vec<_>>(),
        ["", "low", "medium", "high", "xhigh", "max"]
    );
    assert_eq!(effort.label, "Default · Medium");
}

#[test]
fn each_selects_accessible_name_carries_its_value() {
    let selects = chat_selects(
        &settings(json!({ "proactive": true, "chatModel": "sonnet" })),
        Some(&account()),
    );
    assert_eq!(
        [
            selects.harness.name,
            selects.model.name,
            selects.effort.name
        ],
        [
            "Harness: Claude Code",
            "Model: Sonnet 5.5",
            "Effort: Default · Medium"
        ]
    );
}

#[test]
fn a_typed_id_that_is_no_option_is_offered_to_save_as_use_id() {
    let model = chat_selects(&settings(json!({ "proactive": true })), Some(&account())).model;
    assert_eq!(
        typed_entry("  claude-opus-5 ", &model),
        Some(option("claude-opus-5", "Use claude-opus-5"))
    );
    assert_eq!(typed_entry("sonnet", &model), None);
    assert_eq!(typed_entry(" ", &model), None);
}

#[test]
fn a_refused_choice_says_nothing_was_saved_after_its_reason() {
    assert_eq!(
        refusal_said(r#""gpt-6.1-sol" is not a model claude takes (default, opus)"#),
        r#""gpt-6.1-sol" is not a model claude takes (default, opus). Nothing was saved."#
    );
    assert_eq!(
        refusal_said("Write provider/model, for example openai-codex/gpt-6.1-sol."),
        "Write provider/model, for example openai-codex/gpt-6.1-sol. Nothing was saved."
    );
}

#[test]
fn before_the_account_arrives_each_select_shows_what_is_set() {
    let selects = chat_selects(
        &settings(json!({ "proactive": true, "chatHarness": "pi", "chatEffort": "high" })),
        None,
    );
    assert_eq!(
        [
            selects.harness.label,
            selects.model.label,
            selects.effort.label
        ],
        ["Pi", "Default", "High"]
    );
}

#[test]
fn a_reading_list_keeps_the_set_model_and_typed_ids_available_and_names_the_read_beside_a_spinner()
{
    let reading = ChatChoicesSuccess {
        harnesses: vec![claude_offering(json!({ "from": "reading" }))],
        ..account()
    };
    let model = chat_selects(
        &settings(json!({ "proactive": true, "chatModel": "sonnet" })),
        Some(&reading),
    )
    .model;
    assert_eq!(model.label, "sonnet");
    assert!(model.reading);
    assert_eq!(
        model.note.as_deref(),
        Some("Reading Claude Code's models… You can still type a model id.")
    );
    assert_eq!(
        model.options,
        vec![option("", "Default"), option("sonnet", "sonnet")]
    );
    assert_eq!(
        typed_entry("claude-opus-5", &model),
        Some(option("claude-opus-5", "Use claude-opus-5"))
    );
}

#[test]
fn a_failed_list_explains_the_table_fallback_while_a_harness_list_names_its_source() {
    let listed = |from: &str, why: Option<&str>| {
        let mut offered = json!({
            "from": from,
            "unset": { "harness": "claude", "model": "opus", "effort": "medium" },
            "models": claude(),
        });
        if let Some(why) = why {
            offered["why"] = why.into();
        }
        ChatChoicesSuccess {
            harnesses: vec![claude_offering(offered)],
            ..account()
        }
    };
    let unset = settings(json!({ "proactive": true }));
    assert_eq!(
        chat_selects(&unset, Some(&listed("table", Some("Login expired"))))
            .model
            .warning
            .as_deref(),
        Some(
            "Claude Code's list could not be read: Login expired. Showing Collie's table, so models are named by id."
        )
    );
    assert_eq!(
        chat_selects(&unset, Some(&listed("harness", None)))
            .model
            .note
            .as_deref(),
        Some("Listed by Claude Code on this computer")
    );
}
