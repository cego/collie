//! A recorded `terminal` stream replayed into a `Tab` and drawn, for a headless look at the
//! terminal without a live pane: nothing is sent anywhere.
//!
//! `REPLAY=fixtures/terminal/herdr-vim.ndjson [FONT=family] cargo run -p collie-desktop-terminal --example replay -- --snap vim.png --size 1000x640`

use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::view::{Tab, terminal_at};
use rune::{AppSpec, Cx, El, col};

struct Replay {
    tab: Tab,
}

fn tab_of(replay: &mut Replay) -> Option<&mut Tab> {
    Some(&mut replay.tab)
}

fn init() -> Replay {
    let path = std::env::var("REPLAY").expect("REPLAY names an .ndjson stream");
    let cols = std::env::var("COLS").map_or(100, |c| c.parse().unwrap());
    let rows = std::env::var("ROWS").map_or(30, |r| r.parse().unwrap());
    // `FONT` draws with another family than the human's Ghostty config names.
    let mut look = collie_desktop_terminal::config::look().clone();
    if let Ok(family) = std::env::var("FONT") {
        look.families = vec![family];
    }
    let mut tab = Tab::with_look(None, "vm-mk".into(), cols, rows, look);
    for line in std::fs::read_to_string(path).unwrap().lines() {
        tab.shown(serde_json::from_str::<TerminalEvent>(line).unwrap());
    }
    Replay { tab }
}

fn view(replay: &Replay, cx: &mut Cx<Replay>) -> El {
    let scale = cx.env().scale;
    col()
        .w_full()
        .h_full()
        .fill(rune::color::hex("#1a1a1a").unwrap())
        .child(terminal_at(&replay.tab, tab_of, scale))
}

fn main() {
    rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        ..AppSpec::new("Replay", (1000.0, 640.0), init, view)
    })
    .run();
}
