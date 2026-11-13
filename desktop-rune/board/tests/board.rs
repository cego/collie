//! The board as the human meets it: built from Flock items, drawn by Rune without a window,
//! pressed, and its calls read off a fake core. Nothing here reaches a real host.

use collie_desktop_board::board::{Dialog, model};
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::shell::Page;
use collie_desktop_board::{App, view};
use collie_desktop_protocol::generated::{ActPayload, TerminalPayload};
use collie_desktop_terminal::view::Tab;
use rune::{Env, Key, KeyEvent, Mods, Runtime, TextEdit};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// 2026-11-11T12:00:00Z.
const NOW: f64 = 1_794_398_400_000.0;
const DAY: f64 = 86_400_000.0;

fn task(id: &str, name: &str, state: &str, more: Value) -> Value {
    let mut task = json!({
        "id": id, "name": name, "project": "content", "state": state, "steps": [],
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

fn machine(installation: &str, profile: &str, name: &str) -> Value {
    json!({"installation": installation, "profile": profile, "name": name})
}

fn snapshot(machine: &Value, tasks: Vec<Value>) -> Value {
    json!({"machine": machine, "message": {
        "_tag": "Snapshot", "installation": machine["installation"], "build": "0.118.0",
        "protocol": 7, "files": true, "herds": [{"id": "h1"}], "tasks": tasks, "seq": 1,
    }})
}

fn pc() -> Value {
    machine("inst-pc", "p-pc", "mk-pc")
}

fn vm() -> Value {
    machine("inst-vm", "p-vm", "vm-mk")
}

fn question(run: &str, id: &str, text: &str) -> Value {
    json!({"kind": "question", "run": run, "id": id, "step": "plan", "topic": "the path",
    "text": text, "options": [
        {"id": "yes", "title": "Yes", "subtitle": "Keep it"},
        {"id": "no", "title": "No", "subtitle": null},
    ]})
}

/// An app on a fake core, at a fixed now and in UTC, that has heard `items`.
fn app(harness: &Harness<App>, items: Vec<Value>) -> App {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.board.clock = Some(NOW);
    app.board.utc_offset = Some(0);
    for item in items {
        app.apply(serde_json::from_value(item).unwrap());
    }
    app
}

fn runtime(app: App) -> Runtime<App> {
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    // The first frame measures the board; its columns are drawn on the next.
    runtime.frame(0.0);
    runtime.frame(0.016);
    runtime
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

fn node(runtime: &Runtime<App>, key: &str) -> Option<Value> {
    let tree = runtime.accessibility_json();
    within(&tree).into_iter().find(|n| n["key"] == key).cloned()
}

fn has_state(node: &Value, state: &str) -> bool {
    node["states"]
        .as_array()
        .is_some_and(|s| s.iter().any(|one| one == state))
}

/// The names of the cards drawn inside the node keyed `key`.
fn cards_in(runtime: &Runtime<App>, key: &str) -> Vec<String> {
    let Some(section) = node(runtime, key) else {
        return Vec::new();
    };
    within(&section)
        .into_iter()
        .filter(|n| n["role"] == "button")
        .filter(|n| has_state(n, "checked") || has_state(n, "unchecked"))
        .map(|n| n["name"].as_str().unwrap().to_string())
        .collect()
}

fn press(runtime: &mut Runtime<App>, key: &str) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(1.0);
    runtime.pointer_down(x, y);
    runtime.frame(0.05);
    runtime.pointer_up(x, y);
    runtime.frame(1.0);
}

fn double_press(runtime: &mut Runtime<App>, key: &str) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(1.0);
    for _ in 0..2 {
        runtime.pointer_down(x, y);
        runtime.frame(0.05);
        runtime.pointer_up(x, y);
        runtime.frame(0.05);
    }
    runtime.frame(1.0);
}

fn settle(harness: &Harness<App>, runtime: &mut Runtime<App>) {
    harness.settle(&mut runtime.state);
    redraw(runtime);
}

/// Draws again after a test changed the state by hand.
fn redraw(runtime: &mut Runtime<App>) {
    runtime.invalidate();
    runtime.frame(1.0);
}

/// Presses the item of the open menu that says `name`.
fn choose(runtime: &mut Runtime<App>, name: &str) {
    let tree = runtime.accessibility_json();
    let key = within(&tree)
        .into_iter()
        .find(|n| n["role"] == "menu-item" && n["name"] == name)
        .and_then(|n| n["key"].as_str().map(String::from))
        .unwrap_or_else(|| panic!("no {name} in the menu: {tree:#}"));
    press(runtime, &key);
}

/// Each `act` the board sent, checked to be one the core's protocol takes.
fn acts(harness: &Harness<App>) -> Vec<Value> {
    harness
        .fake
        .asked_of("act")
        .into_iter()
        .inspect(|asked| {
            serde_json::from_value::<ActPayload>(asked.clone())
                .unwrap_or_else(|e| panic!("{asked} is no act payload: {e}"));
        })
        .collect()
}

/// Records each pane the board asks for: installation, Run and Machine.
fn record_panes(app: &mut App) -> Arc<Mutex<Vec<(String, String, String)>>> {
    let asked: Arc<Mutex<Vec<(String, String, String)>>> = Arc::default();
    let said = asked.clone();
    app.go_to = Some(Box::new(move |payload: TerminalPayload, machine, _| {
        said.lock()
            .unwrap()
            .push((payload.installation, payload.run_id, machine.clone()));
        Tab::new(None, machine, 100, 30)
    }));
    asked
}

#[test]
fn the_sections_and_the_header_count_every_machines_tasks_and_urgent_work_is_said_in_warning() {
    let harness = Harness::new();
    let asking = task("t-ask", "Ask me", "blocked", json!({}));
    let runtime = runtime(app(
        &harness,
        vec![
            snapshot(&pc(), vec![asking.clone()]),
            snapshot(
                &vm(),
                vec![
                    task("t-vm", "Ask me too", "blocked", json!({})),
                    task("t-work", "Busy", "active", json!({})),
                    task("t-wait", "Look at me", "stopped", json!({})),
                ],
            ),
        ],
    ));
    let header = node(&runtime, "header").expect("a header");
    assert_eq!(header["role"], "status");
    assert_eq!(
        header["name"],
        "2 tasks are waiting on you. 1 waiting on you. 1 working."
    );
    assert!(urgent(&runtime.state), "work that needs you is urgent");
    let order: Vec<String> = within(&runtime.accessibility_json())
        .into_iter()
        .filter(|n| n["role"] == "group")
        .filter_map(|n| n["name"].as_str().map(String::from))
        .filter(|name| {
            ["Needs you", "Waiting on you", "Working", "Finished"]
                .iter()
                .any(|s| name.starts_with(s))
        })
        .collect();
    assert_eq!(order, ["Needs you, 2", "Waiting on you, 1", "Working, 1"]);
    assert_eq!(cards_in(&runtime, "needs-you"), ["Ask me", "Ask me too"]);

    let calm = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t", "Busy", "active", json!({}))],
        )],
    );
    assert!(!urgent(&calm.state));
    assert_eq!(
        node(&calm, "header").unwrap()["name"],
        "Nothing needs you. 1 working."
    );
}

fn urgent(app: &App) -> bool {
    let placed = app.placed();
    let tasks: Vec<_> = placed.iter().map(|p| p.task).collect();
    model::header_sentence(&tasks, Some(NOW)).1
}

