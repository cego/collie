//! The Usage page: one section per Subscription account across the live Machines (ADR-0049),
//! and the page asking the fake core.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::pages::clock::Zone;
use collie_desktop_board::pages::usage::{Level, Section, usage_accounts, usage_page};
use collie_desktop_board::shell::Page;
use collie_desktop_protocol::generated::{Subscription, UsageSuccessItem};
use serde_json::{Value, json};
use support::{flock_app, runtime, said, settle};

const NOW: f64 = 1_791_446_400_000.0; // 2026-10-08T08:00:00Z

fn merged(mut base: Value, over: Value) -> Value {
    for (key, value) in over.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}

fn window(over: Value) -> Value {
    merged(
        json!({ "kind": "session", "label": "Session", "model": null, "usedPercent": 0,
            "resetsAt": "2026-10-08T10:10:00Z", "reached": false }),
        over,
    )
}

fn reading(over: Value) -> Value {
    merged(
        json!({ "subscription": "claude", "account": "org:acct", "accountLabel": "me@example.com",
            "plan": "max", "windows": [window(json!({ "usedPercent": 31 }))],
            "at": "2026-10-08T07:57:00Z", "source": "claude-usage", "problem": null }),
        over,
    )
}

fn chatgpt(over: Value) -> Value {
    reading(merged(
        json!({ "subscription": "chatgpt", "account": "workspace", "source": "codex-app-server" }),
        over,
    ))
}

fn machine(name: &str, readings: Vec<Value>) -> Value {
    json!({ "profile": format!("p-{name}"), "name": name, "readings": readings, "problem": null })
}

fn machines(list: Vec<Value>) -> Vec<UsageSuccessItem> {
    serde_json::from_value(Value::Array(list)).unwrap()
}

fn live(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| format!("p-{n}")).collect()
}

const EXPIRED: &str = "Claude Code's login expired; it refreshes when Claude Code next runs";

#[test]
fn a_machine_that_is_not_live_adds_nothing_and_takes_nothing_from_anothers_reading() {
    let accounts = usage_accounts(
        &machines(vec![
            machine("mk-pc", vec![reading(json!({}))]),
            machine(
                "gone",
                vec![
                    reading(json!({ "windows": [window(json!({ "usedPercent": 90 }))],
                        "at": "2026-10-08T07:59:00Z" })),
                    chatgpt(json!({})),
                ],
            ),
        ]),
        &live(&["mk-pc"]),
    );
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].newest.as_ref().unwrap().1, "mk-pc");
    let on: Vec<&str> = accounts[0].machines.iter().map(|m| m.0.as_str()).collect();
    assert_eq!(on, ["mk-pc"]);
}

#[test]
fn every_live_machine_on_the_account_is_listed_with_its_own_reading_in_the_flocks_order() {
    let expired = reading(json!({ "windows": [], "problem": "Claude Code's login expired" }));
    let accounts = usage_accounts(
        &machines(vec![
            machine("mk-pc", vec![reading(json!({}))]),
            machine("vm-mk", vec![expired]),
        ]),
        &live(&["vm-mk", "mk-pc"]),
    );
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].newest.as_ref().unwrap().1, "mk-pc");
    let on: Vec<(&str, Option<&str>)> = accounts[0]
        .machines
        .iter()
        .map(|(name, reading)| (name.as_str(), reading.problem.as_deref()))
        .collect();
    assert_eq!(
        on,
        [
            ("vm-mk", Some("Claude Code's login expired")),
            ("mk-pc", None)
        ]
    );
}

#[test]
fn an_account_read_only_with_problems_is_a_group_with_no_newest_reading() {
    let accounts = usage_accounts(
        &machines(vec![machine(
            "mk-pc",
            vec![reading(
                json!({ "windows": [], "problem": "Claude Code's login expired" }),
            )],
        )]),
        &live(&["mk-pc"]),
    );
    assert_eq!(accounts.len(), 1);
    assert!(accounts[0].newest.is_none());
    assert_eq!(accounts[0].machines.len(), 1);
}

#[test]
fn accounts_are_ordered_by_subscription_then_label_with_none_last() {
    let accounts = usage_accounts(
        &machines(vec![machine(
            "mk-pc",
            vec![
                chatgpt(json!({ "accountLabel": "me@example.com" })),
                reading(json!({ "account": null, "accountLabel": null })),
                reading(json!({ "account": "org:z", "accountLabel": "z@example.com" })),
                reading(json!({ "account": "org:a", "accountLabel": "a@example.com" })),
            ],
        )]),
        &live(&["mk-pc"]),
    );
    let order: Vec<(Subscription, Option<&str>)> = accounts
        .iter()
        .map(|a| (a.subscription.clone(), a.label.as_deref()))
        .collect();
    assert_eq!(
        order,
        [
            (Subscription::Claude, Some("a@example.com")),
            (Subscription::Claude, Some("z@example.com")),
            (Subscription::Claude, None),
            (Subscription::Chatgpt, Some("me@example.com")),
        ]
    );
}

