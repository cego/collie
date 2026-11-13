//! The board's logic without a view: Desktop's own cases (`test/desktop-view.test.ts`,
//! `test/desktop-pending-answer.test.ts`, `test/desktop-questionnaire.test.ts`,
//! `test/desktop-retry.test.ts`), read against the Rust copy.

use collie_desktop_board::board::answers::{
    Answering, Condition, Now, Sitting, answer_key, card_question,
};
use collie_desktop_board::board::cards::{CardAction, CardMr, card_actions, card_flow, card_mrs};
use collie_desktop_board::board::model::{
    Flock, Shown, apply_item, placed, reaching, reaching_said,
};
use collie_desktop_board::board::questionnaire::{Does, Event, HOLD, Questionnaire, Where};
use collie_desktop_board::board::{backoff, renewal_due};
use collie_desktop_board::calls::{Failure, said};
use collie_desktop_protocol::client::RpcError;
use collie_desktop_protocol::generated::{Flow, Question, Task};
use serde_json::{Value, json};

fn task(id: &str, state: &str, more: Value) -> Value {
    let mut task = json!({
        "id": id, "name": id, "project": "content", "state": state, "steps": [],
        "sentence": "", "age": "5m", "drift": null, "held": null, "heldBy": null,
        "decision": null, "agents": [], "children": [], "mr": null, "branch": null,
        "disposition": null, "landed": false, "ended": null, "mrState": null,
        "planReady": false, "offer": null, "run": "r-1", "runs": ["r-1"], "at": 1.0,
    });
    for (key, value) in more.as_object().into_iter().flatten() {
        task[key] = value.clone();
    }
    task
}

fn snapshot(machine: Value, tasks: Vec<Value>, herds: Value) -> Value {
    json!({"machine": machine, "message": {
        "_tag": "Snapshot", "installation": machine["installation"], "build": "0.118.0",
        "protocol": 7, "herds": herds, "tasks": tasks, "seq": 1,
    }})
}

fn pc() -> Value {
    json!({"installation": "inst-pc", "profile": "local", "name": "mk-pc"})
}

fn vm() -> Value {
    json!({"installation": "inst-vm", "profile": "p-vm", "name": "vm-mk",
        "target": "mk@vm-mk.cegohost.dk"})
}

fn default_herd() -> Value {
    json!([{"id": "default"}])
}

/// Each card's id and where it says it is, as `where` in Desktop's view test.
fn where_(items: Vec<Value>) -> Vec<(String, String)> {
    let (mut machines, mut flock): (Vec<Shown>, Flock) = Default::default();
    for item in items {
        apply_item(
            &mut machines,
            &mut flock,
            serde_json::from_value(item).unwrap(),
        );
    }
    placed(&machines)
        .into_iter()
        .map(|p| (p.task.id.clone(), p.place))
        .collect()
}

fn pairs(said: &[(&str, &str)]) -> Vec<(String, String)> {
    said.iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}

#[test]
fn a_card_names_its_machine_only_once_the_flock_has_more_than_one() {
    let asking = task("t-ask", "blocked", json!({"at": 3.0}));
    assert_eq!(
        where_(vec![snapshot(pc(), vec![asking.clone()], default_herd())]),
        pairs(&[("t-ask", "")])
    );
    assert_eq!(
        where_(vec![
            snapshot(pc(), vec![asking.clone()], default_herd()),
            snapshot(
                vm(),
                vec![task("t-ask", "active", json!({}))],
                default_herd()
            ),
        ]),
        pairs(&[("t-ask", "mk-pc"), ("t-ask", "vm-mk")])
    );
}

#[test]
fn a_card_names_its_herd_only_when_its_machine_runs_several() {
    let herds =
        json!([{"id": "h1", "name": "default"}, {"id": "h2", "name": "work"}, {"id": "h3"}]);
    assert_eq!(
        where_(vec![
            snapshot(
                pc(),
                vec![task("t-pc", "active", json!({"herd": "h1", "at": 1.0}))],
                default_herd()
            ),
            snapshot(
                vm(),
                vec![
                    task("t-ask", "blocked", json!({"herd": "h2", "at": 3.0})),
                    task("t-work", "active", json!({"herd": "h3", "at": 2.0})),
                ],
                herds
            ),
        ]),
        pairs(&[
            ("t-ask", "vm-mk · work"),
            ("t-work", "vm-mk · h3"),
            ("t-pc", "mk-pc")
        ])
    );
}

