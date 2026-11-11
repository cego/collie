//! Helping write the Standing direction: Desktop's offer, the consent dialog that says where
//! the human's sessions are, and the choice the Flock chat takes, through the fake core.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::standing::{self, store_said};
use collie_desktop_protocol::generated::{Choice, Store};
use rune::{Cx, El, Env, Runtime, col};
use serde_json::json;
use support::{said, tap};

/// The dialog over an empty window, as `shell::view` draws it over every page.
fn dialog_only(app: &App, cx: &mut Cx<App>) -> El {
    let k = collie_desktop_theme::kit(cx.system_dark());
    let mut layer = Vec::new();
    standing::view(app, k, &mut layer);
    rune_kit::root(col().key("window").w_full().h_full(), layer)
}

fn dialog(harness: &Harness<App>) -> Runtime<App> {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    let mut runtime = Runtime::new(
        app,
        dialog_only,
        (1280.0, 860.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn store(value: serde_json::Value) -> Store {
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_store_says_how_many_sessions_it_holds_and_where_or_why_it_was_not_read() {
    let read =
        store(json!({ "source": "codex", "where": "~/.codex", "found": "read", "sessions": 12 }));
    assert_eq!(store_said(&read), "Codex: 12 sessions in ~/.codex");
    let records = store(
        json!({ "source": "collie", "where": "~/.local/state", "found": "read", "sessions": 3 }),
    );
    assert_eq!(
        store_said(&records),
        "Collie's records: 3 entries in ~/.local/state"
    );
    let missing =
        store(json!({ "source": "pi", "where": "~/.pi", "found": "missing", "sessions": 0 }));
    assert_eq!(store_said(&missing), "Pi: missing");
    let unreadable = store(
        json!({ "source": "claude-code", "where": "~/.claude", "found": "unreadable",
        "sessions": 0, "why": "permission denied" }),
    );
    assert_eq!(
        store_said(&unreadable),
        "Claude Code: unreadable: permission denied"
    );
}

#[test]
fn desktop_hears_its_offer_and_takes_a_waiting_choice_for_its_flock_chat() {
    let harness = Harness::<App>::new();
    let mut runtime = dialog(&harness);
    runtime.state.listen_setup();
    runtime.state.listen_setup();
    assert_eq!(
        harness.fake.asked_of("setupOffer").len(),
        1,
        "it listens once"
    );
    harness.fake.push("setupOffer", Ok(json!(true)));
    harness.fake.push("setupChosen", Ok(json!(null)));
    support::settle(&harness, &mut runtime);
    assert!(runtime.state.standing.offered);
    assert!(
        harness.fake.asked_of("takeSetup").is_empty(),
        "nothing waits"
    );
    harness.fake.push("setupChosen", Ok(json!("read")));
    support::settle(&harness, &mut runtime);
    assert_eq!(harness.fake.asked_of("takeSetup").len(), 1);
    harness.fake.answer("takeSetup", Ok(json!("read")));
    support::settle(&harness, &mut runtime);
    assert_eq!(runtime.state.standing.taken, Some(Choice::Read));
}

#[test]
fn another_windows_chat_taking_the_choice_leaves_this_one_with_none() {
    let harness = Harness::<App>::new();
    let mut runtime = dialog(&harness);
    runtime.state.listen_setup();
    harness.fake.push("setupChosen", Ok(json!("ask")));
    support::settle(&harness, &mut runtime);
    harness.fake.answer("takeSetup", Ok(json!(null)));
    support::settle(&harness, &mut runtime);
    assert_eq!(runtime.state.standing.taken, None);
}

#[test]
fn the_dialog_says_where_each_computer_keeps_sessions_and_read_my_messages_holds_that_choice() {
    let harness = Harness::<App>::new();
    let mut runtime = dialog(&harness);
    runtime.state.open_standing_setup();
    let mut at = 100.0;
    runtime.invalidate();
    runtime.frame(at);
    assert!(said(&runtime, "Looking for your sessions…"));
    assert_eq!(harness.fake.asked_of("setupInventory").len(), 1);
    harness.fake.answer(
        "setupInventory",
        Ok(json!([
            { "computer": "mk-pc", "stores": [
                { "source": "claude-code", "where": "~/.claude/projects", "found": "read", "sessions": 41 },
                { "source": "codex", "where": "~/.codex", "found": "missing", "sessions": 0 },
            ] },
            { "computer": "vm-mk", "stores": [], "problem": "its host did not answer" },
        ])),
    );
    support::settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(
        &runtime,
        "Claude Code: 41 sessions in ~/.claude/projects"
    ));
    assert!(said(&runtime, "Codex: missing"));
    assert!(said(&runtime, "its host did not answer"));
    tap(&mut runtime, "standing-setup-read", &mut at);
    assert_eq!(
        harness.fake.asked_of("chooseSetup"),
        [json!({ "choice": "read" })]
    );
    assert!(!runtime.state.standing.open);
    assert!(harness.fake.asked_of("declineSetup").is_empty());
}

#[test]
fn ask_me_five_questions_holds_that_choice_and_not_now_or_never_declines_saying_any_refusal() {
    let harness = Harness::<App>::new();
    let mut runtime = dialog(&harness);
    let mut at = 100.0;
    runtime.state.open_standing_setup();
    tap(&mut runtime, "standing-setup-ask", &mut at);
    assert_eq!(
        harness.fake.asked_of("chooseSetup"),
        [json!({ "choice": "ask" })]
    );
    runtime.state.open_standing_setup();
    tap(&mut runtime, "standing-setup-not-now", &mut at);
    runtime.state.open_standing_setup();
    tap(&mut runtime, "standing-setup-never", &mut at);
    assert_eq!(
        harness.fake.asked_of("declineSetup"),
        [json!({ "forGood": false }), json!({ "forGood": true })]
    );
    harness.fake.answer("declineSetup", Ok(json!(null)));
    harness.fake.answer(
        "declineSetup",
        Err(CallError("Settings could not be saved".into())),
    );
    support::settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(&runtime, "Settings could not be saved"));
}
