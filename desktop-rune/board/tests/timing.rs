//! Desktop's marks taken by the Rune app: `desktopTiming`'s cases from
//! `test/desktop-record.test.ts`, then the marks the board reads off its drawn frames.

use collie_desktop_board::timing::{Mark, Timing};
use collie_desktop_board::{Board, frame_drawn, view};
use collie_desktop_protocol::generated::AguiEvent;
use collie_desktop_terminal::view::Tab;
use rune::{Env, Runtime};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

fn mark(name: &'static str, at: f64, card: &str) -> Mark {
    Mark {
        name,
        at,
        card: card.into(),
    }
}

#[test]
fn marks_the_board_usable_once_at_its_first_draw() {
    let mut timing = Timing::default();
    timing.board_usable(500.0);
    timing.board_usable(900.0);
    assert_eq!(timing.marks, [mark("board-usable", 500.0, "")]);
}

#[test]
fn marks_a_draw_only_after_a_key_under_the_keys_pane_and_no_other_key_until_it_is_drawn() {
    let mut timing = Timing::default();
    timing.echoed(590.0);
    timing.key("run-1", 600.0);
    timing.key("run-1", 605.0);
    timing.echoed(612.0);
    timing.echoed(630.0);
    timing.key("run-2", 700.0);
    timing.echoed(711.0);
    assert_eq!(
        timing.marks,
        [
            mark("terminal-key", 600.0, "run-1"),
            mark("terminal-drawn", 612.0, "run-1"),
            mark("terminal-key", 700.0, "run-2"),
            mark("terminal-drawn", 711.0, "run-2"),
        ]
    );
}

#[test]
fn marks_a_chunks_draw_under_its_message_once() {
    let mut timing = Timing::default();
    timing.chunk("m1", 700.0);
    timing.chunk("m1", 703.0);
    timing.chat_drawn(709.0);
    timing.chat_drawn(725.0);
    assert_eq!(
        timing.marks,
        [
            mark("chat-chunk", 700.0, "m1"),
            mark("chat-drawn", 709.0, "m1")
        ]
    );
}

#[test]
fn marks_each_frame_of_a_scroll_under_one_name_until_it_settles_and_the_next_under_another() {
    let mut timing = Timing::default();
    assert!(!timing.frame(790.0));
    assert!(timing.scrolled("log", 800.0));
    assert!(timing.frame(805.0));
    assert!(!timing.scrolled("log", 815.0));
    assert!(timing.frame(822.0));
    assert!(!timing.frame(1200.0));
    assert!(timing.scrolled("diff", 2000.0));
    assert!(timing.frame(2010.0));
    assert_eq!(
        timing.marks,
        [
            mark("frame", 805.0, "log:1"),
            mark("frame", 822.0, "log:1"),
            mark("frame", 2010.0, "diff:2"),
        ]
    );
}

fn runtime() -> Runtime<Board> {
    let mut board = Board::default();
    for line in FLOCK.lines() {
        board.apply(serde_json::from_str(line).unwrap());
    }
    board.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    board.load_diff = Some(Box::new(|_, _, _| {}));
    let mut runtime = Runtime::new(
        board,
        view,
        (1280.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn tap(runtime: &mut Runtime<Board>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

#[test]
fn the_first_frame_with_cards_marks_the_board_usable() {
    let runtime = runtime();
    assert_eq!(
        frame_drawn(&runtime, 500.0),
        [mark("board-usable", 500.0, "")]
    );
    assert_eq!(frame_drawn(&runtime, 520.0), []);
}

#[test]
fn a_key_sent_to_the_pane_and_the_frame_after_its_output_mark_the_echo() {
    let mut runtime = runtime();
    frame_drawn(&runtime, 10.0);
    tap(&mut runtime, "card-b2", 100.0);
    runtime.update(|board, _| board.terminal.as_mut().unwrap().keyed_at = Some(600.0));
    assert_eq!(
        frame_drawn(&runtime, 605.0),
        [mark("terminal-key", 600.0, "r1")]
    );
    runtime.update(|board, _| board.terminal.as_mut().unwrap().shown_at = Some(610.0));
    assert_eq!(
        frame_drawn(&runtime, 612.0),
        [mark("terminal-drawn", 612.0, "r1")]
    );
}

fn event() -> AguiEvent {
    let line = include_str!("../../fixtures/chat/say-text.ndjson")
        .lines()
        .nth(3)
        .unwrap();
    let line: serde_json::Value = serde_json::from_str(line).unwrap();
    serde_json::from_value(line["event"].clone()).unwrap()
}

#[test]
fn a_heard_chunk_of_the_live_turn_and_the_frame_that_draws_it_are_marked() {
    let mut runtime = runtime();
    frame_drawn(&runtime, 10.0);
    runtime.update(|board, _| board.chat_heard(1, Ok(event()), 700.0));
    assert_eq!(frame_drawn(&runtime, 709.0), [], "no turn is live");
    runtime.update(|board, _| {
        board.chat.say = Some(Box::new(|_, _| Box::new(|| {})));
        board.chat.composer = rune::edit::TextEdit::new("hi");
        board.chat.send();
        board.chat_heard(1, Ok(event()), 720.0);
    });
    assert_eq!(
        frame_drawn(&runtime, 729.0),
        [
            mark("chat-chunk", 720.0, "turn-1"),
            mark("chat-drawn", 729.0, "turn-1")
        ]
    );
}

#[test]
fn non_text_events_and_transport_errors_do_not_start_chat_timing() {
    let mut board = Board::default();
    board.chat.say = Some(Box::new(|_, _| Box::new(|| {})));
    board.chat.composer = rune::edit::TextEdit::new("hi");
    board.chat.send();
    for event in [
        serde_json::json!({"type": "RUN_STARTED", "threadId": "t1", "runId": "r1"}),
        serde_json::json!({"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"}),
        serde_json::json!({"type": "TOOL_CALL_START", "toolCallId": "c1", "toolCallName": "read", "parentMessageId": "m1"}),
        serde_json::json!({"type": "RUN_ERROR", "message": "failed", "runId": "r1"}),
    ] {
        board.chat_heard(1, Ok(serde_json::from_value(event).unwrap()), 700.0);
        assert_eq!(board.timing.borrow().marks, []);
    }
    board.chat_heard(1, Err("disconnected".into()), 710.0);
    assert_eq!(board.timing.borrow().marks, []);
    assert_eq!(board.chat.transcript.error.as_deref(), Some("disconnected"));
}

#[test]
fn each_frame_of_a_scrolled_diff_is_marked() {
    let mut runtime = runtime();
    frame_drawn(&runtime, 10.0);
    tap(&mut runtime, "card-b2", 100.0);
    let lines: String = (0..400).map(|n| format!("+line {n}\n")).collect();
    let patch = format!("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1,400 @@\n{lines}");
    runtime.update(move |board, _| board.diff_read(1, &patch));
    runtime.frame(1000.0);
    assert_eq!(frame_drawn(&runtime, 1000.0), []);
    runtime.pointer_move(600.0, 500.0);
    runtime.wheel(600.0, 500.0, -200.0);
    runtime.frame(1016.0);
    let marked = frame_drawn(&runtime, 1016.0);
    assert_eq!(marked, [mark("frame", 1016.0, "diff:1")]);
    assert_eq!(frame_drawn(&runtime, 1400.0), [], "settled");
}
