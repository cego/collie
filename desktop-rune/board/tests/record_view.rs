//! An open Run's record drawn from the test Flock with a fake core: `runDetail` streamed in,
//! items read from `runFile` in parts, and every gesture sent on `act` exactly as the host
//! takes it. Ports the record's cases of `test/desktop-record-door.test.ts`,
//! `desktop-deliver.test.ts`, `desktop-retry.test.ts` and `desktop/test/diff-comments.test.ts`.

use base64::Engine;
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::record::review::compose;
use collie_desktop_board::{App, view};
use collie_desktop_terminal::view::Tab;
use rune::edit::TextEdit;
use rune::{Env, Runtime};
use rune_kit::diff::{LineRange, LineRef, Side};
use serde_json::{Value, json};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

fn keys(runtime: &Runtime<App>) -> Vec<String> {
    within(&runtime.accessibility_json())
        .iter()
        .filter_map(|node| node["key"].as_str().map(String::from))
        .collect()
}

fn named(runtime: &Runtime<App>, key: &str) -> Value {
    within(&runtime.accessibility_json())
        .into_iter()
        .find(|node| node["key"] == key)
        .cloned()
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)))
}

fn tap(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime
        .find(key)
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

fn opened(harness: &Harness<App>) -> Runtime<App> {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    app.core = Some(harness.core.clone());
    app.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    let mut runtime = Runtime::new(
        app,
        view,
        (1400.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn settle(runtime: &mut Runtime<App>, harness: &Harness<App>, at: f64) {
    harness.settle(&mut runtime.state);
    // Rune draws again only for a change it is told of.
    runtime.update(|_, _| {});
    runtime.frame(at);
}

fn detail(extra: Value) -> Value {
    let mut base = json!({
        "id": "r1", "dir": "/runs/r1", "title": "Build it", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": []
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    json!({"detail": base, "asOf": null, "bytes": 100})
}

const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n fn a() {}\n-old\n+new\n";

fn with_diff() -> Value {
    detail(json!({
        "diff": {"base": "abc", "live": true, "files": [{"path": "src/a.rs", "status": "modified", "added": 1, "removed": 1}]},
        "agents": [{"operation": "build", "agent": "build-1", "harness": "claude"}]
    }))
}

#[test]
fn facts_list_each_offer_with_its_owner_and_refusal_even_while_details_are_loading() {
    for run in ["r1", "r-app", "r-api"] {
        let harness = Harness::<App>::new();
        let mut runtime = opened(&harness);
        runtime.update(|app, _| {
            let task = app
                .machines
                .iter_mut()
                .filter(|machine| machine.machine.installation == "inst-build")
                .flat_map(|machine| &mut machine.cards)
                .find(|task| task.run == "r1")
                .unwrap();
            task.children = serde_json::from_value(json!([
                {"repo": "app", "run": "r-app", "state": "done", "mr": null},
                {"repo": "api", "run": "r-api", "state": "done", "mr": null}
            ]))
            .unwrap();
            task.offers = serde_json::from_value(json!([
                {"id": "release", "title": "Release app!12", "run": "r-app"},
                {"id": "stage", "title": "Stage api!7", "run": "r-api",
                    "unavailable": "a Stage is still going"}
            ]))
            .unwrap();
            app.open_record("inst-build".into(), run.into(), "Build box".into(), None);
        });
        runtime.frame(100.0);
        tap(&mut runtime, "tab-facts", 200.0);
        for reading in [true, false] {
            if !reading {
                harness
                    .fake
                    .push("runDetail", Ok(detail(json!({"id": run}))));
                settle(&mut runtime, &harness, 1000.0);
            }
            let offers = named(&runtime, "facts-offers");
            let names: Vec<&str> = within(&offers)
                .into_iter()
                .filter_map(|node| node["name"].as_str())
                .collect();
            for expected in [
                "Release app!12",
                "r-app",
                "Stage api!7",
                "r-api — a Stage is still going",
            ] {
                assert!(names.contains(&expected), "missing {expected} in {names:?}");
            }
        }
    }
}

#[test]
fn a_card_opens_its_runs_record_on_its_first_tab_never_its_terminal_streaming_until_back() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    // Build box's board is a saved one, so its card opens by name, not by a double press.
    runtime.update(|app, _| app.open_card("inst-build:b2"));
    runtime.frame(100.0);
    assert_eq!(
        harness.fake.asked_of("runDetail"),
        [json!({"installation": "inst-build", "runId": "r1"})]
    );
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");
    assert!(
        runtime.state.terminal.is_none(),
        "only Go to pane attaches to the agent"
    );
    assert!(
        shown.iter().any(|k| k == "record-standing"),
        "it says it is reading: {shown:?}"
    );
    let tabs: Vec<String> = shown
        .iter()
        .filter(|k| k.starts_with("tab-"))
        .cloned()
        .collect();
    assert_eq!(tabs, ["tab-log", "tab-terminal", "tab-facts"]);

    harness.fake.push("runDetail", Ok(with_diff()));
    settle(&mut runtime, &harness, 1000.0);
    let tabs: Vec<String> = keys(&runtime)
        .into_iter()
        .filter(|k| k.starts_with("tab-"))
        .collect();
    assert_eq!(
        tabs,
        [
            "tab-summary",
            "tab-diff",
            "tab-evidence",
            "tab-log",
            "tab-terminal",
            "tab-facts"
        ]
    );
    let states = named(&runtime, "tab-summary")["states"].clone();
    assert!(
        states
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "selected" || s == "checked"),
        "{states}"
    );

    tap(&mut runtime, "back", 2000.0);
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"title": "Since left"}))));
    settle(&mut runtime, &harness, 3000.0);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "card-b2"), "{shown:?}");
    assert!(runtime.state.record.open.is_none());
}

