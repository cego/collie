//! The Artefacts page: the Flock's retained material searched across Runs and Machines through
//! the fake core, each result opened on its owning Run's record.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::record::artefacts::Preview;
use collie_desktop_board::shell::Page;
use rune::Runtime;
use rune::edit::TextEdit;
use serde_json::{Value, json};
use support::{flock_app, runtime, said, settle, tap};

fn item(installation: &str, run: &str, id: &str, title: &str, media: &str, bytes: &[u8]) -> Value {
    use sha2::Digest;
    json!({"installation": installation, "id": id, "run": run, "kind": "file", "role": "handoff",
        "title": title, "ref": format!("handoff:{title}"), "source": format!("/runs/{run}/handoffs/{title}"),
        "mediaType": media, "size": bytes.len(), "revision": 2,
        "digest": format!("{:x}", sha2::Sha256::digest(bytes)),
        "created": null, "updated": null, "registeredAt": "2026-01-01T00:00:00Z",
        "observedAt": "2026-11-01T00:00:00Z", "detectedAt": "2026-11-01T00:00:00Z", "seen": null,
        "sourceAvailability": "available", "retainedAvailability": "available", "reason": null})
}

fn found(machine: &str, item: Value) -> Value {
    json!({"installation": item["installation"], "machine": machine, "item": item})
}

fn searched(installation: &str, machine: &str, runs: i64, indexed: i64) -> Value {
    json!({"installation": installation, "machine": machine, "state": "searched", "reason": null,
        "runs": runs, "indexed": indexed})
}

fn away(installation: Value, machine: &str, reason: &str) -> Value {
    json!({"installation": installation, "machine": machine, "state": "unreachable",
        "reason": reason, "runs": 0, "indexed": 0})
}

fn page(items: Vec<Value>, next: Value, machines: Vec<Value>) -> Value {
    json!({"items": items, "next": next, "machines": machines, "complete": false})
}

fn notes_vm() -> Value {
    item(
        "i-vm",
        "r-old",
        "a1",
        "old-notes.md",
        "text/markdown",
        b"# Old notes\n",
    )
}

fn notes_pc() -> Value {
    item(
        "i-pc",
        "r-new",
        "b1",
        "new-notes.txt",
        "text/plain",
        b"new notes\n",
    )
}

fn detail(run: &str) -> Value {
    json!({
        "id": run, "dir": format!("/runs/{run}"), "title": "Build it", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": []
    })
}

/// The record a result opened, told its details and its Run's artefacts.
fn record_of(harness: &Harness<App>, runtime: &mut Runtime<App>, run: &str, items: Vec<Value>) {
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail": detail(run), "asOf": null, "bytes": 100})),
    );
    settle(harness, runtime);
    harness
        .fake
        .answer("artefacts", Ok(json!({"items": items})));
    settle(harness, runtime);
}

fn opened(harness: &Harness<App>) -> Runtime<App> {
    let mut app = flock_app(harness);
    app.open_page(Page::Artefacts);
    runtime(app)
}

fn rows(runtime: &Runtime<App>) -> Vec<(String, String, bool)> {
    runtime
        .state
        .pages
        .artefacts
        .found
        .iter()
        .map(|one| {
            (
                one.found.installation.clone(),
                one.found.item.id.clone(),
                one.stale,
            )
        })
        .collect()
}

