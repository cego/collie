//! The spike app: starts Desktop's main process as its core, speaks `DesktopRpcs` to it over
//! stdio, draws the board `flock` streams, and a pressed card's pane on the `terminal` stream.

use collie_desktop_board::calls::{Answer, CallError, Calls, Each, Live, Stop};
use collie_desktop_board::notify::deliver;
use collie_desktop_board::timing::Mark;
use collie_desktop_board::{App, frame_drawn, view};
use collie_desktop_chat::window::{self as chat_window, Alone};
use collie_desktop_protocol::client::Client;
use collie_desktop_protocol::core::Core;
use collie_desktop_protocol::epoch_ms;
use collie_desktop_protocol::generated::{FlockItem, RecordMarkPayload};
use collie_desktop_terminal::pane::Pane;
use collie_desktop_terminal::view::Tab;
use rune::{AppHandle, AppSpec, WindowSpec};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// Opens a pressed card's pane: its frames are read off the view's thread into the open Tab,
/// and a tick sends each size once it has settled.
fn go_to_panes(handle: &AppHandle<App>, client: &Client) {
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
                            Err(error) => tab.failed(error),
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
                board.keep_chat_width();
                board.ask_usage_when_due(epoch_ms());
                let expired = board.expire_toasts(epoch_ms());
                collie_desktop_chat::chat::tick(board, epoch_ms()) || expired
            });
        }
    });
}

/// Opens the chat on the core: its conversation, subscriptions and turns all go through it.
fn chat(handle: &AppHandle<App>) {
    let picks = handle.clone();
    handle.update(move |board, _| {
        board.chat.pick = Some(Box::new(move || {
            let picks = picks.clone();
            let ask = move || {
                let chosen = collie_desktop_chat::dialog::pick_files("Attach files");
                picks.update(move |board, _| collie_desktop_chat::chat::picked(board, chosen));
            };
            // AppKit's panel runs on the main thread; the portal's blocks, so it runs off it.
            if cfg!(target_os = "macos") {
                ask();
            } else {
                std::thread::spawn(ask);
            }
        }));
        board.open_chat();
    });
}

/// The chat's own window, hidden until the chat is popped out: it reaches the core on calls of
/// its own, and closing it puts the chat back beside the board.
fn chat_window(app: &mut rune::App<App>, handle: &AppHandle<App>, client: &Client) {
    let poster: Arc<std::sync::Mutex<Option<AppHandle<Alone>>>> = Arc::default();
    let posts = poster.clone();
    let core = collie_desktop_board::calls::Core::<Alone>::new(
        Arc::new(Live(client.clone())),
        Arc::new(move |change| {
            if let Some(alone) = posts.lock().unwrap().as_ref() {
                alone.update(move |a: &mut Alone, _| change(a));
            }
        }),
    );
    let mut alone = Alone::default();
    let asks = core.clone();
    alone.request = Some(Box::new(move |tag, payload, done| {
        asks.request(
            tag,
            payload,
            move |a: &mut Alone, answer: Result<Value, CallError>| done(a, answer.map_err(|e| e.0)),
        )
    }));
    alone.stream = Some(Box::new(move |tag, payload, mut each| {
        core.stream(
            tag,
            payload,
            move |a: &mut Alone, value: Result<Value, CallError>| each(a, value.map_err(|e| e.0)),
        )
    }));
    let main = handle.clone();
    alone.back = Some(Box::new(move || {
        main.update(|board, _| collie_desktop_chat::chat::came_back(board))
    }));
    alone.chat.drops_unavailable =
        cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some();
    let spec = WindowSpec::from_app(
        "chat",
        rune::App::new(AppSpec {
            fonts: rune_theme_opencode::FONTS,
            families: rune_theme_opencode::FAMILIES,
            min_size: Some((360.0, 420.0)),
            ..AppSpec::new(
                "Flock chat",
                (520.0, 820.0),
                Alone::default,
                chat_window::view,
            )
        })
        .windowless()
        .on_close(chat_window::closed),
    )
    .state(alone);
    let (alone, _) = app.window(spec);
    *poster.lock().unwrap() = Some(alone.clone());
    let itself = alone.clone();
    let picks = alone.clone();
    alone.update(move |a, _| {
        a.chat.pop = Some(Box::new(move |out| {
            if !out {
                itself.close();
            }
        }));
        a.chat.pick = Some(Box::new(move || {
            let picks = picks.clone();
            let ask = move || {
                let chosen = collie_desktop_chat::dialog::pick_files("Attach files");
                picks.update(move |a, _| collie_desktop_chat::chat::picked(a, chosen));
            };
            if cfg!(target_os = "macos") {
                ask();
            } else {
                std::thread::spawn(ask);
            }
        }));
    });
    let shows = alone.clone();
    let front = alone.clone();
    handle.update(move |board, _| {
        board.nav.chat_window = Some(Box::new(move || front.open()));
        board.chat.pop = Some(Box::new(move |out| {
            if out {
                shows.update(|a, _| chat_window::opened(a));
                shows.open();
            } else {
                shows.close();
            }
        }));
    });
    let ticks = alone.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(250));
            ticks.update_if(|a, _| collie_desktop_chat::chat::tick(a, epoch_ms()));
        }
    });
    // A headless run of the chat's own window shows it popped out.
    let args: Vec<String> = std::env::args().collect();
    if args
        .windows(2)
        .any(|w| w[0] == "--window" && w[1] == "chat")
    {
        alone.update(|a, _| chat_window::opened(a));
    }
}