#[test]
fn a_record_shows_flow_first_and_the_summary_of_what_it_says() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flows: Value = serde_json::from_str(include_str!("../../fixtures/flows.json")).unwrap();
    harness.fake.push(
        "runDetail",
        Ok(detail(json!({
            "flow": flows["before"],
            "inputs": [{"name": "goal", "value": "Ship the record", "source": "cli"}],
        }))),
    );
    settle(&mut runtime, &harness, 100.0);
    let shown = keys(&runtime);
    assert!(
        shown.iter().any(|k| k == "flow-build-run-build"),
        "{shown:?}"
    );
    assert!(
        shown.iter().any(|k| k == "inspector"),
        "the current Step is inspected: {shown:?}"
    );
    assert!(
        !shown.iter().any(|k| k == "terminal-grid"),
        "no terminal is opened unasked"
    );
    tap(&mut runtime, "tab-summary", 200.0);
    let inputs = named(&runtime, "summary-inputs");
    assert_eq!(inputs["name"], "Inputs");
    tap(&mut runtime, "tab-flow", 300.0);
    assert!(keys(&runtime).iter().any(|k| k == "flow"));
}

fn diff_open(harness: &Harness<App>) -> Runtime<App> {
    let mut runtime = opened(harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    harness.fake.push("runDetail", Ok(with_diff()));
    settle(&mut runtime, harness, 100.0);
    assert_eq!(
        harness.fake.asked_of("runFile"),
        [json!({"installation": "inst-build", "runId": "r1", "ref": "diff:src/a.rs", "offset": 0})]
    );
    assert!(keys(&runtime).iter().any(|k| k == "diff-reading"));
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": "diff:src/a.rs", "encoding": "utf8", "content": PATCH, "size": PATCH.len()})),
    );
    settle(&mut runtime, harness, 200.0);
    runtime
}

#[test]
fn the_diff_is_read_file_by_file_and_a_file_ticked_viewed_is_counted() {
    let harness = Harness::<App>::new();
    let mut runtime = diff_open(&harness);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "diff"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "tree-file-src/a.rs"), "{shown:?}");
    assert_eq!(named(&runtime, "diff-viewed")["name"], "0 of 1 viewed");
    runtime.update(|app, _| app.toggle_viewed("src/a.rs"));
    runtime.frame(300.0);
    assert_eq!(named(&runtime, "diff-viewed")["name"], "1 of 1 viewed");
    let row = named(&runtime, "tree-file-src/a.rs");
    assert!(row["name"].as_str().unwrap().contains("viewed"), "{row}");
}

