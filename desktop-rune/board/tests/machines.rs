//! The Machines page: its fold of `flock`, In sync, each Machine's own settings, Clean up, and
//! what its buttons ask of the core, through the fake core and the accessibility tree.

mod support;

use collie_desktop_board::App;
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::pages::cleanup::{Read, Sweep, choose, cleanup_view, swept_said};
use collie_desktop_board::pages::clock::Zone;
use collie_desktop_board::pages::flock::{Fold, Held, MachineRow, RowState, own_rows, route_said};
use collie_desktop_board::pages::in_sync::{
    DesktopHolds, Part, Verdict, build_of, flock_in_sync, in_sync, syncable,
};
use collie_desktop_board::shell::Page;
use collie_desktop_protocol::generated::{
    CleanupSuccessReport, FlockItem, LostState, Route, Run, Transport,
};
use rune::Runtime;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use support::{path_of, runtime, said, settle, tap};

fn item(value: Value) -> FlockItem {
    serde_json::from_value(value).unwrap()
}

fn routed(profile: &str, name: &str, target: Option<&str>) -> FlockItem {
    let mut machine = json!({ "profile": profile, "name": name });
    if let Some(target) = target {
        machine["target"] = json!(target);
    }
    item(json!({ "_tag": "Routed", "machine": machine }))
}

fn snapshot(installation: &str, profile: &str, name: &str, build: &str) -> FlockItem {
    item(json!({
        "machine": { "installation": installation, "profile": profile, "name": name },
        "message": { "_tag": "Snapshot", "installation": installation, "build": build,
            "protocol": 5, "herds": [], "tasks": [], "seq": 0 },
    }))
}

fn run(steps: Value, ready: Option<bool>, at: f64) -> Value {
    json!({ "steps": steps, "asked": null, "ready": ready, "reason": null, "at": at })
}

fn fold(items: Vec<FlockItem>) -> Fold {
    let mut fold = Fold::default();
    for one in &items {
        fold.apply(one);
    }
    fold
}

const VM: (&str, &str, Option<&str>) = ("p-vm", "vm", Some("mk@vm"));

#[test]
fn a_removed_machine_leaves_its_routes_and_what_onboarding_left_of_it() {
    let machine = json!({ "profile": "p-vm", "name": "vm", "target": "mk@vm" });
    let steps = json!([{ "step": "system", "title": "System", "status": "needs_root", "command": "sudo x" }]);
    let before = fold(vec![
        routed("local", "pc", None),
        routed(VM.0, VM.1, VM.2),
        snapshot("vm-1", "p-vm", "vm", "0.31.0"),
        item(
            json!({ "_tag": "Onboarding", "job": "j-1", "machine": machine, "run": run(steps, Some(false), 1.0) }),
        ),
    ]);
    let rows = before.rows();
    assert_eq!(
        rows[0],
        MachineRow::bare("local", "pc", RowState::Connecting)
    );
    assert_eq!(rows[1].state, RowState::Live);
    assert_eq!(rows[1].target.as_deref(), Some("mk@vm"));
    assert_eq!(rows[1].build.as_deref(), Some("0.31.0"));
    assert_eq!(rows[1].onboarded.as_ref().unwrap().steps[0].step, "system");
    let mut after = before;
    after.apply(&item(json!({ "_tag": "Removed", "machine": machine })));
    assert!(after.seen.is_empty());
    let left: Vec<String> = after.rows().into_iter().map(|r| r.profile).collect();
    assert_eq!(left, ["local"]);
    assert!(after.onboarded.is_empty());
}

#[test]
fn a_rows_onboarding_is_what_doctor_finds_over_what_onboarding_said_unless_it_skipped_a_step() {
    let machine = json!({ "profile": "p-vm", "name": "vm", "target": "mk@vm" });
    let doctored = run(
        json!([{ "step": "helle", "title": "Helle", "status": "needs_human" }]),
        Some(false),
        2.0,
    );
    let row = |onboarding: Value| {
        fold(vec![
            routed(VM.0, VM.1, VM.2),
            item(json!({ "_tag": "Onboarding", "job": "j-1", "machine": machine, "run": onboarding })),
            item(json!({ "_tag": "Doctored", "machine": machine, "run": doctored })),
        ])
        .rows()[0]
            .onboarded
            .clone()
            .unwrap()
    };
    let needs = run(
        json!([{ "step": "helle", "title": "Helle's credentials", "status": "needs_human" }]),
        Some(false),
        0.0,
    );
    assert_eq!(row(needs).ready, Some(false));
    let skipped = run(
        json!([{ "step": "helle", "title": "Helle's credentials", "status": "skipped" }]),
        Some(true),
        0.0,
    );
    assert_eq!(row(skipped).ready, Some(true));
    let linear = run(
        json!([{ "step": "linear", "title": "The Linear MCP", "status": "failed" }]),
        Some(false),
        0.0,
    );
    let kept: Vec<String> = row(linear).steps.into_iter().map(|s| s.step).collect();
    assert_eq!(
        kept,
        ["helle", "linear"],
        "an unsettled Linear step doctor can't see stays"
    );
    let newer = run(json!([]), Some(true), 5.0);
    assert_eq!(
        row(newer).ready,
        Some(true),
        "an onboarding newer than doctor stands"
    );
}

