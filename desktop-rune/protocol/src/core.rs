//! Desktop's main process started as the spike's core: `bun` runs Desktop's own source with
//! `core/electrobun-stdio.ts` standing in for Electrobun, and `DesktopRpcs` goes over stdio.

use crate::client::Client;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

const DESKTOP: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../desktop");

/// The spike's own state, apart from a Desktop that may be running beside it.
fn spike_state() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")
        });
    base.join("collie-desktop-rune-spike")
}

pub struct Core {
    child: Child,
    pub client: Client,
}

impl Core {
    pub fn start() -> Core {
        let state = spike_state();
        let mut child = Command::new(std::env::var("COLLIE_RUNE_BUN").unwrap_or("bun".into()))
            .args([
                "--tsconfig-override",
                "../desktop-rune/core/tsconfig.json",
                "src/bun/index.ts",
            ])
            .current_dir(DESKTOP)
            .env("XDG_STATE_HOME", state.join("state"))
            .env("COLLIE_RUNE_USER_DATA", state.join("data"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("bun starts Desktop's main process");
        let client = Client::new(
            BufReader::new(child.stdout.take().expect("the core's stdout")),
            child.stdin.take().expect("the core's stdin"),
        )
        .expect("the core hears Hello");
        Core { child, client }
    }

    /// SIGTERM, not SIGKILL: the core's own exit ends the bridges it started.
    pub fn stop(mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
        let _ = self.child.wait();
    }
}
