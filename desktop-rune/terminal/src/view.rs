//! A pane's terminal as Rune draws it, where Desktop has xterm.js: one monospaced line a row,
//! each run of cells sharing a style one span, the cursor's cell inverted; and what the human
//! does in it, sent on as `terminal-input` decides.

use crate::input::{Held, KeyAction, Pointer, Screen, key_action, mouse_of, pane_where, scroll_of};
use crate::keys::typed;
use crate::pane::Pane;
use crate::vt::{Cell, Frame, Rgb, Vt, XTERM_JS};
use base64::Engine;
use collie_desktop_protocol::client::RpcError;
use collie_desktop_protocol::generated::{
    ActionFailed, At, Command, TerminalEvent, TerminalInput, TerminalMouseAction, Type,
};
use ghostty_sys::{
    GHOSTTY_MOUSE_ACTION_MOTION, GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_ACTION_RELEASE,
    GHOSTTY_MOUSE_BUTTON_FIVE, GHOSTTY_MOUSE_BUTTON_FOUR, GHOSTTY_MOUSE_BUTTON_LEFT,
};
use rune::{Color, Drag, El, KeyEvent, Phase, Span, TextStyle, WheelEvent, col, rich, text};
use std::time::Instant;

/// The mono face at Ghostty's 12pt at 96 dpi, as Desktop's Terminal tab draws.
const FONT_SIZE: f32 = 16.0;
const LINE: f32 = 20.0;
/// A mono glyph's advance, as most monospaced faces have it.
const ADVANCE: f32 = 0.6 * FONT_SIZE;
/// A line of wheel, in points, as `terminal-input` counts it.
const WHEEL_LINE: f32 = 40.0;

/// One pane's terminal: its VT state, the frame last read from it, and its pane on the core.
pub struct Tab {
    vt: Vt,
    pub frame: Frame,
    pane: Option<Pane>,
    pub at: Option<At>,
    pub machine: String,
    pub ended: Option<String>,
    /// Whether it is core's raw stream, whose history and mouse reports are this view's own.
    on_core: bool,
    clock: Instant,
    laid_out: [f32; 2],
    /// Wheel travel not yet a whole line.
    wheel: f32,
    /// The first key awaiting its drawn echo, and output last shown, for Desktop's marks.
    pub keyed_at: std::cell::Cell<Option<f64>>,
    pub shown_at: Option<f64>,
}

impl Tab {
    pub fn new(pane: Option<Pane>, machine: String, cols: u16, rows: u16) -> Tab {
        let mut vt = Vt::new(cols, rows, &XTERM_JS);
        let frame = vt.frame();
        Tab {
            vt,
            frame,
            pane,
            at: None,
            machine,
            ended: None,
            on_core: false,
            clock: Instant::now(),
            laid_out: [0.0, 0.0],
            wheel: 0.0,
            keyed_at: std::cell::Cell::new(None),
            shown_at: None,
        }
    }

    fn send(&self, command: Command) {
        if let Some(pane) = &self.pane {
            pane.send(command);
        }
    }

    fn input(&self, bytes: &[u8]) {
        self.send(Command::TerminalInput(TerminalInput {
            r#type: Type::TerminalInput,
            text: String::from_utf8_lossy(bytes).into_owned(),
        }));
    }

    /// Why the `terminal` stream failed.
    pub fn failed(&mut self, error: RpcError<ActionFailed>) {
        self.ended = Some(match error {
            RpcError::Failed(failed) => failed.reason,
            other => other.to_string(),
        });
    }

