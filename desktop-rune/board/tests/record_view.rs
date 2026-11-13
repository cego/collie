//! An open Run's record drawn from the test Flock with a fake core: `runDetail` streamed in,
//! items read from `runFile` in parts, and every gesture sent on `act` exactly as the host
//! takes it. Ports the record's cases of `test/desktop-record-door.test.ts`,
//! `desktop-deliver.test.ts`, `desktop-retry.test.ts` and `desktop/test/diff-comments.test.ts`.

use base64::Engine;
use collie_desktop_board::calls::CallError;
use collie_desktop_board::calls::testing::Harness;
use collie_desktop_board::record::review::compose;
use collie_desktop_board::{App, view};
use collie_desktop_terminal::view::Tab;
use rune::edit::TextEdit;
use rune::{Env, Runtime, WheelEvent};
use rune_kit::diff::{LineRange, LineRef, Side};
use serde_json::{Value, json};

const FLOCK: &str = include_str!("../../fixtures/flock.ndjson");

#[test]
fn artefacts_are_a_native_record_tab_with_a_named_refresh_control() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| app.open_card("inst-build:b2"));
    harness.fake.push("runDetail", Ok(detail(json!({}))));
    settle(&mut runtime, &harness, 100.0);
    assert!(keys(&runtime).contains(&"tab-artefacts".to_string()));
    runtime.update(|app, _| app.show_tab("artefacts"));
    harness.fake.answer("artefacts", Ok(json!({"items": []})));
    settle(&mut runtime, &harness, 200.0);
    assert!(keys(&runtime).contains(&"artefacts-refresh".to_string()));
}

#[test]
fn a_file_callback_from_a_closed_record_cannot_fill_the_same_runs_reopened_record() {
    let harness = Harness::<App>::new();
    let mut app = App::default();
    app.core = Some(harness.core.clone());
    app.open_record("i1".into(), "r1".into(), "Local".into(), Some("evidence"));
    app.read_item("handoff:note.txt");
    app.back();
    app.open_record("i1".into(), "r1".into(), "Local".into(), Some("evidence"));
    app.read_item("handoff:note.txt");
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref":"handoff:note.txt", "encoding":"utf8", "content":"stale", "size":5})),
    );
    harness.settle(&mut app);
    assert!(matches!(
        app.record
            .open
            .as_ref()
            .unwrap()
            .items
            .get("handoff:note.txt"),
        Some(collie_desktop_board::record::Item::Reading)
    ));
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref":"handoff:note.txt", "encoding":"utf8", "content":"fresh", "size":5})),
    );
    harness.settle(&mut app);
    assert_eq!(
        app.record
            .open
            .as_ref()
            .unwrap()
            .items
            .get("handoff:note.txt")
            .unwrap()
            .text()
            .as_deref(),
        Some("fresh")
    );
}

fn artefact(id: &str, title: &str, media: &str, bytes: &[u8], revision: i64) -> Value {
    use sha2::Digest;
    json!({"id":id, "run":"r1", "kind":"file", "role":"handoff", "title":title,
        "ref":format!("handoff:{title}"), "source":format!("/runs/r1/handoffs/{title}"),
        "mediaType":media, "size":bytes.len(), "revision":revision, "digest":format!("{:x}", sha2::Sha256::digest(bytes)),
        "created":null, "updated":null, "registeredAt":"2026-01-01T00:00:00Z", "observedAt":"2026-11-01T00:00:00Z",
        "detectedAt":"2026-11-01T00:00:00Z", "seen":null, "sourceAvailability":"available", "retainedAvailability":"available", "reason":null})
}

fn collection(runtime: &mut Runtime<App>, harness: &Harness<App>, items: Vec<Value>) {
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("artefacts"),
        )
    });
    harness.fake.push("runDetail", Ok(detail(json!({}))));
    settle(runtime, harness, 100.0);
    harness.fake.answer("artefacts", Ok(json!({"items":items})));
    settle(runtime, harness, 200.0);
}

fn selected_bytes(runtime: &mut Runtime<App>, harness: &Harness<App>, id: &str, bytes: &[u8]) {
    runtime.update(|app, _| app.select_artefact(id));
    harness.fake.answer("artefactRead", Ok(json!({"ref":format!("artefact:{id}:1"),"encoding":"base64","size":bytes.len(),"content":base64::engine::general_purpose::STANDARD.encode(bytes)})));
    harness.settle(&mut runtime.state);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        harness.settle(&mut runtime.state);
        if !matches!(
            runtime
                .state
                .record
                .open
                .as_ref()
                .unwrap()
                .artefacts
                .preview,
            Some(collie_desktop_board::record::artefacts::Preview::Loading)
        ) {
            break;
        }
        assert!(
            std::time::Instant::now() < until,
            "preview worker did not finish"
        );
        std::thread::park_timeout(std::time::Duration::from_millis(1));
    }
    runtime.update(|_, _| {});
    runtime.frame(300.0);
}

#[test]
fn returning_to_the_artefacts_tab_reloads_paused_and_drops_the_hidden_preview_callback() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(
        &mut runtime,
        &harness,
        vec![artefact("a1", "note.txt", "text/plain", b"note", 1)],
    );
    runtime.update(|app, _| app.select_artefact("a1"));
    runtime.update(|app, _| app.show_tab("evidence"));
    harness.fake.answer(
        "artefactRead",
        Ok(json!({"ref":"artefact:a1:1","encoding":"base64","size":4,"content":"bm90ZQ=="})),
    );
    harness.settle(&mut runtime.state);
    assert!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview
            .is_none()
    );
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    runtime.update(|app, _| app.show_tab("artefacts"));
    assert_eq!(harness.fake.asked_of("artefactRead").len(), 2);
}

#[test]
fn selected_native_previews_render_their_content_and_refuse_unverified_bytes() {
    use collie_desktop_board::record::artefacts::{Preview, frame_drawn};
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let md = b"# Ticket\n\n- First item\n\n[Guide](https://example.com/guide)\n";
    let plain = b"first\n  second\n";
    let image = include_bytes!("../../../assets/brand/logos/collie-tile-256.png");
    let corrupt = b"not an image";
    let binary = b"\x00\xff\x80";
    collection(
        &mut runtime,
        &harness,
        vec![
            artefact("md", "ticket.md", "text/markdown", md, 1),
            artefact("text", "note.txt", "text/plain", plain, 1),
            artefact("image", "shot.png", "image/png", image, 1),
            artefact("corrupt", "bad.png", "image/png", corrupt, 1),
            artefact(
                "binary",
                "archive.bin",
                "application/octet-stream",
                binary,
                1,
            ),
            artefact("empty", "empty.txt", "text/plain", b"", 1),
            artefact("wrong", "changed.txt", "text/plain", b"right", 1),
        ],
    );
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    selected_bytes(&mut runtime, &harness, "md", md);
    let tree = runtime.accessibility_json();
    assert!(within(&tree).iter().any(|n| n["name"] == "Ticket"));
    assert!(within(&tree).iter().any(|n| n["name"] == "Guide"));
    frame_drawn(&runtime);
    assert_eq!(harness.fake.asked_of("artefactSeen")[0]["revision"], 1);
    selected_bytes(&mut runtime, &harness, "text", plain);
    assert!(
        within(&runtime.accessibility_json())
            .iter()
            .any(|n| n["name"] == "first\n  second\n")
    );
    selected_bytes(&mut runtime, &harness, "image", image);
    assert!(matches!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview,
        Some(Preview::Image(_))
    ));
    selected_bytes(&mut runtime, &harness, "corrupt", corrupt);
    assert!(matches!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview,
        Some(Preview::Failed(_))
    ));
    let seen = harness.fake.asked_of("artefactSeen").len();
    frame_drawn(&runtime);
    assert_eq!(harness.fake.asked_of("artefactSeen").len(), seen);
    selected_bytes(&mut runtime, &harness, "binary", binary);
    assert!(matches!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview,
        Some(Preview::Unsupported)
    ));
    selected_bytes(&mut runtime, &harness, "empty", b"");
    assert!(
        runtime
            .accessibility_json()
            .to_string()
            .contains("This file is empty.")
    );
    selected_bytes(&mut runtime, &harness, "wrong", b"wrong");
    assert!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .bytes
            .is_none(),
        "unverified bytes must not be offered to Open or Save"
    );
}

