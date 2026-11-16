//! What the human does in a pane's terminal, and the little the view reads off a line it
//! draws: where its links are (`desktop/src/shared/terminal-input.ts`).

use collie_desktop_protocol::generated::At;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Held {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pointer {
    pub x: f64,
    pub y: f64,
    pub held: Held,
}

/// The terminal's drawn screen in the window, and its size in cells.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub cols: u16,
    pub rows: u16,
}

/// The zero-based cell under the pointer, kept inside the screen.
pub fn cell_at(pointer: &Pointer, screen: &Screen) -> (i64, i64) {
    let clamp = |at: f64, size: u16| (at.floor() as i64).clamp(0, i64::from(size) - 1);
    (
        clamp(
            (pointer.x - screen.left) / screen.width * f64::from(screen.cols),
            screen.cols,
        ),
        clamp(
            (pointer.y - screen.top) / screen.height * f64::from(screen.rows),
            screen.rows,
        ),
    )
}

/// A mouse report xterm.js writes itself.
pub fn is_mouse_report(text: &str) -> bool {
    let Some(report) = text.strip_prefix("\u{1b}[") else {
        return false;
    };
    if let Some(sgr) = report.strip_prefix('<') {
        let Some(numbers) = sgr.strip_suffix(['M', 'm']) else {
            return false;
        };
        let parts: Vec<&str> = numbers.split(';').collect();
        return parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    }
    report
        .strip_prefix('M')
        .is_some_and(|rest| rest.chars().count() == 3)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Key {
    pub key: String,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
}

/// Ctrl or Cmd with Shift and F: Focus on the terminal, or Restore, from anywhere in the Flow.
pub fn is_focus_key(key: &Key) -> bool {
    key.key.to_lowercase() == "f" && key.shift && (key.ctrl || key.meta)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Pane,
    Copy,
    Paste,
    Focus,
}

/// What a key pressed in the terminal does: reaches the pane; copies the selection, as Ctrl+C
/// does while there is one; pastes the clipboard; or toggles Focus.
pub fn key_action(key: &Key, has_selection: bool) -> KeyAction {
    if is_focus_key(key) {
        return KeyAction::Focus;
    }
    let letter = key.key.to_lowercase();
    if letter == "c" && (key.meta || (key.ctrl && (key.shift || has_selection))) {
        return KeyAction::Copy;
    }
    if letter == "v" && (key.meta || (key.ctrl && key.shift)) {
        return KeyAction::Paste;
    }
    KeyAction::Pane
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub url: String,
    pub start: usize,
    pub end: usize,
}

/// The web links in a drawn line, by the one-based columns they span.
pub fn links_in(line: &str) -> Vec<Link> {
    let chars: Vec<char> = line.chars().collect();
    let in_url = |c: char| !c.is_whitespace() && !matches!(c, '"' | '\'' | '<' | '>');
    let mut links = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let rest: String = chars[at..].iter().take(8).collect();
        let scheme = ["https://", "http://"]
            .into_iter()
            .find(|scheme| rest.starts_with(scheme))
            .map_or(0, str::len);
        let tail = chars[at + scheme..]
            .iter()
            .take_while(|c| in_url(**c))
            .count();
        if scheme == 0 || tail == 0 {
            at += 1;
            continue;
        }
        let end = at + scheme + tail;
        links.push(Link {
            url: chars[at..end].iter().collect(),
            start: at + 1,
            end,
        });
        at = end;
    }
    links
}

/// Where a pane is, as its card says it: Machine › workspace › tab.
pub fn pane_where(machine: &str, at: &At) -> String {
    [
        Some(machine),
        Some(at.workspace.as_str()),
        at.tab.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" › ")
}

/// A pane on its card's one line, whose footer names the Machine: tab · workspace.
pub fn pane_line(at: &At) -> String {
    [at.tab.as_deref(), Some(at.workspace.as_str())]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}
