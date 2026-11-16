//! Keys as the bytes a pane is typed, in the program's keyboard modes.

use collie_desktop_terminal::config::GHOSTTY;
use collie_desktop_terminal::keys::typed;
use collie_desktop_terminal::vt::Vt;
use rune::{Key, KeyEvent, Mods};

fn press(key: Key, mods: Mods) -> KeyEvent {
    KeyEvent { key, mods }
}

fn plain(key: Key) -> KeyEvent {
    press(key, Mods::default())
}

#[test]
fn named_keys_type_their_sequences_and_the_arrows_follow_application_cursor_mode() {
    let mut vt = Vt::new(80, 24, &GHOSTTY);
    assert_eq!(typed(&mut vt, &plain(Key::Enter)), Some(b"\r".to_vec()));
    assert_eq!(
        typed(&mut vt, &plain(Key::Backspace)),
        Some(b"\x7f".to_vec())
    );
    assert_eq!(typed(&mut vt, &plain(Key::Tab)), Some(b"\t".to_vec()));
    assert_eq!(typed(&mut vt, &plain(Key::Escape)), Some(b"\x1b".to_vec()));
    assert_eq!(
        typed(&mut vt, &plain(Key::Function(1))),
        Some(b"\x1bOP".to_vec())
    );
    assert_eq!(typed(&mut vt, &plain(Key::Up)), Some(b"\x1b[A".to_vec()));
    vt.write(b"\x1b[?1h");
    assert_eq!(typed(&mut vt, &plain(Key::Up)), Some(b"\x1bOA".to_vec()));
}

#[test]
fn text_types_itself_and_ctrl_or_alt_with_a_letter_types_its_control_byte_or_escape() {
    let mut vt = Vt::new(80, 24, &GHOSTTY);
    assert_eq!(
        typed(&mut vt, &plain(Key::Text("é".into()))),
        Some("é".as_bytes().to_vec())
    );
    let ctrl = Mods {
        cmd: !cfg!(target_os = "macos"),
        ctrl: true,
        ..Mods::default()
    };
    let ctrl_c = if cfg!(target_os = "macos") {
        Key::Text("c".into())
    } else {
        Key::Command('c')
    };
    assert_eq!(typed(&mut vt, &press(ctrl_c, ctrl)), Some(b"\x03".to_vec()));
    let alt = Mods {
        alt: true,
        ..Mods::default()
    };
    assert_eq!(
        typed(&mut vt, &press(Key::Text("x".into()), alt)),
        Some(b"\x1bx".to_vec())
    );
}
