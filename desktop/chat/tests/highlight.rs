//! The plugged-in highlighter colours languages rune-kit's 13 scanners do and one they do
//! not, and a block past rune-kit's 32 KiB to its end.

use collie_desktop_chat::highlight::syntect;
use rune_kit::syntax::{Highlight, Highlighter, Paint, Syntax, builtin};

/// The kind of the highlight that covers `word` in `code`.
fn kind_of(found: &[Highlight], code: &str, word: &str) -> Option<Syntax> {
    let at = code
        .find(word)
        .unwrap_or_else(|| panic!("{word} in the code"));
    found.iter().find_map(|(range, paint)| match paint {
        Paint::Kind(kind) if range.start <= at && at + word.len() <= range.end => Some(*kind),
        _ => None,
    })
}

#[test]
fn typescript_is_coloured_by_its_grammar() {
    let code = "const greeting: string = \"hello\"; // said once\n";
    let found = syntect(Some("ts"), code);
    assert_eq!(kind_of(&found, code, "const"), Some(Syntax::Keyword));
    assert_eq!(kind_of(&found, code, "\"hello\""), Some(Syntax::String));
    assert_eq!(kind_of(&found, code, "// said once"), Some(Syntax::Comment));
    assert_eq!(kind_of(&found, code, "string"), Some(Syntax::Type));
}

#[test]
fn rust_is_coloured_by_its_grammar() {
    let code = "fn main() {\n    let answer = 42;\n}\n";
    let found = syntect(Some("rust"), code);
    assert_eq!(kind_of(&found, code, "fn"), Some(Syntax::Keyword));
    assert_eq!(kind_of(&found, code, "main"), Some(Syntax::Function));
    assert_eq!(kind_of(&found, code, "42"), Some(Syntax::Number));
}

#[test]
fn bash_is_coloured_by_its_grammar() {
    let code = "echo \"hi there\" # a comment\n";
    let found = syntect(Some("bash"), code);
    assert_eq!(kind_of(&found, code, "\"hi there\""), Some(Syntax::String));
    assert_eq!(kind_of(&found, code, "# a comment"), Some(Syntax::Comment));
}

#[test]
fn nix_which_rune_kits_scanners_do_not_know_is_coloured_too() {
    let code = "{ pkgs ? import <nixpkgs> {} }:\n# the shell\npkgs.mkShell { buildInputs = [ pkgs.hello ]; }\n";
    assert!(
        builtin(Some("nix"), code).is_empty(),
        "Nix is outside rune-kit's 13"
    );
    let found = syntect(Some("nix"), code);
    assert_eq!(kind_of(&found, code, "# the shell"), Some(Syntax::Comment));
    assert!(found.len() > 3, "{found:?}");
}

#[test]
fn a_language_no_grammar_names_stays_plain() {
    assert!(syntect(Some("no-such-language"), "a = b").is_empty());
    assert!(syntect(None, "a = b").is_empty());
}

#[test]
fn a_block_past_32_kib_is_coloured_to_its_end_but_rune_kit_colours_only_its_first_32_kib() {
    let line = "let value = \"some text\"; // a comment\n";
    let code = line.repeat(64 * 1024 / line.len() + 1);
    assert!(code.len() > 64 * 1024);
    let found = syntect(Some("rust"), &code);
    let last = found.iter().map(|(range, _)| range.end).max().unwrap();
    assert!(
        last > code.len() - line.len(),
        "coloured to {last} of {}",
        code.len()
    );
    let through_markdown = Highlighter::new(syntect).highlight(Some("rust"), &code);
    let last = through_markdown
        .iter()
        .map(|(range, _)| range.end)
        .max()
        .unwrap();
    assert!(last <= 32 * 1024, "rune-kit cut it at {last}");
}
