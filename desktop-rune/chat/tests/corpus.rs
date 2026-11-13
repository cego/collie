//! The checked-in corpus of agent messages, and the notes' table counted from it.

use collie_desktop_chat::corpus::{messages, table};
use std::path::Path;

const CORPUS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/corpus");
const README: &str = include_str!("../../README.md");

#[test]
fn at_least_thirty_agent_messages_are_checked_in() {
    let found = messages(Path::new(CORPUS));
    assert!(found.len() >= 30, "{} messages", found.len());
    assert!(found.iter().all(|(_, text)| !text.trim().is_empty()));
}

/// A line's cells, trimmed, so a formatter's padding and dash counts don't matter.
fn cells(line: &str) -> String {
    line.trim()
        .split('|')
        .map(|cell| match cell.trim() {
            dashes if !dashes.is_empty() && dashes.chars().all(|c| c == '-') => "-",
            cell => cell,
        })
        .collect::<Vec<_>>()
        .join("|")
}

#[test]
fn the_notes_table_is_what_the_corpus_counts() {
    let counted: Vec<String> = table(&messages(Path::new(CORPUS)))
        .lines()
        .map(cells)
        .collect();
    assert!(
        counted.iter().any(|l| l.contains("|Construct|")),
        "{counted:?}"
    );
    let noted: Vec<String> = README.lines().map(cells).collect();
    assert!(
        noted.windows(counted.len()).any(|w| w == counted),
        "README lacks:\n{}",
        counted.join("\n")
    );
}
