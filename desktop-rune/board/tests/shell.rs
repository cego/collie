//! The window's frame and the view's calls to the core, without a window or a core.

use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::pages::usage::Level;
use collie_desktop_board::shell::Page;
use collie_desktop_board::{App, view};
use rune::{Env, Runtime};
use serde_json::{Value, json};

fn runtime(app: App) -> Runtime<App> {
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

fn tap(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

#[test]
fn each_sidebar_row_opens_its_page_and_the_toolbar_names_it() {
    let mut runtime = runtime(App::default());
    let mut at = 100.0;
    for page in Page::ALL.iter().rev() {
        tap(&mut runtime, page.key(), at);
        at += 400.0;
        assert_eq!(runtime.state.nav.page, *page);
        let named = runtime.elements().iter().any(|e| {
            e.text.as_deref() == Some(page.title()) && e.key.as_deref() != Some(page.key())
        });
        assert!(named, "nothing but the sidebar row says {}", page.title());
    }
}

#[test]
fn the_chat_pane_opens_and_closes_from_the_toolbar() {
    let mut runtime = runtime(App::default());
    assert!(!runtime.state.nav.chat.is_open());
    tap(&mut runtime, "open-chat", 100.0);
    assert!(runtime.state.nav.chat.is_open());
    tap(&mut runtime, "open-chat", 2000.0);
    assert!(!runtime.state.nav.chat.is_open());
}

#[derive(Default)]
struct Heard(Vec<Result<Value, CallError>>);

#[test]
fn a_request_is_answered_on_the_apps_state_with_its_typed_answer_or_its_reason() {
    let harness = Harness::<Heard>::new();
    let mut heard = Heard::default();
    harness
        .fake
        .will_answer("usage", Ok(json!({"entries": []})));
    harness
        .core
        .request("usage", json!({}), |s: &mut Heard, a: Result<Value, _>| {
            s.0.push(a)
        });
    harness.core.request(
        "syncNow",
        json!({"profile": "gone"}),
        |s: &mut Heard, a: Result<Value, _>| s.0.push(a),
    );
    assert!(
        heard.0.is_empty(),
        "answers are applied only when the view's thread runs them"
    );
    harness.settle(&mut heard);
    assert_eq!(heard.0, [Ok(json!({"entries": []}))]);
    assert!(harness.fake.answer(
        "syncNow",
        Err(CallError("no Machine is called gone".into()))
    ));
    harness.settle(&mut heard);
    assert_eq!(
        heard.0[1],
        Err(CallError("no Machine is called gone".into()))
    );
    assert_eq!(
        harness.fake.asked_of("syncNow"),
        [json!({"profile": "gone"})]
    );
}

#[test]
fn an_answer_in_a_shape_the_app_cannot_read_says_so_instead_of_panicking() {
    let harness = Harness::<Vec<Result<u32, CallError>>>::new();
    let mut heard = Vec::new();
    harness.fake.will_answer("usage", Ok(json!("not a number")));
    harness
        .core
        .request("usage", json!({}), |s: &mut Vec<_>, a: Result<u32, _>| {
            s.push(a)
        });
    harness.settle(&mut heard);
    assert!(matches!(&heard[..], [Err(CallError(why))] if why.contains("can't read")));
}

#[test]
fn a_stream_delivers_each_value_until_it_is_stopped() {
    let harness = Harness::<Vec<i64>>::new();
    let mut heard = Vec::new();
    let stop = harness
        .core
        .stream("usage", json!({}), |s: &mut Vec<i64>, v: Result<i64, _>| {
            s.push(v.unwrap())
        });
    harness.fake.push("usage", Ok(json!(1)));
    harness.fake.push("usage", Ok(json!(2)));
    stop();
    harness.fake.push("usage", Ok(json!(3)));
    harness.settle(&mut heard);
    assert_eq!(heard, [1, 2]);
}

#[test]
fn the_chats_width_is_taken_from_settings_and_saved_once_a_drag_lets_go() {
    let harness = Harness::<App>::new();
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    let mut settings = app.chat.settings();
    settings.chat_width = Some(600.0);
    app.chat.settings = Some(settings);
    app.keep_chat_width();
    assert_eq!(app.nav.chat.width(), 600.0);
    assert!(
        harness.fake.asked_of("setSettings").is_empty(),
        "a width read back is not saved again"
    );

    app.nav.chat.set_width(512.0);
    app.keep_chat_width();
    app.keep_chat_width();
    assert_eq!(
        harness.fake.asked_of("setSettings"),
        [json!({ "chatWidth": 512.0 })]
    );
}

#[test]
fn the_windows_focus_reaches_an_open_terminal_and_its_scale_is_the_displays() {
    let mut app = App::default();
    app.terminal = Some(collie_desktop_terminal::view::Tab::new(
        None,
        "laptop".into(),
        80,
        24,
    ));
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 860.0),
        Env {
            system_dark: true,
            scale: 1.5,
        },
    );
    runtime.frame(0.0);
    runtime.window_focus(false);
    runtime.frame(0.1);
    let tab = runtime.state.terminal.as_ref().unwrap();
    assert!(!tab.focused());
    assert_eq!(tab.scale(), 1.5);
}

