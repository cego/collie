//! The board as Rune builds it from the test Flock (`fixtures/flock.ndjson`), read through
//! its accessibility tree, without a window.

use collie_desktop_board::{Board, view};
use collie_desktop_protocol::generated::TerminalPayload;
use collie_desktop_terminal::view::Tab;
use rune::{Env, Runtime};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

fn board() -> Board {
    let mut board = Board::default();
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
fn each_machine_says_its_status_and_shows_its_cards_by_name() {
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
    let machines: [(&str, &str, &str, &[&str]); 4] = [
        (
            "machine-local",
            "Local: Live, 3 cards",
            "Live",
            &[
                "Strapi prod seeder",
                "Fix the login redirect",
                "Release 0.119.0",
            ],
        ),
        (
            "machine-build",
            "Build box: Live, 2 cards",
            "Live",
            &["Nightly evidence sweep", "Bump effect to 4.2"],
        ),
        (
            "machine-laptop",
            "Laptop: Out of reach, no cards",
            "Out of reach",
            &[],
        ),
        (
            "machine-studio",
            "Studio: Showing what it last said, 1 card",
            "Showing what it last said",
            &["Port the Flow map"],
        ),
    ];
    for (key, label, status, cards) in machines {
        let machine = nodes
            .iter()
            .find(|node| node["key"] == key)
            .unwrap_or_else(|| panic!("no {key} in {tree:#}"));
        assert_eq!(machine["name"], label);
        let inside = within(machine);
        let said: Vec<&Value> = inside
            .iter()
            .filter(|n| n["role"] == "status")
            .map(|n| &n["name"])
            .collect();
        assert_eq!(said, [status], "{key}'s status");
        let shown: Vec<&Value> = inside
            .iter()
            .filter(|n| n["key"].as_str().is_some_and(|k| k.starts_with("card-")))
            .map(|n| &n["name"])
            .collect();
        assert_eq!(shown, cards, "{key}'s cards");
    }
}

fn tap(runtime: &mut Runtime<Board>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

fn keys(runtime: &Runtime<Board>) -> Vec<String> {
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
    tap(&mut runtime, "card-b2", 100.0);
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
    let asked: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let mut board = board();
    board.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    let said = asked.clone();
    board.load_diff = Some(Box::new(move |installation, run| {
        said.lock().unwrap().push((installation, run));
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
    tap(&mut runtime, "card-b2", 100.0);
    tap(&mut runtime, "open-diff", 1000.0);
    assert_eq!(
        *asked.lock().unwrap(),
        [("inst-build".to_string(), "r1".to_string())]
    );
    runtime.update(|board, _| {
        board.diff = Some(collie_desktop_chat::view::DiffTab::new(
            rune_kit::diff::parse("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n"),
        ))
    });
    runtime.frame(2000.0);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "diff"), "{shown:?}");
    tap(&mut runtime, "close-diff", 3000.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "diff"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");
}