fn runtime_of(harness: &Harness<App>, items: Vec<Value>) -> Runtime<App> {
    runtime(app(harness, items))
}

#[test]
fn an_unseen_finished_task_is_drawn_outside_the_fold_a_seen_one_only_inside_and_finished_counts_both()
 {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![
            snapshot(
                &pc(),
                vec![task(
                    "t-seen",
                    "Read",
                    "done",
                    json!({"landed": true, "unseen": false}),
                )],
            ),
            snapshot(
                &vm(),
                vec![task(
                    "t-unseen",
                    "Report",
                    "done",
                    json!({"landed": true, "unseen": true}),
                )],
            ),
        ],
    );
    assert_eq!(node(&runtime, "finished").unwrap()["name"], "Finished, 2");
    assert_eq!(cards_in(&runtime, "finished"), ["Report"]);
    press(&mut runtime, "finished-seen");
    assert_eq!(cards_in(&runtime, "finished"), ["Report", "Read"]);
}

#[test]
fn waiting_work_older_than_a_week_is_folded_but_ready_work_never_is() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![
                task("t-new", "Fresh", "stopped", json!({"at": NOW - DAY})),
                task("t-old", "Stale", "stopped", json!({"at": NOW - 8.0 * DAY})),
                task(
                    "t-ready",
                    "Ready",
                    "done",
                    json!({"at": NOW - 9.0 * DAY, "ready": true}),
                ),
            ],
        )],
    );
    assert_eq!(cards_in(&runtime, "waiting"), ["Fresh", "Ready"]);
    let older = node(&runtime, "waiting-older").expect("the older fold");
    assert!(
        within(&older)
            .iter()
            .any(|n| n["name"] == "1 older than a week"),
        "{older}"
    );
    press(&mut runtime, "waiting-older");
    assert_eq!(cards_in(&runtime, "waiting"), ["Fresh", "Ready", "Stale"]);
}

#[test]
fn a_flock_that_has_heard_nothing_says_it_is_connecting_and_an_empty_one_says_so() {
    let harness = Harness::new();
    let waiting = runtime_of(&harness, vec![]);
    assert!(node(&waiting, "connecting").is_some());
    assert!(node(&waiting, "board-empty").is_none());
    let empty = runtime_of(&harness, vec![snapshot(&pc(), vec![])]);
    assert!(node(&empty, "connecting").is_none());
    assert_eq!(
        node(&empty, "board-empty").unwrap()["name"],
        "Nothing on the board yet."
    );
}

#[test]
fn a_machine_without_collie_is_said_with_onboard_which_onboards_it_and_one_out_of_reach_has_no_action()
 {
    let harness = Harness::new();
    let lost = |profile: &str, name: &str, state: &str| {
        json!({"_tag": "Lost", "machine": {"profile": profile, "name": name},
            "state": state, "reason": "ssh: connection refused", "at": NOW})
    };
    let mut runtime = runtime_of(
        &harness,
        vec![
            snapshot(&pc(), vec![]),
            lost("p-vm", "vm-mk", "no-collie"),
            lost("p-lap", "mk-laptop", "unreachable"),
        ],
    );
    let bare = node(&runtime, "lost-p-vm").expect("an alert for vm-mk");
    assert_eq!(bare["description"], "ssh: connection refused");
    assert!(node(&runtime, "lost-p-lap").is_some());
    assert!(node(&runtime, "onboard-p-lap").is_none());
    press(&mut runtime, "onboard-p-vm");
    let asked = harness.fake.asked_of("onboard");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["profile"], "p-vm");
    assert_eq!(
        runtime.state.nav.page,
        Page::Board,
        "the onboarding shows over the board"
    );
}

#[test]
fn a_machine_that_drops_keeps_its_cards_as_of_when_and_they_open_nothing() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![
            snapshot(&pc(), vec![task("t-pc", "Here", "active", json!({}))]),
            snapshot(&vm(), vec![task("t-vm", "There", "active", json!({}))]),
            json!({"_tag": "Lost", "machine": {"profile": "p-vm", "name": "vm-mk"},
                "state": "unreachable", "reason": "gone", "at": 5.0 * 60_000.0}),
        ],
    );
    let panes = record_panes(&mut app);
    let as_of: Vec<(String, Option<f64>)> = app
        .placed()
        .into_iter()
        .map(|p| (p.task.id.clone(), p.as_of))
        .collect();
    assert_eq!(
        as_of,
        [("t-pc".to_string(), None), ("t-vm".into(), Some(300_000.0))]
    );
    let mut runtime = runtime(app);
    let card = node(&runtime, "card-t-vm").unwrap();
    assert!(
        within(&card).iter().any(|n| n["name"]
            .as_str()
            .is_some_and(|s| s.contains("as of 00:05"))),
        "{card}"
    );
    double_press(&mut runtime, "card-t-vm");
    assert!(panes.lock().unwrap().is_empty());
    assert_eq!(
        runtime.state.selected_key().as_deref(),
        Some("inst-vm:t-vm")
    );
}

#[test]
fn a_gitlab_token_due_within_two_weeks_is_said_and_renew_opens_settings() {
    let harness = Harness::new();
    let mut runtime = runtime_of(&harness, vec![snapshot(&pc(), vec![])]);
    assert_eq!(harness.fake.asked_of("credentials").len(), 1);
    let held = |expires: &str| {
        Ok(
            json!({"gitlab": {"expires": expires}, "helle": false, "host": "gitlab.com",
            "tokenPage": "https://gitlab.com/-/user_settings/personal_access_tokens"}),
        )
    };
    harness.fake.push("credentials", held("2027-02-01"));
    settle(&harness, &mut runtime);
    assert!(node(&runtime, "renew-gitlab").is_none());
    harness.fake.push("credentials", held("2026-11-20"));
    settle(&harness, &mut runtime);
    let alert = node(&runtime, "renew-gitlab").expect("a renewal alert");
    assert_eq!(alert["name"], "The GitLab token expires on 2026-11-20");
    press(&mut runtime, "renew");
    assert_eq!(runtime.state.nav.page, Page::Settings);
}

#[test]
fn the_selected_card_is_the_chats_chip_and_clearing_the_chip_lets_the_card_go() {
    let harness = Harness::new();
    let app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "One", "active", json!({}))],
        )],
    );
    let mut runtime = runtime(app);
    press(&mut runtime, "card-t1");
    let chip = runtime
        .state
        .chat
        .about
        .clone()
        .expect("the card rides on the chat");
    assert_eq!(
        (
            chip.machine.as_str(),
            chip.task.as_str(),
            chip.run.as_str(),
            chip.name.as_str()
        ),
        ("mk-pc", "t1", "r-t1", "One")
    );
    runtime.update(|app, _| app.chat.choose(None));
    runtime.frame(1.0);
    assert!(!has_state(&node(&runtime, "card-t1").unwrap(), "checked"));
}

