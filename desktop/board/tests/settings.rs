//! The Settings page: its view logic, ported from `desktop/src/shared/flock-settings.ts`,
//! `settings-agents.ts`, `connections.ts` and `slack.ts` with their tests' cases, and the
//! page against a fake core.

use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::pages::settings::agents::{self, AgentSettings, Fallback};
use collie_desktop_board::pages::settings::connections::{self, Primary};
use collie_desktop_board::pages::settings::model::{self, Reached, Tone};
use collie_desktop_board::pages::settings::{registry, time};
use collie_desktop_board::{App, Shown, view};
use collie_desktop_protocol::generated::Machine;
use collie_desktop_protocol::generated::{
    CataloguesSuccessItem, ConnectionReadingsSuccessItem, FlockSettingsSuccess, News,
    SettingsSuccess, SlackUserChannelsSuccessItem,
};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};

fn flock(settings: Value) -> FlockSettingsSuccess {
    serde_json::from_value(json!({ "settings": settings, "synced": [] })).unwrap()
}

fn edit(value: Value, at: &str, from: &str) -> Value {
    json!({ "value": value, "at": at, "from": from, "differed": false })
}

fn desktop() -> SettingsSuccess {
    serde_json::from_value(json!({})).unwrap()
}

fn now() -> f64 {
    time::epoch_ms("2026-11-11T12:00:00.000Z").unwrap()
}

fn rows(flock: &FlockSettingsSuccess) -> Vec<model::Row> {
    model::sections(flock, &desktop(), now(), 0)
        .into_iter()
        .flat_map(|s| s.rows)
        .collect()
}

fn row(flock: &FlockSettingsSuccess, key: &str) -> model::Row {
    rows(flock).into_iter().find(|r| r.key == key).unwrap()
}

#[test]
fn every_setting_shows_under_its_group_with_its_value_and_its_default_in_its_unit() {
    let held = flock(json!({
        "scope": edit(json!("all"), "2026-11-11T09:30:00.000Z", "vm-a"),
        "models.claude": edit(json!(["claude-x"]), "2026-11-11T09:30:00.000Z", "vm-a"),
        "quiet_ms": edit(json!(90000), "2026-10-22T12:31:00.000Z", "mk-laptop"),
    }));
    let sections = model::sections(&held, &desktop(), now(), 0);
    let groups: Vec<&str> = sections.iter().map(|s| s.group).collect();
    assert_eq!(groups, ["Agents", "Runs", "Board", "Chat", "Notifications"]);
    let scope = row(&held, "scope");
    assert_eq!(
        (scope.value.as_str(), scope.fallback.as_str(), scope.set),
        ("all", "local", true)
    );
    assert_eq!(scope.choices, ["local", "all"]);
    assert_eq!(scope.edit.as_deref(), Some("Last edit: vm-a · 09:30"));
    let iterations = row(&held, "max_iterations");
    assert_eq!(
        (
            iterations.value.as_str(),
            iterations.fallback.as_str(),
            iterations.set
        ),
        ("", "5", false)
    );
    assert_eq!(iterations.edit, None);
    let quiet = row(&held, "quiet_ms");
    assert_eq!(
        (quiet.value.as_str(), quiet.fallback.as_str()),
        ("1.5", "10")
    );
    assert_eq!(quiet.default_said, "Default: 10 minutes");
    assert_eq!(
        quiet.edit.as_deref(),
        Some("Last edit: mk-laptop · 22 Oct, 12:31")
    );
    assert_eq!(
        row(&held, "effort").default_said,
        "Unset: the harness decides"
    );
    assert_eq!(
        row(&held, "claude_auto_compact_window").default_said,
        "Default: 400000 tokens"
    );
    assert_eq!(row(&held, "models.claude").value, "claude-x");
    assert_eq!(row(&held, "proactive").default_said, "Default: on");
    assert_eq!(
        row(&held, "release.approval_channel").default_said,
        "Unset: shares nothing"
    );
    let keys: Vec<String> = rows(&held).into_iter().map(|r| r.key).collect();
    for kept_apart in [
        "gitlab_host",
        "terminal_backend",
        "worktrees_directory",
        "zoom",
    ] {
        assert!(
            !keys.contains(&kept_apart.to_string()),
            "{kept_apart} is shown"
        );
    }
}

#[test]
fn record_timing_is_this_computers_and_the_flock_chats_rule_and_switch_are_every_machines() {
    let on: SettingsSuccess = serde_json::from_value(json!({ "recordTiming": true })).unwrap();
    let all: Vec<model::Row> = model::sections(&flock(json!({})), &on, now(), 0)
        .into_iter()
        .flat_map(|s| s.rows)
        .collect();
    let mine: Vec<&model::Row> = all.iter().filter(|r| !r.shared).collect();
    assert_eq!(mine.len(), 1);
    assert_eq!(
        (mine[0].key.as_str(), mine[0].value.as_str(), mine[0].group),
        ("record_timing", "on", "Board")
    );
    assert_eq!(mine[0].edit.as_deref(), Some("Saved on this computer"));
    for key in ["machine_rule", "flock_chat.proactive", "standing_direction"] {
        let r = all.iter().find(|r| r.key == key).unwrap();
        assert!(r.shared && r.group == "Chat", "{key}");
    }
    assert!(
        all.iter()
            .find(|r| r.key == "machine_rule")
            .unwrap()
            .multiline
    );
    assert!(
        all.iter()
            .find(|r| r.key == "agent_profile")
            .unwrap()
            .multiline
    );
}

#[test]
fn a_row_taken_over_a_different_value_at_the_first_sync_says_where_from() {
    let held = flock(json!({
        "trust": { "value": "never", "at": "2026-11-11T09:00:00.000Z", "from": "vm-b", "differed": true },
    }));
    assert_eq!(
        row(&held, "trust").edit.as_deref(),
        Some("Taken from vm-b over a different value at the first sync")
    );
}

fn live(name: &str) -> Reached {
    Reached {
        name: name.into(),
        live: true,
        synced: Some(None),
    }
}