fn page(list: Vec<Value>, on: &[&str]) -> collie_desktop_board::pages::usage::PageView {
    usage_page(&machines(list), &live(on), NOW, &Zone::utc())
}

const LAPTOP: [&str; 2] = ["mk-laptop", "vm-mk"];

#[test]
fn one_claude_seat_and_one_chatgpt_account_on_two_machines_are_two_sections_each_listing_both() {
    let team = reading(json!({ "account": "org-cego:acct", "accountLabel": "mk@cego.dk" }));
    let seat = chatgpt(json!({ "accountLabel": "mk@cego.dk", "plan": "team" }));
    let shown = page(
        vec![
            machine(
                "mk-laptop",
                vec![
                    team.clone(),
                    merged(
                        seat.clone(),
                        json!({ "windows": [window(json!({ "usedPercent": 2 }))],
                            "at": "2026-10-08T07:59:00Z" }),
                    ),
                ],
            ),
            machine(
                "vm-mk",
                vec![
                    merged(
                        team,
                        json!({ "windows": [window(json!({ "usedPercent": 72 }))],
                            "at": "2026-10-08T07:59:00Z" }),
                    ),
                    seat,
                ],
            ),
        ],
        &LAPTOP,
    );
    assert!(shown.not_read.is_empty());
    type Shown<'a> = (
        &'a str,
        Vec<u32>,
        Option<&'a str>,
        Vec<(&'a str, Option<&'a str>)>,
    );
    let sections: Vec<Shown> = shown
        .sections
        .iter()
        .map(|s| {
            (
                s.title.as_str(),
                s.windows.iter().map(|w| w.percent).collect(),
                s.said.as_deref(),
                s.machines
                    .iter()
                    .map(|(n, p)| (n.as_str(), p.as_deref()))
                    .collect(),
            )
        })
        .collect();
    let both = vec![("mk-laptop", None), ("vm-mk", None)];
    assert_eq!(
        sections,
        [
            (
                "Claude · max · mk@cego.dk",
                vec![72],
                Some("as of 1 minute ago · read on vm-mk · Claude's usage endpoint"),
                both.clone()
            ),
            (
                "ChatGPT · team · mk@cego.dk",
                vec![2],
                Some("as of 1 minute ago · read on mk-laptop · Codex's app server"),
                both
            ),
        ]
    );
    assert_eq!(
        shown.sections[0].windows[0].reset.as_deref(),
        Some("resets 10:10 (in 2h 10m)")
    );
}

#[test]
fn an_expired_login_on_one_machine_is_said_beside_it_while_the_others_windows_are_shown() {
    let shown = page(
        vec![
            machine(
                "mk-laptop",
                vec![reading(
                    json!({ "windows": [], "problem": EXPIRED, "at": "2026-10-08T07:59:00Z" }),
                )],
            ),
            machine("vm-mk", vec![reading(json!({}))]),
        ],
        &LAPTOP,
    );
    assert_eq!(shown.sections.len(), 1);
    let section = &shown.sections[0];
    assert_eq!(
        section
            .windows
            .iter()
            .map(|w| w.percent)
            .collect::<Vec<_>>(),
        [31]
    );
    assert!(section.said.as_deref().unwrap().contains("read on vm-mk"));
    assert_eq!(
        section.machines,
        [
            ("mk-laptop".to_string(), Some(EXPIRED.to_string())),
            ("vm-mk".to_string(), None)
        ]
    );
}

#[test]
fn an_account_read_only_with_problems_is_a_section_with_its_title_and_no_windows() {
    let refused = "Claude's usage endpoint refused";
    let shown = page(
        vec![
            machine(
                "mk-laptop",
                vec![reading(json!({ "windows": [], "problem": EXPIRED }))],
            ),
            machine(
                "vm-mk",
                vec![reading(json!({ "windows": [], "problem": refused }))],
            ),
        ],
        &LAPTOP,
    );
    assert_eq!(
        shown.sections,
        [Section {
            key: "claude:org:acct".into(),
            title: "Claude · max · me@example.com".into(),
            windows: vec![],
            said: None,
            machines: vec![
                ("mk-laptop".into(), Some(EXPIRED.into())),
                ("vm-mk".into(), Some(refused.into())),
            ],
        }]
    );
}

#[test]
fn a_reading_with_no_account_and_no_numbers_and_a_machine_whose_host_gave_none_are_not_read() {
    let mut laptop = machine("mk-laptop", vec![]);
    laptop["problem"] = json!("can't say; upgrade this Machine");
    let shown = page(
        vec![
            laptop,
            machine(
                "vm-mk",
                vec![chatgpt(
                    json!({ "account": null, "accountLabel": null, "windows": [],
                    "problem": "Codex is not logged in on this Machine; run `codex login`" }),
                )],
            ),
        ],
        &LAPTOP,
    );
    assert!(shown.sections.is_empty());
    let said: Vec<&str> = shown.not_read.iter().map(|(_, s)| s.as_str()).collect();
    assert_eq!(
        said,
        [
            "mk-laptop: can't say; upgrade this Machine",
            "vm-mk · ChatGPT: Codex is not logged in on this Machine; run `codex login`",
        ]
    );
}

