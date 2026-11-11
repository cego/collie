//! Review comments on an open Run's Diff and plan, pressed and typed as a person does, with a
//! fake core (ADR-0051): a range is chosen on the line numbers, a box opens under it focused,
//! Enter or Comment saves a draft, every way out closes the box saving nothing, and drafts are
//! edited and removed where they are drawn.

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, view};
use collie_desktop_terminal::view::Tab;
use rune::edit::Modifier;
use rune::{Env, Key, KeyEvent, Runtime};
use serde_json::{Value, json};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

fn keys(runtime: &Runtime<App>) -> Vec<String> {
    runtime
        .elements()
        .into_iter()
        .filter(|e| !e.exiting)
        .filter_map(|e| e.key)
        .collect()
}

fn shown(runtime: &Runtime<App>, key: &str) -> bool {
    keys(runtime).iter().any(|k| k == key)
}

fn rect(runtime: &Runtime<App>, path: &str) -> [f32; 4] {
    runtime
        .elements()
        .into_iter()
        .find(|e| {
            !e.exiting && (e.key.as_deref() == Some(path) || e.path.ends_with(&format!("/{path}")))
        })
        .unwrap_or_else(|| panic!("no {path} in {:?}", keys(runtime)))
        .rect
}

/// The focused element's path, if any.
fn focused(runtime: &Runtime<App>) -> String {
    runtime
        .elements()
        .into_iter()
        .find(|e| e.focused)
        .map(|e| e.path)
        .unwrap_or_default()
}

fn press(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime
        .find(key)
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 30.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 60.0);
}

fn key(runtime: &mut Runtime<App>, key: Key, at: f64) {
    runtime.key(KeyEvent {
        key,
        mods: Default::default(),
    });
    runtime.frame(at);
}

fn typed(runtime: &mut Runtime<App>, said: &str, at: f64) {
    key(runtime, Key::Text(said.into()), at);
}

