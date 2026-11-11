//! A Run's Diff tab as Rune builds it, read through the accessibility tree and driven by the
//! pointer, without a window.

use collie_desktop_chat::review::{Anchor, Draft, compose};
use collie_desktop_chat::view::{DiffTab, diff_tab};
use rune::edit::TextEdit;
use rune::{Cx, El, Env, Runtime};
use rune_kit::Kit;
use rune_kit::diff::{DiffMode, LineRange, LineRef, Side, parse};
use serde_json::Value;

fn diff_view(tab: &DiffTab, cx: &mut Cx<DiffTab>) -> El {
    let k = Kit::neutral(cx.system_dark());
    rune_kit::root(diff_tab(tab, |t| t, |t| t, &k), [])
}

fn runtime<S: 'static>(state: S, view: fn(&S, &mut Cx<S>) -> El) -> Runtime<S> {
    let mut runtime = Runtime::new(
        state,
        view,
        (1000.0, 800.0),
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

fn keyed<S>(runtime: &Runtime<S>, key: &str) -> Option<Value> {
    within(&runtime.accessibility_json())
        .into_iter()
        .find(|node| node["key"] == key)
        .cloned()
}

/// Every name said under the node keyed `key`.
fn said<S>(runtime: &Runtime<S>, key: &str) -> String {
    let node = keyed(runtime, key).unwrap_or_else(|| panic!("no {key}"));
    within(&node)
        .iter()
        .filter_map(|n| n["name"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn tap<S>(runtime: &mut Runtime<S>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

const CHANGED: &str = "diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
";

#[test]
fn a_selected_range_becomes_a_draft_and_the_drafts_compose_one_delivery() {
    let mut tab = DiffTab::new(parse(CHANGED));
    tab.state.set_selection(Some(LineRange {
        file: 0,
        start: LineRef::new(Side::New, 2),
        end: LineRef::new(Side::New, 3),
    }));
    tab.comment = TextEdit::new("Keep it lower case.");
    let mut runtime = runtime(tab, diff_view);
    tap(&mut runtime, "add-comment", 100.0);
    assert!(said(&runtime, "draft-1").contains("Keep it lower case."));

    tap(&mut runtime, "compose", 1000.0);
    let delivery = keyed(&runtime, "delivery").expect("the Delivery text");
    let expected = compose(&[Draft {
        id: "1".into(),
        anchor: Anchor::Diff {
            path: "src/a.ts".into(),
            side: Side::New,
            first: 2,
            last: 3,
            lines: vec!["TWO".into(), "three".into()],
        },
        text: "Keep it lower case.".into(),
    }]);
    assert_eq!(delivery["name"], expected.as_str());
}

fn mode(runtime: &mut Runtime<DiffTab>) -> DiffMode {
    let mut mode = DiffMode::default();
    runtime.update(|tab, _| mode = tab.state.mode());
    mode
}

#[test]
fn the_diff_shows_unified_or_split() {
    let mut runtime = runtime(DiffTab::new(parse(CHANGED)), diff_view);
    assert!(keyed(&runtime, "diff").is_some());
    tap(&mut runtime, "segment1", 100.0);
    assert_eq!(mode(&mut runtime), DiffMode::Split);
    tap(&mut runtime, "segment0", 1000.0);
    assert_eq!(mode(&mut runtime), DiffMode::Unified);
}
