//! The VT state beyond the recorded streams: wide glyphs and the scrollback.

use collie_desktop_terminal::config::GHOSTTY;
use collie_desktop_terminal::vt::Vt;

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