#[test]
fn a_rows_paired_link_says_which_way_it_goes_and_why_not_direct() {
    let link = |fields: Value| {
        let mut link = json!({ "installation": "vm-1", "name": "vm", "dials": "out", "url": null,
            "state": "live", "since": null, "failure": null });
        for (key, value) in fields.as_object().unwrap() {
            link[key] = value.clone();
        }
        item(
            json!({ "_tag": "Linked", "machine": { "profile": "p-vm", "name": "vm" }, "link": link }),
        )
    };
    let row_with = |extra: Option<FlockItem>| {
        let mut items = vec![
            routed(VM.0, VM.1, VM.2),
            snapshot("vm-1", "p-vm", "vm", "0.35.0"),
        ];
        items.extend(extra);
        fold(items).rows().remove(0)
    };
    let refused = "wss://vm-mk:4100 refused the connection";
    let over_ssh = row_with(Some(link(json!({ "transport": "ssh", "direct": refused }))));
    assert_eq!(over_ssh.transport, Some(Transport::Ssh));
    assert_eq!(over_ssh.transport_reason.as_deref(), Some(refused));
    let away = row_with(Some(link(
        json!({ "state": "away", "transport": "ssh", "direct": refused }),
    )));
    assert_eq!((away.transport, away.transport_reason), (None, None));
    let waits = row_with(Some(link(
        json!({ "state": "away", "waits": "ssh_connection" }),
    )));
    assert_eq!(
        waits.reason.as_deref(),
        Some("Its link waits on an SSH connection, which Desktop opens when it next connects.")
    );
    assert_eq!(
        route_said(&Route::Link, Some(&Transport::Ssh)),
        "Paired link · over SSH"
    );
    assert_eq!(
        route_said(&Route::Link, Some(&Transport::Direct)),
        "Paired link · direct"
    );
    assert_eq!(route_said(&Route::Link, None), "Paired link");
    assert_eq!(route_said(&Route::Ssh, None), "SSH");
}

#[test]
fn a_lost_route_says_why_until_its_machine_reports_again() {
    let lost = item(
        json!({ "_tag": "Lost", "machine": { "profile": "p-vm", "name": "vm" },
        "state": "unreachable", "reason": "ssh: connection refused", "at": 5 }),
    );
    let mut flock = fold(vec![
        routed(VM.0, VM.1, VM.2),
        snapshot("vm-1", "p-vm", "vm", "0.35.0"),
        lost,
    ]);
    let row = flock.rows().remove(0);
    assert_eq!(row.state, RowState::NotLive(LostState::Unreachable));
    assert_eq!(row.reason.as_deref(), Some("ssh: connection refused"));
    assert_eq!(
        row.build.as_deref(),
        Some("0.35.0"),
        "a dropped Machine keeps its build"
    );
    flock.apply(&snapshot("vm-1", "p-vm", "vm", "0.35.0"));
    let row = flock.rows().remove(0);
    assert_eq!((row.state, row.reason), (RowState::Live, None));
}

fn row(over: impl FnOnce(&mut MachineRow)) -> MachineRow {
    let mut row = MachineRow::bare("p-vm", "vm-mk", RowState::Live);
    row.target = Some("mk@vm-mk".into());
    row.build = Some("0.35.0".into());
    over(&mut row);
    row
}

fn doctored(ready: bool) -> Run {
    serde_json::from_value(run(
        if ready {
            json!([])
        } else {
            json!([{ "step": "helle", "title": "Helle", "status": "failed", "command": "collie onboard" }])
        },
        Some(ready),
        1.0,
    ))
    .unwrap()
}

fn desktop() -> DesktopHolds {
    DesktopHolds {
        version: "0.35.0".into(),
        credentials: vec!["gitlab", "helle"],
    }
}

