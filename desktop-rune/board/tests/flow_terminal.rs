//! A Flow Step's own terminal, drawn in its Terminal part instead of on the record's Terminal
//! tab: which pane is held and when it is given back, the keys and files it takes, and that it
//! keeps its size. The panes are the fake core's and a stream that speaks Desktop's own NDJSON
//! frames; nothing here reaches a real pane.

mod support;

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::calls::{CallError, Post};
use collie_desktop_board::shell::panes;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::TerminalPayload;
use collie_desktop_terminal::view::{Link, Tab};
use rune::{ClipboardContent, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use support::pane::{Queued, Typed, pane_core, typed_after, until};
use support::{path_of, said, tap};

const RUN: &str = "run-1.implement";
const BUILDER: &str = "run-1-imp-r1";
const PLANNER: &str = "run-1-plan-r1";

fn snapshot() -> Value {
    json!({"machine": {"installation": "i-vm", "profile": "p-vm", "name": "vm-mk"},
        "message": {"_tag": "Snapshot", "installation": "i-vm", "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "tasks": [{
            "id": "t1", "name": "Front door", "project": "content", "state": "active",
            "steps": [], "sentence": "Front door is under way.", "age": "5m", "drift": null,
            "held": null, "heldBy": null, "decision": null, "agents": [
                {"name": PLANNER, "role": "planner", "status": "idle", "now": null, "run": RUN},
                {"name": BUILDER, "role": "implementer", "status": "working", "now": null, "run": RUN}],
            "children": [], "mr": null, "branch": null, "disposition": null, "landed": false,
            "ended": null, "mrState": null, "planReady": false, "offer": null, "run": RUN,
            "runs": [RUN], "at": 0.0}],
        "seq": 1}})
}

fn node(id: &str, state: &str, agent: &str, log: i64) -> Value {
    json!({"id": id, "title": id, "state": state, "agent": agent, "log": log, "kind": "agent",
        "description": "", "declared": true, "offPath": false, "attempts": [], "questions": [],
        "runs": []})
}

/// The Run's record: Plan done by the planner, Build `build` by the builder and current.
fn detail(build: &str) -> Value {
    let flow = json!({"lanes": [{"run": RUN, "workflow": "implement", "title": "Front door",
        "machine": "vm-mk", "execution": "running", "declared": true, "actions": [],
        "nodes": [node("plan", "done", PLANNER, 1), node("build", build, BUILDER, 2)]}],
        "current": {"run": RUN, "node": "build"}});
    json!({"detail": {
        "id": RUN, "dir": "/runs/r1", "title": "Front door", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": [],
        "tail": {"_tag": "Text", "text": "planned\nbuilding\n", "truncated": false}, "logStart": 1,
        "flow": flow,
    }, "asOf": null, "bytes": 100})
}

