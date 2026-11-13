//! Rows and the cursor painted into pixels as Ghostty paints them, read back pixel by pixel.

use collie_desktop_terminal::config::{GHOSTTY, Look};
use collie_desktop_terminal::paint::{Image, Painter};
use collie_desktop_terminal::vt::{CursorStyle, Frame, Unit, Vt};

const BG: [u8; 4] = [0x28, 0x2c, 0x34, 255];
const FG: [u8; 4] = [0xff, 0xff, 0xff, 255];

fn painted(text: &str, cols: u16, rows: u16) -> (Frame, Painter) {
    let mut vt = Vt::new(cols, rows, &GHOSTTY);
    vt.write(text.as_bytes());
    (vt.frame(), Painter::new(&Look::default(), 1.0))
}

fn luma([r, g, b, _]: [u8; 4]) -> u32 {
    u32::from(r) * 2126 + u32::from(g) * 7152 + u32::from(b) * 722
}

#[test]
fn the_bundled_font_at_12pt_makes_ghosttys_own_cell_of_10_by_21() {
    let painter = Painter::new(&Look::default(), 1.0);
    assert_eq!(painter.fonts.family, "JetBrains Mono");
    // Measured off Ghostty 1.3.1 with its defaults, on the same bytes.
    assert_eq!(painter.cell(), (10, 21));
    // 0.6 em at 32 px rounds to 19, as Ghostty rounds it on a display of scale 2.
    assert_eq!(Painter::new(&Look::default(), 2.0).cell().0, 19);
}

#[test]
fn box_drawing_meets_its_neighbours_across_cells_and_rows() {
    let (frame, mut painter) = painted("─┼─\r\n │", 3, 2);
    let (cw, ch) = painter.cell();
    let top = painter.row(&frame, 0, None);
    let line_y = (0..ch)
        .find(|y| top.pixel(0, *y) == FG)
        .expect("a horizontal line");
    assert!(
        (0..3 * cw).all(|x| top.pixel(x, line_y) == FG),
        "a gap in ─┼─"
    );
    let below = painter.row(&frame, 1, None);
    let line_x = (cw..2 * cw)
        .find(|x| below.pixel(*x, 0) == FG)
        .expect("a vertical line");
    assert_eq!(
        top.pixel(line_x, ch - 1),
        FG,
        "┼ reaches the bottom of its cell"
    );
    assert_eq!(
        below.pixel(line_x, ch - 1),
        FG,
        "│ reaches the bottom of its cell"
    );
}

#[test]
fn faint_text_is_drawn_at_half_strength_and_bold_inverse_at_full() {
    let (frame, mut painter) = painted("\x1b[2m█\x1b[0m█\x1b[7m \x1b[0m", 3, 1);
    let row = painter.row(&frame, 0, None);
    let (cw, ch) = painter.cell();
    let (faint, full, inverse) = (
        row.pixel(cw / 2, ch / 2),
        row.pixel(cw + cw / 2, ch / 2),
        row.pixel(2 * cw + cw / 2, ch / 2),
    );
    assert_eq!(full, FG);
    assert_eq!(inverse, FG);
    assert!(
        luma(BG) < luma(faint) && luma(faint) < luma(FG),
        "{faint:?}"
    );
}

#[test]
fn underline_styles_strike_and_overline_each_draw_their_own_lines() {
    let (frame, mut painter) = painted(
        "\x1b[4:1ma\x1b[4:2mb\x1b[4:3mc\x1b[4:4md\x1b[4:5me\x1b[0m\x1b[9mf\x1b[0m\x1b[53mg",
        7,
        1,
    );
    let row = painter.row(&frame, 0, None);
    let (cw, ch) = painter.cell();
    // Each cell's lit rows below its baseline, by count, tell the styles apart.
    let lit_below = |cell: u32| -> Vec<u32> {
        (ch * 2 / 3..ch)
            .filter(|y| (cell * cw..cell * cw + cw).any(|x| row.pixel(x, *y) != BG))
            .collect()
    };
    let single = lit_below(0);
    let double = lit_below(1);
    assert!(!single.is_empty());
    assert!(
        double.len() > single.len(),
        "double {double:?} single {single:?}"
    );
    let dotted_gaps = (3 * cw..4 * cw)
        .filter(|x| (ch * 4 / 5..ch).all(|y| row.pixel(*x, y) == BG))
        .count();
    assert!(dotted_gaps > 0, "dots have gaps between them");
    let lit = |cell: u32, y: u32| {
        (cell * cw..cell * cw + cw)
            .filter(|x| row.pixel(*x, y) != BG)
            .count()
    };
    let strike_y = (0..ch).max_by_key(|y| lit(5, *y)).unwrap();
    assert_eq!(
        lit(5, strike_y) as u32,
        cw,
        "strikethrough crosses its cell"
    );
    assert!((ch / 4..ch * 3 / 4).contains(&strike_y));
    assert_eq!(lit(6, 0) as u32, cw, "overline at the cell's top");
}

