//! The Machines page.

use crate::App;
use rune::{El, text};
use rune_kit::Kit;

#[derive(Default)]
pub struct Machines {}

impl Machines {
    /// The sidebar has opened this page.
    pub fn opened(_app: &mut App) {}
}

pub fn view(_app: &App, k: &Kit, _layer: &mut Vec<El>) -> El {
    text("Machines").color(k.c.text_muted)
}
