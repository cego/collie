//! Scrolling runs no view: what follows a scroll moves without a commit, and what the core says
//! while a viewport scrolls waits until it rests.

use collie_desktop_board::flow::FlowMap;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::DetailFlow;
use rune::{Cx, El, Env, Runtime, WheelEvent};
use serde_json::Value;
use std::cell::Cell;
use std::time::Duration;

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");
const FLOWS: &str = include_str!("../../fixtures/flows.json");

thread_local! {
    static VIEWS: Cell<u32> = const { Cell::new(0) };
}

fn counted(app: &App, cx: &mut Cx<App>) -> El {
    VIEWS.with(|v| v.set(v.get() + 1));
    view(app, cx)
}

fn views() -> u32 {
    VIEWS.with(Cell::get)
}

fn board(flow: bool) -> Runtime<App> {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    if flow {
        let flows: Value = serde_json::from_str(FLOWS).unwrap();
        let read: DetailFlow = serde_json::from_value(flows["before"].clone()).unwrap();
        app.flow = Some(FlowMap::new(read));
    }
    // Short enough that the board scrolls under its cards.
    let mut rt = Runtime::new(
        app,
        counted,
        (1280.0, 420.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }
    rt
}

fn swipe(rt: &mut Runtime<App>) {
    for _ in 0..6 {
        rt.wheel_event(WheelEvent::new(0.0, -30.0).at(700.0, 300.0));
        rt.frame(1.0 / 60.0);
    }
}

fn content_y(rt: &Runtime<App>) -> f32 {
    rt.elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("board-body"))
        .map(|e| e.rect[1])
        .expect("the board's body")
}

#[test]
fn the_flow_map_rides_a_scroll_without_running_the_view() {
    let mut rt = board(true);
    let (before, at) = (views(), content_y(&rt));
    swipe(&mut rt);
    assert!(content_y(&rt) < at - 60.0, "the board scrolled");
    assert_eq!(views(), before, "a scroll commits nothing");
}

#[test]
fn what_the_core_says_while_the_board_scrolls_waits_until_it_rests() {
    let mut rt = board(false);
    let open = rt.state.board.older_open;
    swipe(&mut rt);
    let now = rt
        .state
        .take_change(Box::new(|app: &mut App| app.board.older_open ^= true));
    assert!(!now, "held while the board scrolls");
    assert_eq!(rt.state.board.older_open, open);
    assert!(
        !rt.state.release_held(),
        "still held a moment after the hand"
    );
    std::thread::sleep(Duration::from_millis(250));
    assert!(rt.state.release_held(), "applied once the board rests");
    assert_eq!(rt.state.board.older_open, !open);
    let next = rt
        .state
        .take_change(Box::new(|app: &mut App| app.board.older_open ^= true));
    assert!(next, "at rest a change applies at once");
    assert_eq!(rt.state.board.older_open, open);
}

fn has(rt: &Runtime<App>, key: &str) -> bool {
    rt.elements()
        .iter()
        .any(|e| e.key.as_deref() == Some(key) && !e.exiting)
}

#[test]
fn a_closed_chat_stops_being_built_once_its_close_has_played() {
    let mut rt = board(false);
    rt.state.nav.chat.set_open(true);
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "chat-log"), "the open chat is drawn");
    rt.state.nav.chat.set_open(false);
    assert!(!rt.state.rest_closed_chat(1_000.0));
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "chat-log"), "its close plays over what it showed");
    assert!(!rt.state.rest_closed_chat(1_300.0));
    assert!(rt.state.rest_closed_chat(1_700.0), "then it goes");
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert!(
        !has(&rt, "chat-log"),
        "a closed chat costs a commit nothing"
    );
    assert!(!rt.state.rest_closed_chat(2_000.0), "once");
    rt.state.nav.chat.set_open(true);
    rt.invalidate();
    rt.frame(1.0 / 60.0);
    assert!(has(&rt, "chat-log"), "opening it draws it at once");
}
