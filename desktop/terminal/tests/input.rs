//! `desktop/test/terminal-input.test.ts`, case for case, against the Rust mapping.

use collie_desktop_protocol::generated::{At, Command, TerminalMouseAction};
use collie_desktop_terminal::input::{
    Held, Key, KeyAction, Link, Pointer, Screen, is_mouse_report, key_action, links_in, mouse_of,
    pane_line, pane_where, scroll_of,
};
use serde_json::{Value, json};

/// 100 columns by 20 rows, each cell 8 by 16 pixels, drawn at (10, 50).
const SCREEN: Screen = Screen {
    left: 10.0,
    top: 50.0,
    width: 800.0,
    height: 320.0,
    cols: 100,
    rows: 20,
};

fn at(x: f64, y: f64) -> Pointer {
    Pointer {
        x,
        y,
        held: Held::default(),
    }
}

fn holding(x: f64, y: f64, held: Held) -> Pointer {
    Pointer { x, y, held }
}

fn key(pressed: &str, ctrl: bool, meta: bool, shift: bool) -> Key {
    Key {
        key: pressed.into(),
        ctrl,
        meta,
        shift,
    }
}

fn wire(command: Option<Command>) -> Value {
    serde_json::to_value(command).unwrap()
}

#[test]
fn the_wheel_scrolls_the_panes_own_history_at_the_cell_under_the_pointer() {
    assert_eq!(
        wire(scroll_of(
            -120.0,
            &at(10.0 + 8.0 * 4.0 + 1.0, 50.0 + 16.0 * 2.0 + 1.0),
            &SCREEN
        )),
        json!({"type": "terminal.scroll", "direction": "up", "lines": 3, "column": 4, "row": 2, "modifiers": 0})
    );
    let shift = Held {
        shift: true,
        ..Held::default()
    };
    assert_eq!(
        wire(scroll_of(5.0, &holding(0.0, 0.0, shift), &SCREEN)),
        json!({"type": "terminal.scroll", "direction": "down", "lines": 1, "column": 0, "row": 0, "modifiers": 1})
    );
    assert_eq!(scroll_of(0.0, &at(20.0, 60.0), &SCREEN), None);
}

#[test]
fn a_click_reaches_the_pane_at_its_cell_with_herdrs_modifier_bits_and_off_the_edge_is_the_edge() {
    let ctrl_alt = Held {
        ctrl: true,
        alt: true,
        ..Held::default()
    };
    assert_eq!(
        wire(mouse_of(
            TerminalMouseAction::Down,
            0,
            &holding(10.0 + 8.0 * 99.0 + 7.0, 50.0 + 16.0 * 19.0, ctrl_alt),
            &SCREEN
        )),
        json!({"type": "terminal.mouse", "action": "down", "button": "left", "column": 99, "row": 19, "modifiers": 6})
    );
    let up = wire(mouse_of(
        TerminalMouseAction::Up,
        2,
        &at(2000.0, 2000.0),
        &SCREEN,
    ));
    assert_eq!(
        (&up["button"], &up["column"], &up["row"]),
        (&json!("right"), &json!(99), &json!(19))
    );
    let drag = wire(mouse_of(
        TerminalMouseAction::Drag,
        1,
        &at(-5.0, -5.0),
        &SCREEN,
    ));
    assert_eq!(
        (&drag["button"], &drag["column"], &drag["row"]),
        (&json!("middle"), &json!(0), &json!(0))
    );
    assert_eq!(
        mouse_of(TerminalMouseAction::Down, 3, &at(20.0, 60.0), &SCREEN),
        None
    );
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
