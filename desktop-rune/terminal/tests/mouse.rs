//! What the human does in a pane's terminal, as it reaches the core: mouse reports for every
//! button, selection and copy, paste, focus reports, links and the wheel. Against a fake core.

use base64::Engine;
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::generated::{TerminalEvent, TerminalPayload};
use collie_desktop_terminal::config::Look;
use collie_desktop_terminal::pane::Pane;
use collie_desktop_terminal::view::{Button, Keyed, Mouse, Tab};
use rune::{Key, KeyEvent, Mods, Phase, WheelEvent};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::thread::JoinHandle;

/// A core that answers each send and link, and hands back every request once the shell
/// interrupts the stream.
fn core() -> (Client, JoinHandle<Vec<Value>>) {
    let (shell_reads, core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    let core = std::thread::spawn(move || {
        let mut out = core_writes;
        let mut heard = Vec::new();
        for line in BufReader::new(core_reads).lines() {
            let frame: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if frame["tag"] == "terminalSend" || frame["tag"] == "openLink" {
                let exit = json!({"_tag": "Exit", "requestId": frame["id"], "exit": {"_tag": "Success", "value": null}});
                writeln!(out, "{exit}").unwrap();
            }
            let done = frame["_tag"] == "Interrupt";
            heard.push(frame);
            if done {
                break;
            }
        }
        heard
    });
    (
        Client::new(BufReader::new(shell_reads), shell_writes).unwrap(),
        core,
    )
}

struct Session {
    tab: Tab,
    core: JoinHandle<Vec<Value>>,
    _frames: Box<dyn std::any::Any>,
}

/// A 20 by 5 terminal on core's raw stream (or a herdr pane), drawn at scale 1, with `bytes`
/// already shown.
fn session(on_core: bool, bytes: &[u8]) -> Session {
    let (client, core) = core();
    let (pane, frames) = Pane::open(
        &client,
        TerminalPayload {
            installation: "inst-local".into(),
            run_id: "run-1".into(),
            agent: None,
            cols: 20,
            rows: 5,
        },
    );
    let mut tab = Tab::with_look(Some(pane), "vm-mk".into(), 20, 5, Look::default());
    tab.set_scale(1.0);
    let core_at = if on_core { json!("s1") } else { Value::Null };
    tab.shown(
        serde_json::from_value::<TerminalEvent>(json!({"_tag": "Opened", "at": {"session": null, "workspace": "w", "tab": null, "pane": "p1", "core": core_at}}))
            .unwrap(),
    );
    show(&mut tab, bytes);
    Session {
        tab,
        core,
        _frames: Box::new(frames),
    }
}

fn show(tab: &mut Tab, bytes: &[u8]) {
    let bytes = base64::engine::general_purpose::STANDARD.encode(bytes);
    tab.shown(serde_json::from_value(json!({"_tag": "Frame", "bytes": bytes})).unwrap());
}

/// What went to the core after the opening resize: inputs as their text, other commands and
/// links as they were sent.
fn sent(session: Session) -> Vec<Value> {
    session.tab.leave();
    let heard = session.core.join().unwrap();
    heard
        .into_iter()
        .filter_map(|frame| match frame["tag"].as_str() {
            Some("terminalSend") => {
                let command = &frame["payload"]["command"];
                match command["type"].as_str() {
                    Some("terminal.resize") => None,
                    Some("terminal.input") => Some(command["text"].clone()),
                    _ => Some(command.clone()),
                }
            }
            Some("openLink") => Some(json!({"openLink": frame["payload"]["url"]})),
            _ => None,
        })
        .collect()
}

/// The middle of cell (`x`, `y`), in the grid's points: 2 pt of padding and 10 by 21 cells.
fn at(x: u16, y: u16) -> (f32, f32) {
    (
        2.0 + 10.0 * f32::from(x) + 5.0,
        2.0 + 21.0 * f32::from(y) + 10.0,
    )
}

fn mouse(phase: Phase, button: Button, (x, y): (f32, f32), clicks: u32, mods: Mods) -> Mouse {
    Mouse {
        phase,
        button,
        x,
        y,
        clicks,
        mods,
    }
}

fn click(tab: &mut Tab, button: Button, cell: (u16, u16), clicks: u32) {
    let point = at(cell.0, cell.1);
    tab.pointer(mouse(Phase::Down, button, point, clicks, Mods::default()));
    tab.pointer(mouse(Phase::Up, button, point, clicks, Mods::default()));
}

fn shift() -> Mods {
    Mods {
        shift: true,
        ..Mods::default()
    }
}

#[test]
fn every_mouse_button_reaches_a_program_that_tracks_the_mouse_as_sgr_reports() {
    let mut s = session(true, b"\x1b[?1000h\x1b[?1006h");
    click(&mut s.tab, Button::Left, (2, 1), 1);
    click(&mut s.tab, Button::Middle, (3, 1), 1);
    let (x, y) = at(4, 2);
    s.tab.secondary(x, y, Mods::default());
    click(&mut s.tab, Button::Back, (0, 0), 1);
    click(&mut s.tab, Button::Forward, (0, 0), 1);
    assert_eq!(
        sent(s),
        [
            "\x1b[<0;3;2M",
            "\x1b[<0;3;2m",
            "\x1b[<1;4;2M",
            "\x1b[<1;4;2m",
            "\x1b[<2;5;3M",
            "\x1b[<2;5;3m",
            "\x1b[<128;1;1M",
            "\x1b[<128;1;1m",
            "\x1b[<129;1;1M",
            "\x1b[<129;1;1m",
        ]
    );
}

#[test]
fn every_mouse_button_reaches_a_herdr_pane_and_the_right_one_as_a_press_and_release() {
    let mut s = session(false, b"");
    click(&mut s.tab, Button::Middle, (3, 1), 1);
    let (x, y) = at(4, 2);
    s.tab.secondary(x, y, Mods::default());
    let mice: Vec<(String, String, i64, i64)> = sent(s)
        .into_iter()
        .map(|m| {
            (
                m["action"].as_str().unwrap().into(),
                m["button"].as_str().unwrap().into(),
                m["column"].as_i64().unwrap(),
                m["row"].as_i64().unwrap(),
            )
        })
        .collect();
    let named = |a: &str, b: &str, c, r| (a.to_string(), b.to_string(), c, r);
    assert_eq!(
        mice,
        [
            named("down", "middle", 3, 1),
            named("up", "middle", 3, 1),
            named("down", "right", 4, 2),
            named("up", "right", 4, 2),
        ]
    );
}

#[test]
fn shift_drags_a_selection_past_a_program_that_tracks_the_mouse_and_ctrl_shift_c_copies_it() {
    let mut s = session(true, b"\x1b[?1000h\x1b[?1006hhello world\r\nsecond line");
    let shifted = shift();
    s.tab
        .pointer(mouse(Phase::Down, Button::Left, at(6, 0), 1, shifted));
    s.tab
        .pointer(mouse(Phase::Move, Button::Left, at(8, 0), 1, shifted));
    s.tab
        .pointer(mouse(Phase::Move, Button::Left, at(5, 1), 1, shifted));
    s.tab
        .pointer(mouse(Phase::Up, Button::Left, at(5, 1), 1, shifted));
    assert_eq!(s.tab.selection_text().as_deref(), Some("world\nsecond"));
    let copy = KeyEvent {
        key: Key::Command('C'),
        mods: Mods {
            ctrl: true,
            shift: true,
            ..Mods::default()
        },
    };
    assert_eq!(s.tab.key(&copy), Keyed::Copy("world\nsecond".into()));
    assert_eq!(sent(s), Vec::<Value>::new(), "nothing reached the program");
}

#[test]
fn a_double_click_selects_a_word_a_triple_click_its_line_and_a_click_clears_it() {
    let mut s = session(true, b"cargo test --all\r\nnext");
    click(&mut s.tab, Button::Left, (7, 0), 2);
    assert_eq!(s.tab.selection_text().as_deref(), Some("test"));
    click(&mut s.tab, Button::Left, (7, 0), 3);
    assert_eq!(s.tab.selection_text().as_deref(), Some("cargo test --all"));
    click(&mut s.tab, Button::Left, (7, 0), 1);
    assert_eq!(s.tab.selection_text(), None);
}

#[test]
fn a_paste_is_bracketed_for_a_program_that_asked_and_typing_clears_the_selection() {
    let mut s = session(true, b"word\x1b[?2004h");
    click(&mut s.tab, Button::Left, (1, 0), 2);
    assert_eq!(s.tab.selection_text().as_deref(), Some("word"));
    s.tab.paste("ls\n");
    assert_eq!(s.tab.selection_text(), None);
    assert_eq!(sent(s), ["\x1b[200~ls\n\x1b[201~"]);
}

#[test]
fn a_program_that_asked_is_told_when_the_terminal_loses_and_regains_focus() {
    let mut s = session(true, b"");
    s.tab.focus(false);
    show(&mut s.tab, b"\x1b[?1004h");
    s.tab.focus(true);
    s.tab.focus(false);
    assert!(!s.tab.focused());
    assert_eq!(sent(s), ["\x1b[I", "\x1b[O"]);
}

#[test]
fn a_click_on_a_written_out_or_osc_8_link_opens_it_through_the_core() {
    let mut s = session(
        true,
        b"a https://x.te/b ok\r\n\x1b]8;;https://docs.test/\x1b\\the docs\x1b]8;;\x1b\\ here",
    );
    let (x, y) = at(8, 0);
    s.tab.moved(x, y, Mods::default());
    let hover = s.tab.hover.clone().expect("a link under the pointer");
    assert_eq!((hover.cols, hover.url.as_str()), (2..16, "https://x.te/b"));
    click(&mut s.tab, Button::Left, (8, 0), 1);
    let (x, y) = at(2, 1);
    s.tab.moved(x, y, Mods::default());
    assert_eq!(s.tab.hover.as_ref().map(|h| h.cols.clone()), Some(0..8));
    click(&mut s.tab, Button::Left, (2, 1), 1);
    click(&mut s.tab, Button::Left, (12, 1), 1);
    assert_eq!(
        sent(s),
        [
            json!({"openLink": "https://x.te/b"}),
            json!({"openLink": "https://docs.test/"})
        ]
    );
}

#[test]
fn a_wheel_notch_scrolls_three_lines_of_history_and_a_trackpad_by_its_travel() {
    let lines: String = (1..=30).map(|n| format!("line {n}\r\n")).collect();
    let mut s = session(true, lines.as_bytes());
    assert_eq!(s.tab.frame().line(0), "line 27");
    s.tab.wheel(&WheelEvent::new(0.0, 40.0).at(20.0, 20.0));
    assert_eq!(s.tab.frame().line(0), "line 24");
    s.tab
        .wheel(&WheelEvent::new(0.0, 42.0).at(20.0, 20.0).precise(true));
    assert_eq!(s.tab.frame().line(0), "line 22");
    assert_eq!(sent(s), Vec::<Value>::new());
}

#[test]
fn the_wheel_in_a_full_screen_program_sends_arrows_and_to_a_tracking_one_a_report_a_notch() {
    let mut s = session(true, b"\x1b[?1049h");
    s.tab.wheel(&WheelEvent::new(0.0, 40.0).at(20.0, 20.0));
    show(&mut s.tab, b"\x1b[?1000h\x1b[?1006h");
    s.tab.wheel(&WheelEvent::new(0.0, -40.0).at(7.0, 13.0));
    assert_eq!(sent(s), ["\x1b[A", "\x1b[A", "\x1b[A", "\x1b[<65;1;1M"]);
}
