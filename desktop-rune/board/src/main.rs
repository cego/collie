//! The spike app: starts Desktop's main process as its core, speaks `DesktopRpcs` to it over
//! stdio, draws the board `flock` streams, and a pressed card's pane on the `terminal` stream.

use collie_desktop_board::{Board, view};
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::generated::FlockItem;
use collie_desktop_terminal::pane::Pane;
use collie_desktop_terminal::view::Tab;
use rune::{App, AppHandle, AppSpec};
use serde_json::Value;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

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

/// Opens a pressed card's pane: its frames are read off the view's thread into the open Tab,
/// and a tick sends each size once it has settled.
fn go_to_panes(handle: &AppHandle<Board>, client: &Client) {
    let (opener, shows) = (client.clone(), handle.clone());
    handle.update(move |board, _| {
        board.go_to = Some(Box::new(move |payload, machine, opened| {
            let (cols, rows) = (payload.cols as u16, payload.rows as u16);
            let (pane, frames) = Pane::open(&opener, payload);
            let shows = shows.clone();
            std::thread::spawn(move || {
                for event in frames {
                    shows.update(move |board, _| {
                        let Some(tab) = board.terminal.as_mut().filter(|_| board.opened == opened)
                        else {
                            return;
                        };
                        match event {
                            Ok(event) => tab.shown(event),
                            Err(error) => tab.ended = Some(error.to_string()),
                        }
                    });
                }
            });
            Tab::new(Some(pane), machine, cols, rows)
        }));
    });
    let ticks = handle.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(40));
            ticks.update_if(|board, _| {
                if let Some(tab) = &mut board.terminal {
                    tab.tick();
                }
                false
            });
        }
    });
}

fn main() {
    let state = spike_state();
    let mut core = Command::new(std::env::var("COLLIE_RUNE_BUN").unwrap_or("bun".into()))
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
        BufReader::new(core.stdout.take().expect("the core's stdout")),
        core.stdin.take().expect("the core's stdin"),
    )
    .expect("the core hears Hello");

    let app = App::new(AppSpec::new(
        "Collie (Rune spike)",
        (1280.0, 900.0),
        Board::default,
        view,
    ));
    let handle = app.handle();
    go_to_panes(&handle, &client);
    let (live, first_live) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for item in client.stream::<_, FlockItem, Value>("flock", ()) {
            match item {
                Ok(item) => {
                    let board = matches!(item, FlockItem::MachineMessage(_));
                    handle.update(move |shown, _| shown.apply(item));
                    if board {
                        let _ = live.send(());
                    }
                }
                Err(error) => {
                    let said = error.to_string();
                    handle.update(move |shown, _| shown.ended = Some(said));
                }
            }
        }
    });
    // A headless render runs on a virtual clock, so it waits for a live board first.
    if std::env::args().any(|arg| arg == "--snap" || arg == "--tree") {
        let _ = first_live.recv_timeout(Duration::from_secs(60));
    }

    let ran = app.try_run();
    // SIGTERM, not SIGKILL: the core's own exit ends the bridges it started.
    let _ = Command::new("kill")
        .args(["-TERM", &core.id().to_string()])
        .status();
    let _ = core.wait();
    if let Err(error) = ran {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
