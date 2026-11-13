//! Helping the human write their Standing direction: Desktop's offer, the consent dialog that
//! says where their sessions are, and the choice made there, which the Flock chat takes up.
//! A port of `StandingSetupDialog.vue` and `useStandingSetup`.

use crate::App;
use crate::calls::Stop;
use crate::pages::common::{Told, muted, toasts};
use collie_desktop_protocol::generated::{
    Choice, ChooseSetupPayload, DeclineSetupPayload, Found, SetupInventorySuccessItem, StoreSource,
};
use rune::{El, col, el, row, text};
use rune_kit::{Button, ButtonVariant, Dialog, Kit, Spinner};

#[derive(Default)]
pub struct Standing {
    /// Whether Desktop offers to help write the Standing direction.
    pub offered: bool,
    pub open: bool,
    /// Where each computer keeps the human's sessions, once read.
    pub found: Option<Vec<SetupInventorySuccessItem>>,
    /// Whether a choice waits for a Flock chat to take it.
    pub waiting: bool,
    /// The choice this window's Flock chat took, for it to start the setup conversation with.
    pub taken: Option<Choice>,
    pub told: Told,
    stops: Vec<Stop>,
}

fn source_of(source: &StoreSource) -> &'static str {
    match source {
        StoreSource::ClaudeCode => "Claude Code",
        StoreSource::Codex => "Codex",
        StoreSource::Pi => "Pi",
        StoreSource::Opencode => "OpenCode",
        StoreSource::Collie => "Collie's records",
    }
}