#[test]
fn a_machine_is_in_sync_on_desktops_release_and_behind_on_an_older_one_saying_both() {
    let onboarded = row(|r| r.onboarded = Some(doctored(true)));
    assert_eq!(in_sync(&onboarded, &desktop()).state, Verdict::InSync);
    let older = in_sync(&row(|r| r.build = Some("0.34.0".into())), &desktop());
    assert_eq!(older.state, Verdict::Behind);
    assert_eq!(
        older.behind[0].said,
        "Runs Collie 0.34.0; Desktop is 0.35.0"
    );
    let ten = DesktopHolds {
        version: "0.10.0".into(),
        ..desktop()
    };
    assert_eq!(
        in_sync(&row(|r| r.build = Some("0.9.0".into())), &ten).state,
        Verdict::Behind
    );
    assert_eq!(
        in_sync(&row(|r| r.build = Some("0.36.0".into())), &desktop()).state,
        Verdict::InSync
    );
}

#[test]
fn a_development_checkout_or_a_desktop_that_isnt_a_release_is_never_behind_on_its_version() {
    let checkout = row(|r| {
        r.build = Some("0.34.0+abc1234".into());
        r.development = Some("0.34.0+abc1234".into());
    });
    assert_eq!(in_sync(&checkout, &desktop()).state, Verdict::InSync);
    let unreleased = DesktopHolds {
        version: "0.35.0+def5678".into(),
        ..desktop()
    };
    assert_eq!(
        in_sync(&row(|r| r.build = Some("0.34.0".into())), &unreleased).state,
        Verdict::InSync
    );
}

#[test]
fn a_machine_doctor_doesnt_find_onboarded_is_behind_on_onboarding_with_its_steps() {
    let verdict = in_sync(&row(|r| r.onboarded = Some(doctored(false))), &desktop());
    assert_eq!(verdict.state, Verdict::Behind);
    assert_eq!(verdict.behind[0].part, Part::Onboarding);
    assert_eq!(verdict.behind[0].said, "Not onboarded: Helle");
    assert_eq!(verdict.behind[0].steps, doctored(false).steps);
    assert!(!syncable(&verdict), "onboarding has its own steps");
}

#[test]
fn a_machine_not_live_is_its_state_and_one_connecting_has_no_verdict() {
    let lost = row(|r| r.state = RowState::NotLive(LostState::Sso));
    assert_eq!(
        in_sync(&lost, &desktop()).state,
        Verdict::NotLive(LostState::Sso)
    );
    let connecting = row(|r| r.state = RowState::Connecting);
    assert_eq!(in_sync(&connecting, &desktop()).state, Verdict::Connecting);
}

#[test]
fn settings_definitions_and_credentials_that_did_not_sync_are_behind_and_offer_sync_now() {
    let settings = in_sync(
        &row(|r| r.settings = Some(Some("host refused".into()))),
        &desktop(),
    );
    assert_eq!(
        settings.behind[0].said,
        "Settings didn't sync: host refused"
    );
    assert!(syncable(&settings));
    assert_eq!(
        in_sync(&row(|r| r.settings = Some(None)), &desktop()).state,
        Verdict::InSync
    );
    let by_hand = in_sync(
        &row(|r| {
            r.development = Some("0.35.0+abc1234".into());
            r.definitions = Some(Some("can't say; upgrade this Machine".into()));
        }),
        &desktop(),
    );
    assert_eq!(
        by_hand.behind[0].said,
        "Definitions didn't sync: can't say; upgrade this Machine (a development checkout, updated by hand)"
    );
    let lacking = in_sync(
        &row(|r| {
            r.credentials.insert(
                "gitlab",
                Held {
                    given: false,
                    failed: Some("glab: not found".into()),
                },
            );
            r.credentials.insert(
                "helle",
                Held {
                    given: false,
                    failed: None,
                },
            );
        }),
        &desktop(),
    );
    let said: Vec<&str> = lacking.behind.iter().map(|l| l.said.as_str()).collect();
    assert_eq!(
        said,
        [
            "Lacks the GitLab token: glab: not found",
            "Lacks Helle's token"
        ]
    );
}

#[test]
fn the_flocks_summary_names_desktops_version_or_each_machine_that_lags_and_how() {
    let level = flock_in_sync(
        &[
            row(|r| r.name = "mk-pc".into()),
            row(|r| r.state = RowState::Connecting),
        ],
        &desktop(),
    );
    assert_eq!(
        level,
        (
            "Every Machine is in sync with Desktop 0.35.0".to_string(),
            0
        )
    );
    let mixed = flock_in_sync(
        &[
            row(|r| r.name = "mk-pc".into()),
            row(|r| {
                r.build = Some("0.34.0".into());
                r.onboarded = Some(doctored(false));
            }),
            row(|r| {
                r.name = "vm-c".into();
                r.state = RowState::NotLive(LostState::Unreachable);
            }),
        ],
        &desktop(),
    );
    assert_eq!(
        mixed,
        (
            "Not in sync with Desktop 0.35.0: vm-mk: behind on version and onboarding; vm-c: Out of reach"
                .to_string(),
            2
        )
    );
    let without = DesktopHolds {
        credentials: vec![],
        ..desktop()
    };
    assert_eq!(
        flock_in_sync(&[], &without).0,
        "Every Machine is in sync with Desktop 0.35.0. Desktop has no GitLab token to give. Desktop has no Helle token to give"
    );
}

