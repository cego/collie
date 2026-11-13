//! How fast the VT state takes a 50 MiB stream: the recorded fixtures' frames, played in turn
//! until 50 MiB, written in the 64 KiB reads a socket gives; and how long painting a whole
//! screen takes when every row changed, at 200 by 60 on a display of scale 2, and drawing the
//! view while output scrolls it. Evidence for the gate, not a claim.
//!
//! `cargo run --release -p collie-desktop-terminal --example throughput`

use base64::Engine;
use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::config::{GHOSTTY, Look};
use collie_desktop_terminal::paint::Painter;
use collie_desktop_terminal::view::{Tab, terminal_at};
use collie_desktop_terminal::vt::Vt;
use std::time::Instant;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/terminal");
fn itself(tab: &mut Tab) -> Option<&mut Tab> {
    Some(tab)
}

const TOTAL: usize = 50 * 1024 * 1024;

fn main() {
    let mut recorded = Vec::new();
    for name in ["herdr-ls", "herdr-vim", "core-attach"] {
        let lines = std::fs::read_to_string(format!("{FIXTURES}/{name}.ndjson")).unwrap();
        for line in lines.lines() {
            if let TerminalEvent::Frame(frame) = serde_json::from_str(line).unwrap() {
                recorded.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(frame.bytes)
                        .unwrap(),
                );
            }
        }
    }
    let stream: Vec<u8> = recorded.iter().copied().cycle().take(TOTAL).collect();
    let mut vt = Vt::new(100, 30, &GHOSTTY);
    let started = Instant::now();
    for read in stream.chunks(64 * 1024) {
        vt.write(read);
        vt.take_replies();
    }
    let frame = vt.frame();
    let took = started.elapsed().as_secs_f64();
    println!(
        "{} bytes ({} recorded, repeated) in {took:.3} s: {:.1} MiB/s; last row {:?}",
        stream.len(),
        recorded.len(),
        stream.len() as f64 / took / 1024.0 / 1024.0,
        frame.line(29),
    );

    let mut vt = Vt::new(200, 60, &GHOSTTY);
    let mut painter = Painter::new(&Look::default(), 2.0);
    let mut took: Vec<f64> = Vec::new();
    for read in stream.chunks(16 * 1024).take(300) {
        vt.write(read);
        vt.take_replies();
        let started = Instant::now();
        let frame = vt.frame();
        for y in 0..frame.rows.len() {
            std::hint::black_box(painter.row(&frame, y, None));
        }
        took.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    took.sort_by(f64::total_cmp);
    println!(
        "a full 200x60 screen at scale 2, every row repainted: p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms over {} frames",
        took[took.len() / 2],
        took[took.len() * 95 / 100],
        took[took.len() - 1],
        took.len(),
    );

    let mut tab = Tab::with_look(None, "local".into(), 200, 60, Look::default());
    let mut took: Vec<f64> = Vec::new();
    for n in 0..300 {
        let line = format!(
            "\x1b[3{}m{n:>6}\x1b[0m {}\r\n",
            n % 8,
            "scrolling output ".repeat(10)
        );
        let bytes = base64::engine::general_purpose::STANDARD.encode(line);
        tab.shown(
            serde_json::from_value(serde_json::json!({"_tag": "Frame", "bytes": bytes})).unwrap(),
        );
        let started = Instant::now();
        std::hint::black_box(terminal_at(&tab, itself, 2.0));
        took.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    took.sort_by(f64::total_cmp);
    println!(
        "the view of a 200x60 terminal at scale 2 as a line scrolls in: p50 {:.2} ms, p95 {:.2} ms over {} frames",
        took[took.len() / 2],
        took[took.len() * 95 / 100],
        took.len(),
    );
}
