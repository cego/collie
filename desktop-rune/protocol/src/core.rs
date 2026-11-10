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
        Core::start_with(&[])
    }

    /// Starts the bundle's own compiled core where there is one beside the shell, else
    /// Desktop's source under `bun`.
    pub fn start_with(env: &[(&str, &std::ffi::OsStr)]) -> Core {
        let state = spike_state();
        let bundled = std::env::current_exe()
            .ok()
            .and_then(|exe| Some(exe.parent()?.join("collie-core")))
            .filter(|core| core.is_file());
        let mut command = match &bundled {
            Some(core) => Command::new(core),
            None => {
                let mut bun =
                    Command::new(std::env::var("COLLIE_RUNE_BUN").unwrap_or("bun".into()));
                bun.args([
                    "--tsconfig-override",
                    "../desktop-rune/core/tsconfig.json",
                    "src/bun/index.ts",
                ])
                .current_dir(DESKTOP);
                bun
            }
        };
        let mut child = command
            .envs(env.iter().copied())
            .env("XDG_STATE_HOME", state.join("state"))
            .env("COLLIE_RUNE_USER_DATA", state.join("data"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("Desktop's main process starts");
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
