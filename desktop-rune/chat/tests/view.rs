//! The chat panel and the Diff tab as Rune builds them, read through the accessibility tree
//! and driven by the pointer, without a window.

use collie_desktop_chat::review::{Anchor, Draft, compose};
use collie_desktop_chat::view::{Chat, DiffTab, chat, diff_tab};
use collie_desktop_protocol::generated::{AguiEvent, SayPayload};
use rune::edit::TextEdit;
use rune::{ClipboardContent, Cx, El, Env, Runtime};
use rune_kit::Kit;
use rune_kit::diff::{DiffMode, LineRange, LineRef, Side, parse};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/chat");

fn chat_view(chat_at: &Chat, cx: &mut Cx<Chat>) -> El {
    let k = Kit::neutral(cx.system_dark());
    rune_kit::root(chat(chat_at, |c: &mut Chat| c, &k), [])
}

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

fn played(name: &str) -> Chat {
    let mut chat = Chat::default();
    let recorded = std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson")).unwrap();
    for line in recorded.lines() {
        let line: Value = serde_json::from_str(line).unwrap();
        if let Some(said) = line.get("said") {
            chat.transcript.say(said["text"].as_str().unwrap());
        } else if let Some(event) = line.get("event") {
            chat.transcript
                .apply(serde_json::from_value(event.clone()).unwrap());
        }
    }
    chat
}

fn events(name: &str) -> Vec<AguiEvent> {
    std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson"))
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).unwrap().get("event").cloned())
        .map(|event| serde_json::from_value(event).unwrap())
        .collect()
}

#[test]
fn a_cancelled_turns_late_events_and_error_do_not_reach_the_next_turn() {
    let turns: Arc<Mutex<Vec<u64>>> = Arc::default();
    let mut chat = Chat::default();
    let sent = turns.clone();
    chat.say = Some(Box::new(move |_, turn| {
        sent.lock().unwrap().push(turn);
        Box::new(|| {})
    }));
    chat.composer = TextEdit::new("one");
    chat.send();
    chat.cancel();
    chat.composer = TextEdit::new("two");
    chat.send();
    let [first, second] = turns.lock().unwrap()[..] else {
        panic!("two turns: {:?}", turns.lock().unwrap());
    };
    assert_ne!(first, second);

    for event in events("say-text") {
        chat.heard(first, Ok(event));
    }
    chat.heard(first, Err("interrupted".into()));
    assert_eq!(chat.transcript.messages.len(), 2, "only the two said");
    assert_eq!(chat.transcript.error, None);
    assert!(chat.transcript.running, "the second turn still runs");

    for event in events("say-text") {
        chat.heard(second, Ok(event));
    }
    assert_eq!(chat.transcript.messages.len(), 3, "the second turn's reply");
}

#[test]
fn a_played_turn_shows_what_was_said_the_tool_it_called_and_the_reply() {
    let runtime = runtime(played("say-tool"), chat_view);
    let user = said(&runtime, "message-0");
    assert!(user.contains("hostname"), "{user}");
    let reply = said(&runtime, "message-1");
    assert!(reply.contains("Read"), "{reply}");
    assert!(reply.contains("/etc/hostname"), "{reply}");
    assert!(reply.contains("The hostname is"), "{reply}");
}

#[test]
fn a_failed_turn_says_why_under_the_transcript() {
    let runtime = runtime(played("say-error"), chat_view);
    let error = keyed(&runtime, "chat-error").expect("an error");
    assert_eq!(error["role"], "alert");
    assert_eq!(
        error["name"],
        "Desktop no longer has missing-attachment; attach it again."
    );
}

