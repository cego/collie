mod support;

use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::{App, record::artefacts::Preview};
use rune::Runtime;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::{flock_app, runtime, said, settle, tap_label};

const REPORT: &str = "# Socket diagnosis\n\nThe restart succeeded, but the login still fails.\n\n## Attempts\n\nRead the record. Retried the socket. Checked the login.\n\n```text\nECONNREFUSED\n```\n\n## Human next action\n\nRestore the login on vm.\n";

fn task(narratives: Value) -> Value {
    json!({"id":"t-parent", "name":"Recover the build", "project":"collie", "state":"blocked", "steps":[],
        "sentence":"Waiting for the login. Restore it on vm.", "age":"5m", "drift":null, "held":null, "heldBy":null,
        "decision":null, "agents":[], "children":[], "mr":null, "branch":null, "disposition":null, "landed":false,
        "ended":null, "mrState":null, "planReady":false, "offer":null, "run":"r-parent", "runs":["r-parent"], "at":1,
        "recovery":[REPORT.repeat(8), REPORT.repeat(8)], "narratives":narratives})
}

fn ready() -> Value {
    json!({"key":"recovery:park-1", "title":"Socket diagnosis", "summary":"Healed: escalated.",
        "blocker":"Login missing", "nextAction":"Restore the login on vm.", "state":"ready", "reason":null,
        "address":{"installation":"i-vm", "run":"r-helper", "id":"a-report", "revision":1, "step":"heal"},
        "at":null, "observedAt":"2026-11-13T12:00:00Z"})
}

fn opened(harness: &Harness<App>, narratives: Value) -> Runtime<App> {
    let mut app = flock_app(harness);
    app.apply(serde_json::from_value(json!({"machine":{"installation":"i-pc", "profile":"local", "name":"mk-pc"},
        "message":{"_tag":"Snapshot", "installation":"i-pc", "build":"0.118.0", "protocol":7, "files":true,
            "herds":[], "tasks":[task(narratives)], "seq":1}})).unwrap());
    runtime(app)
}

fn item() -> Value {
    json!({"installation":"i-vm", "run":"r-helper", "id":"a-report", "revision":1,
        "kind":"file", "role":"report", "title":"Socket diagnosis", "ref":"registered:/reports/heal.md", "source":"/reports/heal.md",
        "mediaType":"text/markdown", "size":REPORT.len(), "digest":format!("{:x}", Sha256::digest(REPORT.as_bytes())),
        "created":null, "updated":null, "registeredAt":"2026-11-13T12:00:00Z", "observedAt":"2026-11-13T12:00:00Z",
        "detectedAt":"2026-11-13T12:00:00Z", "seen":null, "sourceAvailability":"available", "retainedAvailability":"available", "reason":null})
}

fn detail() -> Value {
    json!({"id":"r-helper", "dir":"/runs/r-helper", "title":"Heal", "status":"complete", "inputs":[], "steps":[], "handoffs":[], "outputs":[],
        "review":{"_tag":"None", "reason":"no review"}, "attention":{"category":"none", "reason":"", "explanation":"", "actions":[]},
        "outcome":{"gaps":[], "metrics":{"verifications":{"pass":0,"fail":0,"unstable":0,"byCollie":0},"slices":{"done":0,"total":0},"rework":0,"halts":[],"obstacles":[]}},
        "finishedAt":0, "findings":[], "verifications":[], "steering":[], "evidence":[]})
}

fn retained(harness: &Harness<App>, runtime: &mut Runtime<App>) {
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail":detail(), "asOf":null, "bytes":100})),
    );
    settle(harness, runtime);
    harness
        .fake
        .answer("artefacts", Ok(json!({"items":[item()]})));
    settle(harness, runtime);
}