#[test]
fn a_block_cursor_fills_its_cell_and_goes_hollow_when_the_terminal_loses_focus() {
    let (frame, mut painter) = painted("ab", 4, 1);
    let cursor = frame.cursor.unwrap();
    assert_eq!((cursor.x, cursor.style), (2, CursorStyle::Block));
    let (cw, ch) = painter.cell();
    let focused = painter.cursor(&frame, &cursor, true);
    assert_eq!((focused.width, focused.height), (cw, ch));
    assert_eq!(focused.pixel(cw / 2, ch / 2), FG);
    let unfocused = painter.cursor(&frame, &cursor, false);
    assert_eq!(unfocused.pixel(cw / 2, ch / 2)[3], 0, "hollow inside");
    assert_eq!(unfocused.pixel(0, ch / 2), FG);
    assert_eq!(unfocused.pixel(cw - 1, 0), FG);
}

#[test]
fn decscusr_turns_the_cursor_into_a_blinking_bar_or_a_steady_underline() {
    let mut vt = Vt::new(10, 2, &GHOSTTY);
    vt.write(b"\x1b[5 q");
    let bar = vt.frame().cursor.unwrap();
    assert_eq!((bar.style, bar.blinking), (CursorStyle::Bar, true));
    let mut painter = Painter::new(&Look::default(), 1.0);
    let (cw, ch) = painter.cell();
    let image: Image = painter.cursor(&vt.frame(), &bar, true);
    assert_eq!(image.pixel(0, ch / 2), FG);
    assert_eq!(image.pixel(cw / 2, ch / 2)[3], 0);
    vt.write(b"\x1b[4 q");
    let under = vt.frame().cursor.unwrap();
    assert_eq!(
        (under.style, under.blinking),
        (CursorStyle::Underline, false)
    );
}

#[test]
fn a_selection_is_drawn_in_the_cells_colours_swapped_and_copied_as_text() {
    let mut vt = Vt::new(20, 2, &GHOSTTY);
    vt.write(b"hello world\r\nnext");
    let from = vt.screen_point(6, 0).unwrap();
    vt.select(from, from, Unit::Word);
    assert_eq!(vt.selection_text().as_deref(), Some("world"));
    let frame = vt.frame();
    let selected: Vec<usize> = (0..20).filter(|x| frame.cell(*x, 0).selected).collect();
    assert_eq!(selected, (6..11).collect::<Vec<_>>());
    let mut painter = Painter::new(&Look::default(), 1.0);
    let row = painter.row(&frame, 0, None);
    let (cw, _) = painter.cell();
    // A corner of a selected cell is its foreground, where text would be its background.
    assert_eq!(row.pixel(6 * cw, 0), FG);
    assert_eq!(row.pixel(5 * cw, 0), BG);
    let to = vt.screen_point(3, 1).unwrap();
    let start = vt.screen_point(0, 0).unwrap();
    vt.select(start, to, Unit::Cell);
    assert_eq!(vt.selection_text().as_deref(), Some("hello world\nnext"));
}

#[test]
fn a_fallback_wide_glyph_fills_its_two_cells_and_the_text_after_keeps_its_column() {
    let (frame, mut painter) = painted("水x", 4, 1);
    let row = painter.row(&frame, 0, None);
    let (cw, ch) = painter.cell();
    let ink = |x0: u32, x1: u32| {
        (x0..x1)
            .filter(|x| (0..ch).any(|y| row.pixel(*x, y) != BG))
            .count() as u32
    };
    // 水 from a CJK fallback, sized as Ghostty sizes it, spans most of its two cells.
    assert!(ink(0, 2 * cw) > cw + cw / 2, "{}", ink(0, 2 * cw));
    assert!(ink(2 * cw, 3 * cw) > 0, "x drawn in the third cell");
}