#[test]
fn send_says_the_composers_text_and_stop_cancels_the_turn() {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let cancelled = Arc::new(Mutex::new(0));
    let mut chat = Chat::default();
    chat.composer = TextEdit::new("what is 3 + 4?");
    let (sent, stopped) = (asked.clone(), cancelled.clone());
    chat.say = Some(Box::new(move |payload: SayPayload, _| {
        sent.lock().unwrap().push(payload.text);
        let stopped = stopped.clone();
        Box::new(move || *stopped.lock().unwrap() += 1)
    }));
    let mut runtime = runtime(chat, chat_view);
    tap(&mut runtime, "send", 100.0);
    assert_eq!(*asked.lock().unwrap(), ["what is 3 + 4?"]);
    assert!(said(&runtime, "message-0").contains("what is 3 + 4?"));
    assert!(keyed(&runtime, "stop").is_some(), "Stop while it runs");

    tap(&mut runtime, "stop", 1000.0);
    assert_eq!(*cancelled.lock().unwrap(), 1);
    assert!(keyed(&runtime, "stop").is_none(), "no Stop once stopped");
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

type Staged = Arc<Mutex<Vec<Vec<PathBuf>>>>;

fn staging(chat: &mut Chat) -> Staged {
    let staged: Staged = Arc::default();
    let into = staged.clone();
    chat.stage = Some(Box::new(move |paths| into.lock().unwrap().push(paths)));
    staged
}

#[test]
fn a_file_chosen_in_the_dialog_reaches_stage_paths() {
    let mut chat = Chat::default();
    let staged = staging(&mut chat);
    let mut runtime = runtime(chat, chat_view);
    tap(&mut runtime, "attach", 100.0);
    assert!(runtime.file_dialog().is_some(), "the dialog opens");
    runtime
        .resolve_file_dialog(Some(PathBuf::from("/tmp/shot.png")))
        .unwrap();
    runtime.frame(1000.0);
    assert_eq!(
        *staged.lock().unwrap(),
        [vec![PathBuf::from("/tmp/shot.png")]]
    );
}

#[test]
fn pasted_files_and_pasted_file_uris_reach_stage_paths_and_other_text_is_typed() {
    let mut chat = Chat::default();
    let staged = staging(&mut chat);
    let mut runtime = runtime(chat, chat_view);
    tap(&mut runtime, "composer", 100.0);
    runtime.paste_content(
        ClipboardContent::new("")
            .with_files([PathBuf::from("/tmp/a.txt"), PathBuf::from("/tmp/b.png")]),
    );
    runtime.frame(1000.0);
    runtime.paste_content(ClipboardContent::new(
        "file:///tmp/a%20b.txt\nfile:///tmp/c.png\n",
    ));
    runtime.frame(1100.0);
    runtime.paste_content(ClipboardContent::new("just words"));
    runtime.frame(1200.0);
    assert_eq!(
        *staged.lock().unwrap(),
        [
            vec![PathBuf::from("/tmp/a.txt"), PathBuf::from("/tmp/b.png")],
            vec![PathBuf::from("/tmp/a b.txt"), PathBuf::from("/tmp/c.png")],
        ]
    );
    let mut typed = String::new();
    runtime.update(|chat, _| typed = chat.composer.text.clone());
    assert_eq!(typed, "just words");
}

#[test]
fn files_dropped_on_the_chat_reach_stage_paths() {
    let mut chat = Chat::default();
    let staged = staging(&mut chat);
    let mut runtime = runtime(chat, chat_view);
    let at = runtime.find("chat").unwrap();
    runtime.drop_files(vec![PathBuf::from("/tmp/log.txt")], Some(at));
    runtime.frame(100.0);
    assert_eq!(
        *staged.lock().unwrap(),
        [vec![PathBuf::from("/tmp/log.txt")]]
    );
}

#[test]
fn where_the_platform_reports_no_drops_the_chat_says_so() {
    let mut chat = Chat::default();
    chat.drops_unavailable = true;
    let runtime = runtime(chat, chat_view);
    let said = keyed(&runtime, "drops-unavailable").expect("a message");
    assert_eq!(
        said["name"],
        "Dropping files isn't available here. Attach or paste them instead."
    );
    let runtime = self::runtime(Chat::default(), chat_view);
    assert!(keyed(&runtime, "drops-unavailable").is_none());
}
