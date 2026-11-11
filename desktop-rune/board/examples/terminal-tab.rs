//! A record's Terminal tab drawn from a recorded `terminal` stream, for a headless look at
//! it in the app without a live pane: nothing is sent anywhere.
//!
//! `REPLAY=fixtures/terminal/herdr-ls.ndjson [STATE=connecting|ended|failed|nopane] cargo run -p collie-desktop-board --example terminal-tab -- --snap tab.png --at 0.6 --size 1280x860 --theme light`
//!
//! `TAB=flow` draws it inline instead, in the working Build Step's Terminal part on Flow, the
//! record read from a fake core.

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::view::Tab;
use rune::AppSpec;
use serde_json::json;

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");
const FLOWS: &str = include_str!("../../fixtures/flows.json");

fn init() -> App {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    app.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    if std::env::var("TAB").as_deref() == Ok("flow") {
        on_flow(&mut app);
    } else {
        app.go_to_pane("inst-build".into(), "r1".into(), "Build box".into());
    }
    app
}

/// Build box's b1 with a builder at work, its record open on Flow at the Build Step.
fn on_flow(app: &mut App) {
    let snapshot: serde_json::Value = FLOCK
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .find(|line| line["message"]["installation"] == "inst-build")
        .unwrap();
    let mut task = snapshot["message"]["tasks"][0].clone();
    task["agents"] = json!([{"name": "build-1", "role": "builder",
        "status": "working", "now": "Slice 4 of 6", "run": "r1"}]);
    let upsert = json!({"machine": snapshot["machine"], "message": {"_tag": "Upsert", "seq": 9,
        "task": task}});
    app.apply(serde_json::from_value(upsert).unwrap());
    let mut flow: serde_json::Value =
        serde_json::from_str::<serde_json::Value>(FLOWS).unwrap()["before"].clone();
    flow["lanes"][1]["nodes"][0]["agent"] = json!("build-1");
    let detail = json!({"detail": {
        "id": "r1", "dir": "/runs/r1", "title": "Nightly evidence sweep", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0}, "inputs": [], "steps": [], "handoffs": [],
        "outputs": [], "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 3, "total": 6}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": [],
        "flow": flow}, "asOf": null, "bytes": 100});
    let harness = Harness::<App>::new();
    app.core = Some(harness.core.clone());
    app.open_record(
        "inst-build".into(),
        "r1".into(),
        "Build box".into(),
        Some("flow"),
    );
    harness.fake.push("runDetail", Ok(detail));
    harness.settle(app);
}

fn event(value: serde_json::Value) -> TerminalEvent {
    serde_json::from_value(value).unwrap()
}

/// The recorded stream arrives once the tab is laid out, as a live one does.
fn poll(app: &mut App, t: f64, _: &mut rune::Tx) -> bool {
    let Some(tab) = app.terminal.as_mut().filter(|_| t > 0.2) else {
        return false;
    };
    if tab.at.is_some() || tab.ended.is_some() {
        return false;
    }
    let state = std::env::var("STATE").unwrap_or_default();
    if state == "connecting" {
        return false;
    }
    let replay = std::env::var("REPLAY").unwrap_or("fixtures/terminal/herdr-ls.ndjson".into());
    for line in std::fs::read_to_string(replay).unwrap().lines() {
        let shown = serde_json::from_str::<TerminalEvent>(line).unwrap();
        if state == "nopane" || state == "failed" {
            break;
        }
        tab.shown(shown);
    }
    match state.as_str() {
        "ended" => tab.shown(event(
            json!({"_tag": "Ended", "reason": "herdr's controller exited 1"}),
        )),
        "failed" => {
            tab.failed_with("Build box's core: SocketError: An error occurred during Read".into())
        }
        "nopane" => tab.shown(event(json!({"_tag": "NoPane",
            "at": {"session": null, "workspace": "Bump effect", "tab": null}}))),
        _ => {}
    }
    true
}

fn main() {
    rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        poll: Some(poll),
        ..AppSpec::new("Collie", (1280.0, 860.0), init, view)
    })
    .run();
}
