//! Go to pane as the human meets it in the record: which pane is asked for, what the Terminal
//! tab says while the pane connects, fails, ends or is not there, and how it looks on the app.
//! The pane's events are the ones Desktop's core sends (`openTerminal` in
//! `desktop/src/bun/terminal.ts`); nothing here reaches a real pane.

mod support;

use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::client::RpcError;
use collie_desktop_protocol::generated::{
    ActionFailed, ActionFailedTag, TerminalEvent, TerminalPayload,
};
use collie_desktop_terminal::view::Tab;
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use support::{said, settle, tap};

const RUN: &str = "run-1.implement";
/// The working agent's own Run, one under the card's.
const CHILD: &str = "run-1.implement.implement-.--front-door";

fn task(agents: Value) -> Value {
    json!({
        "id": "t1", "name": "Front door", "project": "content", "state": "active", "steps": [],
        "sentence": "Front door is under way.", "age": "5m", "drift": null, "held": null,
        "heldBy": null, "decision": null, "agents": agents, "children": [], "mr": null,
        "branch": null, "disposition": null, "landed": false, "ended": null, "mrState": null,
        "planReady": false, "offer": null, "run": RUN, "runs": [RUN, "run-1"], "at": 0.0,
    })
}

fn snapshot(agents: Value) -> Value {
    json!({"machine": {"installation": "i-vm", "profile": "p-vm", "name": "vm-mk"},
        "message": {"_tag": "Snapshot", "installation": "i-vm", "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "tasks": [task(agents)],
        "seq": 1}})
}

fn agents(builder: &str) -> Value {
    json!([
        {"name": "run-1-grill-r1", "role": "planner", "status": "done", "now": null, "run": "run-1"},
        {"name": "run-1-imp-build-r1", "role": "implementer", "status": builder, "now": null,
            "run": CHILD},
    ])
}

type Asked = Arc<Mutex<Vec<TerminalPayload>>>;

/// An app on the fake core whose card's builder is `builder`, recording each pane asked for.
fn app(harness: &Harness<App>, builder: &str) -> (App, Asked) {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.apply(serde_json::from_value(snapshot(agents(builder))).unwrap());
    let asked: Asked = Arc::default();
    let said = asked.clone();
    app.go_to = Some(Box::new(move |payload, machine, _| {
        said.lock().unwrap().push(payload);
        Tab::new(None, machine, 100, 30)
    }));
    (app, asked)
}

fn runtime(app: App, dark: bool) -> Runtime<App> {
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 860.0),
        Env {
            system_dark: dark,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn event(value: Value) -> TerminalEvent {
    serde_json::from_value(value).unwrap()
}

fn opened() -> TerminalEvent {
    event(
        json!({"_tag": "Opened", "at": {"session": null, "workspace": "Front door",
        "tab": "build", "pane": "wTJ:p1", "agent": "run-1-imp-build-r1"}}),
    )
}

/// A frame of the pane: a prompt, with the cursor after it.
fn frame(bytes: &[u8]) -> TerminalEvent {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.encode(bytes);
    event(json!({"_tag": "Frame", "bytes": bytes}))
}

/// What the core's stream says, applied to the open terminal and drawn.
fn hear(runtime: &mut Runtime<App>, shown: TerminalEvent, at: f64) {
    runtime.update(move |app, _| app.terminal.as_mut().unwrap().shown(shown));
    runtime.frame(at);
}

fn keys(runtime: &Runtime<App>) -> Vec<String> {
    runtime
        .elements()
        .into_iter()
        .filter(|e| !e.exiting)
        .filter_map(|e| e.key)
        .collect()
}

fn element(runtime: &Runtime<App>, key: &str) -> Option<rune::ElementInfo> {
    runtime
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(key))
}

fn go_to_pane(runtime: &mut Runtime<App>) {
    runtime.update(|app, _| app.go_to_pane("i-vm".into(), RUN.into(), "vm-mk".into()));
    runtime.frame(0.1);
}

#[test]
fn the_agent_at_work_is_asked_for_under_its_own_run_not_the_cards() {
    let harness = Harness::new();
    let (app, asked) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    let asked = asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1, "{asked:?}");
    assert_eq!(
        (asked[0].run_id.as_str(), asked[0].agent.as_deref()),
        (CHILD, Some("run-1-imp-build-r1"))
    );
}