#[test]
fn a_press_selects_a_card_a_double_press_opens_it_and_escape_lets_it_go() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![
                task("t1", "One", "active", json!({})),
                task("t2", "Two", "active", json!({})),
            ],
        )],
    );
    let panes = record_panes(&mut app);
    let mut runtime = runtime(app);
    press(&mut runtime, "card-t1");
    assert!(has_state(&node(&runtime, "card-t1").unwrap(), "checked"));
    assert!(panes.lock().unwrap().is_empty(), "a press opens nothing");
    press(&mut runtime, "card-t2");
    assert!(!has_state(&node(&runtime, "card-t1").unwrap(), "checked"));
    assert!(has_state(&node(&runtime, "card-t2").unwrap(), "checked"));

    runtime.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    runtime.frame(1.0);
    assert_eq!(runtime.state.selected_key(), None);

    double_press(&mut runtime, "card-t1");
    assert_eq!(
        runtime.state.open_run,
        Some(("inst-pc".into(), "r-t1".into()))
    );
    assert!(
        panes.lock().unwrap().is_empty(),
        "opening a card attaches no pane; Go to pane does"
    );
    assert_eq!(runtime.state.selected_key().as_deref(), Some("inst-pc:t1"));
    assert!(
        acts(&harness).is_empty(),
        "a seen card is opened without a seen"
    );
}

#[test]
fn opening_an_unseen_runs_record_sends_its_machine_one_seen() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task(
                "t1",
                "Report",
                "done",
                json!({"landed": true, "unseen": true}),
            )],
        )],
    );
    record_panes(&mut app);
    let mut runtime = runtime(app);
    double_press(&mut runtime, "card-t1");
    let sent = acts(&harness);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["installation"], "inst-pc");
    assert_eq!(sent[0]["action"], json!({"_tag": "Seen", "runId": "r-t1"}));
}

#[test]
fn stop_is_sent_under_one_request_and_try_again_sends_that_request_again() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Stop run");
    let sent = acts(&harness);
    assert_eq!(
        sent[0]["action"],
        json!({"_tag": "Control", "runId": "r-t1", "control": "stop", "set": true})
    );
    let request = sent[0]["request"].as_str().expect("a request").to_string();
    harness
        .fake
        .answer("act", Err(CallError("Collie on mk-pc is busy".into())));
    settle(&harness, &mut runtime);
    let notice = &runtime.state.board.notices[0];
    assert_eq!(notice.title, "Collie on mk-pc is busy");
    let id = notice.id;
    runtime.state.try_again(id);
    let sent = acts(&harness);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1]["request"], request.as_str());
    assert_eq!(sent[1]["action"], sent[0]["action"]);
}

#[test]
fn an_action_on_a_saved_board_says_why_it_was_not_sent() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![
            json!({"_tag": "Saved", "machine": vm(), "herds": [{"id": "h1"}],
            "tasks": [task("t1", "Busy", "active", json!({}))], "at": 14.0 * 3_600_000.0 + 5.0 * 60_000.0}),
        ],
    );
    app.do_action(
        "inst-vm:t1",
        &collie_desktop_board::board::cards::CardAction::Stop,
    );
    let sent = acts(&harness);
    assert_eq!(sent[0]["unsent"], "its board is a saved one, as of 14:05");
}

#[test]
fn offers_are_read_for_the_run_and_one_with_arguments_is_invoked_with_what_was_typed() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Shipped", "done", json!({}))],
        )],
    );
    app.do_action(
        "inst-pc:t1",
        &collie_desktop_board::board::cards::CardAction::Offers,
    );
    assert_eq!(
        harness.fake.asked_of("offers"),
        [json!({"installation": "inst-pc", "runId": "r-t1"})]
    );
    harness.fake.answer(
        "offers",
        Ok(json!([
            {"id": "release", "title": "Release it", "workflow": "release", "arguments": null,
                "kind": "action", "primary": true, "unavailable": "a release is running"},
            {"id": "redo", "title": "Do it again", "workflow": "implement",
                "arguments": {"type": "object", "required": ["goal"], "properties": {
                    "goal": {"type": "string"}, "rounds": {"type": "number"}}},
                "kind": "follow-up", "primary": false, "unavailable": null},
        ])),
    );
    let mut runtime = runtime(app);
    settle(&harness, &mut runtime);
    let refused = node(&runtime, "offer-release").expect("the release offer");
    assert!(has_state(&refused, "disabled"));
    assert_eq!(refused["name"], "Release it: a release is running");
    press(&mut runtime, "offer-redo");
    assert!(node(&runtime, "field-goal").is_some());
    if let Some(Dialog::Offers { fields, .. }) = &mut runtime.state.board.dialog {
        for (name, _, edit) in fields.iter_mut() {
            *edit = TextEdit::new(if name == "goal" {
                "fix the redirect"
            } else {
                "3"
            });
        }
    }
    redraw(&mut runtime);
    press(&mut runtime, "invoke");
    let sent = acts(&harness);
    assert_eq!(
        sent[0]["action"],
        json!({"_tag": "Invoke", "runId": "r-t1", "offer": "redo",
            "input": {"goal": "fix the redirect", "rounds": 3}})
    );
    assert!(runtime.state.board.dialog.is_none());
}

#[test]
fn a_finished_cards_menu_disables_refused_offers_and_invokes_each_owning_run() {
    for (title, owner, id) in [
        ("Stage app!12", "r-app", "stage"),
        ("Release api!7", "r-api", "release"),
    ] {
        let harness = Harness::new();
        let mut runtime = runtime(app(
            &harness,
            vec![snapshot(
                &pc(),
                vec![task(
                    "fan",
                    "Deliver changes",
                    "done",
                    json!({"offers": [
                        {"id": "release", "title": "Release app!12", "run": "r-app",
                            "unavailable": "a Release is still going"},
                        {"id": "stage", "title": "Stage app!12", "run": "r-app"},
                        {"id": "release", "title": "Release api!7", "run": "r-api"}
                    ]}),
                )],
            )],
        ));
        press(&mut runtime, "card-fan-menu");
        let tree = runtime.accessibility_json();
        let refused = within(&tree)
            .into_iter()
            .find(|n| {
                n["role"] == "menu-item" && n["name"] == "Release app!12 — a Release is still going"
            })
            .expect("the refused offer stays visible with its reason");
        assert!(has_state(refused, "disabled"));
        choose(&mut runtime, "Release app!12 — a Release is still going");
        assert!(harness.fake.asked_of("offers").is_empty());
        assert!(acts(&harness).is_empty());

        choose(&mut runtime, title);
        assert_eq!(
            harness.fake.asked_of("offers"),
            [json!({"installation": "inst-pc", "runId": owner})]
        );
        harness.fake.answer(
            "offers",
            Ok(json!([
                {"id": id, "title": title, "workflow": id, "arguments": null,
                    "kind": "follow-up", "primary": false, "unavailable": null}
            ])),
        );
        settle(&harness, &mut runtime);
        assert_eq!(
            acts(&harness)[0]["action"],
            json!({
                "_tag": "Invoke", "runId": owner, "offer": id, "input": {}
            })
        );
    }
}