fn with_a_draft(runtime: &mut Runtime<App>, said: &str) {
    runtime.update(|app, _| {
        let at = LineRef::new(Side::New, 2);
        app.choose_diff_lines(Some(LineRange {
            file: 0,
            start: at,
            end: at,
        }));
    });
    runtime.frame(400.0);
    assert!(keys(runtime).iter().any(|k| k == "diff-composer"));
    let said = said.to_string();
    runtime.update(move |app, _| app.diff.as_mut().unwrap().comment = TextEdit::new(said.clone()));
    tap(runtime, "add-comment", 500.0);
}

#[test]
fn selected_lines_become_a_draft_sent_as_one_delivery_and_cleared_once_taken() {
    let harness = Harness::<App>::new();
    let mut runtime = diff_open(&harness);
    with_a_draft(&mut runtime, "Name this better");
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "draft-d1"), "{shown:?}");
    assert!(
        shown.iter().any(|k| k == "note-d1"),
        "drawn under its line: {shown:?}"
    );
    let drafts = runtime.state.record.drafts[&("inst-build".to_string(), "r1".to_string())].clone();

    tap(&mut runtime, "send-review", 700.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent.len(), 1);
    let action = &sent[0]["action"];
    assert_eq!(action["_tag"], "Deliver");
    assert_eq!(action["runId"], "r1");
    assert_eq!(action["text"], compose(&drafts));
    assert_eq!(action["shown"], json!({"epoch": "e1", "seq": 7.0}));
    assert!(sent[0]["request"].as_str().is_some_and(|r| r.len() == 36));
    assert!(
        keys(&runtime).iter().any(|k| k == "draft-d1"),
        "kept until the host takes it"
    );

    harness
        .fake
        .answer("act", Ok(json!("Delivered to build-1.")));
    settle(&mut runtime, &harness, 800.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "draft-d1"), "{shown:?}");
    assert_eq!(
        named(&runtime, "record-notice")["name"],
        "Delivered to build-1."
    );
}

#[test]
fn a_delivery_the_host_refused_says_why_and_try_again_sends_the_same_request() {
    let harness = Harness::<App>::new();
    let mut runtime = diff_open(&harness);
    with_a_draft(&mut runtime, "Again");
    tap(&mut runtime, "send-review", 700.0);
    harness
        .fake
        .answer("act", Err(CallError("No live agent took it.".into())));
    settle(&mut runtime, &harness, 800.0);
    assert_eq!(
        named(&runtime, "record-notice")["name"],
        "No live agent took it."
    );
    assert!(
        keys(&runtime).iter().any(|k| k == "draft-d1"),
        "the drafts stay"
    );
    tap(&mut runtime, "notice-again", 900.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["request"], sent[1]["request"]);
    assert_eq!(sent[0]["action"], sent[1]["action"]);
}

fn flow_with(node: Value, lane_actions: Value) -> Value {
    let mut node = node;
    for (key, value) in
        json!({"kind": "agent", "description": "", "declared": true, "offPath": false,
        "attempts": [], "questions": [], "runs": []})
        .as_object()
        .unwrap()
    {
        if node.get(key).is_none() {
            node[key] = value.clone();
        }
    }
    let id = node["id"].clone();
    json!({"lanes": [{"run": "r1", "workflow": "implement", "title": "Build", "machine": "Build box",
        "execution": "running", "declared": true, "nodes": [node], "actions": lane_actions}],
        "current": {"run": "r1", "node": id}})
}

#[test]
fn the_next_move_retries_a_failed_step_on_act_and_a_lane_action_holds_the_run() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "checks", "title": "Checks", "state": "failed", "primary": "retry", "why": "Tests failed"}),
        json!(["hold"]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    tap(&mut runtime, "lane-hold-run", 400.0);
    let sent: Vec<Value> = harness
        .fake
        .asked_of("act")
        .into_iter()
        .map(|a| a["action"].clone())
        .collect();
    assert_eq!(sent[0], json!({"_tag": "Resume", "runId": "r1"}));
    assert_eq!(
        sent[1],
        json!({"_tag": "Control", "runId": "r1", "control": "hold", "set": true, "shown": {"epoch": "e1", "seq": 7.0}})
    );
}

