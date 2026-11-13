//! What floats over the page: toasts stand clear of the Flock chat's composer, and a dialog is
//! drawn on the raised surface a card stands on.

use collie_desktop_board::shell::Page;
use collie_desktop_board::{App, view};
use rune::{Env, Runtime};
use serde_json::json;

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");
const SIZE: (f32, f32) = (1280.0, 860.0);

fn runtime(app: App, dark: bool) -> Runtime<App> {
    let mut runtime = Runtime::new(
        app,
        view,
        SIZE,
        Env {
            system_dark: dark,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

/// Draws a few frames, long enough for anything entering to land and short of a toast's time.
fn settle(runtime: &mut Runtime<App>, from: f64) {
    runtime.invalidate();
    for at in 1..=12 {
        runtime.frame(from + at as f64 * 100.0);
    }
}

/// The test Flock, which says one Machine was upgraded: a toast on the board.
fn with_a_notice() -> App {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    assert_eq!(app.board.notices.len(), 1, "the test Flock has one notice");
    app
}

fn rect(runtime: &Runtime<App>, key: impl Fn(&str) -> bool) -> Option<[f32; 4]> {
    runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref().is_some_and(&key))
        .map(|e| e.rect)
}

fn toast(runtime: &Runtime<App>, prefix: &str) -> Option<[f32; 4]> {
    rect(runtime, |k| k.starts_with(prefix))
}

fn composer(runtime: &Runtime<App>) -> [f32; 4] {
    rect(runtime, |k| k == "composer").expect("the chat's composer is drawn")
}

fn overlap([ax, ay, aw, ah]: [f32; 4], [bx, by, bw, bh]: [f32; 4]) -> bool {
    ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah
}

fn on_screen([x, y, w, h]: [f32; 4]) -> bool {
    w > 0.0 && h > 0.0 && x >= 0.0 && y >= 0.0 && x + w <= SIZE.0 && y + h <= SIZE.1
}

#[test]
fn a_toast_stands_clear_of_the_chats_composer_while_the_chat_is_open() {
    let mut runtime = runtime(with_a_notice(), true);
    settle(&mut runtime, 0.0);
    assert!(runtime.state.nav.chat.is_open(), "the chat starts open");
    let toast = toast(&runtime, "notice-").expect("the notice is drawn");
    let composer = composer(&runtime);
    assert!(on_screen(toast), "the toast is in the window: {toast:?}");
    assert!(
        !overlap(toast, composer),
        "the toast {toast:?} covers the composer {composer:?}"
    );
}

#[test]
fn a_pages_toast_stands_clear_of_the_chats_composer_too() {
    let mut app = App::default();
    app.open_page(Page::Machines);
    app.pages.machines.told.say("Added vm", true);
    let mut runtime = runtime(app, true);
    settle(&mut runtime, 0.0);
    let toast = toast(&runtime, "said-").expect("what the page said is drawn");
    let composer = composer(&runtime);
    assert!(
        !overlap(toast, composer),
        "the toast {toast:?} covers the composer {composer:?}"
    );
}

#[test]
fn with_the_chat_closed_the_toast_is_drawn_at_the_windows_bottom_right() {
    let mut app = with_a_notice();
    app.toggle_chat();
    assert!(!app.nav.chat.is_open());
    let mut runtime = runtime(app, true);
    settle(&mut runtime, 0.0);
    let [x, y, w, h] = toast(&runtime, "notice-").expect("the notice is still drawn");
    assert!(on_screen([x, y, w, h]), "the toast is in the window");
    assert!(
        SIZE.0 - (x + w) < 64.0 && SIZE.1 - (y + h) < 96.0,
        "the toast sits at the window's bottom right: {:?}",
        [x, y, w, h]
    );
}

/// A card that asks a question, with its answer dialog open.
fn answering() -> App {
    let now = 1_800_000_000_000.0;
    let asked = json!({"kind": "question", "run": "r-t1", "id": "c1", "step": "plan",
        "topic": "the path", "text": "Keep the old path?",
        "options": [{"id": "yes", "title": "Keep both paths", "subtitle": null}]});
    let task = json!({
        "id": "t1", "name": "Fix the redirect", "project": "collie", "state": "blocked",
        "steps": [], "sentence": "Fixing it.", "age": "5m", "drift": null, "held": null,
        "heldBy": null, "decision": asked, "questions": [asked], "agents": [], "children": [],
        "mr": null, "branch": null, "disposition": null, "landed": false, "ended": null,
        "mrState": null, "planReady": false, "offer": null, "run": "r-t1", "runs": ["r-t1"],
        "at": now - 60_000.0,
    });
    let snapshot = json!({"machine": {"installation": "inst-pc", "profile": "p-pc", "name": "mk-pc"},
        "message": {"_tag": "Snapshot", "installation": "inst-pc", "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "seq": 1, "tasks": [task]}});
    let mut app = App::default();
    app.board.clock = Some(now);
    app.apply(serde_json::from_value(snapshot).unwrap());
    app.answer_questions("inst-pc:t1");
    app
}

fn fill_of(runtime: &Runtime<App>, key: &str) -> rune::Color {
    runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("no {key}"))
        .fill
}

#[test]
fn a_dialog_is_drawn_on_the_raised_surface_menus_and_cards_stand_on() {
    for dark in [false, true] {
        let raised = collie_desktop_theme::kit(dark).c.surface_raised;
        let mut board = runtime(answering(), dark);
        settle(&mut board, 0.0);
        let answer = fill_of(&board, "questions-dialog");
        assert_eq!(answer.hex(), raised.hex(), "dark={dark}: the answer dialog");

        let mut app = App::default();
        app.open_page(Page::Machines);
        app.open_add_machine();
        let mut page = runtime(app, dark);
        settle(&mut page, 0.0);
        let add = fill_of(&page, "add-machine-dialog");
        assert_eq!(add.hex(), raised.hex(), "dark={dark}: a page's dialog");
    }
}