#[test]
fn a_question_is_answered_through_act_and_the_card_says_it_is_sending_then_waiting() {
    let harness = Harness::new();
    let asked = question("r-t1", "c1", "Keep the old path working?");
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task(
                "t1",
                "Fix the redirect",
                "blocked",
                json!({"decision": asked, "questions": [asked]}),
            )],
        )],
    );
    assert_eq!(node(&runtime, "card-t1-answer").unwrap()["name"], "Answer…");
    press(&mut runtime, "card-t1-answer");
    assert_eq!(
        node(&runtime, "question-text").unwrap()["name"],
        "Keep the old path working?"
    );
    assert!(has_state(
        &node(&runtime, "submit-answer").unwrap(),
        "disabled"
    ));
    press(&mut runtime, "option-0");
    assert!(has_state(&node(&runtime, "option-0").unwrap(), "checked"));
    press(&mut runtime, "submit-answer");
    let sent = acts(&harness);
    assert_eq!(
        sent[0]["action"],
        json!({"_tag": "Answer", "runId": "r-t1", "decision": "c1", "value": "yes"})
    );
    assert!(
        harness.fake.asked_of("answer").is_empty(),
        "answer is the chat's"
    );
    runtime.state.board.dialog = None;
    redraw(&mut runtime);
    assert_eq!(
        node(&runtime, "pending-answer").unwrap()["name"],
        "Sending Yes to mk-pc…"
    );
    harness.fake.answer("act", Ok(json!("Answered")));
    settle(&harness, &mut runtime);
    assert_eq!(
        node(&runtime, "pending-answer").unwrap()["name"],
        "Answered Yes; waiting for mk-pc's board"
    );
}

#[test]
fn a_refused_answer_gives_the_question_its_controls_back_and_says_why() {
    let harness = Harness::new();
    let asked = question("r-t1", "c1", "Keep the old path working?");
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Fix", "blocked", json!({"decision": asked}))],
        )],
    );
    press(&mut runtime, "card-t1-answer");
    press(&mut runtime, "option-1");
    press(&mut runtime, "submit-answer");
    assert!(has_state(
        &node(&runtime, "submit-answer").unwrap(),
        "disabled"
    ));
    harness.fake.answer(
        "act",
        Err(CallError("the question was answered elsewhere".into())),
    );
    settle(&harness, &mut runtime);
    assert_eq!(
        node(&runtime, "answer-state").unwrap()["name"],
        "the question was answered elsewhere"
    );
    assert!(!has_state(
        &node(&runtime, "submit-answer").unwrap(),
        "disabled"
    ));
    runtime.state.board.dialog = None;
    redraw(&mut runtime);
    assert_eq!(
        node(&runtime, "card-t1-answer").map(|n| n["name"].clone()),
        Some("Answer…".into()),
        "a refused answer is no longer in flight"
    );
}

#[test]
fn two_questions_are_answered_in_one_sitting_moving_on_to_the_next() {
    let harness = Harness::new();
    let first = question("r-t1", "c1", "First?");
    let second = question("r-t1", "c2", "Second?");
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task(
                "t1",
                "Fix",
                "blocked",
                json!({"decision": first, "questions": [first, second]}),
            )],
        )],
    );
    assert_eq!(
        node(&runtime, "card-t1-answer").unwrap()["name"],
        "Answer 2 questions…"
    );
    press(&mut runtime, "card-t1-answer");
    assert_eq!(
        node(&runtime, "question-count").unwrap()["name"],
        "Question 1 of 2"
    );
    press(&mut runtime, "option-0");
    press(&mut runtime, "submit-answer");
    harness.fake.answer("act", Ok(json!("Answered")));
    settle(&harness, &mut runtime);
    assert_eq!(
        node(&runtime, "question-count").unwrap()["name"],
        "Question 2 of 2"
    );
    assert_eq!(node(&runtime, "question-text").unwrap()["name"], "Second?");
    press(&mut runtime, "option-0");
    press(&mut runtime, "submit-answer");
    assert!(
        node(&runtime, "question-text").is_some(),
        "open while the last answer is sending"
    );
    harness.fake.answer("act", Ok(json!("Answered")));
    settle(&harness, &mut runtime);
    assert!(
        runtime.state.board.dialog.is_none(),
        "every question answered closes the sitting"
    );
    assert!(node(&runtime, "question-text").is_none());
}

#[test]
fn a_proposal_is_confirmed_only_once_read_to_its_end_and_declined_at_any_time() {
    let harness = Harness::new();
    let proposal = json!({"kind": "proposal", "id": "p1", "hash": "h1",
        "text": "Merge the branch and delete it.",
        "actions": [{"text": "merge !12", "allowed": true}, {"text": "delete mk/fix", "allowed": false}]});
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Land", "blocked", json!({"decision": proposal}))],
        )],
    );
    app.review("inst-pc:t1");
    app.decide(true);
    assert!(acts(&harness).is_empty(), "nothing is confirmed unread");
    assert!(app.board.dialog.is_some());
    // The end not yet on screen: still unread.
    app.proposal_drawn(Some([100.0, 200.0]), Some(400.0));
    app.decide(true);
    assert!(acts(&harness).is_empty());
    app.proposal_drawn(Some([100.0, 360.0]), Some(400.0));
    app.decide(true);
    assert_eq!(
        acts(&harness)[0]["action"],
        json!({"_tag": "Confirm", "proposal": "p1", "hash": "h1"})
    );

    let other = Harness::new();
    let mut app = self::app(
        &other,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Land", "blocked", json!({"decision": proposal}))],
        )],
    );
    app.review("inst-pc:t1");
    app.decide(false);
    assert_eq!(
        acts(&other)[0]["action"],
        json!({"_tag": "Decline", "proposal": "p1", "hash": "h1"})
    );
}

#[test]
fn steer_sends_the_words_typed_and_nothing_while_there_are_none() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Steer…");
    assert!(has_state(
        &node(&runtime, "send-words").unwrap(),
        "disabled"
    ));
    if let Some(Dialog::Words { edit, .. }) = &mut runtime.state.board.dialog {
        *edit = TextEdit::new("  look at the tests first ");
    }
    redraw(&mut runtime);
    press(&mut runtime, "send-words");
    assert_eq!(
        acts(&harness)[0]["action"],
        json!({"_tag": "Steer", "runId": "r-t1", "text": "look at the tests first"})
    );
}

#[test]
fn a_failing_flock_says_why_and_when_it_tries_again_and_retry_now_subscribes_at_once() {
    let harness = Harness::new();
    let mut runtime = runtime_of(&harness, vec![]);
    runtime.state.follow_flock();
    assert_eq!(harness.fake.asked_of("flock").len(), 1);
    harness
        .fake
        .push("flock", Err(CallError("the core is not running.".into())));
    settle(&harness, &mut runtime);
    let trouble = runtime.state.board.trouble.clone().expect("trouble");
    assert_eq!(trouble.said, "the core is not running");
    assert_eq!((trouble.attempt, trouble.at), (1, NOW + 1000.0));
    let said = node(&runtime, "retrying").expect("a retry notice");
    assert!(
        said["description"]
            .as_str()
            .is_some_and(|s| s.contains("the core is not running. Trying again in 1 s")),
        "{said}"
    );
    press(&mut runtime, "retry-now");
    assert_eq!(harness.fake.asked_of("flock").len(), 2);
    harness.fake.push(
        "flock",
        Ok(snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )),
    );
    settle(&harness, &mut runtime);
    assert!(runtime.state.board.trouble.is_none());
    assert!(node(&runtime, "retrying").is_none());
    assert_eq!(cards_in(&runtime, "working"), ["Busy"]);
}

