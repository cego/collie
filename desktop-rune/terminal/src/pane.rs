//! One pane's terminal over the core: its frames come on the `terminal` stream, what the human
//! does goes back through `terminalSend` in the order done, and leaving interrupts the stream,
//! which has the core give the pane back (`terminal.release`).

use crate::size::{SettledResizes, Size};
use collie_desktop_protocol::client::{Client, Release, Subscription};
use collie_desktop_protocol::generated::{
    ActionFailed, Command, TerminalEvent, TerminalPayload, TerminalResize, TerminalResizeType,
    TerminalSendPayload,
};
use serde_json::Value;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

pub type Frames = Subscription<TerminalEvent, ActionFailed>;

pub struct Pane {
    sizes: SettledResizes,
    commands: Sender<Command>,
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
        let (commands, queued) = channel::<Command>();
        let core = client.clone();
        // Off the view's thread, which each send would otherwise wait on.
        let sender = std::thread::spawn(move || {
            for command in queued {
                let _ = core.request::<_, Value, ActionFailed>(
                    "terminalSend",
                    TerminalSendPayload { command },
                );
            }
        });
        let pane = Pane {
            sizes: SettledResizes::default(),
            commands,
            sender,
            release: frames.release(),
        };
        (pane, frames)
    }

    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// The core opened the controller, which takes its size at once.
    pub fn opened(&mut self, size: Size) {
        let size = self.sizes.opened(size);
        self.send(resize(size));
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
