//! Desktop's own update, told wherever the human is: the app hears `updates` from its start,
//! and a verified update offers Restart now and Later on every page.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::shell::Page;
use rune::Runtime;
use serde_json::{Value, json};
use support::{runtime, said, settle, tap};

fn news(tag: &str, version: &str) -> Value {
    json!({ "version": "1.2.0", "news": { "_tag": tag, "version": version } })
}

/// The app as the shell starts it, on the fake core, drawn on the board.
fn started(harness: &Harness<App>) -> Runtime<App> {
    let mut app = App::default();
    app.start(harness.core.clone());
    runtime(app)
}

fn heard(harness: &Harness<App>, runtime: &mut Runtime<App>, value: Value, at: f64) {
    harness.fake.push("updates", Ok(value));
    settle(harness, runtime);
    runtime.frame(at);
}

#[test]
fn a_ready_update_is_offered_on_the_board_without_opening_settings() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), 100.0);
    assert_eq!(runtime.state.nav.page, Page::Board);
    assert!(said(&runtime, "Collie 1.3.0 is ready"));
    let mut at = 200.0;
    tap(&mut runtime, "update-restart", &mut at);
    assert_eq!(harness.fake.asked_of("restart").len(), 1);
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

fn shown(runtime: &Runtime<App>, key: &str) -> bool {
    runtime
        .elements()
        .iter()
        .any(|e| e.key.as_deref() == Some(key) && !e.exiting)
}

#[test]
fn later_puts_the_notice_away_until_the_toolbar_brings_it_back() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), 100.0);
    let mut at = 200.0;
    tap(&mut runtime, "update-later", &mut at);
    assert!(!shown(&runtime, "update-notice"));
    assert!(said(&runtime, "Collie 1.3.0 is ready to install"));

    // The same news again, as each later check says it, does not bring it back.
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), at);
    runtime.state.open_page(Page::Usage);
    runtime.invalidate();
    runtime.frame(at + 100.0);
    assert!(!shown(&runtime, "update-notice"));

    tap(&mut runtime, "update-toolbar", &mut at);
    assert!(shown(&runtime, "update-notice"));
    assert!(!shown(&runtime, "update-toolbar"));
    assert!(harness.fake.asked_of("restart").is_empty());
}

#[test]
fn a_newer_ready_version_is_offered_again_after_later() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), 100.0);
    let mut at = 200.0;
    tap(&mut runtime, "update-later", &mut at);
    heard(&harness, &mut runtime, news("Ready", "1.4.0"), at);
    assert!(shown(&runtime, "update-notice"));
    assert!(said(&runtime, "Collie 1.4.0 is ready"));
}

#[test]
fn restart_is_asked_once_however_often_it_is_pressed_and_never_without_a_press() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    for at in [100.0, 200.0, 300.0] {
        heard(&harness, &mut runtime, news("Ready", "1.3.0"), at);
    }
    assert!(harness.fake.asked_of("restart").is_empty());
    let mut at = 400.0;
    tap(&mut runtime, "update-restart", &mut at);
    runtime.state.restart_to_update();
    runtime.invalidate();
    runtime.frame(at);
    let tree = runtime.accessibility_json();
    let restarting = within(&tree)
        .into_iter()
        .find(|n| n["key"] == "update-restart")
        .unwrap();
    assert!(
        restarting["states"]
            .as_array()
            .is_some_and(|s| s.iter().any(|one| one == "disabled")),
        "the pressed Restart now waits"
    );
    assert!(said(&runtime, "Restarting…"));
    tap(&mut runtime, "update-restart", &mut at);
    assert_eq!(harness.fake.asked_of("restart").len(), 1);
}

#[test]
fn a_refused_restart_is_said_in_the_notice_and_can_be_pressed_again() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), 100.0);
    let mut at = 200.0;
    tap(&mut runtime, "update-later", &mut at);
    tap(&mut runtime, "update-toolbar", &mut at);
    tap(&mut runtime, "update-restart", &mut at);
    harness.fake.answer(
        "restart",
        Err(collie_desktop_board::calls::CallError(
            "the download is unsigned, so it was refused".into(),
        )),
    );
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(
        &runtime,
        "Collie did not restart: the download is unsigned, so it was refused"
    ));
    tap(&mut runtime, "update-restart", &mut at);
    assert_eq!(harness.fake.asked_of("restart").len(), 2);
}

#[test]
fn a_refused_restart_stays_said_after_later_until_put_off_again() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), 100.0);
    let mut at = 200.0;
    tap(&mut runtime, "update-restart", &mut at);
    harness.fake.answer(
        "restart",
        Err(collie_desktop_board::calls::CallError("offline".into())),
    );
    settle(&harness, &mut runtime);
    runtime.state.update_later();
    runtime.invalidate();
    runtime.frame(at);
    assert!(!shown(&runtime, "update-notice"));
    assert!(shown(&runtime, "update-toolbar"));
}

#[test]
fn the_notice_stands_over_every_page_and_takes_no_focus_from_the_chat() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    runtime.update(|app, _| {
        app.chat.composer = rune::TextEdit::new("half a thought");
        app.chat.composer.focused = true;
    });
    heard(&harness, &mut runtime, news("Ready", "1.3.0"), 100.0);
    for (at, page) in [
        (200.0, Page::Board),
        (300.0, Page::Workflows),
        (400.0, Page::Machines),
        (500.0, Page::Schedules),
        (600.0, Page::Usage),
        (700.0, Page::Settings),
    ] {
        runtime.state.open_page(page);
        settle(&harness, &mut runtime);
        runtime.frame(at);
        assert!(shown(&runtime, "update-notice"), "{page:?}");
    }
    assert!(runtime.state.chat.composer.focused);
    assert_eq!(runtime.state.chat.composer.text, "half a thought");
    assert!(
        !runtime
            .elements()
            .iter()
            .any(|e| e.focused && e.path.contains("update-notice"))
    );
}

#[test]
fn a_download_is_said_in_the_toolbar_and_a_failed_check_only_in_settings() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(&harness, &mut runtime, news("Downloading", "1.3.0"), 100.0);
    assert!(said(&runtime, "Downloading Collie 1.3.0…"));
    assert!(!shown(&runtime, "update-notice"));
    heard(
        &harness,
        &mut runtime,
        json!({ "version": "1.2.0", "news": { "_tag": "Failed", "reason": "offline" } }),
        200.0,
    );
    assert!(!shown(&runtime, "update-downloading"));
    assert!(!shown(&runtime, "update-notice"));
    runtime.state.open_page(Page::Settings);
    settle(&harness, &mut runtime);
    runtime.frame(300.0);
    assert!(said(&runtime, "Could not check for updates: offline"));
}

#[test]
fn the_app_hears_updates_once_whichever_pages_open() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    for page in [Page::Settings, Page::Machines, Page::Settings, Page::Board] {
        runtime.state.open_page(page);
    }
    settle(&harness, &mut runtime);
    assert_eq!(harness.fake.asked_of("updates").len(), 1);
}

#[test]
fn a_desktop_that_never_updates_shows_no_notice() {
    let harness = Harness::<App>::new();
    let mut runtime = started(&harness);
    heard(
        &harness,
        &mut runtime,
        json!({ "version": "1.2.0", "news": { "_tag": "Never", "reason": "this Desktop runs from a checkout" } }),
        100.0,
    );
    assert!(!shown(&runtime, "update-notice"));
    assert!(!shown(&runtime, "update-toolbar"));
}