#[test]
fn an_agent_starting_or_stopping_work_leaves_the_pane_shown_where_it_is() {
    let harness = Harness::new();
    let (app, asked) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    hear(&mut runtime, opened(), 0.2);
    for (at, status) in [(0.3, "idle"), (0.4, "working"), (0.5, "blocked")] {
        runtime.update(move |app, _| {
            app.apply(serde_json::from_value(snapshot(agents(status))).unwrap());
            // As each record the host sends does.
            app.show_tab("terminal");
        });
        runtime.frame(at);
    }
    assert_eq!(asked.lock().unwrap().len(), 1, "the pane was opened again");
}

#[test]
fn a_pane_still_connecting_says_so_and_draws_no_live_cursor() {
    let harness = Harness::new();
    let (app, _) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    runtime.frame(0.5);
    let shown = keys(&runtime);
    assert!(said(&runtime, "Connecting to the pane"), "{shown:?}");
    assert!(!shown.iter().any(|k| k == "terminal-cursor"), "{shown:?}");
}

#[test]
fn a_pane_that_cannot_connect_says_so_plainly_and_connects_again() {
    let harness = Harness::new();
    let (app, asked) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    runtime.update(|app, _| {
        app.terminal
            .as_mut()
            .unwrap()
            .failed(RpcError::Failed(ActionFailed {
                tag: ActionFailedTag::ActionFailed,
                reason: "that Machine is not connected".into(),
                request: None,
                step: None,
                refused: None,
            }))
    });
    runtime.frame(0.2);
    assert!(said(
        &runtime,
        "Couldn't connect to the pane: that Machine is not connected"
    ));
    assert!(said(&runtime, "Pane: Not connected"));
    assert!(!keys(&runtime).iter().any(|k| k == "terminal-cursor"));
    let mut at = 1.0;
    tap(&mut runtime, "terminal-reconnect", &mut at);
    assert_eq!(asked.lock().unwrap().len(), 2, "Reconnect opened no pane");
    assert!(said(&runtime, "Connecting to the pane"));
}

#[test]
fn a_pane_that_ended_says_it_disconnected_dims_what_it_drew_and_connects_again() {
    let harness = Harness::new();
    let (app, asked) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    hear(&mut runtime, opened(), 0.2);
    hear(&mut runtime, frame(b"$ "), 0.3);
    assert!(said(&runtime, "Pane: Connected"));
    hear(
        &mut runtime,
        event(json!({"_tag": "Ended", "reason": "the connection to vm-mk dropped"})),
        0.4,
    );
    runtime.frame(1.0);
    assert!(said(
        &runtime,
        "The pane disconnected: the connection to vm-mk dropped"
    ));
    assert!(said(&runtime, "Pane: Disconnected"));
    assert!(!keys(&runtime).iter().any(|k| k == "terminal-cursor"));
    let grid = element(&runtime, "terminal-grid").unwrap();
    assert!(grid.opacity < 0.6, "{}", grid.opacity);
    let mut at = 2.0;
    tap(&mut runtime, "terminal-reconnect", &mut at);
    assert_eq!(asked.lock().unwrap().len(), 2);
}

#[test]
fn a_run_with_no_pane_says_so_and_opens_herdr_on_its_workspace() {
    let harness = Harness::new();
    let (app, _) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    hear(
        &mut runtime,
        event(
            json!({"_tag": "NoPane", "at": {"session": null, "workspace": "Front door",
            "tab": null}}),
        ),
        0.2,
    );
    assert!(said(
        &runtime,
        "This Run has no live agent's pane to show here"
    ));
    assert!(!keys(&runtime).iter().any(|k| k == "terminal-cursor"));
    let mut at = 1.0;
    tap(&mut runtime, "open-in-herdr", &mut at);
    assert_eq!(
        harness.fake.asked_of("goToPane"),
        [json!({"installation": "i-vm", "runId": RUN})]
    );
    harness.fake.answer(
        "goToPane",
        Ok(
            json!({"at": {"session": null, "workspace": "Front door", "tab": null},
            "command": "herdr --remote mk@vm", "opened": false}),
        ),
    );
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(
        &runtime,
        "No terminal app found: run herdr --remote mk@vm"
    ));
    harness.fake.will_answer(
        "goToPane",
        Err(CallError("that Machine is not connected".into())),
    );
    tap(&mut runtime, "open-in-herdr", &mut at);
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(
        &runtime,
        "Could not open herdr: that Machine is not connected"
    ));
}

