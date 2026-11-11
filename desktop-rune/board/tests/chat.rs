//! The Flock chat in the app's window, on a fake core: what it asks of Desktop's core, and
//! what it shows of the answers, read through the accessibility tree.

use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::{About, TerminalPayload};
use collie_desktop_terminal::view::Tab;
use rune::edit::TextEdit;
use rune::{ClipboardContent, ClipboardImage, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/chat");

struct Window {
    core: Harness<App>,
    rt: Runtime<App>,
    at: f64,
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

impl Window {
    /// The window with the chat open, on a core that has answered nothing yet.
    fn open(board: App) -> Window {
        let core = Harness::<App>::new();
        let mut board = board;
        board.core = Some(core.core.clone());
        board.nav.chat.set_open(true);
        board.open_chat();
        let mut rt = Runtime::new(
            board,
            view,
            (1280.0, 900.0),
            Env {
                system_dark: true,
                scale: 1.0,
            },
        );
        rt.frame(0.0);
        Window { core, rt, at: 0.0 }
    }

    /// Opened, with the conversation read as `items`.
    fn reading(items: Value) -> Window {
        let mut window = Window::open(App::default());
        window.answer("transcript", items);
        window
    }

    fn frame(&mut self) {
        self.at += 100.0;
        self.rt.frame(self.at);
    }

    /// Applies what the core answered, and draws it; a file drop held for a fresh build lands.
    fn settle(&mut self) {
        let core = &self.core;
        self.rt.update(|board, _| core.settle(board));
        self.frame();
        self.frame();
    }

    fn answer(&mut self, tag: &str, value: Value) {
        assert!(self.core.fake.answer(tag, Ok(value)), "nothing asked {tag}");
        self.settle();
    }

    fn refuse(&mut self, tag: &str, why: &str) {
        let refused = Err(CallError(why.into()));
        assert!(self.core.fake.answer(tag, refused), "nothing asked {tag}");
        self.settle();
    }

    fn push(&mut self, tag: &str, value: Value) {
        self.core.fake.push(tag, Ok(value));
        self.settle();
    }

    fn played(&mut self, name: &str) {
        let recorded = std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson")).unwrap();
        for line in recorded.lines() {
            let line: Value = serde_json::from_str(line).unwrap();
            if let Some(event) = line.get("event") {
                self.core.fake.push("say", Ok(event.clone()));
            }
        }
        self.settle();
    }

    fn asked(&self, tag: &str) -> Vec<Value> {
        self.core.fake.asked_of(tag)
    }

    fn keys(&self) -> Vec<String> {
        within(&self.rt.accessibility_json())
            .iter()
            .filter_map(|n| n["key"].as_str().map(String::from))
            .collect()
    }

    fn has(&self, key: &str) -> bool {
        self.keys().iter().any(|k| k == key)
    }

    fn node(&self, key: &str) -> Value {
        within(&self.rt.accessibility_json())
            .into_iter()
            .find(|n| n["key"] == key)
            .cloned()
            .unwrap_or_else(|| panic!("no {key} in {:?}", self.keys()))
    }

    /// Every name said under the node keyed `key`.
    fn said(&self, key: &str) -> String {
        within(&self.node(key))
            .iter()
            .filter_map(|n| n["name"].as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn tap(&mut self, key: &str) {
        let (x, y) = self
            .rt
            .find(key)
            .unwrap_or_else(|| panic!("no {key} in {:?}", self.keys()));
        self.rt.pointer_move(x, y);
        self.frame();
        self.rt.pointer_down(x, y);
        self.rt.frame(self.at + 50.0);
        self.rt.pointer_up(x, y);
        self.frame();
        self.settle();
    }

    fn type_in(&mut self, words: &str) {
        let words = words.to_string();
        self.rt.update(move |board, _| {
            board.chat.composer = TextEdit::new(&words);
            board.chat.composer.focused = true;
        });
        self.frame();
    }

    fn key(&mut self, key: Key, mods: Mods) {
        self.rt.key(KeyEvent { key, mods });
        self.frame();
        self.settle();
    }

    fn composer(&mut self) -> String {
        let mut text = String::new();
        self.rt
            .update(|board, _| text = board.chat.composer.text.clone());
        text
    }
}

fn ctrl() -> Mods {
    Mods {
        cmd: true,
        ..Mods::default()
    }
}

fn board() -> App {
    let mut board = App::default();
    for line in FLOCK.lines() {
        board.apply(serde_json::from_str(line).unwrap());
    }
    board
}

fn about() -> Value {
    json!({ "machine": "Build box", "task": "b2", "run": "r1", "name": "Nightly evidence sweep" })
}

fn conversation() -> Value {
    json!([
        {
            "id": "u1",
            "role": "user",
            "parts": [{ "type": "text", "content": "What needs me?" }],
            "metadata": { "about": about() }
        },
        {
            "id": "a1",
            "role": "assistant",
            "parts": [
                { "type": "thinking", "content": "Read the board first." },
                {
                    "type": "tool-call", "id": "call-1", "name": "mcp__collie__collie_herd",
                    "arguments": "{\"machine\":\"build\"}", "state": "complete",
                    "output": "\u{1b}[32m2 cards\u{1b}[0m waiting"
                },
                { "type": "text", "content": "**Two** cards need you.\n\n<details><summary>Which</summary>The sweep and the bump.</details>" }
            ]
        }
    ])
}

fn staged(id: &str, name: &str, size: f64) -> Value {
    json!({ "id": id, "name": name, "size": size, "mediaType": "text/plain", "path": format!("/nowhere/{name}") })
}

#[test]
fn the_conversation_is_read_as_it_opens_and_shows_each_part() {
    let mut window = Window::open(App::default());
    assert_eq!(window.asked("transcript").len(), 1, "read once as it opens");
    for tag in [
        "settings",
        "chatChoices",
        "conversationChanges",
        "desktopTurns",
    ] {
        assert_eq!(window.asked(tag).len(), 1, "subscribed to {tag}");
    }
    assert!(window.has("chat-loading"), "{:?}", window.keys());

    window.answer("transcript", conversation());
    assert!(!window.has("chat-loading"));
    let user = window.said("message-u1");
    assert!(user.contains("What needs me?"), "{user}");
    assert!(
        user.contains("About Build box › Nightly evidence sweep"),
        "{user}"
    );
    let reply = window.said("message-a1");
    assert!(reply.contains("Thinking"), "{reply}");
    assert!(reply.contains("herd"), "{reply}");
    assert!(reply.contains("Two"), "{reply}");
    assert!(
        reply.contains("Which"),
        "the summary of a details block: {reply}"
    );
    assert!(reply.contains("The sweep and the bump."), "{reply}");
    assert!(
        !reply.contains("<details>") && !reply.contains("<summary>"),
        "{reply}"
    );
}

#[test]
fn an_empty_conversation_says_what_the_chat_is_for() {
    let window = Window::reading(json!([]));
    assert!(window.said("chat-empty").contains("Ask about the Flock"));
}

#[test]
fn the_conversation_is_read_again_when_it_changes_once_no_reply_streams() {
    let mut window = Window::reading(conversation());
    window.push("conversationChanges", json!("changed"));
    assert_eq!(window.asked("transcript").len(), 2);
    window.answer("transcript", json!([]));

    window.type_in("hello");
    window.tap("send");
    window.push("conversationChanges", json!("changed"));
    assert_eq!(
        window.asked("transcript").len(),
        2,
        "not while a reply streams"
    );
    window.played("say-text");
    assert_eq!(window.asked("transcript").len(), 3, "once it ends");

    window.answer("transcript", json!([]));
    window.push("desktopTurns", json!("started"));
    assert!(window.has("chat-desktop-speaking"));
    window.push("desktopTurns", json!("ended"));
    assert!(!window.has("chat-desktop-speaking"));
    assert_eq!(
        window.asked("transcript").len(),
        4,
        "Desktop's own turn ended"
    );
}

#[test]
fn pressing_the_card_a_message_is_about_opens_its_runs_pane() {
    let asked: Arc<Mutex<Vec<(TerminalPayload, String)>>> = Arc::default();
    let mut board = board();
    let said = asked.clone();
    board.go_to = Some(Box::new(move |payload, machine, _| {
        said.lock().unwrap().push((payload, machine.clone()));
        Tab::new(None, machine, 100, 30)
    }));
    let mut window = Window::open(board);
    window.answer("transcript", conversation());
    window.tap("chat-about");
    let opened = asked.lock().unwrap().clone();
    assert_eq!(opened.len(), 1, "{opened:?}");
    assert_eq!(opened[0].0.installation, "inst-build");
    assert_eq!(opened[0].0.run_id, "r1");
}

#[test]
fn enter_while_a_reply_streams_queues_the_message_and_ctrl_enter_sends_it_now() {
    let mut window = Window::reading(json!([]));
    window.type_in("one");
    window.key(Key::Enter, Mods::default());
    let said = window.asked("say");
    assert_eq!(said.len(), 1);
    assert_eq!(said[0]["text"], "one");
    assert_eq!(said[0]["now"], false);
    assert!(window.has("stop"), "{:?}", window.keys());

    window.type_in("two");
    window.key(Key::Enter, Mods::default());
    assert_eq!(window.asked("say").len(), 1, "queued, not sent");
    assert!(window.said("chat-queued-1").contains("two"));
    assert_eq!(window.composer(), "");

    window.type_in("three");
    window.key(Key::Enter, ctrl());
    let said = window.asked("say");
    assert_eq!(said.len(), 2, "sent now");
    assert_eq!(said[1]["text"], "three");
    assert_eq!(said[1]["now"], true);

    window.played("say-text");
    let said = window.asked("say");
    assert_eq!(said.len(), 3, "the queued message goes once the reply ends");
    assert_eq!(said[2]["text"], "two");
    assert!(!window.has("chat-queued-1"));
}

#[test]
fn stop_ends_the_reply_and_brings_the_queued_words_back_to_the_composer() {
    let mut window = Window::reading(json!([]));
    window.type_in("one");
    window.tap("send");
    window.type_in("two");
    window.key(Key::Enter, Mods::default());
    window.type_in("three");
    window.tap("stop");
    assert!(window.has("send"), "{:?}", window.keys());
    assert!(!window.has("chat-queued-1"));
    assert_eq!(window.composer(), "two\n\nthree");
    window.played("say-text");
    assert!(
        !window.keys().iter().any(|k| k.starts_with("message-reply")),
        "a stopped reply's late events are not shown: {:?}",
        window.keys()
    );
}

#[test]
fn a_tool_row_opens_to_its_input_and_output() {
    let mut window = Window::reading(json!([]));
    window.type_in("Read /etc/hostname");
    window.tap("send");
    window.played("say-tool");
    let tool = "tool-toolu_01XS1ZjFcJi8H9zLxc25vfJV";
    assert!(!window.has(&format!("{tool}-detail")));
    window.tap(&format!("{tool}-toggle"));
    let detail = window.said(&format!("{tool}-detail"));
    assert!(detail.contains("/etc/hostname"), "{detail}");
    assert!(detail.contains("vm-mk.cegohost.dk"), "{detail}");
}

#[test]
fn a_failed_reply_says_why_and_tries_again_with_the_same_message() {
    let mut window = Window::reading(json!([]));
    window.type_in("What is in the file I attached?");
    window.tap("send");
    window.played("say-error");
    let error = window.node("chat-error");
    assert_eq!(error["role"], "alert");
    assert!(
        window
            .said("chat-error")
            .contains("Desktop no longer has missing-attachment; attach it again."),
        "{}",
        window.said("chat-error")
    );
    window.tap("chat-try-again");
    let said = window.asked("say");
    assert_eq!(said.len(), 2);
    assert_eq!(said[1]["text"], "What is in the file I attached?");
}

fn asking(multi: bool) -> Value {
    json!({
        "questions": [{
            "question": "Which one first?", "header": "Order", "multiSelect": multi,
            "options": [
                { "label": "The sweep", "description": "It is older" },
                { "label": "The bump" }
            ]
        }]
    })
}

fn ask(window: &mut Window, multi: bool) {
    window.type_in("help me choose");
    window.tap("send");
    window.push(
        "say",
        json!({ "type": "TOOL_CALL_START", "toolCallId": "ask-1", "toolCallName": "AskUserQuestion", "parentMessageId": "m1" }),
    );
    window.push(
        "say",
        json!({ "type": "TOOL_CALL_ARGS", "toolCallId": "ask-1", "delta": asking(multi).to_string() }),
    );
}

#[test]
fn the_chats_question_is_answered_in_the_chat() {
    let mut window = Window::reading(json!([]));
    ask(&mut window, false);
    let card = window.said("question-ask-1");
    assert!(card.contains("Which one first?"), "{card}");
    window.tap("question-ask-1-0-1");
    assert_eq!(
        window.asked("answer"),
        [json!({ "toolCallId": "ask-1", "answers": { "Which one first?": "The bump" } })]
    );

    let mut window = Window::reading(json!([]));
    ask(&mut window, true);
    window.tap("question-ask-1-0-0");
    window.tap("question-ask-1-0-1");
    assert!(
        window.asked("answer").is_empty(),
        "many are answered together"
    );
    window.tap("question-ask-1-answer");
    assert_eq!(
        window.asked("answer"),
        [
            json!({ "toolCallId": "ask-1", "answers": { "Which one first?": "The sweep, The bump" } })
        ]
    );
}

fn choices() -> Value {
    json!({
        "heldOn": "claude", "runsOn": null, "turning": false,
        "harnesses": [
            { "harness": "claude", "label": "Claude Code", "installed": true, "offered": {
                "from": "harness", "unset": { "harness": "claude", "model": "default", "effort": null },
                "models": [
                    { "id": "opus", "label": "Opus", "efforts": ["low", "high"], "unsetEffort": "high" },
                    { "id": "sonnet", "label": "Sonnet", "efforts": [], "unsetEffort": null }
                ]
            }},
            { "harness": "codex", "label": "Codex", "installed": true, "offered": {
                "from": "harness", "unset": { "harness": "codex", "model": "default", "effort": null },
                "models": []
            }}
        ]
    })
}

#[test]
fn a_harness_model_or_effort_is_saved_through_settings_and_a_refusal_is_said() {
    let mut window = Window::reading(json!([]));
    window.push("settings", json!({}));
    window.push("chatChoices", choices());
    assert!(window.said("chat-choices").contains("Claude Code"));

    window.tap("chat-harness");
    window.tap("chat-harness-menu-item1");
    assert_eq!(
        window.asked("setSettings"),
        [json!({ "chatHarness": "codex" })]
    );
    window.refuse("setSettings", "Codex is not signed in.");
    assert_eq!(
        window.node("chat-choice-refused")["name"],
        "Codex is not signed in. Nothing was saved."
    );
    window.tap("chat-choice-dismiss");
    assert!(!window.has("chat-choice-refused"));

    window.tap("chat-model");
    window.rt.update(|board, _| {
        board.chat.model_menu.search = TextEdit::new("claude-opus-9");
    });
    window.frame();
    assert!(
        window.has("chat-model-menu-option-claude-opus-9"),
        "a typed id is offered: {:?}",
        window.keys()
    );
    window.tap("chat-model-menu-option-claude-opus-9");
    assert_eq!(
        window.asked("setSettings")[1],
        json!({ "chatModel": "claude-opus-9" })
    );
}

#[test]
fn the_bell_says_whether_the_chat_speaks_first_and_saves_the_flocks_setting() {
    let mut window = Window::reading(json!([]));
    assert_eq!(
        window.node("chat-proactive")["name"],
        "Speaks first about News that matters"
    );
    window.tap("chat-proactive");
    assert_eq!(
        window.asked("setFlockSetting"),
        [json!({ "key": "flock_chat.proactive", "value": "false" })]
    );
    assert_eq!(window.node("chat-proactive")["name"], "Waits to be asked");
}

#[test]
fn files_from_the_dialog_a_paste_or_a_drop_are_staged_and_ride_on_the_next_message() {
    let mut window = Window::reading(json!([]));
    window.tap("attach");
    window
        .rt
        .resolve_file_dialog(Some(PathBuf::from("/tmp/notes.txt")))
        .unwrap();
    window.settle();
    assert_eq!(
        window.asked("stagePaths"),
        [json!({ "paths": ["/tmp/notes.txt"] })]
    );
    window.answer("stagePaths", json!([staged("f1", "notes.txt", 2048.0)]));
    assert!(window.said("file-f1").contains("notes.txt"));

    window.tap("composer");
    window
        .rt
        .paste_content(ClipboardContent::new("").with_files([PathBuf::from("/tmp/a.txt")]));
    window.settle();
    window
        .rt
        .paste_content(ClipboardContent::new("file:///tmp/a%20b.txt\n"));
    window.settle();
    let (x, y) = window.rt.find("chat").unwrap();
    window
        .rt
        .drop_files(vec![PathBuf::from("/tmp/log.txt")], Some((x, y)));
    window.settle();
    assert_eq!(
        window.asked("stagePaths")[1..],
        [
            json!({ "paths": ["/tmp/a.txt"] }),
            json!({ "paths": ["/tmp/a b.txt"] }),
            json!({ "paths": ["/tmp/log.txt"] })
        ]
    );
    window.answer("stagePaths", json!([staged("f2", "a.txt", 10.0)]));
    window.answer("stagePaths", json!([{ "refused": "a b.txt is a folder" }]));
    assert_eq!(window.said("chat-refused"), "a b.txt is a folder");
    window.answer(
        "stagePaths",
        json!([staged("f3", "log.txt", 21.0 * 1024.0 * 1024.0)]),
    );
    assert!(
        window.said("chat-refused").contains("log.txt"),
        "over the cap: {}",
        window.said("chat-refused")
    );
    assert!(!window.has("file-f3"));

    window.tap("file-f2-remove");
    assert!(!window.has("file-f2"));
    window.type_in("read these");
    window.tap("send");
    assert_eq!(window.asked("say")[0]["attachments"], json!(["f1"]));
    assert!(!window.has("file-f1"), "the files went with it");
    assert!(window.said("message-said-1").contains("notes.txt"));
}

#[test]
fn a_paste_with_no_files_asks_the_core_for_the_clipboards() {
    let mut window = Window::reading(json!([]));
    window.tap("composer");
    window.rt.paste_content(ClipboardContent::new(""));
    window.settle();
    assert_eq!(window.asked("clipboardFiles").len(), 1);
    window.answer("clipboardFiles", json!([staged("f9", "copied.txt", 5.0)]));
    assert!(window.has("file-f9"));
}

/// A grey PNG `width` by `height`, stored uncompressed so the test needs no encoder.
fn png(width: u32, height: u32) -> Vec<u8> {
    use std::io::Write;
    fn crc(bytes: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for b in bytes {
            c ^= u32::from(*b);
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        !c
    }
    fn adler(bytes: &[u8]) -> u32 {
        let (mut a, mut b) = (1u32, 0u32);
        for x in bytes {
            a = (a + u32::from(*x)) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
        out.write_all(&(data.len() as u32).to_be_bytes()).unwrap();
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.write_all(&body).unwrap();
        out.write_all(&crc(&body).to_be_bytes()).unwrap();
    }
    let mut raw = Vec::new();
    for _ in 0..height {
        raw.push(0);
        raw.extend(std::iter::repeat_n(128u8, width as usize));
    }
    let mut z = vec![0x78, 0x01];
    for (i, block) in raw.chunks(65535).enumerate() {
        let last = (i + 1) * 65535 >= raw.len();
        z.push(u8::from(last));
        z.extend_from_slice(&(block.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler(&raw).to_be_bytes());
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 0, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

#[test]
fn a_pasted_image_is_staged_with_a_copy_scaled_for_the_model() {
    let mut window = Window::reading(json!([]));
    window.tap("composer");
    let image = ClipboardImage::from_png(png(2400, 10)).expect("a PNG");
    window
        .rt
        .paste_content(ClipboardContent::new("").with_image(image));
    window.settle();
    let first = window.asked("stage");
    assert_eq!(first.len(), 1, "{first:?}");
    assert_eq!(first[0]["offset"], 0);
    assert_eq!(first[0]["mediaType"], "image/png");
    assert!(first[0]["name"].as_str().unwrap().starts_with("pasted-"));
    assert!(first[0].get("scaledOf").is_none());
    window.answer(
        "stage",
        json!({ "id": "img1", "name": "pasted.png", "size": 1.0, "mediaType": "image/png", "path": "/nowhere" }),
    );
    let staged = window.asked("stage");
    assert_eq!(staged.len(), 2, "the scaled copy follows");
    assert_eq!(staged[1]["scaledOf"], "img1");
    assert!(window.has("file-img1"));
}

#[test]
fn a_link_the_chat_writes_opens_through_the_core_and_nothing_else_does() {
    let mut window = Window::reading(json!([]));
    window.rt.update(|board, _| {
        collie_desktop_chat::chat::follow(board, "https://example.com/a");
        collie_desktop_chat::chat::follow(board, "javascript:alert(1)");
    });
    window.settle();
    assert_eq!(
        window.asked("openLink"),
        [json!({ "url": "https://example.com/a" })]
    );
}

#[test]
fn an_earlier_conversation_is_listed_and_reopened_and_start_fresh_opens_a_new_one() {
    let mut window = Window::reading(conversation());
    window.tap("chat-earlier");
    assert_eq!(window.asked("conversations").len(), 1);
    window.answer(
        "conversations",
        json!({ "current": "s0", "earlier": [
            { "session": "s1", "title": "The sweep", "at": 1_762_000_000_000.0, "harness": "codex" }
        ]}),
    );
    let menu = window.said("chat-earlier-menu-menu");
    assert!(menu.contains("The sweep"), "{menu}");
    assert!(menu.contains("moves the chat to Codex"), "{menu}");
    window.tap("chat-earlier-menu-item1");
    assert_eq!(
        window.asked("reopen"),
        [json!({ "conversation": { "session": "s1", "harness": "codex" } })]
    );
    window.answer("reopen", Value::Null);
    assert_eq!(
        window.asked("transcript").len(),
        2,
        "the reopened one is read"
    );

    window.tap("chat-new");
    assert_eq!(window.asked("reopen")[1], json!({ "conversation": null }));
}

#[test]
fn the_setup_offer_is_answered_in_the_chat() {
    let mut window = Window::reading(json!([]));
    window.push("setupOffer", json!(true));
    assert!(window.said("setup").contains("Tell Collie how you work"));
    window.tap("setup-open");
    assert_eq!(window.asked("setupInventory").len(), 1);
    assert!(window.said("setup").contains("Looking for your sessions"));
    window.answer(
        "setupInventory",
        json!([{ "computer": "Local", "stores": [
            { "source": "claude-code", "where": "~/.claude", "found": "read", "sessions": 12.0 }
        ]}]),
    );
    assert!(
        window
            .said("setup")
            .contains("Claude Code: 12 sessions in ~/.claude")
    );
    window.tap("setup-read");
    assert_eq!(window.asked("chooseSetup"), [json!({ "choice": "read" })]);
    assert!(!window.has("setup"));

    window.push("setupOffer", json!(true));
    window.tap("setup-not-now");
    assert_eq!(window.asked("declineSetup"), [json!({ "forGood": false })]);
}

#[test]
fn copy_puts_a_messages_words_on_the_clipboard() {
    let mut window = Window::reading(conversation());
    let clipboard = rune::clipboard::memory();
    window.rt.use_clipboard(&clipboard);
    window.tap("copy-a1");
    assert_eq!(
        clipboard.content().map(|c| c.text().to_string()),
        Some("**Two** cards need you.\n\n<details><summary>Which</summary>The sweep and the bump.</details>".into())
    );
    assert_eq!(window.node("copy-a1")["name"], "Copied");
}

#[test]
fn the_boards_selection_rides_on_the_next_message_and_can_be_cleared() {
    let mut window = Window::reading(json!([]));
    let chosen: About = serde_json::from_value(about()).unwrap();
    let again = chosen.clone();
    window
        .rt
        .update(move |board, _| board.chat.choose(Some(chosen)));
    window.frame();
    assert!(
        window
            .said("chat-chip")
            .contains("About: Build box › Nightly evidence sweep")
    );
    window.tap("chat-chip-clear");
    assert!(!window.has("chat-chip"));

    window
        .rt
        .update(move |board, _| board.chat.choose(Some(again)));
    window.type_in("why is it slow?");
    window.tap("send");
    assert_eq!(window.asked("say")[0]["about"], about());
    assert!(!window.has("chat-chip"));
    assert!(
        window
            .said("message-said-1")
            .contains("About Build box › Nightly evidence sweep")
    );
}

#[test]
fn a_turn_desktop_started_about_news_is_shown_as_desktops() {
    let window = Window::reading(json!([{
        "id": "d1", "role": "user",
        "parts": [{ "type": "text", "content": "Desktop noticed, while you were not asked:\n\nThe sweep failed." }]
    }]));
    let said = window.said("message-d1");
    assert!(said.contains("Desktop"), "{said}");
    assert!(said.contains("The sweep failed."), "{said}");
    assert!(!said.contains("while you were not asked"), "{said}");
}

#[test]
fn a_stopped_subscription_is_said_and_taken_again_on_retry() {
    let mut window = Window::reading(json!([]));
    window.core.fake.push(
        "settings",
        Err(CallError("Desktop's core went away".into())),
    );
    window.settle();
    assert!(
        window
            .said("chat-trouble")
            .contains("Desktop's core went away")
    );
    window.tap("chat-retry-now");
    assert_eq!(window.asked("settings").len(), 2);
    assert!(!window.has("chat-trouble"));
}