#[test]
fn the_page_searches_every_machine_names_what_it_could_not_search_and_loads_more_by_cursor() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    assert_eq!(harness.fake.asked_of("artefactSearch"), [json!({})]);
    harness.fake.answer(
        "artefactSearch",
        Ok(page(
            vec![found("vm", notes_vm())],
            json!("cursor-1"),
            vec![
                searched("i-vm", "vm", 3, 2),
                away(Value::Null, "laptop", "Desktop is not connected to it"),
            ],
        )),
    );
    settle(&harness, &mut runtime);
    runtime.frame(100.0);
    assert!(said(&runtime, "old-notes.md"));
    assert!(said(&runtime, "vm · r-old"));
    assert!(said(
        &runtime,
        "laptop was not searched: Desktop is not connected to it"
    ));
    assert!(said(
        &runtime,
        "vm has indexed 2 of its 3 retained Runs so far"
    ));
    let mut at = 200.0;
    tap(&mut runtime, "artefacts-more", &mut at);
    assert_eq!(
        harness.fake.asked_of("artefactSearch")[1],
        json!({"cursor": "cursor-1"})
    );
    harness.fake.answer(
        "artefactSearch",
        Ok(page(
            vec![found("mk-pc", notes_pc())],
            Value::Null,
            vec![
                searched("i-vm", "vm", 3, 3),
                searched("i-pc", "mk-pc", 1, 1),
            ],
        )),
    );
    settle(&harness, &mut runtime);
    assert_eq!(
        rows(&runtime),
        [
            ("i-vm".into(), "a1".into(), false),
            ("i-pc".into(), "b1".into(), false)
        ]
    );
    runtime.frame(at);
    assert!(runtime.find("artefacts-more").is_none());
}

#[test]
fn the_named_fields_and_unseen_filter_ask_again_and_a_late_answer_to_an_older_search_is_dropped() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let tree = runtime.accessibility_json().to_string();
    for name in [
        "Search names, descriptions, URLs and paths",
        "Run, as its id or machine:run",
        "Kind",
        "Role",
        "Unseen only",
        "Search",
    ] {
        assert!(tree.contains(name), "{name} missing from {tree}");
    }
    runtime.update(|app, _| {
        let state = &mut app.pages.artefacts;
        state.query = TextEdit::new(" notes ");
        state.run = TextEdit::new("vm:r-old");
        state.kind = TextEdit::new("file");
        state.role = TextEdit::new("handoff");
        app.search_artefacts();
    });
    let mut at = 100.0;
    tap(&mut runtime, "artefacts-unseen", &mut at);
    let asked = harness.fake.asked_of("artefactSearch");
    assert_eq!(
        asked[1..],
        [
            json!({"query": "notes", "run": "vm:r-old", "kind": "file", "role": "handoff"}),
            json!({"query": "notes", "run": "vm:r-old", "kind": "file", "role": "handoff", "unseen": true}),
        ]
    );
    // The first search, opened with the page, answers last of all.
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("mk-pc", notes_pc())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    assert!(rows(&runtime).is_empty());
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("mk-pc", notes_pc())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    assert!(rows(&runtime).is_empty());
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("vm", notes_vm())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    assert_eq!(rows(&runtime), [("i-vm".into(), "a1".into(), false)]);

    // Reopening the page asks again; the answer to the search before it changes nothing.
    runtime.update(|app, _| {
        app.search_artefacts();
        app.open_page(Page::Board);
        app.open_page(Page::Artefacts);
    });
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("mk-pc", notes_pc())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    assert_eq!(rows(&runtime), [("i-vm".into(), "a1".into(), false)]);
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    assert!(runtime.state.record.open.is_none());
}