fn runtime(app: App) -> Runtime<App> {
    let mut runtime = Runtime::new(
        app,
        view,
        (1600.0, 1400.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.on_key = Some(collie_desktop_board::shell::on_key);
    runtime.frame(0.0);
    runtime
}

fn settle(harness: &Harness<App>, runtime: &mut Runtime<App>) {
    for _ in 0..3 {
        harness.settle(&mut runtime.state);
        runtime.invalidate();
        runtime.frame(2.0);
    }
}

type Asked = Arc<Mutex<Vec<TerminalPayload>>>;

/// The record open on Flow with Build working, on the fake core; each pane asked for is kept.
fn on_flow(harness: &Harness<App>) -> (Runtime<App>, Asked) {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.apply(serde_json::from_value(snapshot()).unwrap());
    let asked: Asked = Arc::default();
    let said = asked.clone();
    app.go_to = Some(Box::new(move |payload, machine, _| {
        said.lock().unwrap().push(payload);
        Tab::new(None, machine, 100, 30)
    }));
    app.open_record("i-vm".into(), RUN.into(), "vm-mk".into(), Some("flow"));
    let mut runtime = runtime(app);
    harness.fake.push("runDetail", Ok(detail("running")));
    settle(harness, &mut runtime);
    (runtime, asked)
}

fn agents_asked(asked: &Asked) -> Vec<Option<String>> {
    asked
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.agent.clone())
        .collect()
}

fn rect(runtime: &Runtime<App>, key: &str) -> [f32; 4] {
    runtime
        .elements()
        .iter()
        .find(|e| e.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("no {key}"))
        .rect
}

#[test]
fn the_steps_pane_uses_the_remaining_height_and_refits_with_the_window_and_chat() {
    let harness = Harness::new();
    let (mut runtime, asked) = on_flow(&harness);
    let mut at = 1000.0;
    let mut layout = |runtime: &mut Runtime<App>, size, chat_width| {
        runtime.set_viewport(size, 1.0);
        runtime.state.nav.chat.set_open(true);
        runtime.state.nav.chat.set_width(chat_width);
        for _ in 0..4 {
            runtime.invalidate();
            runtime.frame(at);
            at += 1000.0;
        }
        let [_, top, _, height] = rect(runtime, "terminal-grid");
        let [work_x, _, work_width, _] = rect(runtime, "inspector-work");
        let [open_x, _, open_width, _] = rect(runtime, "inspector-terminal");
        assert!(
            open_x >= work_x && open_x + open_width <= work_x + work_width,
            "the terminal control must fit within its work pane"
        );
        let [_, panel_top, _, panel_height] = rect(runtime, "tabpanel-flow");
        assert!(height > 100.0, "pane must remain usable: {height}");
        assert!(
            (panel_top + panel_height - top - height).abs() < 40.0,
            "pane leaves unused space or extends below the record: grid {:?}, panel {:?}",
            rect(runtime, "terminal-grid"),
            rect(runtime, "tabpanel-flow")
        );
        runtime.state.terminal.as_ref().unwrap().size()
    };
    let tall = layout(&mut runtime, (1800.0, 1400.0), 400.0);
    let short = layout(&mut runtime, (1800.0, 850.0), 400.0);
    assert!(
        short.1 < tall.1,
        "rows must follow the available height: {short:?} {tall:?}"
    );
    let narrow = layout(&mut runtime, (1800.0, 850.0), 650.0);
    assert!(
        narrow.0 < short.0,
        "columns must follow the chat divider: {narrow:?} {short:?}"
    );
    layout(&mut runtime, (1000.0, 850.0), 400.0);
    assert_eq!(
        asked.lock().unwrap().len(),
        1,
        "resizing must keep the pane attached"
    );
}

#[test]
fn a_working_steps_terminal_part_draws_its_agents_pane_inside_the_flow_tab() {
    let harness = Harness::new();
    let (runtime, asked) = on_flow(&harness);
    assert_eq!(runtime.state.record_tab(), "flow");
    assert_eq!(agents_asked(&asked), [Some(BUILDER.to_string())]);
    assert_eq!(asked.lock().unwrap()[0].run_id, RUN);
    assert!(
        path_of(&runtime, "tabpanel-flow/inspector/terminal-grid").is_some(),
        "no pane drawn in the Step's Terminal part"
    );
    assert!(path_of(&runtime, "inspector/inspector-terminal").is_some());
}

#[test]
fn leaving_the_part_the_step_or_the_record_gives_the_pane_back() {
    let harness = Harness::new();
    let (mut runtime, asked) = on_flow(&harness);
    let mut at = 10.0;
    assert!(runtime.state.terminal.is_some(), "Build's pane is held");

    tap(&mut runtime, "part-log", &mut at);
    assert!(runtime.state.terminal.is_none(), "Log leaves the pane");
    tap(&mut runtime, "part-terminal", &mut at);
    assert!(runtime.state.terminal.is_some(), "Terminal takes it again");

    tap(&mut runtime, &format!("flow-{RUN}-plan"), &mut at);
    assert!(runtime.state.terminal.is_none(), "another Step leaves it");
    tap(&mut runtime, &format!("flow-{RUN}-build"), &mut at);
    assert!(
        runtime.state.terminal.is_some(),
        "Build's own takes it again"
    );

    tap(&mut runtime, "tab-summary", &mut at);
    assert!(runtime.state.terminal.is_none(), "another tab leaves it");
    tap(&mut runtime, "tab-flow", &mut at);
    assert!(runtime.state.terminal.is_some());

    runtime.update(|app, _| app.back());
    assert!(
        runtime.state.terminal.is_none(),
        "leaving the record leaves it"
    );
    assert_eq!(asked.lock().unwrap().len(), 4, "{:?}", agents_asked(&asked));
}

#[test]
fn a_step_that_finishes_gives_its_pane_back_and_says_so_calmly() {
    let harness = Harness::new();
    let (mut runtime, _) = on_flow(&harness);
    assert!(runtime.state.terminal.is_some());
    harness.fake.push("runDetail", Ok(detail("done")));
    settle(&harness, &mut runtime);
    assert!(
        runtime.state.terminal.is_none(),
        "a done Step holds no pane"
    );
    let mut at = 10.0;
    tap(&mut runtime, "part-terminal", &mut at);
    assert!(runtime.state.terminal.is_none(), "not even on Terminal");
    assert!(said(&runtime, "This Step is over"));
    assert!(path_of(&runtime, "inspector/terminal-grid").is_none());
}

#[test]
fn open_in_terminal_tab_keeps_the_same_pane() {
    let harness = Harness::new();
    let (mut runtime, asked) = on_flow(&harness);
    let mut at = 10.0;
    tap(&mut runtime, "inspector-terminal", &mut at);
    assert_eq!(runtime.state.record_tab(), "terminal");
    assert!(runtime.state.terminal.is_some());
    assert_eq!(agents_asked(&asked), [Some(BUILDER.to_string())]);
}

/// The record open on Flow, Build's pane live on a core that keeps what is typed.
fn live_on_flow(harness: &Harness<App>) -> (Runtime<App>, Queued, Typed) {
    let (client, typed) = pane_core();
    let queued: Queued = Arc::default();
    let into = queued.clone();
    let post: Post<App> = Arc::new(move |change| into.lock().unwrap().push(change));
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.apply(serde_json::from_value(snapshot()).unwrap());
    app.go_to = Some(panes::opener(client, post));
    app.open_record("i-vm".into(), RUN.into(), "vm-mk".into(), Some("flow"));
    let mut runtime = runtime(app);
    harness.fake.push("runDetail", Ok(detail("running")));
    settle(harness, &mut runtime);
    until(&mut runtime, &queued, |app| {
        app.terminal
            .as_ref()
            .is_some_and(|t| t.link() == Link::Live && t.frame().line(0).starts_with('$'))
    });
    (runtime, queued, typed)
}

fn typed_key(text: &str) -> KeyEvent {
    KeyEvent {
        key: Key::Text(text.into()),
        mods: Mods::default(),
    }
}

#[test]
fn keys_typed_with_the_steps_pane_focused_reach_it() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = live_on_flow(&harness);
    // Unfocused, Flow's keys stay Flow's.
    runtime.key(typed_key("y"));
    runtime.frame(3.0);
    assert!(
        typed_after(&typed, 0).is_empty(),
        "{:?}",
        typed_after(&typed, 0)
    );

    let grid = path_of(&runtime, "inspector/terminal-grid").expect("the Step's pane");
    let mut at = 10.0;
    tap(&mut runtime, &grid, &mut at);
    runtime.key(typed_key("x"));
    runtime.frame(at);
    assert_eq!(typed_after(&typed, 1), ["x"]);
}

