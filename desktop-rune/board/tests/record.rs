//! A record's logic, case for case from `test/desktop-record.test.ts`, `desktop-diff-view`,
//! `desktop-flow-actions`, `desktop-step-inspector`, `desktop-step-timing`, `desktop-when`,
//! `desktop-evidence`, `desktop-plan-view` and `desktop/test/record-terminal.test.ts`.

use collie_desktop_board::flow::actions::{self, Effect, next_move, retry_caption, shown_at};
use collie_desktop_board::flow::inspector::{self, Part};
use collie_desktop_board::record::agents::{
    MrRef, agent_tabs, asked_for, delivery_choices, read_mr_ref,
};
use collie_desktop_board::record::diff::{
    TreeNode, choice_for_every, diff_tree, file_beside, file_open, files_of, filter_tree,
    tick_viewed, ticks_still_true, viewed_count,
};
use collie_desktop_board::record::evidence::{confined, plan_progress, sort_evidence};
use collie_desktop_board::record::tabs::{
    KeyAction, KeyFacts, Landing, SummarySection, TabFacts, Target, key_action, landing_of,
    mr_tabs_of, offers_terminal, record_tabs, summary_of, tab_beside, tab_shown,
};
use collie_desktop_board::record::when::{epoch_ms, minutes, when_at};
use collie_desktop_protocol::generated::{
    ActPayloadAction, Agent, Detail, DetailAgent, DetailFlow, DetailMr2, EvidenceItem, File, Lane,
    NodeRun, PendingItem, Review, Revision, Ticket, Verification,
};
use serde_json::{Value, json};
use std::collections::HashMap;

fn everything() -> TabFacts {
    TabFacts {
        flow: false,
        loaded: true,
        plan: true,
        review_text: true,
        findings: true,
        target: false,
        diff: true,
        terminal: true,
        mr: Some("MR !12".into()),
        mrs: Vec::new(),
        pending: Vec::new(),
    }
}

fn values(facts: TabFacts) -> Vec<String> {
    record_tabs(&facts).into_iter().map(|t| t.value).collect()
}

#[test]
fn flow_comes_before_summary_when_the_host_supplies_it() {
    let tabs = record_tabs(&TabFacts {
        flow: true,
        ..everything()
    });
    let first: Vec<(&str, &str)> = tabs[..2]
        .iter()
        .map(|t| (t.label.as_str(), t.value.as_str()))
        .collect();
    assert_eq!(first, [("Flow", "flow"), ("Summary", "summary")]);
    assert_eq!(tab_shown(&tabs, None), "flow");
}

#[test]
fn a_run_with_everything_starts_with_summary_and_ends_with_facts() {
    let tabs: Vec<(String, String)> = record_tabs(&everything())
        .into_iter()
        .map(|t| (t.label, t.value))
        .collect();
    let want = [
        ("Summary", "summary"),
        ("Plan", "plan"),
        ("Review", "review"),
        ("Diff", "diff"),
        ("Evidence", "evidence"),
        ("Artefacts", "artefacts"),
        ("Log", "log"),
        ("Terminal", "terminal"),
        ("MR !12", "mr"),
        ("Facts", "facts"),
    ];
    assert_eq!(tabs, want.map(|(l, v)| (l.to_string(), v.to_string())));
    assert_eq!(
        values(TabFacts {
            plan: false,
            diff: false,
            ..everything()
        }),
        [
            "summary",
            "review",
            "evidence",
            "artefacts",
            "log",
            "terminal",
            "mr",
            "facts"
        ]
    );
}

#[test]
fn review_is_kept_for_a_followed_target_alone() {
    let bare = TabFacts {
        review_text: false,
        findings: false,
        ..everything()
    };
    assert!(!values(bare.clone()).contains(&"review".to_string()));
    assert!(
        values(TabFacts {
            target: true,
            ..bare
        })
        .contains(&"review".to_string())
    );
}