#[test]
fn machines_that_share_a_name_are_told_apart_by_how_they_are_reached() {
    let mut named_vm = pc();
    named_vm["name"] = json!("vm-mk");
    let other = json!({"installation": "inst-vm2", "profile": "p-vm2", "name": "vm-mk",
        "target": "mk@vm-mk2"});
    assert_eq!(
        where_(vec![
            snapshot(
                named_vm,
                vec![task("t-ask", "blocked", json!({"at": 3.0}))],
                default_herd()
            ),
            snapshot(
                vm(),
                vec![task("t-vm", "active", json!({"at": 2.0}))],
                default_herd()
            ),
            snapshot(
                other,
                vec![task("t-work", "active", json!({"at": 2.0}))],
                default_herd()
            ),
        ]),
        pairs(&[
            ("t-ask", "vm-mk (local)"),
            ("t-vm", "vm-mk (mk@vm-mk.cegohost.dk)"),
            ("t-work", "vm-mk (mk@vm-mk2)")
        ])
    );
}

#[test]
fn a_saved_board_stands_in_until_its_machine_is_live_and_never_over_a_live_one() {
    let saved = json!({"_tag": "Saved", "machine": vm(), "herds": [{"id": "default"}],
        "tasks": [task("t-work", "active", json!({}))], "at": 7.0});
    let as_of = |items: Vec<Value>| {
        let (mut machines, mut flock): (Vec<Shown>, Flock) = Default::default();
        for item in items {
            apply_item(
                &mut machines,
                &mut flock,
                serde_json::from_value(item).unwrap(),
            );
        }
        placed(&machines)
            .into_iter()
            .map(|p| (p.task.id.clone(), p.as_of))
            .collect::<Vec<_>>()
    };
    let live = snapshot(
        vm(),
        vec![task("t-ask", "blocked", json!({}))],
        default_herd(),
    );
    assert_eq!(as_of(vec![saved.clone()]), [("t-work".into(), Some(7.0))]);
    assert_eq!(
        as_of(vec![saved.clone(), live.clone()]),
        [("t-ask".into(), None)]
    );
    assert_eq!(as_of(vec![live, saved]), [("t-ask".into(), None)]);
}

fn mr(project: &str, iid: u32, more: Value) -> Value {
    let short = format!("{}!{iid}", project.rsplit('/').next().unwrap());
    let url = format!("https://gitlab.cego.dk/{project}/-/merge_requests/{iid}");
    let mut one = json!({"id": format!("gitlab.cego.dk/{project}!{iid}"), "mr": url,
        "label": format!("{project}!{iid}"), "short": short, "url": url, "run": "r-1",
        "state": "open", "checks": null, "head": null, "ready": false, "disposition": null,
        "waitsOn": []});
    for (key, value) in more.as_object().into_iter().flatten() {
        one[key] = value.clone();
    }
    one
}

#[test]
fn a_fan_out_cards_offers_keep_each_owning_run_and_unavailable_reason() {
    let offers = json!([
        {"id": "release", "title": "Release app!12", "run": "r-app"},
        {"id": "stage", "title": "Stage app!12", "run": "r-app",
            "unavailable": "a Stage is still going"},
        {"id": "release", "title": "Release api!7", "run": "r-api"},
        {"id": "stage", "title": "Stage api!7", "run": "r-api"}
    ]);
    for primary in [Value::Null, offers[0].clone()] {
        let card: Task = serde_json::from_value(task(
            "fan",
            "done",
            json!({"offer": primary, "offers": offers}),
        ))
        .unwrap();
        let shown: Vec<Value> = card_actions(&card)
            .into_iter()
            .filter_map(|action| match action {
                CardAction::Offer(offer) => Some(serde_json::to_value(offer).unwrap()),
                _ => None,
            })
            .collect();
        assert_eq!(shown, offers.as_array().unwrap().as_slice());
    }
}

fn card(id: &str, line: &str, label: &str, url: &str) -> CardMr {
    CardMr {
        id: id.into(),
        line: line.into(),
        open: Some((label.into(), url.into())),
    }
}