#[test]
fn a_flock_the_core_cuts_off_is_followed_again_at_once_and_quietly() {
    let harness = Harness::new();
    let mut runtime = runtime_of(&harness, vec![]);
    runtime.state.follow_flock();
    harness.fake.push(
        "flock",
        Ok(snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )),
    );
    settle(&harness, &mut runtime);
    // A host restarted under the core: the core ends `flock` without an error.
    harness.fake.end("flock");
    settle(&harness, &mut runtime);
    assert_eq!(harness.fake.asked_of("flock").len(), 2);
    assert!(runtime.state.board.trouble.is_none());
    assert_eq!(cards_in(&runtime, "working"), ["Busy"]);
    harness.fake.push(
        "flock",
        Ok(snapshot(
            &pc(),
            vec![task("t2", "Again", "active", json!({}))],
        )),
    );
    settle(&harness, &mut runtime);
    assert_eq!(cards_in(&runtime, "working"), ["Again"]);
    // Cut off again before it said anything: it waits rather than asking in a loop.
    harness.fake.end("flock");
    harness.fake.end("flock");
    settle(&harness, &mut runtime);
    assert_eq!(harness.fake.asked_of("flock").len(), 3);
}

#[test]
fn each_machines_settings_sync_and_own_reading_are_kept_by_profile_and_dropped_with_it() {
    let harness = Harness::new();
    let synced = |part: &str, failed: Value| {
        json!({"_tag": "Synced", "part": part, "machine": {"profile": "p-vm", "name": "vm-mk"},
            "failed": failed})
    };
    let read = |mut values: Value, at: f64| {
        if values.is_object() {
            values["harnesses"] = json!(["claude"]);
            values["remembered"] = json!([]);
        }
        json!({"_tag": "OwnRead", "machine": {"profile": "p-vm", "name": "vm-mk"},
            "reading": {"values": values, "at": at, "problem": null, "unsupported": false}})
    };
    let mut app = app(
        &harness,
        vec![
            snapshot(&vm(), vec![]),
            synced("settings", json!("ssh: refused")),
            synced("definitions", Value::Null),
            read(json!({"projectsRoot": "~/code"}), 1.0),
        ],
    );
    let flock = &app.board.flock;
    assert_eq!(
        flock.synced.get("p-vm"),
        Some(&Some("ssh: refused".to_string()))
    );
    assert_eq!(flock.definitions.get("p-vm"), Some(&None));
    assert_eq!(flock.own.get("p-vm").unwrap().at, 1.0);

    app.apply(serde_json::from_value(synced("settings", Value::Null)).unwrap());
    // A reading that failed keeps the values last read, as of when they were.
    let mut failed: Value = read(Value::Null, 2.0);
    failed["reading"]["problem"] = json!("timed out");
    app.apply(serde_json::from_value(failed).unwrap());
    let flock = &app.board.flock;
    assert_eq!(flock.synced.get("p-vm"), Some(&None));
    let own = flock.own.get("p-vm").unwrap();
    assert_eq!(
        (
            own.values.as_ref().and_then(|v| v.projects_root.clone()),
            own.at,
            own.problem.clone()
        ),
        (Some("~/code".into()), 1.0, Some("timed out".into()))
    );

    app.apply(
        serde_json::from_value(
            json!({"_tag": "Removed", "machine": {"profile": "p-vm", "name": "vm-mk"}}),
        )
        .unwrap(),
    );
    assert!(!app.board.flock.synced.has("p-vm"));
    assert!(!app.board.flock.own.has("p-vm"));
}

#[test]
fn saved_boards_are_drawn_at_once_and_the_machines_still_being_reached_are_named() {
    let harness = Harness::new();
    let saved = json!({"_tag": "Saved", "machine": vm(), "herds": [{"id": "h1"}],
        "tasks": [task("t1", "Busy", "active", json!({}))],
        "at": 14.0 * 3_600_000.0 + 5.0 * 60_000.0});
    let mut runtime = runtime_of(&harness, vec![saved]);
    assert!(node(&runtime, "connecting").is_none());
    assert_eq!(cards_in(&runtime, "working"), ["Busy"]);
    assert_eq!(
        node(&runtime, "reaching").expect("who is still being reached")["name"],
        "Reaching vm-mk; its cards are as of 14:05."
    );
    let live = snapshot(&vm(), vec![task("t1", "Busy", "active", json!({}))]);
    runtime.state.apply(serde_json::from_value(live).unwrap());
    redraw(&mut runtime);
    assert!(node(&runtime, "reaching").is_none());
    assert_eq!(cards_in(&runtime, "working"), ["Busy"]);
}

#[test]
fn a_stop_the_host_refuses_says_why_and_offers_no_try_again() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Stop run");
    harness.fake.refuse("act", "the Run has already ended");
    settle(&harness, &mut runtime);
    let notice = runtime.state.board.notices[0].clone();
    assert_eq!(notice.title, "the Run has already ended");
    let toast = node(&runtime, &format!("notice-{}", notice.id)).expect("the notice");
    assert!(
        !within(&toast).iter().any(|n| n["name"] == "Try again"),
        "{toast:#}"
    );
    runtime.state.try_again(notice.id);
    assert_eq!(acts(&harness).len(), 1);
}

#[test]
fn an_answer_the_host_refused_is_sent_again_under_a_new_request() {
    let harness = Harness::new();
    let asked = question("r-t1", "c1", "Keep the old path working?");
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Fix", "blocked", json!({"decision": asked}))],
        )],
    );
    press(&mut runtime, "card-t1-answer");
    press(&mut runtime, "option-1");
    press(&mut runtime, "submit-answer");
    harness
        .fake
        .refuse("act", "the question was answered elsewhere");
    settle(&harness, &mut runtime);
    assert_eq!(
        node(&runtime, "answer-state").unwrap()["name"],
        "the question was answered elsewhere"
    );
    press(&mut runtime, "submit-answer");
    let sent = acts(&harness);
    assert_eq!(sent.len(), 2);
    assert_ne!(sent[1]["request"], sent[0]["request"]);
}

#[test]
fn check_output_shows_a_running_checks_last_lines_and_opens_its_record() {
    let harness = Harness::new();
    let check = json!({"name": "unit", "pass": "gate", "round": null, "revision": "abc",
        "base": null, "elapsedMs": 60_000, "usualMs": null, "others": 0,
        "sentence": "Running unit, 1 min.", "log": "/tmp/unit.log",
        "lastLines": ["ok 1 boards", "ok 2 cards"]});
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({"check": check}))],
        )],
    );
    record_panes(&mut app);
    let mut runtime = runtime(app);
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Check output…");
    assert_eq!(
        node(&runtime, "check-sentence").unwrap()["name"],
        "Running unit, 1 min."
    );
    let lines = node(&runtime, "check-lines").unwrap();
    assert_eq!(lines["name"], "Its last lines");
    assert!(
        within(&lines)
            .iter()
            .any(|n| n["name"] == "ok 1 boards\nok 2 cards"),
        "{lines:#}"
    );
    assert_eq!(
        node(&runtime, "check-log").unwrap()["name"],
        "Written to /tmp/unit.log on its Machine"
    );
    press(&mut runtime, "check-open-record");
    assert!(runtime.state.board.dialog.is_none());
    assert_eq!(runtime.state.board.opened.as_deref(), Some("inst-pc:t1"));
}

#[test]
fn attach_files_makes_the_card_the_chats_chip_opens_the_chat_and_its_file_dialog() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    let picked = Arc::new(Mutex::new(0));
    let count = picked.clone();
    app.chat.pick = Some(Box::new(move || *count.lock().unwrap() += 1));
    let mut runtime = runtime(app);
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Attach files…");
    assert_eq!(*picked.lock().unwrap(), 1);
    assert!(runtime.state.nav.chat.is_open());
    assert_eq!(runtime.state.selected_key().as_deref(), Some("inst-pc:t1"));
}