#[test]
fn a_save_says_how_far_it_reached_from_each_machines_latest_sync() {
    let healthy = [
        live("laptop"),
        live("vm-build"),
        live("vm-gpu"),
        live("old-mini"),
    ];
    let mut out_of_reach = healthy.clone();
    out_of_reach[3] = Reached {
        name: "old-mini".into(),
        live: false,
        synced: Some(Some("timed out".into())),
    };
    let reach = model::flock_reach(true, &healthy).unwrap();
    assert_eq!(
        (reach.said.as_str(), reach.tone),
        ("Given to all 4 Machines", Tone::Ok)
    );
    assert_eq!(
        model::sync_pill(true, &healthy).said,
        "In sync with all 4 Machines"
    );
    let reach = model::flock_reach(true, &out_of_reach).unwrap();
    assert_eq!(
        (reach.said.as_str(), reach.tone),
        (
            "Given to 3 of 4 · old-mini gets it when it connects",
            Tone::Warn
        )
    );
    assert_eq!(
        model::sync_pill(true, &out_of_reach).said,
        "In sync with 3 of 4 · old-mini out of reach"
    );
    assert_eq!(
        model::flock_reach(false, &healthy),
        Err("Not set: the Flock's settings could not be read".into())
    );
    assert_eq!(
        model::sync_pill(false, &healthy).said,
        "Showing the Flock's settings as last read"
    );
}

#[test]
fn a_live_machine_with_no_settings_exchange_is_still_waiting_for_the_saved_edit() {
    let waiting = [
        live("laptop"),
        Reached {
            name: "vm".into(),
            live: true,
            synced: None,
        },
    ];
    assert_eq!(
        model::flock_reach(true, &waiting).unwrap().said,
        "Given to 1 of 2 · vm gets it when it connects"
    );
    assert_eq!(
        model::sync_pill(true, &waiting).said,
        "In sync with 1 of 2 · vm behind"
    );
}

#[test]
fn a_value_with_a_consequence_says_it_on_its_row_and_asks_nothing() {
    let held = flock(json!({
        "permissions": edit(json!("bypass"), "2026-11-11T09:00:00.000Z", "Desktop"),
        "compact_at_tokens": edit(json!(0), "2026-11-11T09:00:00.000Z", "Desktop"),
        "quiet_ms": edit(json!(0), "2026-11-11T09:00:00.000Z", "Desktop"),
        "models.pi": edit(json!(["openai/gpt", "sonnet"]), "2026-11-11T09:00:00.000Z", "Desktop"),
    }));
    assert!(
        row(&held, "permissions")
            .hint
            .unwrap()
            .starts_with("No one reviews")
    );
    assert_eq!(
        row(&held, "compact_at_tokens").hint.as_deref(),
        Some("Compaction between pieces of work is off.")
    );
    assert!(
        row(&held, "quiet_ms")
            .hint
            .unwrap()
            .contains("never nudged")
    );
    assert!(
        row(&held, "models.pi")
            .hint
            .unwrap()
            .ends_with("cannot run \"sonnet\".")
    );
    assert_eq!(row(&held, "trust").hint, None);
}

#[test]
fn a_duration_typed_in_minutes_is_sent_in_milliseconds_and_anything_else_as_typed() {
    assert_eq!(registry::stored("quiet_ms", " 10 "), "600000");
    assert_eq!(registry::stored("quiet_ms", "1.5"), "90000");
    assert_eq!(registry::stored("quiet_ms", ""), "");
    // The core refuses it, in its words.
    assert_eq!(registry::stored("quiet_ms", "soon"), "soon");
    assert_eq!(registry::stored("max_iterations", "7"), "7");
    assert_eq!(registry::shown("idle_close_ms", "3600000"), "60");
    assert_eq!(registry::shown("handoff_timeout_ms", "90000"), "1.5");
    assert_eq!(registry::text_of(Some(&json!(["a", "b"]))), "a, b");
    assert_eq!(registry::text_of(Some(&json!(false))), "false");
}

#[test]
fn an_instant_is_said_on_this_computers_clock() {
    let now = time::epoch_ms("2026-11-11T12:00:00Z").unwrap();
    assert_eq!(time::when_of("2026-11-11T09:05:00.000Z", now, 0), "09:05");
    assert_eq!(time::when_of("2026-11-11T09:05:00.000Z", now, 60), "10:05");
    assert_eq!(
        time::when_of("2026-09-03T23:30:00.000Z", now, 60),
        "4 Sept, 00:30"
    );
    assert_eq!(
        time::when_of("2025-12-31T08:00:00+02:00", now, 0),
        "31 Dec 2025, 06:00"
    );
    assert_eq!(time::when_of("not a time", now, 0), "not a time");
}

fn entry(model: &str, efforts: &[&str], default: bool) -> Value {
    json!({
        "model": model, "label": model.to_uppercase(), "description": null,
        "efforts": efforts, "defaultEffort": null, "hidden": false,
        "isDefault": default, "from": "harness",
    })
}

fn catalogues() -> Vec<CataloguesSuccessItem> {
    serde_json::from_value(json!([
        { "profile": "laptop", "name": "laptop", "problem": null, "catalogues": [
            { "harness": "claude", "at": "2026-11-11T10:20:00.000Z", "table": null,
              "entries": [entry("opus", &["low", "high"], true), entry("haiku", &[], false)] },
            { "harness": "codex", "at": "2026-11-11T10:20:00.000Z", "table": null,
              "entries": [entry("gpt-5", &["medium"], true)] },
        ]},
        { "profile": "vm", "name": "vm", "problem": null, "catalogues": [
            { "harness": "claude", "at": "2026-11-11T10:25:00.000Z", "table": null,
              "entries": [entry("opus", &["high", "max"], true)] },
        ]},
    ]))
    .unwrap()
}

fn profiles() -> Vec<String> {
    vec!["laptop".into(), "vm".into()]
}

fn set(harness: &str, model: &str, effort: &str) -> AgentSettings {
    AgentSettings {
        harness: harness.into(),
        model: model.into(),
        effort: effort.into(),
    }
}

