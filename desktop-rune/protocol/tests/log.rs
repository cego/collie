//! The app's log: one JSON line an event, kept once as `desktop.log.1` past its size.

use collie_desktop_protocol::log;
use serde_json::Value;
use std::path::PathBuf;

fn fresh(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("collie-log-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn lines(file: &PathBuf) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn an_event_is_one_json_line_of_where_what_why_and_ids() {
    let dir = fresh("line");
    log::here(&dir, log::LOG_BYTES);
    log::event("calls", "request failed", Some("Codex is not signed in."), &[("rpc", "setSettings")]);
    let said = lines(&dir.join("desktop.log"));
    assert_eq!(said.len(), 1);
    assert_eq!(said[0]["area"], "calls");
    assert_eq!(said[0]["what"], "request failed");
    assert_eq!(said[0]["reason"], "Codex is not signed in.");
    assert_eq!(said[0]["rpc"], "setSettings");
    assert!(said[0]["at"].as_str().is_some_and(|at| at.ends_with('Z')));
}

#[test]
fn past_its_size_the_log_is_kept_once_as_its_dot_one() {
    let dir = fresh("rotate");
    log::here(&dir, 300);
    for n in 0..12 {
        log::event("chat", "subscription failed", Some("the core went away"), &[("n", &n.to_string())]);
    }
    let now = dir.join("desktop.log");
    let kept = dir.join("desktop.log.1");
    assert!(std::fs::metadata(&now).unwrap().len() <= 300);
    assert!(std::fs::metadata(&kept).unwrap().len() <= 300);
    assert!(!dir.join("desktop.log.2").exists(), "kept once");
    let last = lines(&now);
    assert_eq!(last.last().unwrap()["n"], "11", "the newest is in the log");
    let before = lines(&kept);
    let first_now: u32 = last[0]["n"].as_str().unwrap().parse().unwrap();
    let last_kept: u32 = before.last().unwrap()["n"].as_str().unwrap().parse().unwrap();
    assert_eq!(last_kept + 1, first_now, "the kept file ends where the log begins");
}

#[test]
fn a_write_that_fails_is_dropped() {
    let dir = fresh("gone").join("no-such-dir");
    log::here(&dir, log::LOG_BYTES);
    log::event("chat", "subscription failed", None, &[]);
    assert!(!dir.exists());
}
