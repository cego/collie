//! The window's frame and the view's calls to the core, without a window or a core.

use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
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