#[test]
fn a_card_of_two_merge_requests_has_a_line_and_an_open_for_each_and_one_from_an_older_host_its_single_one()
 {
    let app = mr(
        "spilnu/app",
        12,
        json!({"ready": true, "head": "aaaaaaaabbbb"}),
    );
    let api = mr("spilnu/api", 7, json!({"waitsOn": [app["id"]]}));
    let of = |more: Value| -> Task { serde_json::from_value(task("t", "done", more)).unwrap() };
    assert_eq!(
        card_mrs(&of(json!({"mr": app["mr"], "mrs": [app, api]}))),
        [
            card(
                "gitlab.cego.dk/spilnu/app!12",
                "app!12 · open, ready to release at aaaaaaaa",
                "Open MR app!12",
                "https://gitlab.cego.dk/spilnu/app/-/merge_requests/12"
            ),
            card(
                "gitlab.cego.dk/spilnu/api!7",
                "api!7 · open, not ready to release, waits on app!12",
                "Open MR api!7",
                "https://gitlab.cego.dk/spilnu/api/-/merge_requests/7"
            ),
        ]
    );
    assert_eq!(
        card_mrs(&of(json!({"mr": app["mr"], "mrState": "open"}))),
        [card(
            "gitlab.cego.dk/spilnu/app!12",
            "app!12 · open, not ready to release",
            "Open merge request",
            "https://gitlab.cego.dk/spilnu/app/-/merge_requests/12"
        )]
    );
    assert_eq!(card_mrs(&of(json!({}))), []);
}

fn question(id: &str, run: &str) -> Question {
    serde_json::from_value(
        json!({"kind": "question", "run": run, "id": id, "step": "plan",
        "topic": id, "text": format!("About {id}?"), "options": []}),
    )
    .unwrap()
}

fn now<'a>(open: &'a [Question], answering: &'a Answering) -> Now<'a> {
    Now {
        installation: "vm",
        open: open.iter().collect(),
        answering,
    }
}

fn sending(state: &mut Answering, asked: &Question, shown: &str, send: u64) {
    state.sent(
        &answer_key("vm", &asked.run, &asked.id),
        shown.into(),
        "vm-mk".into(),
        send,
    );
}

#[test]
fn the_sitting_counts_k_of_n_and_back_and_next_never_wrap() {
    let open = [
        question("a", "r-1"),
        question("b", "r-1"),
        question("c", "r-2"),
    ];
    let none = Answering::default();
    let start = Sitting::starts(&now(&open, &none));
    let view = start.view(&now(&open, &none));
    assert_eq!(
        (view.k, view.n, view.question, view.back, view.next),
        (1, 3, Some(open[0].clone()), false, true)
    );
    let last = start.moved(1).moved(1);
    let view = last.view(&now(&open, &none));
    assert_eq!((view.k, view.next), (3, false));
    assert_eq!(last.moved(1), last);
    assert_eq!(start.moved(-1), start);
}

#[test]
fn answering_moves_to_the_next_unanswered_question_after_it_wrapping_round() {
    let open = [
        question("a", "r-1"),
        question("b", "r-1"),
        question("c", "r-2"),
    ];
    let mut state = Answering::default();
    let mut sitting = Sitting::starts(&now(&open, &state)).moved(1);
    sending(&mut state, &open[1], "no", 1);
    sitting = sitting.answered(&now(&open, &state));
    assert_eq!(
        sitting.view(&now(&open, &state)).question,
        Some(open[2].clone())
    );
    sending(&mut state, &open[2], "maybe", 2);
    sitting = sitting.answered(&now(&open, &state));
    assert_eq!(
        sitting.view(&now(&open, &state)).question,
        Some(open[0].clone())
    );
    sending(&mut state, &open[0], "yes", 3);
    sitting = sitting.answered(&now(&open, &state));
    let view = sitting.view(&now(&open, &state));
    assert_eq!(view.question, Some(open[0].clone()));
    assert_eq!(
        view.condition,
        Some(Condition::Answered {
            said: "Sending yes to vm-mk…".into(),
            sending: true
        })
    );
}

