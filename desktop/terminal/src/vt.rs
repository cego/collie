//! A pane's terminal state: libghostty-vt fed the bytes the `terminal` stream brings, read back
//! as frames to draw, and asked to encode keys and mouse input where the pane takes raw bytes.
//! Adapted from herdr-app's `src/vt.rs` (Apache-2.0; see THIRD-PARTY-NOTICES), without its
//! search and images.

use ghostty_sys::*;
use std::ffi::c_void;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Hash)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl From<GhosttyColorRgb> for Rgb {
    fn from(c: GhosttyColorRgb) -> Self {
        Rgb(c.r, c.g, c.b)
    }
}

/// The colours a terminal starts with, before a program sets its own.
#[derive(Clone, Debug, PartialEq)]
pub struct Theme {
    pub fg: Rgb,
    pub bg: Rgb,
    pub cursor: Rgb,
    pub palette16: [Rgb; 16],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Underline {
    #[default]
    None,
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Cell {
    /// Empty for blank cells, hidden text, and the tail half of a wide character.
    pub text: String,
    /// After inverse video is applied.
    pub fg: Rgb,
    pub bg: Option<Rgb>,
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub blink: bool,
    pub strikethrough: bool,
    pub overline: bool,
    pub underline: Underline,
    /// SGR 58's colour; the text's colour when not set.
    pub underline_color: Option<Rgb>,
    pub wide: bool,
    /// The second column of a wide character, drawn by the cell before it.
    pub spacer: bool,
    /// Part of an OSC 8 hyperlink.
    pub link: bool,
    pub selected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CursorStyle {
    Block,
    Bar,
    Underline,
    BlockHollow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
    pub style: CursorStyle,
    /// Whether the program wants it blinking.
    pub blinking: bool,
    /// Over a wide character, so two cells wide.
    pub wide: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub rows: Vec<Vec<Cell>>,
    /// Where the cursor shows, unless the program hides it.
    pub cursor: Option<Cursor>,
    pub fg: Rgb,
    pub bg: Rgb,
    /// The cursor's colour when a program set one (OSC 12).
    pub cursor_color: Option<Rgb>,
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

/// A cell of the whole screen, scrollback included, which stays put while the viewport moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ScreenPoint {
    pub y: u32,
    pub x: u16,
}

/// How a drag selects: by cell, by word (double click) or by line (triple click).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Cell,
    Word,
    Line,
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

/// Ghostty's buffer APIs report the required byte count on OUT_OF_SPACE. Keep the
/// allocation in Rust, and accept only a successful write that fits that allocation.
fn read_text(mut read: impl FnMut(&mut [u8], &mut usize) -> GhosttyResult) -> Option<String> {
    let mut needed = 0;
    if read(&mut [], &mut needed) != GHOSTTY_OUT_OF_SPACE || needed == 0 {
        return None;
    }
    let mut buf = Vec::new();
    buf.try_reserve_exact(needed).ok()?;
    buf.resize(needed, 0);
    let mut written = 0;
    if read(&mut buf, &mut written) != GHOSTTY_SUCCESS {
        return None;
    }
    let bytes = buf.get(..written)?;
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(bytes).into_owned())
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
pub const BRACKETED_PASTE: GhosttyMode = 2004;
pub const FOCUS_EVENTS: GhosttyMode = 1004;
pub const ALT_SCROLL: GhosttyMode = 1007;
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
            // As in Ghostty, the wheel sends arrow keys to a full-screen program not tracking the mouse.
            let alt_scroll = GhosttyTerminalModeConfig {
                mode: ALT_SCROLL,
                value: true,
            };
            ghostty_terminal_set(
                term,
                GHOSTTY_TERMINAL_OPT_MODE_DEFAULT,
                &alt_scroll as *const _ as *const c_void,
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
            }
        }
    }