#[test]
fn a_row_says_the_collie_it_runs_a_development_builds_own_or_that_it_isnt_known_yet() {
    assert_eq!(build_of(&row(|_| {})), "Collie 0.35.0");
    assert_eq!(
        build_of(&row(|r| r.development = Some("0.35.0+abc1234".into()))),
        "development build 0.35.0+abc1234"
    );
    assert_eq!(build_of(&row(|r| r.build = None)), "Build not known yet");
}

fn own_read(values: Value, at: f64, problem: Option<&str>, unsupported: bool) -> FlockItem {
    item(
        json!({ "_tag": "OwnRead", "machine": { "profile": "p-vm", "name": "vm" },
        "reading": { "values": values, "at": at, "problem": problem, "unsupported": unsupported } }),
    )
}

#[test]
fn a_machine_out_of_reach_keeps_its_own_settings_and_says_when_they_were_read() {
    let at = 1_793_273_400_000.0; // 2026-10-29T11:30:00Z
    let values = json!({ "projectsRoot": "/work", "chatHarness": "pi", "harnesses": ["codex"],
        "remembered": [{ "key": "linear.team", "value": "TOOLS" }] });
    let mut flock = fold(vec![
        routed(VM.0, VM.1, VM.2),
        own_read(values, at, None, false),
        item(
            json!({ "_tag": "Lost", "machine": { "profile": "p-vm", "name": "vm" },
            "state": "unreachable", "reason": "connection closed", "at": at + 1.0 }),
        ),
    ]);
    let own =
        |flock: &Fold| own_rows(&flock.rows(), &flock.own, at + 60_000.0, &Zone::utc()).remove(0);
    let read = own(&flock);
    assert_eq!(read.projects_root.as_deref(), Some("/work"));
    assert_eq!(read.chat_harness.as_deref(), Some("pi"));
    assert_eq!(
        read.remembered,
        [("linear.team".to_string(), "TOOLS".to_string())]
    );
    assert_eq!((read.sync, read.sync_ok), ("Out of reach", false));
    assert_eq!(read.detail.as_deref(), Some("Last read 11:30"));
    flock.apply(&own_read(
        Value::Null,
        at + 50_000.0,
        Some("socket closed"),
        false,
    ));
    let kept = own(&flock);
    assert_eq!(
        (kept.projects_root.as_deref(), kept.at),
        (Some("/work"), Some(at))
    );
    assert_eq!(
        kept.detail.as_deref(),
        Some("Last read 11:30 · socket closed")
    );
}