#[test]
fn a_question_arriving_while_open_joins_and_the_dialog_moves_to_it_from_one_it_cannot_answer() {
    let (a, b) = (question("a", "r-1"), question("b", "r-1"));
    let mut state = Answering::default();
    let only = [a.clone()];
    let both = [a, b.clone()];
    let mut sitting = Sitting::starts(&now(&only, &state));
    sending(&mut state, &only[0], "yes", 1);
    sitting = sitting.answered(&now(&only, &state));
    sitting = sitting.sees(&now(&both, &state));
    let view = sitting.view(&now(&both, &state));
    assert_eq!((view.k, view.n, view.question), (2, 2, Some(b)));

    let none = Answering::default();
    let stays = Sitting::starts(&now(&only, &none)).sees(&now(&both, &none));
    let view = stays.view(&now(&both, &none));
    assert_eq!((view.k, view.n), (1, 2));
}

#[test]
fn a_question_answered_elsewhere_stays_as_no_longer_open_and_one_answered_here_reads_answered() {
    let open = [question("a", "r-1"), question("b", "r-1")];
    let mut state = Answering::default();
    sending(&mut state, &open[0], "yes", 1);
    state.tried(&answer_key("vm", "r-1", "a"), 1, Some(true));
    let mut sitting = Sitting::starts(&now(&open, &Answering::default()));
    sitting = sitting.answered(&now(&open, &state));
    let board: Task =
        serde_json::from_value(task("t", "blocked", json!({"questions": []}))).unwrap();
    state.settled([("vm", &board)]);
    sitting = sitting.sees(&now(&[], &state));
    let at = |k: usize| {
        let to = k as isize - 1 - sitting.cursor as isize;
        sitting.moved(to).view(&now(&[], &state))
    };
    assert_eq!(at(1).n, 2);
    assert_eq!(
        at(1).condition,
        Some(Condition::Answered {
            said: "Answered yes".into(),
            sending: false
        })
    );
    assert_eq!(at(2).condition, Some(Condition::Gone));
}

#[test]
fn the_card_counts_only_questions_with_no_answer_in_flight_then_says_how_many_are_sending() {
    let (a, b) = (question("a", "r-1"), question("b", "r-1"));
    let board: Task = serde_json::from_value(task(
        "t",
        "blocked",
        json!({"decision": a, "questions": [a, b]}),
    ))
    .unwrap();
    let mut state = Answering::default();
    let said = card_question(&board, "vm", &state).unwrap();
    assert_eq!(
        (said.text.as_str(), said.label.as_deref()),
        ("About a?", Some("Answer 2 questions…"))
    );
    sending(&mut state, &a, "yes", 1);
    let said = card_question(&board, "vm", &state).unwrap();
    assert_eq!(
        (said.text.as_str(), said.label.as_deref()),
        ("About b?", Some("Answer…"))
    );
    sending(&mut state, &b, "no", 2);
    let said = card_question(&board, "vm", &state).unwrap();
    assert_eq!(said.pending.as_deref(), Some("Sending 2 answers to vm-mk…"));
    state.tried(&answer_key("vm", "r-1", "a"), 1, Some(true));
    state.tried(&answer_key("vm", "r-1", "b"), 2, Some(true));
    let said = card_question(&board, "vm", &state).unwrap();
    assert_eq!(
        said.pending.as_deref(),
        Some("Answered 2 questions; waiting for vm-mk's board")
    );
    // A failed try takes its answer back; a try a newer answer replaced changes nothing.
    sending(&mut state, &a, "no", 3);
    state.tried(&answer_key("vm", "r-1", "a"), 1, Some(false));
    assert!(state.answers.contains_key(&answer_key("vm", "r-1", "a")));
    state.tried(&answer_key("vm", "r-1", "a"), 3, Some(false));
    assert!(!state.answers.contains_key(&answer_key("vm", "r-1", "a")));
}

fn choices(more: Value) -> Question {
    let mut asked = json!({"kind": "question", "run": "r-1", "id": "c1", "step": "plan",
    "topic": "path", "text": "Keep it?", "options": [
        {"id": "yes", "title": "Yes", "subtitle": null},
        {"id": "no", "title": "No", "subtitle": null},
    ]});
    for (key, value) in more.as_object().into_iter().flatten() {
        asked[key] = value.clone();
    }
    serde_json::from_value(asked).unwrap()
}

fn key(name: &str, at: Where) -> Event {
    Event::Key {
        key: name.into(),
        r#mod: false,
        at,
    }
}

