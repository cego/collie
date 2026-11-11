//! The Schedules page: each Machine's Schedules in words, and pausing, resuming, removing or
//! moving the chosen one, through the fake core.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::pages::schedules::{
    Action, Ask, Standing, UPGRADE_SAID, machine_schedules, schedule_ask,
};
use collie_desktop_board::shell::Page;
use collie_desktop_protocol::generated::{Change, ChangeSchedulePayload, SchedulesSuccessItem};
use rune::Runtime;
use serde_json::{Value, json};
use support::{flock_app, runtime, said, settle, tap};

fn entry(over: Value) -> Value {
    let mut entry = json!({
        "machine": { "installation": "i-vm", "hostname": "vm" },
        "name": "daily",
        "workflow": "self-improve",
        "checkout": "/src/collie",
        "cron": "0 7 * * *",
        "tz": "Europe/Copenhagen",
        "paused": false,
        "start": { "workflow": "self-improve", "inputs": {}, "workspace": "/src/collie", "verify": [] },
        "next": "2026-10-15T05:00:00.000Z",
        "last": null,
    });
    for (key, value) in over.as_object().unwrap() {
        entry[key] = value.clone();
    }
    entry
}

fn on(over: Value) -> Value {
    let mut on = json!({ "installation": "i-vm", "profile": "vm", "name": "vm",
        "schedules": [], "problem": null, "unreachable": false });
    for (key, value) in over.as_object().unwrap() {
        on[key] = value.clone();
    }
    on
}

fn machine(over: Value) -> SchedulesSuccessItem {
    serde_json::from_value(on(over)).unwrap()
}

#[test]
fn each_last_occurrence_says_what_became_of_it() {
    let at = "2026-10-14T05:00:00.000Z";
    let said = |last: Value| {
        machine_schedules(&machine(
            json!({ "schedules": [entry(json!({ "last": last }))] }),
        ))
        .rows[0]
            .last
            .clone()
    };
    assert_eq!(said(Value::Null), "nothing yet");
    let outcome = |outcome: Value| json!({ "occurrence": at, "outcome": outcome });
    assert_eq!(
        said(outcome(
            json!({ "kind": "run", "run": "run-1", "status": "complete" })
        )),
        format!("{at} run-1 complete")
    );
    assert_eq!(
        said(outcome(
            json!({ "kind": "waiting-for-run", "run": "run-0", "status": "running" })
        )),
        format!("{at} waiting for run-0 (running)")
    );
    assert_eq!(
        said(outcome(json!({ "kind": "waiting-for-herdr" }))),
        format!("{at} waiting for herdr")
    );
    assert_eq!(
        said(outcome(
            json!({ "kind": "refused", "reason": "needs_input: note" })
        )),
        format!("{at} refused: needs_input: note")
    );
}

#[test]
fn a_row_says_when_it_fires_in_words_with_its_cron_expression_and_time_zone() {
    let row =
        machine_schedules(&machine(json!({ "schedules": [entry(json!({}))] }))).rows[0].clone();
    assert_eq!(
        (
            row.name.as_str(),
            row.workflow.as_str(),
            row.checkout.as_str()
        ),
        ("daily", "self-improve", "/src/collie")
    );
    assert_eq!(row.when, "every day at 07:00 (0 7 * * * Europe/Copenhagen)");
    assert_eq!(row.next, "next 2026-10-15T05:00:00.000Z");
    let when = |cron: &str| {
        machine_schedules(&machine(
            json!({ "schedules": [entry(json!({ "cron": cron }))] }),
        ))
        .rows[0]
            .when
            .clone()
    };
    assert_eq!(
        when("30 6 * * 1-5"),
        "weekdays at 06:30 (30 6 * * 1-5 Europe/Copenhagen)"
    );
    assert_eq!(when("0 7 1 */2 *"), "0 7 1 */2 * Europe/Copenhagen");
}

#[test]
fn a_paused_schedule_offers_resume_remove_and_move_and_an_active_one_pause_remove_and_move() {
    let view = machine_schedules(&machine(json!({ "schedules": [
        entry(json!({ "name": "off", "paused": true, "next": null })),
        entry(json!({})),
    ] })));
    let rows: Vec<(&str, &str, &[Action])> = view
        .rows
        .iter()
        .map(|r| (r.name.as_str(), r.next.as_str(), r.actions.as_slice()))
        .collect();
    assert_eq!(
        rows,
        [
            (
                "off",
                "paused",
                &[Action::Resume, Action::Remove, Action::Move][..]
            ),
            (
                "daily",
                "next 2026-10-15T05:00:00.000Z",
                &[Action::Pause, Action::Remove, Action::Move][..]
            ),
        ]
    );
}

