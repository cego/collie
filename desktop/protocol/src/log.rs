//! The app's own log: `desktop.log` under `$XDG_STATE_HOME/collie-desktop`, one JSON line an
//! event, kept once as `desktop.log.1` past 1 MiB, as the core keeps `actions.log`
//! (`desktop/src/bun/sent.ts`). A line holds where and what, a reason and ids: never a
//! message's words, an answer's value or a file's content. A write that fails is dropped.

use serde_json::{Map, Value};
use std::cell::RefCell;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Past this many bytes the log is kept once as `desktop.log.1`.
pub const LOG_BYTES: u64 = 1024 * 1024;

struct Target {
    file: PathBuf,
    max: u64,
}

/// The app's log, once `start` named it; nothing is logged before.
static APP: Mutex<Option<Target>> = Mutex::new(None);

thread_local! {
    /// A test's log, which this thread writes instead of the app's.
    static HERE: RefCell<Option<Target>> = const { RefCell::new(None) };
}

/// `$XDG_STATE_HOME/collie-desktop`, else `~/.local/state/collie-desktop`.
/// `COLLIE_RUNE_LOG_DIR` puts it elsewhere, as a headless run's does.
pub fn dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("COLLIE_RUNE_LOG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(state.join("collie-desktop"))
}

/// Logs the app's events from here on, in `dir()`.
pub fn start() {
    if let Some(dir) = dir() {
        let _ = fs::create_dir_all(&dir);
        *APP.lock().unwrap_or_else(|e| e.into_inner()) = Some(Target {
            file: dir.join("desktop.log"),
            max: LOG_BYTES,
        });
    }
}

/// Logs this thread's events in `dir` instead, rotating past `max` bytes: for a test.
pub fn here(dir: &Path, max: u64) {
    HERE.with(|here| {
        *here.borrow_mut() = Some(Target {
            file: dir.join("desktop.log"),
            max,
        })
    });
}

/// One event: its `area` (chat, calls, terminal, board…), `what` happened, the `reason` where
/// something failed, and the `ids` it is about (an RPC's tag, a turn, a Machine). Never pass
/// a message's words, an answer or a file's content.
pub fn event(area: &str, what: &str, reason: Option<&str>, ids: &[(&str, &str)]) {
    let mut line = Map::new();
    line.insert("at".into(), Value::String(iso_now()));
    line.insert("area".into(), area.into());
    line.insert("what".into(), what.into());
    if let Some(reason) = reason {
        line.insert("reason".into(), reason.into());
    }
    for (key, id) in ids {
        line.insert((*key).into(), (*id).into());
    }
    let mut bytes = Value::Object(line).to_string().into_bytes();
    bytes.push(b'\n');
    let written = HERE.with(|here| here.borrow().as_ref().map(|t| write(t, &bytes)));
    if written.is_none() {
        let app = APP.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(target) = app.as_ref() {
            write(target, &bytes);
        }
    }
}

fn write(target: &Target, bytes: &[u8]) {
    // One writer at a time: a rotation is a stat, a rename and an append.
    static WRITING: Mutex<()> = Mutex::new(());
    let _one = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let size = fs::metadata(&target.file).map_or(0, |m| m.len());
    if size > 0 && size + bytes.len() as u64 > target.max {
        let mut kept = target.file.clone().into_os_string();
        kept.push(".1");
        let _ = fs::rename(&target.file, kept);
    }
    let _ = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target.file)
        .and_then(|mut file| file.write_all(bytes));
}

fn iso_now() -> String {
    let ms = crate::epoch_ms();
    let secs = (ms / 1000.0).floor() as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's days_from_civil, reversed).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        (ms.rem_euclid(1000.0)) as i64
    )
}
