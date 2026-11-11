//! A file the human gives the chat: whether it fits, how far an image is scaled for the model,
//! and which pasted data becomes one: `attachments.ts`.

use collie_desktop_protocol::generated::{Document, StagedOrRefusedItem0};
use rune::ClipboardContent;
use std::path::PathBuf;

/// A file a message carries, as the conversation shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Attached {
    pub id: String,
    pub name: String,
    pub size: f64,
    pub media_type: String,
}

impl From<&StagedOrRefusedItem0> for Attached {
    fn from(staged: &StagedOrRefusedItem0) -> Attached {
        Attached {
            id: staged.id.clone(),
            name: staged.name.clone(),
            size: staged.size,
            media_type: staged.media_type.clone(),
        }
    }
}

impl From<&Document> for Attached {
    fn from(part: &Document) -> Attached {
        Attached {
            id: part.id.clone(),
            name: part.metadata.name.clone(),
            size: part.metadata.size,
            media_type: part.source.mime_type.clone(),
        }
    }
}

pub const FILE_CAP: f64 = 20.0 * 1024.0 * 1024.0;
pub const MESSAGE_CAP: f64 = 30.0 * 1024.0 * 1024.0;
/// The longest edge the API takes in a request of more than 20 images.
pub const LONG_EDGE: u32 = 2000;

fn megabytes(bytes: f64) -> String {
    format!("{:.1} MB", bytes / 1024.0 / 1024.0)
}

/// Why `name`, `size` bytes, cannot go with a message already holding `held`.
pub fn cap_refusal(held: &[Attached], name: &str, size: f64) -> Option<String> {
    if size > FILE_CAP {
        return Some(format!(
            "{name} is {}, over the 20 MB one file may be.",
            megabytes(size)
        ));
    }
    let total = held.iter().map(|f| f.size).sum::<f64>() + size;
    (total > MESSAGE_CAP).then(|| {
        format!(
            "With {name} this message's files come to {}, over the 30 MB one message may carry.",
            megabytes(total)
        )
    })
}

/// The size an image is scaled to, or none where it is sent as it is.
pub fn scaled_size(width: u32, height: u32) -> Option<(u32, u32)> {
    let long = width.max(height);
    if long <= LONG_EDGE {
        return None;
    }
    let by = LONG_EDGE as f64 / long as f64;
    Some((
        (width as f64 * by).round() as u32,
        (height as f64 * by).round() as u32,
    ))
}

/// A pasted image's name, from when it was pasted: `pasted-2026-11-11-09-30-00.png`.
pub fn pasted_name(at_iso: &str, media_type: &str) -> String {
    let stamp: String = at_iso
        .chars()
        .take(19)
        .map(|c| if c == 'T' || c == ':' { '-' } else { c })
        .collect();
    let ext = media_type.split('/').nth(1).unwrap_or("png");
    format!("pasted-{stamp}.{ext}")
}

/// A file's size as its chip says it.
pub fn size_said(bytes: f64) -> String {
    if bytes < 1024.0 * 1024.0 {
        format!("{} KB", (bytes / 1024.0).round().max(1.0))
    } else {
        megabytes(bytes)
    }
}

fn percent_decoded(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The paths of a `text/uri-list`, and why each other line is not a file here.
pub fn uri_list_paths(text: &str) -> (Vec<PathBuf>, Vec<String>) {
    let (mut paths, mut refused) = (Vec::new(), Vec::new());
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let local = line
            .strip_prefix("file://")
            .and_then(|rest| {
                let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
                (host.is_empty() || host == "localhost").then_some(path)
            })
            .filter(|path| !path.is_empty())
            .and_then(percent_decoded);
        match local {
            Some(path) => paths.push(PathBuf::from(path)),
            None => refused.push(format!("{line} is not a file on this computer")),
        }
    }
    (paths, refused)
}

/// The files a paste carries: the clipboard's own list, or text that is only `file://` URIs.
/// Text with anything else in it is typed, as it always was.
pub fn pasted_paths(pasted: &ClipboardContent) -> Vec<PathBuf> {
    if !pasted.files().is_empty() {
        return pasted.files().to_vec();
    }
    let text = pasted.text();
    if text.trim().is_empty()
        || !text
            .lines()
            .all(|l| l.trim().is_empty() || l.trim().starts_with("file://"))
    {
        return Vec::new();
    }
    let (paths, refused) = uri_list_paths(text);
    if refused.is_empty() {
        paths
    } else {
        Vec::new()
    }
}

/// A moment as an ISO 8601 UTC stamp to the second: `2026-11-11T09:30:00Z`.
pub fn iso_of(epoch_ms: f64) -> String {
    let secs = (epoch_ms / 1000.0).floor() as i64;
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
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}
