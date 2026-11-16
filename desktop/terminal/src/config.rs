//! What the terminal looks like: Ghostty's defaults, and what the human's own Ghostty config
//! changes of them, so a pane looks as it does in their Ghostty.

use crate::vt::{Rgb, Theme};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Ghostty's default colours (`ghostty +show-config --default`).
pub const GHOSTTY: Theme = Theme {
    fg: Rgb(0xff, 0xff, 0xff),
    bg: Rgb(0x28, 0x2c, 0x34),
    cursor: Rgb(0xff, 0xff, 0xff),
    palette16: [
        Rgb(0x1d, 0x1f, 0x21),
        Rgb(0xcc, 0x66, 0x66),
        Rgb(0xb5, 0xbd, 0x68),
        Rgb(0xf0, 0xc6, 0x74),
        Rgb(0x81, 0xa2, 0xbe),
        Rgb(0xb2, 0x94, 0xbb),
        Rgb(0x8a, 0xbe, 0xb7),
        Rgb(0xc5, 0xc8, 0xc6),
        Rgb(0x66, 0x66, 0x66),
        Rgb(0xd5, 0x4e, 0x53),
        Rgb(0xb9, 0xca, 0x4a),
        Rgb(0xe7, 0xc5, 0x47),
        Rgb(0x7a, 0xa6, 0xda),
        Rgb(0xc3, 0x97, 0xd8),
        Rgb(0x70, 0xc0, 0xb1),
        Rgb(0xea, 0xea, 0xea),
    ],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Bar,
    Underline,
}

/// The settings of Ghostty's that the terminal draws with.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    /// Font families, the first preferred; none is Ghostty's own default, JetBrains Mono.
    pub families: Vec<String>,
    /// In points, at Ghostty's 96 dpi off macOS and 72 on it.
    pub font_size: f32,
    pub theme: Theme,
    /// The text under a block cursor; the background when not set.
    pub cursor_text: Option<Rgb>,
    pub selection_fg: Option<Rgb>,
    pub selection_bg: Option<Rgb>,
    pub cursor_shape: CursorShape,
    /// Whether the cursor blinks; `None` leaves it to the program, blinking by default.
    pub cursor_blink: Option<bool>,
    pub faint_opacity: f32,
    /// Around the grid, in points.
    pub padding: f32,
}

impl Default for Look {
    fn default() -> Look {
        Look {
            families: Vec::new(),
            font_size: 12.0,
            theme: GHOSTTY,
            cursor_text: None,
            selection_fg: None,
            selection_bg: None,
            cursor_shape: CursorShape::Block,
            cursor_blink: None,
            faint_opacity: 0.5,
            padding: 2.0,
        }
    }
}

/// `#rrggbb`, `rrggbb` or `#rgb`, as Ghostty reads a colour.
pub fn color(value: &str) -> Option<Rgb> {
    let hex = value.trim().trim_start_matches('#');
    let byte = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
    match hex.len() {
        6 => Some(Rgb(byte(0)?, byte(2)?, byte(4)?)),
        3 => {
            let nibble = |i: usize| {
                u8::from_str_radix(hex.get(i..i + 1)?, 16)
                    .ok()
                    .map(|n| n * 17)
            };
            Some(Rgb(nibble(0)?, nibble(1)?, nibble(2)?))
        }
        _ => None,
    }
}

impl Look {
    /// `text`, a Ghostty config, over what is already set.
    pub fn read(&mut self, text: &str) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let (key, value) = (key.trim(), value.trim().trim_matches('"'));
            match key {
                "font-family" if value.is_empty() => self.families.clear(),
                "font-family" => self.families.push(value.to_string()),
                "font-size" => {
                    if let Ok(size) = value.parse::<f32>()
                        && size > 0.0
                    {
                        self.font_size = size;
                    }
                }
                "background" => self.theme.bg = color(value).unwrap_or(self.theme.bg),
                "foreground" => self.theme.fg = color(value).unwrap_or(self.theme.fg),
                "cursor-color" => self.theme.cursor = color(value).unwrap_or(self.theme.cursor),
                "cursor-text" => self.cursor_text = color(value),
                "selection-foreground" => self.selection_fg = color(value),
                "selection-background" => self.selection_bg = color(value),
                "palette" => {
                    if let Some((n, rgb)) = value.split_once('=')
                        && let (Ok(n), Some(rgb)) = (n.trim().parse::<usize>(), color(rgb))
                        && n < 16
                    {
                        self.theme.palette16[n] = rgb;
                    }
                }
                "cursor-style" => {
                    self.cursor_shape = match value {
                        "bar" => CursorShape::Bar,
                        "underline" => CursorShape::Underline,
                        _ => CursorShape::Block,
                    }
                }
                "cursor-style-blink" => {
                    self.cursor_blink = match value {
                        "true" => Some(true),
                        "false" => Some(false),
                        _ => None,
                    }
                }
                "faint-opacity" => {
                    if let Ok(opacity) = value.parse::<f32>() {
                        self.faint_opacity = opacity.clamp(0.0, 1.0);
                    }
                }
                _ => {}
            }
        }
    }
}

/// Where Ghostty reads its config, in the order it reads them.
fn config_files() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let xdg = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".config")));
    let mut files = Vec::new();
    if let Some(xdg) = xdg {
        files.push(xdg.join("ghostty/config"));
        files.push(xdg.join("ghostty/config.ghostty"));
    }
    if cfg!(target_os = "macos")
        && let Some(home) = home
    {
        let support = home.join("Library/Application Support/com.mitchellh.ghostty");
        files.push(support.join("config"));
        files.push(support.join("config.ghostty"));
    }
    files
}

/// Ghostty's defaults with `files` read over them.
pub fn look_from(files: &[impl AsRef<Path>]) -> Look {
    let mut look = Look::default();
    for file in files {
        if let Ok(text) = std::fs::read_to_string(file) {
            look.read(&text);
        }
    }
    look
}

/// The human's Ghostty look, read once.
pub fn look() -> &'static Look {
    static LOOK: OnceLock<Look> = OnceLock::new();
    LOOK.get_or_init(|| look_from(&config_files()))
}
