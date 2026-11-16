//! The board on a made-up Flock, with no core, for looking at a screen headlessly:
//! `cargo run -p collie-desktop-board --example scene -- <scene> --snap out.png`.
//! Scenes: `answer` (a question with options), `words` (a question answered in words), `pr400`
//! (a working card whose pull request two Machines hold).

use collie_desktop_board::{App, shell::view};
use rune::AppSpec;
use serde_json::{Value, json};

const NOW: f64 = 1_800_000_000_000.0;

fn task(id: &str, name: &str, state: &str, more: Value) -> Value {
    let mut task = json!({
        "id": id, "name": name, "project": "collie", "state": state, "steps": [],
        "sentence": format!("{name} is under way."), "age": "5m", "drift": null, "held": null,
        "heldBy": null, "decision": null, "agents": [], "children": [], "mr": null,
        "branch": null, "disposition": null, "landed": false, "ended": null, "mrState": null,
        "planReady": false, "offer": null, "run": format!("r-{id}"), "runs": [format!("r-{id}")],
        "at": NOW - 60_000.0,
    });
    for (key, value) in more.as_object().into_iter().flatten() {
        task[key] = value.clone();
    }
    task
}

fn question(id: &str, text: &str, options: Value) -> Value {
    json!({"kind": "question", "run": "r-t1", "id": id, "step": "plan", "topic": "the path",
        "text": text, "options": options})
}

fn machine(installation: &str, name: &str, tasks: Vec<Value>) -> Value {
    json!({"machine": {"installation": installation, "profile": format!("p-{name}"), "name": name},
        "message": {"_tag": "Snapshot", "installation": installation, "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "seq": 1, "tasks": tasks}})
}

fn pr400(id: &str, age: &str) -> Value {
    task(
        id,
        "Fix Desktop retaining a broken VM chat channel",
        "active",
        json!({"project": "/home/mk/collie", "branch": "desktop-replaces-a-dead-chat-channel",
            "sentence": "Running startup-final-tests, 16 s.", "age": age,
            "agents": [{"name": "build", "status": "working", "now": null, "run": format!("r-{id}")}],
            "mr": "https://github.com/cego/collie/pull/400", "mrState": "open",
            "flow": {"glyphs": [{"title": "build", "state": "running"}], "release": 0.0, "current": null}}),
    )
}

fn make() -> App {
    let scene = std::env::args().nth(1).unwrap_or_else(|| "answer".into());
    if scene == "pr400" {
        let mut app = App::default();
        app.board.clock = Some(NOW);
        app.board.utc_offset = Some(0);
        app.nav.chat.set_open(false);
        for one in [
            machine("inst-laptop", "mk-laptop", vec![pr400("t1", "22h")]),
            machine("inst-vm", "vm-mk", vec![pr400("t2", "21h")]),
        ] {
            app.apply(serde_json::from_value(one).unwrap());
        }
        return app;
    }
    let asked = match scene.as_str() {
        "words" => question("c1", "What should the new endpoint be called?", json!([])),
        _ => question(
            "c1",
            "The redirect breaks old bookmarks. Keep the old path working while the new one ships?",
            json!([
                {"id": "yes", "title": "Keep both paths", "subtitle": "Old links keep working for a release"},
                {"id": "no", "title": "Drop the old path", "subtitle": null},
            ]),
        ),
    };
    let snapshot = json!({"machine": {"installation": "inst-pc", "profile": "p-pc", "name": "mk-pc"},
        "message": {"_tag": "Snapshot", "installation": "inst-pc", "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "seq": 1,
        "tasks": [task("t1", "Fix the redirect", "blocked", json!({"decision": asked, "questions": [asked]}))]}});
    let mut app = App::default();
    app.board.clock = Some(NOW);
    app.board.utc_offset = Some(0);
    app.apply(serde_json::from_value(snapshot).unwrap());
    app.answer_questions("inst-pc:t1");
    app
}

fn main() {
    rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        ..AppSpec::new("Collie scene", (1280.0, 860.0), make, view)
    })
    .run();
}