#[test]
fn a_note_for_a_step_names_its_step_and_retry_with_a_note_resumes_once_delivered() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "checks", "title": "Checks", "state": "failed", "primary": "retry-noted", "why": "Tests failed"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert!(keys(&runtime).iter().any(|k| k == "form-text"));
    runtime.update(|app, _| {
        if let Some(collie_desktop_board::record::Form::Text { edit, .. }) =
            app.record.open.as_mut().unwrap().form.as_mut()
        {
            *edit = TextEdit::new("Use the fixture");
        }
    });
    tap(&mut runtime, "form-send", 300.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent.len(), 1, "the retry waits for the note");
    assert_eq!(
        sent[0]["action"],
        json!({"_tag": "Deliver", "runId": "r1", "step": "checks", "text": "Use the fixture", "shown": {"epoch": "e1", "seq": 7.0}})
    );
    harness.fake.answer("act", Ok(json!("Noted.")));
    settle(&mut runtime, &harness, 400.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent[1]["action"], json!({"_tag": "Resume", "runId": "r1"}));
    assert_ne!(sent[0]["request"], sent[1]["request"]);
}

#[test]
fn an_open_question_is_answered_by_an_option() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
            "questions": [{"id": "q-1", "name": "Which way?", "open": true, "text": "Which way?",
                "options": [{"id": "left", "title": "Left"}, {"id": "right", "title": "Right", "recommended": true}]}]}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    tap(&mut runtime, "option-right", 300.0);
    tap(&mut runtime, "form-send", 400.0);
    assert_eq!(
        harness.fake.asked_of("act")[0]["action"],
        json!({"_tag": "Answer", "runId": "r1", "decision": "q-1", "value": "right"})
    );
}

#[test]
fn a_report_is_read_in_parts_confined_and_opened_in_the_browser_from_a_file() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("evidence"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(detail(
            json!({"evidence": [{"name": "report.html", "bytes": 40}]}),
        )),
    );
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "open-evidence-report-html", 200.0);
    let html = "<html><head></head><body>ok</body></html>";
    let b64 = base64::engine::general_purpose::STANDARD;
    let (first, rest) = html.split_at(20);
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": "evidence:report.html", "encoding": "base64", "content": b64.encode(first), "size": html.len()})),
    );
    settle(&mut runtime, &harness, 300.0);
    let asked = harness.fake.asked_of("runFile");
    assert_eq!(asked[1]["offset"], 20, "{asked:?}");
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": "evidence:report.html", "encoding": "base64", "content": b64.encode(rest), "size": html.len()})),
    );
    settle(&mut runtime, &harness, 400.0);
    let opened = harness.fake.asked_of("openLink");
    let url = opened[0]["url"].as_str().unwrap();
    let path = url.strip_prefix("file://").unwrap();
    let written = std::fs::read_to_string(path).unwrap();
    assert!(written.contains("Content-Security-Policy"), "{written}");
    assert!(written.contains("<body>ok</body>"));
}

#[test]
fn a_gesture_on_a_machine_out_of_reach_says_so_to_the_host() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.machines.iter_mut().for_each(|m| m.as_of = Some(1.0));
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "checks", "title": "Checks", "state": "failed", "primary": "retry"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    assert!(
        !keys(&runtime).iter().any(|k| k == "next-action"),
        "no action is offered while away"
    );
    assert!(
        named(&runtime, "record-standing")["name"]
            .as_str()
            .unwrap()
            .starts_with("Not current")
    );
    runtime.update(|app, _| {
        app.act_in_record(
            "inst-build".into(),
            collie_desktop_board::flow::actions::resume("r1"),
            Default::default(),
        )
    });
    assert_eq!(
        harness.fake.asked_of("act")[0]["unsent"],
        "its Machine is out of reach"
    );
}

#[test]
fn a_steps_questions_are_answered_one_after_another_each_on_its_own() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
            "questions": [
                {"id": "q-1", "name": "Which way?", "open": true, "text": "Which way?",
                    "options": [{"id": "left", "title": "Left"}, {"id": "right", "title": "Right"}]},
                {"id": "q-2", "name": "How fast?", "open": true, "text": "How fast?",
                    "options": [{"id": "slow", "title": "Slow"}, {"id": "quick", "title": "Quick"}]}]}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert_eq!(named(&runtime, "question-count")["name"], "Question 1 of 2");
    tap(&mut runtime, "option-right", 300.0);
    tap(&mut runtime, "form-send", 400.0);
    assert_eq!(named(&runtime, "question-count")["name"], "Question 2 of 2");
    tap(&mut runtime, "option-quick", 500.0);
    tap(&mut runtime, "form-send", 600.0);
    let sent: Vec<Value> = harness
        .fake
        .asked_of("act")
        .into_iter()
        .map(|a| a["action"].clone())
        .collect();
    assert_eq!(
        sent,
        [
            json!({"_tag": "Answer", "runId": "r1", "decision": "q-1", "value": "right"}),
            json!({"_tag": "Answer", "runId": "r1", "decision": "q-2", "value": "quick"}),
        ]
    );
    assert!(
        !keys(&runtime).iter().any(|k| k == "flow-form"),
        "the form closes once every question is answered"
    );
}

