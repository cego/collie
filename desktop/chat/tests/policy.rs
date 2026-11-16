//! `desktop/test/markdown.test.ts`, on rune-kit: each case's markdown, confined, as rune-kit
//! parses it to draw. rune-kit draws no HTML element at all, so the cases about elements'
//! styles, popovers and commands hold with the element gone and its text kept.

use collie_desktop_chat::policy::{Opened, confined, opened};
use rune_kit::markdown::{Block, Inline, Style, parse};

fn drawn(src: &str) -> Vec<Block> {
    parse(&confined(src))
}

fn para(text: &str) -> Block {
    Block::Para(Inline {
        text: text.into(),
        ..Inline::default()
    })
}

fn linked(text: &str, links: &[(usize, usize, &str)]) -> Block {
    Block::Para(Inline {
        text: text.into(),
        spans: links
            .iter()
            .map(|(start, end, _)| (*start, *end, Style::Link))
            .collect(),
        links: links
            .iter()
            .map(|(start, end, url)| (*start, *end, url.to_string()))
            .collect(),
    })
}

#[test]
fn no_element_keeps_a_style_of_its_own() {
    assert_eq!(
        drawn("x <span style=\"a\">hi</span>\n\n<div style=\"position:fixed\">over all</div>\n"),
        [para("x hi"), para("over all")]
    );
}

#[test]
fn nothing_can_be_made_a_popover_which_no_box_contains() {
    assert_eq!(
        drawn(
            "Press <button popovertarget=\"p\" popovertargetaction=\"show\">Open</button> <span id=\"p\" popover>over all</span>"
        ),
        [para("Press Open over all")]
    );
}

#[test]
fn nothing_can_open_a_dialog_by_command() {
    assert_eq!(
        drawn(
            "Press <button commandfor=\"d\" command=\"show-modal\">Open</button> <span closedby=\"none\">held</span> <dialog open>shown</dialog>"
        ),
        [para("Press Open held shown")]
    );
}

#[test]
fn nothing_inside_a_block_a_link_or_code_keeps_a_style_popover_or_command_either() {
    assert_eq!(
        drawn("> <span popover style=\"position:fixed\">over</span>\n"),
        [Block::Quote(vec![para("over")])]
    );
    assert_eq!(
        drawn("[<button command=\"show-popover\">go</button>](https://a.dk/)"),
        [linked("go", &[(0, 2, "https://a.dk/")])]
    );
    let Block::Para(code) = &drawn("`<span popover>x</span>`")[0] else {
        panic!("a paragraph")
    };
    assert!(
        code.text.contains("<span popover>x</span>"),
        "code shows its text: {code:?}"
    );
}

#[test]
fn no_link_keeps_a_script_url_whatever_it_is_called() {
    assert_eq!(
        drawn(
            "[go](javascript:alert(1)) [pic](data:text/html,x) [card](<JaVa ScRiPt:alert(1)>) ::prose-card{to=\"javascript:x\"}"
        ),
        [para("go pic card ::prose-card{to=\"javascript:x\"}")]
    );
    for url in [
        "javascript:alert(1)",
        " JaVa\tScRiPt:alert(1)",
        "data:text/html,x",
        "vbscript:x",
    ] {
        assert_eq!(opened(url), None, "{url:?}");
    }
    assert_eq!(
        opened("https://example.com/a"),
        Some(Opened::Web("https://example.com/a".into()))
    );
}

#[test]
fn a_file_line_in_text_is_a_reference_and_the_text_around_it_stays() {
    assert_eq!(
        drawn("See src/seed.ts:12, and README.md:3."),
        [linked(
            "See src/seed.ts:12, and README.md:3.",
            &[
                (4, 18, "collie-file:src/seed.ts:12"),
                (24, 35, "collie-file:README.md:3")
            ]
        )]
    );
    assert_eq!(
        opened("collie-file:src/seed.ts:12"),
        Some(Opened::File {
            file: "src/seed.ts".into(),
            line: 12
        })
    );
}

#[test]
fn inline_code_that_is_only_a_file_line_is_a_reference_too() {
    assert_eq!(
        drawn("`src/a.ts:7`"),
        [linked("src/a.ts:7", &[(0, 10, "collie-file:src/a.ts:7")])]
    );
}

#[test]
fn a_port_a_time_code_blocks_and_links_are_not_references() {
    let kept = "On localhost:8080 at 10:30, see https://x.dk/a.ts:4\n\n```\nsrc/a.ts:7\n```\n\n[src/b.ts:2](https://x.dk/b)\n";
    assert_eq!(confined(kept), kept);
}

const LONG: &str = "https://gitlab.cego.dk/some-group/some-project/-/merge_requests/1234/diffs?commit_id=0123456789abcdef0123456789abcdef01234567";
const SHORT: &str = "gitlab.cego.dk/some-group/some-project/-…9abcdef01234567";

#[test]
fn a_link_that_is_its_own_url_is_drawn_short_and_still_goes_to_the_whole_url() {
    let short = linked(SHORT, &[(0, SHORT.len(), LONG)]);
    assert_eq!(
        drawn(&format!("[{LONG}]({LONG})")),
        std::slice::from_ref(&short)
    );
    assert_eq!(drawn(&format!("<{LONG}>")), [short]);
}

#[test]
fn a_markdown_link_keeps_the_words_it_was_given() {
    let kept = format!("[the MR]({LONG})");
    assert_eq!(confined(&kept), kept);
}

#[test]
fn inline_code_that_is_only_a_web_url_is_a_link_to_it_and_a_script_url_is_not() {
    let blocks = drawn(
        "`https://example.com/a/` `javascript:alert(1)`\n\n```\nhttps://example.com/b\n```\n",
    );
    let Block::Para(line) = &blocks[0] else {
        panic!("a paragraph")
    };
    let link = &line.links[0];
    assert_eq!(link.2, "https://example.com/a/");
    assert_eq!(
        &line.text[link.0..link.1].trim_matches('\u{202f}'),
        &"example.com/a"
    );
    assert!(
        line.spans
            .iter()
            .any(|(s, e, style)| *style == Style::Code && &line.text[*s..*e] == "example.com/a")
    );
    assert_eq!(line.links.len(), 1, "the script URL is no link");
    assert!(line.text.contains("javascript:alert(1)"));
    assert_eq!(blocks[1], Block::Code("https://example.com/b".into()));
}

#[test]
fn a_link_is_its_own_url_however_the_parser_encoded_its_address() {
    let href = "https://example.com/%C3%A6ble?a=b%7Cc%20d";
    let shown = "example.com/æble?a=b|c d";
    assert_eq!(
        drawn(&format!("[https://example.com/æble?a=b|c d]({href})")),
        [linked(shown, &[(0, shown.len(), href)])]
    );
}

#[test]
fn raw_html_keeps_its_words_and_a_details_block_its_summary() {
    assert_eq!(
        drawn("<details><summary>Which</summary>\n\nThe sweep and the bump.\n\n</details>\n"),
        drawn("**Which**\n\nThe sweep and the bump.\n")
    );
    assert_eq!(drawn("one<br>two"), drawn("one\\\ntwo"));
    assert_eq!(
        drawn("<p>Kept &amp; <em>read</em></p>\n"),
        drawn("Kept & read\n")
    );
}