    /// One event of the `terminal` stream.
    pub fn shown(&mut self, event: TerminalEvent) {
        match event {
            TerminalEvent::Opened(opened) => {
                self.on_core = opened.at.core.is_some();
                self.at = Some(opened.at);
                self.vt = Vt::new(self.vt.cols, self.vt.rows, &XTERM_JS);
                let size = (self.vt.cols, self.vt.rows);
                if let Some(pane) = &mut self.pane {
                    pane.opened(size);
                }
            }
            TerminalEvent::Frame(frame) => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(frame.bytes) {
                    self.vt.write(&bytes);
                    self.shown_at = Some(collie_desktop_protocol::epoch_ms());
                    // What the program asked the terminal, such as where its cursor is.
                    let replies = self.vt.take_replies();
                    if !replies.is_empty() {
                        self.input(&replies);
                    }
                }
            }
            TerminalEvent::Ended(ended) => self.ended = Some(ended.reason),
            TerminalEvent::NoPane(no_pane) => {
                self.ended = Some(format!(
                    "No pane to show: focused {}",
                    pane_where(&self.machine, &no_pane.at)
                ));
                self.at = Some(no_pane.at);
            }
        }
        self.frame = self.vt.frame();
    }

    /// Sends a size that has settled.
    pub fn tick(&mut self) {
        let now = self.clock.elapsed();
        if let Some(pane) = &mut self.pane {
            pane.tick(now);
        }
    }

    fn laid(&mut self, [_, _, w, h]: [f32; 4]) {
        if [w, h] == self.laid_out {
            return;
        }
        self.laid_out = [w, h];
        let cols = ((w / ADVANCE).floor() as u16).max(1);
        let rows = ((h / LINE).floor() as u16).max(1);
        if (cols, rows) == (self.vt.cols, self.vt.rows) {
            return;
        }
        self.vt.resize(cols, rows, ADVANCE as u32, LINE as u32);
        self.frame = self.vt.frame();
        let now = self.clock.elapsed();
        if let Some(pane) = &mut self.pane {
            pane.resized((cols, rows), now);
        }
    }

    fn key(&mut self, key: &KeyEvent) -> bool {
        let pressed = crate::input::Key {
            key: match &key.key {
                rune::Key::Text(text) => text.clone(),
                rune::Key::Command(c) => c.to_string(),
                other => format!("{other:?}"),
            },
            ctrl: key.mods.ctrl,
            meta: key.mods.logo || (cfg!(target_os = "macos") && key.mods.cmd),
            shift: key.mods.shift,
        };
        // No selection in the spike: Copy has nothing to copy, and Paste is Rune's own.
        if key_action(&pressed, false) != KeyAction::Pane {
            return false;
        }
        match typed(&mut self.vt, key) {
            Some(bytes) => {
                self.vt.scroll_to_bottom();
                self.input(&bytes);
                if self.keyed_at.get().is_none() {
                    self.keyed_at.set(Some(collie_desktop_protocol::epoch_ms()));
                }
                true
            }
            None => false,
        }
    }

    fn paste(&mut self, text: &str) {
        let bytes = self.vt.paste_bytes(text);
        self.input(&bytes);
    }

    fn screen(&self) -> Screen {
        Screen {
            left: 0.0,
            top: 0.0,
            width: f64::from(self.laid_out[0].max(1.0)),
            height: f64::from(self.laid_out[1].max(1.0)),
            cols: self.vt.cols,
            rows: self.vt.rows,
        }
    }

    fn wheel(&mut self, wheel: &WheelEvent) -> bool {
        // Rune's delta moves the content; the DOM's, which `terminal-input` reads, the view.
        let delta_y = -wheel.dy;
        let pointer = Pointer {
            x: f64::from(wheel.x),
            y: f64::from(wheel.y),
            held: Held {
                shift: wheel.mods.shift,
                ctrl: wheel.mods.ctrl,
                alt: wheel.mods.alt,
            },
        };
        if !self.on_core {
            if let Some(scroll) = scroll_of(f64::from(delta_y), &pointer, &self.screen()) {
                self.send(scroll);
            }
            return true;
        }
        self.wheel += delta_y;
        let lines = (self.wheel / WHEEL_LINE).trunc();
        self.wheel -= lines * WHEEL_LINE;
        if lines == 0.0 {
            return true;
        }
        if self.vt.mouse_tracking() {
            let button = if lines < 0.0 {
                GHOSTTY_MOUSE_BUTTON_FOUR
            } else {
                GHOSTTY_MOUSE_BUTTON_FIVE
            };
            for _ in 0..lines.abs() as usize {
                let report = self.vt.encode_mouse(
                    GHOSTTY_MOUSE_ACTION_PRESS,
                    Some(button),
                    0,
                    (wheel.x, wheel.y),
                    (ADVANCE as u32, LINE as u32),
                );
                self.input(&report);
            }
        } else {
            self.vt.scroll_viewport(lines as isize);
            self.frame = self.vt.frame();
        }
        true
    }

    fn drag(&mut self, drag: &Drag) {
        let pointer = Pointer {
            x: f64::from(drag.x),
            y: f64::from(drag.y),
            held: Held::default(),
        };
        if !self.on_core {
            let action = match drag.phase {
                Phase::Down => TerminalMouseAction::Down,
                Phase::Move => TerminalMouseAction::Drag,
                Phase::Up => TerminalMouseAction::Up,
            };
            if let Some(mouse) = mouse_of(action, 0, &pointer, &self.screen()) {
                self.send(mouse);
            }
            return;
        }
        if !self.vt.mouse_tracking() {
            return;
        }
        let action = match drag.phase {
            Phase::Down => GHOSTTY_MOUSE_ACTION_PRESS,
            Phase::Move => GHOSTTY_MOUSE_ACTION_MOTION,
            Phase::Up => GHOSTTY_MOUSE_ACTION_RELEASE,
        };
        let report = self.vt.encode_mouse(
            action,
            Some(GHOSTTY_MOUSE_BUTTON_LEFT),
            0,
            (drag.x, drag.y),
            (ADVANCE as u32, LINE as u32),
        );
        if !report.is_empty() {
            self.input(&report);
        }
    }

    /// Gives the pane back, as leaving the Terminal tab does, off the view's thread: the sends
    /// still queued go first.
    pub fn leave(self) {
        if let Some(pane) = self.pane {
            std::thread::spawn(move || pane.leave());
        }
    }
}

