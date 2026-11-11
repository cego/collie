//! The board as Rune builds it from the test Flock (`fixtures/flock.ndjson`), read through
//! its accessibility tree, without a window.

use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::{DetailFlow, TerminalPayload};
use collie_desktop_terminal::view::Tab;
use rune::{Env, Runtime};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

fn board() -> App {
    let mut board = App::default();
    for line in FLOCK.lines() {
        board.apply(serde_json::from_str(line).unwrap());
    }
    board
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

#[test]
fn the_board_says_its_sections_in_order_with_their_cards_by_name() {
    let mut runtime = Runtime::new(
        board(),
        view,
        (1280.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    let tree = runtime.accessibility_json();
    let nodes = within(&tree);
    let header = nodes
        .iter()
        .find(|n| n["key"] == "header")
        .unwrap_or_else(|| panic!("no header in {tree:#}"));
    assert_eq!(header["role"], "status");
    assert_eq!(header["name"], "One task is waiting on you. 4 working.");
    let lost = nodes
        .iter()
        .find(|n| n["key"] == "lost-laptop")
        .unwrap_or_else(|| panic!("no lost-laptop in {tree:#}"));
    assert_eq!(lost["name"], "Laptop is out of reach");

    let sections: Vec<(&Value, Vec<&Value>)> = nodes
        .iter()
        .filter(|n| {
            ["needs-you", "waiting", "working", "finished"]
                .iter()
                .any(|s| n["key"] == *s)
        })
        .map(|section| {
            let cards = within(section)
                .into_iter()
                .filter(|n| n["role"] == "button")
                .filter(|n| {
                    n["key"]
                        .as_str()
                        .is_some_and(|k| k.starts_with("card-") && k.matches('-').count() == 1)
                })
                .map(|n| &n["name"])
                .collect();
            (&section["name"], cards)
        })
        .collect();
    assert_eq!(
        sections,
        [
            (
                &"Needs you, 1".into(),
                vec![&"Fix the login redirect".into()]
            ),
            (
                &"Working, 4".into(),
                vec![
                    &"Strapi prod seeder".into(),
                    &"Nightly evidence sweep".into(),
                    &"Bump effect to 4.2".into(),
                    &"Port the Flow map".into(),
                ]
            ),
            // A finished card that has been seen is folded away, as today.
            (&"Finished, 1".into(), vec![]),
        ]
    );
}

const PATCH: &str = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";

fn tap(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

/// A card is opened by a second press; the first selects it.
fn open(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    for _ in 0..2 {
        runtime.pointer_down(x, y);
        runtime.frame(0.05);
        runtime.pointer_up(x, y);
        runtime.frame(0.05);
    }
    runtime.frame(1.0);
}

fn keys(runtime: &Runtime<App>) -> Vec<String> {
    within(&runtime.accessibility_json())
        .iter()
        .filter_map(|node| node["key"].as_str().map(String::from))
        .collect()
}

#[test]
fn pressing_a_card_goes_to_its_runs_pane_and_back_leaves_it_for_the_board() {
    let asked: Arc<Mutex<Vec<(TerminalPayload, String)>>> = Arc::default();
    let mut board = board();
    let said = asked.clone();
    board.go_to = Some(Box::new(move |payload, machine, _| {
        said.lock().unwrap().push((payload, machine.clone()));
        Tab::new(None, machine, 100, 30)
    }));
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
    open(&mut runtime, "card-b2", 100.0);
    let asked_for = asked.lock().unwrap().clone();
    assert_eq!(
        asked_for,
        [(
            TerminalPayload {
                installation: "inst-build".into(),
                run_id: "r1".into(),
                agent: None,
                cols: 100,
                rows: 30,
            },
            "Build box".to_string()
        )]
    );
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");
    assert!(!shown.iter().any(|k| k.starts_with("card-")), "{shown:?}");

    tap(&mut runtime, "back", 1000.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "card-b2"), "{shown:?}");
}

#[test]
fn the_chat_opens_beside_the_board_and_closes() {
    let mut runtime = Runtime::new(
        board(),
        view,
        (1280.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    assert!(!keys(&runtime).iter().any(|k| k == "chat"));
    tap(&mut runtime, "open-chat", 100.0);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "chat"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "card-b2"), "{shown:?}");
    tap(&mut runtime, "open-chat", 1000.0);
    assert!(!keys(&runtime).iter().any(|k| k == "chat"));
}

#[test]
fn a_panes_diff_button_asks_for_its_runs_diff_and_shows_it_once_read() {
    let asked: Arc<Mutex<Vec<(String, String, u64)>>> = Arc::default();
    let mut board = board();
    board.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    let said = asked.clone();
    board.load_diff = Some(Box::new(move |installation, run, opened| {
        said.lock().unwrap().push((installation, run, opened));
    }));
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
    open(&mut runtime, "card-b2", 100.0);
    tap(&mut runtime, "open-diff", 1000.0);
    assert_eq!(
        *asked.lock().unwrap(),
        [("inst-build".to_string(), "r1".to_string(), 1)]
    );
    runtime.update(|board, _| board.diff_read(1, PATCH));
    runtime.frame(2000.0);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "diff"), "{shown:?}");
    tap(&mut runtime, "close-diff", 3000.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "diff"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");
}

#[test]
fn a_diff_read_for_a_pane_since_left_is_not_shown_over_the_next() {
    let mut board = board();
    board.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    board.load_diff = Some(Box::new(|_, _, _| {}));
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
    open(&mut runtime, "card-b2", 100.0);
    tap(&mut runtime, "open-diff", 1000.0);
    tap(&mut runtime, "back", 2000.0);
    open(&mut runtime, "card-b1", 3000.0);
    runtime.update(|board, _| board.diff_read(1, PATCH));
    runtime.frame(4000.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "diff"), "{shown:?}");
    runtime.update(|board, _| board.diff_read(2, PATCH));
    runtime.frame(5000.0);
    assert!(keys(&runtime).iter().any(|k| k == "diff"));
}

fn flow(name: &str) -> DetailFlow {
    let flows: Value = serde_json::from_str(include_str!("../../fixtures/flows.json")).unwrap();
    serde_json::from_value(flows[name].clone()).unwrap()
}

#[test]
fn a_panes_run_record_gives_its_flow_map_and_one_since_left_does_not() {
    let asked: Arc<Mutex<Vec<(String, String, u64)>>> = Arc::default();
    let mut board = board();
    board.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    let said = asked.clone();
    board.read_record = Some(Box::new(move |installation, run, opened| {
        said.lock().unwrap().push((installation, run, opened));
        Box::new(|| {})
    }));
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
    open(&mut runtime, "card-b2", 100.0);
    assert_eq!(
        *asked.lock().unwrap(),
        [("inst-build".to_string(), "r1".to_string(), 1)]
    );
    runtime.update(|board, _| board.flow_read(1, flow("before")));
    runtime.frame(1000.0);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "flow"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");

    tap(&mut runtime, "back", 2000.0);
    assert!(
        keys(&runtime).iter().any(|k| k == "flow"),
        "the board keeps it"
    );
    open(&mut runtime, "card-b1", 3000.0);
    runtime.update(|board, _| board.flow_read(1, flow("before")));
    runtime.frame(4000.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "flow"), "{shown:?}");
}

#[test]
fn the_chats_controls_stay_inside_its_panel_and_leave_the_composer_the_most_room() {
    for running in [false, true] {
        let mut board = board();
        board.nav.chat.set_open(true);
        board.chat.transcript.running = running;
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
        let elements = runtime.elements();
        let rect = |key: &str| {
            elements
                .iter()
                .find(|e| e.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("no {key}"))
                .rect
        };
        let [px, py, pw, ph] = rect("chat");
        let action = if running { "stop" } else { "send" };
        for key in ["attach", "composer", action, "highlighter"] {
            let [x, y, w, h] = rect(key);
            assert!(
                x >= px && y >= py && x + w <= px + pw && y + h <= py + ph,
                "{key} at {:?} leaves the chat at {:?} (running: {running})",
                [x, y, w, h],
                [px, py, pw, ph]
            );
        }
        let composer = rect("composer")[2];
        for key in ["attach", action, "highlighter"] {
            assert!(
                composer > rect(key)[2],
                "the composer, {composer} wide, is narrower than {key} (running: {running})"
            );
        }
    }
}