#[test]
fn the_agent_selects_offer_what_the_flock_reports_and_say_where() {
    let selects = agents::agent_selects(
        &catalogues(),
        &profiles(),
        &set("claude", "opus", ""),
        now(),
        0,
    );
    let harness: Vec<(&str, &str, bool)> = selects
        .harness
        .options
        .iter()
        .map(|o| {
            (
                o.value.as_str(),
                o.description.as_deref().unwrap(),
                o.disabled,
            )
        })
        .collect();
    assert_eq!(
        harness,
        [
            ("claude", "2 of 2 Machines", false),
            ("codex", "1 of 2 Machines", false),
            ("opencode", "Not reported on any Machine", true),
            ("pi", "Not reported on any Machine", true),
        ]
    );
    assert_eq!(selects.model.label, "OPUS · 2 of 2 Machines");
    let opus = selects
        .model
        .options
        .iter()
        .find(|o| o.value == "opus")
        .unwrap();
    assert_eq!(
        opus.description.as_deref(),
        Some("2 of 2 Machines · Reported by harness")
    );
    let efforts: Vec<(&str, Option<&str>)> = selects
        .effort
        .options
        .iter()
        .map(|o| (o.value.as_str(), o.description.as_deref()))
        .collect();
    assert_eq!(
        efforts,
        [
            ("", None),
            ("low", Some("1 of 2 Machines")),
            ("high", Some("2 of 2 Machines")),
            ("max", Some("1 of 2 Machines")),
        ]
    );
    assert_eq!(selects.lead, "Catalogues read 10:20 · 2 of 2 Machines read");
    let unknown = agents::agent_selects(
        &catalogues(),
        &profiles(),
        &set("claude", "sonnet-x", ""),
        now(),
        0,
    );
    assert_eq!(
        unknown.model.warning.as_deref(),
        Some(
            "sonnet-x is not reported on any Machine. A step on it would not start unless it is added under Advanced."
        )
    );
    let none = agents::agent_selects(
        &catalogues(),
        &profiles(),
        &set("claude", "haiku", ""),
        now(),
        0,
    );
    assert!(none.effort.disabled);
    assert_eq!(none.effort.label, "No effort listed");
}

#[test]
fn another_harness_drops_the_model_and_effort_and_another_model_an_effort_it_does_not_list() {
    let changes = |current: AgentSettings, key: &str, value: &str| {
        agents::agent_changes(&catalogues(), &profiles(), &current, key, value)
            .into_iter()
            .map(|(_, v)| v)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        changes(set("claude", "opus", "high"), "harness", "codex"),
        ["codex", "default", ""]
    );
    assert_eq!(
        changes(set("claude", "opus", "high"), "harness", "claude"),
        ["claude", "opus", "high"]
    );
    assert_eq!(
        changes(set("claude", "opus", "low"), "model", "haiku"),
        ["claude", "haiku", ""]
    );
    assert_eq!(
        changes(set("claude", "haiku", "high"), "model", "opus"),
        ["claude", "opus", "high"]
    );
    assert_eq!(
        changes(set("claude", "opus", ""), "effort", "max"),
        ["claude", "opus", "max"]
    );
}

#[test]
fn fallbacks_are_added_once_moved_and_removed_in_order() {
    let list = "codex, claude/opus";
    assert_eq!(
        agents::change_fallbacks(list, &Fallback::Add("pi".into())),
        "codex, claude/opus, pi"
    );
    assert_eq!(
        agents::change_fallbacks(list, &Fallback::Add("codex".into())),
        list
    );
    assert_eq!(
        agents::change_fallbacks(list, &Fallback::Up(1)),
        "claude/opus, codex"
    );
    assert_eq!(agents::change_fallbacks(list, &Fallback::Up(0)), list);
    assert_eq!(agents::change_fallbacks(list, &Fallback::Down(1)), list);
    assert_eq!(
        agents::change_fallbacks(list, &Fallback::Remove(0)),
        "claude/opus"
    );
    let offered: Vec<String> = agents::fallback_options("codex", &catalogues(), &profiles())
        .into_iter()
        .map(|o| o.value)
        .collect();
    assert_eq!(
        offered,
        ["claude", "claude/opus", "claude/haiku", "codex/gpt-5"]
    );
}

#[test]
fn a_catalogue_read_that_fails_keeps_the_one_before_and_says_why() {
    let held = catalogues();
    let fresh: Vec<CataloguesSuccessItem> = serde_json::from_value(json!([
        { "profile": "laptop", "name": "laptop", "problem": "timed out", "catalogues": [] },
    ]))
    .unwrap();
    let machines = [
        ("laptop".to_string(), "laptop".to_string(), true),
        ("vm".to_string(), "vm".to_string(), false),
        ("new".to_string(), "new".to_string(), true),
    ];
    let kept = agents::remember_catalogues(&held, &fresh, &machines);
    assert_eq!(kept[0].catalogues, held[0].catalogues);
    assert_eq!(kept[0].problem.as_deref(), Some("timed out"));
    assert_eq!(kept[1].problem.as_deref(), Some("out of reach"));
    assert_eq!(kept[2].problem.as_deref(), Some("not read yet"));
}

fn readings(value: Value) -> Vec<ConnectionReadingsSuccessItem> {
    serde_json::from_value(value).unwrap()
}

fn ok(id: &str, account: &str) -> Value {
    json!({ "id": id, "reading": { "state": "ok", "account": account, "detail": format!("{account} detail") } })
}

fn absent(id: &str) -> Value {
    json!({ "id": id, "reading": { "state": "absent", "detail": "no login", "fix": "log in" } })
}