#[test]
fn arrows_move_the_check_past_a_hold_that_is_not_offered_and_hold_sends_a_control() {
    let mut asked = Questionnaire::new(choices(
        json!({"hold": {"offered": false, "why": "nothing to hold"}}),
    ));
    let view = asked.view();
    let hold = &view.rows[2].0;
    assert_eq!(
        (hold.id.as_str(), hold.disabled, hold.why.as_deref()),
        (HOLD, true, Some("nothing to hold"))
    );
    asked.step(key("ArrowDown", Where::Group));
    assert_eq!(asked.checked.as_deref(), Some("no"));
    asked.step(key("ArrowDown", Where::Group));
    assert_eq!(asked.checked.as_deref(), Some("yes"), "it wraps past Hold");
    asked.step(key("End", Where::Group));
    assert_eq!(
        asked.checked.as_deref(),
        Some("no"),
        "End is the last it can take"
    );

    let mut held = Questionnaire::new(choices(json!({"hold": {"offered": true, "why": null}})));
    held.step(Event::Pick(HOLD.into()));
    let Some(Does::Send { action, .. }) = held.step(Event::Submit("q-1".into())) else {
        panic!("Submit sends");
    };
    assert_eq!(
        action,
        json!({"_tag": "Control", "runId": "r-1", "control": "hold", "set": true,
            "reason": "held at question c1"})
    );
    held.step(Event::Replied {
        request: "q-1".into(),
        outcome: Ok(()),
    });
    assert_eq!(
        held.view().status.as_deref(),
        Some("Run held · question still open")
    );
}

#[test]
fn enter_submits_only_with_a_modifier_in_the_options_and_a_resend_keeps_its_request() {
    let mut asked = Questionnaire::new(choices(json!({})));
    asked.step(Event::Pick("no".into()));
    assert_eq!(asked.step(key("Enter", Where::Group)), None);
    let submit = asked.step(Event::Key {
        key: "Enter".into(),
        r#mod: true,
        at: Where::Group,
    });
    assert_eq!(submit, Some(Does::Submit));
    let Some(Does::Send { request, .. }) = asked.step(Event::Submit("first".into())) else {
        panic!("Submit sends");
    };
    asked.step(Event::Replied {
        request: request.clone(),
        outcome: Err((false, "busy".into())),
    });
    assert_eq!(asked.view().status.as_deref(), Some("busy"));
    let Some(Does::Send { request: again, .. }) = asked.step(Event::Submit("second".into())) else {
        panic!("Submit sends again");
    };
    assert_eq!(
        again, "first",
        "the same answer goes again under its request"
    );
}

#[test]
fn steering_is_off_where_the_question_names_no_agent_and_goes_to_the_one_it_names() {
    let mut nobody = Questionnaire::new(choices(
        json!({"steer": {"agent": null, "why": "no agent is running"}}),
    ));
    nobody.step(Event::Draft("try again".into()));
    let view = nobody.view();
    assert!(view.steer_disabled && !view.steer_send);
    assert_eq!(view.steer_why.as_deref(), Some("no agent is running"));

    let mut planner = Questionnaire::new(choices(
        json!({"steer": {"agent": "planner-1", "why": null}}),
    ));
    planner.step(Event::Draft(" look at the API first ".into()));
    assert_eq!(planner.view().steer_label, "Send to planner-1");
    let Some(Does::Send { action, request }) = planner.step(Event::Steer("s-1".into())) else {
        panic!("Steer sends");
    };
    assert_eq!(
        action,
        json!({"_tag": "Deliver", "runId": "r-1", "agent": "planner-1",
            "text": "look at the API first"})
    );
    planner.step(Event::Replied {
        request,
        outcome: Ok(()),
    });
    assert_eq!(
        planner.view().status.as_deref(),
        Some("Sent to planner-1; the question is set aside")
    );
}

#[test]
fn a_failing_subscription_waits_one_second_then_two_and_never_more_than_a_minute() {
    let waits: Vec<f64> = (0..8).map(backoff).collect();
    assert_eq!(
        waits,
        [
            1000.0, 2000.0, 4000.0, 8000.0, 16000.0, 32000.0, 60000.0, 60000.0
        ]
    );
}

