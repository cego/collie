//! The board, its Flow map and the chat as a screen reader meets them: built in-process from
//! the test Flock and `fixtures/flows.json` (Desktop's Flow test case), read through the
//! accessibility tree.

use collie_desktop_board::flow::FlowMap;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::DetailFlow;
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");
const FLOWS: &str = include_str!("../../fixtures/flows.json");

fn flow(name: &str) -> DetailFlow {
    let flows: Value = serde_json::from_str(FLOWS).unwrap();
    serde_json::from_value(flows[name].clone()).unwrap()
}

fn runtime() -> Runtime<App> {
    let mut board = App::default();
    for line in FLOCK.lines() {
        board.apply(serde_json::from_str(line).unwrap());
    }
    board.nav.chat.set_open(true);
    board.flow = Some(FlowMap::new(flow("before")));
    let mut runtime = Runtime::new(
        board,
        view,
        (1600.0, 1000.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

fn keyed(tree: &Value, key: &str) -> Value {
    within(tree)
        .into_iter()
        .find(|node| node["key"] == key)
        .unwrap_or_else(|| panic!("no {key} in {tree:#}"))
        .clone()
}

fn focused(runtime: &Runtime<App>) -> Option<String> {
    let tree = runtime.accessibility_json();
    within(&tree)
        .into_iter()
        .find(|node| {
            node["states"]
                .as_array()
                .is_some_and(|states| states.iter().any(|s| s == "focused"))
        })
        .and_then(|node| node["key"].as_str().map(String::from))
}

fn press(runtime: &mut Runtime<App>, key: Key) {
    runtime.key(KeyEvent {
        key,
        mods: Mods::default(),
    });
    runtime.frame(0.1);
}

#[test]
fn a_card_a_flow_node_and_the_chat_log_say_what_they_are() {
    let tree = runtime().accessibility_json();
    let card = within(&tree)
        .into_iter()
        .find(|node| node["name"] == "Fix the login redirect")
        .unwrap_or_else(|| panic!("no card in {tree:#}"));
    assert!(card["key"].as_str().unwrap().starts_with("card-"));
    assert_eq!(
        card["role"], "button",
        "a card is pressed to select it and opened twice"
    );
    assert_eq!(
        card["description"], "Fixing the review findings, round 2 of 5.",
        "a card says its sentence"
    );

    let map = keyed(&tree, "flow");
    assert_eq!(
        (&map["role"], &map["name"]),
        (&"group".into(), &"Flow".into())
    );
    let lane = keyed(&tree, "flow-row-build-run");
    assert_eq!(lane["role"], "group");
    assert_eq!(lane["name"], "Implement, build-run, on laptop, running");
    let release = keyed(&tree, "flow-row-release");
    assert_eq!(release["name"], "Release");
    let build = keyed(&tree, "flow-build-run-build");
    assert_eq!(build["role"], "button");
    assert_eq!(build["name"], "Build, running, Slice 4 of 6");
    assert_eq!(
        keyed(&tree, "flow-build-run-review")["name"],
        "Review, expected"
    );

    let log = keyed(&tree, "chat-log");
    assert_eq!(
        (&log["role"], &log["name"]),
        (&"log".into(), &"Flock chat".into())
    );
}

#[test]
fn the_flow_map_is_one_tab_stop_at_the_current_step() {
    let mut runtime = runtime();
    let mut stops = Vec::new();
    for _ in 0..60 {
        press(&mut runtime, Key::Tab);
        let Some(key) = focused(&runtime) else {
            continue;
        };
        if stops.first() == Some(&key) {
            break;
        }
        stops.push(key);
    }
    let in_map: Vec<&String> = stops.iter().filter(|k| k.starts_with("flow-")).collect();
    assert_eq!(in_map, ["flow-build-run-build"], "Tab stops: {stops:?}");
}

#[test]
fn arrows_move_about_the_flow_map_as_flow_key_does() {
    let moves: [(&[Key], &str); 5] = [
        (&[Key::Down], "flow-release-ci"),
        (&[Key::Up], "flow-plan-run-grill"),
        (&[Key::End], "flow-build-run-mr"),
        (&[Key::End, Key::Right], "flow-build-run-mr"),
        (&[Key::End, Key::Home], "flow-build-run-build"),
    ];
    for (keys, lands) in moves {
        let mut runtime = runtime();
        let mut tabs = 0;
        while focused(&runtime).as_deref() != Some("flow-build-run-build") {
            press(&mut runtime, Key::Tab);
            tabs += 1;
            assert!(tabs < 60, "Tab never reached the Flow map");
        }
        for key in keys {
            press(&mut runtime, key.clone());
        }
        assert_eq!(focused(&runtime).as_deref(), Some(lands), "{keys:?}");
    }
}

#[test]
fn a_new_current_step_and_a_step_that_asks_are_announced_politely() {
    let mut runtime = runtime();
    let announced = |runtime: &Runtime<App>| {
        let said = keyed(&runtime.accessibility_json(), "flow-announcement");
        assert!(
            said["states"]
                .as_array()
                .is_some_and(|states| states.iter().any(|s| s == "live-polite")),
            "{said:#}"
        );
        said["name"].as_str().unwrap_or_default().to_string()
    };
    assert_eq!(announced(&runtime), "");
    runtime.update(|board, _| board.flow.as_mut().unwrap().set(flow("after")));
    runtime.frame(0.1);
    assert_eq!(announced(&runtime), "Review, expected");
    runtime.update(|board, _| board.flow.as_mut().unwrap().set(flow("asking")));
    runtime.frame(0.1);
    assert_eq!(announced(&runtime), "Review, needs you, Asked 1 min ago");
}

/// A narrow window on one Machine with two Projects, one Task of which needs the operator.
fn with_projects(width: f32) -> Runtime<App> {
    let items = [
        json!({"machine": {"installation": "inst-pc", "profile": "local", "name": "mk-pc"},
            "message": {"_tag": "Snapshot", "installation": "inst-pc", "build": "0.118.0",
                "protocol": 7, "files": true, "herds": [{"id": "h1"}],
                "projects": [
                    {"installation": "inst-pc", "id": "project-payments", "name": "Payments",
                     "starred": false, "archived": false, "tasks": 1.0, "needs": 1.0},
                    {"installation": "inst-pc", "id": "project-cego", "name": "CEGO Platform",
                     "starred": true, "archived": false, "tasks": 0.0, "needs": 0.0}
                ],
                "tasks": [{
                    "id": "t-1", "name": "Refunds", "project": "content", "state": "blocked",
                    "steps": [], "sentence": "Refunds is waiting on you.", "age": "5m",
                    "drift": null, "held": null, "heldBy": null, "decision": null, "agents": [],
                    "children": [], "mr": null, "branch": null, "disposition": null,
                    "landed": false, "ended": null, "mrState": null, "planReady": false,
                    "offer": null, "run": "r-1", "runs": ["r-1"], "at": 1.0,
                    "projectId": {"installation": "inst-pc", "id": "project-payments"}
                }],
                "seq": 1}
        }),
    ];
    let mut board = App::default();
    for item in items {
        board.apply(serde_json::from_value(item).unwrap());
    }
    board.nav.chat.set_open(false);
    let mut runtime = Runtime::new(
        board,
        view,
        (width, 640.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime.frame(0.016);
    runtime
}
/// A board of one Machine whose `states` say what each Task's state is: `moving` is blocked,
/// so a fold of a second item moves it from Working to Needs you.
fn moving() -> Runtime<App> {
    let task = |state: &str| {
        json!({"id": "t-1", "name": "Refunds", "project": "content", "state": state,
            "steps": [], "sentence": "Refunds is under way.", "age": "5m", "drift": null,
            "held": null, "heldBy": null, "decision": null, "agents": [], "children": [],
            "mr": null, "branch": null, "disposition": null, "landed": false, "ended": null,
            "mrState": null, "planReady": false, "offer": null, "run": "r-1", "runs": ["r-1"],
            "at": 1.0})
    };
    let mut board = App::default();
    board.apply(
        serde_json::from_value(json!({
            "machine": {"installation": "inst-pc", "profile": "local", "name": "mk-pc"},
            "message": {"_tag": "Snapshot", "installation": "inst-pc", "build": "0.118.0",
                "protocol": 7, "files": true, "herds": [{"id": "h1"}],
                "tasks": [task("active")], "seq": 1},
        }))
        .unwrap(),
    );
    board.nav.chat.set_open(false);
    let mut runtime = Runtime::new(
        board,
        view,
        (1280.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime.frame(0.016);
    runtime
}

#[test]
fn a_card_that_moves_to_another_section_keeps_the_keyboard_on_its_control() {
    let mut runtime = moving();
    for _ in 0..60 {
        press(&mut runtime, Key::Tab);
        if focused(&runtime).is_some_and(|key| key.starts_with("card-")) {
            break;
        }
    }
    let held = focused(&runtime).expect("a card control takes the keyboard");
    // The app records where the keyboard is as each frame is drawn, which is what a move consults.
    collie_desktop_board::frame_drawn(&runtime, 0.0);
    // The Task is blocked on the host's next update, so its card leaves Working for Needs you.
    runtime.state.apply(
        serde_json::from_value(json!({
            "machine": {"installation": "inst-pc", "profile": "local", "name": "mk-pc"},
            "message": {"_tag": "Upsert", "seq": 2, "task": {
                "id": "t-1", "name": "Refunds", "project": "content", "state": "blocked",
                "steps": [], "sentence": "Refunds needs you.", "age": "5m", "drift": null,
                "held": null, "heldBy": null, "decision": null, "agents": [], "children": [],
                "mr": null, "branch": null, "disposition": null, "landed": false, "ended": null,
                "mrState": null, "planReady": false, "offer": null, "run": "r-1",
                "runs": ["r-1"], "at": 1.0}
            },
        }))
        .unwrap(),
    );
    // The card is new where it landed, and its section springs into place: it takes the
    // keyboard back once it shows.
    runtime.settle_all();
    for at in 1..8 {
        runtime.frame(f64::from(at) * 0.1);
    }
    assert_eq!(
        focused(&runtime).as_deref(),
        Some(held.as_str()),
        "the control the keyboard was on is still the one it is on, in its new section"
    );
    let tree = runtime.accessibility_json();
    assert!(
        within(&tree)
            .into_iter()
            .any(|node| node["key"] == "needs-you"),
        "the card really moved"
    );
}

#[test]
fn at_a_narrow_width_the_sidebar_names_the_flock_and_each_project() {
    let tree = with_projects(760.0).accessibility_json();
    assert_eq!(keyed(&tree, "nav-board")["name"], "Board");
    assert_eq!(keyed(&tree, "projects")["name"], "Projects");
    let payments = keyed(&tree, "project-inst-pc-project-payments");
    assert_eq!(payments["name"], "Payments");
    assert_eq!(
        payments["description"], "1",
        "a Project says how many Tasks need you"
    );
    assert_eq!(
        keyed(&tree, "project-inst-pc-project-cego")["name"],
        "CEGO Platform"
    );
    assert_eq!(keyed(&tree, "nav-settings")["name"], "Settings");
}
#[test]
fn keyboard_focus_reaches_the_flock_and_each_project_and_selecting_keeps_the_row_focused() {
    let mut runtime = with_projects(760.0);
    // The sidebar is one focus group: Tab enters it at the Board, and the arrows go on.
    for _ in 0..80 {
        press(&mut runtime, Key::Tab);
        if focused(&runtime).as_deref() == Some("nav-board") {
            break;
        }
    }
    let mut stops = Vec::new();
    for _ in 0..20 {
        press(&mut runtime, Key::Down);
        let Some(key) = focused(&runtime) else {
            continue;
        };
        stops.push(key.clone());
        if key == "project-inst-pc-project-payments" {
            break;
        }
    }
    assert_eq!(
        focused(&runtime).as_deref(),
        Some("project-inst-pc-project-payments"),
        "arrows reach a Project's row: {stops:?}"
    );
    press(&mut runtime, Key::Enter);
    assert_eq!(
        focused(&runtime).as_deref(),
        Some("project-inst-pc-project-payments"),
        "selecting a Project leaves its row focused"
    );
    let tree = runtime.accessibility_json();
    let selected = keyed(&tree, "project-inst-pc-project-payments");
    assert!(
        selected["states"]
            .as_array()
            .is_some_and(|states| states.iter().any(|one| one == "selected")),
        "{selected:#}"
    );
    assert!(
        within(&tree)
            .into_iter()
            .any(|node| node["name"] == "Following"),
        "the scoped board offers Following"
    );
}