#[test]
fn a_concise_card_opens_the_helpers_actual_markdown_and_returns_to_the_same_task() {
    use base64::Engine;
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness, json!([ready()]));
    assert!(said(&runtime, "Login missing"));
    assert!(said(&runtime, "Restore the login on vm."));
    assert!(
        !runtime
            .accessibility_json()
            .to_string()
            .contains("ECONNREFUSED")
    );
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    let mut at = 100.0;
    tap_label(&mut runtime, "Open report: Socket diagnosis", &mut at);
    assert_eq!(
        harness.fake.asked_of("runDetail"),
        [json!({"installation":"i-vm", "runId":"r-helper"})]
    );
    retained(&harness, &mut runtime);
    assert_eq!(
        harness.fake.asked_of("artefactRead"),
        [
            json!({"installation":"i-vm", "runId":"r-helper", "id":"a-report", "revision":1, "offset":0})
        ]
    );
    harness.fake.answer("artefactRead", Ok(json!({"ref":"artefact:a-report:1", "encoding":"base64", "size":REPORT.len(), "content":base64::engine::general_purpose::STANDARD.encode(REPORT)})));
    let until = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        settle(&harness, &mut runtime);
        if let Some(Preview::Failed(why)) = &runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview
        {
            panic!("{why}");
        }
        if matches!(
            runtime
                .state
                .record
                .open
                .as_ref()
                .unwrap()
                .artefacts
                .preview,
            Some(Preview::Text { .. })
        ) {
            break;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::park_timeout(std::time::Duration::from_millis(1));
    }
    let Some(Preview::Text {
        text,
        markdown,
        truncated,
    }) = &runtime
        .state
        .record
        .open
        .as_ref()
        .unwrap()
        .artefacts
        .preview
    else {
        panic!("readable Markdown")
    };
    assert_eq!(text, REPORT);
    assert!(*markdown && !truncated);
    runtime.frame(at);
    assert!(said(&runtime, "Socket diagnosis"));
    assert!(said(&runtime, "ECONNREFUSED"));
    runtime.update(|app, _| app.back());
    runtime.frame(at + 200.0);
    assert!(runtime.state.record.open.is_none());
    assert!(said(&runtime, "Recover the build"));
}

#[test]
fn failed_preparation_keeps_the_blocker_and_legacy_reader_with_an_explicit_retry() {
    let harness = Harness::<App>::new();
    let mut failed = ready();
    failed["state"] = json!("failed");
    failed["reason"] = json!("Retained copy denied");
    failed["origin"] = json!({"installation":"i-vm", "run":"r-helper", "step":"heal"});
    failed.as_object_mut().unwrap().remove("address");
    let mut runtime = opened(&harness, json!([failed]));
    assert!(said(&runtime, "Login missing"));
    assert!(said(&runtime, "Restore the login on vm."));
    assert!(said(&runtime, "Retained copy denied"));
    assert!(!said(&runtime, "Open report"));
    assert!(
        !runtime
            .accessibility_json()
            .to_string()
            .contains("ECONNREFUSED")
    );
    let mut at = 100.0;
    tap_label(&mut runtime, "Retry report preparation", &mut at);
    assert_eq!(
        harness.fake.asked_of("artefacts"),
        [json!({"installation":"i-vm", "runId":"r-helper", "refresh":true})]
    );
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
}

#[test]
fn a_failed_read_is_unseen_and_retry_reads_again_without_reopening_the_card() {
    use collie_desktop_board::calls::CallError;
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness, json!([ready()]));
    let mut at = 100.0;
    tap_label(&mut runtime, "Open report: Socket diagnosis", &mut at);
    retained(&harness, &mut runtime);
    harness.fake.answer(
        "artefactRead",
        Err(CallError("The owner is offline".into())),
    );
    settle(&harness, &mut runtime);
    runtime.frame(at);
    assert!(said(&runtime, "The owner is offline"));
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    tap_label(&mut runtime, "Retry report", &mut at);
    assert_eq!(harness.fake.asked_of("artefactRead").len(), 2);
}

