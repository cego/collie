//! Go to pane in the app: a pane's `terminal` stream opened on the core, what it says applied
//! to the terminal it was opened for, and Open in herdr where there is no pane to show.

use crate::calls::{CallError, Post};
use crate::{App, GoTo};
use collie_desktop_protocol::client::{Client, RpcError};
use collie_desktop_protocol::generated::{GoToPaneSuccess, TerminalEvent};
use collie_desktop_terminal::input::pane_where;
use collie_desktop_terminal::pane::Pane;
use collie_desktop_terminal::view::Tab;
use serde_json::json;

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

    /// Opens herdr's own client on the open Run's workspace, in a terminal of this computer's.
    pub fn open_in_herdr(&mut self) {
        let (Some(record), Some(core)) = (&self.record.open, self.core.clone()) else {
            return;
        };
        let machine = record.machine.clone();
        let payload = json!({"installation": record.installation, "runId": record.run});
        self.record.terminal_said = Some("Opening herdr…".into());
        core.request(
            "goToPane",
            payload,
            move |app: &mut App, went: Result<GoToPaneSuccess, CallError>| {
                app.record.terminal_said = Some(match went {
                    Ok(went) if went.opened => {
                        format!("Opened {} in a terminal", pane_where(&machine, &went.at))
                    }
                    Ok(went) => format!("No terminal app found: run {}", went.command),
                    Err(why) => format!("Could not open herdr: {why}"),
                });
            },
        );
    }
}