#[test]
fn a_connection_card_reuses_a_login_a_machine_has_and_signs_in_or_sets_up_where_none_is() {
    let read = readings(json!([
        { "profile": "laptop", "name": "laptop", "problem": null, "workflows": [],
          "connections": [ok("gitlab", "mk"), ok("github", "mk-gh"), absent("linear"), ok("slack", "mk")] },
        { "profile": "vm", "name": "vm", "problem": null, "workflows": [],
          "connections": [absent("gitlab"), absent("github"), absent("linear"), absent("slack")] },
    ]));
    let machines = [
        connections::Machine {
            profile: "laptop",
            name: "laptop",
            live: true,
            reason: None,
        },
        connections::Machine {
            profile: "vm",
            name: "vm",
            live: true,
            reason: None,
        },
    ];
    let cards = connections::cards(&connections::machines_read(&machines, &read));
    let card = |name: &str| cards.iter().find(|c| c.name == name).unwrap();
    assert_eq!(
        card("GitLab").primary,
        Some(Primary::Reuse {
            label: "Use glab's login".into(),
            from: "laptop".into(),
            to: vec!["vm".into()]
        })
    );
    assert_eq!(card("GitLab").state, "On 1 of 2 Machines");
    assert_eq!(card("GitLab").account.as_deref(), Some("mk"));
    assert_eq!(card("GitLab").where_, "On laptop · missing on vm");
    assert_eq!(
        card("GitHub").primary.as_ref().unwrap().label(),
        "Give to vm"
    );
    assert_eq!(
        card("Linear").primary,
        Some(Primary::Setup {
            label: "Set up on laptop".into(),
            to: "laptop".into()
        })
    );
    assert_eq!(card("Linear").state, "Not set up");
    assert_eq!(
        card("Linear").where_,
        "No login found · missing on laptop and vm"
    );
    assert_eq!(
        card("Helle").primary,
        Some(Primary::Connect {
            label: "Connect".into()
        })
    );
    assert_eq!(card("Slack").account.as_deref(), Some("mk detail"));

    let gone = [connections::Machine {
        profile: "vm",
        name: "vm",
        live: false,
        reason: Some("Out of reach"),
    }];
    let cards = connections::cards(&connections::machines_read(&gone, &read));
    assert!(
        cards
            .iter()
            .all(|c| c.needs_you && c.machines[0].problem.as_deref() == Some("Out of reach"))
    );
    assert!(
        connections::cards(&[])
            .iter()
            .all(|c| c.state == "Not read yet")
    );
}

#[test]
fn a_workflow_that_needs_a_connection_does_not_start_without_it() {
    let read = readings(
        json!([{ "profile": "a", "name": "a", "problem": null, "connections": [],
        "workflows": [
            { "id": "release", "connections": { "needs": { "gitlab": { "with": "Merges" } } } },
            { "id": "renovate", "connections": { "uses": { "gitlab": { "with": "Opens MRs", "without": "Asks" } } } },
        ] }]),
    );
    let uses = connections::uses(
        &collie_desktop_protocol::generated::Id::Gitlab,
        &connections::workflows(&read),
    );
    let said: Vec<(&str, &str, &str, &str)> = uses
        .iter()
        .map(|u| {
            (
                u.id.as_str(),
                u.declares,
                u.with.as_str(),
                u.without.as_str(),
            )
        })
        .collect();
    assert_eq!(
        said,
        [
            ("release", "needs", "Merges", "Does not start"),
            ("renovate", "uses", "Opens MRs", "Asks")
        ]
    );
}

fn channels() -> Vec<SlackUserChannelsSuccessItem> {
    serde_json::from_value(json!([{ "id": "C456", "name": "collie", "is_private": false }]))
        .unwrap()
}

#[test]
fn a_slack_destination_offers_the_channels_the_human_is_in_and_refuses_any_other() {
    let yours = channels();
    let row = connections::destination("slack.notification_channel", "", Some(&yours));
    assert_eq!(
        row.options,
        [
            ("".into(), "Nowhere: toasts only".into()),
            ("C456".into(), "#collie".into())
        ]
    );
    assert!(!row.disabled);
    assert_eq!(
        connections::pick_destination("C456", Some(&yours)),
        Ok("C456".into())
    );
    assert_eq!(
        connections::pick_destination("C999", Some(&yours)),
        Err("Pick a channel you're in, or refresh Slack".into())
    );
    let kept = connections::destination("release.approval_channel", "D123", Some(&yours));
    assert_eq!(kept.options[0].1, "Nowhere: shares nothing");
    assert_eq!(
        kept.options[2].1,
        "D123 (direct messages are no longer sent)"
    );
    let off = connections::destination("release.approval_channel", "#old", None);
    assert!(off.disabled);
    assert_eq!(off.hint, Some(connections::SIGN_IN_TO_PICK));
    assert_eq!(off.options[1].1, "#old (not checked)");
    assert_eq!(
        connections::pick_destination("C456", None),
        Err(connections::SIGN_IN_TO_PICK.into())
    );
}

#[test]
fn desktops_update_news_is_said_in_a_line() {
    let news = |v: Value| serde_json::from_value::<News>(v).unwrap();
    let said = |v: Value| collie_desktop_board::pages::settings::update_said(&news(v), "1.2.0");
    assert_eq!(
        said(json!({"_tag": "UpToDate", "version": "1.2.0"})),
        "Collie 1.2.0 is up to date"
    );
    assert_eq!(
        said(json!({"_tag": "Ready", "version": "1.3.0"})),
        "Collie 1.3.0 is ready, restart Desktop"
    );
    assert_eq!(
        said(json!({"_tag": "Failed", "reason": "offline"})),
        "Could not check for updates: offline"
    );
    assert_eq!(
        said(json!({"_tag": "Never", "reason": "built from source"})),
        "Built from source."
    );
}

/// The registry is a copy; this keeps it to `src/settings.ts`, where Bun is at hand.
#[test]
fn the_settings_listed_are_src_settings_ts_own() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let script =
        "import { SETTINGS } from './src/settings.ts'; console.log(JSON.stringify(SETTINGS))";
    let out = std::process::Command::new(std::env::var("COLLIE_RUNE_BUN").unwrap_or("bun".into()))
        .args(["-e", script])
        .current_dir(root)
        .output()
        .expect("bun runs");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let theirs: Vec<Value> = serde_json::from_slice(&out.stdout).unwrap();
    let ours: Vec<Value> = registry::settings()
        .into_iter()
        .map(|s| {
            let mut one = json!({
                "key": s.key, "kind": s.kind.name(), "choices": s.choices, "fallback": s.fallback,
                "group": s.group, "label": s.label, "description": s.description,
            });
            if let Some(unit) = s.unit {
                one["unit"] = json!(unit);
            }
            if s.machine {
                one["machine"] = json!(true);
            }
            one
        })
        .collect();
    assert_eq!(ours.len(), theirs.len());
    for (ours, theirs) in ours.iter().zip(&theirs) {
        assert_eq!(ours, theirs);
    }
}