#[test]
fn an_older_report_reference_reads_its_selected_revision_before_following_a_later_publication() {
    let harness = Harness::<App>::new();
    let mut reference = ready();
    reference["address"]["digest"] = item()["digest"].clone();
    reference["address"]["size"] = json!(REPORT.len());
    let mut runtime = opened(&harness, json!([reference]));
    let mut at = 100.0;
    tap_label(&mut runtime, "Open report: Socket diagnosis", &mut at);
    let mut latest = item();
    latest["revision"] = json!(2);
    latest["size"] = json!(14);
    latest["digest"] = json!(format!("{:x}", Sha256::digest(b"# New report\n\n")));
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail":detail(),"asOf":null,"bytes":100})),
    );
    settle(&harness, &mut runtime);
    harness
        .fake
        .answer("artefacts", Ok(json!({"items":[latest.clone()]})));
    settle(&harness, &mut runtime);
    assert_eq!(harness.fake.asked_of("artefactRead")[0]["revision"], 1);
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail":detail(),"asOf":null,"bytes":101})),
    );
    settle(&harness, &mut runtime);
    harness
        .fake
        .answer("artefacts", Ok(json!({"items":[latest]})));
    settle(&harness, &mut runtime);
    assert_eq!(harness.fake.asked_of("artefactRead")[1]["revision"], 2);
    harness.fake.answer(
        "artefactRead",
        Err(collie_desktop_board::calls::CallError(
            "old callback".into(),
        )),
    );
    settle(&harness, &mut runtime);
    assert!(matches!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview,
        Some(Preview::Loading)
    ));
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
}

#[test]
#[ignore = "test/heal.test.ts supplies the accepted producer and public-host fixture"]
fn accepted_producer_fixture() {
    use base64::Engine;
    let path = std::env::var("COLLIE_REPORT_FIXTURE").expect("the public-host fixture path");
    let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let snapshot = &fixture["snapshot"];
    let parent = fixture["parent"].as_str().unwrap();
    let task = snapshot["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| {
            task["run"] == parent
                || task["runs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|run| run == parent)
        })
        .expect("the affected Task");
    let name = task["name"].as_str().unwrap().to_string();
    let report = task["narratives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|report| report["address"]["id"] == fixture["item"]["id"])
        .expect("the actual registered helper report");
    let address = report["address"].clone();
    assert_eq!(report["state"], "ready");
    assert_eq!(report["nextAction"], fixture["next"]);
    let harness = Harness::<App>::new();
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.apply(serde_json::from_value(json!({"machine":{"installation":snapshot["installation"], "profile":"local", "name":"Owning Machine"}, "message":snapshot})).unwrap());
    let mut runtime = runtime(app);
    assert!(
        !runtime
            .accessibility_json()
            .to_string()
            .contains(fixture["diagnosis"].as_str().unwrap())
    );
    let mut at = 100.0;
    tap_label(
        &mut runtime,
        &format!("Open report: {}", report["title"].as_str().unwrap()),
        &mut at,
    );
    assert_eq!(
        harness.fake.asked_of("runDetail")[0],
        json!({"installation":address["installation"], "runId":address["run"]})
    );
    harness
        .fake
        .push("runDetail", Ok(fixture["detail"].clone()));
    settle(&harness, &mut runtime);
    harness
        .fake
        .answer("artefacts", Ok(json!({"items":[fixture["item"]]})));
    settle(&harness, &mut runtime);
    assert_eq!(
        harness.fake.asked_of("artefactRead")[0],
        json!({"installation":address["installation"], "runId":address["run"], "id":address["id"], "revision":address["revision"], "offset":0})
    );
    let body = fixture["body"].as_str().unwrap();
    harness.fake.answer("artefactRead", Ok(json!({"ref":format!("artefact:{}:{}", address["id"].as_str().unwrap(), address["revision"]), "encoding":"base64", "size":body.len(), "content":base64::engine::general_purpose::STANDARD.encode(body)})));
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        settle(&harness, &mut runtime);
        match &runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview
        {
            Some(Preview::Text {
                text,
                markdown,
                truncated,
            }) => {
                assert!(*markdown && !truncated);
                for field in ["diagnosis", "action", "next"] {
                    assert!(text.contains(fixture[field].as_str().unwrap()));
                }
                assert_eq!(text, body);
                break;
            }
            Some(Preview::Failed(why)) => panic!("{why}"),
            _ => {}
        }
        assert!(
            std::time::Instant::now() < until,
            "the native reader did not receive the retained report"
        );
        std::thread::park_timeout(std::time::Duration::from_millis(1));
    }
    runtime.frame(at);
    assert!(said(&runtime, "ECONNREFUSED"));
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    collie_desktop_board::record::artefacts::frame_drawn(&runtime);
    let seen = harness.fake.asked_of("artefactSeen");
    assert_eq!(seen[0]["id"], address["id"]);
    assert_eq!(seen[0]["revision"], address["revision"]);
    runtime.update(|app, _| app.back());
    runtime.frame(at + 200.0);
    assert!(said(&runtime, &name));
}
