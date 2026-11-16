//! Collie's compiled desktop core, or its source in a checkout, with DesktopRpcs over stdio.

use crate::client::Client;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

const DESKTOP: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// Keep the physical channel root used by existing stable installations.
pub fn channel_root(
    home: &std::path::Path,
    data: Option<PathBuf>,
    macos: bool,
    exe: &std::path::Path,
) -> PathBuf {
    let base = if macos {
        home.join("Library/Application Support")
    } else {
        data.filter(|p| p.is_absolute() && p.parent().is_some())
            .unwrap_or_else(|| home.join(".local/share"))
    };
    let identity = base.join("dk.cego.collie.desktop");
    if !macos
        && let Some(root) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        && root.parent() == Some(identity.as_path())
    {
        return root.into();
    }
    let candidates = [
        identity.join("stable"),
        identity.join("collie-desktop"),
        identity.join("Collie"),
    ];
    let hash = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .and_then(|app| std::fs::read(app.join("Contents/Resources/version.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("hash")?.as_str().map(String::from));
    if let Some(hash) = hash
        && let Some(root) = candidates.iter().find(|p| {
            p.join("self-extraction")
                .join(format!("{hash}.tar"))
                .is_file()
        })
    {
        return root.clone();
    }
    candidates
        .iter()
        .find(|p| p.join(".electrobun-uninstall.json").is_file())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
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
        let exe = std::env::current_exe().expect("the shell's own path");
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
        let data = channel_root(
            &home,
            std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
            cfg!(target_os = "macos"),
            &exe,
        );
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
                    "core/tsconfig.json",
                    "src/bun/index.ts",
                ])
                .current_dir(DESKTOP);
                bun
            }
        };
        let mut child = command
            .env("COLLIE_RUNE_USER_DATA", data)
            // Keep the old state root and herdr's environment; callers may override for tests.
            .envs(env.iter().copied())
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
