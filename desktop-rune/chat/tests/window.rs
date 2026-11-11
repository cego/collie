//! The chat in its own window: it reads the conversation there, puts itself back, and tells
//! the board's window when it closes.

use collie_desktop_chat::window::{Alone, closed, opened, view};
use rune::{Env, Runtime};
use serde_json::Value;
use std::sync::{Arc, Mutex};

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

#[test]
fn the_chat_in_its_own_window_reads_the_conversation_and_puts_itself_back() {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let popped: Arc<Mutex<Vec<bool>>> = Arc::default();
    let back: Arc<Mutex<u32>> = Arc::default();
    let mut alone = Alone::default();
    let (requests, streams) = (asked.clone(), asked.clone());
    alone.request = Some(Box::new(move |tag, _, _| {
        requests.lock().unwrap().push(tag.into())
    }));
    alone.stream = Some(Box::new(move |tag, _, _| {
        streams.lock().unwrap().push(tag.into());
        Box::new(|| {})
    }));
    let told = popped.clone();
    alone.chat.pop = Some(Box::new(move |out| told.lock().unwrap().push(out)));
    let came = back.clone();
    alone.back = Some(Box::new(move || *came.lock().unwrap() += 1));
    opened(&mut alone);
    assert!(asked.lock().unwrap().contains(&"transcript".to_string()));

    let mut rt = Runtime::new(
        alone,
        view,
        (480.0, 760.0),
        Env {
            system_dark: false,
            scale: 1.0,
        },
    );
    rt.frame(0.0);
    let tree = rt.accessibility_json();
    let keys: Vec<&str> = within(&tree)
        .iter()
        .filter_map(|n| n["key"].as_str())
        .collect();
    assert!(keys.contains(&"composer"), "{keys:?}");
    assert!(!keys.contains(&"chat-popped"), "{keys:?}");
    let pop = within(&tree)
        .into_iter()
        .find(|n| n["key"] == "chat-pop")
        .cloned()
        .unwrap();
    assert_eq!(pop["name"], "Put back beside the board");

    let (x, y) = rt.find("chat-pop").unwrap();
    rt.pointer_move(x, y);
    rt.frame(100.0);
    rt.pointer_down(x, y);
    rt.frame(150.0);
    rt.pointer_up(x, y);
    rt.frame(250.0);
    assert_eq!(*popped.lock().unwrap(), [false]);

    rt.update(closed);
    assert_eq!(*back.lock().unwrap(), 1, "the board's window is told");
}

#[test]
fn p2_pressing_the_card_in_the_chats_own_window_asks_the_boards_window_to_open_it() {
    use collie_desktop_protocol::generated::{About, TranscriptSuccessItem};
    let about = serde_json::json!({ "machine": "Build box", "task": "b2", "run": "r1", "name": "Nightly evidence sweep" });
    let items: Vec<TranscriptSuccessItem> = serde_json::from_value(serde_json::json!([{
        "id": "u1", "role": "user",
        "parts": [{ "type": "text", "content": "What needs me?" }],
        "metadata": { "about": about }
    }]))
    .unwrap();
    let asked: Arc<Mutex<Vec<About>>> = Arc::default();
    let mut alone = Alone::default();
    let told = asked.clone();
    alone.about = Some(Box::new(move |about| told.lock().unwrap().push(about)));
    alone.chat.transcript.replace(items);
    alone.chat.loaded = true;
    let mut rt = Runtime::new(
        alone,
        view,
        (480.0, 760.0),
        Env {
            system_dark: false,
            scale: 1.0,
        },
    );
    rt.frame(0.0);
    let (x, y) = rt.find("chat-about").expect("the message's card");
    rt.pointer_move(x, y);
    rt.frame(100.0);
    rt.pointer_down(x, y);
    rt.frame(150.0);
    rt.pointer_up(x, y);
    rt.frame(250.0);
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].task, "b2");
}