#[test]
fn an_updated_selection_and_a_reopened_record_drop_old_artefact_reads() {
    use collie_desktop_board::record::artefacts::Preview;
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(
        &mut runtime,
        &harness,
        vec![artefact("a1", "note.txt", "text/plain", b"old", 1)],
    );
    runtime.update(|app, _| app.select_artefact("a1"));
    runtime.update(|app, _| app.read_artefacts(true));
    harness.fake.answer(
        "artefacts",
        Ok(json!({"items":[artefact("a1", "note.txt", "text/plain", b"new", 2)]})),
    );
    harness.settle(&mut runtime.state);
    assert_eq!(
        harness.fake.asked_of("artefactRead").last().unwrap()["revision"],
        2
    );
    harness.fake.answer(
        "artefactRead",
        Ok(json!({"ref":"artefact:a1:1", "encoding":"base64", "size":3, "content":"b2xk"})),
    );
    harness.settle(&mut runtime.state);
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
    runtime.update(|app, _| app.back());
    collection(
        &mut runtime,
        &harness,
        vec![artefact("a1", "note.txt", "text/plain", b"newer", 3)],
    );
    runtime.update(|app, _| app.select_artefact("a1"));
    harness.fake.answer(
        "artefactRead",
        Ok(json!({"ref":"artefact:a1:2", "encoding":"base64", "size":3, "content":"bmV3"})),
    );
    harness.settle(&mut runtime.state);
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
fn long_text_exposes_its_limit_and_failed_open_and_save_leave_binary_material_unseen() {
    use collie_desktop_board::record::artefacts::{Preview, frame_drawn};
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let long = vec![b'x'; 300 * 1024];
    let mut report = artefact("long-report", "diagnosis.md", "text/markdown", &long, 1);
    report["role"] = json!("report");
    let bytes = b"\x00\xff\x80";
    collection(
        &mut runtime,
        &harness,
        vec![
            artefact("long", "output.log", "text/plain", &long, 1),
            artefact("binary", "file.bin", "application/octet-stream", bytes, 1),
            report,
        ],
    );
    selected_bytes(&mut runtime, &harness, "long", &long);
    let record = runtime.state.record.open.as_ref().unwrap();
    assert!(
        matches!(&record.artefacts.preview, Some(Preview::Text { text, truncated: true, .. }) if text.len() == 256 * 1024)
    );
    assert_eq!(record.artefacts.bytes.as_ref().unwrap().len(), long.len());
    assert!(
        runtime
            .accessibility_json()
            .to_string()
            .contains("Preview truncated")
    );
    selected_bytes(&mut runtime, &harness, "long-report", &long);
    assert!(
        matches!(&runtime.state.record.open.as_ref().unwrap().artefacts.preview,
        Some(Preview::Text {text, markdown:true, truncated:false}) if text.len() == long.len())
    );
    selected_bytes(&mut runtime, &harness, "binary", bytes);
    harness
        .fake
        .will_answer("openLink", Err(CallError("the opener was refused".into())));
    runtime.update(|app, _| app.open_artefact());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !runtime
        .state
        .record
        .notice
        .as_ref()
        .is_some_and(|n| n.failed)
    {
        harness.settle(&mut runtime.state);
        assert!(std::time::Instant::now() < deadline);
        std::thread::park_timeout(std::time::Duration::from_millis(1));
    }
    assert!(
        runtime
            .state
            .record
            .notice
            .as_ref()
            .unwrap()
            .said
            .contains("opener was refused")
    );
    runtime.update(|app, tx| app.save_artefact(tx));
    runtime
        .resolve_file_dialog(Some(std::env::temp_dir()))
        .unwrap();
    runtime.frame(400.0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while runtime
        .state
        .record
        .open
        .as_ref()
        .unwrap()
        .artefacts
        .failed
        .is_none()
    {
        harness.settle(&mut runtime.state);
        assert!(std::time::Instant::now() < deadline);
        std::thread::park_timeout(std::time::Duration::from_millis(1));
    }
    assert!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .failed
            .as_ref()
            .unwrap()
            .contains("Save failed")
    );
    runtime.update(|_, _| {});
    runtime.frame(500.0);
    assert!(
        runtime
            .accessibility_json()
            .to_string()
            .contains("Save failed")
    );
    frame_drawn(&runtime);
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
}

#[test]
fn native_video_controls_name_their_actions_and_loading_a_decoder_does_not_acknowledge_a_revision()
{
    use collie_desktop_board::record::artefacts::{Preview, frame_drawn};
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let clip = include_bytes!("../../fixtures/artefact-video.mp4");
    collection(
        &mut runtime,
        &harness,
        vec![artefact("clip", "record.mp4", "video/mp4", clip, 1)],
    );
    selected_bytes(&mut runtime, &harness, "clip", clip);
    for (key, label) in [
        ("artefact-play", "Play"),
        ("artefact-seek-back", "Seek back 5 seconds"),
        ("artefact-seek-forward", "Seek forward 5 seconds"),
        ("artefact-mute", "Mute"),
    ] {
        let control = named(&runtime, key);
        assert_eq!(control["role"], "button");
        assert_eq!(control["name"], label);
    }
    assert_eq!(named(&runtime, "artefact-time")["role"], "status");
    assert!(
        matches!(&runtime.state.record.open.as_ref().unwrap().artefacts.preview, Some(Preview::Video(player)) if !player.state().playing)
    );
    frame_drawn(&runtime);
    assert!(
        harness.fake.asked_of("artefactSeen").is_empty(),
        "metadata and layout alone present no decoded frame"
    );
    runtime.update(|app, _| app.show_tab("summary"));
    assert!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview
            .is_none()
    );
}

#[test]
fn an_older_host_keeps_legacy_record_tabs_and_explains_the_catalogue_upgrade() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("artefacts"),
        )
    });
    harness.fake.push("runDetail", Ok(detail(json!({}))));
    settle(&mut runtime, &harness, 100.0);
    harness.fake.answer(
        "artefacts",
        Err(CallError(
            "Upgrade this Machine's Collie host to use Artefacts".into(),
        )),
    );
    settle(&mut runtime, &harness, 200.0);
    assert!(
        runtime
            .accessibility_json()
            .to_string()
            .contains("Upgrade this Machine")
    );
    runtime.update(|app, _| app.show_tab("summary"));
    runtime.frame(300.0);
    assert!(keys(&runtime).contains(&"tab-summary".into()));
    assert!(keys(&runtime).contains(&"tab-evidence".into()));
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
}

