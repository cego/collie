//! The Usage page.

use crate::App;
use rune::{El, text};
use rune_kit::Kit;

#[derive(Default)]
pub struct Usage {}

impl Usage {
    /// The sidebar has opened this page.
    pub fn opened(_app: &mut App) {}
}

pub fn view(_app: &App, k: &Kit, _layer: &mut Vec<El>) -> El {
    text("Usage").color(k.c.text_muted)
}
