//! Go to pane's live path: `panes::opener` over a core that speaks Desktop's own NDJSON frames,
//! answering `terminal` as `openTerminal` does, then the record says what came of it. Nothing
//! here reaches a real pane.

mod support;

use collie_desktop_board::calls::Post;
use collie_desktop_board::shell::panes;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::client::Client;
use collie_desktop_terminal::view::Link;
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::said;

type Change = Box<dyn FnOnce(&mut App) + Send>;
/// Each frame the shell sent the core, when it arrived.
type Heard = Arc<Mutex<Vec<(Instant, Value)>>>;

/// A core that answers the `terminal` stream with `replies`, each sent after the shell acks
/// the one before, as Effect's RPC server waits on its acks; each `terminalSend` is answered,
/// and every frame the shell sent is handed back.
fn core(replies: Vec<Value>) -> (Client, Heard) {
    let (shell_reads, core_writes) = std::io::pipe().unwrap();
    let (core_reads, shell_writes) = std::io::pipe().unwrap();
    let heard: Heard = Arc::default();
    let hears = heard.clone();
    std::thread::spawn(move || {
        let mut out = core_writes;
        let mut replies = replies.into_iter();
        let mut stream = None;
        for line in BufReader::new(core_reads).lines() {
            let Ok(line) = line else { return };
            let frame: Value = serde_json::from_str(&line).unwrap();
            hears.lock().unwrap().push((Instant::now(), frame.clone()));
            let next = match (frame["_tag"].as_str(), frame["tag"].as_str()) {
                (Some("Request"), Some("terminal")) => {
                    stream = Some(frame["id"].clone());
                    replies.next()
                }
                (Some("Ack"), _) => replies.next(),
                (Some("Request"), Some("terminalSend")) => {
                    let exit = json!({"_tag": "Exit", "requestId": frame["id"],
                        "exit": {"_tag": "Success", "value": null}});
                    writeln!(out, "{exit}").unwrap();
                    None
                }
                _ => None,
            };
            if let (Some(mut reply), Some(id)) = (next, stream.clone()) {
                reply["requestId"] = id;
                writeln!(out, "{reply}").unwrap();
            }
        }
    });
    (
        Client::new(BufReader::new(shell_reads), shell_writes).unwrap(),
        heard,
    )
}

fn chunk(values: Vec<Value>) -> Value {
    json!({"_tag": "Chunk", "values": values})
}

fn opened() -> Value {
    json!({"_tag": "Opened", "at": {"session": null, "workspace": "Front door", "tab": null,
        "pane": "wTJ:p1"}})
}

fn success() -> Value {
    json!({"_tag": "Exit", "exit": {"_tag": "Success"}})
}

fn failure(reason: &str) -> Value {
    json!({"_tag": "Exit", "exit": {"_tag": "Failure", "cause": [{"_tag": "Fail",
        "error": {"_tag": "ActionFailed", "reason": reason}}]}})
}

/// An app whose panes open on `client`, its changes queued for the test to apply.
fn app(client: Client) -> (App, Arc<Mutex<Vec<Change>>>) {
    let queued: Arc<Mutex<Vec<Change>>> = Arc::default();
    let into = queued.clone();
    let post: Post<App> = Arc::new(move |change| into.lock().unwrap().push(change));
    let mut app = App::default();
    app.go_to = Some(panes::opener(client, post));
    app.go_to_pane("i-vm".into(), "run-1".into(), "vm-mk".into());
    (app, queued)
}

/// Applies what the stream posted until `done` holds, or fails after a while.
fn until(app: &mut App, queued: &Arc<Mutex<Vec<Change>>>, done: impl Fn(&App) -> bool) {
    let by = Instant::now() + Duration::from_secs(5);
    while !done(app) {
        assert!(Instant::now() < by, "the pane never got there");
        let changes = std::mem::take(&mut *queued.lock().unwrap());
        changes.into_iter().for_each(|change| change(app));
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn link(app: &App) -> Link {
    app.terminal.as_ref().unwrap().link()
}

fn drawn(app: App) -> Runtime<App> {
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 860.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

#[test]
fn a_stream_that_ends_without_saying_why_says_the_pane_disconnected() {
    let (client, _) = core(vec![chunk(vec![opened()]), success()]);
    let (mut app, queued) = app(client);
    until(&mut app, &queued, |app| {
        !matches!(link(app), Link::Connecting | Link::Live)
    });
    assert_eq!(
        link(&app),
        Link::Ended("the core closed the pane's stream".into())
    );
    let runtime = drawn(app);
    assert!(said(
        &runtime,
        "The pane disconnected: the core closed the pane's stream"
    ));
}

#[test]
fn a_pane_the_core_cannot_open_says_why_in_its_words() {
    let (client, _) = core(vec![failure("that Machine is not connected")]);
    let (mut app, queued) = app(client);
    until(&mut app, &queued, |app| link(app) != Link::Connecting);
    assert_eq!(
        link(&app),
        Link::Failed("that Machine is not connected".into())
    );
}

#[test]
fn a_socket_that_breaks_says_which_connection_broke() {
    let reason = "vm-mk's core: SocketError: An error occurred during Read";
    let (client, _) = core(vec![chunk(vec![opened()]), failure(reason)]);
    let (mut app, queued) = app(client);
    until(&mut app, &queued, |app| matches!(link(app), Link::Ended(_)));
    let runtime = drawn(app);
    assert!(said(
        &runtime,
        &format!("The pane disconnected: the connection to vm-mk's terminal broke ({reason})")
    ));
}

#[test]
fn a_key_reaches_the_core_within_a_few_milliseconds() {
    let (client, heard) = core(vec![chunk(vec![opened()])]);
    let (mut app, queued) = app(client);
    until(&mut app, &queued, |app| link(app) == Link::Live);
    let pressed = Instant::now();
    app.terminal.as_mut().unwrap().paste("y");
    let by = Instant::now() + Duration::from_secs(5);
    let reached = loop {
        let found =
            heard.lock().unwrap().iter().find_map(|(at, frame)| {
                (frame["payload"]["command"]["text"] == "y").then_some(*at)
            });
        if let Some(at) = found {
            break at;
        }
        assert!(Instant::now() < by, "the key never reached the core");
        std::thread::sleep(Duration::from_millis(1));
    };
    let took = reached.duration_since(pressed);
    eprintln!("key to terminalSend: {took:?}");
    assert!(took < Duration::from_millis(20), "{took:?}");
}
