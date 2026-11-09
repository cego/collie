//! A pane's terminal against a fake core: a burst of resizes sends one size once it settles,
//! and leaving the tab interrupts the `terminal` stream, which has the core release the pane.

use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::generated::{Command, TerminalInput, TerminalPayload, Type};
use collie_desktop_terminal::pane::Pane;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::thread::JoinHandle;
use std::time::Duration;

/// A core that answers each `terminalSend`, and hands back every frame it heard once the
/// shell interrupts a stream.
fn core() -> (Client, JoinHandle<Vec<Value>>) {
    let (shell_reads, core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    let core = std::thread::spawn(move || {
        let mut out = core_writes;
        let mut heard = Vec::new();
        for line in BufReader::new(core_reads).lines() {
            let frame: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if frame["tag"] == "terminalSend" {
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

fn ms(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

#[test]
fn a_burst_of_resizes_sends_one_size_once_it_settles_and_leaving_sends_the_release() {
    let (client, core) = core();
    let (mut pane, frames) = Pane::open(
        &client,
        TerminalPayload {
            installation: "inst-local".into(),
            run_id: "run-1".into(),
            agent: None,
            cols: 80,
            rows: 24,
        },
    );
    pane.resized((90, 24), ms(0));
    pane.resized((100, 30), ms(40));
    pane.tick(ms(100));
    pane.tick(ms(160));
    pane.tick(ms(400));
    pane.send(Command::TerminalInput(TerminalInput {
        r#type: Type::TerminalInput,
        text: "ls\r".into(),
    }));
    pane.resized((120, 40), ms(500));
    pane.leave();
    let heard = core.join().unwrap();
    drop(frames);
    assert_eq!(
        heard,
        vec![
            json!({"_tag": "Hello"}),
            json!({"_tag": "Request", "id": 0, "tag": "terminal", "payload": {"installation": "inst-local", "runId": "run-1", "cols": 80, "rows": 24}, "headers": []}),
            json!({"_tag": "Request", "id": 1, "tag": "terminalSend", "payload": {"command": {"type": "terminal.resize", "cols": 100, "rows": 30}}, "headers": []}),
            json!({"_tag": "Request", "id": 2, "tag": "terminalSend", "payload": {"command": {"type": "terminal.input", "text": "ls\r"}}, "headers": []}),
            json!({"_tag": "Interrupt", "requestId": 0}),
        ]
    );
}

#[test]
fn an_opened_controller_is_told_its_size_at_once() {
    let (client, core) = core();
    let (mut pane, frames) = Pane::open(
        &client,
        TerminalPayload {
            installation: "inst-local".into(),
            run_id: "run-1".into(),
            agent: Some("implement".into()),
            cols: 80,
            rows: 24,
        },
    );
    pane.resized((100, 30), ms(0));
    pane.opened((100, 30));
    pane.tick(ms(1000));
    pane.leave();
    let heard = core.join().unwrap();
    drop(frames);
    assert_eq!(
        heard[2..],
        [
            json!({"_tag": "Request", "id": 1, "tag": "terminalSend", "payload": {"command": {"type": "terminal.resize", "cols": 100, "rows": 30}}, "headers": []}),
            json!({"_tag": "Interrupt", "requestId": 0}),
        ]
    );
}