/// Says where the platform reports no file drops; the chat stages its files through the core.
fn files_in(handle: &AppHandle<App>) {
    handle.update(move |board, _| {
        // winit 0.30 reports no file drags on Wayland.
        board.chat.drops_unavailable =
            cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some();
    });
}

/// Posts what the main process asks to notify; a click brings the window forward.
fn notifications(handle: &AppHandle<App>, client: &Client) {
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

/// Hands each frame's marks to the main process's `recordMark`, which logs them while Record
/// timing is on.
fn marks(client: &Client) -> impl FnMut(&rune::Runtime<App>) + 'static {
    let (marked, marks) = std::sync::mpsc::channel::<Mark>();
    let client = client.clone();
    std::thread::spawn(move || {
        for mark in marks {
            let _ = client.request::<_, Value, Value>(
                "recordMark",
                RecordMarkPayload {
                    name: mark.name.into(),
                    at: mark.at,
                    card: mark.card,
                },
            );
        }
    });
    move |drawn| {
        for mark in frame_drawn(drawn, epoch_ms()) {
            let _ = marked.send(mark);
        }
    }
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

/// The live core, saying once when the board's `flock` first brings a Machine's own board.
struct FirstLive {
    calls: Live,
    live: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

impl Calls for FirstLive {
    fn request(&self, tag: &str, payload: Value, answer: Answer) {
        self.calls.request(tag, payload, answer)
    }

    fn stream(&self, tag: &str, payload: Value, mut each: Each) -> Stop {
        if tag != "flock" {
            return self.calls.stream(tag, payload, each);
        }
        let live = self.live.lock().unwrap().take();
        self.calls.stream(
            tag,
            payload,
            Box::new(move |item| {
                let board = matches!(
                    item.as_ref()
                        .map(|v| serde_json::from_value::<FlockItem>(v.clone())),
                    Ok(Ok(FlockItem::MachineMessage(_)))
                );
                if board && let Some(live) = &live {
                    let _ = live.send(());
                }
                each(item)
            }),
        )
    }
}

fn main() {
    let staging = update_at_launch();
    let env: Vec<(&str, &std::ffi::OsStr)> = staging
        .iter()
        .map(|(name, value)| (*name, value.as_os_str()))
        .collect();
    let core = Core::start_with(&env);
    let client = core.client.clone();

    // The desktop entry's name, so the window is shown as its launcher's, never stable Desktop's.
    rune::set_app_id("dk.cego.collie.desktop.rune");
    let app = rune::App::new(AppSpec {
        fonts: rune_theme_opencode::FONTS,
        families: rune_theme_opencode::FAMILIES,
        min_size: Some((720.0, 480.0)),
        ..AppSpec::new("Collie", (1280.0, 860.0), App::default, view)
    })
    .on_frame_drawn(marks(&client));
    let mut app = app;
    let handle = app.handle();
    let poster = std::sync::Mutex::new(handle.clone());
    let (live, first_live) = std::sync::mpsc::channel();
    let calls = collie_desktop_board::calls::Core::new(
        Arc::new(FirstLive {
            calls: Live(client.clone()),
            live: std::sync::Mutex::new(Some(live)),
        }),
        Arc::new(move |change| {
            poster
                .lock()
                .unwrap()
                .update(move |app: &mut App, _| change(app))
        }),
    );
    handle.update(move |app, _| {
        app.core = Some(calls);
        app.listen_setup();
        app.follow_flock();
    });
    go_to_panes(&handle, &client);
    chat(&handle);
    chat_window(&mut app, &handle, &client);
    files_in(&handle);
    notifications(&handle, &client);
    // A headless render runs on a virtual clock, so it waits for a live board first, unless
    // it is asked to show the start itself.
    let at_start = std::env::var_os("COLLIE_RUNE_SNAP_AT_START").is_some();
    if !at_start
        && std::env::args().any(|arg| ["--snap", "--tree", "--script"].contains(&arg.as_str()))
    {
        let _ = first_live.recv_timeout(Duration::from_secs(60));
    }

    let ran = app.try_run();
    core.stop();
    if let Err(error) = ran {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