// The page against a fake core.

fn machine(name: &str) -> Shown {
    Shown {
        machine: Machine {
            installation: format!("{name}-install"),
            profile: name.into(),
            name: name.into(),
            target: None,
            route: None,
        },
        herds: Vec::new(),
        cards: Vec::new(),
        as_of: None,
        build: None,
        development: None,
        protocol: None,
        files: false,
    }
}

fn opened() -> (Harness<App>, Runtime<App>) {
    let harness = Harness::<App>::new();
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.machines = vec![machine("laptop"), machine("vm")];
    for profile in ["laptop", "vm"] {
        app.board.flock.synced.set(profile, None);
    }
    harness.fake.will_answer(
        "catalogues",
        Ok(serde_json::to_value(catalogues()).unwrap()),
    );
    harness
        .fake
        .will_answer("connectionReadings", Ok(json!([])));
    harness.fake.will_answer(
        "slackUserChannels",
        Ok(serde_json::to_value(channels()).unwrap()),
    );
    let mut runtime = Runtime::new(
        app,
        view,
        (1280.0, 16000.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    tap(&mut runtime, "nav-settings", 100.0);
    harness.fake.push(
        "flockSettings",
        Ok(json!({ "settings": {
            "quiet_ms": edit(json!(90000), "2026-11-11T09:30:00.000Z", "vm"),
            "trust": edit(json!("never"), "2026-11-11T09:30:00.000Z", "vm"),
        }, "synced": [] })),
    );
    harness.fake.push("settings", Ok(json!({})));
    harness.fake.push(
        "credentials",
        Ok(json!({ "gitlab": null, "helle": false, "host": "gitlab.example.com", "tokenPage": "https://gitlab.example.com/new" })),
    );
    harness.fake.push(
        "updates",
        Ok(json!({ "version": "1.2.0", "news": { "_tag": "UpToDate", "version": "1.2.0" } })),
    );
    harness.fake.push(
        "slackUser",
        Ok(json!({ "signedIn": null, "trouble": null })),
    );
    settle(&harness, &mut runtime, 600.0);
    (harness, runtime)
}

fn settle(harness: &Harness<App>, runtime: &mut Runtime<App>, at: f64) {
    harness.settle(&mut runtime.state);
    runtime.invalidate();
    runtime.frame(at);
}

fn tap(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime.find(key).unwrap_or_else(|| panic!("no {key}"));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

fn press(runtime: &mut Runtime<App>, key: Key, at: f64) {
    runtime.key(KeyEvent {
        key,
        mods: Mods::default(),
    });
    runtime.frame(at);
}

fn type_text(runtime: &mut Runtime<App>, typed: &str, at: f64) {
    press(runtime, Key::Text(typed.into()), at);
}

fn element(runtime: &Runtime<App>, key: &str) -> Option<rune::ElementInfo> {
    runtime
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(key))
}

fn said(runtime: &Runtime<App>, key: &str) -> Option<String> {
    element(runtime, key).and_then(|e| e.text.or(e.label))
}

#[test]
fn opening_settings_asks_the_core_for_everything_it_shows_and_draws_it() {
    let (harness, runtime) = opened();
    for tag in [
        "flockSettings",
        "settings",
        "credentials",
        "updates",
        "slackUser",
        "catalogues",
        "connectionReadings",
        "slackUserChannels",
    ] {
        assert_eq!(harness.fake.asked_of(tag).len(), 1, "{tag} asked once");
    }
    assert!(element(&runtime, "setting-flock-quiet_ms").is_some());
    assert_eq!(
        said(&runtime, "sync-pill").as_deref(),
        Some("In sync with all 2 Machines")
    );
    assert_eq!(
        said(&runtime, "update-state").as_deref(),
        Some("Collie 1.2.0 is up to date")
    );
    assert_eq!(
        said(&runtime, "settings-count").as_deref(),
        Some("44 settings")
    );
    assert!(element(&runtime, "connection-gitlab").is_some());
}

#[test]
fn a_duration_typed_in_minutes_is_set_on_enter_shows_its_progress_and_says_the_cores_refusal() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "flock-quiet_ms", 1000.0);
    press(&mut runtime, Key::End, 1200.0);
    press(&mut runtime, Key::Backspace, 1300.0);
    press(&mut runtime, Key::Backspace, 1400.0);
    press(&mut runtime, Key::Backspace, 1500.0);
    type_text(&mut runtime, "12", 1600.0);
    assert_eq!(
        said(&runtime, "flock-quiet_ms-said").as_deref(),
        Some("Enter sets it · Esc puts it back")
    );
    press(&mut runtime, Key::Enter, 1700.0);
    assert_eq!(
        harness.fake.asked_of("setFlockSetting"),
        [json!({ "key": "quiet_ms", "value": "720000" })]
    );
    assert_eq!(
        said(&runtime, "flock-quiet_ms-said").as_deref(),
        Some("Saving…")
    );
    assert!(harness.fake.answer(
        "setFlockSetting",
        Err(CallError(
            "quiet_ms has to be a whole number, not \"12x\"".into()
        ))
    ));
    settle(&harness, &mut runtime, 1900.0);
    let refusal = element(&runtime, "flock-quiet_ms-error").expect("the refusal is shown");
    assert_eq!(refusal.role, "alert");
    assert_eq!(
        refusal.label.as_deref(),
        Some("quiet_ms has to be a whole number, not \"12x\"")
    );
}

#[test]
fn a_set_value_says_how_far_it_reached_and_esc_puts_an_edit_back() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "flock-max_iterations", 1000.0);
    type_text(&mut runtime, "7", 1100.0);
    press(&mut runtime, Key::Escape, 1200.0);
    assert_eq!(
        said(&runtime, "flock-max_iterations-said").as_deref(),
        Some("Default: 5")
    );
    type_text(&mut runtime, "7", 1300.0);
    tap(&mut runtime, "flock-max_iterations-set", 1400.0);
    assert_eq!(
        harness.fake.asked_of("setFlockSetting"),
        [json!({ "key": "max_iterations", "value": "7" })]
    );
    harness
        .fake
        .answer("setFlockSetting", Ok(json!("max_iterations is now 7")));
    settle(&harness, &mut runtime, 1600.0);
    assert_eq!(
        said(&runtime, "flock-max_iterations-said").as_deref(),
        Some("Given to all 2 Machines")
    );
}