/// An sRGB colour as Rune's linear one.
fn color(Rgb(r, g, b): Rgb) -> Color {
    let linear = |v: u8| {
        let v = f32::from(v) / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    Color {
        r: linear(r),
        g: linear(g),
        b: linear(b),
        a: 1.0,
    }
}

type Style = (Rgb, Option<Rgb>, bool, bool, bool);

fn style_of(cell: &Cell, cursor: bool, bg: Rgb) -> Style {
    if cursor {
        return (
            cell.bg.unwrap_or(bg),
            Some(XTERM_JS.cursor),
            cell.bold,
            cell.italic,
            cell.underline,
        );
    }
    (cell.fg, cell.bg, cell.bold, cell.italic, cell.underline)
}

/// Row `y` as its text and a span for each run of one style.
pub fn row_spans(frame: &Frame, y: usize) -> (String, Vec<Span>) {
    let cursor = frame
        .cursor
        .filter(|c| usize::from(c.y) == y)
        .map(|c| usize::from(c.x));
    let mut content = String::new();
    let mut spans: Vec<Span> = Vec::new();
    let mut run: Option<(Style, usize)> = None;
    let close = |spans: &mut Vec<Span>, (style, start): (Style, usize), end: usize| {
        let (fg, bg, bold, italic, underline) = style;
        let mut span = Span::new(start, end).mono().color(color(fg));
        if bold {
            span = span.bold();
        }
        if italic {
            span = span.italic();
        }
        if underline {
            span = span.underline(color(fg));
        }
        if let Some(bg) = bg {
            span = span.bg(color(bg), 0.0);
        }
        spans.push(span);
    };
    for (x, cell) in frame.rows[y].iter().enumerate() {
        if cell.spacer {
            continue;
        }
        let style = style_of(cell, cursor == Some(x), frame.bg);
        let start = content.len();
        content.push_str(if cell.text.is_empty() {
            " "
        } else {
            &cell.text
        });
        match run {
            Some((same, _)) if same == style => {}
            Some(open) => {
                close(&mut spans, open, start);
                run = Some((style, start));
            }
            None => run = Some((style, start)),
        }
    }
    if let Some(open) = run {
        close(&mut spans, open, content.len());
    }
    (content, spans)
}

/// The terminal of `tab`, which `lens` finds in the app's state.
pub fn terminal<S: 'static>(tab: &Tab, lens: fn(&mut S) -> Option<&mut Tab>) -> El {
    let mono = TextStyle {
        line_height: LINE,
        ..TextStyle::new(FONT_SIZE, 400.0).mono()
    };
    let rows = (0..tab.frame.rows.len()).map(|y| {
        let (content, spans) = row_spans(&tab.frame, y);
        rich(content, spans)
            .font(mono)
            .key(format!("row-{y}"))
            .h(LINE)
    });
    let cursor = tab.frame.cursor.map_or("hidden".to_string(), |c| {
        format!("row {}, column {}", c.y + 1, c.x + 1)
    });
    let grid = col()
        .key("terminal-grid")
        .role("group")
        .label(format!("Terminal, cursor at {cursor}"))
        .fill(color(tab.frame.bg))
        .clip_rounded(0.0)
        .w_full()
        .grow(1.0)
        .focusable(true)
        .children(rows)
        .on_layout(move |state: &mut S, rect| {
            if let Some(tab) = lens(state) {
                tab.laid(rect);
            }
        })
        .on_key(move |state: &mut S, key, _| lens(state).is_some_and(|tab| tab.key(key)))
        .on_paste(move |state: &mut S, pasted, _| {
            if let Some(tab) = lens(state) {
                tab.paste(pasted);
            }
        })
        .on_wheel(move |state: &mut S, wheel, _| lens(state).is_some_and(|tab| tab.wheel(&wheel)))
        .on_drag(move |state: &mut S, drag, _| {
            if let Some(tab) = lens(state) {
                tab.drag(drag);
            }
        });
    let place = tab.at.as_ref().map(|at| pane_where(&tab.machine, at));
    col()
        .w_full()
        .h_full()
        .children(place.map(|place| text(place).key("terminal-where")))
        .children(
            tab.ended
                .clone()
                .map(|why| text(why).key("terminal-ended").role("alert")),
        )
        .child(grid)
}
