//! A Run's review comment drafts, what each is about, and the one message they are sent as
//! (ADR-0051): `review-comments.ts`, with diff anchors taken from rune-kit's Diff selection.

use rune_kit::diff::{DiffState, FileDiff, Side};

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