#[test]
fn a_machine_gone_unreachable_keeps_its_earlier_results_visibly_stale_and_takes_no_seen_for_them() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    harness.fake.answer(
        "artefactSearch",
        Ok(page(
            vec![found("vm", notes_vm()), found("mk-pc", notes_pc())],
            Value::Null,
            vec![
                searched("i-vm", "vm", 1, 1),
                searched("i-pc", "mk-pc", 1, 1),
            ],
        )),
    );
    settle(&harness, &mut runtime);
    runtime.update(|app, _| app.search_artefacts());
    harness.fake.answer(
        "artefactSearch",
        Ok(page(
            vec![found("mk-pc", notes_pc())],
            Value::Null,
            vec![
                away(json!("i-vm"), "vm", "its host did not answer in time"),
                searched("i-pc", "mk-pc", 1, 1),
            ],
        )),
    );
    settle(&harness, &mut runtime);
    assert_eq!(
        rows(&runtime),
        [
            ("i-pc".into(), "b1".into(), false),
            ("i-vm".into(), "a1".into(), true)
        ]
    );
    runtime.frame(100.0);
    assert!(said(
        &runtime,
        "Saved from an earlier search; vm is unreachable"
    ));
    runtime.update(|app, _| app.mark_found(1, true));
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    let stale = within(&runtime.accessibility_json())
        .into_iter()
        .find(|node| node["key"] == "found-i-vm-r-old-a1")
        .cloned()
        .expect("the stale row");
    let seen = within(&stale)
        .into_iter()
        .find(|node| node["key"] == "found-seen")
        .cloned()
        .expect("its seen control");
    assert!(
        seen["states"]
            .as_array()
            .is_some_and(|s| s.iter().any(|one| one == "disabled")),
        "{seen}"
    );

    let mut at = 200.0;
    tap(&mut runtime, "found-i-pc-r-new-b1/found-seen", &mut at);
    let asked = harness.fake.asked_of("artefactSeen");
    assert_eq!(asked.len(), 1);
    assert_eq!(
        (
            &asked[0]["installation"],
            &asked[0]["runId"],
            &asked[0]["id"],
            &asked[0]["revision"]
        ),
        (&json!("i-pc"), &json!("r-new"), &json!("b1"), &json!(2))
    );
    // Nothing is marked here until the host says so.
    assert!(
        runtime.state.pages.artefacts.found[0]
            .found
            .item
            .seen
            .is_none()
    );
    let mut seen = notes_pc();
    seen["seen"] = json!({"revision": 2, "at": "2026-11-13T00:00:00Z"});
    harness.fake.answer("artefactSeen", Ok(seen));
    settle(&harness, &mut runtime);
    assert_eq!(
        runtime.state.pages.artefacts.found[0]
            .found
            .item
            .seen
            .as_ref()
            .map(|s| s.revision),
        Some(2)
    );
}

#[test]
fn opening_a_result_reaches_its_owning_runs_exact_artefact_and_back_returns_to_the_page() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("vm", notes_vm())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    runtime.update(|app, _| app.board.opened = Some("card-from-an-earlier-record".into()));
    let mut at = 100.0;
    tap(&mut runtime, "found-i-vm-r-old-a1/found-open", &mut at);
    let record = runtime.state.record.open.as_ref().unwrap();
    assert_eq!(
        (record.installation.as_str(), record.run.as_str()),
        ("i-vm", "r-old")
    );
    assert_eq!(runtime.state.nav.page, Page::Board);
    assert_eq!(
        harness.fake.asked_of("runDetail"),
        [json!({"installation": "i-vm", "runId": "r-old"})]
    );
    record_of(
        &harness,
        &mut runtime,
        "r-old",
        vec![
            notes_vm(),
            item("i-vm", "r-old", "a0", "other.txt", "text/plain", b"other"),
        ],
    );
    runtime.update(|app, _| {
        app.apply(serde_json::from_value(json!({
        "machine": {"installation": "i-pc", "profile": "local", "name": "mk-pc"},
        "message": {"_tag": "Snapshot", "installation": "i-pc", "build": "0.35.0", "protocol": 5,
            "herds": [], "tasks": [], "seq": 1}
    })).unwrap())
    });
    assert_eq!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .selected,
        Some(("a1".into(), 2))
    );
    let read = harness.fake.asked_of("artefactRead");
    assert_eq!(
        (
            &read[0]["installation"],
            &read[0]["runId"],
            &read[0]["id"],
            &read[0]["revision"]
        ),
        (&json!("i-vm"), &json!("r-old"), &json!("a1"), &json!(2))
    );
    runtime.update(|app, _| app.back());
    assert_eq!(runtime.state.nav.page, Page::Artefacts);
    assert!(runtime.state.record.open.is_none());
}

