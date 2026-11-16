//! Prints the notes' table for a corpus of agent messages (`*.md`). With `--png <dir>`, also
//! renders each message headless under both highlighters, by `render-md`.
//!
//! `cargo run -p collie-desktop-chat --bin corpus -- <dir> [--png <dir>]`

use collie_desktop_chat::corpus::{messages, table};
use std::path::Path;
use std::process::Command;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = Path::new(args.first().expect("corpus <dir> [--png <dir>]"));
    let found = messages(dir);
    print!("{}", table(&found));
    let Some(at) = args.iter().position(|a| a == "--png") else {
        return;
    };
    let out = Path::new(&args[at + 1]);
    for (name, _) in &found {
        for highlighter in ["builtin", "syntect"] {
            render(&dir.join(name), highlighter, out);
        }
    }
}

fn render(file: &Path, highlighter: &str, out: &Path) {
    std::fs::create_dir_all(out).unwrap();
    let stem = file.file_stem().unwrap().to_string_lossy();
    let png = out.join(format!("{stem}-{highlighter}.png"));
    let render_md = std::env::current_exe().unwrap().with_file_name("render-md");
    let ran = Command::new(render_md)
        .env("RENDER_MD", file)
        .env("RENDER_HIGHLIGHTER", highlighter)
        .args(["--snap", &png.to_string_lossy(), "--size", "960x2400"])
        .status()
        .unwrap();
    assert!(ran.success(), "render-md {} {highlighter}", file.display());
}