#[test]
fn a_steps_start_asks_the_run_what_it_offers_and_starts_it_with_what_was_typed() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "offer:build", "title": "Build it", "state": "expected", "primary": "start"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert_eq!(
        harness.fake.asked_of("offers"),
        [json!({"installation": "inst-build", "runId": "r1"})]
    );
    harness.fake.answer(
        "offers",
        Ok(json!([
            {"id": "other", "title": "Other", "workflow": "general", "arguments": null,
                "kind": "action", "primary": false, "unavailable": null},
            {"id": "build", "title": "Build it", "workflow": "implement", "kind": "follow-up",
                "primary": true, "unavailable": null,
                "arguments": {"type": "object", "required": ["goal"],
                    "properties": {"goal": {"type": "string"}, "tries": {"type": "number"}}}}
        ])),
    );
    settle(&mut runtime, &harness, 300.0);
    assert_eq!(named(&runtime, "offer-title")["name"], "Build it");
    assert!(
        harness.fake.asked_of("act").is_empty(),
        "an offer that takes inputs waits for them"
    );
    tap(&mut runtime, "offer-field-goal", 350.0);
    runtime.key(rune::KeyEvent {
        key: rune::Key::Text("Ship it".into()),
        mods: Default::default(),
    });
    runtime.frame(380.0);
    tap(&mut runtime, "offer-start", 400.0);
    assert_eq!(
        harness.fake.asked_of("act")[0]["action"],
        json!({"_tag": "Invoke", "runId": "r1", "offer": "build", "input": {"goal": "Ship it"}})
    );
}

fn several_files(files: Value) -> Value {
    detail(json!({"diff": {"base": "abc", "live": true, "files": files}}))
}

fn read_asked(harness: &Harness<App>) -> Vec<String> {
    harness
        .fake
        .asked_of("runFile")
        .iter()
        .map(|a| a["ref"].as_str().unwrap().to_string())
        .collect()
}

fn small(path: &str) -> Value {
    json!({"path": path, "status": "modified", "added": 1, "removed": 1})
}

fn patch_of(path: &str) -> Value {
    let patch = PATCH.replace("src/a.rs", path);
    json!({"ref": format!("diff:{path}"), "encoding": "utf8", "content": patch, "size": patch.len()})
}

#[test]
fn a_big_files_patch_is_read_only_once_it_is_opened_and_no_more_than_four_at_once() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    let mut files: Vec<Value> = (1..=5).map(|i| small(&format!("src/f{i}.rs"))).collect();
    files.push(json!({"path": "src/big.rs", "status": "modified", "added": 4000, "removed": 10}));
    harness
        .fake
        .push("runDetail", Ok(several_files(json!(files))));
    settle(&mut runtime, &harness, 100.0);
    assert_eq!(
        read_asked(&harness),
        [
            "diff:src/f1.rs",
            "diff:src/f2.rs",
            "diff:src/f3.rs",
            "diff:src/f4.rs"
        ],
        "four at once, the big file not at all"
    );
    harness.fake.answer("runFile", Ok(patch_of("src/f1.rs")));
    settle(&mut runtime, &harness, 200.0);
    assert_eq!(
        read_asked(&harness).len(),
        5,
        "the fifth goes once one is in"
    );
    assert!(
        keys(&runtime).iter().any(|k| k == "show-src/big.rs"),
        "the big file says it is not read yet: {:?}",
        keys(&runtime)
    );
    tap(&mut runtime, "tree-file-src/big.rs", 300.0);
    assert_eq!(read_asked(&harness).len(), 5, "opened, it waits its turn");
    harness.fake.answer("runFile", Ok(patch_of("src/f2.rs")));
    settle(&mut runtime, &harness, 400.0);
    assert_eq!(read_asked(&harness).last().unwrap(), "diff:src/big.rs");
}