#[test]
fn the_finished_fold_says_whether_it_is_open_and_the_keyboard_opens_it() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task(
                "t-seen",
                "Read",
                "done",
                json!({"landed": true, "unseen": false}),
            )],
        )],
    );
    let fold = node(&runtime, "finished-seen").unwrap();
    assert_eq!(fold["name"], "1 finished");
    assert!(has_state(&fold, "collapsed"), "{fold:#}");
    let mut tabs = 0;
    while !node(&runtime, "finished-seen").is_some_and(|n| has_state(&n, "focused")) {
        tabs += 1;
        assert!(tabs < 40, "Tab never reaches the fold");
        runtime.key(KeyEvent {
            key: Key::Tab,
            mods: Mods::default(),
        });
        runtime.frame(1.0);
    }
    runtime.key(KeyEvent {
        key: Key::Text(" ".into()),
        mods: Mods::default(),
    });
    runtime.frame(1.0);
    assert!(has_state(
        &node(&runtime, "finished-seen").unwrap(),
        "expanded"
    ));
    assert_eq!(cards_in(&runtime, "finished"), ["Read"]);
}

/// The key of the element that has focus, if any.
fn focused(runtime: &Runtime<App>) -> Option<String> {
    let tree = runtime.accessibility_json();
    within(&tree)
        .into_iter()
        .find(|n| has_state(n, "focused"))
        .and_then(|n| n["key"].as_str().map(String::from))
}

/// Whether focus is on the node keyed `key` or inside it.
fn focus_within(runtime: &Runtime<App>, key: &str) -> bool {
    node(runtime, key).is_some_and(|n| within(&n).into_iter().any(|n| has_state(n, "focused")))
}

/// The drawn bounds of the first node with `role`: x, y, w, h.
fn bounds_of_role(runtime: &Runtime<App>, role: &str) -> Option<[f32; 4]> {
    let tree = runtime.accessibility_json();
    within(&tree)
        .into_iter()
        .find(|n| n["role"] == role)
        .map(|n| {
            let b = n["bounds"].as_array().unwrap();
            [0, 1, 2, 3].map(|i| b[i].as_f64().unwrap() as f32)
        })
}

#[test]
fn p2_a_card_menu_opens_at_its_trigger_on_a_card_scrolled_down_a_long_section() {
    let harness = Harness::new();
    let tasks: Vec<Value> = (0..30)
        .map(|n| task(&format!("t{n}"), &format!("Busy {n}"), "active", json!({})))
        .collect();
    let mut runtime = runtime_of(&harness, vec![snapshot(&pc(), tasks)]);
    let before = runtime.find("card-t28-menu").map(|(_, y)| y);
    let (x, y) = runtime.find("card-t0").unwrap();
    runtime.wheel(x, y, -8000.0);
    runtime.frame(1.0);
    let (tx, ty) = runtime.find("card-t28-menu").expect("the trigger is drawn");
    assert_ne!(before, Some(ty), "the board scrolled");
    assert!(ty > 0.0 && ty < 900.0, "the trigger is on screen: {ty}");
    press(&mut runtime, "card-t28-menu");
    let [mx, my, mw, mh] = bounds_of_role(&runtime, "menu").expect("the menu is open");
    let near_x = tx >= mx - 40.0 && tx <= mx + mw + 40.0;
    let near_y = (my - ty).abs() < 40.0 || (my + mh - ty).abs() < 40.0;
    assert!(
        near_x && near_y,
        "the menu at {:?} opens at its trigger at {:?}",
        [mx, my, mw, mh],
        (tx, ty)
    );
}

#[test]
fn p2_a_steer_dialogs_field_has_focus_when_it_opens() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Steer…");
    runtime.frame(1.0);
    assert!(focus_within(&runtime, "words"), "{:?}", focused(&runtime));
}

#[test]
fn p2_an_offers_first_field_has_focus_once_the_offer_is_picked() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Shipped", "done", json!({}))],
        )],
    );
    runtime.state.do_action(
        "inst-pc:t1",
        &collie_desktop_board::board::cards::CardAction::Offers,
    );
    harness.fake.answer(
        "offers",
        Ok(json!([
            {"id": "redo", "title": "Do it again", "workflow": "implement",
                "arguments": {"type": "object", "required": ["goal"], "properties": {
                    "goal": {"type": "string"}}},
                "kind": "follow-up", "primary": false, "unavailable": null},
        ])),
    );
    settle(&harness, &mut runtime);
    press(&mut runtime, "offer-redo");
    runtime.frame(1.0);
    assert!(
        focus_within(&runtime, "field-goal"),
        "{:?}",
        focused(&runtime)
    );
}

#[test]
fn p2_focus_goes_back_to_the_card_after_a_steer_is_sent() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Steer…");
    if let Some(Dialog::Words { edit, .. }) = &mut runtime.state.board.dialog {
        *edit = TextEdit::new("look at the tests");
    }
    redraw(&mut runtime);
    press(&mut runtime, "send-words");
    runtime.frame(1.0);
    assert!(runtime.state.board.dialog.is_none());
    assert_eq!(focused(&runtime).as_deref(), Some("card-t1"));
}

#[test]
fn p2_a_proposal_decided_elsewhere_closes_its_dialog() {
    let harness = Harness::new();
    let proposal = json!({"kind": "proposal", "id": "p1", "hash": "h1",
        "text": "Merge the branch.", "actions": [{"text": "merge !12", "allowed": true}]});
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Land", "blocked", json!({"decision": proposal}))],
        )],
    );
    app.review("inst-pc:t1");
    app.proposal_drawn(Some([0.0, 400.0]), Some(100.0));
    // Changed while open: what is shown is the new one, read again from the start.
    let changed = json!({"kind": "proposal", "id": "p1", "hash": "h2",
        "text": "Merge the branch and tag it.", "actions": []});
    app.apply(
        serde_json::from_value(snapshot(
            &pc(),
            vec![task("t1", "Land", "blocked", json!({"decision": changed}))],
        ))
        .unwrap(),
    );
    match &app.board.dialog {
        Some(Dialog::Proposal { proposal, seen, .. }) => {
            assert_eq!(proposal.hash, "h2");
            assert!(!seen, "a changed proposal is read again");
        }
        _ => panic!("the proposal dialog stays open on its card's new proposal"),
    }
    app.apply(
        serde_json::from_value(snapshot(
            &pc(),
            vec![task("t1", "Land", "active", json!({}))],
        ))
        .unwrap(),
    );
    assert!(
        app.board.dialog.is_none(),
        "the proposal is no longer asked"
    );
}

#[test]
fn p2_a_steer_dialog_closes_when_its_card_leaves_the_board() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    app.do_action(
        "inst-pc:t1",
        &collie_desktop_board::board::cards::CardAction::Steer,
    );
    assert!(app.board.dialog.is_some());
    app.apply(serde_json::from_value(snapshot(&pc(), vec![])).unwrap());
    assert!(app.board.dialog.is_none());
}

