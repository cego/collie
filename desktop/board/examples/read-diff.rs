//! Reads a Run's diff from the core as the Diff tab does, and says what rune-kit parsed of it.
//!
//! `cargo run -p collie-desktop-board --example read-diff -- <installation> <run>`

use collie_desktop_board::run_diff;
use collie_desktop_protocol::core::Core;
use collie_desktop_protocol::generated::FlockItem;
use serde_json::Value;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [installation, run] = &args[..] else {
        panic!("read-diff <installation> <run>");
    };
    let core = Core::start();
    // The core reaches a Machine only while `flock` streams, so it waits for a live board.
    let mut flock = core.client.stream::<_, FlockItem, Value>("flock", ());
    let _ = flock
        .find(|item| matches!(item, Ok(FlockItem::MachineMessage(_))))
        .expect("a live board");
    let patch = match run_diff(&core.client, installation, run) {
        Ok(patch) => patch,
        Err(why) => {
            println!("{run}: {why}");
            core.stop();
            return;
        }
    };
    let files = rune_kit::diff::parse(&patch);
    println!("{} bytes of patch, {} files", patch.len(), files.len());
    for file in &files {
        let lines: usize = file.hunks.iter().map(|h| h.lines.len()).sum();
        println!("{}: {} hunks, {lines} lines", file.path(), file.hunks.len());
    }
    core.stop();
}