#[test]
fn a_folder_of_the_diffs_tree_folds_its_files_away_until_a_filter_looks_inside() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(several_files(json!([
            small("src/a.rs"),
            small("docs/b.md")
        ]))),
    );
    settle(&mut runtime, &harness, 100.0);
    assert!(keys(&runtime).iter().any(|k| k == "tree-file-src/a.rs"));
    tap(&mut runtime, "tree-src/", 200.0);
    let shown = keys(&runtime);
    assert!(
        !shown.iter().any(|k| k == "tree-file-src/a.rs"),
        "{shown:?}"
    );
    assert!(
        shown.iter().any(|k| k == "tree-file-docs/b.md"),
        "{shown:?}"
    );
    let folder = named(&runtime, "tree-src/");
    assert!(
        folder["states"]
            .as_array()
            .unwrap()
            .contains(&json!("collapsed")),
        "{folder}"
    );
    runtime.update(|app, _| app.diff.as_mut().unwrap().filter = TextEdit::new("a.rs"));
    runtime.frame(300.0);
    assert!(keys(&runtime).iter().any(|k| k == "tree-file-src/a.rs"));
}

#[test]
fn a_file_the_run_has_not_changed_again_keeps_its_patch_when_the_diff_is_read_again() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(several_files(json!([small("src/a.rs"), small("src/b.rs")]))),
    );
    settle(&mut runtime, &harness, 100.0);
    harness.fake.answer("runFile", Ok(patch_of("src/a.rs")));
    harness.fake.answer("runFile", Ok(patch_of("src/b.rs")));
    settle(&mut runtime, &harness, 200.0);
    let changed = json!({"path": "src/b.rs", "status": "modified", "added": 3, "removed": 1});
    harness.fake.push(
        "runDetail",
        Ok(several_files(json!([small("src/a.rs"), changed]))),
    );
    settle(&mut runtime, &harness, 300.0);
    assert_eq!(
        read_asked(&harness),
        ["diff:src/a.rs", "diff:src/b.rs", "diff:src/b.rs"],
        "only the file changed again is read again"
    );
}

#[test]
fn a_cards_flow_strip_opens_its_record_on_flow_with_the_active_step_chosen_never_its_terminal() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    // Build box's b2, as its latest upsert has it, with a Flow strip on its card.
    let mut upsert: Value = FLOCK
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .rfind(|line| line["message"]["task"]["id"] == "b2")
        .unwrap();
    upsert["message"]["seq"] = json!(3);
    upsert["message"]["task"]["flow"] = json!({"release": 0, "current": null, "glyphs": [
        {"title": "Plan", "state": "done"}, {"title": "Ask", "state": "needs-you"},
        {"title": "Build", "state": "done"}, {"title": "Ship", "state": "expected"}]});
    runtime.update(|app, _| app.apply(serde_json::from_value(upsert).unwrap()));
    runtime.frame(50.0);
    let shown = keys(&runtime);
    let strip = shown
        .iter()
        .find(|k| k.ends_with("b2-flow"))
        .unwrap_or_else(|| panic!("no Flow strip for b2 in {shown:?}"))
        .clone();
    tap(&mut runtime, &strip, 100.0);
    assert_eq!(
        harness.fake.asked_of("runDetail"),
        [json!({"installation": "inst-build", "runId": "r1"})]
    );
    assert!(
        runtime.state.terminal.is_none(),
        "the strip opens no terminal"
    );
    // No Step is current; the one needing the human is the active one, over the latest done.
    let step = |id: &str, state: &str| {
        let lane = flow_with(json!({"id": id, "title": id, "state": state}), json!([]));
        lane["lanes"][0]["nodes"][0].clone()
    };
    let flow = json!({"lanes": [{"run": "r1", "workflow": "implement", "title": "Build", "machine": "Build box",
        "execution": "running", "declared": true, "actions": [], "nodes": [
            step("plan", "done"), step("ask", "needs-you"), step("build", "done"), step("ship", "expected")]}],
        "current": null});
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 400.0);
    settle(&mut runtime, &harness, 500.0);
    assert_eq!(runtime.state.record_tab(), "flow");
    assert!(runtime.state.terminal.is_none(), "still no terminal");
    let selected = runtime.state.flow.as_ref().and_then(|m| m.selected.clone());
    assert_eq!(
        selected.map(|s| (s.run, s.node)),
        Some(("r1".to_string(), "ask".to_string()))
    );
    assert!(
        runtime.state.flow.as_ref().unwrap().reveal.is_none(),
        "the Step was laid out and scrolled to"
    );
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "inspector"), "{shown:?}");
}