#[test]
fn leaving_the_terminal_tab_gives_the_pane_back_and_coming_back_opens_it_again() {
    let harness = Harness::new();
    let (app, asked) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    runtime.update(|app, _| app.show_tab("log"));
    runtime.frame(0.2);
    assert!(runtime.state.terminal.is_none(), "the pane is still held");
    runtime.update(|app, _| app.show_tab("terminal"));
    runtime.frame(0.3);
    assert!(runtime.state.terminal.is_some());
    assert_eq!(asked.lock().unwrap().len(), 2);
}

#[test]
fn the_pane_sits_on_the_records_own_surface_in_light_and_dark() {
    for dark in [false, true] {
        let harness = Harness::new();
        let (app, _) = app(&harness, "working");
        let mut runtime = runtime(app, dark);
        go_to_pane(&mut runtime);
        hear(&mut runtime, opened(), 0.2);
        hear(&mut runtime, frame(b"$ ls"), 0.3);
        let kit = rune_theme_opencode::kit(dark);
        let surface = kit.c.bg_base.hex()[..7].to_string();
        let ink = kit.c.text_base.hex()[..7].to_string();
        let drawn = runtime.state.terminal.as_ref().unwrap().frame();
        let hex = |rgb: collie_desktop_terminal::vt::Rgb| {
            format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2)
        };
        assert_eq!(
            (hex(drawn.bg), hex(drawn.fg)),
            (surface, ink),
            "dark {dark}"
        );
    }
}

#[test]
fn what_the_pane_draws_lands_at_once_with_no_motion() {
    let harness = Harness::new();
    let (app, _) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    hear(&mut runtime, opened(), 0.2);
    hear(&mut runtime, frame(b"$ "), 0.3);
    runtime.frame(1.0);
    // The cursor jumps ten rows down, as output does; the next frame draws it there.
    hear(&mut runtime, frame(b"\x1b[12;30H"), 1.016);
    let cursor = element(&runtime, "terminal-cursor").unwrap();
    assert_eq!(cursor.rect, cursor.target, "the cursor glides");
    let grid = element(&runtime, "terminal-grid").unwrap();
    assert_eq!((grid.rect, grid.opacity), (grid.target, 1.0));
}

#[test]
fn opening_a_pane_shows_its_terminal_at_once() {
    let harness = Harness::new();
    let (app, _) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    go_to_pane(&mut runtime);
    runtime.update(|app, _| {
        let tab = app.terminal.as_mut().unwrap();
        tab.shown(opened());
        tab.shown(frame(b"$ "));
    });
    // The first frame after the gesture.
    runtime.frame(0.116);
    let tab = element(&runtime, "terminal-tab").unwrap();
    let grid = element(&runtime, "terminal-grid").unwrap();
    assert_eq!((tab.opacity, grid.opacity), (1.0, 1.0));
}

#[test]
fn keys_typed_after_go_to_pane_reach_the_pane_without_a_click_but_tab_still_moves_focus() {
    let harness = Harness::new();
    let (app, _) = app(&harness, "working");
    let mut runtime = runtime(app, true);
    // As `main` gives the window its keys.
    runtime.on_key = Some(collie_desktop_board::shell::on_key);
    go_to_pane(&mut runtime);
    hear(&mut runtime, opened(), 0.2);
    let press = |runtime: &mut Runtime<App>, key: rune::Key| {
        runtime.key(rune::KeyEvent {
            key,
            mods: rune::Mods::default(),
        });
        runtime.frame(0.3);
    };
    press(&mut runtime, rune::Key::Text("y".into()));
    let keyed = runtime.state.terminal.as_ref().unwrap().keyed_at.get();
    assert!(
        keyed.is_some(),
        "a key typed on the shown pane went nowhere"
    );
    let before = runtime.accessibility_json().to_string();
    assert!(
        !before.contains("\"focused\""),
        "something had focus already"
    );
    press(&mut runtime, rune::Key::Tab);
    let focused = runtime.accessibility_json().to_string();
    assert!(focused.contains("\"focused\""), "Tab moved focus nowhere");
}