#[test]
fn picker_import_is_fenced_by_the_record_opening_and_transfer_failure_never_marks_seen() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(&mut runtime, &harness, vec![]);
    runtime.update(|app, tx| app.pick_artefact(tx));
    runtime
        .resolve_file_dialog(Some(std::path::PathBuf::from("/local/report.md")))
        .unwrap();
    runtime.frame(250.0);
    let asked = &harness.fake.asked_of("artefactImport")[0];
    assert_eq!(asked["installation"], "inst-build");
    assert_eq!(asked["runId"], "r1");
    assert_eq!(asked["path"], "/local/report.md");
    harness
        .fake
        .answer("artefactImport", Err(CallError("Transfer failed".into())));
    settle(&mut runtime, &harness, 300.0);
    assert!(
        runtime
            .accessibility_json()
            .to_string()
            .contains("Transfer failed")
    );
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    runtime.update(|app, tx| app.pick_artefact(tx));
    runtime.update(|app, _| {
        app.back();
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("artefacts"),
        );
    });
    let before = harness.fake.asked_of("artefactImport").len();
    runtime
        .resolve_file_dialog(Some(std::path::PathBuf::from("/local/stale.md")))
        .unwrap();
    runtime.frame(400.0);
    assert_eq!(harness.fake.asked_of("artefactImport").len(), before);
}

#[test]
fn a_machine_path_registers_on_the_runs_machine_and_rereads_the_collection() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(&mut runtime, &harness, vec![]);
    let reads = harness.fake.asked_of("artefacts").len();
    runtime.update(|app, _| {
        app.record.open.as_mut().unwrap().artefacts.path = TextEdit::new("  /srv/out/report.md ");
        app.register_artefact_path();
    });
    settle(&mut runtime, &harness, 300.0);
    let asked = &harness.fake.asked_of("artefactRegister")[0];
    assert_eq!(asked["installation"], "inst-build");
    assert_eq!(asked["runId"], "r1");
    assert_eq!(asked["path"], "/srv/out/report.md");
    let item = artefact("a9", "report.md", "text/markdown", b"# Out", 1);
    harness.fake.answer(
        "artefactRegister",
        Ok(json!({"address":{"installation":"inst-build","run":"r1","id":"a9"},"item":item,"retained":{"revision":1,"digest":"d","size":5}})),
    );
    settle(&mut runtime, &harness, 400.0);
    assert_eq!(harness.fake.asked_of("artefacts").len(), reads + 1);
    assert!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .path
            .text
            .is_empty()
    );
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
}

#[test]
fn an_overdue_tracked_source_reads_as_stale_and_pending_not_current() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let mut item = artefact("a1", "tracked.txt", "text/plain", b"AAA", 2);
    item["tracking"] = json!("local");
    item["stale"] = json!(true);
    item["pending"] = json!(true);
    let mut copy = artefact("a2", "copy.txt", "text/plain", b"BBB", 1);
    copy["tracking"] = json!("snapshot");
    collection(&mut runtime, &harness, vec![item, copy]);
    let tree = runtime.accessibility_json().to_string();
    assert!(tree.contains("tracked.txt · handoff · Unseen · stale, refresh pending"));
    assert!(tree.contains("copy.txt · handoff · Unseen · retained snapshot"));
}

#[test]
fn transferred_bytes_that_do_not_match_the_revision_digest_are_refused_and_never_seen() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(
        &mut runtime,
        &harness,
        vec![artefact("a1", "note.txt", "text/plain", b"good", 1)],
    );
    selected_bytes(&mut runtime, &harness, "a1", b"evil");
    let tree = runtime.accessibility_json().to_string();
    assert!(tree.contains("does not match this revision"));
    assert!(!tree.contains("evil"));
    runtime.frame(600.0);
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
}

#[test]
fn an_unreachable_owner_keeps_the_cached_collection_and_says_why() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(
        &mut runtime,
        &harness,
        vec![artefact("a1", "note.txt", "text/plain", b"good", 1)],
    );
    runtime.update(|app, _| app.read_artefacts(true));
    settle(&mut runtime, &harness, 300.0);
    let asked = harness.fake.asked_of("artefacts");
    assert_eq!(asked.last().unwrap()["installation"], "inst-build");
    harness.fake.answer(
        "artefacts",
        Err(CallError("Build box is unreachable".into())),
    );
    settle(&mut runtime, &harness, 400.0);
    let tree = runtime.accessibility_json().to_string();
    assert!(tree.contains("Build box is unreachable"));
    assert!(tree.contains("note.txt · handoff · Unseen"));
    assert!(harness.fake.asked_of("artefactImport").is_empty());
    assert!(harness.fake.asked_of("artefactRegister").is_empty());
}

fn link(id: &str, kind: &str, title: &str, url: &str) -> Value {
    json!({"id":id, "run":"r1", "kind":kind, "role":"deliverable", "title":title,
        "ref":format!("url:{url}"), "source":url, "url":url, "mediaType":"", "size":0, "revision":2, "digest":"",
        "created":null, "updated":null, "registeredAt":"2026-01-01T00:00:00Z", "observedAt":"2026-11-01T00:00:00Z",
        "detectedAt":"2026-11-01T00:00:00Z", "seen":null, "sourceAvailability":"untracked", "retainedAvailability":"none", "reason":null})
}

#[test]
fn a_link_shows_its_destination_and_opens_the_registered_url_without_reading_or_acknowledging_it() {
    use collie_desktop_board::record::artefacts::frame_drawn;
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let url = "https://claude.ai/code/artifact/0b8c";
    let mut item = link("l1", "acme.dev/diagram", "Design notes", url);
    item["provider"] = json!({"name":"claude", "namespace":"org-1", "resource":"0b8c", "version":"3",
        "provenance":"caller-reported", "observedAt":"2026-11-01T00:00:00Z"});
    item["metadata"] = json!({"layers":[{"name":"<script>alert(1)</script>"}]});
    collection(&mut runtime, &harness, vec![item]);
    runtime.update(|app, _| app.select_artefact("l1"));
    settle(&mut runtime, &harness, 300.0);
    assert!(harness.fake.asked_of("artefactRead").is_empty());
    let tree = runtime.accessibility_json().to_string();
    for shown in [
        "Design notes",
        url,
        "acme.dev/diagram · claude 0b8c · version 3 (caller-reported)",
        "External updates not tracked",
        "Created: Unknown",
        "<script>alert(1)</script>",
    ] {
        assert!(tree.contains(shown), "{shown} missing from {tree}");
    }
    let open = named(&runtime, "artefact-browser");
    assert_eq!(open["role"], "button");
    assert_eq!(open["name"], "Open in browser");
    harness
        .fake
        .will_answer("openLink", Err(CallError("no browser".into())));
    tap(&mut runtime, "artefact-browser", 400.0);
    settle(&mut runtime, &harness, 600.0);
    assert_eq!(harness.fake.asked_of("openLink")[0]["url"], url);
    assert!(
        runtime
            .accessibility_json()
            .to_string()
            .contains("no browser")
    );
    frame_drawn(&runtime);
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    tap(&mut runtime, "artefact-seen", 700.0);
    assert_eq!(harness.fake.asked_of("artefactSeen")[0]["revision"], 2);
}

