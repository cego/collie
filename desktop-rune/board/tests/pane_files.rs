//! Files given to a Run's pane: pasted or dropped, staged on this computer, placed on the
//! pane's Machine with `placeFiles`, then typed into the pane as one paste of their quoted
//! paths there. The calls go to the fake core, and the pane's input to a core that speaks
//! Desktop's own NDJSON frames; nothing here reaches a real pane.

mod support;

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::calls::{CallError, Post};
use collie_desktop_board::shell::panes;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::client::Client;
use collie_desktop_terminal::view::Link;
use rune::{ClipboardContent, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use support::said;

const RUN: &str = "run-1.implement";
/// The bracketed paste the pane's program turned on, as Claude Code and Codex do.
const BRACKETED: &[u8] = b"\x1b[?2004h$ ";

type Change = Box<dyn FnOnce(&mut App) + Send>;
type Queued = Arc<Mutex<Vec<Change>>>;
/// What reached the pane: each `terminal.input`'s text, in order.
type Typed = Arc<Mutex<Vec<String>>>;

/// A core whose `terminal` stream opens the pane and draws `BRACKETED`, and which keeps the
/// text of every `terminalSend` input.
fn pane_core() -> (Client, Typed) {
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

fn snapshot() -> Value {
    json!({"machine": {"installation": "i-vm", "profile": "p-vm", "name": "vm-mk"},
        "message": {"_tag": "Snapshot", "installation": "i-vm", "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "tasks": [{
            "id": "t1", "name": "Front door", "project": "content", "state": "active",
            "steps": [], "sentence": "Front door is under way.", "age": "5m", "drift": null,
            "held": null, "heldBy": null, "decision": null, "agents": [{"name": "run-1-imp-r1",
            "role": "implementer", "status": "working", "now": null, "run": RUN}],
            "children": [], "mr": null, "branch": null, "disposition": null, "landed": false,
            "ended": null, "mrState": null, "planReady": false, "offer": null, "run": RUN,
            "runs": [RUN], "at": 0.0}],
        "seq": 1}})
}

/// The record of vm-mk's Run open on Terminal, its pane live and drawn.
fn shown(harness: &Harness<App>) -> (Runtime<App>, Queued, Typed) {
    let (client, typed) = pane_core();
    let queued: Queued = Arc::default();
    let into = queued.clone();
    let post: Post<App> = Arc::new(move |change| into.lock().unwrap().push(change));
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.apply(serde_json::from_value(snapshot()).unwrap());
    app.go_to = Some(panes::opener(client, post));
    app.go_to_pane("i-vm".into(), RUN.into(), "vm-mk".into());
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 860.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.on_key = Some(collie_desktop_board::shell::on_key);
    runtime.frame(0.0);
    until(&mut runtime, &queued, |app| {
        app.terminal
            .as_ref()
            .is_some_and(|t| t.link() == Link::Live)
            && app
                .terminal
                .as_ref()
                .is_some_and(|t| t.frame().line(0).starts_with('$'))
    });
    (runtime, queued, typed)
}

/// Applies what the pane's stream posted until `done` holds, or fails after a while.
fn until(runtime: &mut Runtime<App>, queued: &Queued, done: impl Fn(&App) -> bool) {
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
fn typed_after(typed: &Typed, expected: usize) -> Vec<String> {
    let by = Instant::now() + Duration::from_millis(if expected == 0 { 300 } else { 5000 });
    while typed.lock().unwrap().len() < expected.max(1) && Instant::now() < by {
        std::thread::sleep(Duration::from_millis(5));
    }
    typed.lock().unwrap().clone()
}

fn settle(harness: &Harness<App>, runtime: &mut Runtime<App>) {
    for _ in 0..4 {
        harness.settle(&mut runtime.state);
        runtime.invalidate();
        runtime.frame(2.0);
    }
}

fn staged(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "size": 4.0, "mediaType": "image/png",
        "path": format!("/home/mk/.local/state/collie-desktop/attachments/{id}")})
}

