//! Each construct rune-kit's Markdown draws otherwise than Desktop's view, counted over a corpus
//! of agent messages, as the notes' table.

use crate::highlight;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// What rune-kit's Markdown does with a construct, under its own highlighter and syntect.
type Row = (String, &'static str, &'static str);

/// rune-kit's colouring stops here, whichever highlighter is plugged in.
const COLOURED: usize = 32 * 1024;

pub fn constructs(src: &str) -> Vec<Row> {
    let mut found = Vec::new();
    let mut fence: Option<(String, String)> = None;
    for event in Parser::new_ext(src, Options::all()) {
        match event {
            Event::Html(_) | Event::InlineHtml(_) => {
                found.push(("raw HTML".into(), "dropped, block content with it", "same"))
            }
            Event::Start(Tag::Image { .. }) => {
                found.push(("image".into(), "its alt text only", "same"))
            }
            Event::FootnoteReference(_) | Event::Start(Tag::FootnoteDefinition(_)) => {
                found.push(("footnote".into(), "literal `[^n]` text", "same"))
            }
            Event::InlineMath(_) | Event::DisplayMath(_) => {
                found.push(("math".into(), "literal `$` text", "same"))
            }
            Event::Start(Tag::DefinitionList) => {
                found.push(("definition list".into(), "plain paragraphs", "same"))
            }
            Event::Start(Tag::BlockQuote(Some(_))) => {
                found.push(("GFM alert".into(), "a quote with literal `[!KIND]`", "same"))
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let lang = info.split_whitespace().next().unwrap_or("").to_string();
                fence = Some((lang, String::new()));
            }
            Event::Text(text) if fence.is_some() => fence.as_mut().unwrap().1.push_str(&text),
            Event::Text(text) => {
                if text.lines().any(|line| line.trim_start().starts_with("::")) {
                    found.push(("`::` component".into(), "literal text", "same"))
                }
            }
            Event::End(pulldown_cmark::TagEnd::CodeBlock) => {
                let Some((lang, code)) = fence.take() else {
                    continue;
                };
                if code.len() > COLOURED {
                    found.push(("code over 32 KiB".into(), "plain past 32 KiB", "same"));
                }
                if lang == "mermaid" {
                    if !rune_kit::mermaid::supported(&code) {
                        let kind = code.split_whitespace().next().unwrap_or("").to_string();
                        found.push((format!("mermaid `{kind}`"), "its source as code", "same"));
                    }
                    continue;
                }
                if lang.is_empty() || rune_kit::syntax::known(&lang) {
                    continue;
                }
                let under_syntect = if highlight::knows(&lang) {
                    "coloured"
                } else {
                    "plain"
                };
                found.push((format!("code `{lang}`"), "plain", under_syntect));
            }
            _ => {}
        }
    }
    found
}

pub fn largest_block(src: &str) -> usize {
    let mut largest = 0;
    let mut open = None;
    for event in Parser::new_ext(src, Options::all()) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => open = Some(0),
            Event::Text(text) if open.is_some() => *open.as_mut().unwrap() += text.len(),
            Event::End(pulldown_cmark::TagEnd::CodeBlock) => {
                largest = largest.max(open.take().unwrap_or(0))
            }
            _ => {}
        }
    }
    largest
}

/// The corpus's `*.md` messages, by name.
pub fn messages(dir: &Path) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            (name, std::fs::read_to_string(&p).unwrap())
        })
        .collect();
    found.sort();
    found
}

/// The notes' table of `messages`.
pub fn table(messages: &[(String, String)]) -> String {
    // construct -> (rune-kit, syntect, occurrences, messages)
    let mut rows: BTreeMap<String, (&str, &str, usize, usize)> = BTreeMap::new();
    let mut largest = 0;
    for (_, src) in messages {
        largest = largest.max(largest_block(src));
        let mut seen = BTreeSet::new();
        for (name, kit, syntect) in constructs(src) {
            let row = rows.entry(name.clone()).or_insert((kit, syntect, 0, 0));
            row.2 += 1;
            if seen.insert(name) {
                row.3 += 1;
            }
        }
    }
    let mut out = format!(
        "{} messages; largest code block {largest} bytes.\n\n",
        messages.len()
    );
    out.push_str(
        "| Construct | rune-kit highlighter | syntect + two-face | Occurrences | Messages |\n",
    );
    out.push_str("|---|---|---|---|---|\n");
    for (name, (kit, syntect, count, seen)) in rows {
        out.push_str(&format!(
            "| {name} | {kit} | {syntect} | {count} | {seen} |\n"
        ));
    }
    out
}
