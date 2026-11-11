//! The live core's streams, over a scripted core on pipes: a stream the shell stopped says
//! nothing more, and one the core ends says it ended. And what the app's log keeps of calls.

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::calls::{CallError, Calls, Live};
use collie_desktop_board::log;
use collie_desktop_protocol::client::Client;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

/// A core that answers the first stream with one value, then, once told to, ends it as
/// `exit` says; it answers an `Interrupt` with Effect's interrupted exit.
fn core(exit: &'static str) -> Client {
    let (shell_reads, mut core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(core_reads).lines().map_while(Result::ok) {
            let frame: Value = serde_json::from_str(&line).unwrap();
            let reply = match frame["_tag"].as_str() {
                Some("Request") if exit == "interrupted-by-shell" => {
                    json!({ "_tag": "Chunk", "requestId": frame["id"], "values": [true] })
                }
                Some("Request") if exit == "success" => {
                    writeln!(core_writes, "{}", json!({ "_tag": "Chunk", "requestId": frame["id"], "values": [true] })).unwrap();
                    json!({ "_tag": "Exit", "requestId": frame["id"], "exit": { "_tag": "Success", "value": null } })
                }
                Some("Request") => {
                    writeln!(core_writes, "{}", json!({ "_tag": "Chunk", "requestId": frame["id"], "values": [true] })).unwrap();
                    json!({ "_tag": "Exit", "requestId": frame["id"], "exit": { "_tag": "Failure", "cause": [{ "_tag": "Interrupt", "fiberId": 7 }] } })
                }
                Some("Interrupt") => {
                    json!({ "_tag": "Exit", "requestId": frame["requestId"], "exit": { "_tag": "Failure", "cause": [{ "_tag": "Interrupt", "fiberId": 26 }] } })
                }
                _ => continue,
            };
            if writeln!(core_writes, "{reply}").is_err() {
                return;
            }
        }
    });
    Client::new(BufReader::new(shell_reads), shell_writes).unwrap()
}

enum Heard {
    Value(Result<Value, String>),
    Ended,
}

fn listen(exit: &'static str) -> (Box<dyn FnOnce() + Send>, Receiver<Heard>) {
    let live = Live(core(exit));
    let (tell, heard) = channel();
    let ends = tell.clone();
    let stop = live.stream(
        "setupOffer",
        Value::Null,
        Box::new(move |value| {
            let _ = tell.send(Heard::Value(value.map_err(|f| f.said)));
        }),
        Box::new(move || {
            let _ = ends.send(Heard::Ended);
        }),
    );
    (stop, heard)
}

#[test]
fn a_stream_the_shell_stopped_says_nothing_more() {
    let (stop, heard) = listen("interrupted-by-shell");
    let first = heard.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(first, Heard::Value(Ok(_))));
    stop();
    match heard.recv_timeout(Duration::from_millis(500)) {
        Err(_) => {}
        Ok(Heard::Value(v)) => panic!("heard {v:?} after its Stop"),
        Ok(Heard::Ended) => panic!("told it ended after its Stop"),
    }
}

#[test]
fn a_stream_the_core_ends_or_cuts_off_says_it_ended() {
    for exit in ["success", "interrupted-by-core"] {
        let (_stop, heard) = listen(exit);
        assert!(matches!(heard.recv_timeout(Duration::from_secs(5)).unwrap(), Heard::Value(Ok(_))));
        match heard.recv_timeout(Duration::from_secs(5)) {
            Ok(Heard::Ended) => {}
            Ok(Heard::Value(v)) => panic!("{exit}: heard {v:?}, not its end"),
            Err(_) => panic!("{exit}: never told it ended"),
        }
    }
}

#[test]
fn a_failed_call_is_logged_by_its_rpc_and_reason_and_never_its_words() {
    let dir = std::env::temp_dir().join(format!("collie-calls-log-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    log::here(&dir, log::LOG_BYTES);
    let harness = Harness::<()>::new();
    harness.fake.will_answer("answer", Err(CallError("The question was already answered.".into())));
    harness.core.request(
        "answer",
        json!({ "toolCallId": "ask-1", "answers": { "Which one first?": "the secret sweep" } }),
        |_: &mut (), _: Result<Value, CallError>| {},
    );
    let _stop = harness.core.stream_until(
        "say",
        json!({ "text": "my private words" }),
        |_: &mut (), _: Result<Value, CallError>| {},
        |_: &mut ()| {},
    );
    harness.fake.push("say", Err(CallError("The Flock chat could not start".into())));
    harness.fake.end("say");
    let mut unit = ();
    harness.settle(&mut unit);
    let logged = std::fs::read_to_string(dir.join("desktop.log")).unwrap_or_default();
    let lines: Vec<Value> = logged.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let said: Vec<(String, String)> = lines
        .iter()
        .map(|l| (l["what"].as_str().unwrap().into(), l["rpc"].as_str().unwrap_or("").into()))
        .collect();
    assert_eq!(
        said,
        [
            ("request failed".to_string(), "answer".to_string()),
            ("stream failed".into(), "say".into()),
            ("stream ended".into(), "say".into()),
        ],
        "{logged}"
    );
    assert_eq!(lines[0]["reason"], "The question was already answered.");
    assert!(!logged.contains("secret") && !logged.contains("private"), "{logged}");
}