#[test]
fn a_part_still_coming_is_a_loading_tab_and_goes_once_it_came_empty() {
    let coming = TabFacts {
        plan: false,
        review_text: false,
        findings: false,
        diff: false,
        ..everything()
    };
    let loading = record_tabs(&TabFacts {
        pending: vec![
            PendingItem::Texts,
            PendingItem::Diff,
            PendingItem::Mr,
            PendingItem::Tail,
        ],
        ..coming.clone()
    });
    let still: Vec<&str> = loading
        .iter()
        .filter(|t| t.loading)
        .map(|t| t.value.as_str())
        .collect();
    assert_eq!(still, ["plan", "review", "diff", "log", "mr"]);
    let came = record_tabs(&coming);
    assert!(came.iter().all(|t| !t.loading));
    assert_eq!(
        came.iter().map(|t| t.value.as_str()).collect::<Vec<_>>(),
        [
            "summary",
            "evidence",
            "artefacts",
            "log",
            "terminal",
            "mr",
            "facts"
        ]
    );
}

#[test]
fn several_merge_requests_each_get_a_tab_in_place_of_the_one() {
    let mrs: Vec<DetailMr2> = serde_json::from_value(json!([
        {"id": "gitlab.cego.dk/spilnu/api!7", "mr": "https://gitlab.cego.dk/spilnu/api/-/merge_requests/7"},
        {"id": "github.com/cego/web#8", "mr": "https://github.com/cego/web/pull/8"}
    ]))
    .unwrap();
    let tabs = record_tabs(&TabFacts {
        mrs: mr_tabs_of(Some(&mrs)),
        ..everything()
    });
    let tail: Vec<(String, String)> = tabs
        .iter()
        .skip_while(|tab| !tab.value.starts_with("mr:"))
        .map(|t| (t.label.clone(), t.value.clone()))
        .collect();
    assert_eq!(
        tail,
        [
            (
                "Merge request api!7".to_string(),
                "mr:gitlab.cego.dk/spilnu/api!7".to_string()
            ),
            (
                "Pull request web#8".into(),
                "mr:github.com/cego/web#8".into()
            ),
            ("Facts".into(), "facts".into()),
        ]
    );
    assert!(mr_tabs_of(None).is_empty());
}

#[test]
fn without_the_runs_details_only_log_terminal_and_facts_show() {
    let bare = TabFacts {
        loaded: false,
        plan: false,
        review_text: false,
        findings: false,
        diff: false,
        mr: None,
        ..everything()
    };
    assert_eq!(values(bare.clone()), ["log", "terminal", "facts"]);
    assert_eq!(
        values(TabFacts {
            target: true,
            terminal: false,
            ..bare
        }),
        ["log", "facts"]
    );
}

#[test]
fn the_tab_shown_is_the_chosen_one_while_present_else_the_first() {
    let tabs = record_tabs(&everything());
    assert_eq!(tab_shown(&tabs, None), "summary");
    assert_eq!(tab_shown(&tabs, Some("diff")), "diff");
    assert_eq!(
        tab_shown(
            &record_tabs(&TabFacts {
                diff: false,
                ..everything()
            }),
            Some("diff")
        ),
        "summary"
    );
    assert_eq!(
        tab_shown(
            &record_tabs(&TabFacts {
                loaded: false,
                ..everything()
            }),
            Some("plan")
        ),
        "log"
    );
}

#[test]
fn brackets_step_through_tabs_past_terminal_and_j_k_move_files_only_on_diff() {
    let tabs = record_tabs(&everything());
    assert_eq!(
        tab_beside(&tabs, "log", 1).as_deref(),
        Some("mr"),
        "Terminal is passed over"
    );
    assert_eq!(tab_beside(&tabs, "summary", -1), None);
    let key = |key: &str, tab: &str| {
        key_action(&KeyFacts {
            key,
            ctrl_or_meta: false,
            in_field: false,
            tab,
        })
    };
    assert_eq!(key("]", "summary"), Some(KeyAction::NextTab));
    assert_eq!(key("j", "diff"), Some(KeyAction::NextFile));
    assert_eq!(key("j", "plan"), None);
    assert_eq!(key("[", "terminal"), None, "the pane keeps its keys");
    assert_eq!(
        key_action(&KeyFacts {
            key: "]",
            ctrl_or_meta: true,
            in_field: false,
            tab: "plan"
        }),
        None
    );
}

