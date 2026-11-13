//! The chat's turns: a cancelled one's late events never reach the next.

use collie_desktop_chat::Chat;
use collie_desktop_protocol::generated::AguiEvent;
use rune::edit::TextEdit;
use serde_json::Value;
use std::sync::{Arc, Mutex};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/chat");

fn events(name: &str) -> Vec<AguiEvent> {
    std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson"))
        .unwrap()
        .lines()
        .filter_map(|line| {
            serde_json::from_str::<Value>(line)
                .unwrap()
                .get("event")
                .cloned()
        })
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