#[test]
fn a_toast_goes_after_five_seconds_unless_the_pointer_is_on_it() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    press(&mut runtime, "card-t1-menu");
    choose(&mut runtime, "Stop run");
    harness.fake.refuse("act", "the Run has already ended");
    settle(&harness, &mut runtime);
    let key = format!("notice-{}", runtime.state.board.notices[0].id);

    assert!(!runtime.state.expire_toasts(1_000.0));
    assert!(!runtime.state.expire_toasts(5_999.0));
    let (x, y) = runtime.find(&key).expect("the toast");
    runtime.pointer_move(x, y);
    runtime.frame(0.1);
    assert!(
        !runtime.state.expire_toasts(60_000.0),
        "held while pointed at"
    );
    runtime.pointer_move(5.0, 5.0);
    runtime.frame(0.1);
    assert!(
        !runtime.state.expire_toasts(60_000.0),
        "a full time again once left"
    );
    assert!(runtime.state.expire_toasts(65_000.0));
    redraw(&mut runtime);
    assert!(node(&runtime, &key).is_none());

    runtime.state.pages.machines.told.say("Synced", true);
    assert!(!runtime.state.expire_toasts(70_000.0));
    assert!(runtime.state.expire_toasts(75_000.0));
    assert!(runtime.state.pages.machines.told.said.is_empty());
}

#[test]
fn go_to_pane_opens_a_cards_record_on_its_terminal() {
    let harness = Harness::new();
    let mut app = app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "One", "active", json!({}))],
        )],
    );
    let panes = record_panes(&mut app);
    app.do_action(
        "inst-pc:t1",
        &collie_desktop_board::board::cards::CardAction::GoToTab,
    );
    assert_eq!(app.record_tab(), "terminal");
    assert_eq!(
        *panes.lock().unwrap(),
        [("inst-pc".into(), "r-t1".into(), "mk-pc".into())]
    );
}

#[test]
fn a_cards_title_opens_its_record_with_one_press() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "One", "active", json!({}))],
        )],
    );
    let title = node(&runtime, "card-t1-name").expect("the title is a control");
    assert_eq!(title["role"], "button");
    press(&mut runtime, "card-t1-name");
    assert_eq!(
        runtime.state.open_run,
        Some(("inst-pc".into(), "r-t1".into()))
    );
    assert_eq!(runtime.state.selected_key().as_deref(), Some("inst-pc:t1"));
}

#[test]
fn cards_take_the_columns_the_boards_width_fits_at_once_never_springing_into_them() {
    let harness = Harness::new();
    let mut runtime = runtime_of(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task("t1", "Busy", "active", json!({}))],
        )],
    );
    let (board, _) = runtime.presented("board-body").expect("the board");
    runtime.frame(0.016);
    let (card, _) = runtime.presented("card-t1").expect("the card");
    assert_eq!(
        card[2], board[2],
        "one column, filled in the frame after measuring"
    );

    runtime.state.nav.chat.set_open(false);
    runtime.invalidate();
    runtime.frame(0.016);
    runtime.frame(0.016);
    let (board, _) = runtime.presented("board-body").expect("the board");
    let (card, _) = runtime.presented("card-t1").expect("the card");
    assert!(
        (card[2] - (board[2] - 2.0 * 12.0) / 3.0).abs() < 1.0,
        "three columns once the chat closes, without springing: {card:?} in {board:?}"
    );
}

#[test]
fn ready_to_ship_preserves_the_release_title_and_owning_run() {
    let harness = Harness::new();
    let offer = json!({"id": "release", "title": "Release after review", "run": "r-owner"});
    let mut runtime = runtime(app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![
                task("t-ask", "Ask me", "blocked", json!({})),
                task(
                    "t-ship",
                    "Green and approved",
                    "done",
                    json!({"shipping": "merge", "offer": offer}),
                ),
                task("t-wait", "Look at me", "stopped", json!({})),
                task("t-work", "Busy", "active", json!({})),
            ],
        )],
    ));
    let header = node(&runtime, "header").expect("a header");
    assert_eq!(
        header["name"],
        "One task is waiting on you. 1 ready to ship, 1 waiting on you. 1 working."
    );
    let order: Vec<String> = within(&runtime.accessibility_json())
        .into_iter()
        .filter(|n| n["role"] == "group")
        .filter_map(|n| n["name"].as_str().map(String::from))
        .filter(|name| name.ends_with(", 1"))
        .collect();
    assert_eq!(
        order,
        [
            "Needs you, 1",
            "Ready to ship, 1",
            "Waiting on you, 1",
            "Working, 1"
        ]
    );
    assert_eq!(cards_in(&runtime, "ready-to-ship"), ["Green and approved"]);
    let primary = node(&runtime, "card-t-ship-primary").expect("its Release offer");
    assert_eq!(primary["name"], "Release after review");
    press(&mut runtime, "card-t-ship-primary");
    assert_eq!(
        harness.fake.asked_of("offers"),
        [json!({"installation": "inst-pc", "runId": "r-owner"})]
    );
}

#[test]
fn a_parked_card_names_its_cause_and_its_latest_two_recovery_actions() {
    let harness = Harness::new();
    let runtime = runtime(app(
        &harness,
        vec![snapshot(
            &pc(),
            vec![task(
                "t1",
                "Waiting for CI",
                "blocked",
                json!({"park": {"cause": "ci-job-absent", "kind": "rechecks"},
                    "recovery": ["first", "second", "third"]}),
            )],
        )],
    ));
    let park = node(&runtime, "card-t1-park").expect("its park");
    assert_eq!(park["name"], "Parked: ci-job-absent · Collie rechecks");
    let history = node(&runtime, "card-t1-recovery").expect("its recovery");
    assert_eq!(history["name"], "Recovery history");
    let lines: Vec<&str> = within(&history)
        .into_iter()
        .filter(|n| n["role"] == "list-item")
        .filter_map(|n| n["name"].as_str())
        .collect();
    assert_eq!(lines, ["second", "third"]);
}

const PR400: &str = "https://github.com/cego/collie/pull/400";

/// The Working card the human's screenshot shows, holding PR collie#400.
fn pr400(id: &str, more: Value) -> Value {
    let mut card = task(
        id,
        "Fix Desktop retaining a broken VM chat channel",
        "active",
        json!({
            "project": "/home/mk/collie", "branch": "desktop-replaces-a-dead-chat-channel",
            "sentence": "Running startup-final-tests, 16 s.", "age": "22h",
            "agents": [{"name": "build", "status": "working", "now": null, "run": format!("r-{id}")}],
            "mr": PR400, "mrState": "open",
            "flow": {"glyphs": [{"title": "build", "state": "running"}], "release": 0.0,
                "current": null},
        }),
    );
    for (key, value) in more.as_object().into_iter().flatten() {
        card[key] = value.clone();
    }
    card
}

fn overlap(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] + 0.5 < b[0] + b[2]
        && b[0] + 0.5 < a[0] + a[2]
        && a[1] + 0.5 < b[1] + b[3]
        && b[1] + 0.5 < a[1] + a[3]
}

fn inside(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] >= b[0] - 0.5
        && a[1] >= b[1] - 0.5
        && a[0] + a[2] <= b[0] + b[2] + 0.5
        && a[1] + a[3] <= b[1] + b[3] + 0.5
}

/// Draws until the board's columns and springs have come to rest.
fn settle_layout(runtime: &mut Runtime<App>) {
    runtime.invalidate();
    for _ in 0..6 {
        runtime.frame(1.0);
    }
}

