//! A Run's review comment drafts, what each is about, and the one message they are sent as
//! (ADR-0051): `review-comments.ts`, with diff anchors taken from rune-kit's Diff selection.

use rune_kit::diff::{DiffState, FileDiff, Line, LineKind, Side};

#[derive(Debug, Clone, PartialEq)]
pub enum Anchor {
    /// A span of a plan file, by its path in the plan directory, quoted as selected.
    Plan { file: String, quote: String },
    /// Lines of a changed file on one side: as it is now (`New`) or as it was (`Old`).
    Diff {
        path: String,
        side: Side,
        first: u32,
        last: u32,
        lines: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub id: String,
    pub anchor: Anchor,
    pub text: String,
}

pub fn add_draft(drafts: &[Draft], draft: Draft) -> Vec<Draft> {
    [drafts, &[draft]].concat()
}

pub fn edit_draft(drafts: &[Draft], id: &str, text: &str) -> Vec<Draft> {
    drafts
        .iter()
        .map(|draft| match draft.id == id {
            true => Draft {
                text: text.into(),
                ..draft.clone()
            },
            false => draft.clone(),
        })
        .collect()
}

pub fn remove_draft(drafts: &[Draft], id: &str) -> Vec<Draft> {
    drafts.iter().filter(|d| d.id != id).cloned().collect()
}

/// What is left once the drafts `sent` carried have gone; one edited since is kept.
pub fn clear_sent(drafts: &[Draft], sent: &[Draft]) -> Vec<Draft> {
    drafts
        .iter()
        .filter(|d| !sent.iter().any(|s| s.id == d.id && s.text == d.text))
        .cloned()
        .collect()
}

/// A selection in a plan file as an anchor; none for one with nothing but whitespace.
pub fn plan_anchor(file: &str, selected: &str) -> Option<Anchor> {
    (!selected.trim().is_empty()).then(|| Anchor::Plan {
        file: file.into(),
        quote: selected.into(),
    })
}

fn text_at(file: &FileDiff, line: u32, side: Side) -> Option<&str> {
    file.hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .find(|l| l.number(side) == Some(line))
        .map(|l| l.text.as_str())
}

pub fn in_hunks(file: &FileDiff, line: u32, side: Side) -> bool {
    text_at(file, line, side).is_some()
}

/// The lines selected in `diff` on the side the selection starts on. One crossing to the
/// other side is its first line alone, since the two sides number apart.
pub fn diff_anchor(diff: &DiffState) -> Option<Anchor> {
    let range = diff.selection()?;
    let file = diff.files().get(range.file)?;
    let side = range.start.side;
    let end = match range.end.side == side {
        true => range.end.line,
        false => range.start.line,
    };
    let (first, last) = (range.start.line.min(end), range.start.line.max(end));
    let lines = (first..=last)
        .filter_map(|line| text_at(file, line, side).map(String::from))
        .collect();
    Some(Anchor::Diff {
        path: file.path().into(),
        side,
        first,
        last,
        lines,
    })
}

/// What a point on rune-kit's drawn Diff is over: the file, the row by its key, and that row's
/// line on each side.
#[derive(Debug, Clone, PartialEq)]
pub struct LinesAt {
    pub file: usize,
    pub row: String,
    pub old: Option<u32>,
    pub new: Option<u32>,
}

impl LinesAt {
    pub fn on(&self, side: Side) -> Option<u32> {
        match side {
            Side::Old => self.old,
            Side::New => self.new,
        }
    }
}

/// The lines at the drawn element `path`, by the key rune-kit gives its row: `df{file}.c{old}`
/// for an unchanged line, `.o{old}` for a removed one (in split, one beside the line that
/// replaced it), `.n{new}` for an added one. In split, the half it is in keeps one side.
pub fn lines_at(diff: &DiffState, path: &str) -> Option<LinesAt> {
    let (_, drawn) = path.split_once("/rows/")?;
    let mut parts = drawn.split('/');
    let row = parts.next()?;
    let (file, line) = row.strip_prefix("df")?.split_once('.')?;
    let file: usize = file.parse().ok()?;
    let drawn = diff.files().get(file)?;
    let half = match parts.find(|p| *p != "line") {
        Some("notes") => return None,
        Some("old") => Some(Side::Old),
        Some("new") => Some(Side::New),
        _ => None,
    };
    let n: u32 = line.get(1..)?.parse().ok()?;
    let (old, new) = match &line[..1] {
        "c" => (Some(n), new_of(drawn, n)),
        "o" if half == Some(Side::New) => (None, partner(drawn, n)),
        "o" => (Some(n), None),
        "n" => (None, Some(n)),
        _ => return None,
    };
    let (old, new) = match half {
        Some(Side::Old) => (old, None),
        Some(Side::New) => (None, new),
        None => (old, new),
    };
    (old.is_some() || new.is_some()).then(|| LinesAt {
        file,
        row: row.into(),
        old,
        new,
    })
}

/// One past the last line a hunk covers on a side, from its header's start and count.
fn past(start: u32, count: u32) -> u32 {
    if count == 0 { start + 1 } else { start + count }
}

/// An unchanged line's number as the file is now, from its number as it was.
fn new_of(file: &FileDiff, old: u32) -> Option<u32> {
    let mut shift = 0i64;
    for hunk in &file.hunks {
        if let Some(line) = hunk.lines.iter().find(|l| l.old == Some(old)) {
            return line.new;
        }
        let (old_end, new_end) = (
            past(hunk.old_start, hunk.old_count),
            past(hunk.new_start, hunk.new_count),
        );
        if old_end > old {
            break;
        }
        shift = i64::from(new_end) - i64::from(old_end);
    }
    u32::try_from(i64::from(old) + shift).ok()
}

/// The added line split mode draws beside removed line `old`: the same place in the run of
/// added lines that follows its run of removed ones.
fn partner(file: &FileDiff, old: u32) -> Option<u32> {
    let removed = |l: &Line| l.kind == LineKind::Removed;
    file.hunks.iter().find_map(|hunk| {
        let lines = &hunk.lines;
        let i = lines
            .iter()
            .position(|l| removed(l) && l.old == Some(old))?;
        let first = lines[..i]
            .iter()
            .rposition(|l| !removed(l))
            .map_or(0, |p| p + 1);
        let added = i + lines[i..].iter().take_while(|l| removed(l)).count();
        let at = added + (i - first);
        lines
            .get(added..=at)?
            .iter()
            .all(|l| l.kind == LineKind::Added)
            .then(|| lines[at].new)?
    })
}

const QUOTE_MAX: usize = 300;

/// The quote as `>` lines, a long one kept to its start and end.
fn quoted(quote: &str) -> String {
    let chars: Vec<char> = quote.chars().collect();
    let cut = match chars.len() <= QUOTE_MAX {
        true => quote.to_string(),
        false => {
            let head = (QUOTE_MAX - 1).div_ceil(2);
            let tail = QUOTE_MAX - 1 - head;
            let start: String = chars[..head].iter().collect();
            let end: String = chars[chars.len() - tail..].iter().collect();
            format!("{start}…{end}")
        }
    };
    cut.split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn quote_of(anchor: &Anchor) -> String {
    match anchor {
        Anchor::Plan { quote, .. } => quote.clone(),
        Anchor::Diff { lines, .. } => lines.join("\n"),
    }
}

fn location_of(anchor: &Anchor) -> String {
    match anchor {
        Anchor::Plan { file, .. } => format!("the plan's `{file}`"),
        Anchor::Diff {
            path,
            side,
            first,
            last,
            ..
        } => {
            let lines = match first == last {
                true => first.to_string(),
                false => format!("{first}-{last}"),
            };
            let was = if *side == Side::Old {
                " (as it was)"
            } else {
                ""
            };
            format!("`{path}:{lines}`{was}")
        }
    }
}

fn counted(drafts: &[Draft]) -> String {
    let s = if drafts.len() == 1 { "" } else { "s" };
    format!("{} review comment{s}", drafts.len())
}

/// The one message the drafts are sent as.
pub fn compose(drafts: &[Draft]) -> String {
    let mut message = vec![format!(
        "{} from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.",
        counted(drafts)
    )];
    message.extend(drafts.iter().enumerate().map(|(at, draft)| {
        format!(
            "{}. {}\n{}\n\n{}",
            at + 1,
            location_of(&draft.anchor),
            quoted(&quote_of(&draft.anchor)),
            draft.text
        )
    }));
    if drafts
        .iter()
        .any(|d| matches!(d.anchor, Anchor::Plan { .. }))
    {
        message.push("Revise the plan and tickets where these comments call for changes. Preserve the Run's scope and constraints. Leave its next-choice menu unanswered.".into());
    }
    message.join("\n\n")
}