#[test]
fn an_older_host_is_not_known_and_a_live_ones_unset_values_are_not_set() {
    let flock = fold(vec![
        routed(VM.0, VM.1, VM.2),
        own_read(Value::Null, 0.0, None, true),
    ]);
    let mut rows = flock.rows();
    rows[0].state = RowState::Live;
    rows[0].build = Some("0.105.0".into());
    let old = own_rows(&rows, &flock.own, 0.0, &Zone::utc()).remove(0);
    assert_eq!(
        old.detail.as_deref(),
        Some("Not known: vm runs Collie 0.105.0")
    );
    assert_eq!(old.projects_root, None);
    let mut unset = fold(vec![
        routed(VM.0, VM.1, VM.2),
        own_read(
            json!({ "harnesses": [], "remembered": [] }),
            0.0,
            None,
            false,
        ),
    ]);
    unset.apply(&item(json!({ "_tag": "Synced", "part": "settings",
        "machine": { "profile": "p-vm", "name": "vm" }, "failed": "permission denied" })));
    let mut rows = unset.rows();
    rows[0].state = RowState::Live;
    let read = own_rows(&rows, &unset.own, 0.0, &Zone::utc()).remove(0);
    assert_eq!(read.projects_root.as_deref(), Some("Not set"));
    assert_eq!((read.sync, read.sync_ok), ("Behind", false));
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

fn report(items: &[(&str, &str, f64)]) -> CleanupSuccessReport {
    serde_json::from_value(json!({
        "remove": items.iter().map(|(kind, target, bytes)| json!({
            "kind": kind, "target": target, "bytes": bytes, "reason": format!("{target} is done") })).collect::<Vec<_>>(),
        "keep": [],
        "bytes": items.iter().map(|i| i.2).sum::<f64>(),
    }))
    .unwrap()
}

fn live(name: &str) -> MachineRow {
    MachineRow::bare(&format!("p-{name}"), name, RowState::Live)
}

fn listed(name: &str, report: CleanupSuccessReport) -> (String, Read) {
    (
        format!("p-{name}"),
        Read::Listed {
            installation: format!("i-{name}"),
            report,
        },
    )
}

#[test]
fn a_machines_removals_are_grouped_by_kind_largest_first_each_with_its_count_and_size() {
    let reads = HashMap::from([listed(
        "vm",
        report(&[
            ("generation", "/g/1", 1024.0),
            ("worktree", "/w/a", GIB),
            ("generation", "/g/2", 3072.0),
            ("worktree", "/w/b", 2.0 * GIB),
            ("staged-blob", "/s/x", 5.0),
        ]),
    )]);
    let view = cleanup_view(&[live("vm")], &reads, None, &HashMap::new(), 0.0);
    let row = &view.rows[0];
    assert_eq!(row.said, "Would free 3.0 GiB");
    let groups: Vec<(&str, usize, &str)> = row
        .groups
        .iter()
        .map(|g| (g.kind.as_str(), g.count, g.size.as_str()))
        .collect();
    assert_eq!(
        groups,
        [
            ("worktree", 2, "3.0 GiB"),
            ("generation", 2, "4.0 KiB"),
            ("staged-blob", 1, "5 B")
        ]
    );
    let first: Vec<&str> = row.groups[0]
        .items
        .iter()
        .map(|i| i.target.as_str())
        .collect();
    assert_eq!(first, ["/w/b", "/w/a"]);
}

#[test]
fn a_machine_desktop_doesnt_reach_says_its_state_and_reason_and_cant_be_chosen() {
    let states = [
        (RowState::Connecting, "Connecting: why", None),
        (
            RowState::NotLive(LostState::Unreachable),
            "Out of reach: why",
            Some("Its host still cleans up there every ten minutes."),
        ),
        (
            RowState::NotLive(LostState::NoCollie),
            "Collie isn't installed: why",
            None,
        ),
    ];
    let rows: Vec<MachineRow> = states
        .iter()
        .enumerate()
        .map(|(i, (state, _, _))| {
            let mut r = MachineRow::bare(&format!("p-{i}"), &format!("m{i}"), state.clone());
            r.reason = Some("why".into());
            r
        })
        .collect();
    let view = cleanup_view(&rows, &HashMap::new(), None, &HashMap::new(), 0.0);
    for (row, (_, said, note)) in view.rows.iter().zip(states) {
        assert_eq!(
            (row.said.as_str(), row.note.as_deref(), row.choosable),
            (said, note, false)
        );
    }
    assert_eq!(view.chosen, "0 Machines chosen · would free 0 B");
}

#[test]
fn a_live_machine_being_read_waits_unchosen_and_one_never_asked_offers_read_again() {
    let reads = HashMap::from([
        ("p-slow".to_string(), Read::Reading { since: 1_000.0 }),
        listed("vm", report(&[])),
        (
            "p-old".to_string(),
            Read::Failed {
                problem: "the disk is gone".into(),
            },
        ),
    ]);
    let rows = [live("slow"), live("vm"), live("old"), live("late")];
    let view = cleanup_view(&rows, &reads, None, &HashMap::new(), 24_500.0);
    let seen: Vec<(&str, bool, bool, bool)> = view
        .rows
        .iter()
        .map(|r| (r.said.as_str(), r.choosable, r.chosen, r.read_again))
        .collect();
    assert_eq!(
        seen,
        [
            ("Reading… 23 s", false, false, false),
            ("Nothing to remove now", true, true, false),
            ("the disk is gone", false, false, true),
            ("It wasn't connected when Cleanup read.", false, false, true),
        ]
    );
}

#[test]
fn every_machine_that_can_be_chosen_starts_chosen_and_all_and_none_act_on_those() {
    let rows = [live("a"), live("b"), live("off")];
    let reads = HashMap::from([
        listed("a", report(&[("worktree", "/w", GIB)])),
        listed("b", report(&[("worktree", "/v", 0.1 * GIB)])),
    ]);
    let start = cleanup_view(&rows, &reads, None, &HashMap::new(), 0.0);
    assert_eq!(start.chosen, "2 Machines chosen · would free 1.1 GiB");
    assert_eq!(start.button, "Clean up 2 Machines");
    let none = choose(&start, false);
    let view = cleanup_view(&rows, &reads, Some(&none), &HashMap::new(), 0.0);
    assert_eq!(
        (view.chosen.as_str(), view.disabled),
        ("0 Machines chosen · would free 0 B", true)
    );
    let all = choose(&view, true);
    assert_eq!(all, HashSet::from(["p-a".to_string(), "p-b".to_string()]));
    let one = HashSet::from(["p-b".to_string()]);
    let view = cleanup_view(&rows, &reads, Some(&one), &HashMap::new(), 0.0);
    assert_eq!(
        (view.chosen.as_str(), view.button.as_str()),
        (
            "1 Machine chosen · would free 102.4 MiB",
            "Clean up 1 Machine"
        )
    );
}

#[test]
fn a_sweep_fixes_the_choice_and_says_cleaning_then_what_it_freed_or_why_not() {
    let rows = [live("a"), live("b"), live("c")];
    let reads = HashMap::from([
        listed("a", report(&[("worktree", "/w", 3.0 * GIB)])),
        listed("b", report(&[("worktree", "/v", GIB)])),
        listed("c", report(&[("generation", "/g", 1024.0)])),
    ]);
    let sweeps = HashMap::from([
        (
            "p-a".to_string(),
            Sweep::Running {
                request: "s-a".into(),
            },
        ),
        (
            "p-b".to_string(),
            Sweep::Failed {
                request: "s-b".into(),
                reason: "the disk is gone".into(),
            },
        ),
    ]);
    let view = cleanup_view(&rows, &reads, None, &sweeps, 0.0);
    let seen: Vec<(&str, bool, bool, bool)> = view
        .rows
        .iter()
        .map(|r| (r.said.as_str(), r.chosen, r.choosable, r.try_again))
        .collect();
    assert_eq!(
        seen,
        [
            ("Cleaning…", true, false, false),
            ("Not cleaned", true, false, true),
            ("Would free 1.0 KiB", false, false, false),
        ]
    );
    assert!(view.disabled && view.choosable.is_empty());
    let mut away = live("a");
    away.state = RowState::NotLive(LostState::Unreachable);
    let waiting = cleanup_view(&[away], &reads, None, &sweeps, 0.0);
    assert_eq!(waiting.rows[0].said, "Cleaning… waiting for a to reconnect");
    let done = Sweep::Done {
        report: report(&[("worktree", "/w/a", 3.2 * GIB)]),
    };
    assert_eq!(
        swept_said("vm-mk", &done),
        ("Cleaned up vm-mk: freed 3.2 GiB".to_string(), true)
    );
    let failed = Sweep::Failed {
        request: "s".into(),
        reason: "the disk is gone".into(),
    };
    assert_eq!(
        swept_said("vm-mk", &failed),
        ("vm-mk not cleaned: the disk is gone".to_string(), false)
    );
}

// The page itself, through the fake core.

fn machines_page(harness: &Harness<App>) -> Runtime<App> {
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    for one in [
        routed("local", "mk-pc", None),
        routed(VM.0, VM.1, VM.2),
        snapshot("i-pc", "local", "mk-pc", "0.35.0"),
        snapshot("i-vm", "p-vm", "vm", "0.34.0"),
    ] {
        app.apply(one.clone());
        app.pages.machines.heard(&one);
    }
    app.open_page(Page::Machines);
    harness.fake.push(
        "updates",
        Ok(json!({ "version": "0.35.0", "news": { "_tag": "Checking" } })),
    );
    harness.fake.push(
        "credentials",
        Ok(json!({ "gitlab": { "expires": null }, "helle": true,
        "host": "gitlab.example.com", "tokenPage": "https://gitlab.example.com/new" })),
    );
    let mut runtime = runtime(app);
    settle(harness, &mut runtime);
    runtime.frame(200.0);
    runtime
}

#[test]
fn the_page_hears_desktops_version_and_says_which_machine_lags_and_how() {
    let harness = Harness::<App>::new();
    let runtime = machines_page(&harness);
    assert_eq!(harness.fake.asked_of("updates").len(), 1);
    assert_eq!(harness.fake.asked_of("credentials").len(), 1);
    assert!(said(
        &runtime,
        "Not in sync with Desktop 0.35.0: vm: behind on version"
    ));
    assert!(said(&runtime, "Runs Collie 0.34.0; Desktop is 0.35.0"));
    let tree = runtime.elements();
    let vm = tree
        .iter()
        .find(|e| e.key.as_deref() == Some("machine-p-vm"))
        .unwrap();
    assert_eq!(vm.label.as_deref(), Some("vm: Behind"));
    let pc = tree
        .iter()
        .find(|e| e.key.as_deref() == Some("machine-local"))
        .unwrap();
    assert_eq!(pc.label.as_deref(), Some("mk-pc: In sync"));
}

#[test]
fn sync_now_remove_and_onboard_ask_the_core_for_that_machine_and_say_what_came_of_it() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    let mut at = 400.0;
    tap(&mut runtime, "machine-p-vm/sync-now", &mut at);
    assert_eq!(
        harness.fake.asked_of("syncNow"),
        [json!({ "profile": "p-vm" })]
    );
    harness.fake.answer(
        "syncNow",
        Ok(json!({ "said": "Upgraded vm to 0.35.0", "failed": false })),
    );
    tap(&mut runtime, "machine-p-vm/remove", &mut at);
    assert_eq!(
        harness.fake.asked_of("removeMachine"),
        [json!({ "profile": "p-vm" })]
    );
    harness.fake.answer(
        "removeMachine",
        Err(CallError("herdr refused: busy".into())),
    );
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert_eq!(
        runtime.state.pages.machines.told.texts(),
        ["Upgraded vm to 0.35.0", "herdr refused: busy"]
    );
    assert!(
        said(&runtime, "herdr refused: busy"),
        "what came of it is shown"
    );
    assert!(
        path_of(&runtime, "machine-local/remove").is_none(),
        "this computer is never removed"
    );
    tap(&mut runtime, "machine-local/onboard", &mut at);
    assert_eq!(
        harness.fake.asked_of("onboard"),
        [json!({ "profile": "local" })]
    );
}