#[test]
fn an_edit_made_while_the_flocks_settings_cannot_be_read_is_refused_without_asking() {
    let (harness, mut runtime) = opened();
    harness.fake.push(
        "flockSettings",
        Err(CallError("the file is unreadable".into())),
    );
    settle(&harness, &mut runtime, 1000.0);
    assert_eq!(
        said(&runtime, "sync-pill").as_deref(),
        Some("Showing the Flock's settings as last read")
    );
    assert!(element(&runtime, "settings-trouble").is_some());
    tap(&mut runtime, "flock-proactive", 1200.0);
    assert!(harness.fake.asked_of("setFlockSetting").is_empty());
    assert_eq!(
        said(&runtime, "flock-proactive-error").as_deref(),
        Some("Not set: the Flock's settings could not be read")
    );
}

#[test]
fn a_switch_a_segment_and_reset_set_the_flocks_value_and_record_timing_is_saved_here() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "flock-proactive", 1000.0);
    tap(&mut runtime, "flock-trust-reset", 1400.0);
    let (x, y) = runtime.find("desktop-record_timing").unwrap();
    let [left, _, width, _] = element(&runtime, "desktop-record_timing").unwrap().rect;
    let _ = x;
    runtime.pointer_move(left + width * 0.75, y);
    runtime.frame(1800.0);
    runtime.pointer_down(left + width * 0.75, y);
    runtime.frame(1850.0);
    runtime.pointer_up(left + width * 0.75, y);
    runtime.frame(1900.0);
    assert_eq!(
        harness.fake.asked_of("setFlockSetting"),
        [
            json!({ "key": "proactive", "value": "false" }),
            json!({ "key": "trust", "value": "" }),
        ]
    );
    assert_eq!(
        harness.fake.asked_of("setSettings"),
        [json!({ "recordTiming": true })]
    );
    harness
        .fake
        .answer("setSettings", Ok(json!({ "recordTiming": true })));
    settle(&harness, &mut runtime, 2100.0);
    assert_eq!(
        said(&runtime, "desktop-record_timing-said").as_deref(),
        Some("Saved on this computer")
    );
}

#[test]
fn an_agent_choice_is_saved_as_one_change_with_what_it_drops() {
    let (harness, mut runtime) = opened();
    runtime.update(|app, _| {
        collie_desktop_board::pages::settings::choose_agent(app, "harness", "codex", false)
    });
    runtime.update(|app, _| {
        collie_desktop_board::pages::settings::choose_agent(app, "effort", "max", false)
    });
    assert_eq!(
        harness.fake.asked_of("setFlockSettings"),
        [json!({ "changes": [
            { "key": "harness", "value": "codex" },
            { "key": "model", "value": "default" },
            { "key": "effort", "value": "" },
        ] })],
        "a second choice waits for the first"
    );
}

#[test]
fn a_token_is_typed_masked_until_revealed_and_saved_for_every_machine() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "details-gitlab", 1000.0);
    let field = element(&runtime, "gitlab-token").expect("the GitLab token field");
    let input = runtime
        .elements()
        .into_iter()
        .find(|e| e.path.starts_with(&field.path) && e.key.as_deref() == Some("input"))
        .unwrap();
    assert!(runtime.element_is_secure(&input.path));
    tap(&mut runtime, "gitlab-token", 1200.0);
    type_text(&mut runtime, "glpat-secret", 1300.0);
    assert_eq!(
        said(&runtime, "reveal-gitlab").as_deref(),
        Some("Show the GitLab token")
    );
    tap(&mut runtime, "reveal-gitlab", 1400.0);
    assert!(runtime.state.pages.settings.gitlab.revealed);
    tap(&mut runtime, "save-gitlab", 1600.0);
    assert_eq!(
        harness.fake.asked_of("saveGitlab"),
        [json!({ "token": "glpat-secret" })]
    );
    harness.fake.answer(
        "saveGitlab",
        Err(CallError("GitLab refused the token: 401".into())),
    );
    settle(&harness, &mut runtime, 1800.0);
    assert_eq!(
        said(&runtime, "gitlab-said").as_deref(),
        Some("GitLab refused the token: 401")
    );
}

#[test]
fn helles_token_is_saved_only_once_helle_says_whose_it_is() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "details-helle", 1000.0);
    tap(&mut runtime, "helle-token", 1200.0);
    type_text(&mut runtime, "hl-1", 1300.0);
    assert!(!collie_desktop_board::pages::settings::token_accepted(
        &runtime.state.pages.settings,
        collie_desktop_board::pages::settings::Which::Helle
    ));
    assert_eq!(
        harness.fake.asked_of("checkHelle").last(),
        Some(&json!({ "token": "hl-1" }))
    );
    harness.fake.answer("checkHelle", Ok(json!("mk")));
    settle(&harness, &mut runtime, 1500.0);
    assert_eq!(
        said(&runtime, "helle-check").as_deref(),
        Some("Belongs to mk")
    );
    tap(&mut runtime, "save-helle", 1700.0);
    assert_eq!(
        harness.fake.asked_of("saveHelle"),
        [json!({ "token": "hl-1" })]
    );
}

#[test]
fn helles_copy_button_writes_the_command_to_the_clipboard() {
    let (harness, mut runtime) = opened();
    let clipboard = rune::clipboard::memory();
    clipboard.set_text("what was copied before");
    runtime.use_clipboard(&clipboard);

    tap(&mut runtime, "details-helle", 1000.0);
    tap(&mut runtime, "helle-copy", 1200.0);

    assert_eq!(
        clipboard.text().as_deref().map(String::as_str),
        Some("/helle token")
    );
    assert!(harness.fake.asked_of("copyText").is_empty());
}