fn opened(harness: &Harness<App>) -> Runtime<App> {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    app.core = Some(harness.core.clone());
    app.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    let mut runtime = Runtime::new(
        app,
        view,
        (1400.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn settle(runtime: &mut Runtime<App>, harness: &Harness<App>, at: f64) {
    harness.settle(&mut runtime.state);
    runtime.update(|_, _| {});
    runtime.frame(at);
}

fn detail(extra: Value) -> Value {
    let mut base = json!({
        "id": "r1", "dir": "/runs/r1", "title": "Build it", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": []
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    json!({"detail": base, "asOf": null, "bytes": 100})
}

fn patch(path: &str) -> String {
    format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,4 +1,4 @@\n fn a() {{}}\n-old\n+new\n fn b() {{}}\n fn c() {{}}\n"
    )
}

fn answer_patch(harness: &Harness<App>, path: &str) {
    let content = patch(path);
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": format!("diff:{path}"), "encoding": "utf8", "content": content, "size": content.len()})),
    );
}

fn changed(path: &str) -> Value {
    json!({"path": path, "status": "modified", "added": 1, "removed": 1})
}

/// The record open on its Diff, `src/a.rs` read and drawn, the others still being read.
fn on_diff(harness: &Harness<App>, others: &[&str]) -> Runtime<App> {
    let mut runtime = opened(harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    let files: Vec<Value> = std::iter::once("src/a.rs")
        .chain(others.iter().copied())
        .map(changed)
        .collect();
    harness.fake.push(
        "runDetail",
        Ok(detail(json!({
            "diff": {"base": "abc", "live": true, "files": files},
            "agents": [{"operation": "build", "agent": "build-1", "harness": "claude"}]
        }))),
    );
    settle(&mut runtime, harness, 100.0);
    answer_patch(harness, "src/a.rs");
    settle(&mut runtime, harness, 200.0);
    runtime
}

fn selection(runtime: &Runtime<App>) -> Option<(u32, u32)> {
    let range = runtime.state.diff.as_ref()?.state.selection()?;
    let (a, b) = (range.start.line, range.end.line);
    Some((a.min(b), a.max(b)))
}

fn drafts(runtime: &Runtime<App>) -> Vec<String> {
    runtime
        .state
        .record
        .drafts
        .get(&("inst-build".to_string(), "r1".to_string()))
        .map(|d| d.iter().map(|d| d.text.clone()).collect())
        .unwrap_or_default()
}

#[test]
fn a_press_on_a_line_number_selects_it_highlighted_and_opens_a_focused_box_under_it() {
    let harness = Harness::<App>::new();
    let mut runtime = on_diff(&harness, &[]);
    press(&mut runtime, "df0.n2/gutter/nn", 300.0);
    assert_eq!(selection(&runtime), Some((2, 2)));
    let picked = runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("df0.n2"))
        .unwrap();
    let other = runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("df0.c3"))
        .unwrap();
    assert_ne!(picked.fill, other.fill, "the line chosen is highlighted");
    let line = rect(&runtime, "df0.n2");
    let line = [line[0], line[1], line[2], 20.0];
    let composer = rect(&runtime, "diff-composer");
    assert!(
        composer[1] >= line[1] + line[3] - 1.0 && composer[1] <= line[1] + line[3] + 12.0,
        "the box opens right under its line: line {line:?}, box {composer:?}"
    );
    assert!(
        focused(&runtime).contains("diff-comment"),
        "its field has focus: {}",
        focused(&runtime)
    );
}

#[test]
fn a_drag_down_the_numbers_or_a_shift_press_extends_the_range() {
    let harness = Harness::<App>::new();
    let mut runtime = on_diff(&harness, &[]);
    let (x, y) = runtime.find("df0.c1/gutter/nn").unwrap();
    let (_, to) = runtime.find("df0.c4/gutter/nn").unwrap();
    runtime.pointer_move(x, y);
    runtime.frame(300.0);
    runtime.pointer_down(x, y);
    runtime.frame(320.0);
    for step in 1..=8 {
        runtime.pointer_move(x, y + (to - y) * step as f32 / 8.0);
        runtime.frame(320.0 + 16.0 * step as f64);
    }
    runtime.pointer_up(x, to);
    runtime.frame(500.0);
    assert_eq!(selection(&runtime), Some((1, 4)), "a drag");
    assert!(shown(&runtime, "diff-composer"));

    key(&mut runtime, Key::Escape, 550.0);
    press(&mut runtime, "df0.c1/gutter/nn", 600.0);
    runtime.set_modifier_keys(true);
    let shift = |pressed| KeyEvent {
        key: Key::Modifier {
            modifier: Modifier::ShiftLeft,
            pressed,
        },
        mods: rune::edit::Mods {
            shift: pressed,
            ..Default::default()
        },
    };
    runtime.key(shift(true));
    runtime.frame(700.0);
    press(&mut runtime, "df0.c3/gutter/nn", 750.0);
    runtime.key(shift(false));
    runtime.frame(850.0);
    assert_eq!(selection(&runtime), Some((1, 3)), "a Shift-press");
}

#[test]
fn enter_or_comment_saves_a_draft_shown_under_its_line_and_the_box_closes() {
    let harness = Harness::<App>::new();
    let mut runtime = on_diff(&harness, &[]);
    press(&mut runtime, "df0.n2/gutter/nn", 300.0);
    typed(&mut runtime, "Name this better", 350.0);
    key(&mut runtime, Key::Enter, 400.0);
    assert_eq!(drafts(&runtime), ["Name this better"]);
    assert!(!shown(&runtime, "diff-composer"), "the box closes");
    assert!(shown(&runtime, "note-d1"), "drawn under its line");
    assert_eq!(selection(&runtime), None);

    press(&mut runtime, "df0.c4/gutter/nn", 500.0);
    typed(&mut runtime, "And this", 550.0);
    press(&mut runtime, "add-comment", 600.0);
    assert_eq!(drafts(&runtime), ["Name this better", "And this"]);
    assert!(!shown(&runtime, "diff-composer"));
}

/// The box open on line 2, `words` typed into it.
fn writing(harness: &Harness<App>, others: &[&str], words: &str) -> Runtime<App> {
    let mut runtime = on_diff(harness, others);
    press(&mut runtime, "df0.n2/gutter/nn", 300.0);
    assert!(shown(&runtime, "diff-composer"));
    if !words.is_empty() {
        typed(&mut runtime, words, 350.0);
    }
    runtime
}

fn closed_saving_nothing(runtime: &Runtime<App>, how: &str) {
    assert!(
        !shown(runtime, "diff-composer"),
        "{how} closes the box: {:?}",
        keys(runtime)
    );
    assert!(drafts(runtime).is_empty(), "{how} saves nothing");
}

#[test]
fn escape_cancel_a_press_elsewhere_and_leaving_the_tab_or_file_each_close_the_box() {
    let harness = Harness::<App>::new();
    let mut runtime = writing(&harness, &[], "half a thought");
    key(&mut runtime, Key::Escape, 400.0);
    closed_saving_nothing(&runtime, "Escape");
    assert_eq!(selection(&runtime), None);

    let mut runtime = writing(&harness, &[], "half a thought");
    press(&mut runtime, "cancel-comment", 400.0);
    closed_saving_nothing(&runtime, "Cancel");

    let mut runtime = writing(&harness, &[], "");
    press(&mut runtime, "df0.c4/code", 400.0);
    closed_saving_nothing(&runtime, "a press elsewhere in the diff");

    let mut runtime = writing(&harness, &[], "half a thought");
    press(&mut runtime, "tab-facts", 400.0);
    press(&mut runtime, "tab-diff", 500.0);
    closed_saving_nothing(&runtime, "leaving the tab");

    let mut runtime = writing(&harness, &[], "half a thought");
    press(&mut runtime, "tree-file-src/a.rs", 400.0);
    closed_saving_nothing(&runtime, "going to a file");
}

#[test]
fn a_press_elsewhere_keeps_a_box_with_words_typed_in_it() {
    let harness = Harness::<App>::new();
    let mut runtime = writing(&harness, &[], "half a thought");
    press(&mut runtime, "df0.c4/code", 400.0);
    assert!(shown(&runtime, "diff-composer"), "the words are not lost");
}

#[test]
fn a_patch_read_while_choosing_lines_keeps_them_and_the_box() {
    let harness = Harness::<App>::new();
    let mut runtime = writing(&harness, &["src/b.rs"], "half");
    answer_patch(&harness, "src/b.rs");
    settle(&mut runtime, &harness, 500.0);
    assert_eq!(selection(&runtime), Some((2, 2)));
    assert!(shown(&runtime, "diff-composer"));
}

#[test]
fn a_draft_under_its_line_is_edited_and_removed_there() {
    let harness = Harness::<App>::new();
    let mut runtime = writing(&harness, &[], "First");
    key(&mut runtime, Key::Enter, 400.0);
    press(&mut runtime, "note-edit-d1", 500.0);
    assert!(
        focused(&runtime).contains("draft-text-d1"),
        "its words have focus: {}",
        focused(&runtime)
    );
    typed(&mut runtime, " and more", 550.0);
    press(&mut runtime, "draft-save-d1", 600.0);
    assert_eq!(drafts(&runtime), ["First and more"]);

    press(&mut runtime, "note-edit-d1", 700.0);
    typed(&mut runtime, "!!", 750.0);
    key(&mut runtime, Key::Escape, 800.0);
    assert_eq!(drafts(&runtime), ["First and more"], "Escape keeps it as it was");
    assert!(!shown(&runtime, "draft-text-d1"));

    press(&mut runtime, "note-remove-d1", 900.0);
    assert!(drafts(&runtime).is_empty());
    assert!(!shown(&runtime, "note-d1"));
}

#[test]
fn sent_drafts_go_once_the_core_takes_them() {
    let harness = Harness::<App>::new();
    let mut runtime = writing(&harness, &[], "First");
    key(&mut runtime, Key::Enter, 400.0);
    press(&mut runtime, "send-review", 500.0);
    assert_eq!(drafts(&runtime), ["First"], "kept until taken");
    harness.fake.answer("act", Ok(json!("Delivered to build-1.")));
    settle(&mut runtime, &harness, 600.0);
    assert!(drafts(&runtime).is_empty());
    assert!(!shown(&runtime, "note-d1"));
}

const SPEC: &str = "# Spec\n\nBuild the thing well and quickly.\n";

fn on_plan(harness: &Harness<App>) -> Runtime<App> {
    let mut runtime = opened(harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("plan"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(detail(json!({
            "plan": {"spec": {"_tag": "Text", "text": SPEC, "truncated": false}, "tickets": []},
            "agents": [{"operation": "plan", "agent": "planner-1", "harness": "claude"}]
        }))),
    );
    settle(&mut runtime, harness, 100.0);
    runtime
}

/// Drags across the plan's text to select a span, as a person does.
fn select_plan(runtime: &mut Runtime<App>, at: f64) {
    let [x, y, w, h] = rect(runtime, "plan-text");
    let (from, to) = ((x + 4.0, y + h - 8.0), (x + w.min(300.0), y + h - 8.0));
    runtime.pointer_move(from.0, from.1);
    runtime.frame(at);
    runtime.pointer_down(from.0, from.1);
    runtime.frame(at + 20.0);
    for step in 1..=6 {
        let f = step as f32 / 6.0;
        runtime.pointer_move(from.0 + (to.0 - from.0) * f, to.1);
        runtime.frame(at + 20.0 + 16.0 * step as f64);
    }
    runtime.pointer_up(to.0, to.1);
    runtime.frame(at + 200.0);
}

#[test]
fn a_span_selected_in_the_plan_opens_a_focused_box_that_enter_saves() {
    let harness = Harness::<App>::new();
    let mut runtime = on_plan(&harness);
    select_plan(&mut runtime, 200.0);
    assert!(shown(&runtime, "plan-composer"), "{:?}", keys(&runtime));
    assert!(
        focused(&runtime).contains("plan-comment"),
        "its field has focus: {}",
        focused(&runtime)
    );
    typed(&mut runtime, "Say how", 500.0);
    key(&mut runtime, Key::Enter, 550.0);
    assert_eq!(drafts(&runtime), ["Say how"]);
    assert!(!shown(&runtime, "plan-composer"));
}

#[test]
fn the_plans_box_closes_on_escape_cancel_and_leaving_the_tab_saving_nothing() {
    let harness = Harness::<App>::new();
    for (how, at) in [("Escape", 0), ("Cancel", 1), ("leaving the tab", 2)] {
        let mut runtime = on_plan(&harness);
        select_plan(&mut runtime, 200.0);
        typed(&mut runtime, "half", 500.0);
        match at {
            0 => key(&mut runtime, Key::Escape, 600.0),
            1 => press(&mut runtime, "cancel-plan-comment", 600.0),
            _ => {
                press(&mut runtime, "tab-facts", 600.0);
                press(&mut runtime, "tab-plan", 700.0);
            }
        }
        assert!(!shown(&runtime, "plan-composer"), "{how} closes the box");
        assert!(drafts(&runtime).is_empty(), "{how} saves nothing");
    }
}