#[test]
fn a_links_export_uses_the_file_presentation_and_never_acknowledges_the_hosted_observation() {
    use collie_desktop_board::record::artefacts::{Preview, frame_drawn};
    use sha2::Digest;
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    let md = b"# Exported\n";
    let clip = include_bytes!("../../fixtures/artefact-video.mp4");
    let exported = |id: &str, title: &str, media: &str, bytes: &[u8]| {
        let mut item = link(
            id,
            "claude-artefact",
            title,
            "https://claude.ai/code/artifact/x",
        );
        item["mediaType"] = json!(media);
        item["size"] = json!(bytes.len());
        item["revision"] = json!(1);
        item["digest"] = json!(format!("{:x}", sha2::Sha256::digest(bytes)));
        item["retainedAvailability"] = json!("available");
        item["export"] = json!({"source":"/srv/export", "availability":"available"});
        item
    };
    collection(
        &mut runtime,
        &harness,
        vec![
            exported("md", "notes.md", "text/markdown", md),
            exported("clip", "demo.mp4", "video/mp4", clip),
        ],
    );
    selected_bytes(&mut runtime, &harness, "md", md);
    assert!(
        within(&runtime.accessibility_json())
            .iter()
            .any(|n| n["name"] == "Exported")
    );
    assert_eq!(
        named(&runtime, "artefact-browser")["name"],
        "Open in browser"
    );
    frame_drawn(&runtime);
    assert!(harness.fake.asked_of("artefactSeen").is_empty());
    selected_bytes(&mut runtime, &harness, "clip", clip);
    assert!(matches!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .preview,
        Some(Preview::Video(_))
    ));
}

#[test]
fn a_link_url_is_registered_from_its_own_named_field() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    collection(&mut runtime, &harness, vec![]);
    let field = named(&runtime, "artefact-url");
    assert!(
        within(&field)
            .iter()
            .any(|n| n["name"] == "URL to register"
                && n["actions"].to_string().contains("set-value"))
    );
    assert_eq!(
        named(&runtime, "artefact-register-url")["name"],
        "Register link"
    );
    runtime.update(|app, _| {
        app.record.open.as_mut().unwrap().artefacts.url =
            TextEdit::new(" https://example.com/report ");
        app.register_artefact_url();
    });
    settle(&mut runtime, &harness, 300.0);
    let asked = &harness.fake.asked_of("artefactRegister")[0];
    assert_eq!(asked["url"], "https://example.com/report");
    assert!(asked.get("path").is_none());
    assert!(
        runtime
            .state
            .record
            .open
            .as_ref()
            .unwrap()
            .artefacts
            .url
            .text
            .is_empty()
    );
}

fn within(node: &Value) -> Vec<&Value> {
    let mut found = vec![node];
    for child in node["children"].as_array().into_iter().flatten() {
        found.extend(within(child));
    }
    found
}

fn keys(runtime: &Runtime<App>) -> Vec<String> {
    within(&runtime.accessibility_json())
        .iter()
        .filter_map(|node| node["key"].as_str().map(String::from))
        .collect()
}

fn named(runtime: &Runtime<App>, key: &str) -> Value {
    within(&runtime.accessibility_json())
        .into_iter()
        .find(|node| node["key"] == key)
        .cloned()
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)))
}

fn tap(runtime: &mut Runtime<App>, key: &str, at: f64) {
    let (x, y) = runtime
        .find(key)
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)));
    runtime.pointer_move(x, y);
    runtime.frame(at);
    runtime.pointer_down(x, y);
    runtime.frame(at + 50.0);
    runtime.pointer_up(x, y);
    runtime.frame(at + 100.0);
}

fn opened(harness: &Harness<App>) -> Runtime<App> {
    let mut app = App::default();
    for line in FLOCK.lines() {
        app.apply(serde_json::from_str(line).unwrap());
    }
    app.core = Some(harness.core.clone());
    app.go_to = Some(Box::new(|_, machine, _| Tab::new(None, machine, 100, 30)));
    let mut runtime = Runtime::new(
        app,
        view,
        (1400.0, 900.0),
        Env {
            system_dark: true,
            scale: 1.0,
        },
    );
    runtime.frame(0.0);
    runtime
}

fn settle(runtime: &mut Runtime<App>, harness: &Harness<App>, at: f64) {
    harness.settle(&mut runtime.state);
    // Rune draws again only for a change it is told of.
    runtime.update(|_, _| {});
    runtime.frame(at);
}

fn detail(extra: Value) -> Value {
    let mut base = json!({
        "id": "r1", "dir": "/runs/r1", "title": "Build it", "status": "running",
        "revision": {"epoch": "e1", "seq": 7.0},
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
    json!({"detail": base, "asOf": null, "bytes": 100})
}

const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n fn a() {}\n-old\n+new\n";

fn with_diff() -> Value {
    detail(json!({
        "diff": {"base": "abc", "live": true, "files": [{"path": "src/a.rs", "status": "modified", "added": 1, "removed": 1}]},
        "agents": [{"operation": "build", "agent": "build-1", "harness": "claude"}]
    }))
}

#[test]
fn facts_list_each_offer_with_its_owner_and_refusal_even_while_details_are_loading() {
    for run in ["r1", "r-app", "r-api"] {
        let harness = Harness::<App>::new();
        let mut runtime = opened(&harness);
        runtime.update(|app, _| {
            let task = app
                .machines
                .iter_mut()
                .filter(|machine| machine.machine.installation == "inst-build")
                .flat_map(|machine| &mut machine.cards)
                .find(|task| task.run == "r1")
                .unwrap();
            task.children = serde_json::from_value(json!([
                {"repo": "app", "run": "r-app", "state": "done", "mr": null},
                {"repo": "api", "run": "r-api", "state": "done", "mr": null}
            ]))
            .unwrap();
            task.offers = serde_json::from_value(json!([
                {"id": "release", "title": "Release app!12", "run": "r-app"},
                {"id": "stage", "title": "Stage api!7", "run": "r-api",
                    "unavailable": "a Stage is still going"}
            ]))
            .unwrap();
            app.open_record("inst-build".into(), run.into(), "Build box".into(), None);
        });
        runtime.frame(100.0);
        tap(&mut runtime, "tab-facts", 200.0);
        for reading in [true, false] {
            if !reading {
                harness
                    .fake
                    .push("runDetail", Ok(detail(json!({"id": run}))));
                settle(&mut runtime, &harness, 1000.0);
            }
            let offers = named(&runtime, "facts-offers");
            let names: Vec<&str> = within(&offers)
                .into_iter()
                .filter_map(|node| node["name"].as_str())
                .collect();
            for expected in [
                "Release app!12",
                "r-app",
                "Stage api!7",
                "r-api — a Stage is still going",
            ] {
                assert!(names.contains(&expected), "missing {expected} in {names:?}");
            }
        }
    }
}

#[test]
fn a_card_opens_its_runs_record_on_its_first_tab_never_its_terminal_streaming_until_back() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    // Build box's board is a saved one, so its card opens by name, not by a double press.
    runtime.update(|app, _| app.open_card("inst-build:b2"));
    runtime.frame(100.0);
    assert_eq!(
        harness.fake.asked_of("runDetail"),
        [json!({"installation": "inst-build", "runId": "r1"})]
    );
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "terminal-grid"), "{shown:?}");
    assert!(
        runtime.state.terminal.is_none(),
        "only Go to pane attaches to the agent"
    );
    assert!(
        shown.iter().any(|k| k == "record-standing"),
        "it says it is reading: {shown:?}"
    );
    let tabs: Vec<String> = shown
        .iter()
        .filter(|k| k.starts_with("tab-"))
        .cloned()
        .collect();
    assert_eq!(tabs, ["tab-log", "tab-terminal", "tab-facts"]);

    harness.fake.push("runDetail", Ok(with_diff()));
    settle(&mut runtime, &harness, 1000.0);
    let tabs: Vec<String> = keys(&runtime)
        .into_iter()
        .filter(|k| k.starts_with("tab-"))
        .collect();
    assert_eq!(
        tabs,
        [
            "tab-summary",
            "tab-diff",
            "tab-evidence",
            "tab-artefacts",
            "tab-log",
            "tab-terminal",
            "tab-facts"
        ]
    );
    let states = named(&runtime, "tab-summary")["states"].clone();
    assert!(
        states
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "selected" || s == "checked"),
        "{states}"
    );

    tap(&mut runtime, "back", 2000.0);
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"title": "Since left"}))));
    settle(&mut runtime, &harness, 3000.0);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "card-b2"), "{shown:?}");
    assert!(runtime.state.record.open.is_none());
}

