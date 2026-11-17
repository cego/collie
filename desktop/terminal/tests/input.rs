//! `desktop/test/terminal-input.test.ts`, case for case, against the Rust mapping.

use collie_desktop_protocol::generated::At;
use collie_desktop_terminal::input::{
    Key, KeyAction, Link, is_mouse_report, key_action, links_in, pane_line, pane_where,
};

fn key(pressed: &str, ctrl: bool, meta: bool, shift: bool) -> Key {
    Key {
        key: pressed.into(),
        ctrl,
        meta,
        shift,
    }
}

#[test]
fn xterm_jss_own_mouse_reports_are_not_typed_into_the_pane_and_everything_else_is() {
    assert!(is_mouse_report("\u{1b}[<0;5;3M"));
    assert!(is_mouse_report("\u{1b}[<0;5;3m"));
    assert!(is_mouse_report("\u{1b}[M !!"));
    assert!(!is_mouse_report("\u{1b}"));
    assert!(!is_mouse_report("\u{1b}[A"));
    assert!(!is_mouse_report("\u{1b}[200~one\rtwo\u{1b}[201~"));
}

#[test]
fn ctrl_c_interrupts_the_pane_and_copies_while_there_is_a_selection() {
    assert_eq!(
        key_action(&key("c", true, false, false), false),
        KeyAction::Pane
    );
    assert_eq!(
        key_action(&key("c", true, false, false), true),
        KeyAction::Copy
    );
    assert_eq!(
        key_action(&key("C", true, false, true), false),
        KeyAction::Copy
    );
    assert_eq!(
        key_action(&key("c", false, true, false), true),
        KeyAction::Copy
    );
    assert_eq!(
        key_action(&key("Escape", false, false, false), true),
        KeyAction::Pane
    );
    assert_eq!(
        key_action(&key("c", false, false, false), true),
        KeyAction::Pane
    );
}

#[test]
fn the_platforms_paste_is_the_shells_and_a_bare_ctrl_v_is_the_panes() {
    assert_eq!(
        key_action(&key("V", true, false, true), false),
        KeyAction::Paste
    );
    assert_eq!(
        key_action(&key("v", false, true, false), false),
        KeyAction::Paste
    );
    assert_eq!(
        key_action(&key("v", true, false, false), false),
        KeyAction::Pane
    );
}

#[test]
fn a_lines_web_links_are_found_by_the_columns_they_span() {
    assert_eq!(
        links_in("see https://gitlab.example/mr/1 now, or http://x.example."),
        vec![
            Link {
                url: "https://gitlab.example/mr/1".into(),
                start: 5,
                end: 31
            },
            Link {
                url: "http://x.example.".into(),
                start: 41,
                end: 57
            },
        ]
    );
    assert_eq!(links_in("no link, file:///etc/passwd"), vec![]);
}

fn pane(session: Option<&str>, workspace: &str, tab: Option<&str>) -> At {
    At {
        session: session.map(Into::into),
        workspace: workspace.into(),
        tab: tab.map(Into::into),
        pane: None,
        agent: None,
        core: None,
    }
}

#[test]
fn a_pane_is_said_where_it_is_as_the_card_says_it() {
    assert_eq!(
        pane_where("vm-mk", &pane(None, "workspace 3", Some("tab 2"))),
        "vm-mk › workspace 3 › tab 2"
    );
    assert_eq!(
        pane_where("vm-mk", &pane(Some("work"), "workspace 3", None)),
        "vm-mk › workspace 3"
    );
}

#[test]
fn a_pane_on_its_cards_line_is_its_tab_then_its_workspace() {
    assert_eq!(
        pane_line(&pane(None, "workspace 3", Some("tab 2"))),
        "tab 2 · workspace 3"
    );
    assert_eq!(pane_line(&pane(None, "workspace 3", None)), "workspace 3");
}

#[test]
fn ctrl_or_cmd_with_shift_and_f_is_focus_not_the_panes_and_plain_ctrl_f_is_the_panes() {
    assert_eq!(
        key_action(&key("F", true, false, true), false),
        KeyAction::Focus
    );
    assert_eq!(
        key_action(&key("F", false, true, true), false),
        KeyAction::Focus
    );
    assert_eq!(
        key_action(&key("f", true, false, false), false),
        KeyAction::Pane
    );
    assert_eq!(
        key_action(&key("F", false, false, true), false),
        KeyAction::Pane
    );
}
