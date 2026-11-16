//! Files given to a Run's pane: pasted or dropped, staged on this computer, placed on the
//! pane's Machine with `placeFiles`, then typed into the pane as one paste of their quoted
//! paths there. The calls go to the fake core, and the pane's input to a core that speaks
//! Desktop's own NDJSON frames; nothing here reaches a real pane.

mod support;

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::calls::{CallError, Post};
use collie_desktop_board::shell::panes;
use collie_desktop_board::{App, view};
use collie_desktop_terminal::view::Link;
use rune::clipboard::MemoryClipboard;
use rune::{ClipboardContent, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use support::pane::{Queued, Typed, pane_core, typed_after, until};
use support::said;

const RUN: &str = "run-1.implement";

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

/// The pane's grid, as the app's emulator has it.
fn grid(runtime: &Runtime<App>) -> (u16, u16) {
    runtime.state.terminal.as_ref().expect("the pane").size()
}

// A grid that shrinks and grows back under a running program shifts what it drew by a row:
// a paste's status must leave the pane its size.
#[test]
fn a_paste_and_what_it_says_leave_the_pane_its_size() {
    let harness = Harness::new();
    let (mut runtime, _, _) = shown(&harness);
    let size = grid(&runtime);
    will_place(&harness);
    runtime.paste_content(ClipboardContent::new("shot.png").with_files(files()));
    runtime.frame(0.1);
    assert!(said(&runtime, "Placing files"));
    assert_eq!(grid(&runtime), size, "while placing");
    runtime.frame(1.5);
    settle(&harness, &mut runtime);
    assert_eq!(grid(&runtime), size, "once typed");

    harness
        .fake
        .will_answer("stagePaths", Ok(json!([staged("aa/shot.png", "shot.png")])));
    harness
        .fake
        .will_answer("placeFiles", Err(CallError("the disk is full".into())));
    runtime.paste_content(ClipboardContent::new("").with_files(files()[..1].to_vec()));
    runtime.frame(2.5);
    settle(&harness, &mut runtime);
    assert!(said(&runtime, "Nothing was pasted"));
    assert_eq!(grid(&runtime), size, "while it says why");
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
    let key = stage[0]["key"].as_str().unwrap();
    assert!(support::core_takes_key(key), "the core refuses {key}");
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
    assert!(
        runtime.state.nav.chat.is_open(),
        "the chat is beside the pane"
    );
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

/// A paste the platform reads, as Ctrl+V asks for one, into the chat's composer beside the pane.
fn paste_into_composer(
    runtime: &mut Runtime<App>,
    clipboard: &MemoryClipboard,
    held: ClipboardContent,
    at: f64,
) {
    clipboard.set_content(held);
    runtime.update(|_, tx| tx.request_paste());
    runtime.frame(at);
    runtime.frame(at + 0.1);
}

#[test]
fn a_paste_into_the_chat_beside_the_pane_attaches_there_and_types_nothing_into_the_pane() {
    let harness = Harness::new();
    let (mut runtime, _, typed) = shown(&harness);
    let clipboard = rune::clipboard::memory();
    runtime.use_clipboard(&clipboard);
    assert!(
        runtime.state.nav.chat.is_open(),
        "the chat is beside the pane"
    );
    let mut at = 3.0;
    support::tap(&mut runtime, "composer", &mut at);
    assert!(runtime.state.chat.composer.focused);

    // A screenshot: staged for the chat under a key the core takes, and never placed.
    use base64::Engine;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
    let png = base64::engine::general_purpose::STANDARD
        .decode(PNG)
        .unwrap();
    let shot = rune::ClipboardImage::from_png(png).unwrap();
    paste_into_composer(
        &mut runtime,
        &clipboard,
        ClipboardContent::new("").with_image(shot),
        at,
    );
    settle(&harness, &mut runtime);
    let stage = harness.fake.asked_of("stage");
    assert_eq!(stage.len(), 1, "{stage:?}");
    let key = stage[0]["key"].as_str().unwrap();
    assert!(support::core_takes_key(key), "the core refuses {key}");
    assert!(
        harness
            .fake
            .answer("stage", Ok(staged("cc/pasted.png", "pasted.png")))
    );
    settle(&harness, &mut runtime);
    assert!(
        runtime
            .state
            .chat
            .attached
            .iter()
            .any(|f| f.id == "cc/pasted.png")
    );

    // Files a file manager copied.
    paste_into_composer(
        &mut runtime,
        &clipboard,
        ClipboardContent::new("").with_files(files()),
        at + 1.0,
    );
    settle(&harness, &mut runtime);
    assert_eq!(
        harness.fake.asked_of("stagePaths"),
        [json!({"paths": ["/home/mk/Pictures/shot.png", "/home/mk/my notes.txt"]})]
    );

    // Words are typed into the composer as they always were.
    paste_into_composer(
        &mut runtime,
        &clipboard,
        ClipboardContent::new("what failed?"),
        at + 2.0,
    );
    settle(&harness, &mut runtime);
    assert_eq!(runtime.state.chat.composer.text, "what failed?");

    assert!(harness.fake.asked_of("placeFiles").is_empty());
    assert!(harness.fake.asked_of("clipboardFiles").is_empty());
    assert_eq!(
        typed_after(&typed, 0),
        Vec::<String>::new(),
        "the pane got nothing"
    );
}
