//! The spike app: starts Desktop's main process as its core, speaks `DesktopRpcs` to it over
//! stdio, draws the board `flock` streams, and a pressed card's pane on the `terminal` stream.

use collie_desktop_board::{Board, run_diff, view};
use collie_desktop_chat::view::DiffTab;
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::core::Core;
use collie_desktop_protocol::generated::{AguiEvent, FlockItem};
use collie_desktop_terminal::pane::Pane;
use collie_desktop_terminal::view::Tab;
use rune::{App, AppHandle, AppSpec};
use serde_json::Value;
use std::time::Duration;

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

/// Sends the chat's turns on `say`, its events read off the view's thread into the transcript.
fn chat(handle: &AppHandle<Board>, client: &Client) {
    let (sayer, shows) = (client.clone(), handle.clone());
    handle.update(move |board, _| {
        board.chat.say = Some(Box::new(move |payload| {
            let events = sayer.stream::<_, AguiEvent, Value>("say", payload);
            let release = events.release();
            let shows = shows.clone();
            // ponytail: a cancelled turn's late events land in the next; tag turns if that shows.
            std::thread::spawn(move || {
                for event in events {
                    shows.update(move |board, _| match event {
                        Ok(event) => board.chat.transcript.apply(event),
                        Err(error) => {
                            board.chat.transcript.error = Some(error.to_string());
                            board.chat.transcript.running = false;
                        }
                    });
                }
            });
            Box::new(move || release.interrupt())
        }));
    });
}

/// Reads the open Run's diff: its files from `runDetail`, each file's patch from `runFile`.
fn diffs(handle: &AppHandle<Board>, client: &Client) {
    let (reader, shows) = (client.clone(), handle.clone());
    handle.update(move |board, _| {
        board.load_diff = Some(Box::new(move |installation, run| {
            let (client, shows) = (reader.clone(), shows.clone());
            std::thread::spawn(move || {
                let patch = run_diff(&client, &installation, &run).unwrap_or_default();
                // FileDiff holds an Rc, so the patch is parsed on the view's thread.
                shows.update(move |board, _| {
                    board.diff = Some(DiffTab::new(rune_kit::diff::parse(&patch)))
                });
            });
        }));
    });
}

fn main() {
    let core = Core::start();
    let client = core.client.clone();

    let app = App::new(AppSpec::new(
        "Collie (Rune spike)",
        (1280.0, 900.0),
        Board::default,
        view,
    ));
    let handle = app.handle();
    go_to_panes(&handle, &client);
    chat(&handle, &client);
    diffs(&handle, &client);
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
    core.stop();
    if let Err(error) = ran {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