/// 2026-10-08T08:00:00Z.
const NOW: f64 = 1_791_446_400_000.0;

fn snapshot(profile: &str, name: &str) -> Value {
    json!({"machine": {"installation": format!("inst-{name}"), "profile": profile, "name": name},
        "message": {"_tag": "Snapshot", "installation": format!("inst-{name}"), "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "tasks": [], "seq": 1}})
}

fn window(used: f64, reached: bool) -> Value {
    json!({"kind": "session", "label": "Session", "model": null, "usedPercent": used,
        "resetsAt": "2026-10-08T10:10:00Z", "reached": reached})
}

fn reading(subscription: &str, account: &str, label: &str, windows: Vec<Value>, at: &str) -> Value {
    json!({"subscription": subscription, "account": account, "accountLabel": label,
        "plan": "max", "windows": windows, "at": at, "source": "claude-usage", "problem": null})
}

fn usage_of(name: &str, readings: Vec<Value>) -> Value {
    json!({"profile": format!("p-{name}"), "name": name, "readings": readings, "problem": null})
}

/// An app on a fake core, at `NOW`, whose `machines` are live.
fn live_app(harness: &Harness<App>, machines: &[&str]) -> App {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.board.clock = Some(NOW);
    app.board.utc_offset = Some(0);
    for name in machines {
        app.apply(serde_json::from_value(snapshot(&format!("p-{name}"), name)).unwrap());
    }
    app
}

fn texts(runtime: &Runtime<App>, prefix: &str) -> Vec<String> {
    runtime
        .elements()
        .iter()
        .filter(|e| e.key.as_deref().is_some_and(|k| k.starts_with(prefix)))
        .filter_map(|e| e.text.clone())
        .collect()
}

#[test]
fn the_toolbar_says_each_accounts_busiest_window_and_opens_the_usage_page() {
    let harness = Harness::<App>::new();
    let mut app = live_app(&harness, &["mk-pc", "vm-mk"]);
    app.ask_usage_when_due(NOW);
    assert_eq!(harness.fake.asked_of("usage").len(), 1);
    harness.fake.answer(
        "usage",
        Ok(json!([
            usage_of(
                "mk-pc",
                vec![reading(
                    "claude",
                    "org:acct",
                    "me@example.com",
                    vec![window(40.0, false)],
                    "2026-10-08T07:57:00Z"
                )]
            ),
            usage_of(
                "vm-mk",
                vec![
                    reading(
                        "claude",
                        "org:acct",
                        "me@example.com",
                        vec![window(72.0, false)],
                        "2026-10-08T07:59:00Z"
                    ),
                    reading(
                        "chatgpt",
                        "c-1",
                        "me@example.com",
                        vec![window(20.0, true)],
                        "2026-10-08T07:59:00Z"
                    ),
                ]
            ),
        ])),
    );
    harness.settle(&mut app);
    let mut runtime = runtime(app);
    assert_eq!(texts(&runtime, "toolbar-usage-"), ["Claude 72%", "ChatGPT out"]);
    let usage = runtime
        .elements()
        .iter()
        .find(|e| e.key.as_deref() == Some("usage"))
        .map(|e| e.label.clone())
        .expect("the toolbar's Usage");
    assert_eq!(usage.as_deref(), Some("Usage: Claude 72%, ChatGPT out"));
    tap(&mut runtime, "usage", 100.0);
    assert_eq!(runtime.state.nav.page, Page::Usage);
}

#[test]
fn a_machine_that_is_not_live_takes_its_reading_out_of_the_toolbar() {
    let harness = Harness::<App>::new();
    let mut app = live_app(&harness, &["mk-pc"]);
    app.board.clock = Some(NOW);
    app.pages.usage.machines = serde_json::from_value(json!([
        usage_of(
            "mk-pc",
            vec![reading(
                "claude",
                "org:acct",
                "me@example.com",
                vec![window(31.0, false)],
                "2026-10-08T07:57:00Z"
            )]
        ),
        usage_of(
            "gone",
            vec![reading(
                "claude",
                "org:acct",
                "me@example.com",
                vec![window(95.0, false)],
                "2026-10-08T07:59:00Z"
            )]
        ),
    ]))
    .unwrap();
    let entries = app.usage_entries();
    let said: Vec<(&str, Level)> = entries.iter().map(|e| (e.text.as_str(), e.level)).collect();
    assert_eq!(said, [("Claude 31%", Level::Ok)]);
    assert!(
        entries[0].title.contains("read on mk-pc"),
        "{}",
        entries[0].title
    );
}

#[test]
fn usage_is_asked_when_desktop_opens_when_a_machine_comes_live_and_then_each_minute() {
    let harness = Harness::<App>::new();
    let mut app = live_app(&harness, &[]);
    app.ask_usage_when_due(NOW);
    app.ask_usage_when_due(NOW + 1_000.0);
    assert_eq!(harness.fake.asked_of("usage").len(), 1, "once at open");
    app.apply(serde_json::from_value(snapshot("p-mk-pc", "mk-pc")).unwrap());
    app.ask_usage_when_due(NOW + 2_000.0);
    assert_eq!(harness.fake.asked_of("usage").len(), 2, "again for mk-pc");
    app.ask_usage_when_due(NOW + 61_000.0);
    assert_eq!(
        harness.fake.asked_of("usage").len(),
        2,
        "not before the minute"
    );
    app.ask_usage_when_due(NOW + 62_000.0);
    assert_eq!(harness.fake.asked_of("usage").len(), 3);
}

#[test]
fn the_board_row_counts_what_needs_you() {
    let harness = Harness::<App>::new();
    let mut app = live_app(&harness, &[]);
    let mut needs = snapshot("p-mk-pc", "mk-pc");
    needs["message"]["tasks"] = json!([{
        "id": "t1", "name": "Ask", "project": "content", "state": "blocked", "steps": [],
        "sentence": "", "age": "5m", "drift": null, "held": null, "heldBy": null,
        "decision": null, "agents": [], "children": [], "mr": null, "branch": null,
        "disposition": null, "landed": false, "ended": null, "mrState": null,
        "planReady": false, "offer": null, "run": "r-1", "runs": ["r-1"], "at": NOW,
    }]);
    app.apply(serde_json::from_value(needs).unwrap());
    let runtime = runtime(app);
    let tree = runtime.accessibility_json();
    let board = keyed(&tree, Page::Board.key()).expect("the Board row");
    assert_eq!(board["description"], "1", "{board:#}");
}

fn keyed<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    if node["key"] == key {
        return Some(node);
    }
    node["children"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|child| keyed(child, key))
}