const PLACED: &str = "\x1b[200~/srv/collie/uploads/aa/shot.png\x1b[201~";

#[test]
fn the_steps_pane_takes_files_and_keeps_its_size_while_it_says_what_became_of_them() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = live_on_flow(&harness);
    let size = runtime.state.terminal.as_ref().unwrap().size();
    assert_ne!(size, (100, 30), "the pane was laid out in its part");
    let staged = json!([{"id": "aa/shot.png", "name": "shot.png", "size": 4.0,
        "mediaType": "image/png", "path": "/home/mk/.local/state/collie-desktop/attachments/aa/shot.png"}]);
    let shot = vec![PathBuf::from("/home/mk/Pictures/shot.png")];

    harness.fake.will_answer("stagePaths", Ok(staged.clone()));
    harness
        .fake
        .will_answer("placeFiles", Ok(json!(["/srv/collie/uploads/aa/shot.png"])));
    runtime.paste_content(ClipboardContent::new("shot.png").with_files(shot.clone()));
    runtime.frame(3.0);
    assert!(said(&runtime, "Placing files"));
    assert_eq!(runtime.state.terminal.as_ref().unwrap().size(), size);
    settle(&harness, &mut runtime);
    assert_eq!(typed_after(&typed, 1), [PLACED]);

    harness.fake.will_answer("stagePaths", Ok(staged));
    harness
        .fake
        .will_answer("placeFiles", Err(CallError("the disk is full".into())));
    runtime.drop_files(shot, None);
    runtime.frame(4.0);
    settle(&harness, &mut runtime);
    assert!(said(&runtime, "Nothing was pasted"));
    assert_eq!(
        runtime.state.terminal.as_ref().unwrap().size(),
        size,
        "while it says why"
    );
}
