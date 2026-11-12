//! Terminal output as styled runs: SGR colours and weights kept, every other escape dropped
//! (`ansi.ts`). A tool row's output is drawn through it.

use regex::Regex;
use std::sync::LazyLock;

static ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[([\d;?]*)([A-Za-z])").unwrap());
/// Operating-system commands, such as a link's, and character-set choices.
static OTHER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()]\w").unwrap());

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Colour {
    /// One of the theme's sixteen.
    Theme(u8),
    Rgb(u8, u8, u8),
}

const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];

/// A 256-colour code: the first sixteen are the theme's, the rest fixed.
fn colour256(n: u8) -> Colour {
    match n {
        0..=15 => Colour::Theme(n),
        232..=255 => {
            let grey = 8 + 10 * (n - 232);
            Colour::Rgb(grey, grey, grey)
        }
        _ => {
            let at = (n - 16) as usize;
            Colour::Rgb(CUBE[at / 36], CUBE[(at / 6) % 6], CUBE[at % 6])
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Style {
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub fg: Option<Colour>,
    pub bg: Option<Colour>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnsiSpan {
    pub text: String,
    pub style: Style,
}

fn apply(style: &mut Style, codes: &[u32]) {
    let mut at = 0;
    while at < codes.len() {
        let code = codes[at];
        match code {
            0 => *style = Style::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = true,
            22 => (style.bold, style.dim) = (false, false),
            23 => style.italic = false,
            24 => style.underline = false,
            39 => style.fg = None,
            49 => style.bg = None,
            30..=37 => style.fg = Some(colour256((code - 30) as u8)),
            90..=97 => style.fg = Some(colour256((code - 82) as u8)),
            40..=47 => style.bg = Some(colour256((code - 40) as u8)),
            100..=107 => style.bg = Some(colour256((code - 92) as u8)),
            38 | 48 => {
                let colour = match codes.get(at + 1) {
                    Some(5) => {
                        let c = colour256(codes.get(at + 2).copied().unwrap_or(0).min(255) as u8);
                        at += 2;
                        Some(c)
                    }
                    Some(2) => {
                        let part =
                            |i: usize| codes.get(at + i).copied().unwrap_or(0).min(255) as u8;
                        let c = Colour::Rgb(part(2), part(3), part(4));
                        at += 4;
                        Some(c)
                    }
                    _ => None,
                };
                if code == 38 {
                    style.fg = colour.or(style.fg);
                } else {
                    style.bg = colour.or(style.bg);
                }
            }
            _ => {}
        }
        at += 1;
    }
}

pub fn ansi_spans(output: &str) -> Vec<AnsiSpan> {
    let text = OTHER.replace_all(output, "");
    let mut spans = Vec::new();
    let mut style = Style::default();
    let mut from = 0;
    for found in ESCAPE.captures_iter(&text) {
        let whole = found.get(0).unwrap();
        if whole.start() > from {
            spans.push(AnsiSpan {
                text: text[from..whole.start()].into(),
                style,
            });
        }
        from = whole.end();
        if &found[2] != "m" {
            continue;
        }
        let codes: Vec<u32> = match &found[1] {
            "" => vec![0],
            listed => listed.split(';').map(|c| c.parse().unwrap_or(0)).collect(),
        };
        apply(&mut style, &codes);
    }
    if from < text.len() {
        spans.push(AnsiSpan {
            text: text[from..].into(),
            style,
        });
    }
    spans
}

/// The spans of each line, with a colour still on carried to the lines after it.
pub fn ansi_lines(text: &str) -> Vec<Vec<AnsiSpan>> {
    let mut lines: Vec<Vec<AnsiSpan>> = vec![Vec::new()];
    for span in ansi_spans(text) {
        for (at, part) in span.text.split('\n').enumerate() {
            if at > 0 {
                lines.push(Vec::new());
            }
            if !part.is_empty() {
                lines.last_mut().unwrap().push(AnsiSpan {
                    text: part.into(),
                    style: span.style,
                });
            }
        }
    }
    lines
}

/// The text without its escapes, as copied.
pub fn plain(text: &str) -> String {
    ansi_spans(text).into_iter().map(|s| s.text).collect()
}
