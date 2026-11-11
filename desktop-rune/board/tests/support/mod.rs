//! Driving a page through the fake core: tapping by key, settling answers, reading what is said.

#![allow(dead_code)]

use collie_desktop_board::App;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::view;
use collie_desktop_protocol::generated::FlockItem;
use rune::{Env, Runtime};
use serde_json::json;

pub fn runtime(app: App) -> Runtime<App> {
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 860.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

/// The element keyed by the last part of `key`, inside elements keyed by the parts before it.
pub fn path_of(runtime: &Runtime<App>, key: &str) -> Option<String> {
    let parts: Vec<&str> = key.split('/').collect();
    runtime.elements().into_iter().map(|e| e.path).find(|path| {
        let mut segments = path.split('/');
        path.ends_with(&format!("/{}", parts[parts.len() - 1]))
            && parts.iter().all(|part| segments.any(|s| s == *part))
    })
}

/// What the core answered, and anything a test set by hand, drawn on the next frame.
pub fn settle(harness: &Harness<App>, runtime: &mut Runtime<App>) {
    harness.settle(&mut runtime.state);
    runtime.invalidate();
}

pub fn tap(runtime: &mut Runtime<App>, key: &str, at: &mut f64) {
    runtime.invalidate();
    runtime.frame(*at);
    let path = path_of(runtime, key).unwrap_or_else(|| panic!("no {key}"));
    let (x, y) = runtime.find(&path).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(*at + 16.0);
    runtime.pointer_down(x, y);
    runtime.frame(*at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(*at + 100.0);
    *at += 600.0;
}

pub fn said(runtime: &Runtime<App>, text: &str) -> bool {
    runtime.elements().iter().any(|e| {
        e.text.as_deref().is_some_and(|t| t.contains(text))
            || e.label.as_deref().is_some_and(|l| l.contains(text))
    })
}

/// Taps the element whose accessible label is `label`.
pub fn tap_label(runtime: &mut Runtime<App>, label: &str, at: &mut f64) {
    runtime.invalidate();
    runtime.frame(*at);
    let path = runtime
        .elements()
        .into_iter()
        .find(|e| e.label.as_deref() == Some(label))
        .map(|e| e.path)
        .unwrap_or_else(|| panic!("nothing labelled {label}"));
    tap(runtime, &path, at);
}

/// An App on the fake core with two live Machines: this computer `mk-pc` (`local`, `i-pc`)
/// and `vm` (`p-vm`, `i-vm`), both on Collie 0.35.0.
pub fn flock_app(harness: &Harness<App>) -> App {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    let items = [
        json!({ "_tag": "Routed", "machine": { "profile": "local", "name": "mk-pc" } }),
        json!({ "_tag": "Routed", "machine": { "profile": "p-vm", "name": "vm", "target": "mk@vm" } }),
        snapshot("i-pc", "local", "mk-pc"),
        snapshot("i-vm", "p-vm", "vm"),
    ];
    for one in items {
        let one: FlockItem = serde_json::from_value(one).unwrap();
        app.apply(one.clone());
        app.pages.machines.heard(&one);
    }
    app
}

fn snapshot(installation: &str, profile: &str, name: &str) -> serde_json::Value {
    json!({
        "machine": { "installation": installation, "profile": profile, "name": name },
        "message": { "_tag": "Snapshot", "installation": installation, "build": "0.35.0",
            "protocol": 5, "herds": [], "tasks": [], "seq": 0 },
    })
}
