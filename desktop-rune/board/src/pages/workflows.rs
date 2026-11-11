//! The Workflows page.

use crate::App;
use rune::{El, text};
use rune_kit::Kit;

#[derive(Default)]
pub struct Workflows {}

impl Workflows {
    /// The sidebar has opened this page.
    pub fn opened(_app: &mut App) {}
}

pub fn view(_app: &App, k: &Kit, _layer: &mut Vec<El>) -> El {
    text("Workflows").color(k.c.text_muted)
}
