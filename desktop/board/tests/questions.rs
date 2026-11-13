//! A Step's questions answered in the record on a fake core. Where the board has the question,
//! the record's form is the board's questionnaire, as `FlowDecision.vue` substitutes it: Hold
//! the Run among the options, words for the agent instead, a status line, and the form moving
//! on once the host takes an answer and closing after the last.

use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, view};
use collie_desktop_terminal::view::Tab;
use rune::{Env, Key, KeyEvent, Mods, Runtime};
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

fn shown(runtime: &Runtime<App>, key: &str) -> bool {
    keys(runtime).iter().any(|k| k == key)
}

fn said(runtime: &Runtime<App>, key: &str) -> String {
    within(&runtime.accessibility_json())
        .into_iter()
        .find(|node| node["key"] == key)
        .and_then(|node| node["name"].as_str().map(String::from))
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

fn key(runtime: &mut Runtime<App>, key: Key, at: f64) {
    runtime.key(KeyEvent {
        key,
        mods: Mods::default(),
    });
    runtime.frame(at);
}

fn settle(runtime: &mut Runtime<App>, harness: &Harness<App>, at: f64) {
    harness.settle(&mut runtime.state);
    runtime.update(|_, _| {});
    runtime.frame(at);
}

fn sent(harness: &Harness<App>) -> Vec<Value> {
    harness
        .fake
        .asked_of("act")
        .into_iter()
        .map(|a| a["action"].clone())
        .collect()
}

fn board_question(id: &str, text: &str, options: Value) -> Value {
    json!({"kind": "question", "run": "r1", "id": id, "step": "ask", "topic": "the way",
        "text": text, "options": options, "hold": {"offered": true, "why": null},
        "steer": {"agent": "build-1", "why": null}})
}

/// Build box's r1 open on Flow, its Ask Step's questions open on the board's b2 card, and the
/// Step's answer form open.
fn asking(harness: &Harness<App>, questions: &[(&str, &str, Value)]) -> Runtime<App> {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    let mut upsert: Value = FLOCK
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .rfind(|line| line["message"]["task"]["id"] == "b2")
        .unwrap();
    upsert["message"]["seq"] = json!(3);
    upsert["message"]["task"]["questions"] = questions
        .iter()
        .map(|(id, text, options)| board_question(id, text, options.clone()))
        .collect();
    app.apply(serde_json::from_value(upsert).unwrap());
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
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let node = json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
        "kind": "agent", "description": "", "declared": true, "offPath": false,
        "attempts": [], "runs": [],
        "questions": questions.iter().map(|(id, text, options)| json!({
            "id": id, "name": text, "open": true, "text": text, "options": options}))
            .collect::<Vec<_>>()});
    let flow = json!({"lanes": [{"run": "r1", "workflow": "implement", "title": "Build",
        "machine": "Build box", "execution": "running", "declared": true, "nodes": [node],
        "actions": []}], "current": {"run": "r1", "node": "ask"}});
    let detail = json!({
        "id": "r1", "dir": "/runs/r1", "title": "Build it", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": [],
        "flow": flow
    });
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail": detail, "asOf": null, "bytes": 100})),
    );
    settle(&mut runtime, harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert!(shown(&runtime, "flow-form"), "{:?}", keys(&runtime));
    runtime
}

fn way() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "q-1",
        "Which way?",
        json!([{"id": "left", "title": "Left"}, {"id": "right", "title": "Right"}]),
    )]
}

#[test]
fn hold_the_run_is_offered_and_holds_it_leaving_the_question_open() {
    let harness = Harness::<App>::new();
    let mut runtime = asking(&harness, &way());
    tap(&mut runtime, "option-hold", 300.0);
    tap(&mut runtime, "form-send", 400.0);
    assert_eq!(
        sent(&harness),
        [
            json!({"_tag": "Control", "runId": "r1", "control": "hold", "set": true,
            "reason": "held at question q-1"})
        ]
    );
    assert_eq!(said(&runtime, "form-status"), "Sending…");
    harness.fake.answer("act", Ok(json!("Held.")));
    settle(&mut runtime, &harness, 500.0);
    assert_eq!(
        said(&runtime, "form-status"),
        "Run held · question still open"
    );
    assert!(shown(&runtime, "option-left"), "the question stays open");
}

