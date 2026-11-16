//! Records what today's Flock chat streams on `say`, as NDJSON: `{"said": payload}` for each
//! turn asked, `{"event": …}` for each AG-UI event as the core sent it, and `{"cancelled": n}`
//! where the turn was interrupted after `n` text deltas.
//!
//! `cargo run -p collie-desktop-chat --bin record-say -- --out <file> --say <text>
//!  [--attach <id>] [--cancel-after <n>] [--say <text> …]`
//!
//! `--attach` and `--cancel-after` apply to the `--say` after them.

use collie_desktop_protocol::core::Core;
use collie_desktop_protocol::generated::SayPayload;
use serde_json::{Value, json};
use std::io::Write;

struct Turn {
    payload: SayPayload,
    cancel_after: Option<usize>,
}

fn turns(args: &[String]) -> (String, Vec<Turn>) {
    let (mut out, mut turns) = (None, Vec::new());
    let (mut attach, mut cancel_after) = (None, None);
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .unwrap_or_else(|| panic!("{flag} takes a value"));
        match flag.as_str() {
            "--out" => out = Some(value.clone()),
            "--attach" => attach = Some(vec![value.clone()]),
            "--cancel-after" => cancel_after = Some(value.parse().expect("a count")),
            "--say" => turns.push(Turn {
                payload: SayPayload {
                    text: value.clone(),
                    about: None,
                    now: None,
                    attachments: attach.take(),
                },
                cancel_after: cancel_after.take(),
            }),
            _ => panic!("unknown flag {flag}"),
        }
    }
    (out.expect("--out <file>"), turns)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (out, turns) = turns(&args);
    let core = Core::start();
    let mut lines = Vec::new();
    for turn in turns {
        lines.push(json!({ "said": turn.payload }));
        let mut events = core.client.stream::<_, Value, Value>("say", turn.payload);
        let mut deltas = 0;
        while let Some(event) = events.next() {
            let event = event.expect("the turn streams");
            if event["type"] == "TEXT_MESSAGE_CONTENT" {
                deltas += 1;
            }
            eprintln!("{}", event["type"]);
            lines.push(json!({ "event": event }));
            if turn.cancel_after.is_some_and(|n| deltas >= n) {
                events.interrupt();
                lines.push(json!({ "cancelled": deltas }));
                break;
            }
        }
    }
    let mut file = std::fs::File::create(&out).expect("the out file");
    for line in lines {
        writeln!(file, "{line}").expect("written");
    }
    core.stop();
}
