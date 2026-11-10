//! The spike app: starts Desktop's main process as its core, speaks `DesktopRpcs` to it over
//! stdio, draws the board `flock` streams, and a pressed card's pane on the `terminal` stream.

use collie_desktop_board::notify::deliver;
use collie_desktop_board::{Board, run_diff, view};
use collie_desktop_chat::view::DiffTab;
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::core::Core;
use collie_desktop_protocol::generated::{
    AguiEvent, FlockItem, StagePathsPayload, StagedOrRefusedItem,
};
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
        board.load_diff = Some(Box::new(move |installation, run, opened| {
            let (client, shows) = (reader.clone(), shows.clone());
            std::thread::spawn(move || {
                let patch = run_diff(&client, &installation, &run).unwrap_or_default();
                // FileDiff holds an Rc, so the patch is parsed on the view's thread.
                shows.update(move |board, _| {
                    board.diff_read(opened, &patch)
                });
            });
        }));
    });
}

/// Hands the chat's files to `stagePaths`; what it copied in rides on the next turn.
fn files_in(handle: &AppHandle<Board>, client: &Client) {
    let (stager, shows) = (client.clone(), handle.clone());
    handle.update(move |board, _| {
        // winit 0.30 reports no file drags on Wayland.
        board.chat.drops_unavailable =
            cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some();
        board.chat.stage = Some(Box::new(move |paths| {
            let (client, shows) = (stager.clone(), shows.clone());
            let paths = paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            std::thread::spawn(move || {
                let staged = client.request::<_, Vec<StagedOrRefusedItem>, Value>(
                    "stagePaths",
                    StagePathsPayload { paths },
                );
                shows.update(move |board, _| match staged {
                    Ok(staged) => staged.into_iter().for_each(|item| match item {
                        StagedOrRefusedItem::StagedOrRefusedItem0(file) => {
                            board.chat.attached.push(file.id)
                        }
                        StagedOrRefusedItem::StagedOrRefusedItem1(no) => {
                            board.chat.transcript.error = Some(no.refused)
                        }
                    }),
                    Err(error) => board.chat.transcript.error = Some(error.to_string()),
                });
            });
        }));
    });
}

/// Posts what the main process asks to notify; a click brings the window forward.
fn notifications(handle: &AppHandle<Board>, client: &Client) {
    let Some(notices) = client.notices() else {
        return;
    };
    let window = handle.clone();
    let raise = move |token: Option<String>| match token {
        Some(token) => window.activate(token),
        None => window.focus(),
    };
    #[cfg(target_os = "linux")]
    let notifier = collie_desktop_board::notify::freedesktop::Freedesktop::start();
    #[cfg(not(target_os = "linux"))]
    let notifier = collie_desktop_board::notify::mac::Mac::start();
    std::thread::spawn(move || deliver(notices, &notifier, raise));
}

/// Installs a staged update before anything starts, and runs the new shell where it did.
/// For a bundled shell, says where the core stages the next one and where the bundle's
/// version is.
fn update_at_launch() -> Vec<(&'static str, std::ffi::OsString)> {
    use collie_desktop_update::{Applied, apply_staged, installed_from};
    let exe = std::env::current_exe().expect("the shell's own path");
    let Some((install, bundle, version)) = installed_from(&exe).and_then(|(install, bundle)| {
        let version = ["version.json", "Contents/Resources/version.json"]
            .iter()
            .map(|at| install.join(&bundle).join(at))
            .find(|at| at.is_file())?;
        Some((install, bundle, version))
    }) else {
        return Vec::new();
    };
    match apply_staged(&install, &bundle, include_str!("../../../release.pub")) {
        Applied::Installed => {
            use std::os::unix::process::CommandExt;
            let failed = std::process::Command::new(&exe)
                .args(std::env::args_os().skip(1))
                .exec();
            eprintln!("the updated shell did not start: {failed}");
        }
        Applied::Refused(why) => eprintln!("update not installed: {why}"),
        Applied::Nothing => {}
    }
    vec![
        (
            "COLLIE_RUNE_STAGED",
            install.join(".update").join(format!("{bundle}.tar")).into(),
        ),
        ("COLLIE_RUNE_VERSION", version.into()),
    ]
}

fn main() {
    let staging = update_at_launch();
    let env: Vec<(&str, &std::ffi::OsStr)> = staging
        .iter()
        .map(|(name, value)| (*name, value.as_os_str()))
        .collect();
    let core = Core::start_with(&env);
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
    files_in(&handle, &client);
    notifications(&handle, &client);
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