#[test]
fn add_machine_sends_what_was_typed_trimmed_then_shows_its_onboarding_and_herdrs_question() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    let mut at = 400.0;
    tap(&mut runtime, "add-machine", &mut at);
    assert!(said(&runtime, "SSH target"));
    let adding = runtime.state.pages.machines.adding.as_mut().unwrap();
    adding.target.replace_text(" mk@vm-new ");
    adding.label.replace_text("vm-new");
    tap(&mut runtime, "add-submit", &mut at);
    assert_eq!(
        harness.fake.asked_of("addMachine"),
        [json!({ "target": "mk@vm-new", "label": "vm-new", "session": "default" })]
    );
    harness.fake.answer("addMachine", Ok(json!("job-1")));
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(&runtime, "Starting…"));
    let machine = json!({ "profile": "p-new", "name": "vm-new", "target": "mk@vm-new" });
    let asking = item(
        json!({ "_tag": "Onboarding", "job": "job-1", "machine": machine, "run": {
        "steps": [{ "step": "herdr", "title": "Saved in herdr", "status": "running" }],
        "asked": { "text": "Trust this host key?", "yes": false }, "ready": null, "reason": null, "at": 1 } }),
    );
    runtime.state.pages.machines.heard(&asking);
    runtime.invalidate();
    runtime.frame(at);
    assert!(said(&runtime, "Onboarding vm-new"));
    assert!(said(&runtime, "Trust this host key?"));
    tap(&mut runtime, "herdr-yes", &mut at);
    assert_eq!(
        harness.fake.asked_of("answerHerdr"),
        [json!({ "job": "job-1", "yes": true })]
    );
    runtime.state.close_onboarding();
    assert_eq!(
        harness.fake.asked_of("answerHerdr")[1],
        json!({ "job": "job-1", "yes": false }),
        "a question nobody can see takes herdr's own default"
    );
}

