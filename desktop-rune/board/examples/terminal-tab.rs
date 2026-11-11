//! A record's Terminal tab drawn from a recorded `terminal` stream, for a headless look at
//! it in the app without a live pane: nothing is sent anywhere.
//!
//! `REPLAY=fixtures/terminal/herdr-ls.ndjson [STATE=connecting|ended|failed|nopane] cargo run -p collie-desktop-board --example terminal-tab -- --snap tab.png --at 0.6 --size 1280x860 --theme light`

use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::view::Tab;
use rune::AppSpec;
use serde_json::json;

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

fn init() -> App {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    app.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    app.go_to_pane("inst-build".into(), "r1".into(), "Build box".into());
    app
}

fn event(value: serde_json::Value) -> TerminalEvent {
    serde_json::from_value(value).unwrap()
}

/// The recorded stream arrives once the tab is laid out, as a live one does.
fn poll(app: &mut App, t: f64, _: &mut rune::Tx) -> bool {
    let Some(tab) = app.terminal.as_mut().filter(|_| t > 0.2) else {
        return false;
    };
    if tab.at.is_some() || tab.ended.is_some() {
        return false;
    }
    let state = std::env::var("STATE").unwrap_or_default();
    if state == "connecting" {
        return false;
    }
    let replay = std::env::var("REPLAY").unwrap_or("fixtures/terminal/herdr-ls.ndjson".into());
    for line in std::fs::read_to_string(replay).unwrap().lines() {
        let shown = serde_json::from_str::<TerminalEvent>(line).unwrap();
        if state == "nopane" || state == "failed" {
            break;
        }
        tab.shown(shown);
    }
    match state.as_str() {
        "ended" => tab.shown(event(
            json!({"_tag": "Ended", "reason": "herdr's controller exited 1"}),
        )),
        "failed" => {
            tab.failed_with("Build box's core: SocketError: An error occurred during Read".into())
        }
        "nopane" => tab.shown(event(json!({"_tag": "NoPane",
            "at": {"session": null, "workspace": "Bump effect", "tab": null}}))),
        _ => {}
    }
    true
}

fn main() {
    rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        poll: Some(poll),
        ..AppSpec::new("Collie", (1280.0, 860.0), init, view)
    })
    .run();
}