#[test]
fn switching_results_during_a_read_cannot_show_or_acknowledge_the_earlier_one() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let mut link = item("i-pc", "r-new", "l1", "Dashboard", "", b"");
    link["digest"] = json!("");
    link["url"] = json!("https://example.com/dash");
    harness.fake.answer(
        "artefactSearch",
        Ok(page(
            vec![found("vm", notes_vm()), found("mk-pc", link.clone())],
            Value::Null,
            vec![],
        )),
    );
    settle(&harness, &mut runtime);
    runtime.update(|app, _| app.open_found(0));
    record_of(&harness, &mut runtime, "r-old", vec![notes_vm()]);
    assert_eq!(harness.fake.asked_of("artefactRead").len(), 1);
    runtime.update(|app, _| {
        app.back();
        app.open_found(1);
    });
    record_of(&harness, &mut runtime, "r-new", vec![link]);
    // The earlier result's read answers only now.
    let bytes = b"# Old notes\n";
    use base64::Engine;
    harness.fake.answer(
        "artefactRead",
        Ok(
            json!({"ref": "artefact:a1:2", "encoding": "base64", "size": bytes.len(),
            "content": base64::engine::general_purpose::STANDARD.encode(bytes)}),
        ),
    );
    settle(&harness, &mut runtime);
    std::thread::sleep(std::time::Duration::from_millis(200));
    settle(&harness, &mut runtime);
    let record = runtime.state.record.open.as_ref().unwrap();
    assert_eq!(record.run, "r-new");
    assert_eq!(record.artefacts.selected, Some(("l1".into(), 2)));
    assert!(matches!(record.artefacts.preview, Some(Preview::Link)));
    assert!(record.artefacts.bytes.is_none());
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    runtime.frame(100.0);
    assert!(!said(&runtime, "Old notes"));
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

#[test]
fn a_seen_answer_from_before_a_new_search_cannot_overwrite_its_newer_revision() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("vm", notes_vm())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    runtime.update(|app, _| {
        app.mark_found(0, true);
        app.search_artefacts();
    });
    let mut newer = notes_vm();
    newer["revision"] = json!(3);
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("vm", newer)], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    let mut old = notes_vm();
    old["seen"] = json!({"revision": 2, "at": "2026-11-13T00:00:00Z"});
    harness.fake.answer("artefactSeen", Ok(old));
    settle(&harness, &mut runtime);
    let item = &runtime.state.pages.artefacts.found[0].found.item;
    assert_eq!(item.revision, 3);
    assert!(item.seen.is_none());
}

#[test]
fn enter_submits_a_named_search_field_and_the_result_controls_are_accessible() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let mut at = 100.0;
    tap(&mut runtime, "artefacts-query", &mut at);
    runtime.key(rune::KeyEvent {
        key: rune::Key::Text("notes".into()),
        mods: Default::default(),
    });
    runtime.frame(at + 16.0);
    runtime.key(rune::KeyEvent {
        key: rune::Key::Enter,
        mods: Default::default(),
    });
    runtime.frame(at + 32.0);
    assert_eq!(
        harness.fake.asked_of("artefactSearch")[1],
        json!({"query": "notes"})
    );
    harness
        .fake
        .answer("artefactSearch", Ok(page(vec![], Value::Null, vec![])));
    harness.fake.answer(
        "artefactSearch",
        Ok(page(vec![found("vm", notes_vm())], Value::Null, vec![])),
    );
    settle(&harness, &mut runtime);
    runtime.frame(at);
    let tree = runtime.accessibility_json();
    for label in ["Open", "Mark seen"] {
        assert!(
            within(&tree)
                .iter()
                .any(|node| node["role"] == "button" && node["name"] == label)
        );
    }
    assert!(said(&runtime, "Last observed: 2026-11-01T00:00:00Z"));
}