#[test]
fn a_rows_pause_resume_and_remove_ask_its_machines_host_and_move_opens_the_dialog() {
    for (action, change, wire) in [
        (Action::Pause, Change::Pause, "pause"),
        (Action::Resume, Change::Resume, "resume"),
        (Action::Remove, Change::Remove, "remove"),
    ] {
        let payload = ChangeSchedulePayload {
            installation: "i-vm".into(),
            change,
            name: "daily".into(),
            request: None,
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({ "installation": "i-vm", "name": "daily", "change": wire })
        );
        assert_eq!(schedule_ask("i-vm", "daily", action), Ask::Change(payload));
    }
    assert_eq!(
        schedule_ask("i-vm", "daily", Action::Move),
        Ask::Move {
            from: "i-vm".into(),
            name: "daily".into()
        }
    );
}

#[test]
fn a_host_too_old_to_list_schedules_asks_for_an_upgrade() {
    let view = machine_schedules(&machine(json!({ "problem": UPGRADE_SAID })));
    assert_eq!(
        (view.state, view.said.as_deref(), view.rows.len()),
        (Standing::Upgrade, Some(UPGRADE_SAID), 0)
    );
}

#[test]
fn an_unreachable_machine_says_its_schedules_still_fire_there_and_offers_nothing() {
    let view = machine_schedules(&machine(json!({ "unreachable": true,
        "problem": "its host did not answer in time", "schedules": [entry(json!({}))] })));
    assert_eq!(view.state, Standing::Unreachable);
    assert_eq!(
        view.said.as_deref(),
        Some(
            "vm is unreachable (its host did not answer in time); its Schedules still fire there while its host runs."
        )
    );
    assert!(view.rows.is_empty());
}

#[test]
fn a_machine_with_none_says_so_and_that_the_flock_chat_adds_them() {
    let view = machine_schedules(&machine(json!({})));
    assert_eq!(
        (view.state, view.said.as_deref()),
        (
            Standing::Empty,
            Some("No Schedules on vm. Ask the Flock chat to add one.")
        )
    );
}

// The page itself, through the fake core.

fn schedules_page(harness: &Harness<App>) -> Runtime<App> {
    let mut app = flock_app(harness);
    app.open_page(Page::Schedules);
    let mut runtime = runtime(app);
    let listed = json!([
        on(
            json!({ "installation": "i-vm", "profile": "p-vm", "name": "vm",
            "schedules": [entry(json!({}))] })
        ),
        on(json!({ "installation": "i-pc", "profile": "local", "name": "mk-pc" })),
    ]);
    harness.fake.answer("schedules", Ok(listed));
    settle(harness, &mut runtime);
    runtime
}

#[test]
fn the_page_lists_each_machines_schedules_and_says_which_has_none() {
    let harness = Harness::<App>::new();
    let runtime = schedules_page(&harness);
    assert_eq!(harness.fake.asked_of("schedules").len(), 1);
    let mut runtime = runtime;
    runtime.frame(100.0);
    assert!(said(
        &runtime,
        "No Schedules on mk-pc. Ask the Flock chat to add one."
    ));
    assert!(said(
        &runtime,
        "every day at 07:00 (0 7 * * * Europe/Copenhagen)"
    ));
    assert!(said(
        &runtime,
        "Choose a Schedule to pause, resume, remove or move it."
    ));
}

#[test]
fn pausing_the_chosen_schedule_asks_its_host_says_what_it_did_and_reads_again() {
    let harness = Harness::<App>::new();
    let mut runtime = schedules_page(&harness);
    let mut at = 100.0;
    tap(&mut runtime, "schedules/i-vm/daily", &mut at);
    assert!(said(&runtime, "daily on vm"));
    tap(&mut runtime, "schedule-pause", &mut at);
    assert_eq!(
        harness.fake.asked_of("changeSchedule"),
        [json!({ "installation": "i-vm", "name": "daily", "change": "pause" })]
    );
    harness
        .fake
        .answer("changeSchedule", Ok(json!("Paused daily")));
    settle(&harness, &mut runtime);
    assert_eq!(runtime.state.pages.schedules.told.texts(), ["Paused daily"]);
    assert_eq!(
        harness.fake.asked_of("schedules").len(),
        2,
        "it reads again"
    );
    tap(&mut runtime, "schedule-remove", &mut at);
    harness
        .fake
        .answer("changeSchedule", Err(CallError("vm's host refused".into())));
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(&runtime, "vm's host refused"));
}

#[test]
fn moving_a_schedule_sends_it_to_the_machine_chosen_with_its_checkout_there() {
    let harness = Harness::<App>::new();
    let mut runtime = schedules_page(&harness);
    let mut at = 100.0;
    tap(&mut runtime, "schedules/i-vm/daily", &mut at);
    tap(&mut runtime, "schedule-move", &mut at);
    assert!(
        said(&runtime, "mk-pc"),
        "the other reachable Machine is offered"
    );
    let moving = runtime.state.pages.schedules.moving.as_mut().unwrap();
    assert_eq!(moving.to.as_deref(), Some("i-pc"));
    moving.checkout.replace_text(" /home/mk/src/collie ");
    tap(&mut runtime, "move-submit", &mut at);
    assert_eq!(
        harness.fake.asked_of("moveSchedule"),
        [
            json!({ "from": "i-vm", "to": "i-pc", "name": "daily", "checkout": "/home/mk/src/collie" })
        ]
    );
    assert!(runtime.state.pages.schedules.moving.is_none());
}
