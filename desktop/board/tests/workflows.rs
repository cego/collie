//! The Workflows page: what a host read, as a tree and in full, asked of the fake core.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::pages::workflows::{Offer, is_markdown, offers_of};
use collie_desktop_board::shell::Page;
use serde_json::{Value, json};
use support::{flock_app, runtime, said, settle, tap_label};

#[test]
fn a_modules_follow_ups_and_actions_are_its_offers_each_saying_what_it_starts() {
    let offers = offers_of(&json!({
        "hints": {},
        "followUps": [{ "id": "build", "title": "Build it", "workflow": "implement", "when": "succeeded" }],
        "actions": [{ "id": "retro", "title": "Look back", "workflow": "self-improve", "arguments": {}, "limits": [] }],
    }));
    let offer = |id: &str, title: &str, workflow: &str, when: &str| Offer {
        id: id.into(),
        title: title.into(),
        workflow: workflow.into(),
        when: when.into(),
    };
    assert_eq!(
        offers,
        [
            offer("build", "Build it", "implement", "after it succeeds"),
            offer("retro", "Look back", "self-improve", "on its card"),
        ]
    );
}

#[test]
fn metadata_without_offers_or_not_shaped_as_the_host_draws_it_offers_nothing() {
    for metadata in [
        json!({ "hints": {}, "followUps": [], "actions": [] }),
        json!({}),
        Value::Null,
        json!({ "followUps": "garbled" }),
    ] {
        assert_eq!(offers_of(&metadata), [], "{metadata}");
    }
}

#[test]
fn a_modules_markdown_is_rendered_and_its_code_is_highlighted() {
    assert!(is_markdown("/x/workflows/plan.md"));
    assert!(is_markdown("/x/workflows/renovate.github.md"));
    assert!(!is_markdown("/x/workflows/plan.workflow.ts"));
}

fn definitions() -> Value {
    let success = json!({ "schema": null, "limits": [] });
    json!({
        "workflows": [{
            "id": "plan", "title": "Plan", "description": "Plans a change before it is made.",
            "layer": "shipped", "path": "/x/workflows/plan.workflow.ts",
            "inputs": [{ "name": "goal", "required": true, "strategy": null, "schema": null, "limits": [] }],
            "options": [], "success": success, "error": success,
            "metadata": { "followUps": [{ "id": "build", "title": "Build it", "workflow": "implement", "when": "succeeded" }] },
            "broken": null,
            "files": [{ "path": "/x/workflows/plan.md", "text": "# Plan\n\nWrite the plan." }],
        }],
        "problems": [{ "id": "odd", "layer": "user", "path": "/home/mk/.config/collie/workflows/odd.workflow.ts",
            "message": "SyntaxError: Unexpected token" }],
        "personas": [{ "name": "reviewer", "description": "Reviews a change.", "body": "You review.",
            "layer": "baseline", "path": "/x/personas/reviewer.md", "extends": null }],
        "errors": [],
    })
}

#[test]
fn opening_the_page_reads_this_computers_definitions_and_shows_one_chosen_in_full() {
    let harness = Harness::<App>::new();
    let mut app = flock_app(&harness);
    app.open_page(Page::Workflows);
    assert_eq!(
        harness.fake.asked_of("definitions"),
        [json!({ "installation": "i-pc" })],
        "this computer's host is asked before another Machine's"
    );
    let mut runtime = runtime(app);
    assert!(said(&runtime, "Reading…"));
    harness.fake.answer("definitions", Ok(definitions()));
    settle(&harness, &mut runtime);
    runtime.frame(100.0);
    assert!(said(&runtime, "Read from mk-pc"));
    assert!(said(&runtime, "Workflows · 1"));
    assert!(said(&runtime, "Would not load"));
    assert!(said(&runtime, "Choose a Workflow or a Persona to read it"));
    let mut at = 200.0;
    tap_label(&mut runtime, "Plan", &mut at);
    assert!(said(&runtime, "Plans a change before it is made."));
    assert!(said(&runtime, "Build it"), "its offers are shown");
    let file = runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("file-/x/workflows/plan.md"));
    assert!(file.is_some(), "its files are shown");
    tap_label(
        &mut runtime,
        "/home/mk/.config/collie/workflows/odd.workflow.ts",
        &mut at,
    );
    assert!(said(&runtime, "SyntaxError: Unexpected token"));
    tap_label(&mut runtime, "reviewer", &mut at);
    assert!(said(&runtime, "You review."));
}

#[test]
fn a_read_that_fails_says_why_and_no_machine_says_none_is_connected() {
    let harness = Harness::<App>::new();
    let mut app = flock_app(&harness);
    app.open_page(Page::Workflows);
    let mut runtime = runtime(app);
    harness.fake.answer(
        "definitions",
        Err(CallError("mk-pc's host did not answer".into())),
    );
    settle(&harness, &mut runtime);
    runtime.frame(100.0);
    assert!(said(&runtime, "mk-pc's host did not answer"));
    let mut alone = App::default();
    alone.core = Some(harness.core.clone());
    alone.open_page(Page::Workflows);
    let alone = support::runtime(alone);
    assert!(said(&alone, "No Machine is connected"));
    assert_eq!(harness.fake.asked_of("definitions").len(), 1);
}

#[test]
fn a_workflows_metadata_is_folded_until_asked_for() {
    let harness = Harness::<App>::new();
    let mut app = flock_app(&harness);
    app.open_page(Page::Workflows);
    let mut runtime = runtime(app);
    harness.fake.answer("definitions", Ok(definitions()));
    settle(&harness, &mut runtime);
    let mut at = 200.0;
    tap_label(&mut runtime, "Plan", &mut at);
    assert!(said(&runtime, "Build it"), "its offers are said in words");
    assert!(
        !said(&runtime, "\"followUps\""),
        "the raw metadata waits to be asked for"
    );
    tap_label(&mut runtime, "Show metadata", &mut at);
    assert!(said(&runtime, "\"followUps\""), "and then shows");
}