#[test]
fn gitlab_paste_reads_the_clipboard_and_uses_the_typed_tokens_save() {
    let (harness, mut runtime) = opened();
    let clipboard = rune::clipboard::memory();
    clipboard.set_text(" \t glpat-from-clipboard \n");
    runtime.use_clipboard(&clipboard);

    tap(&mut runtime, "details-gitlab", 1000.0);
    tap(&mut runtime, "paste-gitlab", 1200.0);
    runtime.frame(1400.0);

    assert_eq!(
        harness.fake.asked_of("saveGitlab"),
        [json!({ "token": "glpat-from-clipboard" })]
    );
    assert!(harness.fake.asked_of("pasteGitlab").is_empty());
    harness.fake.answer(
        "saveGitlab",
        Err(CallError("GitLab refused the token: 401".into())),
    );
    settle(&harness, &mut runtime, 1600.0);
    assert_eq!(
        said(&runtime, "gitlab-said").as_deref(),
        Some("GitLab refused the token: 401")
    );
    assert!(!runtime.state.pages.settings.gitlab.saving);

    // The typed-token path refuses blank input. A blank paste must not resubmit the
    // preceding token, either, and it never asks the core to read the clipboard.
    clipboard.set_text(" \t\n ");
    tap(&mut runtime, "paste-gitlab", 1800.0);
    runtime.frame(2000.0);
    assert_eq!(harness.fake.asked_of("saveGitlab").len(), 1);
    assert!(harness.fake.asked_of("pasteGitlab").is_empty());
    assert!(!runtime.state.pages.settings.gitlab.saving);
}

#[test]
fn a_connections_primary_action_reuses_a_login_and_says_what_came_of_it() {
    let (harness, mut runtime) = opened();
    harness.fake.will_answer(
        "connectionReadings",
        Ok(json!([
            { "profile": "laptop", "name": "laptop", "problem": null, "workflows": [], "connections": [ok("gitlab", "mk")] },
            { "profile": "vm", "name": "vm", "problem": null, "workflows": [], "connections": [absent("gitlab")] },
        ])),
    );
    tap(&mut runtime, "refresh-connections", 1000.0);
    settle(&harness, &mut runtime, 1200.0);
    tap(&mut runtime, "connect-gitlab", 1400.0);
    assert_eq!(
        harness.fake.asked_of("reuseConnection"),
        [json!({ "id": "gitlab", "from": "laptop", "to": ["vm"] })]
    );
    harness
        .fake
        .answer("reuseConnection", Ok(json!("Gave glab's login to vm")));
    settle(&harness, &mut runtime, 1600.0);
    assert_eq!(
        said(&runtime, "connection-gitlab-said").as_deref(),
        Some("Gave glab's login to vm")
    );
}

#[test]
fn restart_desktop_is_offered_once_an_update_is_ready() {
    let (harness, mut runtime) = opened();
    assert!(element(&runtime, "restart-desktop").is_none());
    harness.fake.push(
        "updates",
        Ok(json!({ "version": "1.2.0", "news": { "_tag": "Ready", "version": "1.3.0" } })),
    );
    settle(&harness, &mut runtime, 1000.0);
    tap(&mut runtime, "restart-desktop", 1200.0);
    assert_eq!(harness.fake.asked_of("restart").len(), 1);
}

#[test]
fn the_search_keeps_the_rows_it_names_and_says_how_many() {
    let (_harness, mut runtime) = opened();
    tap(&mut runtime, "settings-search", 1000.0);
    type_text(&mut runtime, "quiet", 1100.0);
    assert_eq!(
        said(&runtime, "settings-count").as_deref(),
        Some("2 of 44 settings shown")
    );
    assert!(element(&runtime, "setting-flock-quiet_ms").is_some());
    assert!(element(&runtime, "setting-flock-trust").is_none());
    assert!(element(&runtime, "connections").is_none());
    tap(&mut runtime, "settings-only-set", 1300.0);
    assert_eq!(
        said(&runtime, "settings-count").as_deref(),
        Some("1 of 44 settings shown")
    );
}

/// Every text drawn inside the element keyed `key`.
fn texts_in(runtime: &Runtime<App>, key: &str) -> Vec<String> {
    let tree = runtime.elements();
    let Some(at) = tree.iter().find(|e| e.key.as_deref() == Some(key)) else {
        return Vec::new();
    };
    let inside = format!("{}/", at.path);
    tree.iter()
        .filter(|e| e.path.starts_with(&inside))
        .filter_map(|e| e.text.clone())
        .collect()
}

#[test]
fn each_machines_own_settings_are_a_row_a_machine_with_what_it_read() {
    let (harness, mut runtime) = opened();
    let read: collie_desktop_protocol::generated::FlockItem = serde_json::from_value(json!({
        "_tag": "OwnRead", "machine": { "profile": "vm", "name": "vm" },
        "reading": { "values": { "projectsRoot": "/work", "chatHarness": "pi",
            "harnesses": ["codex", "claude"],
            "remembered": [{ "key": "linear.team", "value": "TOOLS" }] },
            "at": 1_793_273_400_000.0, "problem": null, "unsupported": false },
    }))
    .unwrap();
    runtime.state.apply(read);
    settle(&harness, &mut runtime, 900.0);
    let vm = texts_in(&runtime, "own-vm");
    for shown in [
        "vm",
        "/work",
        "pi",
        "codex, claude",
        "linear.team = TOOLS",
        "In sync",
    ] {
        assert!(
            vm.iter().any(|t| t == shown),
            "{shown} is in vm's row: {vm:?}"
        );
    }
    let laptop = texts_in(&runtime, "own-laptop");
    assert!(
        laptop.iter().any(|t| t == "Not read yet"),
        "a Machine not read yet says so: {laptop:?}"
    );
}

#[test]
fn help_me_write_it_opens_the_standing_direction_dialog_and_reads_the_sessions() {
    let (harness, mut runtime) = opened();
    assert!(!runtime.state.standing.open);
    tap(&mut runtime, "standing-setup-help", 900.0);
    assert!(runtime.state.standing.open, "the dialog is open");
    assert_eq!(harness.fake.asked_of("setupInventory").len(), 1);
}

