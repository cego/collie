//! A Run's evidence files as the record shows them, and how far its plan is: copies of
//! `evidence.ts` and `planProgress` in `plan-view.ts`. Rune has no web view, so a report or a
//! video opens in the browser, written aside first (ADR-0066).

use collie_desktop_protocol::generated::{EvidenceItem, Ticket};
use std::path::PathBuf;

const MEDIA: [(&str, &str); 11] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("mov", "video/quicktime"),
    ("ogv", "video/ogg"),
];

/// An image's or a video's media type, by its extension; none for anything else.
pub fn media_type(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    MEDIA
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, media)| *media)
}

fn kind(name: &str) -> Option<&'static str> {
    media_type(name).and_then(|m| m.split('/').next())
}

/// Whether an item ref (`evidence:shot.png`) names an image Rune draws: SVG and AVIF open aside.
pub fn is_image(item: &str) -> bool {
    matches!(
        media_type(item),
        Some("image/png" | "image/jpeg" | "image/gif" | "image/webp")
    )
}

pub fn is_report(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// One place in the gallery: a before/after pair, or a shot on its own.
#[derive(Debug, Clone, PartialEq)]
pub struct GalleryItem {
    pub key: String,
    pub before: Option<EvidenceItem>,
    pub after: Option<EvidenceItem>,
    pub alone: Option<EvidenceItem>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sorted {
    pub gallery: Vec<GalleryItem>,
    pub videos: Vec<EvidenceItem>,
    pub reports: Vec<EvidenceItem>,
    pub files: Vec<EvidenceItem>,
}

/// `before` or `after` as a word of a name, `home.before.png`: the word and the name without it.
fn side_of(name: &str) -> Option<(&'static str, String)> {
    let lower = name.to_ascii_lowercase();
    let sep = |c: Option<char>| c.is_none_or(|c| matches!(c, '.' | '_' | '-'));
    for word in ["before", "after"] {
        let mut from = 0;
        while let Some(at) = lower[from..].find(word).map(|at| at + from) {
            let end = at + word.len();
            let ahead = sep(lower[..at].chars().last());
            if ahead && sep(lower[end..].chars().next()) {
                let start = if at > 0 { at - 1 } else { at };
                let rest = format!("{}{}", &name[..start], &name[end..]);
                let rest = rest
                    .strip_prefix(['.', '_', '-'])
                    .unwrap_or(&rest)
                    .to_string();
                return Some((word, rest));
            }
            from = end;
        }
    }
    None
}

pub fn sort_evidence(files: &[EvidenceItem]) -> Sorted {
    let mut by_name = files.to_vec();
    by_name.sort_by(|a, b| a.name.cmp(&b.name));
    let mut pairs: Vec<(String, Option<EvidenceItem>, Option<EvidenceItem>)> = Vec::new();
    let mut shots: Vec<GalleryItem> = Vec::new();
    let alone = |file: &EvidenceItem| GalleryItem {
        key: file.name.clone(),
        before: None,
        after: None,
        alone: Some(file.clone()),
    };
    for file in by_name.iter().filter(|f| kind(&f.name) == Some("image")) {
        let Some((word, key)) = side_of(&file.name) else {
            shots.push(alone(file));
            continue;
        };
        let at = match pairs.iter().position(|(k, _, _)| *k == key) {
            Some(at) => at,
            None => {
                pairs.push((key, None, None));
                pairs.len() - 1
            }
        };
        let slot = if word == "before" {
            &mut pairs[at].1
        } else {
            &mut pairs[at].2
        };
        if slot.is_some() {
            shots.push(alone(file));
        } else {
            *slot = Some(file.clone());
        }
    }
    for (key, before, after) in pairs {
        match (before, after) {
            (Some(before), Some(after)) => shots.push(GalleryItem {
                key,
                before: Some(before),
                after: Some(after),
                alone: None,
            }),
            (one, other) => shots.extend(one.or(other).as_ref().map(alone)),
        }
    }
    shots.sort_by(|a, b| a.key.cmp(&b.key));
    let rest: Vec<EvidenceItem> = by_name
        .into_iter()
        .filter(|f| kind(&f.name) != Some("image"))
        .collect();
    Sorted {
        gallery: shots,
        videos: rest
            .iter()
            .filter(|f| kind(&f.name) == Some("video"))
            .cloned()
            .collect(),
        reports: rest
            .iter()
            .filter(|f| is_report(&f.name))
            .cloned()
            .collect(),
        files: rest
            .iter()
            .filter(|f| kind(&f.name) != Some("video") && !is_report(&f.name))
            .cloned()
            .collect(),
    }
}

/// Nothing the report may fetch, first in its head so it holds before its own scripts run.
const POLICY: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/// A report with the policy that confines it first in its head.
pub fn confined(html: &str) -> String {
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{POLICY}\">");
    let lower = html.to_ascii_lowercase();
    let head = lower
        .find("<head")
        .and_then(|at| lower[at..].find('>').map(|end| at + end + 1));
    match head {
        Some(at) => format!("{}{meta}{}", &html[..at], &html[at..]),
        None => format!("<!doctype html><head>{meta}</head>{html}"),
    }
}

/// Where an evidence file of a Run is written to open aside: under the system's temp
/// directory, by installation and Run, its name kept to its last segment.
pub fn aside(installation: &str, run: &str, name: &str) -> PathBuf {
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    let file = name.rsplit('/').next().unwrap_or(name);
    std::env::temp_dir()
        .join("collie-desktop-evidence")
        .join(safe(installation))
        .join(safe(run))
        .join(safe(file))
}

/// `3 of 5 tickets done`; none for a plan without tickets.
pub fn plan_progress(tickets: &[Ticket]) -> Option<String> {
    (!tickets.is_empty()).then(|| {
        let done = tickets.iter().filter(|t| t.done).count();
        format!("{done} of {} tickets done", tickets.len())
    })
}

/// `said` without its terminal escapes (colours, cursor moves, titles), as plain text shows it;
/// `AnsiText.vue` draws the colours, which Rune's text here leaves out.
pub fn without_escapes(said: &str) -> String {
    let mut plain = String::with_capacity(said.len());
    let mut chars = said.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if c != '\r' {
                plain.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte from @ to ~.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ST.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    plain
}
