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
    runtime.frame(0.0);
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
    assert_eq!(cards_in(&runtime, "waiting"), ["Ready", "Fresh"]);
    let older = node(&runtime, "waiting-older").expect("the older fold");
    assert!(
        within(&older)
            .iter()
            .any(|n| n["name"] == "1 older than a week"),
        "{older}"
    );
    press(&mut runtime, "waiting-older");
    assert_eq!(cards_in(&runtime, "waiting"), ["Ready", "Fresh", "Stale"]);
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
fn a_machine_without_collie_is_said_with_onboard_which_opens_machines_and_one_out_of_reach_has_no_action()
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
    assert_eq!(runtime.state.nav.page, Page::Machines);
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
        runtime.state.board.selected.as_deref(),
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
    assert_eq!(runtime.state.board.selected, None);

    double_press(&mut runtime, "card-t1");
    assert_eq!(
        *panes.lock().unwrap(),
        [("inst-pc".into(), "r-t1".into(), "mk-pc".into())]
    );
    assert_eq!(runtime.state.board.selected.as_deref(), Some("inst-pc:t1"));
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
