//! A pane's terminal as Rune draws it, as Ghostty draws one: a grid of cells from the font's
//! own metrics, each row painted into pixels again only when it changes, the cursor laid over
//! it; and what the human does in it, sent on as `terminal-input` decides, or as a program
//! that tracks the mouse asks.

use crate::config::{CursorShape, Look};
use crate::input::{
    Held, KeyAction, Pointer, Screen, key_action, links_in, mouse_of, pane_where, scroll_of,
};
use crate::keys::typed;
use crate::paint::Painter;
use crate::pane::Pane;
use crate::vt::{ALT_SCROLL, CursorStyle, Frame, Rgb, ScreenPoint, Unit, Vt};
use base64::Engine;
use collie_desktop_protocol::client::RpcError;
use collie_desktop_protocol::generated::{
    ActionFailed, At, Command, TerminalEvent, TerminalInput, TerminalMouseAction, Type,
};
use ghostty_sys::*;
use rune::{
    Color, Cursor as Pointing, Drag, El, KeyEvent, Live, Mods, Phase, Pixels, PointerButton,
    WheelEvent, col, el, text,
};
use std::cell::{Cell as Shared, RefCell};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::time::{Duration, Instant};

/// A notch of a mouse wheel, in points, as Rune reports one.
const WHEEL_NOTCH: f32 = 40.0;
/// Lines a notch scrolls, Ghostty's `mouse-scroll-multiplier` for a notched wheel.
const NOTCH_LINES: f32 = 3.0;
/// Half of Ghostty's cursor blink.
const BLINK: Duration = Duration::from_millis(600);
/// The display scale until the view says otherwise.
const DEFAULT_SCALE: f32 = 2.0;

/// A mouse button as the terminal tells them apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
    Back,
    Forward,
}

impl Button {
    fn of(button: PointerButton) -> Option<Button> {
        Some(match button {
            PointerButton::Primary => Button::Left,
            PointerButton::Middle => Button::Middle,
            PointerButton::Secondary => Button::Right,
            PointerButton::Back => Button::Back,
            PointerButton::Forward => Button::Forward,
            _ => return None,
        })
    }

    fn ghostty(self) -> GhosttyMouseButton {
        match self {
            Button::Left => GHOSTTY_MOUSE_BUTTON_LEFT,
            Button::Middle => GHOSTTY_MOUSE_BUTTON_MIDDLE,
            Button::Right => GHOSTTY_MOUSE_BUTTON_RIGHT,
            Button::Back => GHOSTTY_MOUSE_BUTTON_EIGHT,
            Button::Forward => GHOSTTY_MOUSE_BUTTON_NINE,
        }
    }

    /// As a window event numbers it, which `terminal-input` names for herdr.
    fn number(self) -> u8 {
        match self {
            Button::Left => 0,
            Button::Middle => 1,
            Button::Right => 2,
            Button::Back => 3,
            Button::Forward => 4,
        }
    }
}

/// A press, drag or release over the grid, in the grid's own points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mouse {
    pub phase: Phase,
    pub button: Button,
    pub x: f32,
    pub y: f32,
    /// Which click of a run: two selects a word, three a line.
    pub clicks: u32,
    pub mods: Mods,
}

/// What a key did that the view must finish.
#[derive(Clone, Debug, PartialEq)]
pub enum Keyed {
    /// The terminal has no use for it.
    Passed,
    /// Sent to the pane, or handled here.
    Taken,
    Copy(String),
    Paste,
}

/// The link under the pointer: its row, the columns it spans and where it goes.
#[derive(Clone, Debug, PartialEq)]
pub struct Hover {
    pub y: u16,
    pub cols: Range<usize>,
    pub url: String,
}

struct Press {
    button: Button,
    clicks: u32,
    cell: (u16, u16),
    moved: bool,
    /// Reported to a program that tracks the mouse, so its release and drags are too.
    reported: bool,
    link: Option<String>,
}