#[test]
fn a_record_shows_flow_first_and_the_summary_of_what_it_says() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flows: Value = serde_json::from_str(include_str!("../../fixtures/flows.json")).unwrap();
    harness.fake.push(
        "runDetail",
        Ok(detail(json!({
            "flow": flows["before"],
            "inputs": [{"name": "goal", "value": "Ship the record", "source": "cli"}],
        }))),
    );
    settle(&mut runtime, &harness, 100.0);
    let shown = keys(&runtime);
    assert!(
        shown.iter().any(|k| k == "flow-build-run-build"),
        "{shown:?}"
    );
    assert!(
        shown.iter().any(|k| k == "inspector"),
        "the current Step is inspected: {shown:?}"
    );
    assert!(
        !shown.iter().any(|k| k == "terminal-grid"),
        "no terminal is opened unasked"
    );
    tap(&mut runtime, "tab-summary", 200.0);
    let inputs = named(&runtime, "summary-inputs");
    assert_eq!(inputs["name"], "Inputs");
    tap(&mut runtime, "tab-flow", 300.0);
    assert!(keys(&runtime).iter().any(|k| k == "flow"));
}

fn diff_open(harness: &Harness<App>) -> Runtime<App> {
    let mut runtime = opened(harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    harness.fake.push("runDetail", Ok(with_diff()));
    settle(&mut runtime, harness, 100.0);
    assert_eq!(
        harness.fake.asked_of("runFile"),
        [json!({"installation": "inst-build", "runId": "r1", "ref": "diff:src/a.rs", "offset": 0})]
    );
    assert!(keys(&runtime).iter().any(|k| k == "diff-reading"));
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": "diff:src/a.rs", "encoding": "utf8", "content": PATCH, "size": PATCH.len()})),
    );
    settle(&mut runtime, harness, 200.0);
    runtime
}

#[test]
fn the_diff_is_read_file_by_file_and_a_file_ticked_viewed_is_counted() {
    let harness = Harness::<App>::new();
    let mut runtime = diff_open(&harness);
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "diff"), "{shown:?}");
    assert!(shown.iter().any(|k| k == "tree-file-src/a.rs"), "{shown:?}");
    assert_eq!(named(&runtime, "diff-viewed")["name"], "0 of 1 viewed");
    runtime.update(|app, _| app.toggle_viewed("src/a.rs"));
    runtime.frame(300.0);
    assert_eq!(named(&runtime, "diff-viewed")["name"], "1 of 1 viewed");
    let row = named(&runtime, "tree-file-src/a.rs");
    assert!(row["name"].as_str().unwrap().contains("viewed"), "{row}");
}

fn with_a_draft(runtime: &mut Runtime<App>, said: &str) {
    runtime.update(|app, _| {
        let at = LineRef::new(Side::New, 2);
        app.choose_diff_lines(Some(LineRange {
            file: 0,
            start: at,
            end: at,
        }));
    });
    runtime.frame(400.0);
    assert!(keys(runtime).iter().any(|k| k == "diff-composer"));
    let said = said.to_string();
    runtime.update(move |app, _| app.diff.as_mut().unwrap().comment = TextEdit::new(said.clone()));
    tap(runtime, "add-comment", 500.0);
}

#[test]
fn selected_lines_become_a_draft_sent_as_one_delivery_and_cleared_once_taken() {
    let harness = Harness::<App>::new();
    let mut runtime = diff_open(&harness);
    with_a_draft(&mut runtime, "Name this better");
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "draft-d1"), "{shown:?}");
    assert!(
        shown.iter().any(|k| k == "note-d1"),
        "drawn under its line: {shown:?}"
    );
    let drafts = runtime.state.record.drafts[&("inst-build".to_string(), "r1".to_string())].clone();

    tap(&mut runtime, "send-review", 700.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent.len(), 1);
    let action = &sent[0]["action"];
    assert_eq!(action["_tag"], "Deliver");
    assert_eq!(action["runId"], "r1");
    assert_eq!(action["text"], compose(&drafts));
    assert_eq!(action["shown"], json!({"epoch": "e1", "seq": 7.0}));
    assert!(sent[0]["request"].as_str().is_some_and(|r| r.len() == 36));
    assert!(
        keys(&runtime).iter().any(|k| k == "draft-d1"),
        "kept until the host takes it"
    );

    harness
        .fake
        .answer("act", Ok(json!("Delivered to build-1.")));
    settle(&mut runtime, &harness, 800.0);
    let shown = keys(&runtime);
    assert!(!shown.iter().any(|k| k == "draft-d1"), "{shown:?}");
    assert_eq!(
        named(&runtime, "record-notice")["name"],
        "Delivered to build-1."
    );
}

#[test]
fn a_delivery_the_host_refused_says_why_and_try_again_sends_the_same_request() {
    let harness = Harness::<App>::new();
    let mut runtime = diff_open(&harness);
    with_a_draft(&mut runtime, "Again");
    tap(&mut runtime, "send-review", 700.0);
    harness
        .fake
        .answer("act", Err(CallError("No live agent took it.".into())));
    settle(&mut runtime, &harness, 800.0);
    assert_eq!(
        named(&runtime, "record-notice")["name"],
        "No live agent took it."
    );
    assert!(
        keys(&runtime).iter().any(|k| k == "draft-d1"),
        "the drafts stay"
    );
    tap(&mut runtime, "notice-again", 900.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["request"], sent[1]["request"]);
    assert_eq!(sent[0]["action"], sent[1]["action"]);
}

fn flow_with(node: Value, lane_actions: Value) -> Value {
    let mut node = node;
    for (key, value) in
        json!({"kind": "agent", "description": "", "declared": true, "offPath": false,
        "attempts": [], "questions": [], "runs": []})
        .as_object()
        .unwrap()
    {
        if node.get(key).is_none() {
            node[key] = value.clone();
        }
    }
    let id = node["id"].clone();
    json!({"lanes": [{"run": "r1", "workflow": "implement", "title": "Build", "machine": "Build box",
        "execution": "running", "declared": true, "nodes": [node], "actions": lane_actions}],
        "current": {"run": "r1", "node": id}})
}

#[test]
fn the_next_move_retries_a_failed_step_on_act_and_a_lane_action_holds_the_run() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "checks", "title": "Checks", "state": "failed", "primary": "retry", "why": "Tests failed"}),
        json!(["hold"]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    tap(&mut runtime, "lane-hold-run", 400.0);
    let sent: Vec<Value> = harness
        .fake
        .asked_of("act")
        .into_iter()
        .map(|a| a["action"].clone())
        .collect();
    assert_eq!(sent[0], json!({"_tag": "Resume", "runId": "r1"}));
    assert_eq!(
        sent[1],
        json!({"_tag": "Control", "runId": "r1", "control": "hold", "set": true, "shown": {"epoch": "e1", "seq": 7.0}})
    );
}