#[test]
fn an_ended_onboarding_offers_retry_and_skip_on_its_unsettled_steps() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    let machine = json!({ "profile": "p-vm", "name": "vm", "target": "mk@vm" });
    let ended = item(
        json!({ "_tag": "Onboarding", "job": "job-2", "machine": machine, "run": {
        "steps": [{ "step": "helle", "title": "Helle's credentials", "status": "failed", "detail": "no token" }],
        "asked": null, "ready": false, "reason": null, "at": 9 } }),
    );
    runtime.state.pages.machines.heard(&ended);
    runtime.state.pages.machines.job = Some("job-2".into());
    let mut at = 400.0;
    runtime.invalidate();
    runtime.frame(at);
    assert!(said(&runtime, "Not onboarded yet."));
    tap(&mut runtime, "onboarding-steps/step-helle/skip", &mut at);
    assert_eq!(
        harness.fake.asked_of("onboard"),
        [json!({ "profile": "p-vm", "skip": ["helle"] })]
    );
    tap(&mut runtime, "onboarding-steps/step-helle/retry", &mut at);
    assert_eq!(
        harness.fake.asked_of("onboard")[1],
        json!({ "profile": "p-vm" })
    );
}

#[test]
fn clean_up_reads_each_live_machine_and_sweeps_the_chosen_ones_under_a_request() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    let mut at = 400.0;
    tap(&mut runtime, "clean-up", &mut at);
    let asked: Vec<Value> = harness.fake.asked_of("cleanup");
    assert_eq!(
        asked,
        [json!({ "profile": "local" }), json!({ "profile": "p-vm" })]
    );
    harness.fake.answer(
        "cleanup",
        Ok(json!({ "installation": "i-pc", "report": { "remove": [], "keep": [], "bytes": 0 } })),
    );
    harness.fake.answer("cleanup", Ok(json!({ "installation": "i-vm", "report": {
        "remove": [{ "kind": "worktree", "target": "/w/run-1", "bytes": 2048, "reason": "its Run ended" }],
        "keep": [], "bytes": 2048 } })));
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(&runtime, "Would free 2.0 KiB"));
    assert!(said(&runtime, "2 Machines chosen · would free 2.0 KiB"));
    tap(&mut runtime, "cleanup-p-vm/chosen", &mut at);
    assert!(said(&runtime, "1 Machine chosen · would free 0 B"));
    tap(&mut runtime, "cleanup-clean", &mut at);
    let swept = harness.fake.asked_of("sweep");
    assert_eq!(swept.len(), 1);
    assert_eq!(
        (&swept[0]["installation"], &swept[0]["machine"]),
        (&json!("i-pc"), &json!("mk-pc"))
    );
    assert_eq!(swept[0]["request"].as_str().unwrap().len(), 36);
    harness
        .fake
        .answer("sweep", Ok(json!({ "remove": [], "keep": [], "bytes": 0 })));
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(&runtime, "Nothing removed"));
    assert_eq!(
        runtime.state.pages.machines.told.texts(),
        ["Cleaned up mk-pc: freed 0 B"]
    );
}

