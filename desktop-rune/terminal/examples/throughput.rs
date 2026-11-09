//! How fast the VT state takes a 50 MiB stream: the recorded fixtures' frames, played in turn
//! until 50 MiB, written in the 64 KiB reads a socket gives. Evidence for the gate, not a claim.
//!
//! `cargo run --release -p collie-desktop-terminal --example throughput`

use base64::Engine;
use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::vt::{Vt, XTERM_JS};
use std::time::Instant;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/terminal");
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
    let mut vt = Vt::new(100, 30, &XTERM_JS);
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
}
