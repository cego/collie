//! The NDJSON client against transcripts of Effect's own client and server
//! (`bun run tools/rune-fixtures.ts`): a fake core plays the core's frames and checks that the
//! shell's are the ones Effect's client sent, in order.

use collie_desktop_protocol::client::{Client, RpcError};
use collie_desktop_protocol::generated::{ActionFailed, FlockItem, SyncNowPayload, SyncNowSuccess};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::channel;
use std::thread::JoinHandle;
use std::time::Duration;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures");

fn lines(path: &str) -> Vec<Value> {
    std::fs::read_to_string(format!("{FIXTURES}/{path}"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

/// A client wired to a core that plays `transcript`, then ends its stdout.
fn against(transcript: &str) -> (Client, JoinHandle<Result<(), String>>) {
    let (shell_reads, core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    let frames = lines(&format!("transcripts/{transcript}.ndjson"));
    let core = std::thread::spawn(move || {
        let mut heard = BufReader::new(core_reads);
        let mut out = core_writes;
        for line in frames {
            let frame = &line["frame"];
            if line["from"] == "core" {
                writeln!(out, "{frame}").map_err(|e| e.to_string())?;
                continue;
            }
            let mut said = String::new();
            heard.read_line(&mut said).map_err(|e| e.to_string())?;
            let said: Value = serde_json::from_str(&said).map_err(|e| format!("{e}: {said:?}"))?;
            if &said != frame {
                return Err(format!(
                    "the shell sent {said}, where Effect's client sent {frame}"
                ));
            }
        }
        drop(out);
        let rest: Vec<String> = heard.lines().map_while(Result::ok).collect();
        if rest.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "the shell sent more than Effect's client: {rest:?}"
            ))
        }
    });
    (
        Client::new(BufReader::new(shell_reads), shell_writes).unwrap(),
        core,
    )
}

/// A core that says `frames` once the shell has sent `heard` frames, and keeps running.
fn still_running(heard: usize, frames: Vec<Value>) -> (Client, JoinHandle<()>) {
    let (shell_reads, core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    let core = std::thread::spawn(move || {
        let mut said = BufReader::new(core_reads).lines();
        let mut out = core_writes;
        said.by_ref().take(heard).for_each(drop);
        frames
            .iter()
            .for_each(|frame| writeln!(out, "{frame}").unwrap());
        said.for_each(drop);
    });
    (
        Client::new(BufReader::new(shell_reads), shell_writes).unwrap(),
        core,
    )
}

type Synced = Result<SyncNowSuccess, RpcError<ActionFailed>>;
type Taken = Option<Result<FlockItem, RpcError<Value>>>;

/// What a request and a stream, both open, end with after `frame` from a core that keeps running.
fn open_calls_after(frame: Value) -> (Synced, Taken) {
    // Hello, flock and syncNow.
    let (client, core) = still_running(3, vec![frame]);
    let (done, outcome) = channel();
    let asker = client.clone();
    std::thread::spawn(move || {
        let mut flock = asker.stream::<_, FlockItem, Value>("flock", ());
        let build = SyncNowPayload {
            profile: "build".into(),
        };
        let synced = asker.request::<_, SyncNowSuccess, ActionFailed>("syncNow", &build);
        let ended = flock.next();
        assert!(flock.next().is_none());
        done.send((synced, ended)).unwrap();
    });
    let outcome = outcome
        .recv_timeout(Duration::from_secs(10))
        .expect("the open calls ended");
    drop(client);
    core.join().unwrap();
    outcome
}

fn the_flock() -> Vec<FlockItem> {
    lines("flock.ndjson")
        .into_iter()
        .map(|item| serde_json::from_value(item).unwrap())
        .collect()
}

#[test]
fn a_request_is_answered_and_another_refused() {
    let (client, core) = against("answered");
    let build = SyncNowPayload {
        profile: "build".into(),
    };
    let synced: SyncNowSuccess = client
        .request::<_, _, ActionFailed>("syncNow", &build)
        .unwrap();
    assert_eq!(synced.said, "Synced Build box");
    let gone = SyncNowPayload {
        profile: "gone".into(),
    };
    let refused = client.request::<_, SyncNowSuccess, ActionFailed>("syncNow", &gone);
    match refused {
        Err(RpcError::Failed(failed)) => assert_eq!(failed.reason, "no Machine is called gone"),
        other => panic!("expected ActionFailed, got {other:?}"),
    }
    drop(client);
    core.join().unwrap().unwrap();
}

#[test]
fn a_stream_gives_its_chunks_in_order_and_acks_each() {
    let (client, core) = against("stream");
    let items: Vec<FlockItem> = client
        .stream::<_, FlockItem, Value>("flock", ())
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(items, the_flock());
    drop(client);
    core.join().unwrap().unwrap();
}

#[test]
fn the_shell_interrupts_a_stream_it_is_done_with() {
    let (client, core) = against("interrupt");
    let mut flock = client.stream::<_, FlockItem, Value>("flock", ());
    let first: Vec<FlockItem> = flock.by_ref().take(3).map(Result::unwrap).collect();
    assert_eq!(first, the_flock()[..3]);
    flock.interrupt();
    drop((flock, client));
    core.join().unwrap().unwrap();
}

#[test]
fn the_core_exiting_mid_stream_ends_it_with_an_error_naming_the_core() {
    let (client, core) = against("core-gone");
    let mut flock = client.stream::<_, FlockItem, Value>("flock", ());
    let before: Vec<FlockItem> = flock.by_ref().take(6).map(Result::unwrap).collect();
    assert_eq!(before, the_flock()[..6]);
    let ended = flock.next().expect("the stream ends with an error");
    match ended {
        Err(error @ RpcError::CoreGone) => assert!(error.to_string().contains("Desktop core")),
        other => panic!("expected the core gone, got {other:?}"),
    }
    assert!(flock.next().is_none());
    drop((flock, client));
    core.join().unwrap().unwrap();
}

#[test]
fn a_defect_from_the_core_fails_every_open_call() {
    let (synced, ended) = open_calls_after(json!({"_tag": "Defect", "defect": "the server died"}));
    assert_eq!(synced, Err(RpcError::Defect(json!("the server died"))));
    assert_eq!(ended, Some(Err(RpcError::Defect(json!("the server died")))));
}

#[test]
fn a_protocol_error_from_the_core_fails_every_open_call() {
    let (synced, ended) =
        open_calls_after(json!({"_tag": "ClientProtocolError", "error": "bad frame"}));
    assert!(matches!(synced, Err(RpcError::Protocol(why)) if why.contains("bad frame")));
    assert!(matches!(ended, Some(Err(RpcError::Protocol(why))) if why.contains("bad frame")));
}