#[test]
fn a_window_past_its_reset_is_unused_and_a_full_one_is_out() {
    let shown = page(
        vec![machine(
            "mk-laptop",
            vec![reading(json!({ "windows": [
                window(json!({ "usedPercent": 100, "reached": true, "resetsAt": "2026-10-08T07:00:00Z" })),
                window(json!({ "kind": "weekly", "label": "Weekly", "usedPercent": 100, "resetsAt": null })),
                window(json!({ "kind": "weekly", "label": "Weekly", "usedPercent": 95, "resetsAt": null })),
            ] }))],
        )],
        &LAPTOP,
    );
    let windows: Vec<(u32, Level)> = shown.sections[0]
        .windows
        .iter()
        .map(|w| (w.percent, w.level))
        .collect();
    assert_eq!(
        windows,
        [(0, Level::Ok), (100, Level::Out), (95, Level::Warn)]
    );
}

#[test]
fn a_machine_that_is_not_live_is_nowhere_on_the_page() {
    let mut old = machine("old", vec![]);
    old["problem"] = json!("can't say; upgrade this Machine");
    let shown = page(
        vec![
            machine("mk-laptop", vec![reading(json!({}))]),
            machine(
                "gone",
                vec![reading(json!({ "windows": [], "problem": EXPIRED }))],
            ),
            old,
            machine(
                "off",
                vec![chatgpt(
                    json!({ "account": null, "windows": [], "problem": "not logged in" }),
                )],
            ),
        ],
        &["mk-laptop"],
    );
    let on: Vec<&Vec<(String, Option<String>)>> =
        shown.sections.iter().map(|s| &s.machines).collect();
    assert_eq!(on, [&vec![("mk-laptop".to_string(), None)]]);
    assert!(shown.not_read.is_empty());
}

#[test]
fn opening_the_page_asks_each_machine_and_draws_a_meter_per_window_of_the_live_ones() {
    let harness = Harness::<App>::new();
    let mut app = flock_app(&harness);
    app.open_page(Page::Usage);
    let mut runtime = runtime(app);
    assert_eq!(harness.fake.asked_of("usage").len(), 1);
    assert!(said(&runtime, "Asking each Machine…"));
    let answer = json!([
        machine("vm", vec![reading(json!({ "windows": [window(json!({ "usedPercent": 72,
            "resetsAt": "2099-01-01T00:00:00Z" }))] }))]),
        { "profile": "local", "name": "mk-pc", "readings": [], "problem": "can't say; upgrade this Machine" },
    ]);
    harness.fake.answer("usage", Ok(answer));
    settle(&harness, &mut runtime);
    runtime.frame(100.0);
    let tree = runtime.elements();
    let section = tree
        .iter()
        .find(|e| e.key.as_deref() == Some("usage-claude:org:acct"))
        .expect("the account's section");
    assert_eq!(
        section.label.as_deref(),
        Some("Claude · max · me@example.com")
    );
    let meter = tree
        .iter()
        .find(|e| e.key.as_deref() == Some("window-0:Session"))
        .expect("its window's meter");
    assert_eq!(
        (meter.role, meter.label.as_deref()),
        ("progressbar", Some("Session: 72%"))
    );
    assert!(said(&runtime, "mk-pc: can't say; upgrade this Machine"));
}

#[test]
fn the_page_reads_usage_again_on_its_own_while_desktop_runs() {
    let harness = Harness::<App>::new();
    let mut app = flock_app(&harness);
    app.pages.usage.every = std::time::Duration::from_millis(250);
    let fresh = |percent: u32| {
        json!([machine("vm", vec![reading(json!({ "windows": [window(json!({
            "usedPercent": percent, "resetsAt": "2099-01-01T00:00:00Z" }))] }))])])
    };
    harness.fake.will_answer("usage", Ok(fresh(10)));
    app.open_page(Page::Usage);
    let mut runtime = runtime(app);
    settle(&harness, &mut runtime);
    runtime.frame(100.0);
    assert!(said(&runtime, "Session: 10%"));
    for _ in 0..8 {
        harness.fake.will_answer("usage", Ok(fresh(64)));
    }
    std::thread::sleep(std::time::Duration::from_millis(700));
    settle(&harness, &mut runtime);
    runtime.frame(200.0);
    assert!(
        harness.fake.asked_of("usage").len() >= 2,
        "it asked again without being told to"
    );
    assert!(said(&runtime, "Session: 64%"), "and shows the fresh reading");
}