#[test]
fn a_token_is_due_for_renewal_within_fourteen_days_of_expiring() {
    // 2026-11-11T12:00:00Z.
    let now = 1_794_398_400_000.0;
    assert!(renewal_due(Some("2026-11-24"), now));
    assert!(!renewal_due(Some("2026-11-26"), now));
    assert!(
        renewal_due(Some("2026-11-01"), now),
        "an expired one is due"
    );
    assert!(!renewal_due(None, now));
    assert!(!renewal_due(Some("soon"), now));
}

fn said_while_reaching(items: Vec<Value>) -> Option<String> {
    let (mut machines, mut flock): (Vec<Shown>, Flock) = Default::default();
    for item in items {
        apply_item(
            &mut machines,
            &mut flock,
            serde_json::from_value(item).unwrap(),
        );
    }
    reaching_said(&reaching(&machines, &flock), 0)
}

fn routed(machine: Value) -> Value {
    json!({"_tag": "Routed", "machine": machine})
}

fn saved(machine: Value, at: f64) -> Value {
    json!({"_tag": "Saved", "machine": machine, "herds": default_herd(), "tasks": [], "at": at})
}

#[test]
fn the_board_names_each_machine_it_is_still_reaching_and_how_old_its_saved_cards_are() {
    let at = 14.0 * 3_600_000.0 + 5.0 * 60_000.0;
    assert_eq!(
        said_while_reaching(vec![routed(pc()), routed(vm())]).as_deref(),
        Some("Reaching mk-pc and vm-mk…")
    );
    assert_eq!(
        said_while_reaching(vec![routed(pc()), routed(vm()), saved(vm(), at)]).as_deref(),
        Some("Reaching mk-pc and vm-mk; vm-mk's cards are as of 14:05.")
    );
    assert_eq!(
        said_while_reaching(vec![
            routed(pc()),
            routed(vm()),
            saved(vm(), at),
            snapshot(pc(), vec![], default_herd()),
        ])
        .as_deref(),
        Some("Reaching vm-mk; its cards are as of 14:05.")
    );
    assert_eq!(
        said_while_reaching(vec![saved(pc(), at), saved(vm(), at)]).as_deref(),
        Some("Reaching mk-pc and vm-mk; the cards shown are what each last said.")
    );
    assert_eq!(
        said_while_reaching(vec![
            routed(vm()),
            saved(vm(), at),
            snapshot(vm(), vec![], default_herd()),
        ]),
        None
    );
    assert_eq!(
        said_while_reaching(vec![
            routed(vm()),
            json!({"_tag": "Lost", "machine": {"profile": "p-vm", "name": "vm-mk"},
                "state": "unreachable", "reason": "gone", "at": at}),
        ]),
        None,
        "a Machine out of reach is said by its alert, not as one being reached"
    );
}

fn flow(states: &[&str], current: Value) -> Flow {
    serde_json::from_value(json!({
        "glyphs": states.iter().map(|s| json!({"title": s, "state": s})).collect::<Vec<_>>(),
        "release": 0, "current": current,
    }))
    .unwrap()
}

#[test]
fn a_flow_with_no_step_under_way_says_done_only_when_every_step_is() {
    let all = card_flow(Some(&flow(&["done", "done"], Value::Null))).unwrap();
    assert_eq!(
        (all.label.as_str(), all.name.as_str()),
        ("Done", "Flow: 2 of 2 Steps done.")
    );
    let failed = card_flow(Some(&flow(&["done", "failed", "not-run"], Value::Null))).unwrap();
    assert_eq!(
        (failed.label.as_str(), failed.name.as_str()),
        (
            "1 of 3 Steps done",
            "Flow: no Step under way. 1 of 3 Steps done."
        )
    );
}

#[test]
fn a_failure_the_host_marks_refused_is_told_from_one_worth_trying_again() {
    let refused = said(RpcError::Failed(
        json!({"reason": "the Run has already ended", "refused": true}),
    ));
    assert_eq!(
        refused,
        Failure {
            said: "the Run has already ended".into(),
            refused: true
        }
    );
    let busy = said(RpcError::Failed(
        json!({"reason": "Collie on mk-pc is busy"}),
    ));
    assert_eq!(
        busy,
        Failure {
            said: "Collie on mk-pc is busy".into(),
            refused: false
        }
    );
}