#[test]
fn a_note_for_a_step_names_its_step_and_retry_with_a_note_resumes_once_delivered() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "checks", "title": "Checks", "state": "failed", "primary": "retry-noted", "why": "Tests failed"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert!(keys(&runtime).iter().any(|k| k == "form-text"));
    runtime.update(|app, _| {
        if let Some(collie_desktop_board::record::Form::Text { edit, .. }) =
            app.record.open.as_mut().unwrap().form.as_mut()
        {
            *edit = TextEdit::new("Use the fixture");
        }
    });
    tap(&mut runtime, "form-send", 300.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent.len(), 1, "the retry waits for the note");
    assert_eq!(
        sent[0]["action"],
        json!({"_tag": "Deliver", "runId": "r1", "step": "checks", "text": "Use the fixture", "shown": {"epoch": "e1", "seq": 7.0}})
    );
    harness.fake.answer("act", Ok(json!("Noted.")));
    settle(&mut runtime, &harness, 400.0);
    let sent = harness.fake.asked_of("act");
    assert_eq!(sent[1]["action"], json!({"_tag": "Resume", "runId": "r1"}));
    assert_ne!(sent[0]["request"], sent[1]["request"]);
}

#[test]
fn an_open_question_is_answered_by_an_option() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
            "questions": [{"id": "q-1", "name": "Which way?", "open": true, "text": "Which way?",
                "options": [{"id": "left", "title": "Left"}, {"id": "right", "title": "Right", "recommended": true}]}]}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    tap(&mut runtime, "option-right", 300.0);
    tap(&mut runtime, "form-send", 400.0);
    assert_eq!(
        harness.fake.asked_of("act")[0]["action"],
        json!({"_tag": "Answer", "runId": "r1", "decision": "q-1", "value": "right"})
    );
}

#[test]
fn a_long_question_can_be_scrolled_to_its_answer_control_with_or_without_a_selected_step() {
    let rect = |runtime: &Runtime<App>, key: &str| {
        runtime
            .elements()
            .iter()
            .find(|e| e.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("no {key}"))
            .rect
    };
    for inspected in [true, false] {
        let harness = Harness::<App>::new();
        let mut runtime = opened(&harness);
        runtime.set_viewport((1000.0, 850.0), 1.0);
        runtime.update(|app, _| {
            app.nav.chat.set_open(true);
            app.open_record(
                "inst-build".into(),
                "r1".into(),
                "Build box".into(),
                Some("flow"),
            );
        });
        let options: Vec<Value> = (0..if inspected { 12 } else { 24 })
            .map(|i| json!({"id": format!("choice-{i}"), "title": format!("Choice {i}")}))
            .collect();
        let flow = flow_with(
            json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
                "questions": [{"id": "q-1", "name": "Which way?", "open": true,
                    "text": "Which way?", "options": options}]}),
            json!([]),
        );
        harness
            .fake
            .push("runDetail", Ok(detail(json!({"flow": flow}))));
        settle(&mut runtime, &harness, 100.0);
        tap(&mut runtime, "next-action", 200.0);
        if !inspected {
            runtime.update(|app, _| app.flow.as_mut().unwrap().selected = None);
        }
        for at in [400.0, 500.0, 600.0, 700.0] {
            runtime.invalidate();
            runtime.frame(at);
        }
        tap(&mut runtime, "option-choice-0", 800.0);
        let [x, y, width, height] = rect(&runtime, "tabpanel-flow");
        let before = rect(&runtime, "form-send")[1];
        assert!(before > y + height, "fixture must require scrolling");
        for i in 0..20 {
            runtime.wheel_event(WheelEvent::new(0.0, -80.0).at(x + width / 2.0, y + height - 32.0));
            runtime.frame(1000.0 + i as f64 * 100.0);
        }
        let [send_x, send_y, send_width, send_height] = rect(&runtime, "form-send");
        assert!(
            send_y < before && send_y >= y && send_y + send_height <= y + height,
            "Answer must scroll inside Flow (inspected={inspected}): {:?}",
            rect(&runtime, "form-send")
        );
        assert!(send_x >= x && send_x + send_width <= x + width);
        tap(&mut runtime, "form-send", 4000.0);
        assert_eq!(
            harness.fake.asked_of("act")[0]["action"],
            json!({"_tag": "Answer", "runId": "r1", "decision": "q-1", "value": "choice-0"}),
            "the visible control must submit the selected answer (inspected={inspected})"
        );
    }
}

#[test]
fn a_report_is_read_in_parts_confined_and_opened_in_the_browser_from_a_file() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("evidence"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(detail(
            json!({"evidence": [{"name": "report.html", "bytes": 40}]}),
        )),
    );
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "open-evidence-report-html", 200.0);
    let html = "<html><head></head><body>ok</body></html>";
    let b64 = base64::engine::general_purpose::STANDARD;
    let (first, rest) = html.split_at(20);
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": "evidence:report.html", "encoding": "base64", "content": b64.encode(first), "size": html.len()})),
    );
    settle(&mut runtime, &harness, 300.0);
    let asked = harness.fake.asked_of("runFile");
    assert_eq!(asked[1]["offset"], 20, "{asked:?}");
    harness.fake.answer(
        "runFile",
        Ok(json!({"ref": "evidence:report.html", "encoding": "base64", "content": b64.encode(rest), "size": html.len()})),
    );
    settle(&mut runtime, &harness, 400.0);
    let opened = harness.fake.asked_of("openLink");
    let url = opened[0]["url"].as_str().unwrap();
    let path = url.strip_prefix("file://").unwrap();
    let written = std::fs::read_to_string(path).unwrap();
    assert!(written.contains("Content-Security-Policy"), "{written}");
    assert!(written.contains("<body>ok</body>"));
}

#[test]
fn a_gesture_on_a_machine_out_of_reach_says_so_to_the_host() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.machines.iter_mut().for_each(|m| m.as_of = Some(1.0));
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "checks", "title": "Checks", "state": "failed", "primary": "retry"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    assert!(
        !keys(&runtime).iter().any(|k| k == "next-action"),
        "no action is offered while away"
    );
    assert!(
        named(&runtime, "record-standing")["name"]
            .as_str()
            .unwrap()
            .starts_with("Not current")
    );
    runtime.update(|app, _| {
        app.act_in_record(
            "inst-build".into(),
            collie_desktop_board::flow::actions::resume("r1"),
            Default::default(),
        )
    });
    assert_eq!(
        harness.fake.asked_of("act")[0]["unsent"],
        "its Machine is out of reach"
    );
}

#[test]
fn a_steps_questions_are_answered_one_after_another_each_on_its_own() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
            "questions": [
                {"id": "q-1", "name": "Which way?", "open": true, "text": "Which way?",
                    "options": [{"id": "left", "title": "Left"}, {"id": "right", "title": "Right"}]},
                {"id": "q-2", "name": "How fast?", "open": true, "text": "How fast?",
                    "options": [{"id": "slow", "title": "Slow"}, {"id": "quick", "title": "Quick"}]}]}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert_eq!(named(&runtime, "question-count")["name"], "Question 1 of 2");
    tap(&mut runtime, "option-right", 300.0);
    tap(&mut runtime, "form-send", 400.0);
    assert_eq!(named(&runtime, "question-count")["name"], "Question 2 of 2");
    tap(&mut runtime, "option-quick", 500.0);
    tap(&mut runtime, "form-send", 600.0);
    let sent: Vec<Value> = harness
        .fake
        .asked_of("act")
        .into_iter()
        .map(|a| a["action"].clone())
        .collect();
    assert_eq!(
        sent,
        [
            json!({"_tag": "Answer", "runId": "r1", "decision": "q-1", "value": "right"}),
            json!({"_tag": "Answer", "runId": "r1", "decision": "q-2", "value": "quick"}),
        ]
    );
    assert!(
        !keys(&runtime).iter().any(|k| k == "flow-form"),
        "the form closes once every question is answered"
    );
}