    /// The colours a cell without its own is drawn in, and the cursor's.
    pub fn set_colors(&mut self, fg: Rgb, bg: Rgb, cursor: Rgb) {
        let c = |rgb: Rgb| GhosttyColorRgb {
            r: rgb.0,
            g: rgb.1,
            b: rgb.2,
        };
        let (fg, bg, cursor) = (c(fg), c(bg), c(cursor));
        unsafe {
            for (option, color) in [
                (GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &fg),
                (GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &bg),
                (GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor),
            ] {
                ghostty_terminal_set(self.term, option, color as *const _ as *const c_void);
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

    /// Whether the program has DEC private mode `mode` set.
    pub fn mode(&self, mode: GhosttyMode) -> bool {
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
            tag: GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA,
            ..Default::default()
        };
        scroll.value.delta = delta;
        unsafe { ghostty_terminal_scroll_viewport(self.term, scroll) };
    }

    pub fn scroll_to_bottom(&mut self) {
        let scroll = GhosttyTerminalScrollViewport {
            tag: GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM,
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
            let (fg, bg) = (Rgb::from(colors.foreground), Rgb::from(colors.background));
            let palette = colors.palette;
            let mut rows = Vec::with_capacity(self.rows as usize);
            ghostty_render_state_get(
                state,
                GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                &mut self.rows_it as *mut _ as *mut c_void,
            );
            while ghostty_render_state_row_iterator_next(self.rows_it) {
                let mut selection = GhosttyRenderStateRowSelection {
                    size: std::mem::size_of::<GhosttyRenderStateRowSelection>(),
                    ..Default::default()
                };
                let selected = (ghostty_render_state_row_get(
                    self.rows_it,
                    GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
                    &mut selection as *mut _ as *mut c_void,
                ) == GHOSTTY_SUCCESS)
                    .then_some(selection.start_x..=selection.end_x);
                ghostty_render_state_row_get(
                    self.rows_it,
                    GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                    &mut self.cells as *mut _ as *mut c_void,
                );
                let mut row = Vec::with_capacity(self.cols as usize);
                while ghostty_render_state_row_cells_next(self.cells) {
                    let mut cell = self.read_cell(fg, bg, &palette);
                    cell.selected = selected
                        .as_ref()
                        .is_some_and(|range| range.contains(&(row.len() as u16)));
                    row.push(cell);
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
            let cursor = (cur.visible && cur.viewport_has_value).then(|| {
                let x = if cur.wide_tail {
                    cur.viewport_x.saturating_sub(1)
                } else {
                    cur.viewport_x
                };
                let wide = rows
                    .get(cur.viewport_y as usize)
                    .and_then(|row: &Vec<Cell>| row.get(x as usize))
                    .is_some_and(|cell| cell.wide);
                Cursor {
                    x,
                    y: cur.viewport_y,
                    style: match cur.visual_style {
                        GHOSTTY_CURSOR_STYLE_BAR => CursorStyle::Bar,
                        GHOSTTY_CURSOR_STYLE_UNDERLINE => CursorStyle::Underline,
                        GHOSTTY_CURSOR_STYLE_BLOCK_HOLLOW => CursorStyle::BlockHollow,
                        _ => CursorStyle::Block,
                    },
                    blinking: cur.blinking,
                    wide,
                }
            });
            ghostty_render_state_clean(state);
            Frame {
                rows,
                cursor,
                fg,
                bg,
                cursor_color: colors.cursor_has_value.then(|| Rgb::from(colors.cursor)),
            }
        }
    }

    unsafe fn read_cell(
        &mut self,
        fg_default: Rgb,
        bg_default: Rgb,
        palette: &[GhosttyColorRgb; 256],
    ) -> Cell {
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
            let mut link = false;
            ghostty_cell_get(
                raw,
                GHOSTTY_CELL_DATA_HAS_HYPERLINK,
                &mut link as *mut _ as *mut c_void,
            );
            let mut style = GhosttyStyle::default();
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
            let has = |flag: u32| u32::from(style.flags) & flag != 0;
            let (fg, bg) = if has(GHOSTTY_STYLE_FLAG_INVERSE) {
                (bg.unwrap_or(bg_default), Some(fg))
            } else {
                (fg, bg)
            };
            let underline_color = match GhosttyStyleColorTag::from(style.underline_color.tag) {
                GHOSTTY_STYLE_COLOR_RGB => Some(Rgb::from(style.underline_color.value.rgb)),
                GHOSTTY_STYLE_COLOR_PALETTE => Some(Rgb::from(
                    palette[style.underline_color.value.palette as usize],
                )),
                _ => None,
            };
            let mut text = String::new();
            if wide != GHOSTTY_CELL_WIDE_SPACER_TAIL
                && wide != GHOSTTY_CELL_WIDE_SPACER_HEAD
                && !has(GHOSTTY_STYLE_FLAG_INVISIBLE)
            {
                let mut len: u32 = 0;
                ghostty_render_state_row_cells_get(
                    c,
                    GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
                    &mut len as *mut _ as *mut c_void,
                );
                if len > 0 {
                    let mut codepoints = vec![0u32; len as usize];
                    let mut graphemes = GhosttyCodepointBuffer {
                        ptr: codepoints.as_mut_ptr(),
                        cap: codepoints.len(),
                        len: 0,
                    };
                    ghostty_render_state_row_cells_get(
                        c,
                        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
                        &mut graphemes as *mut _ as *mut c_void,
                    );
                    codepoints.truncate(graphemes.len);
                    text = codepoints.into_iter().filter_map(char::from_u32).collect();
                }
            }
            Cell {
                text,
                fg,
                bg,
                bold: has(GHOSTTY_STYLE_FLAG_BOLD),
                italic: has(GHOSTTY_STYLE_FLAG_ITALIC),
                faint: has(GHOSTTY_STYLE_FLAG_FAINT),
                blink: has(GHOSTTY_STYLE_FLAG_BLINK),
                strikethrough: has(GHOSTTY_STYLE_FLAG_STRIKETHROUGH),
                overline: has(GHOSTTY_STYLE_FLAG_OVERLINE),
                underline: match GhosttySgrUnderline::from(
                    (u32::from(style.flags) & GHOSTTY_STYLE_UNDERLINE_MASK)
                        >> GHOSTTY_STYLE_UNDERLINE_SHIFT,
                ) {
                    GHOSTTY_SGR_UNDERLINE_SINGLE => Underline::Single,
                    GHOSTTY_SGR_UNDERLINE_DOUBLE => Underline::Double,
                    GHOSTTY_SGR_UNDERLINE_CURLY => Underline::Curly,
                    GHOSTTY_SGR_UNDERLINE_DOTTED => Underline::Dotted,
                    GHOSTTY_SGR_UNDERLINE_DASHED => Underline::Dashed,
                    _ => Underline::None,
                },
                underline_color,
                wide: wide == GHOSTTY_CELL_WIDE_WIDE,
                spacer: wide == GHOSTTY_CELL_WIDE_SPACER_TAIL
                    || wide == GHOSTTY_CELL_WIDE_SPACER_HEAD,
                link,
                selected: false,
            }
        }
    }

    fn grid_ref(&self, tag: GhosttyPointTag, x: u16, y: u32) -> Option<GhosttyGridRef> {
        let point = GhosttyPoint {
            tag,
            value: GhosttyPointValue {
                coordinate: GhosttyPointCoordinate { x, y },
            },
        };
        let mut grid = GhosttyGridRef::default();
        let r = unsafe { ghostty_terminal_grid_ref(self.term, point, &mut grid) };
        (r == GHOSTTY_SUCCESS && !grid.node.is_null()).then_some(grid)
    }

    fn screen_of(&self, grid: &GhosttyGridRef) -> Option<ScreenPoint> {
        let mut out = GhosttyPointCoordinate::default();
        let r = unsafe {
            ghostty_terminal_point_from_grid_ref(
                self.term,
                grid,
                GHOSTTY_POINT_TAG_SCREEN,
                &mut out,
            )
        };
        (r == GHOSTTY_SUCCESS).then_some(ScreenPoint { y: out.y, x: out.x })
    }

    /// The screen cell under column `x` of viewport row `y`.
    pub fn screen_point(&self, x: u16, y: u16) -> Option<ScreenPoint> {
        let grid = self.grid_ref(GHOSTTY_POINT_TAG_VIEWPORT, x, u32::from(y))?;
        self.screen_of(&grid)
    }

    /// Where `point` shows in the viewport, if it does.
    pub fn viewport_point(&self, point: ScreenPoint) -> Option<(u16, u16)> {
        let grid = self.grid_ref(GHOSTTY_POINT_TAG_SCREEN, point.x, point.y)?;
        let mut out = GhosttyPointCoordinate::default();
        let r = unsafe {
            ghostty_terminal_point_from_grid_ref(
                self.term,
                &grid,
                GHOSTTY_POINT_TAG_VIEWPORT,
                &mut out,
            )
        };
        (r == GHOSTTY_SUCCESS).then_some((out.x, out.y as u16))
    }

    /// The word or line around `at`, as Ghostty's double and triple click find it.
    fn around(&self, at: ScreenPoint, unit: Unit) -> Option<(ScreenPoint, ScreenPoint)> {
        let grid = self.grid_ref(GHOSTTY_POINT_TAG_SCREEN, at.x, at.y)?;
        let mut sel = GhosttySelection {
            start: grid,
            end: grid,
            rectangle: false,
        };
        let r = match unit {
            Unit::Cell => return Some((at, at)),
            Unit::Word => {
                let options = GhosttyTerminalSelectWordOptions {
                    size: std::mem::size_of::<GhosttyTerminalSelectWordOptions>(),
                    ref_: grid,
                    boundary_codepoints: std::ptr::null(),
                    boundary_codepoints_len: 0,
                };
                // SAFETY: grid_ref validated this cell in the live terminal, which
                // cannot be mutated during this borrow. Both structs are initialized
                // and live for the call. selection.h defines NULL/0 as default boundaries.
                unsafe { ghostty_terminal_select_word(self.term, &options, &mut sel) }
            }
            Unit::Line => {
                let options = GhosttyTerminalSelectLineOptions {
                    size: std::mem::size_of::<GhosttyTerminalSelectLineOptions>(),
                    ref_: grid,
                    whitespace: std::ptr::null(),
                    whitespace_len: 0,
                    semantic_prompt_boundary: false,
                };
                // SAFETY: the same live-grid and output-struct invariants as above;
                // selection.h defines NULL/0 as Ghostty's default line whitespace.
                unsafe { ghostty_terminal_select_line(self.term, &options, &mut sel) }
            }
        };
        if r != GHOSTTY_SUCCESS {
            return Some((at, at));
        }
        let (a, b) = (self.screen_of(&sel.start)?, self.screen_of(&sel.end)?);
        Some((a.min(b), a.max(b)))
    }

    /// Selects from `anchor` to `head` by `unit`, both ends included, as the terminal's
    /// selection, which the next frame shows.
    pub fn select(&mut self, anchor: ScreenPoint, head: ScreenPoint, unit: Unit) {
        let (Some(a), Some(b)) = (self.around(anchor, unit), self.around(head, unit)) else {
            return self.clear_selection();
        };
        let (start, end) = (a.0.min(b.0), a.1.max(b.1));
        let (Some(start), Some(end)) = (
            self.grid_ref(GHOSTTY_POINT_TAG_SCREEN, start.x, start.y),
            self.grid_ref(GHOSTTY_POINT_TAG_SCREEN, end.x, end.y),
        ) else {
            return self.clear_selection();
        };
        let sel = GhosttySelection {
            start,
            end,
            rectangle: false,
        };
        unsafe {
            ghostty_terminal_set(
                self.term,
                GHOSTTY_TERMINAL_OPT_SELECTION,
                &sel as *const _ as *const c_void,
            )
        };
    }

    pub fn clear_selection(&mut self) {
        unsafe {
            ghostty_terminal_set(self.term, GHOSTTY_TERMINAL_OPT_SELECTION, std::ptr::null())
        };
    }

    /// The selected text, soft wraps joined and trailing spaces trimmed, as Ghostty copies it.
    pub fn selection_text(&self) -> Option<String> {
        let mut selection = GhosttySelection::default();
        let mut formatter: GhosttyFormatter = std::ptr::null_mut();
        let unwrap = true;
        // SAFETY: the handle stays live and immutable for this borrow, so the selection
        // snapshot stays valid; the formatter copies each option and is freed below.
        unsafe {
            if ghostty_terminal_get(
                self.term,
                GHOSTTY_TERMINAL_DATA_SELECTION,
                &mut selection as *mut _ as *mut c_void,
            ) != GHOSTTY_SUCCESS
                || ghostty_formatter_terminal_new(std::ptr::null(), &mut formatter, self.term)
                    != GHOSTTY_SUCCESS
            {
                return None;
            }
            let text = (ghostty_formatter_set(
                formatter,
                GHOSTTY_FORMATTER_OPT_UNWRAP,
                &unwrap as *const _ as *const c_void,
            ) == GHOSTTY_SUCCESS
                && ghostty_formatter_set(
                    formatter,
                    GHOSTTY_FORMATTER_OPT_SELECTION,
                    &selection as *const _ as *const c_void,
                ) == GHOSTTY_SUCCESS)
                .then(|| {
                    read_text(|buf, written| {
                        ghostty_formatter_format_buf(
                            formatter,
                            buf.as_mut_ptr(),
                            buf.len(),
                            written,
                        )
                    })
                })
                .flatten();
            ghostty_formatter_free(formatter);
            text
        }
    }

    /// The OSC 8 hyperlink under column `x` of viewport row `y`.
    pub fn hyperlink_at(&self, x: u16, y: u16) -> Option<String> {
        let grid = self.grid_ref(GHOSTTY_POINT_TAG_VIEWPORT, x, u32::from(y))?;
        read_text(|buf, written| {
            // SAFETY: grid came from this terminal and no write can invalidate it
            // during this borrow. Ghostty bounds the copy by the supplied slice length.
            unsafe { ghostty_grid_ref_hyperlink_uri(&grid, buf.as_mut_ptr(), buf.len(), written) }
        })
    }

    /// What to tell the program when the terminal gains or loses focus, if it asked (mode 1004).
    pub fn focus_report(&self, gained: bool) -> Vec<u8> {
        if !self.mode(FOCUS_EVENTS) {
            return Vec::new();
        }
        let mut buf = [0u8; 8];
        let mut len = 0usize;
        let event = if gained {
            GHOSTTY_FOCUS_GAINED
        } else {
            GHOSTTY_FOCUS_LOST
        };
        let r =
            unsafe { ghostty_focus_encode(event, buf.as_mut_ptr() as *mut _, buf.len(), &mut len) };
        if r != GHOSTTY_SUCCESS {
            return Vec::new();
        }
        buf[..len].to_vec()
    }

    /// The cursor a program gets when it resets it (`CSI 0 q`), and starts with.
    pub fn set_default_cursor(&mut self, style: CursorStyle, blink: bool) {
        let style: GhosttyCursorStyle = match style {
            CursorStyle::Bar => GHOSTTY_CURSOR_STYLE_BAR,
            CursorStyle::Underline => GHOSTTY_CURSOR_STYLE_UNDERLINE,
            CursorStyle::BlockHollow => GHOSTTY_CURSOR_STYLE_BLOCK_HOLLOW,
            CursorStyle::Block => GHOSTTY_CURSOR_STYLE_BLOCK,
        };
        unsafe {
            ghostty_terminal_set(
                self.term,
                GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_STYLE,
                &style as *const _ as *const c_void,
            );
            ghostty_terminal_set(
                self.term,
                GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_BLINK,
                &blink as *const _ as *const c_void,
            );
        }
        self.write(b"\x1b[0 q");
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
            ghostty_key_encoder_set_from_terminal(self.keys, self.term);
            let e = self.key_event;
            ghostty_key_event_set_action(e, GHOSTTY_KEY_ACTION_PRESS);
            ghostty_key_event_set_key(e, key);
            ghostty_key_event_set_mods(e, mods);
            let printable = text.is_some_and(|t| !t.is_empty() && !t.chars().any(char::is_control));
            ghostty_key_event_set_consumed_mods(e, if printable { consumed } else { 0 });
            match text {
                Some(t) if printable => ghostty_key_event_set_utf8(
                    e,
                    GhosttyString {
                        ptr: t.as_ptr(),
                        len: t.len(),
                    },
                ),
                _ => ghostty_key_event_set_utf8(e, GhosttyString::default()),
            };
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
        let Some(screen_width) = u32::from(self.cols).checked_mul(cell.0) else {
            return Vec::new();
        };
        let Some(screen_height) = u32::from(self.rows).checked_mul(cell.1) else {
            return Vec::new();
        };
        if screen_width == 0 || screen_height == 0 {
            return Vec::new();
        }
        // Ghostty converts to u16 cells before clamping, and SGR-Pixels rounds into
        // i32 pixels. Reject values those conversions cannot represent, including
        // NaN/inf, while preserving normal releases outside the pane's bounds.
        let coordinate_fits = |value: f32, cell: u32| {
            let pixel = f64::from(value);
            pixel.is_finite()
                && pixel.round() >= f64::from(i32::MIN)
                && pixel.round() <= f64::from(i32::MAX)
                && pixel.max(0.0) / f64::from(cell) < f64::from(u16::MAX) + 1.0
        };
        if !coordinate_fits(x, cell.0)
            || !coordinate_fits(y, cell.1)
            || !matches!(
                action,
                GHOSTTY_MOUSE_ACTION_PRESS
                    | GHOSTTY_MOUSE_ACTION_RELEASE
                    | GHOSTTY_MOUSE_ACTION_MOTION
            )
            || button.is_some_and(|button| {
                !(GHOSTTY_MOUSE_BUTTON_UNKNOWN..=GHOSTTY_MOUSE_BUTTON_ELEVEN).contains(&button)
            })
        {
            return Vec::new();
        }
        let size = GhosttyMouseEncoderSize {
            size: std::mem::size_of::<GhosttyMouseEncoderSize>(),
            screen_width,
            screen_height,
            cell_width: cell.0,
            cell_height: cell.1,
            ..Default::default()
        };
        let e = self.mouse_event;
        let mut buf = [0u8; 64];
        let mut len = 0usize;
        // SAFETY: these handles are owned by Vt until Drop. The sized option is
        // initialized, its dimensions and event values were checked above, and it
        // is copied by set. encode writes only within the live buffer's capacity.
        let r = unsafe {
            ghostty_mouse_encoder_set_from_terminal(self.mouse, self.term);
            ghostty_mouse_encoder_set(
                self.mouse,
                GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
                &size as *const _ as *const c_void,
            );
            ghostty_mouse_event_set_action(e, action);
            match button {
                Some(b) => ghostty_mouse_event_set_button(e, b),
                None => ghostty_mouse_event_clear_button(e),
            };
            ghostty_mouse_event_set_mods(e, mods);
            ghostty_mouse_event_set_position(e, GhosttyMousePosition { x, y });
            ghostty_mouse_encoder_encode(
                self.mouse,
                e,
                buf.as_mut_ptr() as *mut _,
                buf.len(),
                &mut len,
            )
        };
        if r != GHOSTTY_SUCCESS {
            return Vec::new();
        }
        buf.get(..len).unwrap_or_default().to_vec()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_read_refuses_an_unallocatable_length_before_the_second_call() {
        let mut calls = 0;
        let text = read_text(|_, written| {
            calls += 1;
            *written = usize::MAX;
            GHOSTTY_OUT_OF_SPACE
        });
        assert_eq!(text, None);
        assert_eq!(calls, 1);
    }

    #[test]
    fn text_read_refuses_an_output_length_beyond_its_buffer() {
        for result in [GHOSTTY_SUCCESS, GHOSTTY_OUT_OF_SPACE] {
            let text = read_text(|buf, written| {
                if buf.is_empty() {
                    *written = 2;
                    GHOSTTY_OUT_OF_SPACE
                } else {
                    *written = 3;
                    result
                }
            });
            assert_eq!(text, None);
        }
    }
}
