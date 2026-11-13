//! A pane on a core that speaks Desktop's own NDJSON frames: its `terminal` stream opens the
//! pane and draws a prompt, and every `terminalSend` input is kept. Nothing reaches a real pane.

use collie_desktop_board::App;
use collie_desktop_protocol::client::Client;
use rune::Runtime;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The bracketed paste the pane's program turned on, as Claude Code and Codex do.
pub const BRACKETED: &[u8] = b"\x1b[?2004h$ ";

pub type Change = Box<dyn FnOnce(&mut App) + Send>;
pub type Queued = Arc<Mutex<Vec<Change>>>;
/// What reached the pane: each `terminal.input`'s text, in order.
pub type Typed = Arc<Mutex<Vec<String>>>;

/// A core whose `terminal` stream opens the pane and draws `BRACKETED`, and which keeps the
/// text of every `terminalSend` input.
pub fn pane_core() -> (Client, Typed) {
    let (shell_reads, core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    let typed: Typed = Arc::default();
    let types = typed.clone();
    std::thread::spawn(move || {
        let mut out = core_writes;
        for line in BufReader::new(core_reads).lines() {
            let Ok(line) = line else { return };
            let frame: Value = serde_json::from_str(&line).unwrap();
            match frame["tag"].as_str() {
                Some("terminal") => {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD.encode(BRACKETED);
                    let chunk = json!({"_tag": "Chunk", "requestId": frame["id"], "values": [
                        {"_tag": "Opened", "at": {"session": null, "workspace": "Front door",
                            "tab": null, "pane": "wTJ:p1"}},
                        {"_tag": "Frame", "bytes": bytes},
                    ]});
                    writeln!(out, "{chunk}").unwrap();
                }
                Some("terminalSend") => {
                    let command = &frame["payload"]["command"];
                    if command["type"] == "terminal.input" {
                        let text = command["text"].as_str().unwrap_or_default().to_string();
                        types.lock().unwrap().push(text);
                    }
                    let exit = json!({"_tag": "Exit", "requestId": frame["id"],
                        "exit": {"_tag": "Success", "value": null}});
                    writeln!(out, "{exit}").unwrap();
                }
                _ => {}
            }
        }
    });
    (
        Client::new(BufReader::new(shell_reads), shell_writes).unwrap(),
        typed,
    )
}

/// Applies what the pane's stream posted until `done` holds, or fails after a while.
pub fn until(runtime: &mut Runtime<App>, queued: &Queued, done: impl Fn(&App) -> bool) {
    let by = Instant::now() + Duration::from_secs(5);
    while !done(&runtime.state) {
        assert!(Instant::now() < by, "the pane never got there");
        let changes = std::mem::take(&mut *queued.lock().unwrap());
        changes
            .into_iter()
            .for_each(|change| change(&mut runtime.state));
        std::thread::sleep(Duration::from_millis(5));
    }
    runtime.invalidate();
    runtime.frame(1.0);
}

/// What the pane was sent within a moment, once `expected` inputs have arrived or it is up.
pub fn typed_after(typed: &Typed, expected: usize) -> Vec<String> {
    let by = Instant::now() + Duration::from_millis(if expected == 0 { 300 } else { 5000 });
    while typed.lock().unwrap().len() < expected.max(1) && Instant::now() < by {
        std::thread::sleep(Duration::from_millis(5));
    }
    typed.lock().unwrap().clone()
}