fn files() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/home/mk/Pictures/shot.png"),
        PathBuf::from("/home/mk/my notes.txt"),
    ]
}

/// The fake core stages both files and places them on vm-mk's uploads.
fn will_place(harness: &Harness<App>) {
    harness.fake.will_answer(
        "stagePaths",
        Ok(json!([
            staged("aa/shot.png", "shot.png"),
            staged("bb/my notes.txt", "my notes.txt")
        ])),
    );
    harness.fake.will_answer(
        "placeFiles",
        Ok(json!([
            "/srv/collie/uploads/aa/shot.png",
            "/srv/collie/uploads/bb/my notes.txt"
        ])),
    );
}

const PLACED: &str =
    "\x1b[200~/srv/collie/uploads/aa/shot.png '/srv/collie/uploads/bb/my notes.txt'\x1b[201~";

#[test]
fn a_paste_with_files_stages_places_and_types_their_quoted_paths_on_the_machine() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    will_place(&harness);
    runtime.paste_content(ClipboardContent::new("shot.png").with_files(files()));
    runtime.frame(1.5);
    settle(&harness, &mut runtime);

    assert_eq!(
        harness.fake.asked_of("stagePaths"),
        [json!({"paths": ["/home/mk/Pictures/shot.png", "/home/mk/my notes.txt"]})]
    );
    assert_eq!(
        harness.fake.asked_of("placeFiles"),
        [json!({"installation": "i-vm", "ids": ["aa/shot.png", "bb/my notes.txt"]})]
    );
    // One bracketed paste, and no Enter.
    assert_eq!(typed_after(&typed, 1), [PLACED]);
    assert!(!said(&runtime, "Placing files"), "the status stayed up");
}

#[test]
fn files_dropped_on_the_shown_pane_are_typed_as_their_paths_on_its_machine() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    will_place(&harness);
    runtime.drop_files(files(), Some((640.0, 500.0)));
    runtime.frame(1.5);
    settle(&harness, &mut runtime);
    assert_eq!(typed_after(&typed, 1), [PLACED]);
}

#[test]
fn ctrl_v_with_files_on_the_clipboard_gives_them_and_without_types_ctrl_v() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    let clipboard = rune::clipboard::memory();
    runtime.use_clipboard(&clipboard);
    let ctrl_v = KeyEvent {
        key: Key::Command('v'),
        mods: Mods {
            ctrl: true,
            cmd: true,
            ..Mods::default()
        },
    };

    clipboard.set_text("just words");
    runtime.key(ctrl_v.clone());
    runtime.frame(1.5);
    runtime.frame(1.6);
    assert_eq!(typed_after(&typed, 1), ["\x16"]);
    assert!(harness.fake.asked_of("stagePaths").is_empty());

    will_place(&harness);
    clipboard.set_content(ClipboardContent::new("").with_files(files()));
    runtime.key(ctrl_v);
    runtime.frame(1.7);
    runtime.frame(1.8);
    settle(&harness, &mut runtime);
    assert_eq!(typed_after(&typed, 2), ["\x16", PLACED]);
}

#[test]
fn a_file_that_cannot_be_placed_is_said_and_nothing_is_typed() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    harness
        .fake
        .will_answer("stagePaths", Ok(json!([staged("aa/shot.png", "shot.png")])));
    harness.fake.will_answer(
        "placeFiles",
        Err(CallError(
            "shot.png could not be placed on vm-mk: the disk is full".into(),
        )),
    );
    runtime.paste_content(ClipboardContent::new("").with_files(files()[..1].to_vec()));
    runtime.frame(1.5);
    settle(&harness, &mut runtime);
    assert!(said(
        &runtime,
        "Nothing was pasted: shot.png could not be placed on vm-mk: the disk is full"
    ));

    // One refused while staging is not placed either, and its reason is said.
    harness.fake.will_answer(
        "stagePaths",
        Ok(json!([
            staged("aa/shot.png", "shot.png"),
            {"refused": "/home/mk/my notes.txt cannot be read"}
        ])),
    );
    runtime.drop_files(files(), Some((640.0, 500.0)));
    runtime.frame(2.5);
    settle(&harness, &mut runtime);
    assert!(said(
        &runtime,
        "Nothing was pasted: /home/mk/my notes.txt cannot be read"
    ));
    assert_eq!(harness.fake.asked_of("placeFiles").len(), 1);
    assert_eq!(typed_after(&typed, 0), Vec::<String>::new());
}