/// One store in a line: `Codex: 12 sessions in ~/.codex`, or why it wasn't read.
pub fn store_said(store: &collie_desktop_protocol::generated::Store) -> String {
    let source = source_of(&store.source);
    match store.found {
        Found::Read => {
            let unit = if store.source == StoreSource::Collie {
                "entries"
            } else {
                "sessions"
            };
            format!("{source}: {} {unit} in {}", store.sessions, store.r#where)
        }
        Found::Missing | Found::Unreadable => {
            let found = if store.found == Found::Missing {
                "missing"
            } else {
                "unreadable"
            };
            match &store.why {
                Some(why) => format!("{source}: {found}: {why}"),
                None => format!("{source}: {found}"),
            }
        }
    }
}

fn standing(app: &mut App) -> &mut Standing {
    &mut app.standing
}

impl App {
    /// Hears Desktop's offer and any choice waiting for a Flock chat, from now on.
    pub fn listen_setup(&mut self) {
        let Some(core) = &self.core else { return };
        if !self.standing.stops.is_empty() {
            return;
        }
        let offer = core.stream(
            "setupOffer",
            (),
            |app: &mut App, offered: Result<bool, _>| {
                if let Ok(offered) = offered {
                    standing(app).offered = offered;
                }
            },
        );
        let chosen = core.stream(
            "setupChosen",
            (),
            |app: &mut App, chosen: Result<Option<Choice>, _>| {
                let waiting = matches!(chosen, Ok(Some(_)));
                standing(app).waiting = waiting;
                if waiting {
                    app.take_setup();
                }
            },
        );
        self.standing.stops = vec![offer, chosen];
    }

    /// Opens the dialog and reads where each computer keeps the human's sessions, which
    /// takes the offer up.
    pub fn open_standing_setup(&mut self) {
        let state = standing(self);
        state.open = true;
        state.found = None;
        let Some(core) = &self.core else { return };
        core.request(
            "setupInventory",
            (),
            |app: &mut App, found: Result<Vec<SetupInventorySuccessItem>, _>| {
                standing(app).found = Some(found.unwrap_or_default());
            },
        );
    }

    /// "Not now", or "Don't ask again" `for_good`.
    pub fn decline_setup(&mut self, for_good: bool) {
        standing(self).open = false;
        let Some(core) = &self.core else { return };
        core.request(
            "declineSetup",
            DeclineSetupPayload { for_good },
            |app: &mut App, kept: Result<serde_json::Value, _>| {
                if let Err(why) = kept {
                    standing(app).told.say(why.0, false);
                }
            },
        );
    }

    /// Holds the human's choice for the Flock chat, which may be in another window.
    pub fn choose_setup(&mut self, choice: Choice) {
        standing(self).open = false;
        let Some(core) = &self.core else { return };
        core.request(
            "chooseSetup",
            ChooseSetupPayload { choice },
            |_: &mut App, _: Result<serde_json::Value, _>| {},
        );
    }

    /// Takes the waiting choice, if this window's chat is the one to take it.
    pub fn take_setup(&mut self) {
        let Some(core) = &self.core else { return };
        core.request(
            "takeSetup",
            (),
            |app: &mut App, taken: Result<Option<Choice>, _>| {
                if let Ok(Some(choice)) = taken {
                    standing(app).taken = Some(choice);
                }
            },
        );
    }
}

/// The consent dialog while it is open, and an onboarding the human started, over whichever
/// page is shown.
pub fn view(app: &App, k: &Kit, layer: &mut Vec<El>) {
    crate::pages::onboard::dialog(app, k, layer);
    let state = &app.standing;
    toasts(
        app,
        &state.told,
        |app: &mut App| &mut app.standing.told,
        k,
        layer,
    );
    if !state.open {
        return;
    }
    let found = match &state.found {
        None => row()
            .gap(8.0)
            .center_y()
            .child(Spinner::new().size(12.0).build(k))
            .child(muted(k, "Looking for your sessions…")),
        Some(found) => col()
            .key("standing-setup-found")
            .w_full()
            .gap(10.0)
            .children(found.iter().map(|computer| {
                let mut lines = col().w_full().gap(4.0).child(
                    text(computer.computer.clone())
                        .font(k.ty.text_small_medium)
                        .color(k.c.text_base),
                );
                match &computer.problem {
                    Some(problem) => {
                        lines = lines.child(
                            text(problem.clone())
                                .font(k.ty.text_small)
                                .color(k.c.warning.fg)
                                .wrap()
                                .w_full(),
                        )
                    }
                    None => {
                        for store in &computer.stores {
                            let tone = if store.found == Found::Read {
                                k.c.text_base
                            } else {
                                k.c.text_faint
                            };
                            lines = lines.child(
                                text(store_said(store))
                                    .font(k.ty.text_small)
                                    .color(tone)
                                    .wrap()
                                    .w_full()
                                    .pl(12.0),
                            );
                        }
                    }
                }
                lines.key(format!("computer-{}", computer.computer))
            })),
    };
    let actions = row()
        .w_full()
        .flex_wrap()
        .gap(8.0)
        .child(
            Button::new("Don't ask again")
                .variant(ButtonVariant::Ghost)
                .on_press(|app: &mut App| app.decline_setup(true))
                .build(k)
                .key("standing-setup-never"),
        )
        .child(
            Button::new("Not now")
                .variant(ButtonVariant::Ghost)
                .on_press(|app: &mut App| app.decline_setup(false))
                .build(k)
                .key("standing-setup-not-now"),
        )
        .child(el().grow(1.0))
        .child(
            Button::new("Ask me five questions instead")
                .variant(ButtonVariant::Outline)
                .on_press(|app: &mut App| app.choose_setup(Choice::Ask))
                .build(k)
                .key("standing-setup-ask"),
        )
        .child(
            Button::new("Read my messages")
                .variant(ButtonVariant::Contrast)
                .disabled(state.found.is_none())
                .on_press(|app: &mut App| app.choose_setup(Choice::Read))
                .build(k)
                .key("standing-setup-read"),
        );
    let body = col()
        .key("standing-setup")
        .w_full()
        .px(16.0)
        .pb(16.0)
        .gap(14.0)
        .child(
            text(
                "Collie can draft your Standing direction from the messages you typed to your \
                 coding agents, or ask you five questions instead. Nothing is saved until you \
                 accept the draft.",
            )
            .font(k.ty.body)
            .color(k.c.text_base)
            .wrap()
            .w_full(),
        )
        .child(found)
        .child(muted(
            k,
            "What is read goes to the Flock chat's model provider, for this one conversation. \
             Your consent is not kept: the next setup asks again.",
        ))
        .child(actions);
    Dialog::new("standing-setup", "Tell Collie how you work")
        .width(560.0)
        .fit()
        .open(true)
        .child(body)
        .on_close(|app: &mut App| standing(app).open = false)
        .build(collie_desktop_theme::dialog(k.dark), layer);
}