/// What the view last drew, kept so a row is painted again only when it changes.
struct Drawn {
    frame: Frame,
    stale: bool,
    painter: Option<Painter>,
    rows: Vec<(Pixels, u64)>,
    cursor: (Pixels, u64),
}

/// The grid's measures in points, for laying it out and finding the cell under the pointer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub cell_w: f32,
    pub cell_h: f32,
    pub pad: f32,
    /// A cell in device pixels.
    pub cell_px: (u32, u32),
    pub scale: f32,
}

/// One pane's terminal: its VT state, what was drawn of it, and its pane on the core.
pub struct Tab {
    vt: RefCell<Vt>,
    drawn: RefCell<Drawn>,
    pane: Option<Pane>,
    pub at: Option<At>,
    pub machine: String,
    pub ended: Option<String>,
    /// Whether it is core's raw stream, whose history and mouse reports are this view's own.
    on_core: bool,
    clock: Instant,
    laid_out: [f32; 2],
    look: Look,
    scale: Shared<f32>,
    focused: bool,
    blink: Live<f32>,
    /// When the human last typed, from which the cursor blinks again.
    woke: Duration,
    /// Wheel travel not yet a whole line.
    wheel: f32,
    press: Option<Press>,
    /// Where a selection started, and by what it grows.
    anchor: Option<(ScreenPoint, Unit)>,
    pub hover: Option<Hover>,
    motion_at: Option<(u16, u16)>,
    /// The first key awaiting its drawn echo, and output last shown, for Desktop's marks.
    pub keyed_at: std::cell::Cell<Option<f64>>,
    pub shown_at: Option<f64>,
}

fn fresh_vt(cols: u16, rows: u16, look: &Look) -> Vt {
    let mut vt = Vt::new(cols, rows, &look.theme);
    let style = match look.cursor_shape {
        CursorShape::Block => CursorStyle::Block,
        CursorShape::Bar => CursorStyle::Bar,
        CursorShape::Underline => CursorStyle::Underline,
    };
    vt.set_default_cursor(style, look.cursor_blink.unwrap_or(true));
    vt
}

impl Tab {
    pub fn new(pane: Option<Pane>, machine: String, cols: u16, rows: u16) -> Tab {
        Tab::with_look(pane, machine, cols, rows, crate::config::look().clone())
    }

    /// A tab drawn with `look` rather than the human's Ghostty config.
    pub fn with_look(pane: Option<Pane>, machine: String, cols: u16, rows: u16, look: Look) -> Tab {
        let mut vt = fresh_vt(cols, rows, &look);
        let frame = vt.frame();
        Tab {
            vt: RefCell::new(vt),
            drawn: RefCell::new(Drawn {
                frame,
                stale: false,
                painter: None,
                rows: Vec::new(),
                cursor: (Pixels::new(), 0),
            }),
            pane,
            at: None,
            machine,
            ended: None,
            on_core: false,
            clock: Instant::now(),
            laid_out: [0.0, 0.0],
            look,
            scale: Shared::new(DEFAULT_SCALE),
            focused: true,
            blink: Live::new(1.0),
            woke: Duration::ZERO,
            wheel: 0.0,
            press: None,
            anchor: None,
            hover: None,
            motion_at: None,
            keyed_at: std::cell::Cell::new(None),
            shown_at: None,
        }
    }

    fn vt(&mut self) -> &mut Vt {
        self.drawn.get_mut().stale = true;
        self.vt.get_mut()
    }

    fn send(&self, command: Command) {
        if let Some(pane) = &self.pane {
            pane.send(command);
        }
    }

