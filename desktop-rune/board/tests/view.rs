//! The board as Rune builds it from the test Flock (`fixtures/flock.ndjson`), read through
//! its accessibility tree, without a window.

use collie_desktop_board::{Board, view};
use rune::{Env, Runtime};
use serde_json::Value;

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
