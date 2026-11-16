//! Times each highlighter over the largest code block in a corpus of agent messages and over a
//! 10,000-line TypeScript block, whole and cut to the 32 KiB rune-kit's Markdown colours.
//! The built-in scanners stop at 32 KiB on their own.
//!
//! `cargo run --release -p collie-desktop-chat --example highlight-cost -- <corpus dir>`

use collie_desktop_chat::highlight::syntect;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use rune_kit::syntax::{Highlight, builtin};
use std::time::Instant;

fn largest(dir: &str) -> (String, String) {
    let mut found = (String::new(), String::new());
    for entry in std::fs::read_dir(dir).unwrap() {
        let src = std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default();
        let mut open: Option<(String, String)> = None;
        for event in Parser::new_ext(&src, Options::all()) {
            match event {
                Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                    open = Some((
                        info.split_whitespace().next().unwrap_or("").into(),
                        String::new(),
                    ))
                }
                Event::Text(text) if open.is_some() => open.as_mut().unwrap().1.push_str(&text),
                Event::End(TagEnd::CodeBlock) => {
                    let block = open.take().unwrap_or_default();
                    if block.1.len() > found.1.len() {
                        found = block;
                    }
                }
                _ => {}
            }
        }
    }
    found
}

fn timed(name: &str, lang: &str, code: &str, f: fn(Option<&str>, &str) -> Vec<Highlight>) {
    let mut best = f64::MAX;
    let mut spans = 0;
    for _ in 0..5 {
        let at = Instant::now();
        spans = f(Some(lang), code).len();
        best = best.min(at.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "| {name} | `{lang}`, {} bytes | {best:.2} ms | {spans} |",
        code.len()
    );
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("highlight-cost <corpus dir>");
    let (lang, block) = largest(&dir);
    let long: String = (0..10_000)
        .map(|n| {
            format!("export const value{n}: number = compute(\"item {n}\", {n}); // line {n}\n")
        })
        .collect();
    // What rune-kit's Markdown hands either highlighter at most.
    let cut = &long[..long[..32 * 1024].rfind('\n').unwrap() + 1];
    println!("| Highlighter | Block | Best of 5 | Spans |\n|---|---|---|---|");
    for (what, lang, code) in [
        ("largest corpus block", lang.as_str(), block.as_str()),
        ("10,000 lines", "ts", long.as_str()),
        ("its first 32 KiB", "ts", cut),
    ] {
        timed(&format!("rune-kit built-in, {what}"), lang, code, builtin);
        timed(&format!("syntect + two-face, {what}"), lang, code, syntect);
    }
}
