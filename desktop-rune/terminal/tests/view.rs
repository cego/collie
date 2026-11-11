//! The terminal as Rune builds it from a recorded stream, read through its accessibility tree,
//! without a window.

use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::view::{Link, Tab, terminal};
use rune::{Cx, El, Env, Runtime};
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/terminal");

struct Shown {
    tab: Tab,
}

fn tab_of(shown: &mut Shown) -> Option<&mut Tab> {
    Some(&mut shown.tab)
}

fn view(shown: &Shown, _: &mut Cx<Shown>) -> El {
    terminal(&shown.tab, tab_of)
}

fn played(name: &str) -> Shown {
    let mut tab = Tab::new(None, "vm-mk".into(), 100, 30);
    let recorded = std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson")).unwrap();
    for line in recorded.lines() {
        tab.shown(serde_json::from_str::<TerminalEvent>(line).unwrap());
    }
    Shown { tab }
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

fn named(tree: &Value, key: &str) -> String {
    within(tree)
        .into_iter()
        .find(|node| node["key"] == key)
        .unwrap_or_else(|| panic!("no {key}"))["name"]
        .as_str()
        .unwrap()
        .trim_end()
        .to_string()
}

#[test]
fn a_core_attach_is_drawn_row_by_row_with_its_place_and_its_cursor() {
    let mut runtime = Runtime::new(
        played("core-attach"),
        view,
        (1000.0, 640.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    let tree = runtime.accessibility_json();
    assert_eq!(
        runtime.state.tab.place().as_deref(),
        Some("vm-mk › recording")
    );
    assert_eq!(
        named(&tree, "row-1"),
        "journald.conf  logind.conf  network  networkd.conf  pstore.conf  resolved.conf  sleep.conf  system"
    );
    assert_eq!(
        named(&tree, "row-3"),
        "mk@vm-mk:~/work/gitte2/gitlab.cego.dk$"
    );
    assert_eq!(
        named(&tree, "terminal-grid"),
        "Terminal, cursor at row 4, column 40"
    );
}

#[test]
fn a_pane_the_core_cannot_open_says_why_in_its_own_words() {
    use collie_desktop_protocol::client::RpcError;
    use collie_desktop_protocol::generated::{ActionFailed, ActionFailedTag};
    let mut tab = Tab::new(None, "vm-mk".into(), 100, 30);
    tab.failed(RpcError::Failed(ActionFailed {
        tag: ActionFailedTag::ActionFailed,
        reason: "that Machine is not connected".into(),
        request: None,
        step: None,
        refused: None,
    }));
    assert_eq!(
        tab.link(),
        Link::Failed("that Machine is not connected".into())
    );
}
