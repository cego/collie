//! The board, its Flow map and the chat as a screen reader meets them: built in-process from
//! the test Flock and `fixtures/flows.json` (Desktop's Flow test case), read through the
//! accessibility tree.

use collie_desktop_board::flow::FlowMap;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::DetailFlow;
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::Value;

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

fn press(runtime: &mut Runtime<App>, key: Key, at: &mut f64) {
    runtime.key(KeyEvent {
        key,
        mods: Mods::default(),
    });
    *at += 100.0;
    runtime.frame(*at);
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
    let mut at = 0.0;
    let mut stops = Vec::new();
    for _ in 0..60 {
        press(&mut runtime, Key::Tab, &mut at);
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
        let mut at = 0.0;
        while focused(&runtime).as_deref() != Some("flow-build-run-build") {
            press(&mut runtime, Key::Tab, &mut at);
            assert!(at < 6000.0, "Tab never reached the Flow map");
        }
        for key in keys {
            press(&mut runtime, key.clone(), &mut at);
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
    runtime.frame(100.0);
    assert_eq!(announced(&runtime), "Review, expected");
    runtime.update(|board, _| board.flow.as_mut().unwrap().set(flow("asking")));
    runtime.frame(200.0);
    assert_eq!(announced(&runtime), "Review, needs you, Asked 1 min ago");
}