#[test]
fn a_finding_lands_on_its_line_its_file_or_the_file_read_only() {
    let diff = ["a.rs".to_string()];
    let at = |file: &str, line| Target {
        file: file.into(),
        line,
    };
    assert_eq!(
        landing_of(&at("a.rs", Some(3)), Some(&diff)),
        Landing::Line {
            file: "a.rs".into(),
            line: 3
        }
    );
    assert_eq!(
        landing_of(&at("a.rs", None), Some(&diff)),
        Landing::File {
            file: "a.rs".into()
        }
    );
    assert_eq!(landing_of(&at("b.rs", Some(1)), Some(&diff)).tab(), "diff");
    assert_eq!(landing_of(&at("b.rs", Some(1)), None).tab(), "review");
}

fn detail(extra: Value) -> Detail {
    let mut base = json!({
        "id": "run-1", "dir": "/runs/run-1", "title": "Build it", "status": "running",
        "inputs": [], "steps": [], "handoffs": [], "outputs": [],
        "review": {"_tag": "None", "reason": "no review"},
        "attention": {"category": "none", "reason": "", "explanation": "", "actions": []},
        "outcome": {"gaps": [], "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "finishedAt": 0, "findings": [], "verifications": [], "steering": [], "evidence": []
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    serde_json::from_value(base).unwrap()
}

#[test]
fn the_summary_says_status_attention_outcome_and_inputs_each_only_with_something_to_say() {
    let bare = summary_of(&detail(json!({})));
    assert_eq!(bare, [SummarySection::Status("running".into())]);
    let full = summary_of(&detail(json!({
        "attention": {"category": "question", "reason": "r", "explanation": "Which way?", "actions": []},
        "outcome": {"gaps": [], "measurement": "p95 120ms", "metrics": {"verifications": {"pass": 0, "fail": 0, "unstable": 0, "byCollie": 0},
            "slices": {"done": 0, "total": 0}, "rework": 0, "halts": [], "obstacles": []}},
        "inputs": [{"name": "goal", "value": "x", "source": "cli"}]
    })));
    let kinds: Vec<&str> = full
        .iter()
        .map(|s| match s {
            SummarySection::Status(_) => "status",
            SummarySection::Attention { .. } => "attention",
            SummarySection::Outcome(_) => "outcome",
            SummarySection::Inputs(_) => "inputs",
            SummarySection::Replies(_) => "replies",
        })
        .collect();
    assert_eq!(
        kinds,
        ["status", "attention", "outcome", "inputs"],
        "a measurement alone is something to say"
    );
}

#[test]
fn the_terminal_is_offered_on_a_reached_machine_and_kept_while_shown_after_it_drops() {
    assert!(offers_terminal(true, None));
    assert!(!offers_terminal(false, Some("diff")));
    assert!(offers_terminal(false, Some("terminal")));
}

#[test]
fn an_instant_reads_as_its_time_today_its_day_this_year_or_its_date_before() {
    let now = epoch_ms("2026-11-04T12:00:00Z").unwrap();
    let utc = |_: f64| 0;
    assert_eq!(when_at("2026-11-04T08:05:00Z", now, utc), "08:05");
    assert_eq!(when_at("2026-10-24T11:22:00Z", now, utc), "24 Oct, 11:22");
    assert_eq!(
        when_at("2025-10-24T11:22:00Z", now, utc),
        "24 Oct 2025, 11:22"
    );
    assert_eq!(when_at("2026-11-04T23:30:00Z", now, |_| 60), "5 Nov, 00:30");
    assert_eq!(when_at("not a time", now, utc), "not a time");
    assert_eq!(
        epoch_ms("2026-11-04T13:00:00.500+01:00"),
        Some(epoch_ms("2026-11-04T12:00:00Z").unwrap() + 500.0)
    );
    assert_eq!(
        [
            minutes(30_000.0),
            minutes(540_000.0),
            minutes(7_200_000.0),
            minutes(7_500_000.0)
        ],
        ["under a minute", "9 min", "2 h", "2 h 5 min"]
    );
}

fn file(path: &str) -> File {
    serde_json::from_value(json!({"path": path, "status": "modified", "added": 1, "removed": 0}))
        .unwrap()
}

fn paths(files: &[File]) -> Vec<&str> {
    files.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn the_diff_tree_lists_files_in_the_order_it_reads_around_a_folder_sharing_their_prefix() {
    let changed: Vec<File> = ["a/b.ts", "a/b/c.ts", "a/b-c.ts", "a/b/d.ts", "a/b0.ts"]
        .map(file)
        .to_vec();
    let tree = diff_tree(&changed);
    assert_eq!(
        paths(&files_of(&tree)),
        ["a/b.ts", "a/b/c.ts", "a/b/d.ts", "a/b-c.ts", "a/b0.ts"]
    );
    let keys: Vec<&str> = tree
        .iter()
        .map(|n| match n {
            TreeNode::Folder { key, .. } | TreeNode::File { key, .. } => key.as_str(),
        })
        .collect();
    assert_eq!(keys, ["a/"]);
}

#[test]
fn a_chain_of_single_folders_is_one_row_keyed_by_its_deepest_and_a_filter_merges_alike() {
    let tree = diff_tree(&[file("src/app/deep/x.rs"), file("top.rs")]);
    match &tree[0] {
        TreeNode::Folder { key, label, .. } => {
            assert_eq!(
                (key.as_str(), label.as_str()),
                ("src/app/deep/", "src/app/deep")
            )
        }
        other => panic!("{other:?}"),
    }
    let tree = diff_tree(&[file("src/a/x.rs"), file("src/b/y.rs")]);
    let kept = filter_tree(&tree, "Y.RS");
    match &kept[0] {
        TreeNode::Folder { key, label, .. } => {
            assert_eq!((key.as_str(), label.as_str()), ("src/b/", "src/b"))
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(filter_tree(&tree, "  ").len(), tree.len());
}

#[test]
fn a_viewed_tick_holds_while_the_file_and_base_are_as_seen() {
    let seen = file("a.rs");
    let ticks = tick_viewed(&HashMap::new(), &seen, "base-1");
    assert_eq!(
        viewed_count(&ticks, &[seen.clone(), file("b.rs")], "base-1"),
        "1 of 2 viewed"
    );
    let changed = File {
        added: Some(5),
        ..seen.clone()
    };
    assert_eq!(
        viewed_count(&ticks, std::slice::from_ref(&changed), "base-1"),
        "0 of 1 viewed"
    );
    assert_eq!(
        viewed_count(&ticks, std::slice::from_ref(&seen), "base-2"),
        "0 of 1 viewed"
    );
    assert!(
        ticks_still_true(&ticks, &[changed], "base-1").is_empty(),
        "gone even if it changes back"
    );
}

#[test]
fn a_big_or_binary_file_starts_closed_and_a_choice_or_expand_all_overrides_it() {
    let big = File {
        added: Some(400),
        removed: Some(101),
        ..file("big.rs")
    };
    let binary = File {
        added: None,
        removed: None,
        ..file("logo.png")
    };
    let none = HashMap::new();
    assert!(file_open(&file("a.rs"), &none));
    assert!(!file_open(&big, &none));
    assert!(!file_open(&binary, &none));
    assert!(file_open(
        &big,
        &choice_for_every(std::slice::from_ref(&big), true)
    ));
}

#[test]
fn j_and_k_step_from_the_active_file_and_start_at_the_first() {
    let files = [file("a"), file("b")];
    assert_eq!(file_beside(&files, None, 1).as_deref(), Some("a"));
    assert_eq!(file_beside(&files, Some("a"), 1).as_deref(), Some("b"));
    assert_eq!(file_beside(&files, Some("b"), 1), None);
    assert_eq!(file_beside(&files, Some("a"), -1), None);
}

fn node(id: &str, extra: Value) -> NodeRun {
    let mut base = json!({"id": id, "title": format!("{}{}", id[..1].to_uppercase(), &id[1..]), "kind": "agent",
        "description": "", "declared": true, "state": "expected", "offPath": false, "attempts": [], "questions": []});
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn lane(nodes: Vec<NodeRun>, actions: Value) -> Lane {
    let nodes: Vec<Value> = nodes
        .into_iter()
        .map(|n| {
            let mut v = serde_json::to_value(n).unwrap();
            v["runs"] = json!([]);
            v
        })
        .collect();
    serde_json::from_value(
        json!({"run": "build-run", "workflow": "implement", "title": "Build", "machine": "Local",
        "execution": "running", "declared": true, "nodes": nodes, "actions": actions}),
    )
    .unwrap()
}

#[test]
fn retry_names_the_steps_it_keeps_shortening_after_three() {
    let checks = node("checks", json!({"state": "failed"}));
    let done = |id: &str| node(id, json!({"state": "done"}));
    let two = lane(
        vec![done("build"), done("review"), checks.clone()],
        json!([]),
    );
    assert_eq!(
        retry_caption(&two, &checks),
        "Keeps Build and Review and runs Checks again."
    );
    let many = lane(
        ["grill", "spec", "tickets", "build", "review"]
            .map(done)
            .to_vec(),
        json!([]),
    );
    assert_eq!(
        retry_caption(&many, &checks),
        "Keeps Grill and 4 more and runs Checks again."
    );
}

#[test]
fn a_steps_actions_are_its_primary_then_the_rest_and_none_while_its_machine_is_away() {
    let step = node(
        "review",
        json!({"state": "running", "agent": "review-1", "role": "reviewer", "primary": "terminal", "actions": ["tell", "pause"]}),
    );
    let lane = lane(vec![step.clone()], json!(["hold", "stop"]));
    let labels: Vec<String> = actions::step_actions(&step, &lane, true)
        .into_iter()
        .map(|a| a.label)
        .collect();
    assert_eq!(
        labels,
        [
            "Watch the reviewer",
            "Tell the reviewer…",
            "Pause before Review"
        ]
    );
    assert!(actions::step_actions(&step, &lane, false).is_empty());
    let lanes: Vec<String> = actions::lane_actions(&lane, true)
        .into_iter()
        .map(|a| a.label)
        .collect();
    assert_eq!(lanes, ["Hold run", "Stop run"]);
    let tell = actions::flow_action(
        &collie_desktop_protocol::generated::Primary::Tell,
        &step,
        &lane,
        true,
    )
    .unwrap();
    match tell.effect {
        Effect::Text {
            write: ActPayloadAction::Deliver(d),
            ..
        } => {
            assert_eq!(
                (d.run_id.as_str(), d.agent.as_deref()),
                ("build-run", Some("review-1"))
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_next_move_is_the_current_nodes_primary() {
    let step = node("checks", json!({"state": "failed", "primary": "retry"}));
    let lane = serde_json::to_value(lane(vec![step], json!([]))).unwrap();
    let flow: DetailFlow = serde_json::from_value(
        json!({"lanes": [lane], "current": {"run": "build-run", "node": "checks"}}),
    )
    .unwrap();
    let next = next_move(&flow).unwrap();
    assert_eq!(
        (next.node.id.as_str(), next.action.clone()),
        ("checks", collie_desktop_protocol::generated::Primary::Retry)
    );
    let still: DetailFlow = serde_json::from_value(json!({"lanes": [], "current": null})).unwrap();
    assert!(next_move(&still).is_none());
}

#[test]
fn a_hold_or_a_note_names_the_revision_it_was_shown_at_and_other_acts_do_not() {
    let revision = Revision {
        epoch: "e1".into(),
        seq: 4.0,
    };
    let hold = actions::control(
        "r",
        collie_desktop_protocol::generated::ControlControl::Hold,
        true,
        None,
    );
    match shown_at(hold, Some(&revision)) {
        ActPayloadAction::Control(c) => assert_eq!(c.shown, Some(revision.clone())),
        other => panic!("{other:?}"),
    }
    let resume = actions::resume("r");
    assert_eq!(shown_at(resume.clone(), Some(&revision)), resume);
}

#[test]
fn a_steps_log_is_bounded_by_the_next_steps_start_and_says_where_earlier_lines_went() {
    let text = |t: &str, cut| -> Review {
        serde_json::from_value(json!({"_tag": "Text", "text": t, "truncated": cut})).unwrap()
    };
    let all = text(
        "first\n── First ──\na\n── Second ──\nb\nc\n── Third ──\nd\n",
        false,
    );
    let log = inspector::step_lines(Some(&all), 1, Some(4), &[2, 4, 7]);
    assert_eq!(
        (log.text.as_deref(), log.count, log.older),
        (Some("── Second ──\nb\nc\n"), 3, None)
    );
    let tail = text("b\nc\n── Third ──\nd\n", true);
    let log = inspector::step_lines(Some(&tail), 5, Some(4), &[2, 4, 7]);
    assert_eq!(
        (log.text.as_deref(), log.count, log.older),
        (
            Some("b\nc\n"),
            2,
            Some("Earlier lines are older than the log shown.")
        )
    );
}

#[test]
fn a_step_opens_on_its_question_its_live_work_why_it_failed_or_its_proof() {
    let asking = node(
        "ask",
        json!({"questions": [{"id": "q1", "name": "Which?", "open": true}]}),
    );
    assert_eq!(inspector::inspector_part(&asking, true), Part::Decision);
    let running = node("build", json!({"state": "running"}));
    assert_eq!(inspector::inspector_part(&running, true), Part::Terminal);
    assert_eq!(inspector::inspector_part(&running, false), Part::Details);
    assert_eq!(
        inspector::inspector_part(&node("x", json!({"state": "failed"})), true),
        Part::Why
    );
    assert_eq!(
        inspector::inspector_part(&node("c", json!({"kind": "check"})), false),
        Part::Evidence
    );
    let parts = inspector::inspector_parts(&node("l", json!({"log": 3})), true, 4, 0);
    let labels: Vec<&str> = parts.iter().map(|p| p.label.as_str()).collect();
    assert_eq!(labels, ["Terminal", "Log · 4"]);
    assert_eq!(
        inspector::shown_part(Part::Evidence, &parts),
        Part::Terminal
    );
}

#[test]
fn a_steps_evidence_leaves_out_other_steps_and_narrows_to_a_picked_slice() {
    let check = |id: &str, step: &str, place: Value| -> Verification {
        serde_json::from_value(
            json!({"id": id, "step": step, "place": place, "name": "test", "result": "pass",
            "expect": "pass", "exit": 0, "at": "2026-11-04T08:00:00Z", "by": "collie"}),
        )
        .unwrap()
    };
    let checks = [
        check(
            "1",
            "build",
            json!({"item": "slice-a", "items": ["slice-a", "slice-b"]}),
        ),
        check(
            "2",
            "build",
            json!({"item": "slice-b", "items": ["slice-a", "slice-b"]}),
        ),
        check("3", "review", json!(null)),
    ];
    assert_eq!(inspector::step_evidence(&checks, "build", None).len(), 2);
    let picked = node("slice-b", json!({"place": "slice-b"}));
    let ids: Vec<&str> = inspector::step_evidence(&checks, "build", Some(&picked))
        .iter()
        .map(|v| v.id.as_str())
        .collect();
    assert_eq!(ids, ["2"]);
}

#[test]
fn a_steps_timing_says_elapsed_and_usual_time_including_an_expected_step() {
    let now = epoch_ms("2026-10-23T09:09:00Z").unwrap();
    let running = node(
        "review",
        json!({"state": "running", "started": "2026-10-23T09:00:00Z", "usual": 720000}),
    );
    assert_eq!(
        inspector::step_timing(&running, &[], now).as_deref(),
        Some("9 min so far, usually 12")
    );
    let next = node("next", json!({"usual": 120000}));
    assert_eq!(
        inspector::step_timing(&next, &[], now).as_deref(),
        Some("usually 2 min")
    );
    let said = node(
        "x",
        json!({"said": "Working · 9 min · Longer than usual", "long": true}),
    );
    assert_eq!(
        inspector::status_of(&said, Some("9 min so far")).as_deref(),
        Some("Working · 9 min so far")
    );
}

fn item(name: &str) -> EvidenceItem {
    EvidenceItem {
        name: name.into(),
        bytes: 10,
    }
}

#[test]
fn evidence_pairs_before_and_after_shots_and_sorts_videos_reports_and_files_apart() {
    let sorted = sort_evidence(&[
        item("home.after.png"),
        item("notes.txt"),
        item("run.mp4"),
        item("home.before.png"),
        item("report.html"),
        item("lonely.jpg"),
    ]);
    let gallery: Vec<(String, bool)> = sorted
        .gallery
        .iter()
        .map(|g| (g.key.clone(), g.before.is_some() && g.after.is_some()))
        .collect();
    assert_eq!(
        gallery,
        [("home.png".to_string(), true), ("lonely.jpg".into(), false)]
    );
    assert_eq!(sorted.videos, [item("run.mp4")]);
    assert_eq!(sorted.reports, [item("report.html")]);
    assert_eq!(sorted.files, [item("notes.txt")]);
}

#[test]
fn a_report_is_confined_first_in_its_head_before_its_own_scripts() {
    let html = confined("<html><head><script>x()</script></head><body></body></html>");
    let meta = html.find("Content-Security-Policy").unwrap();
    assert!(meta < html.find("<script>").unwrap(), "{html}");
    assert!(html.contains("default-src 'none'"));
    assert!(confined("<p>bare</p>").contains("Content-Security-Policy"));
}

#[test]
fn the_plan_counts_its_tickets_done() {
    let ticket = |done| Ticket {
        file: "01.md".into(),
        title: "One".into(),
        done,
        stamp: None,
    };
    assert_eq!(plan_progress(&[]), None);
    assert_eq!(
        plan_progress(&[ticket(true), ticket(false)]).as_deref(),
        Some("1 of 2 tickets done")
    );
}

fn live(name: &str, role: &str, status: &str) -> Agent {
    serde_json::from_value(
        json!({"name": name, "role": role, "status": status, "now": null, "run": "run-1"}),
    )
    .unwrap()
}

fn launched(names: &[&str]) -> Vec<DetailAgent> {
    names
        .iter()
        .map(|n| {
            serde_json::from_value(json!({"operation": "build", "agent": n, "harness": "claude"}))
                .unwrap()
        })
        .collect()
}

#[test]
fn a_pick_is_asked_for_over_the_agent_at_work_and_a_steps_agent_exactly_even_once_ended() {
    let agents = [
        live("plan-1", "planner", "idle"),
        live("impl-1", "implementer", "working"),
    ];
    let tabs = agent_tabs(&agents, None);
    assert_eq!(
        asked_for(&agents, "run-1", Some("plan-1")),
        Some(tabs[0].clone())
    );
    assert_eq!(asked_for(&agents, "run-1", None), Some(tabs[1].clone()));
    assert_eq!(asked_for(&agents[..1], "run-1", None), None);
    let ended = asked_for(&agents, "run-1", Some("ended-builder")).unwrap();
    assert_eq!(
        (ended.name.as_str(), ended.state.as_str()),
        ("ended-builder", "ended")
    );
}

#[test]
fn review_comments_go_to_the_agent_at_work_a_role_the_run_has_or_an_agent() {
    let live = [
        live("build-1", "implementer", "working"),
        live("review-1", "reviewer", "idle"),
    ];
    let choices = |protocol| -> Vec<String> {
        delivery_choices(&launched(&["build-1", "review-1"]), &live, protocol, None)
            .into_iter()
            .map(|c| c.key)
            .collect()
    };
    assert_eq!(
        choices(Some(4)),
        ["@work", "@builder", "@reviewer", "build-1", "review-1"]
    );
    assert_eq!(
        choices(Some(3)),
        ["review-1", "build-1"],
        "newest first by name alone"
    );
    assert_eq!(choices(None), ["review-1", "build-1"]);
    assert!(delivery_choices(&launched(&["gone"]), &live, Some(4), None).is_empty());
}

#[test]
fn a_merge_request_reference_is_read_from_a_target_a_url_or_owner_repo_number() {
    let at = |project: &str, iid: &str| {
        Some(MrRef {
            project: Some(project.into()),
            iid: iid.into(),
        })
    };
    assert_eq!(
        read_mr_ref("mr:gitlab.example.com/group/project!42"),
        at("gitlab.example.com/group/project", "42")
    );
    assert_eq!(
        read_mr_ref("mr:github.com/owner/repo#30"),
        at("github.com/owner/repo", "30")
    );
    assert_eq!(
        read_mr_ref("mr:github.com/owner/repo!30"),
        None,
        "GitHub's sign is #"
    );
    assert_eq!(
        read_mr_ref("mr:42"),
        Some(MrRef {
            project: None,
            iid: "42".into()
        })
    );
    assert_eq!(
        read_mr_ref("https://github.com/cego/web/pull/8/files"),
        at("github.com/cego/web", "8")
    );
    assert_eq!(
        read_mr_ref("https://gitlab.cego.dk/spilnu/api/-/merge_requests/7"),
        at("gitlab.cego.dk/spilnu/api", "7")
    );
    assert_eq!(read_mr_ref("cego/web#9"), at("github.com/cego/web", "9"));
    assert_eq!(read_mr_ref("not one"), None);
}