/// Lays the board out at `size` and `scale`, then checks the merge requests drawn on `card`:
/// their text and each control sit apart, inside the card and clear of its other rows.
/// Returns the card's width.
fn mr_rows_fit(runtime: &mut Runtime<App>, card: &str, size: (f32, f32), scale: f32) -> f32 {
    runtime.set_viewport(size, scale);
    settle_layout(runtime);
    let elements = runtime.elements();
    let at = format!("{size:?} at {scale}x");
    let card_el = elements
        .iter()
        .find(|e| e.key.as_deref() == Some(card))
        .unwrap_or_else(|| panic!("no {card} at {at}"));
    let within_card = |e: &&rune::ElementInfo| e.path.starts_with(&format!("{}/", card_el.path));
    let mrs = elements
        .iter()
        .filter(within_card)
        .find(|e| e.key.as_deref() == Some("mrs"))
        .unwrap_or_else(|| panic!("{card} draws no merge requests at {at}"));
    let buttons: Vec<_> = elements
        .iter()
        .filter(|e| e.path.starts_with(&format!("{}/", mrs.path)) && e.role == "button")
        .collect();
    let in_button = |e: &rune::ElementInfo| {
        buttons
            .iter()
            .any(|b| e.path.starts_with(&format!("{}/", b.path)))
    };
    let parts: Vec<(String, [f32; 4])> = elements
        .iter()
        .filter(|e| e.path.starts_with(&format!("{}/", mrs.path)))
        .filter(|e| e.role == "button" || (e.text.is_some() && !in_button(e)))
        .map(|e| {
            (
                e.label.clone().or(e.text.clone()).unwrap_or_default(),
                e.rect,
            )
        })
        .collect();
    assert!(parts.len() >= 2, "{card} at {at}: {parts:?}");
    for button in &buttons {
        assert!(button.focusable, "{:?} takes no focus ({at})", button.label);
    }
    for (name, rect) in &parts {
        assert!(rect[2] >= 1.0, "{name} is drawn {rect:?} at {at}");
        assert!(
            inside(*rect, card_el.rect),
            "{name} at {rect:?} leaves the card at {:?} ({at})",
            card_el.rect
        );
    }
    for (i, (a, ra)) in parts.iter().enumerate() {
        for (b, rb) in &parts[i + 1..] {
            assert!(
                !overlap(*ra, *rb),
                "{a} at {ra:?} overlaps {b} at {rb:?} ({at})"
            );
        }
    }
    for other in ["sentence", "footer"]
        .into_iter()
        .map(String::from)
        .chain([format!("{card}-flow")])
    {
        if let Some(e) = elements
            .iter()
            .filter(within_card)
            .find(|e| e.key.as_deref() == Some(other.as_str()))
        {
            assert!(
                !overlap(mrs.rect, e.rect),
                "the merge requests at {:?} overlap {other} at {:?} ({at})",
                mrs.rect,
                e.rect
            );
        }
    }
    card_el.rect[2]
}

/// Presses the button of `card`'s merge requests whose accessible name is `name`.
fn press_mr_button(runtime: &mut Runtime<App>, name: &str) {
    let path = runtime
        .elements()
        .into_iter()
        .find(|e| {
            e.role == "button" && e.label.as_deref() == Some(name) && e.path.contains("/mrs/")
        })
        .map(|e| e.path)
        .unwrap_or_else(|| panic!("no {name} button"));
    press(runtime, &path);
}

const SIZES: [(f32, f32); 6] = [
    (1280.0, 900.0),
    (1000.0, 900.0),
    (1600.0, 900.0),
    (700.0, 900.0),
    (420.0, 900.0),
    (1280.0, 900.0),
];

#[test]
fn card_mr_reference_open_and_machine_links_fit_a_narrow_card_at_every_width_and_scale() {
    let harness = Harness::new();
    let laptop = machine("inst-laptop", "p-laptop", "mk-laptop");
    let mut app = app(
        &harness,
        vec![
            snapshot(&laptop, vec![pr400("pr400", json!({}))]),
            snapshot(&vm(), vec![pr400("pr400vm", json!({"age": "21h"}))]),
        ],
    );
    app.nav.chat.set_open(false);
    let mut runtime = runtime(app);
    let mut narrowest = f32::MAX;
    for scale in [1.0, 1.5, 2.0] {
        for size in SIZES {
            narrowest = narrowest.min(mr_rows_fit(&mut runtime, "card-pr400", size, scale));
        }
    }
    assert!(
        narrowest < 320.0,
        "no card was as narrow as the screenshot's: {narrowest}"
    );

    runtime.set_viewport((1000.0, 900.0), 1.0);
    settle_layout(&mut runtime);
    press_mr_button(&mut runtime, "Open pull request");
    assert!(
        harness
            .fake
            .asked_of("openLink")
            .iter()
            .any(|asked| asked["url"] == PR400),
        "{:?}",
        harness.fake.asked_of("openLink")
    );
    press_mr_button(&mut runtime, "on vm-mk");
    assert_eq!(
        runtime.state.open_run,
        Some(("inst-vm".into(), "r-pr400vm".into()))
    );
}

#[test]
fn card_mr_rows_keep_long_machine_and_project_names_inside_the_card() {
    let harness = Harness::new();
    let long = "https://github.com/cego/collie-desktop-native-board-renderer/pull/400";
    let here = machine(
        "inst-laptop",
        "p-laptop",
        "mk-laptop-workstation-copenhagen-office",
    );
    let there = machine("inst-vm", "p-vm", "vm-mk-build-runner-eu-north-1-large");
    let mut app = app(
        &harness,
        vec![
            snapshot(&here, vec![pr400("pr400", json!({"mr": long}))]),
            snapshot(&there, vec![pr400("pr400vm", json!({"mr": long}))]),
        ],
    );
    app.nav.chat.set_open(false);
    let mut runtime = runtime(app);
    for scale in [1.0, 2.0] {
        for size in SIZES {
            mr_rows_fit(&mut runtime, "card-pr400", size, scale);
        }
    }
    let names: Vec<String> = runtime
        .elements()
        .into_iter()
        .filter(|e| e.role == "button" && e.path.contains("/mrs/"))
        .filter_map(|e| e.label)
        .collect();
    assert!(
        names.contains(&"on vm-mk-build-runner-eu-north-1-large".to_string()),
        "a cut name is still read whole: {names:?}"
    );
}

#[test]
fn card_mr_rows_of_one_machines_several_merge_requests_fit_a_narrow_card() {
    let harness = Harness::new();
    let mr = |iid: &str, repo: &str| {
        json!({"id": format!("github.com/cego/{repo}#{iid}"),
            "mr": format!("https://github.com/cego/{repo}/pull/{iid}"),
            "label": format!("cego/{repo}#{iid}"), "short": format!("{repo}#{iid}"),
            "url": format!("https://github.com/cego/{repo}/pull/{iid}"), "run": "r-pr400",
            "state": "open", "checks": null, "head": "0123456789abcdef", "ready": true,
            "disposition": null, "waitsOn": []})
    };
    let laptop = machine("inst-laptop", "p-laptop", "mk-laptop");
    let mut app = app(
        &harness,
        vec![snapshot(
            &laptop,
            vec![pr400(
                "pr400",
                json!({"mrs": [mr("400", "collie"), mr("401", "collie-desktop-native-board")]}),
            )],
        )],
    );
    app.nav.chat.set_open(false);
    let mut runtime = runtime(app);
    for scale in [1.0, 2.0] {
        for size in SIZES {
            mr_rows_fit(&mut runtime, "card-pr400", size, scale);
        }
    }
}
