//! The record's Evidence tab on a fake core: a check's output, a kept log or a handoff note
//! opens under its row on a press, Enter or Space, read from `runFile` on demand, as
//! `EvidenceText.vue` does.

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

fn named(runtime: &Runtime<App>, key: &str) -> Value {
    within(&runtime.accessibility_json())
        .into_iter()
        .find(|node| node["key"] == key)
        .cloned()
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)))
}

/// Whether the row says it is expanded or collapsed, as ARIA's `aria-expanded` does.
fn expanded(runtime: &Runtime<App>, key: &str) -> String {
    let states = named(runtime, key)["states"].clone();
    ["expanded", "collapsed"]
        .into_iter()
        .find(|state| {
            states
                .as_array()
                .is_some_and(|all| all.iter().any(|s| s == state))
        })
        .unwrap_or("neither")
        .to_string()
}

fn shown(runtime: &Runtime<App>, key: &str) -> bool {
    keys(runtime).iter().any(|k| k == key)
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

fn settle(runtime: &mut Runtime<App>, harness: &Harness<App>, at: f64) {
    harness.settle(&mut runtime.state);
    runtime.update(|_, _| {});
    runtime.frame(at);
}

/// Build box's r1 open on Evidence, with a check, a kept log and a handoff note.
fn evidence(harness: &Harness<App>) -> Runtime<App> {
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
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("evidence"),
        )
    });
    let detail = json!({
        "id": "r1", "dir": "/runs/r1", "title": "Build it", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "steering": [],
        "verifications": [{"id": "v1", "name": "bun test", "result": "fail", "expect": "pass",
            "exit": 1, "at": "2026-11-05T11:00:00Z", "by": "collie"}],
        "evidence": [{"name": "build.log", "bytes": 120}],
        "handoffFiles": [{"name": "notes.md", "bytes": 40}]
    });
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail": detail, "asOf": null, "bytes": 100})),
    );
    settle(&mut runtime, harness, 100.0);
    runtime
}

fn refs(harness: &Harness<App>) -> Vec<String> {
    harness
        .fake
        .asked_of("runFile")
        .iter()
        .map(|a| a["ref"].as_str().unwrap().to_string())
        .collect()
}

fn read(harness: &Harness<App>, item: &str, text: &str) {
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": item, "encoding": "utf8", "content": text, "size": text.len()})),
    );
}

#[test]
fn a_checks_row_opens_its_output_on_a_press_read_once_and_closes_on_another() {
    let harness = Harness::<App>::new();
    let mut runtime = evidence(&harness);
    assert_eq!(expanded(&runtime, "check-v1"), "collapsed");
    assert!(
        refs(&harness).is_empty(),
        "nothing is read before it is opened"
    );
    tap(&mut runtime, "check-v1", 200.0);
    assert_eq!(expanded(&runtime, "check-v1"), "expanded");
    assert_eq!(refs(&harness), ["verification:v1"]);
    assert!(shown(&runtime, "check-v1-reading"), "{:?}", keys(&runtime));
    read(
        &harness,
        "verification:v1",
        "\u{1b}[31m1 failed\u{1b}[0m\r\nexpected 2, got 3",
    );
    settle(&mut runtime, &harness, 400.0);
    let output = named(&runtime, "check-v1-text");
    assert!(
        output["name"]
            .as_str()
            .is_some_and(|said| said == "1 failed\nexpected 2, got 3"),
        "{output}"
    );
    tap(&mut runtime, "check-v1", 500.0);
    assert_eq!(expanded(&runtime, "check-v1"), "collapsed");
    assert!(!shown(&runtime, "check-v1-text"));
    tap(&mut runtime, "check-v1", 700.0);
    assert!(shown(&runtime, "check-v1-text"));
    assert_eq!(refs(&harness), ["verification:v1"], "read the once");
}

#[test]
fn enter_and_space_open_and_close_a_row() {
    let harness = Harness::<App>::new();
    let mut runtime = evidence(&harness);
    let rows = [
        "check-v1",
        "file-evidence-build-log",
        "file-handoff-notes-md",
    ];
    for row in rows {
        let actions = named(&runtime, row)["actions"].clone();
        assert!(
            actions.as_array().unwrap().iter().any(|a| a == "focus"),
            "{row} takes focus: {actions}"
        );
        assert_eq!(expanded(&runtime, row), "collapsed", "{row}");
    }
    let press = |runtime: &mut Runtime<App>, key: Key, at: f64| {
        runtime.key(KeyEvent {
            key,
            mods: Mods::default(),
        });
        runtime.frame(at);
    };
    // A press opens it and leaves it focused, for the keys to close and open again.
    tap(&mut runtime, "check-v1", 200.0);
    assert_eq!(expanded(&runtime, "check-v1"), "expanded");
    press(&mut runtime, Key::Enter, 400.0);
    assert_eq!(expanded(&runtime, "check-v1"), "collapsed");
    press(&mut runtime, Key::Text(" ".into()), 500.0);
    assert_eq!(expanded(&runtime, "check-v1"), "expanded");
    press(&mut runtime, Key::Text(" ".into()), 600.0);
    assert_eq!(expanded(&runtime, "check-v1"), "collapsed");
}

#[test]
fn a_kept_log_and_a_handoff_note_open_under_their_rows() {
    let harness = Harness::<App>::new();
    let mut runtime = evidence(&harness);
    tap(&mut runtime, "file-evidence-build-log", 200.0);
    tap(&mut runtime, "file-handoff-notes-md", 400.0);
    assert_eq!(refs(&harness), ["evidence:build.log", "handoff:notes.md"]);
    read(&harness, "evidence:build.log", "compiling\ndone");
    settle(&mut runtime, &harness, 500.0);
    read(&harness, "handoff:notes.md", "Left for review");
    settle(&mut runtime, &harness, 600.0);
    assert!(
        named(&runtime, "file-evidence-build-log-text")["name"]
            .as_str()
            .is_some_and(|s| s.contains("compiling"))
    );
    assert!(
        named(&runtime, "file-handoff-notes-md-text")["name"]
            .as_str()
            .is_some_and(|s| s.contains("Left for review"))
    );
    // The kept log still opens in the browser, beside its row.
    assert!(shown(&runtime, "open-evidence-build-log"));
}

#[test]
fn an_output_that_could_not_be_read_says_so() {
    let harness = Harness::<App>::new();
    let mut runtime = evidence(&harness);
    tap(&mut runtime, "check-v1", 200.0);
    harness
        .fake
        .answer("runFile", Err(CallError("no such file".into())));
    settle(&mut runtime, &harness, 300.0);
    let said = named(&runtime, "check-v1-failed");
    assert!(
        said["name"]
            .as_str()
            .is_some_and(|s| s.starts_with("Could not be read")),
        "{said}"
    );
}
