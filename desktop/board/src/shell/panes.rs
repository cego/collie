//! Go to pane in the app: a pane's `terminal` stream opened on the core, what it says applied
//! to the terminal it was opened for.

use crate::calls::Post;
use crate::{App, GoTo};
use collie_desktop_protocol::client::{Client, RpcError};
use collie_desktop_protocol::generated::TerminalEvent;
use collie_desktop_terminal::pane::Pane;
use collie_desktop_terminal::view::Tab;

/// What a pane's `terminal` stream said.
#[derive(Debug)]
pub enum Heard {
    Event(TerminalEvent),
    /// It failed, in the core's words.
    Failed(String),
    /// It ended, whether or not it said why.
    Closed,
}

/// Opens each pane on the live core: its stream is read off the view's thread, and every
/// event, its failure and its end are posted to the app.
pub fn opener(client: Client, post: Post<App>) -> GoTo {
    Box::new(move |payload, machine, opened| {
        let (cols, rows) = (payload.cols as u16, payload.rows as u16);
        let (pane, frames) = Pane::open(&client, payload);
        let post = post.clone();
        std::thread::spawn(move || {
            for event in frames {
                let heard = match event {
                    Ok(event) => Heard::Event(event),
                    Err(RpcError::Failed(failed)) => Heard::Failed(failed.reason),
                    Err(other) => Heard::Failed(other.to_string()),
                };
                post(Box::new(move |app: &mut App| app.pane_heard(opened, heard)));
            }
            post(Box::new(move |app: &mut App| {
                app.pane_heard(opened, Heard::Closed)
            }));
        });
        Tab::new(Some(pane), machine, cols, rows)
    })
}

/// Why a pane did not connect or ended, in words that say what broke: a failure of the
/// socket to a Machine's core names that connection rather than only its error.
pub fn plainly(reason: &str, machine: &str) -> String {
    if reason.to_lowercase().contains("socket") {
        format!("the connection to {machine}'s terminal broke ({reason})")
    } else {
        reason.to_string()
    }
}

impl App {
    /// What the `opened`th terminal's stream said; a terminal since replaced hears nothing.
    pub fn pane_heard(&mut self, opened: u64, heard: Heard) {
        if self.opened != opened {
            return;
        }
        let Some(tab) = &mut self.terminal else {
            return;
        };
        match heard {
            Heard::Event(event) => {
                if let TerminalEvent::Opened(open) = &event
                    && let Some(agent) = &open.at.agent
                {
                    self.record.terminal_agent = Some(agent.clone());
                }
                tab.shown(event);
            }
            Heard::Failed(why) => tab.failed_with(why),
            Heard::Closed => tab.closed(),
        }
    }
}