#[test]
fn a_steps_start_asks_the_run_what_it_offers_and_starts_it_with_what_was_typed() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "offer:build", "title": "Build it", "state": "expected", "primary": "start"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    assert_eq!(
        harness.fake.asked_of("offers"),
        [json!({"installation": "inst-build", "runId": "r1"})]
    );
    harness.fake.answer(
        "offers",
        Ok(json!([
            {"id": "other", "title": "Other", "workflow": "general", "arguments": null,
                "kind": "action", "primary": false, "unavailable": null},
            {"id": "build", "title": "Build it", "workflow": "implement", "kind": "follow-up",
                "primary": true, "unavailable": null,
                "arguments": {"type": "object", "required": ["goal"],
                    "properties": {"goal": {"type": "string"}, "tries": {"type": "number"}}}}
        ])),
    );
    settle(&mut runtime, &harness, 300.0);
    assert_eq!(named(&runtime, "offer-title")["name"], "Build it");
    assert!(
        harness.fake.asked_of("act").is_empty(),
        "an offer that takes inputs waits for them"
    );
    tap(&mut runtime, "offer-field-goal", 350.0);
    runtime.key(rune::KeyEvent {
        key: rune::Key::Text("Ship it".into()),
        mods: Default::default(),
    });
    runtime.frame(380.0);
    tap(&mut runtime, "offer-start", 400.0);
    assert_eq!(
        harness.fake.asked_of("act")[0]["action"],
        json!({"_tag": "Invoke", "runId": "r1", "offer": "build", "input": {"goal": "Ship it"}})
    );
}

#[test]
fn a_steps_start_that_says_what_it_does_is_asked_first_and_a_needed_yes_or_no_is_sent_as_ticked() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "offer:merge", "title": "Merge", "state": "expected", "primary": "start"}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    harness.fake.answer(
        "offers",
        Ok(json!([
            {"id": "merge", "title": "Merge", "workflow": "release", "kind": "follow-up",
                "primary": true, "unavailable": null, "ships": "merge",
                "confirm": "Merges it and stops: nothing is tagged or deployed.",
                "arguments": {"type": "object", "required": ["squash"],
                    "properties": {"squash": {"type": "boolean"}}}}
        ])),
    );
    settle(&mut runtime, &harness, 300.0);
    assert!(
        harness.fake.asked_of("act").is_empty(),
        "nothing is started before its yes"
    );
    assert_eq!(
        named(&runtime, "offer-confirm")["name"],
        "Merges it and stops: nothing is tagged or deployed."
    );
    assert_eq!(named(&runtime, "offer-field-squash")["role"], "check-box");
    assert_eq!(named(&runtime, "offer-start")["name"], "Merge");
    tap(&mut runtime, "offer-start", 400.0);
    assert_eq!(
        harness.fake.asked_of("act")[0]["action"],
        json!({"_tag": "Invoke", "runId": "r1", "offer": "merge", "input": {"squash": false}})
    );
}

fn several_files(files: Value) -> Value {
    detail(json!({"diff": {"base": "abc", "live": true, "files": files}}))
}

fn read_asked(harness: &Harness<App>) -> Vec<String> {
    harness
        .fake
        .asked_of("runFile")
        .iter()
        .map(|a| a["ref"].as_str().unwrap().to_string())
        .collect()
}

fn small(path: &str) -> Value {
    json!({"path": path, "status": "modified", "added": 1, "removed": 1})
}

fn patch_of(path: &str) -> Value {
    let patch = PATCH.replace("src/a.rs", path);
    json!({"ref": format!("diff:{path}"), "encoding": "utf8", "content": patch, "size": patch.len()})
}

#[test]
fn a_big_files_patch_is_read_only_once_it_is_opened_and_no_more_than_four_at_once() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    let mut files: Vec<Value> = (1..=5).map(|i| small(&format!("src/f{i}.rs"))).collect();
    files.push(json!({"path": "src/big.rs", "status": "modified", "added": 4000, "removed": 10}));
    harness
        .fake
        .push("runDetail", Ok(several_files(json!(files))));
    settle(&mut runtime, &harness, 100.0);
    assert_eq!(
        read_asked(&harness),
        [
            "diff:src/f1.rs",
            "diff:src/f2.rs",
            "diff:src/f3.rs",
            "diff:src/f4.rs"
        ],
        "four at once, the big file not at all"
    );
    harness.fake.answer("runFile", Ok(patch_of("src/f1.rs")));
    settle(&mut runtime, &harness, 200.0);
    assert_eq!(
        read_asked(&harness).len(),
        5,
        "the fifth goes once one is in"
    );
    assert!(
        keys(&runtime).iter().any(|k| k == "show-src/big.rs"),
        "the big file says it is not read yet: {:?}",
        keys(&runtime)
    );
    tap(&mut runtime, "tree-file-src/big.rs", 300.0);
    assert_eq!(read_asked(&harness).len(), 5, "opened, it waits its turn");
    harness.fake.answer("runFile", Ok(patch_of("src/f2.rs")));
    settle(&mut runtime, &harness, 400.0);
    assert_eq!(read_asked(&harness).last().unwrap(), "diff:src/big.rs");
}

#[test]
fn a_folder_of_the_diffs_tree_folds_its_files_away_until_a_filter_looks_inside() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(several_files(json!([
            small("src/a.rs"),
            small("docs/b.md")
        ]))),
    );
    settle(&mut runtime, &harness, 100.0);
    assert!(keys(&runtime).iter().any(|k| k == "tree-file-src/a.rs"));
    tap(&mut runtime, "tree-src/", 200.0);
    let shown = keys(&runtime);
    assert!(
        !shown.iter().any(|k| k == "tree-file-src/a.rs"),
        "{shown:?}"
    );
    assert!(
        shown.iter().any(|k| k == "tree-file-docs/b.md"),
        "{shown:?}"
    );
    let folder = named(&runtime, "tree-src/");
    assert!(
        folder["states"]
            .as_array()
            .unwrap()
            .contains(&json!("collapsed")),
        "{folder}"
    );
    runtime.update(|app, _| app.diff.as_mut().unwrap().filter = TextEdit::new("a.rs"));
    runtime.frame(300.0);
    assert!(keys(&runtime).iter().any(|k| k == "tree-file-src/a.rs"));
}

#[test]
fn a_file_the_run_has_not_changed_again_keeps_its_patch_when_the_diff_is_read_again() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("diff"),
        )
    });
    harness.fake.push(
        "runDetail",
        Ok(several_files(json!([small("src/a.rs"), small("src/b.rs")]))),
    );
    settle(&mut runtime, &harness, 100.0);
    harness.fake.answer("runFile", Ok(patch_of("src/a.rs")));
    harness.fake.answer("runFile", Ok(patch_of("src/b.rs")));
    settle(&mut runtime, &harness, 200.0);
    let changed = json!({"path": "src/b.rs", "status": "modified", "added": 3, "removed": 1});
    harness.fake.push(
        "runDetail",
        Ok(several_files(json!([small("src/a.rs"), changed]))),
    );
    settle(&mut runtime, &harness, 300.0);
    assert_eq!(
        read_asked(&harness),
        ["diff:src/a.rs", "diff:src/b.rs", "diff:src/b.rs"],
        "only the file changed again is read again"
    );
}

