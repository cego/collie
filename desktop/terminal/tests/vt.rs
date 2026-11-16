//! The VT state beyond the recorded streams: wide glyphs and the scrollback.

use collie_desktop_terminal::config::GHOSTTY;
use collie_desktop_terminal::vt::{ScreenPoint, Unit, Vt};
use ghostty_sys::{
    GHOSTTY_MOUSE_ACTION_MAX_VALUE, GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_ACTION_RELEASE,
    GHOSTTY_MOUSE_BUTTON_LEFT, GHOSTTY_MOUSE_BUTTON_MAX_VALUE,
};

#[test]
fn copied_selection_joins_soft_wraps_but_keeps_hard_lines_and_trims_spaces() {
    let mut vt = Vt::new(6, 4, &GHOSTTY);
    vt.write(b"abcdefghi \r\nxy ");
    let start = vt.screen_point(0, 0).unwrap();
    let end = vt.screen_point(5, 2).unwrap();
    vt.select(start, end, Unit::Cell);
    assert_eq!(vt.selection_text().as_deref(), Some("abcdefghi\nxy"));
    vt.clear_selection();
    assert_eq!(vt.selection_text(), None);
}

#[test]
fn a_wide_glyph_takes_two_columns_and_the_text_after_it_keeps_its_column() {
    let mut vt = Vt::new(20, 4, &GHOSTTY);
    vt.write("日本 ok".as_bytes());
    let frame = vt.frame();
    assert_eq!(frame.line(0), "日本 ok");
    assert!(frame.cell(0, 0).wide);
    assert!(frame.cell(1, 0).spacer);
    assert_eq!(frame.cell(5, 0).text, "o");
}

#[test]
fn the_viewport_scrolls_back_through_what_left_the_screen_and_returns() {
    let mut vt = Vt::new(20, 10, &GHOSTTY);
    for n in 1..=30 {
        vt.write(format!("line {n}\r\n").as_bytes());
    }
    assert_eq!(vt.frame().line(0), "line 22");
    vt.scroll_viewport(-5);
    assert_eq!(vt.frame().line(0), "line 17");
    vt.scroll_to_bottom();
    assert_eq!(vt.frame().line(0), "line 22");
}

#[test]
fn mouse_encoding_rejects_overflowing_or_empty_screen_geometry() {
    let mut vt = Vt::new(80, 24, &GHOSTTY);
    vt.write(b"\x1b[?1000h\x1b[?1006h");
    for cell in [(u32::MAX, 16), (8, u32::MAX), (0, 16), (8, 0)] {
        assert!(
            vt.encode_mouse(
                GHOSTTY_MOUSE_ACTION_PRESS,
                Some(GHOSTTY_MOUSE_BUTTON_LEFT),
                0,
                (4.0, 8.0),
                cell,
            )
            .is_empty(),
            "invalid cell size {cell:?} must not become a mouse report"
        );
    }
    assert_eq!(
        vt.encode_mouse(
            GHOSTTY_MOUSE_ACTION_PRESS,
            Some(GHOSTTY_MOUSE_BUTTON_LEFT),
            0,
            (4.0, 8.0),
            (8, 16),
        ),
        b"\x1b[<0;1;1M"
    );
}

#[test]
fn mouse_encoding_rejects_coordinates_that_ghostty_cannot_convert() {
    let mut vt = Vt::new(80, 24, &GHOSTTY);
    vt.write(b"\x1b[?1000h\x1b[?1016h");
    for coordinate in [
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::MAX,
        f32::MIN,
        65_536.0,
    ] {
        for position in [(coordinate, 0.0), (0.0, coordinate)] {
            assert!(
                vt.encode_mouse(
                    GHOSTTY_MOUSE_ACTION_RELEASE,
                    Some(GHOSTTY_MOUSE_BUTTON_LEFT),
                    0,
                    position,
                    (1, 1),
                )
                .is_empty(),
                "invalid position {position:?} must not enter Ghostty's numeric casts"
            );
        }
    }
    // Releases just outside a pane remain valid, including negative pixel coordinates.
    assert_eq!(
        vt.encode_mouse(
            GHOSTTY_MOUSE_ACTION_RELEASE,
            Some(GHOSTTY_MOUSE_BUTTON_LEFT),
            0,
            (-1.0, 25.0),
            (1, 1),
        ),
        b"\x1b[<0;-1;25m"
    );
    // A large cell makes the grid conversion fit, but the pixel conversion still
    // must not round i32::MAX (not exactly representable as f32) beyond i32.
    assert!(
        vt.encode_mouse(
            GHOSTTY_MOUSE_ACTION_RELEASE,
            Some(GHOSTTY_MOUSE_BUTTON_LEFT),
            0,
            (i32::MAX as f32, 0.0),
            (1_000_000, 1_000_000),
        )
        .is_empty()
    );
}

#[test]
fn invalid_mouse_event_tags_do_not_poison_the_next_valid_report() {
    let mut vt = Vt::new(80, 24, &GHOSTTY);
    vt.write(b"\x1b[?1000h\x1b[?1006h");
    for (action, button) in [
        (GHOSTTY_MOUSE_ACTION_MAX_VALUE, GHOSTTY_MOUSE_BUTTON_LEFT),
        (GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_BUTTON_MAX_VALUE),
    ] {
        assert!(
            vt.encode_mouse(action, Some(button), 0, (0.0, 0.0), (8, 16))
                .is_empty()
        );
    }
    assert_eq!(
        vt.encode_mouse(
            GHOSTTY_MOUSE_ACTION_PRESS,
            Some(GHOSTTY_MOUSE_BUTTON_LEFT),
            0,
            (0.0, 0.0),
            (8, 16)
        ),
        b"\x1b[<0;1;1M"
    );
}

#[test]
fn word_and_line_selection_preserve_utf8_and_reject_points_outside_the_grid() {
    let mut vt = Vt::new(20, 4, &GHOSTTY);
    assert_eq!(vt.selection_text(), None);
    vt.write("café 世界\r\nnext".as_bytes());
    let at = vt.screen_point(2, 0).unwrap();
    vt.select(at, at, Unit::Word);
    assert_eq!(vt.selection_text().as_deref(), Some("café"));
    vt.select(at, at, Unit::Line);
    assert_eq!(vt.selection_text().as_deref(), Some("café 世界"));
    let outside = ScreenPoint {
        x: u16::MAX,
        y: u32::MAX,
    };
    assert_eq!(vt.viewport_point(outside), None);
    vt.select(at, outside, Unit::Line);
    assert_eq!(vt.selection_text(), None);
}