fn width_of(runtime: &Runtime<App>, key: &str) -> f32 {
    runtime
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)))
        .rect[2]
}

#[test]
fn the_forms_fields_span_their_form_not_a_fixed_280_points() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
            "questions": [{"id": "q-1", "name": "Which way?", "open": true, "text": "Which way?",
                "options": [{"id": "left", "title": "Left"}]}]}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    let form = width_of(&runtime, "flow-form");
    let field = width_of(&runtime, "form-answer-text");
    assert!(
        field > 300.0 && field > form - 80.0,
        "the answer field is {field} wide in a form {form} wide"
    );
}

#[test]
fn a_record_attaches_its_terminal_only_while_its_terminal_tab_is_shown() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("log"),
        )
    });
    harness.fake.push("runDetail", Ok(with_diff()));
    settle(&mut runtime, &harness, 100.0);
    assert!(runtime.state.terminal.is_none(), "not on Log");
    // Picking an agent elsewhere, as the inspector's Watch it does first, attaches nothing.
    runtime.update(|app, _| app.pick_agent("build-1".into()));
    assert!(
        runtime.state.terminal.is_none(),
        "not until Terminal is shown"
    );
    runtime.update(|app, _| app.show_tab("terminal"));
    assert!(runtime.state.terminal.is_some(), "on Terminal it attaches");
    runtime.update(|app, _| app.show_tab("log"));
    assert!(
        runtime.state.terminal.is_none(),
        "leaving Terminal leaves the pane"
    );
}

#[test]
fn a_record_whose_details_are_not_on_its_machine_says_so_rather_than_reading() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail": null, "asOf": null, "bytes": 0})),
    );
    settle(&mut runtime, &harness, 100.0);
    let tree = runtime.accessibility_json();
    let record = within(&tree)
        .into_iter()
        .find(|n| n["key"] == "record")
        .expect("the record");
    let said: Vec<String> = within(record)
        .iter()
        .filter_map(|n| n["name"].as_str().map(String::from))
        .collect();
    assert!(
        said.iter()
            .any(|s| s == "This Run's details are not on its Machine."),
        "{said:?}"
    );
    assert!(
        !said.iter().any(|s| s.starts_with("Reading")),
        "nothing is still reading: {said:?}"
    );
}

#[test]
fn a_parked_runs_record_names_its_park_and_keeps_its_recovery_after_it_clears() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| app.open_card("inst-build:b2"));
    runtime.frame(100.0);
    let recovery: Vec<String> = (1..=22).map(|n| format!("rechecked {n}")).collect();
    harness.fake.push(
        "runDetail",
        Ok(detail(json!({
            "park": {"cause": "login-missing", "kind": "needs-you"},
            "recovery": recovery,
        }))),
    );
    settle(&mut runtime, &harness, 200.0);
    assert_eq!(
        named(&runtime, "record-park")["name"],
        "Parked: login-missing · needs you"
    );
    let lines = |runtime: &Runtime<App>| -> Vec<String> {
        within(&named(runtime, "record-recovery"))
            .into_iter()
            .filter(|n| n["role"] == "list-item")
            .filter_map(|n| n["name"].as_str().map(String::from))
            .collect()
    };
    let kept = lines(&runtime);
    assert_eq!(kept.len(), 20);
    assert_eq!(kept[0], "rechecked 3");

    harness.fake.push(
        "runDetail",
        Ok(detail(
            json!({"park": null, "recovery": ["rechecked cleared", "resumed resumed"]}),
        )),
    );
    settle(&mut runtime, &harness, 300.0);
    assert!(!keys(&runtime).iter().any(|k| k == "record-park"));
    assert_eq!(lines(&runtime), ["rechecked cleared", "resumed resumed"]);
}