#[test]
fn a_cards_flow_strip_opens_its_record_on_flow_with_the_active_step_chosen_never_its_terminal() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    // Build box's b2, as its latest upsert has it, with a Flow strip on its card.
    let mut upsert: Value = FLOCK
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .rfind(|line| line["message"]["task"]["id"] == "b2")
        .unwrap();
    upsert["message"]["seq"] = json!(3);
    upsert["message"]["task"]["flow"] = json!({"release": 0, "current": null, "glyphs": [
        {"title": "Plan", "state": "done"}, {"title": "Ask", "state": "needs-you"},
        {"title": "Build", "state": "done"}, {"title": "Ship", "state": "expected"}]});
    runtime.update(|app, _| app.apply(serde_json::from_value(upsert).unwrap()));
    runtime.frame(50.0);
    let shown = keys(&runtime);
    let strip = shown
        .iter()
        .find(|k| k.ends_with("b2-flow"))
        .unwrap_or_else(|| panic!("no Flow strip for b2 in {shown:?}"))
        .clone();
    tap(&mut runtime, &strip, 100.0);
    assert_eq!(
        harness.fake.asked_of("runDetail"),
        [json!({"installation": "inst-build", "runId": "r1"})]
    );
    assert!(
        runtime.state.terminal.is_none(),
        "the strip opens no terminal"
    );
    // No Step is current; the one needing the human is the active one, over the latest done.
    let step = |id: &str, state: &str| {
        let lane = flow_with(json!({"id": id, "title": id, "state": state}), json!([]));
        lane["lanes"][0]["nodes"][0].clone()
    };
    let flow = json!({"lanes": [{"run": "r1", "workflow": "implement", "title": "Build", "machine": "Build box",
        "execution": "running", "declared": true, "actions": [], "nodes": [
            step("plan", "done"), step("ask", "needs-you"), step("build", "done"), step("ship", "expected")]}],
        "current": null});
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 400.0);
    settle(&mut runtime, &harness, 500.0);
    assert_eq!(runtime.state.record_tab(), "flow");
    assert!(runtime.state.terminal.is_none(), "still no terminal");
    let selected = runtime.state.flow.as_ref().and_then(|m| m.selected.clone());
    assert_eq!(
        selected.map(|s| (s.run, s.node)),
        Some(("r1".to_string(), "ask".to_string()))
    );
    assert!(
        runtime.state.flow.as_ref().unwrap().reveal.is_none(),
        "the Step was laid out and scrolled to"
    );
    let shown = keys(&runtime);
    assert!(shown.iter().any(|k| k == "inspector"), "{shown:?}");
}

fn width_of(runtime: &Runtime<App>, key: &str) -> f32 {
    runtime
        .elements()
        .into_iter()
        .find(|e| !e.exiting && e.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("no {key} in {:?}", keys(runtime)))
        .rect[2]
}

#[test]
fn the_forms_fields_span_their_form_not_a_fixed_280_points() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    let flow = flow_with(
        json!({"id": "ask", "title": "Ask", "state": "needs-you", "primary": "answer",
            "questions": [{"id": "q-1", "name": "Which way?", "open": true, "text": "Which way?",
                "options": [{"id": "left", "title": "Left"}]}]}),
        json!([]),
    );
    harness
        .fake
        .push("runDetail", Ok(detail(json!({"flow": flow}))));
    settle(&mut runtime, &harness, 100.0);
    tap(&mut runtime, "next-action", 200.0);
    let form = width_of(&runtime, "flow-form");
    let field = width_of(&runtime, "form-answer-text");
    assert!(
        field > 300.0 && field > form - 80.0,
        "the answer field is {field} wide in a form {form} wide"
    );
}

#[test]
fn a_record_attaches_its_terminal_only_while_its_terminal_tab_is_shown() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record(
            "inst-build".into(),
            "r1".into(),
            "Build box".into(),
            Some("log"),
        )
    });
    harness.fake.push("runDetail", Ok(with_diff()));
    settle(&mut runtime, &harness, 100.0);
    assert!(runtime.state.terminal.is_none(), "not on Log");
    // Picking an agent elsewhere, as the inspector's Watch it does first, attaches nothing.
    runtime.update(|app, _| app.pick_agent("build-1".into()));
    assert!(
        runtime.state.terminal.is_none(),
        "not until Terminal is shown"
    );
    runtime.update(|app, _| app.show_tab("terminal"));
    assert!(runtime.state.terminal.is_some(), "on Terminal it attaches");
    runtime.update(|app, _| app.show_tab("log"));
    assert!(
        runtime.state.terminal.is_none(),
        "leaving Terminal leaves the pane"
    );
}

#[test]
fn a_record_whose_details_are_not_on_its_machine_says_so_rather_than_reading() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| {
        app.open_record("inst-build".into(), "r1".into(), "Build box".into(), None)
    });
    harness.fake.push(
        "runDetail",
        Ok(json!({"detail": null, "asOf": null, "bytes": 0})),
    );
    settle(&mut runtime, &harness, 100.0);
    let tree = runtime.accessibility_json();
    let record = within(&tree)
        .into_iter()
        .find(|n| n["key"] == "record")
        .expect("the record");
    let said: Vec<String> = within(record)
        .iter()
        .filter_map(|n| n["name"].as_str().map(String::from))
        .collect();
    assert!(
        said.iter()
            .any(|s| s == "This Run's details are not on its Machine."),
        "{said:?}"
    );
    assert!(
        !said.iter().any(|s| s.starts_with("Reading")),
        "nothing is still reading: {said:?}"
    );
}

#[test]
fn a_parked_runs_record_names_its_park_and_keeps_its_recovery_after_it_clears() {
    let harness = Harness::<App>::new();
    let mut runtime = opened(&harness);
    runtime.update(|app, _| app.open_card("inst-build:b2"));
    runtime.frame(100.0);
    let recovery: Vec<String> = (1..=22).map(|n| format!("rechecked {n}")).collect();
    harness.fake.push(
        "runDetail",
        Ok(detail(json!({
            "park": {"cause": "login-missing", "kind": "needs-you"},
            "recovery": recovery,
        }))),
    );
    settle(&mut runtime, &harness, 200.0);
    assert_eq!(
        named(&runtime, "record-park")["name"],
        "Parked: login-missing · needs you"
    );
    let lines = |runtime: &Runtime<App>| -> Vec<String> {
        within(&named(runtime, "record-recovery"))
            .into_iter()
            .filter(|n| n["role"] == "list-item")
            .filter_map(|n| n["name"].as_str().map(String::from))
            .collect()
    };
    let kept = lines(&runtime);
    assert_eq!(kept.len(), 20);
    assert_eq!(kept[0], "rechecked 3");

    harness.fake.push(
        "runDetail",
        Ok(detail(
            json!({"park": null, "recovery": ["rechecked cleared", "resumed resumed"]}),
        )),
    );
    settle(&mut runtime, &harness, 300.0);
    assert!(!keys(&runtime).iter().any(|k| k == "record-park"));
    assert_eq!(lines(&runtime), ["rechecked cleared", "resumed resumed"]);
}
