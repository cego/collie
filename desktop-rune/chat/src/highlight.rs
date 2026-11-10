//! Code blocks coloured by syntect with `two-face`'s grammars, plugged into rune-kit's
//! Markdown beside its built-in scanners, so the gate can choose between them. Scopes become
//! rune-kit's token kinds, so the kit's theme colours both alike.

use rune_kit::syntax::{Highlight, Paint, Syntax};
use std::sync::LazyLock;
use syntect::easy::ScopeRangeIterator;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxSet};
use syntect::util::LinesWithEndings;

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

/// Inside a comment or string, all of it is that.
static WHOLE: LazyLock<[(Scope, Syntax); 2]> = LazyLock::new(|| {
    [
        (Scope::new("comment").unwrap(), Syntax::Comment),
        (Scope::new("string").unwrap(), Syntax::String),
    ]
});

/// The innermost scope a prefix here names decides; earlier prefixes first.
static KINDS: LazyLock<Vec<(Scope, Syntax)>> = LazyLock::new(|| {
    [
        ("markup.inserted", Syntax::Inserted),
        ("markup.deleted", Syntax::Deleted),
        ("constant.character", Syntax::String),
        ("constant", Syntax::Number),
        ("keyword.operator", Syntax::Punctuation),
        ("keyword", Syntax::Keyword),
        ("storage", Syntax::Keyword),
        ("entity.name.function", Syntax::Function),
        ("support.function", Syntax::Function),
        ("variable.function", Syntax::Function),
        ("support.type.property-name", Syntax::Property),
        ("entity.name.type", Syntax::Type),
        ("entity.name.class", Syntax::Type),
        ("support.type", Syntax::Type),
        ("support.class", Syntax::Type),
        ("entity.other.attribute-name", Syntax::Property),
        ("variable.other.member", Syntax::Property),
        ("variable.other.property", Syntax::Property),
        ("meta.mapping.key", Syntax::Property),
        ("punctuation", Syntax::Punctuation),
    ]
    .into_iter()
    .map(|(prefix, kind)| (Scope::new(prefix).unwrap(), kind))
    .collect()
});

fn kind_of(stack: &ScopeStack) -> Option<Syntax> {
    let scopes = stack.as_slice();
    let whole = WHOLE
        .iter()
        .find(|(prefix, _)| scopes.iter().any(|scope| prefix.is_prefix_of(*scope)));
    if let Some((_, kind)) = whole {
        return Some(*kind);
    }
    scopes.iter().rev().find_map(|scope| {
        KINDS
            .iter()
            .find(|(prefix, _)| prefix.is_prefix_of(*scope))
            .map(|(_, kind)| *kind)
    })
}

/// `code` in `lang` as token kinds; nothing for a language no grammar names.
pub fn syntect(lang: Option<&str>, code: &str) -> Vec<Highlight> {
    let Some(syntax) = lang.and_then(|lang| SYNTAXES.find_syntax_by_token(lang)) else {
        return Vec::new();
    };
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut found: Vec<Highlight> = Vec::new();
    let mut offset = 0;
    for line in LinesWithEndings::from(code) {
        let ops = state.parse_line(line, &SYNTAXES).unwrap_or_default();
        for (range, op) in ScopeRangeIterator::new(&ops, line) {
            let _ = stack.apply(op);
            let (start, end) = (offset + range.start, offset + range.end);
            let Some(kind) = kind_of(&stack).filter(|_| start < end) else {
                continue;
            };
            match found.last_mut() {
                Some((last, Paint::Kind(was))) if last.end == start && *was == kind => {
                    last.end = end
                }
                _ => found.push((start..end, Paint::Kind(kind))),
            }
        }
        offset += line.len();
    }
    found
}

/// Whether a two-face grammar names `lang`.
pub fn knows(lang: &str) -> bool {
    SYNTAXES.find_syntax_by_token(lang).is_some()
}
