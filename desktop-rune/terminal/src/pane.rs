//! One pane's terminal over the core: its frames come on the `terminal` stream, what the human
//! does goes back through `terminalSend` in the order done, and leaving interrupts the stream,
//! which has the core give the pane back (`terminal.release`).

use crate::size::{SettledResizes, Size};
use collie_desktop_protocol::client::{Client, Release, Subscription};
use collie_desktop_protocol::generated::{
    ActionFailed, Command, OpenLinkPayload, TerminalEvent, TerminalPayload, TerminalResize,
    TerminalResizeType, TerminalSendPayload,
};
use serde_json::Value;
use std::cell::RefCell;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

pub type Frames = Subscription<TerminalEvent, ActionFailed>;

/// What goes to the core for the pane, in the order done.
enum Out {
    Send(Command),
    OpenLink(String),
}

pub struct Pane {
    sizes: SettledResizes,
    /// What was done before the core opened the pane, which a `terminalSend` then would have
    /// given to the terminal shown before it; none once it has opened.
    held: RefCell<Option<Vec<Command>>>,
    commands: Sender<Out>,
    sender: JoinHandle<()>,
    release: Release,
}

fn resize((cols, rows): Size) -> Command {
    Command::TerminalResize(TerminalResize {
        r#type: TerminalResizeType::TerminalResize,
        cols: cols.into(),
        rows: rows.into(),
    })
}

impl Pane {
    pub fn open(client: &Client, payload: TerminalPayload) -> (Pane, Frames) {
        let frames = client.stream("terminal", payload);
        let (commands, queued) = channel::<Out>();
        let core = client.clone();
        // Off the view's thread, which each send would otherwise wait on.
        let sender = std::thread::spawn(move || {
            for out in queued {
                match out {
                    Out::Send(command) => {
                        let _ = core.request::<_, Value, ActionFailed>(
                            "terminalSend",
                            TerminalSendPayload { command },
                        );
                    }
                    Out::OpenLink(url) => {
                        let _ =
                            core.request::<_, Value, Value>("openLink", OpenLinkPayload { url });
                    }
                }
            }
        });
        let pane = Pane {
            sizes: SettledResizes::default(),
            held: RefCell::new(Some(Vec::new())),
            commands,
            sender,
            release: frames.release(),
        };
        (pane, frames)
    }

    pub fn send(&self, command: Command) {
        match self.held.borrow_mut().as_mut() {
            // Its size is sent as it opens.
            Some(_) if matches!(command, Command::TerminalResize(_)) => {}
            Some(held) => held.push(command),
            None => {
                let _ = self.commands.send(Out::Send(command));
            }
        }
    }

    /// Opens `url` in the human's own browser, through the core.
    pub fn open_link(&self, url: String) {
        let _ = self.commands.send(Out::OpenLink(url));
    }

    /// The core opened the controller, which takes its size at once.
    pub fn opened(&mut self, size: Size) {
        let size = self.sizes.opened(size);
        let held = self.held.borrow_mut().take().unwrap_or_default();
        self.send(resize(size));
        for command in held {
            self.send(command);
        }
    }

    pub fn resized(&mut self, size: Size, now: Duration) {
        self.sizes.resized(size, now);
    }

    /// Sends a size that has settled by `now`.
    pub fn tick(&mut self, now: Duration) {
        if let Some(size) = self.sizes.due(now) {
            self.send(resize(size));
        }
    }

    /// Sends what is still queued, drops a size still settling, and gives the pane back.
    pub fn leave(mut self) {
        self.sizes.stop();
        drop(self.commands);
        let _ = self.sender.join();
        self.release.interrupt();
    }
}