#[test]
fn a_failed_sweep_is_tried_again_under_its_own_request() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    runtime.state.open_cleanup(0.0);
    for installation in ["i-pc", "i-vm"] {
        harness.fake.answer(
            "cleanup",
            Ok(json!({ "installation": installation,
            "report": { "remove": [], "keep": [], "bytes": 0 } })),
        );
    }
    settle(&harness, &mut runtime);
    runtime.state.cleanup_clean(0.0);
    harness
        .fake
        .answer("sweep", Ok(json!({ "remove": [], "keep": [], "bytes": 0 })));
    harness
        .fake
        .answer("sweep", Err(CallError("the disk is gone".into())));
    settle(&harness, &mut runtime);
    let first = harness.fake.asked_of("sweep")[1]["request"].clone();
    let mut at = 400.0;
    runtime.frame(at);
    assert!(said(&runtime, "the disk is gone"));
    tap(&mut runtime, "cleanup-p-vm/try-again", &mut at);
    let again = harness.fake.asked_of("sweep");
    assert_eq!((again.len(), &again[2]["request"]), (3, &first));
}

#[test]
fn the_header_says_which_machines_it_reaches_and_never_calls_one_connecting_in_sync() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    for one in [
        snapshot("i-vm", "p-vm", "vm", "0.35.0"),
        item(
            json!({ "_tag": "Reconnecting", "machine": { "profile": "p-vm", "name": "vm" }, "at": 5.0 }),
        ),
    ] {
        runtime.state.apply(one);
    }
    settle(&harness, &mut runtime);
    runtime.frame(400.0);
    let reach = runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some("reach"))
        .and_then(|e| e.label)
        .unwrap_or_default();
    assert_eq!(reach, "1 of 2 Machines reached · vm is connecting");
    assert!(
        !said(&runtime, "Every Machine is in sync"),
        "a Machine connecting is not said to be in sync"
    );
    assert!(said(
        &runtime,
        "Every Machine reached is in sync with Desktop 0.35.0"
    ));
    runtime
        .state
        .apply(snapshot("i-vm", "p-vm", "vm", "0.35.0"));
    settle(&harness, &mut runtime);
    runtime.frame(800.0);
    assert!(said(&runtime, "2 of 2 Machines reached"));
    assert!(said(
        &runtime,
        "Every Machine is in sync with Desktop 0.35.0"
    ));
}

#[test]
fn an_onboarding_started_anywhere_shows_over_whichever_page_is_open() {
    let harness = Harness::<App>::new();
    let mut runtime = machines_page(&harness);
    runtime.state.open_page(Page::Settings);
    runtime.state.pages.machines.job = Some("job-9".into());
    settle(&harness, &mut runtime);
    runtime.frame(400.0);
    assert!(
        said(&runtime, "Starting…"),
        "the onboarding shows on Settings"
    );
    runtime.state.open_page(Page::Board);
    settle(&harness, &mut runtime);
    runtime.frame(800.0);
    assert!(said(&runtime, "Starting…"), "and on the Board");
}