#[test]
fn setting_up_linear_shows_the_job_it_started_as_an_onboarding() {
    use collie_desktop_board::pages::settings::connections::Card;
    use collie_desktop_protocol::generated::Id;
    let (harness, mut runtime) = opened();
    let card = Card {
        id: Id::Linear,
        name: "Linear",
        primary: Some(Primary::Setup {
            label: "Set up on vm".into(),
            to: "vm".into(),
        }),
        needs_you: true,
        state: "Not set up".into(),
        account: None,
        where_: String::new(),
        machines: Vec::new(),
    };
    collie_desktop_board::pages::settings::connect(&mut runtime.state, &card);
    assert_eq!(
        harness.fake.asked_of("linearSetup"),
        [json!({ "profile": "vm" })]
    );
    harness.fake.answer("linearSetup", Ok(json!("job-linear")));
    settle(&harness, &mut runtime, 900.0);
    assert_eq!(
        runtime.state.pages.machines.job.as_deref(),
        Some("job-linear")
    );
    assert!(
        runtime
            .elements()
            .iter()
            .any(|e| e.text.as_deref() == Some("Starting…")),
        "its onboarding dialog shows on Settings"
    );
}

/// The `[x, y, w, h]` an element with `key` is drawn at.
fn rect_of(runtime: &Runtime<App>, key: &str) -> [f32; 4] {
    element(runtime, key)
        .unwrap_or_else(|| panic!("no {key}"))
        .rect
}

#[test]
fn a_select_opens_its_list_at_its_field_not_the_windows_corner() {
    let (_harness, mut runtime) = opened();
    tap(&mut runtime, "flock-harness", 1000.0);
    runtime.frame(1400.0);
    let [fx, fy, fw, fh] = rect_of(&runtime, "flock-harness-trigger");
    let [lx, ly, lw, _] = rect_of(&runtime, "flock-harness-content");
    assert!(fy > 40.0, "the field is down the page, at {fy}");
    assert!(
        lx < fx + fw && fx < lx + lw && (ly - (fy + fh)).abs() < 12.0,
        "the list at ({lx}, {ly}) opens under its field at ({fx}, {})",
        fy + fh
    );
}

#[test]
fn a_setting_the_flock_has_kept_says_how_far_it_reached_while_the_core_gives_it_out() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "flock-max_iterations", 1000.0);
    type_text(&mut runtime, "7", 1100.0);
    press(&mut runtime, Key::Enter, 1200.0);
    assert_eq!(
        said(&runtime, "flock-max_iterations-said").as_deref(),
        Some("Saving…")
    );
    // The core keeps it at once, then waits on each Machine's sync before it answers.
    harness.fake.push(
        "flockSettings",
        Ok(json!({ "settings": {
            "quiet_ms": edit(json!(90000), "2026-11-11T09:30:00.000Z", "vm"),
            "trust": edit(json!("never"), "2026-11-11T09:30:00.000Z", "vm"),
            "max_iterations": edit(json!(7), "2026-11-11T10:00:00.000Z", "laptop"),
        }, "synced": [] })),
    );
    settle(&harness, &mut runtime, 1400.0);
    assert_eq!(
        said(&runtime, "flock-max_iterations-said").as_deref(),
        Some("Given to all 2 Machines"),
        "kept, it is no longer saving"
    );
    assert!(runtime.state.pages.settings.saving.is_empty());
    type_text(&mut runtime, "0", 1500.0);
    harness
        .fake
        .answer("setFlockSetting", Ok(json!("max_iterations is now 7")));
    settle(&harness, &mut runtime, 1600.0);
    assert!(
        runtime
            .state
            .pages
            .settings
            .drafts
            .contains_key("flock-max_iterations"),
        "the late answer leaves a new edit alone"
    );
}

#[test]
fn connections_are_read_again_when_an_onboarding_such_as_linears_setup_ends() {
    let (harness, mut runtime) = opened();
    let read = harness.fake.asked_of("connectionReadings").len();
    let ended: collie_desktop_protocol::generated::FlockItem = serde_json::from_value(json!({
        "_tag": "Onboarding", "job": "job-linear",
        "machine": { "profile": "vm", "name": "vm" },
        "run": { "steps": [{ "step": "linear", "title": "Linear", "status": "done" }],
            "asked": null, "ready": true, "reason": null, "at": 9 } }))
    .unwrap();
    runtime.state.apply(ended.clone());
    settle(&harness, &mut runtime, 1000.0);
    runtime.frame(1100.0);
    assert_eq!(
        harness.fake.asked_of("connectionReadings").len(),
        read + 1,
        "Linear may be connected now"
    );
    runtime.state.apply(ended);
    settle(&harness, &mut runtime, 1200.0);
    runtime.frame(1300.0);
    assert_eq!(
        harness.fake.asked_of("connectionReadings").len(),
        read + 1,
        "the same run told again is not read again"
    );
}

#[test]
fn the_harness_select_lists_a_harness_no_machine_reports_and_choosing_it_does_nothing() {
    let (harness, mut runtime) = opened();
    tap(&mut runtime, "flock-harness", 1000.0);
    runtime.frame(1400.0);
    let options: Vec<rune::ElementInfo> = runtime
        .elements()
        .into_iter()
        .filter(|e| e.role == "option" && e.path.contains("flock-harness-content"))
        .collect();
    let names: Vec<&str> = options.iter().filter_map(|o| o.label.as_deref()).collect();
    assert_eq!(names, ["Claude Code", "Codex", "OpenCode", "Pi"]);
    let pi = options
        .iter()
        .find(|o| o.label.as_deref() == Some("Pi"))
        .unwrap();
    let [x, y, w, h] = pi.rect;
    let (x, y) = (x + w / 2.0, y + h / 2.0);
    runtime.pointer_move(x, y);
    runtime.frame(1500.0);
    runtime.pointer_down(x, y);
    runtime.frame(1550.0);
    runtime.pointer_up(x, y);
    runtime.frame(1600.0);
    assert!(
        harness.fake.asked_of("setFlockSettings").is_empty(),
        "a harness no Machine has is not chosen"
    );
}