#[test]
fn a_text_paste_is_typed_as_it_always_was() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    runtime.paste("git status");
    runtime.frame(1.5);
    settle(&harness, &mut runtime);
    assert_eq!(typed_after(&typed, 1), ["\x1b[200~git status\x1b[201~"]);
    assert!(harness.fake.asked_of("stagePaths").is_empty());
    assert!(harness.fake.asked_of("clipboardFiles").is_empty());
}

#[test]
fn a_path_is_quoted_only_where_a_shell_would_split_or_expand_it() {
    use collie_desktop_board::shell::shell_quoted;
    assert_eq!(
        shell_quoted("/srv/up/a-b_c.1/x.png"),
        "/srv/up/a-b_c.1/x.png"
    );
    assert_eq!(
        shell_quoted("/srv/up/my notes.txt"),
        "'/srv/up/my notes.txt'"
    );
    assert_eq!(shell_quoted("/srv/it's $HOME"), r"'/srv/it'\''s $HOME'");
}

#[test]
fn a_pasted_screenshot_is_staged_in_parts_placed_and_typed_as_its_path() {
    use base64::Engine;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
    let png = base64::engine::general_purpose::STANDARD
        .decode(PNG)
        .unwrap();
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    harness
        .fake
        .will_answer("stage", Ok(staged("cc/pasted.png", "pasted.png")));
    harness.fake.will_answer(
        "placeFiles",
        Ok(json!(["/srv/collie/uploads/cc/pasted.png"])),
    );
    let image = rune::ClipboardImage::from_png(png.clone()).unwrap();
    runtime.paste_content(ClipboardContent::new("").with_image(image));
    runtime.frame(1.5);
    settle(&harness, &mut runtime);
    let stage = harness.fake.asked_of("stage");
    assert_eq!(stage.len(), 1, "{stage:?}");
    assert_eq!(
        (
            &stage[0]["mediaType"],
            &stage[0]["offset"],
            &stage[0]["content"]
        ),
        (&json!("image/png"), &json!(0), &json!(PNG))
    );
    assert_eq!(
        harness.fake.asked_of("placeFiles"),
        [json!({"installation": "i-vm", "ids": ["cc/pasted.png"]})]
    );
    assert_eq!(
        typed_after(&typed, 1),
        ["\x1b[200~/srv/collie/uploads/cc/pasted.png\x1b[201~"]
    );
}

#[test]
fn files_dropped_on_the_chat_beside_the_pane_go_to_the_chat_not_the_pane() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    runtime.update(|app, _| app.toggle_chat());
    for at in [3.0, 3.5, 4.0] {
        runtime.frame(at);
    }
    let (x, y) = runtime
        .find(&support::path_of(&runtime, "chat").expect("no chat pane"))
        .unwrap();
    runtime.drop_files(files(), Some((x, y)));
    runtime.frame(4.5);
    settle(&harness, &mut runtime);
    assert_eq!(
        harness.fake.asked_of("stagePaths"),
        [json!({"paths": ["/home/mk/Pictures/shot.png", "/home/mk/my notes.txt"]})]
    );
    assert!(harness.fake.asked_of("placeFiles").is_empty());
    assert_eq!(typed_after(&typed, 0), Vec::<String>::new());
}