    fn input(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
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

    /// One event of the `terminal` stream. Its frame is read when it is next drawn, so a
    /// burst of output is drawn once.
    pub fn shown(&mut self, event: TerminalEvent) {
        match event {
            TerminalEvent::Opened(opened) => {
                self.on_core = opened.at.core.is_some();
                self.at = Some(opened.at);
                let (cols, rows) = (self.vt.get_mut().cols, self.vt.get_mut().rows);
                let mut vt = fresh_vt(cols, rows, &self.look);
                if let Some(grid) = self.grid() {
                    vt.resize(cols, rows, grid.cell_px.0, grid.cell_px.1);
                }
                *self.vt() = vt;
                self.anchor = None;
                if let Some(pane) = &mut self.pane {
                    pane.opened((cols, rows));
                }
            }
            TerminalEvent::Frame(frame) => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(frame.bytes) {
                    self.vt().write(&bytes);
                    self.shown_at = Some(collie_desktop_protocol::epoch_ms());
                    // What the program asked the terminal, such as where its cursor is.
                    let replies = self.vt.get_mut().take_replies();
                    self.input(&replies);
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
    }

    /// The screen as it is now.
    pub fn frame(&self) -> Frame {
        self.refreshed();
        self.drawn.borrow().frame.clone()
    }

    fn refreshed(&self) {
        let mut drawn = self.drawn.borrow_mut();
        if drawn.stale {
            drawn.frame = self.vt.borrow_mut().frame();
            drawn.stale = false;
        }
    }

    /// Sends a size that has settled, and blinks the cursor.
    pub fn tick(&mut self) {
        let now = self.clock.elapsed();
        if let Some(pane) = &mut self.pane {
            pane.tick(now);
        }
        // A synchronized frame a program never finished is drawn after a while.
        self.drawn.get_mut().stale = true;
        let blinking = self.focused
            && self.ended.is_none()
            && self
                .drawn
                .get_mut()
                .frame
                .cursor
                .is_some_and(|c| c.blinking);
        let lit =
            !blinking || ((now - self.woke).as_millis() / BLINK.as_millis()).is_multiple_of(2);
        self.blink.set(if lit { 1.0 } else { 0.0 });
    }

    /// The display scale the grid is drawn at, which the view reads from Rune's `Env`.
    pub fn set_scale(&self, scale: f32) {
        if scale > 0.0 {
            self.scale.set(scale);
        }
    }

    /// The grid's measures at the current scale.
    pub fn grid(&self) -> Option<Grid> {
        let mut drawn = self.drawn.borrow_mut();
        let scale = self.scale.get();
        if drawn.painter.as_ref().is_none_or(|p| p.scale() != scale) {
            drawn.painter = Some(Painter::new(&self.look, scale));
            drawn.rows.clear();
            drawn.cursor.1 = 0;
        }
        let (w, h) = drawn.painter.as_ref()?.cell();
        Some(Grid {
            cell_w: w as f32 / scale,
            cell_h: h as f32 / scale,
            pad: self.look.padding,
            cell_px: (w, h),
            scale,
        })
    }

    /// The terminal gained or lost the human's focus: the cursor goes hollow, and a program
    /// that asked is told.
    pub fn focus(&mut self, focused: bool) {
        if focused == self.focused {
            return;
        }
        self.focused = focused;
        self.woke = self.clock.elapsed();
        let report = self.vt.get_mut().focus_report(focused);
        self.input(&report);
    }

    pub fn focused(&self) -> bool {
        self.focused
    }

    pub fn laid(&mut self, [_, _, w, h]: [f32; 4]) {
        if [w, h] == self.laid_out {
            return;
        }
        self.laid_out = [w, h];
        let Some(grid) = self.grid() else { return };
        let cols = (((w - 2.0 * grid.pad) / grid.cell_w).floor().max(1.0)) as u16;
        let rows = (((h - 2.0 * grid.pad) / grid.cell_h).floor().max(1.0)) as u16;
        let (cell_w, cell_h) = grid.cell_px;
        if (cols, rows) == (self.vt.get_mut().cols, self.vt.get_mut().rows) {
            return;
        }
        self.vt().resize(cols, rows, cell_w, cell_h);
        let now = self.clock.elapsed();
        if let Some(pane) = &mut self.pane {
            pane.resized((cols, rows), now);
        }
    }

    /// The selected text, as copying takes it.
    pub fn selection_text(&self) -> Option<String> {
        self.vt.borrow().selection_text()
    }

    pub fn key(&mut self, key: &KeyEvent) -> Keyed {
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
        self.focus(true);
        let selected = self.selection_text();
        match key_action(&pressed, selected.is_some()) {
            KeyAction::Copy => return selected.map_or(Keyed::Taken, Keyed::Copy),
            KeyAction::Paste => return Keyed::Paste,
            KeyAction::Focus => return Keyed::Passed,
            KeyAction::Pane => {}
        }
        match typed(self.vt(), key) {
            Some(bytes) => {
                self.typed(&bytes);
                Keyed::Taken
            }
            None => Keyed::Passed,
        }
    }

    fn typed(&mut self, bytes: &[u8]) {
        let vt = self.vt();
        vt.scroll_to_bottom();
        vt.clear_selection();
        self.anchor = None;
        self.woke = self.clock.elapsed();
        self.input(bytes);
        if self.keyed_at.get().is_none() {
            self.keyed_at.set(Some(collie_desktop_protocol::epoch_ms()));
        }
    }

    pub fn paste(&mut self, text: &str) {
        let bytes = self.vt.get_mut().paste_bytes(text);
        self.typed(&bytes);
    }

    /// The grid as `terminal-input` measures it.
    fn screen(&self) -> Screen {
        let (cols, rows) = {
            let vt = self.vt.borrow();
            (vt.cols, vt.rows)
        };
        let grid = self.grid();
        let (cw, ch, pad) = grid.map_or((1.0, 1.0, 0.0), |g| (g.cell_w, g.cell_h, g.pad));
        Screen {
            left: f64::from(pad),
            top: f64::from(pad),
            width: f64::from(cw * f32::from(cols)),
            height: f64::from(ch * f32::from(rows)),
            cols,
            rows,
        }
    }

    fn cell_at(&self, x: f32, y: f32) -> (u16, u16) {
        let (column, row) = crate::input::cell_at(
            &Pointer {
                x: f64::from(x),
                y: f64::from(y),
                held: Held::default(),
            },
            &self.screen(),
        );
        (column as u16, row as u16)
    }

    /// The pointer in device pixels from the grid's corner, as a mouse report measures it.
    fn report_at(&self, x: f32, y: f32) -> ((f32, f32), (u32, u32)) {
        let grid = self.grid().expect("a grid");
        (
            ((x - grid.pad) * grid.scale, (y - grid.pad) * grid.scale),
            grid.cell_px,
        )
    }

    fn report(
        &mut self,
        action: GhosttyMouseAction,
        button: Option<Button>,
        mods: Mods,
        x: f32,
        y: f32,
    ) {
        let (at, cell) = self.report_at(x, y);
        let bytes = self.vt.get_mut().encode_mouse(
            action,
            button.map(Button::ghostty),
            mods_of(mods),
            at,
            cell,
        );
        self.input(&bytes);
    }

    /// Whether the mouse goes to the program: it tracks the mouse and Shift is not held.
    fn reporting(&self, mods: Mods) -> bool {
        self.on_core && !mods.shift && self.vt.borrow().mouse_tracking()
    }

    fn herdr(&self, action: TerminalMouseAction, button: Button, mouse: &Mouse) {
        let pointer = Pointer {
            x: f64::from(mouse.x),
            y: f64::from(mouse.y),
            held: held(mouse.mods),
        };
        if let Some(command) = mouse_of(action, button.number(), &pointer, &self.screen()) {
            self.send(command);
        }
    }

    /// A press, drag or release over the grid: reported to a program that tracks the mouse,
    /// otherwise a selection by cell, word or line, a click on a link, or a middle-click
    /// paste of the selection.
    pub fn pointer(&mut self, mouse: Mouse) {
        let cell = self.cell_at(mouse.x, mouse.y);
        if !self.on_core {
            let action = match mouse.phase {
                Phase::Down => TerminalMouseAction::Down,
                Phase::Move => TerminalMouseAction::Drag,
                Phase::Up => TerminalMouseAction::Up,
            };
            self.herdr(action, mouse.button, &mouse);
        }
        match mouse.phase {
            Phase::Down => {
                self.focus(true);
                let reported = self.reporting(mouse.mods);
                if reported {
                    self.report(
                        GHOSTTY_MOUSE_ACTION_PRESS,
                        Some(mouse.button),
                        mouse.mods,
                        mouse.x,
                        mouse.y,
                    );
                }
                let link = (!reported && mouse.button == Button::Left)
                    .then(|| self.link_at(cell))
                    .flatten()
                    .map(|hover| hover.url);
                self.press = Some(Press {
                    button: mouse.button,
                    clicks: mouse.clicks,
                    cell,
                    moved: false,
                    reported,
                    link,
                });
                if reported {
                    return;
                }
                match mouse.button {
                    Button::Left => self.select_from(cell, mouse.clicks),
                    Button::Middle => {
                        if let Some(text) = self.selection_text() {
                            self.paste(&text);
                        }
                    }
                    _ => {}
                }
            }
            Phase::Move => {
                let Some(press) = &mut self.press else { return };
                let moved = press.cell != cell;
                press.moved |= moved;
                let (reported, button) = (press.reported, press.button);
                let extending = press.moved || press.clicks > 1;
                if reported {
                    if moved || self.motion_at != Some(cell) {
                        self.motion_at = Some(cell);
                        self.report(
                            GHOSTTY_MOUSE_ACTION_MOTION,
                            Some(button),
                            mouse.mods,
                            mouse.x,
                            mouse.y,
                        );
                    }
                    return;
                }
                if button == Button::Left
                    && extending
                    && let Some((anchor, unit)) = self.anchor
                    && let Some(head) = self.vt.get_mut().screen_point(cell.0, cell.1)
                {
                    self.vt().select(anchor, head, unit);
                }
            }
            Phase::Up => {
                let Some(press) = self.press.take() else {
                    return;
                };
                if press.reported {
                    self.report(
                        GHOSTTY_MOUSE_ACTION_RELEASE,
                        Some(press.button),
                        mouse.mods,
                        mouse.x,
                        mouse.y,
                    );
                    return;
                }
                if press.button == Button::Left && !press.moved && press.clicks == 1 {
                    self.vt().clear_selection();
                    if let Some(url) = press.link {
                        self.open(url);
                    }
                }
            }
        }
    }

    fn select_from(&mut self, (x, y): (u16, u16), clicks: u32) {
        let Some(at) = self.vt.get_mut().screen_point(x, y) else {
            return;
        };
        let unit = match clicks {
            1 => Unit::Cell,
            2 => Unit::Word,
            _ => Unit::Line,
        };
        self.anchor = Some((at, unit));
        if unit != Unit::Cell {
            self.vt().select(at, at, unit);
        }
    }

    /// The secondary button, which Rune reports as a press alone: a program that tracks the
    /// mouse gets its press and release.
    pub fn secondary(&mut self, x: f32, y: f32, mods: Mods) {
        self.focus(true);
        if !self.on_core {
            let mouse = Mouse {
                phase: Phase::Down,
                button: Button::Right,
                x,
                y,
                clicks: 1,
                mods,
            };
            self.herdr(TerminalMouseAction::Down, Button::Right, &mouse);
            self.herdr(TerminalMouseAction::Up, Button::Right, &mouse);
        } else if self.reporting(mods) {
            self.report(GHOSTTY_MOUSE_ACTION_PRESS, Some(Button::Right), mods, x, y);
            self.report(
                GHOSTTY_MOUSE_ACTION_RELEASE,
                Some(Button::Right),
                mods,
                x,
                y,
            );
        }
    }

    /// The pointer moved over the grid with no button held: a link under it is underlined,
    /// and a program tracking every motion hears it.
    pub fn moved(&mut self, x: f32, y: f32, mods: Mods) {
        if self.press.is_some() {
            return;
        }
        let cell = self.cell_at(x, y);
        let hover = self.link_at(cell);
        if hover != self.hover {
            self.hover = hover;
        }
        if self.reporting(mods) && self.motion_at != Some(cell) {
            self.motion_at = Some(cell);
            self.report(GHOSTTY_MOUSE_ACTION_MOTION, None, mods, x, y);
        }
    }

    pub fn left(&mut self) {
        self.hover = None;
        self.motion_at = None;
    }

    /// The link at `cell`: an OSC 8 hyperlink, or a web address written out.
    pub fn link_at(&self, (x, y): (u16, u16)) -> Option<Hover> {
        let frame = self.frame();
        let vt = self.vt.borrow();
        let row = frame.rows.get(usize::from(y))?;
        let at = usize::from(x);
        if row.get(at)?.link
            && let Some(url) = vt.hyperlink_at(x, y)
        {
            let same =
                |c: usize| row[c].link && vt.hyperlink_at(c as u16, y).as_deref() == Some(&url);
            let start = (0..at).rev().take_while(|c| same(*c)).last().unwrap_or(at);
            let end = (at + 1..row.len())
                .take_while(|c| same(*c))
                .last()
                .unwrap_or(at)
                + 1;
            return Some(Hover {
                y,
                cols: start..end,
                url,
            });
        }
        let mut line = String::new();
        let mut columns = Vec::new();
        for (c, cell) in row.iter().enumerate() {
            if cell.spacer {
                continue;
            }
            let text = if cell.text.is_empty() {
                " "
            } else {
                &cell.text
            };
            for ch in text.chars() {
                line.push(ch);
                columns.push(c);
            }
        }
        links_in(&line)
            .into_iter()
            .find(|link| (columns[link.start - 1]..=columns[link.end - 1]).contains(&at))
            .map(|link| Hover {
                y,
                cols: columns[link.start - 1]..columns[link.end - 1] + 1,
                url: link.url,
            })
    }

    fn open(&self, url: String) {
        if let Some(pane) = &self.pane {
            pane.open_link(url);
        }
    }

    pub fn wheel(&mut self, wheel: &WheelEvent) -> bool {
        // Rune's delta moves the content; the DOM's, which `terminal-input` reads, the view.
        let delta_y = -wheel.dy;
        if !self.on_core {
            let pointer = Pointer {
                x: f64::from(wheel.x),
                y: f64::from(wheel.y),
                held: held(wheel.mods),
            };
            if let Some(scroll) = scroll_of(f64::from(delta_y), &pointer, &self.screen()) {
                self.send(scroll);
            }
            return true;
        }
        let Some(grid) = self.grid() else { return true };
        let reporting = self.reporting(wheel.mods);
        // A notch is one report to a program, and three lines of history.
        let per_line = if wheel.precise {
            grid.cell_h
        } else if reporting {
            WHEEL_NOTCH
        } else {
            WHEEL_NOTCH / NOTCH_LINES
        };
        self.wheel += delta_y;
        let lines = (self.wheel / per_line).trunc();
        self.wheel -= lines * per_line;
        if lines == 0.0 {
            return true;
        }
        let count = lines.abs() as usize;
        if reporting {
            let button = if lines < 0.0 {
                GHOSTTY_MOUSE_BUTTON_FOUR
            } else {
                GHOSTTY_MOUSE_BUTTON_FIVE
            };
            let (at, cell) = self.report_at(wheel.x, wheel.y);
            for _ in 0..count {
                let report = self.vt.get_mut().encode_mouse(
                    GHOSTTY_MOUSE_ACTION_PRESS,
                    Some(button),
                    mods_of(wheel.mods),
                    at,
                    cell,
                );
                self.input(&report);
            }
        } else if self.vt.get_mut().alt_screen() && self.vt.get_mut().mode(ALT_SCROLL) {
            let key = if lines < 0.0 {
                GHOSTTY_KEY_ARROW_UP
            } else {
                GHOSTTY_KEY_ARROW_DOWN
            };
            for _ in 0..count {
                let bytes = self.vt.get_mut().encode_key(key, 0, 0, None);
                self.input(&bytes);
            }
        } else {
            self.vt().scroll_viewport(lines as isize);
        }
        true
    }

    /// Paints what changed since the last draw, and says where it all goes.
    fn draw(&self) -> Option<Drawing> {
        let grid = self.grid()?;
        self.refreshed();
        let mut drawn = self.drawn.borrow_mut();
        let Drawn {
            frame,
            painter,
            rows,
            cursor,
            ..
        } = &mut *drawn;
        let painter = painter.as_mut()?;
        // A row is found by what it shows, so output that scrolls repaints only the new rows.
        let mut before: HashMap<u64, Pixels> = rows.drain(..).map(|(p, h)| (h, p)).collect();
        let mut now: HashMap<u64, Pixels> = HashMap::new();
        let mut lines = Vec::with_capacity(frame.rows.len());
        let mut wanted = Vec::with_capacity(frame.rows.len());
        for y in 0..frame.rows.len() {
            let hover = self
                .hover
                .as_ref()
                .filter(|h| usize::from(h.y) == y)
                .map(|h| h.cols.clone());
            let mut hasher = std::hash::DefaultHasher::new();
            (&frame.rows[y], &hover, frame.fg, frame.bg).hash(&mut hasher);
            let hash = hasher.finish();
            if !now.contains_key(&hash)
                && let Some(pixels) = before.remove(&hash)
            {
                now.insert(hash, pixels);
            }
            wanted.push((hash, hover));
            lines.push(frame.line(y));
        }
        let mut spare = before.into_values();
        for (y, (hash, hover)) in wanted.into_iter().enumerate() {
            let pixels = now.entry(hash).or_insert_with(|| {
                let image = painter.row(frame, y, hover);
                let pixels = spare.next().unwrap_or_default();
                pixels.set(image.width, image.height, image.rgba);
                pixels
            });
            rows.push((pixels.clone(), hash));
        }
        let shown_cursor = frame.cursor.filter(|_| self.ended.is_none());
        if let Some(at) = shown_cursor {
            let mut hasher = std::hash::DefaultHasher::new();
            let under = frame
                .rows
                .get(usize::from(at.y))
                .and_then(|row| row.get(usize::from(at.x)));
            (at, under, self.focused, frame.cursor_color, frame.bg).hash(&mut hasher);
            let hash = hasher.finish() | 1;
            if hash != cursor.1 {
                let image = painter.cursor(frame, &at, self.focused);
                cursor.0.set(image.width, image.height, image.rgba);
                cursor.1 = hash;
            }
        }
        Some(Drawing {
            grid,
            cols: frame.rows.first().map_or(0, Vec::len),
            lines,
            rows: rows.iter().map(|(p, _)| p.clone()).collect(),
            cursor: shown_cursor.map(|c| (c.x, c.y, if c.wide { 2 } else { 1 }, cursor.0.clone())),
            bg: frame.bg,
        })
    }

    /// Gives the pane back, as leaving the Terminal tab does, off the view's thread: the sends
    /// still queued go first.
    pub fn leave(self) {
        if let Some(pane) = self.pane {
            std::thread::spawn(move || pane.leave());
        }
    }
}

struct Drawing {
    grid: Grid,
    cols: usize,
    lines: Vec<String>,
    rows: Vec<Pixels>,
    cursor: Option<(u16, u16, u16, Pixels)>,
    bg: Rgb,
}

fn held(mods: Mods) -> Held {
    Held {
        shift: mods.shift,
        ctrl: mods.ctrl,
        alt: mods.alt,
    }
}

fn mods_of(mods: Mods) -> GhosttyMods {
    let mut bits = 0;
    if mods.shift {
        bits |= GHOSTTY_MODS_SHIFT;
    }
    if mods.ctrl {
        bits |= GHOSTTY_MODS_CTRL;
    }
    if mods.alt {
        bits |= GHOSTTY_MODS_ALT;
    }
    if mods.logo {
        bits |= GHOSTTY_MODS_SUPER;
    }
    bits as GhosttyMods
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

/// The terminal of `tab`, which `lens` finds in the app's state, drawn at display `scale`
/// (`cx.env().scale`).
pub fn terminal_at<S: 'static>(tab: &Tab, lens: fn(&mut S) -> Option<&mut Tab>, scale: f32) -> El {
    tab.set_scale(scale);
    terminal(tab, lens)
}

/// The terminal of `tab`, which `lens` finds in the app's state, at the scale last set.
pub fn terminal<S: 'static>(tab: &Tab, lens: fn(&mut S) -> Option<&mut Tab>) -> El {
    let drawing = tab.draw();
    let frame_cursor = tab.drawn.borrow().frame.cursor;
    let cursor = frame_cursor.map_or("hidden".to_string(), |c| {
        format!("row {}, column {}", c.y + 1, c.x + 1)
    });
    let mut grid = el()
        .key("terminal-grid")
        .role("group")
        .label(format!("Terminal, cursor at {cursor}"))
        .w_full()
        .grow(1.0)
        .clip_rounded(0.0)
        .focusable(true)
        .cursor(if tab.hover.is_some() {
            Pointing::Pointer
        } else {
            Pointing::Text
        });
    if let Some(drawing) = drawing {
        let Grid {
            cell_w,
            cell_h,
            pad,
            ..
        } = drawing.grid;
        let width = cell_w * drawing.cols as f32;
        let rows =
            drawing
                .rows
                .iter()
                .zip(&drawing.lines)
                .enumerate()
                .map(|(y, (pixels, line))| {
                    el().key(format!("row-{y}"))
                        .label(line.clone())
                        .absolute(pad, pad + cell_h * y as f32)
                        .w(width)
                        .h(cell_h)
                        .pixels(pixels)
                });
        grid = grid
            .fill(color(drawing.bg))
            .children(rows)
            .children(drawing.cursor.map(|(x, y, cells, pixels)| {
                el().key("terminal-cursor")
                    .absolute(pad + cell_w * f32::from(x), pad + cell_h * f32::from(y))
                    .w(cell_w * f32::from(cells))
                    .h(cell_h)
                    .pixels(&pixels)
                    .live_opacity(&tab.blink)
            }));
        if tab.ended.is_some() {
            grid = grid.opacity(0.5);
        }
    }
    let grid = grid
        .pointer_buttons([
            PointerButton::Middle,
            PointerButton::Back,
            PointerButton::Forward,
        ])
        .on_layout(move |state: &mut S, rect| {
            if let Some(tab) = lens(state) {
                tab.laid(rect);
            }
        })
        .on_key(move |state: &mut S, key, tx| {
            let Some(tab) = lens(state) else { return false };
            match tab.key(key) {
                Keyed::Passed => false,
                Keyed::Taken => true,
                Keyed::Copy(text) => {
                    tx.copy(text);
                    true
                }
                Keyed::Paste => {
                    tx.request_paste();
                    true
                }
            }
        })
        .on_paste(move |state: &mut S, pasted, _| {
            if let Some(tab) = lens(state) {
                tab.paste(pasted);
            }
        })
        .on_wheel(move |state: &mut S, wheel, _| lens(state).is_some_and(|tab| tab.wheel(&wheel)))
        .on_drag(move |state: &mut S, drag: &mut Drag, tx| {
            let Some(tab) = lens(state) else { return };
            let Some(button) = Button::of(tx.button()) else {
                return;
            };
            tab.pointer(Mouse {
                phase: drag.phase,
                button,
                x: drag.x,
                y: drag.y,
                clicks: drag.clicks,
                mods: tx.mods(),
            });
        })
        .on_secondary_press_local(move |state: &mut S, at, tx| {
            if let Some(tab) = lens(state) {
                tab.secondary(at.x, at.y, tx.mods());
            }
        })
        .on_pointer_move_local(move |state: &mut S, at, tx| {
            if let Some(tab) = lens(state) {
                tab.moved(at.x, at.y, tx.mods());
            }
        })
        .on_hover_change(move |state: &mut S, inside, _| {
            if !inside && let Some(tab) = lens(state) {
                tab.left();
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
