//! What agent-written markdown may keep, as `markdown.ts` says for Comark, re-expressed for
//! rune-kit's Markdown. rune-kit draws no raw HTML, so no style, popover or command can
//! reach the window; what is left is rewriting the source before it is drawn
//! ([`confined`]) and refusing what a link may open ([`opened`]).

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::ops::Range;
use std::sync::LazyLock;

/// The scheme a `file:line` reference is linked with.
const FILE_REF: &str = "collie-file:";

static FILE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^((?:[A-Za-z0-9_@.-]+/)*[A-Za-z0-9_@-][A-Za-z0-9_@.-]*\.[A-Za-z][A-Za-z0-9_]*):(\d+)",
    )
    .unwrap()
});
static WEB_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://\S+$").unwrap());

/// What following a link opens.
#[derive(Debug, Clone, PartialEq)]
pub enum Opened {
    Web(String),
    File { file: String, line: u32 },
}

/// What `url` may open: a web page or a `file:line`, and nothing else.
pub fn opened(url: &str) -> Option<Opened> {
    if let Some(at) = url.strip_prefix(FILE_REF) {
        let (file, line) = at.rsplit_once(':')?;
        return Some(Opened::File {
            file: file.into(),
            line: line.parse().ok()?,
        });
    }
    WEB_URL.is_match(url).then(|| Opened::Web(url.into()))
}

/// Whether a link to `url` could run script or load something other than a page: a scheme
/// other than the web's or mail's, read past the whitespace a browser would skip.
fn scripted(url: &str) -> bool {
    let bare: String = url
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect::<String>()
        .to_ascii_lowercase();
    let scheme = bare.split_once(':').map(|(scheme, _)| scheme);
    scheme.is_some_and(|scheme| {
        scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
            && !["http", "https", "mailto"].contains(&scheme)
    })
}

/// A URL without its scheme or trailing slash, elided in the middle past 60 characters.
pub fn short_url(url: &str) -> String {
    let shown = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let shown = shown.strip_suffix('/').unwrap_or(shown);
    let chars: Vec<char> = shown.chars().collect();
    match chars.len() > 60 {
        true => format!(
            "{}…{}",
            chars[..40].iter().collect::<String>(),
            chars[chars.len() - 15..].iter().collect::<String>()
        ),
        false => shown.into(),
    }
}

/// `decodeURI`: percent-escapes decoded, except those of characters a URI reserves.
fn decoded(href: &str) -> String {
    let bytes = href.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[at], hex) {
            (b'%', Some(byte)) if !b";/?:@&=+$,#".contains(&byte) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| href.into())
}

fn escaped(text: &str) -> String {
    text.chars()
        .flat_map(|c| match "\\[]*_`<>".contains(c) {
            true => vec!['\\', c],
            false => vec![c],
        })
        .collect()
}

fn link(text: &str, url: &str) -> String {
    format!("[{text}](<{url}>)")
}

/// Each `file:line` in `text`, by its byte range, as `markdown.ts`'s `FILE_LINE` finds them:
/// not inside a longer path, URL or word, and not followed by more of one.
fn file_lines(text: &str) -> Vec<(Range<usize>, String)> {
    let mut found = Vec::new();
    let mut from = 0;
    for (at, _) in text.char_indices() {
        let before = text[..at].chars().next_back();
        if at < from || before.is_some_and(|c| c.is_ascii_alphanumeric() || "_/:.@-".contains(c)) {
            continue;
        }
        let Some(hit) = FILE_LINE.find(&text[at..]) else {
            continue;
        };
        let end = at + hit.end();
        let after = text[end..].chars().next();
        if after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':') {
            continue;
        }
        found.push((at..end, hit.as_str().to_string()));
        from = end;
    }
    found
}

/// The open link: where it is in the source, where it goes, and the text it shows.
struct Open {
    range: Range<usize>,
    url: String,
    kind: LinkType,
    text: String,
}

/// `src` rewritten so that rune-kit draws what `markdown.ts` lets Comark draw: each
/// `file:line` outside code and links a link to it; a link that is its own URL short, still
/// going to the whole URL; inline code that is only a web URL a link to it; and a link to a
/// script URL its words alone.
pub fn confined(src: &str) -> String {
    let opts = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();
    let mut open: Option<Open> = None;
    let (mut in_code_block, mut in_image) = (false, 0);
    for (event, range) in Parser::new_ext(src, opts).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Image { .. }) => in_image += 1,
            Event::End(TagEnd::Image) => in_image -= 1,
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => {
                open = Some(Open {
                    range,
                    url: dest_url.into_string(),
                    kind: link_type,
                    text: String::new(),
                })
            }
            Event::End(TagEnd::Link) => {
                let Some(link_open) = open.take() else {
                    continue;
                };
                let Open {
                    range,
                    url,
                    kind,
                    text,
                } = link_open;
                if scripted(&url) {
                    edits.push((range, escaped(&text)));
                } else if WEB_URL.is_match(&url)
                    && (text == url || text == decoded(&url) || kind == LinkType::Autolink)
                {
                    edits.push((range, link(&escaped(&short_url(&text)), &url)));
                }
            }
            Event::Text(text) | Event::Code(text) if open.is_some() => {
                open.as_mut().unwrap().text.push_str(&text)
            }
            Event::Code(code) if in_image == 0 => {
                if file_lines(&code)
                    .first()
                    .is_some_and(|(r, _)| r.len() == code.len())
                {
                    edits.push((range, link(&escaped(&code), &format!("{FILE_REF}{code}"))));
                } else if WEB_URL.is_match(&code) {
                    let short = format!("`{}`", short_url(&code));
                    edits.push((range, link(&short, &code)));
                }
            }
            Event::Text(text) if !in_code_block && in_image == 0 && src[range.clone()] == *text => {
                for (at, reference) in file_lines(&text) {
                    let at = range.start + at.start..range.start + at.end;
                    edits.push((
                        at,
                        link(&escaped(&reference), &format!("{FILE_REF}{reference}")),
                    ));
                }
            }
            _ => {}
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    let mut out = src.to_string();
    for (range, with) in edits.into_iter().rev() {
        out.replace_range(range, &with);
    }
    out
}
