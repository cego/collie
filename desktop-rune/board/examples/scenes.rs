//! The board and an open record from the test Flock on a fake core, for headless snapshots that
//! change nothing live: `cargo run -p collie-desktop-board --example scenes -- --scene record
//! --snap record.png --theme light`.

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, view};
use rune::AppSpec;
use serde_json::{Value, json};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");
const FLOWS: &str = include_str!("../../fixtures/flows.json");

fn board(app: &mut App) {
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
}

fn detail(flow: &Value) -> Value {
    json!({"detail": {
        "id": "r1", "dir": "/runs/r1", "title": "Build the record", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [{"name": "goal", "value": "Ship the record", "source": "cli"}],
        "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 3, "fail": 1, "unstable": 0, "byCollie": 2},
            "slices": {"done": 1, "total": 2}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": [],
        "flow": flow,
    }, "asOf": null, "bytes": 100})
}

fn record_with(app: &mut App, flow: &str) {
    board(app);
    let harness = Harness::<App>::new();
    app.core = Some(harness.core.clone());
    app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None);
    let flows: Value = serde_json::from_str(FLOWS).unwrap();
    harness.fake.push("runDetail", Ok(detail(&flows[flow])));
    harness.settle(app);
}

fn record(app: &mut App) {
    record_with(app, "before");
}

fn asking(app: &mut App) {
    record_with(app, "asking");
}

fn step(app: &mut App) {
    use base64::Engine;
    use collie_desktop_terminal::view::Tab;
    for line in FLOCK.lines() {
        let mut item: Value = serde_json::from_str(line).unwrap();
        if let Some(tasks) = item["message"]["tasks"].as_array_mut() {
            for task in tasks.iter_mut().filter(|task| task["run"] == "r1") {
                task["name"] = json!("Use the available Step space");
                task["agents"] = json!([{"name": "builder", "role": "implementer", "status": "working", "now": null, "run": "r1"}]);
            }
        }
        app.apply(serde_json::from_value(item).unwrap());
    }
    let harness = Harness::<App>::new();
    app.core = Some(harness.core.clone());
    app.go_to = Some(Box::new(|_, machine, _| {
        let mut tab = Tab::new(None, machine, 100, 30);
        tab.shown(
            serde_json::from_value(json!({"_tag": "Opened", "at": {
            "session": null, "workspace": "Layout preview", "tab": null, "pane": "test"}}))
            .unwrap(),
        );
        let bytes = base64::engine::general_purpose::STANDARD.encode(
            "\x1b[?2004h$ bun run typecheck\r\nTypecheck passed.\r\n\r\n$ bun test test/desktop-terminal.test.ts\r\nAll checks passed.\r\n\r\n$ ");
        tab.shown(serde_json::from_value(json!({"_tag": "Frame", "bytes": bytes})).unwrap());
        tab
    }));
    let nodes: Vec<Value> = [("Build", "done"), ("Review", "done"), ("Checks", "running"), ("Merge request", "expected")]
        .into_iter().map(|(title, state)| json!({"id": title, "title": title, "state": state,
            "agent": "builder", "kind": "agent", "description": "Collie runs every check on the tree.",
            "declared": true, "offPath": false, "attempts": [], "questions": [], "runs": [], "log": 1})).collect();
    let flow = json!({"lanes": [{"run": "r1", "workflow": "implement", "title": "Implement",
        "machine": "Build box", "execution": "running", "declared": true, "actions": [], "nodes": nodes}],
        "current": {"run": "r1", "node": "Checks"}});
    app.open_record(
        "inst-build".into(),
        "r1".into(),
        "Build box".into(),
        Some("flow"),
    );
    harness.fake.push("runDetail", Ok(detail(&flow)));
    harness.settle(app);
    app.nav.chat.set_open(true);
}

type Scene = (&'static str, fn(&mut App));

const SCENES: &[Scene] = &[
    ("board", board),
    ("record", record),
    ("asking", asking),
    ("step", step),
];

fn main() {
    rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        scenes: SCENES,
        ..AppSpec::new("Collie", (1280.0, 860.0), App::default, view)
    })
    .run();
}
