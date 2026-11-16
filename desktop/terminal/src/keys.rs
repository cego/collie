//! A key pressed in the terminal, as the bytes typed into the pane: Ghostty encodes it for the
//! program's keyboard modes, as herdr's server, which runs the same emulator, would.

use crate::vt::Vt;
use ghostty_sys::*;
use rune::{Key, KeyEvent, Mods};

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

/// Ghostty's key for a character typed with a modifier, where it names one.
fn key_of(c: char) -> GhosttyKey {
    match c.to_ascii_lowercase() {
        c @ 'a'..='z' => GHOSTTY_KEY_A + (c as GhosttyKey - 'a' as GhosttyKey),
        c @ '0'..='9' => GHOSTTY_KEY_DIGIT_0 + (c as GhosttyKey - '0' as GhosttyKey),
        ' ' => GHOSTTY_KEY_SPACE,
        '[' => GHOSTTY_KEY_BRACKET_LEFT,
        '-' => GHOSTTY_KEY_MINUS,
        _ => GHOSTTY_KEY_UNIDENTIFIED,
    }
}

/// The bytes `key` types, or none for a key the pane is not sent.
pub fn typed(vt: &mut Vt, key: &KeyEvent) -> Option<Vec<u8>> {
    let named = match &key.key {
        Key::Enter => GHOSTTY_KEY_ENTER,
        Key::Backspace => GHOSTTY_KEY_BACKSPACE,
        Key::Delete => GHOSTTY_KEY_DELETE,
        Key::Left => GHOSTTY_KEY_ARROW_LEFT,
        Key::Right => GHOSTTY_KEY_ARROW_RIGHT,
        Key::Up => GHOSTTY_KEY_ARROW_UP,
        Key::Down => GHOSTTY_KEY_ARROW_DOWN,
        Key::Home => GHOSTTY_KEY_HOME,
        Key::End => GHOSTTY_KEY_END,
        Key::PageUp => GHOSTTY_KEY_PAGE_UP,
        Key::PageDown => GHOSTTY_KEY_PAGE_DOWN,
        Key::Insert => GHOSTTY_KEY_INSERT,
        Key::Escape => GHOSTTY_KEY_ESCAPE,
        Key::Tab => GHOSTTY_KEY_TAB,
        Key::Function(n @ 1..=12) => GHOSTTY_KEY_F1 + GhosttyKey::from(*n - 1),
        // Ctrl with a character off macOS.
        Key::Command(c) if !cfg!(target_os = "macos") => {
            let bytes = vt.encode_key(key_of(*c), mods_of(key.mods), 0, None);
            return (!bytes.is_empty()).then_some(bytes);
        }
        Key::Text(text) if key.mods.ctrl || key.mods.alt => {
            let c = text.chars().next()?;
            let bytes = vt.encode_key(key_of(c), mods_of(key.mods), 0, Some(text));
            return (!bytes.is_empty()).then_some(bytes);
        }
        Key::Text(text) => return Some(text.as_bytes().to_vec()),
        _ => return None,
    };
    let bytes = vt.encode_key(named, mods_of(key.mods), 0, None);
    (!bytes.is_empty()).then_some(bytes)
}
