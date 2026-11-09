//! A pane's terminal state: libghostty-vt fed the bytes the `terminal` stream brings, read back
//! as frames to draw, and asked to encode keys and mouse input where the pane takes raw bytes.
//! Adapted from herdr-app's `src/vt.rs` (Apache-2.0; see THIRD-PARTY-NOTICES), without its
//! search, selection, links and images.

use ghostty_sys::*;
use std::ffi::c_void;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl From<GhosttyColorRgb> for Rgb {
    fn from(c: GhosttyColorRgb) -> Self {
        Rgb(c.r, c.g, c.b)
    }
}

/// xterm.js's default theme, which Desktop's Terminal tab draws with today.
pub struct Theme {
    pub fg: Rgb,
    pub bg: Rgb,
    pub cursor: Rgb,
    pub palette16: [Rgb; 16],
}

pub const XTERM_JS: Theme = Theme {
    fg: Rgb(0xff, 0xff, 0xff),
    bg: Rgb(0x00, 0x00, 0x00),
    cursor: Rgb(0xff, 0xff, 0xff),
    palette16: [
        Rgb(0x00, 0x00, 0x00),
        Rgb(0xcd, 0x31, 0x31),
        Rgb(0x0d, 0xbc, 0x79),
        Rgb(0xe5, 0xe5, 0x10),
        Rgb(0x24, 0x72, 0xc8),
        Rgb(0xbc, 0x3f, 0xbc),
        Rgb(0x11, 0xa8, 0xcd),
        Rgb(0xe5, 0xe5, 0xe5),
        Rgb(0x66, 0x66, 0x66),
        Rgb(0xf1, 0x4c, 0x4c),
        Rgb(0x23, 0xd1, 0x8b),
        Rgb(0xf5, 0xf5, 0x43),
        Rgb(0x3b, 0x8e, 0xea),
        Rgb(0xd6, 0x70, 0xd6),
        Rgb(0x29, 0xb8, 0xdb),
        Rgb(0xe5, 0xe5, 0xe5),
    ],
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cell {
    /// Empty for blank cells and for the tail half of a wide character.
    pub text: String,
    pub fg: Rgb,
    pub bg: Option<Rgb>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub wide: bool,
    /// The second column of a wide character, drawn by the cell before it.
    pub spacer: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub rows: Vec<Vec<Cell>>,
    /// Where the cursor shows, unless the program hides it.
    pub cursor: Option<Cursor>,
    pub bg: Rgb,
}

impl Frame {
    /// Row `y` as text, a wide character's spacer taking no column of its own.
    pub fn line(&self, y: usize) -> String {
        let text: String = self.rows[y]
            .iter()
            .filter(|cell| !cell.spacer)
            .map(|cell| {
                if cell.text.is_empty() {
                    " "
                } else {
                    &cell.text
                }
            })
            .collect();
        text.trim_end().to_string()
    }

    /// The cell holding column `x` of row `y`.
    pub fn cell(&self, x: usize, y: usize) -> &Cell {
        &self.rows[y][x]
    }
}

/// What the terminal's callbacks write into; boxed so its address is stable.
struct Shared {
    state: GhosttyRenderState,
    size: GhosttySizeReportSize,
    held_since: Option<Instant>,
    /// Replies the terminal writes back to the program, such as a cursor position report.
    replies: Vec<u8>,
}

fn ok(r: GhosttyResult, what: &str) {
    assert!(r == GHOSTTY_SUCCESS, "{what} failed: {r}");
}

unsafe extern "C" fn on_render_hold(t: GhosttyTerminal, userdata: *mut c_void, held: bool) {
    let shared = unsafe { &mut *(userdata as *mut Shared) };
    if held {
        // The finished frame the program wants on screen, taken before it redraws.
        unsafe { ghostty_render_state_update(shared.state, t) };
        shared.held_since = Some(Instant::now());
    } else {
        shared.held_since = None;
    }
}

unsafe extern "C" fn on_size(
    _t: GhosttyTerminal,
    userdata: *mut c_void,
    out: *mut GhosttySizeReportSize,
) -> bool {
    let shared = unsafe { &*(userdata as *const Shared) };
    if shared.size.cell_width == 0 || shared.size.cell_height == 0 {
        return false;
    }
    unsafe { *out = shared.size };
    true
}

unsafe extern "C" fn on_write_pty(
    _t: GhosttyTerminal,
    userdata: *mut c_void,
    data: *const u8,
    len: usize,
) {
    let shared = unsafe { &mut *(userdata as *mut Shared) };
    if !data.is_null() && len > 0 {
        shared
            .replies
            .extend_from_slice(unsafe { std::slice::from_raw_parts(data, len) });
    }
}

const SYNC_OUTPUT: GhosttyMode = 2026;
/// On from the start, as in Ghostty: VS16 makes ✍️ two cells wide.
const GRAPHEME_CLUSTER: GhosttyMode = 2027;
const BRACKETED_PASTE: GhosttyMode = 2004;
/// How long a program may hold synchronized output before its frame is drawn anyway.
const MAX_HOLD: Duration = Duration::from_millis(1000);
const SCROLLBACK_MAX_LINES: usize = 10_000;
const SCROLLBACK_MAX_BYTES: usize = 10_000_000;

pub struct Vt {
    term: GhosttyTerminal,
    shared: Box<Shared>,
    rows_it: GhosttyRenderStateRowIterator,
    cells: GhosttyRenderStateRowCells,
    keys: GhosttyKeyEncoder,
    key_event: GhosttyKeyEvent,
    mouse: GhosttyMouseEncoder,
    mouse_event: GhosttyMouseEvent,
    pub cols: u16,
    pub rows: u16,
    bg: Rgb,
}

impl Vt {
    pub fn new(cols: u16, rows: u16, theme: &Theme) -> Vt {
        unsafe {
            let mut term = std::ptr::null_mut();
            ok(
                ghostty_terminal_new(std::ptr::null(), &mut term, cols.max(1), rows.max(1)),
                "terminal_new",
            );
            let cluster = GhosttyTerminalModeConfig {
                mode: GRAPHEME_CLUSTER,
                value: true,
            };
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_MODE_DEFAULT,
                &cluster as *const _ as *const c_void,
            );
            let mut state = std::ptr::null_mut();
            ok(
                ghostty_render_state_new(std::ptr::null(), &mut state),
                "render_state_new",
            );
            let mut rows_it = std::ptr::null_mut();
            ok(
                ghostty_render_state_row_iterator_new(std::ptr::null(), &mut rows_it),
                "row_iterator_new",
            );
            let mut cells = std::ptr::null_mut();
            ok(
                ghostty_render_state_row_cells_new(std::ptr::null(), &mut cells),
                "row_cells_new",
            );
            let mut keys = std::ptr::null_mut();
            ok(
                ghostty_key_encoder_new(std::ptr::null(), &mut keys),
                "key_encoder_new",
            );
            let mut key_event = std::ptr::null_mut();
            ok(
                ghostty_key_event_new(std::ptr::null(), &mut key_event),
                "key_event_new",
            );
            let mut mouse = std::ptr::null_mut();
            ok(
                ghostty_mouse_encoder_new(std::ptr::null(), &mut mouse),
                "mouse_encoder_new",
            );
            let mut mouse_event = std::ptr::null_mut();
            ok(
                ghostty_mouse_event_new(std::ptr::null(), &mut mouse_event),
                "mouse_event_new",
            );

            let mut shared = Box::new(Shared {
                state,
                size: GhosttySizeReportSize {
                    rows: rows.max(1),
                    columns: cols.max(1),
                    cell_width: 0,
                    cell_height: 0,
                },
                held_since: None,
                replies: Vec::new(),
            });
            let userdata = &mut *shared as *mut Shared as *const c_void;
            ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_USERDATA, userdata);
            let hold: GhosttyTerminalRenderHoldFn = Some(on_render_hold);
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_RENDER_HOLD,
                std::mem::transmute::<GhosttyTerminalRenderHoldFn, *const c_void>(hold),
            );
            let size: GhosttyTerminalSizeFn = Some(on_size);
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_SIZE,
                std::mem::transmute::<GhosttyTerminalSizeFn, *const c_void>(size),
            );
            let write: GhosttyTerminalWritePtyFn = Some(on_write_pty);
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_WRITE_PTY,
                std::mem::transmute::<GhosttyTerminalWritePtyFn, *const c_void>(write),
            );
            ok(
                ghostty_terminal_set(
                    term,
                    GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES,
                    &SCROLLBACK_MAX_BYTES as *const _ as *const c_void,
                ),
                "scrollback_max_bytes",
            );
            ok(
                ghostty_terminal_set(
                    term,
                    GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES,
                    &SCROLLBACK_MAX_LINES as *const _ as *const c_void,
                ),
                "scrollback_max_lines",
            );

            ghostty_render_state_update(state, term);
            let mut colors = GhosttyRenderStateColors {
                size: std::mem::size_of::<GhosttyRenderStateColors>(),
                ..Default::default()
            };
            ghostty_render_state_get(
                state,
                GHOSTTY_RENDER_STATE_DATA_COLORS,
                &mut colors as *mut _ as *mut c_void,
            );
            let c = |rgb: Rgb| GhosttyColorRgb {
                r: rgb.0,
                g: rgb.1,
                b: rgb.2,
            };
            let mut palette = colors.palette;
            for (i, rgb) in theme.palette16.iter().enumerate() {
                palette[i] = c(*rgb);
            }
            let (fg, bg, cursor) = (c(theme.fg), c(theme.bg), c(theme.cursor));
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND,
                &fg as *const _ as *const c_void,
            );
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND,
                &bg as *const _ as *const c_void,
            );
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_COLOR_CURSOR,
                &cursor as *const _ as *const c_void,
            );
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_COLOR_PALETTE,
                &palette as *const _ as *const c_void,
            );

            Vt {
                term,
                shared,
                rows_it,
                cells,
                keys,
                key_event,
                mouse,
                mouse_event,
                cols,
                rows,
                bg: theme.bg,
            }
        }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        unsafe { ghostty_terminal_vt_write(self.term, bytes.as_ptr(), bytes.len()) };
    }

    /// What the terminal wants to say back to the program since the last call.
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.shared.replies)
    }

    pub fn resize(&mut self, cols: u16, rows: u16, cell_w: u32, cell_h: u32) {
        if cols == 0 || rows == 0 {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.shared.size = GhosttySizeReportSize {
            rows,
            columns: cols,
            cell_width: cell_w.max(1),
            cell_height: cell_h.max(1),
        };
        unsafe { ghostty_terminal_resize(self.term, cols, rows, cell_w.max(1), cell_h.max(1)) };
    }

    fn mode(&self, mode: GhosttyMode) -> bool {
        let mut config = GhosttyTerminalModeConfig { mode, value: false };
        unsafe {
            ghostty_terminal_get(
                self.term,
                GHOSTTY_TERMINAL_DATA_MODE,
                &mut config as *mut _ as *mut c_void,
            )
        };
        config.value
    }

    pub fn mouse_tracking(&self) -> bool {
        let mut tracking = false;
        unsafe {
            ghostty_terminal_get(
                self.term,
                GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING,
                &mut tracking as *mut _ as *mut c_void,
            )
        };
        tracking
    }

    pub fn alt_screen(&self) -> bool {
        let mut screen: GhosttyTerminalScreen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
        unsafe {
            ghostty_terminal_get(
                self.term,
                GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
                &mut screen as *mut _ as *mut c_void,
            )
        };
        screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE
    }

    /// Moves the viewport through the scrollback, negative being back in time.
    pub fn scroll_viewport(&mut self, delta: isize) {
        let mut scroll = GhosttyTerminalScrollViewport {
            tag: GHOSTTY_SCROLL_VIEWPORT_DELTA,
            ..Default::default()
        };
        scroll.value.delta = delta;
        unsafe { ghostty_terminal_scroll_viewport(self.term, scroll) };
    }

    pub fn scroll_to_bottom(&mut self) {
        let scroll = GhosttyTerminalScrollViewport {
            tag: GHOSTTY_SCROLL_VIEWPORT_BOTTOM,
            ..Default::default()
        };
        unsafe { ghostty_terminal_scroll_viewport(self.term, scroll) };
    }

    /// The scrollable rows in all, the viewport's offset into them, and its length.
    pub fn scrollbar(&self) -> (u64, u64, u64) {
        let mut bar = GhosttyTerminalScrollbar::default();
        unsafe {
            ghostty_terminal_get(
                self.term,
                GHOSTTY_TERMINAL_DATA_SCROLLBAR,
                &mut bar as *mut _ as *mut c_void,
            )
        };
        (bar.total, bar.offset, bar.len)
    }

    pub fn paste_bytes(&self, text: &str) -> Vec<u8> {
        if self.mode(BRACKETED_PASTE) {
            let clean = text.replace("\x1b[201~", "");
            [b"\x1b[200~".as_slice(), clean.as_bytes(), b"\x1b[201~"].concat()
        } else {
            text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
        }
    }

    /// Updates the render state, holding a synchronized frame until it is done, and reads it.
    pub fn frame(&mut self) -> Frame {
        unsafe {
            if let Some(since) = self.shared.held_since
                && since.elapsed() > MAX_HOLD
            {
                let config = GhosttyTerminalModeConfig {
                    mode: SYNC_OUTPUT,
                    value: false,
                };
                ghostty_terminal_set(
                    self.term,
                    GHOSTTY_TERMINAL_OPT_MODE,
                    &config as *const _ as *const c_void,
                );
                self.shared.held_since = None;
            }
            let state = self.shared.state;
            if self.shared.held_since.is_none() {
                ghostty_render_state_update(state, self.term);
            }
            let mut colors = GhosttyRenderStateColors {
                size: std::mem::size_of::<GhosttyRenderStateColors>(),
                ..Default::default()
            };
            ghostty_render_state_get(
                state,
                GHOSTTY_RENDER_STATE_DATA_COLORS,
                &mut colors as *mut _ as *mut c_void,
            );
            let fg_default = Rgb::from(colors.foreground);
            let mut rows = Vec::with_capacity(self.rows as usize);
            ghostty_render_state_get(
                state,
                GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                &mut self.rows_it as *mut _ as *mut c_void,
            );
            while ghostty_render_state_row_iterator_next(self.rows_it) {
                ghostty_render_state_row_get(
                    self.rows_it,
                    GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                    &mut self.cells as *mut _ as *mut c_void,
                );
                let mut row = Vec::with_capacity(self.cols as usize);
                while ghostty_render_state_row_cells_next(self.cells) {
                    row.push(self.read_cell(fg_default));
                }
                rows.push(row);
            }
            let mut cur = GhosttyRenderStateCursor {
                size: std::mem::size_of::<GhosttyRenderStateCursor>(),
                ..Default::default()
            };
            ghostty_render_state_get(
                state,
                GHOSTTY_RENDER_STATE_DATA_CURSOR,
                &mut cur as *mut _ as *mut c_void,
            );
            let cursor = (cur.visible && cur.viewport_has_value).then(|| Cursor {
                x: if cur.wide_tail {
                    cur.viewport_x.saturating_sub(1)
                } else {
                    cur.viewport_x
                },
                y: cur.viewport_y,
            });
            ghostty_render_state_clean(state);
            Frame {
                rows,
                cursor,
                bg: self.bg,
            }
        }
    }

    unsafe fn read_cell(&mut self, fg_default: Rgb) -> Cell {
        unsafe {
            let c = self.cells;
            let mut raw: GhosttyCell = Default::default();
            ghostty_render_state_row_cells_get(
                c,
                GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
                &mut raw as *mut _ as *mut c_void,
            );
            let mut wide: GhosttyCellWide = GHOSTTY_CELL_WIDE_NARROW;
            ghostty_cell_get(
                raw,
                GHOSTTY_CELL_DATA_WIDE,
                &mut wide as *mut _ as *mut c_void,
            );
            let mut style = GhosttyStyle {
                size: std::mem::size_of::<GhosttyStyle>(),
                ..Default::default()
            };
            ghostty_render_state_row_cells_get(
                c,
                GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
                &mut style as *mut _ as *mut c_void,
            );
            let mut fg = GhosttyColorRgb::default();
            let fg = if ghostty_render_state_row_cells_get(
                c,
                GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
                &mut fg as *mut _ as *mut c_void,
            ) == GHOSTTY_SUCCESS
            {
                Rgb::from(fg)
            } else {
                fg_default
            };
            let mut bg = GhosttyColorRgb::default();
            let bg = (ghostty_render_state_row_cells_get(
                c,
                GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
                &mut bg as *mut _ as *mut c_void,
            ) == GHOSTTY_SUCCESS)
                .then(|| Rgb::from(bg));
            let (fg, bg) = if style.inverse {
                (bg.unwrap_or(self.bg), Some(fg))
            } else {
                (fg, bg)
            };
            let mut text = String::new();
            if wide != GHOSTTY_CELL_WIDE_SPACER_TAIL
                && wide != GHOSTTY_CELL_WIDE_SPACER_HEAD
                && !style.invisible
            {
                let mut len: u32 = 0;
                ghostty_render_state_row_cells_get(
                    c,
                    GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
                    &mut len as *mut _ as *mut c_void,
                );
                if len > 0 {
                    let mut codepoints = vec![0u32; len as usize];
                    ghostty_render_state_row_cells_get(
                        c,
                        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
                        codepoints.as_mut_ptr() as *mut c_void,
                    );
                    text = codepoints.into_iter().filter_map(char::from_u32).collect();
                }
            }
            Cell {
                text,
                fg,
                bg,
                bold: style.bold,
                italic: style.italic,
                underline: style.underline != 0,
                wide: wide == GHOSTTY_CELL_WIDE_WIDE,
                spacer: wide == GHOSTTY_CELL_WIDE_SPACER_TAIL
                    || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD,
            }
        }
    }

    /// One key press, as the program's keyboard modes want it.
    pub fn encode_key(
        &mut self,
        key: GhosttyKey,
        mods: GhosttyMods,
        consumed: GhosttyMods,
        text: Option<&str>,
    ) -> Vec<u8> {
        unsafe {
            ghostty_key_encoder_setopt_from_terminal(self.keys, self.term);
            let e = self.key_event;
            ghostty_key_event_set_action(e, GHOSTTY_KEY_ACTION_PRESS);
            ghostty_key_event_set_key(e, key);
            ghostty_key_event_set_mods(e, mods);
            let printable = text.is_some_and(|t| !t.is_empty() && !t.chars().any(char::is_control));
            ghostty_key_event_set_consumed_mods(e, if printable { consumed } else { 0 });
            match text {
                Some(t) if printable => {
                    ghostty_key_event_set_utf8(e, t.as_ptr() as *const _, t.len())
                }
                _ => ghostty_key_event_set_utf8(e, std::ptr::null(), 0),
            }
            let mut buf = [0u8; 128];
            let mut len = 0usize;
            let r = ghostty_key_encoder_encode(
                self.keys,
                e,
                buf.as_mut_ptr() as *mut _,
                buf.len(),
                &mut len,
            );
            if r != GHOSTTY_SUCCESS {
                return Vec::new();
            }
            buf[..len].to_vec()
        }
    }

    /// A mouse event at pixel (`x`, `y`) for a program that tracks the mouse, on cells of
    /// `cell` pixels.
    pub fn encode_mouse(
        &mut self,
        action: GhosttyMouseAction,
        button: Option<GhosttyMouseButton>,
        mods: GhosttyMods,
        (x, y): (f32, f32),
        cell: (u32, u32),
    ) -> Vec<u8> {
        unsafe {
            ghostty_mouse_encoder_setopt_from_terminal(self.mouse, self.term);
            let size = GhosttyMouseEncoderSize {
                size: std::mem::size_of::<GhosttyMouseEncoderSize>(),
                screen_width: u32::from(self.cols) * cell.0,
                screen_height: u32::from(self.rows) * cell.1,
                cell_width: cell.0,
                cell_height: cell.1,
                ..Default::default()
            };
            ghostty_mouse_encoder_setopt(
                self.mouse,
                GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
                &size as *const _ as *const c_void,
            );
            let e = self.mouse_event;
            ghostty_mouse_event_set_action(e, action);
            match button {
                Some(b) => ghostty_mouse_event_set_button(e, b),
                None => ghostty_mouse_event_clear_button(e),
            }
            ghostty_mouse_event_set_mods(e, mods);
            ghostty_mouse_event_set_position(e, GhosttyMousePosition { x, y });
            let mut buf = [0u8; 64];
            let mut len = 0usize;
            let r = ghostty_mouse_encoder_encode(
                self.mouse,
                e,
                buf.as_mut_ptr() as *mut _,
                buf.len(),
                &mut len,
            );
            if r != GHOSTTY_SUCCESS {
                return Vec::new();
            }
            buf[..len].to_vec()
        }
    }
}

impl Drop for Vt {
    fn drop(&mut self) {
        unsafe {
            ghostty_mouse_event_free(self.mouse_event);
            ghostty_mouse_encoder_free(self.mouse);
            ghostty_key_event_free(self.key_event);
            ghostty_key_encoder_free(self.keys);
            ghostty_render_state_row_cells_free(self.cells);
            ghostty_render_state_row_iterator_free(self.rows_it);
            ghostty_render_state_free(self.shared.state);
            ghostty_terminal_free(self.term);
        }
    }
}
