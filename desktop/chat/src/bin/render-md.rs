//! Draws one agent message as the chat does: Desktop's markdown policy, then rune-kit's
//! Markdown, with the highlighter `RENDER_HIGHLIGHTER` names (`builtin` or `syntect`).
//!
//! `RENDER_MD=<file.md> RENDER_HIGHLIGHTER=syntect render-md --snap <png> --size 960x2400`

use collie_desktop_chat::highlight::syntect;
use collie_desktop_chat::policy::confined;
use rune::{App, AppSpec, Cx, El, col};
use rune_kit::Kit;
use rune_kit::markdown::Markdown;
use rune_kit::syntax::Highlighter;

struct Message {
    src: String,
    syntect: bool,
}

fn view(message: &Message, cx: &mut Cx<Message>) -> El {
    let k = Kit::neutral(cx.system_dark());
    let highlighter = if message.syntect {
        Highlighter::new(syntect)
    } else {
        Highlighter::builtin()
    };
    let body = Markdown::new(message.src.clone())
        .highlighter(highlighter)
        .build(&k);
    rune_kit::root(
        col().padding(16.0).fill(k.c.bg_base).w_full().child(body),
        [],
    )
}

fn message() -> Message {
    let file = std::env::var("RENDER_MD").expect("RENDER_MD=<file.md>");
    Message {
        src: confined(&std::fs::read_to_string(file).unwrap()),
        syntect: std::env::var("RENDER_HIGHLIGHTER").is_ok_and(|h| h == "syntect"),
    }
}

fn main() {
    let app = App::new(AppSpec::new(
        "Agent message",
        (960.0, 2400.0),
        message,
        view,
    ));
    if let Err(error) = app.try_run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