#[test]
fn words_for_the_agent_go_to_it_instead_of_an_answer_and_clear() {
    let harness = Harness::<App>::new();
    let mut runtime = asking(&harness, &way());
    tap(&mut runtime, "form-steer-text", 300.0);
    key(&mut runtime, Key::Text("Ask the team first".into()), 400.0);
    tap(&mut runtime, "form-steer-send", 500.0);
    assert_eq!(
        sent(&harness),
        [
            json!({"_tag": "Deliver", "runId": "r1", "agent": "build-1", "text": "Ask the team first"})
        ]
    );
    harness
        .fake
        .answer("act", Ok(json!("Delivered to build-1.")));
    settle(&mut runtime, &harness, 600.0);
    assert_eq!(
        said(&runtime, "form-status"),
        "Sent to build-1; the question is set aside"
    );
    let field = within(&runtime.accessibility_json())
        .into_iter()
        .find(|n| n["key"] == "form-steer-text")
        .and_then(|n| {
            within(n)
                .into_iter()
                .find(|c| c["role"] == "text-input")
                .cloned()
        })
        .expect("the steering field stays");
    assert_eq!(field["value"], "", "the words are cleared");
}

#[test]
fn an_answer_moves_on_once_the_host_takes_it_and_the_form_closes_after_the_last() {
    let harness = Harness::<App>::new();
    let mut runtime = asking(
        &harness,
        &[
            way()[0].clone(),
            (
                "q-2",
                "How fast?",
                json!([{"id": "slow", "title": "Slow"}, {"id": "quick", "title": "Quick"}]),
            ),
        ],
    );
    assert_eq!(said(&runtime, "question-count"), "Question 1 of 2");
    tap(&mut runtime, "option-right", 300.0);
    tap(&mut runtime, "form-send", 400.0);
    // Still on it while it is sending, so a refusal is said where it was asked.
    assert_eq!(said(&runtime, "question-count"), "Question 1 of 2");
    harness.fake.answer(
        "act",
        Err(CallError("The Run is not waiting for that.".into())),
    );
    settle(&mut runtime, &harness, 500.0);
    assert_eq!(
        said(&runtime, "form-status"),
        "The Run is not waiting for that."
    );
    tap(&mut runtime, "form-send", 600.0);
    harness.fake.answer("act", Ok(json!("Answered.")));
    settle(&mut runtime, &harness, 700.0);
    assert_eq!(said(&runtime, "question-count"), "Question 2 of 2");
    tap(&mut runtime, "option-quick", 800.0);
    tap(&mut runtime, "form-send", 900.0);
    harness.fake.answer("act", Ok(json!("Answered.")));
    settle(&mut runtime, &harness, 1000.0);
    assert!(
        !shown(&runtime, "flow-form"),
        "the form closes once every question is answered"
    );
    let answers: Vec<Value> = sent(&harness)
        .into_iter()
        .filter(|a| a["_tag"] == "Answer")
        .map(|a| a["value"].clone())
        .collect();
    assert_eq!(answers, ["right", "right", "quick"]);
}

#[test]
fn escape_closes_the_form_sending_nothing() {
    let harness = Harness::<App>::new();
    let mut runtime = asking(&harness, &way());
    tap(&mut runtime, "option-left", 300.0);
    key(&mut runtime, Key::Escape, 400.0);
    assert!(!shown(&runtime, "flow-form"), "{:?}", keys(&runtime));
    assert!(sent(&harness).is_empty());
}
