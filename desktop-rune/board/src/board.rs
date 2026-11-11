//! The Board: each Machine `flock` names, its status and its cards.
//! The fold is a narrow copy of `applyItem` in `desktop/src/shared/flock.ts`, enough to
//! draw; the TypeScript stays its owner.

use crate::record::flow_of;
use crate::{App, flow};
use collie_desktop_protocol::generated::{FlockItem, LostState, Message, Task};
use rune::{El, col, row, text};
use rune_kit::{Badge, Card, Kit};

/// A Machine as the board shows it, by herdr profile.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub installation: Option<String>,
    pub profile: String,
    pub name: String,
    pub cards: Vec<Task>,
    /// Since when its board is no longer live; `None` while it is.
    pub as_of: Option<f64>,
    pub lost: Option<LostState>,
}

impl Shown {
    pub fn status(&self) -> &'static str {
        match (&self.lost, self.as_of) {
            (Some(LostState::Unreachable), _) => "Out of reach",
            (Some(LostState::Sso), _) => "Waiting for SSO",
            (Some(LostState::NoCollie), _) => "Collie isn't installed",
            (Some(LostState::UpdateDesktop), _) => "Update Desktop",
            (None, Some(_)) => "Showing what it last said",
            (None, None) => "Live",
        }
    }

    fn label(&self) -> String {
        let cards = match self.cards.len() {
            0 => "no cards".to_string(),
            1 => "1 card".to_string(),
            n => format!("{n} cards"),
        };
        format!("{}: {}, {cards}", self.name, self.status())
    }
}

impl App {
    fn at_profile(&mut self, profile: &str, name: &str) -> &mut Shown {
        let at = match self.machines.iter().position(|m| m.profile == profile) {
            Some(at) => at,
            None => {
                self.machines.push(Shown {
                    installation: None,
                    profile: profile.into(),
                    name: name.into(),
                    cards: Vec::new(),
                    as_of: None,
                    lost: None,
                });
                self.machines.len() - 1
            }
        };
        &mut self.machines[at]
    }

    pub fn apply(&mut self, item: FlockItem) {
        match item {
            FlockItem::MachineMessage(said) => {
                let machine = said.machine;
                let shown = self.at_profile(&machine.profile, &machine.name);
                shown.installation = Some(machine.installation);
                shown.name = machine.name;
                shown.as_of = None;
                shown.lost = None;
                match said.message {
                    Message::Snapshot(snapshot) => shown.cards = snapshot.tasks,
                    Message::Upsert(upsert) => {
                        match shown
                            .cards
                            .iter_mut()
                            .find(|card| card.id == upsert.task.id)
                        {
                            Some(card) => *card = upsert.task,
                            None => shown.cards.push(upsert.task),
                        }
                    }
                    Message::Remove(remove) => shown.cards.retain(|card| card.id != remove.id),
                    Message::UnknownMessage(_) => {}
                }
            }
            FlockItem::Lost(lost) => {
                let shown = self.at_profile(&lost.machine.profile, &lost.machine.name);
                shown.lost = Some(lost.state);
                shown.as_of.get_or_insert(lost.at);
            }
            FlockItem::Reconnecting(again) => {
                let shown = self.at_profile(&again.machine.profile, &again.machine.name);
                shown.as_of.get_or_insert(again.at);
            }
            FlockItem::Saved(saved) => {
                let shown = self.at_profile(&saved.machine.profile, &saved.machine.name);
                if shown.installation.is_none() {
                    shown.installation = Some(saved.machine.installation);
                    shown.cards = saved.tasks;
                    shown.as_of = Some(saved.at);
                }
            }
            FlockItem::Merged(merged) => self.machines.retain_mut(|m| {
                if m.profile == merged.machine.profile {
                    m.lost = None;
                }
                m.installation.is_some() || m.lost.is_some()
            }),
            FlockItem::Removed(removed) => self
                .machines
                .retain(|m| m.profile != removed.machine.profile),
            FlockItem::Routes(routes) => self
                .machines
                .retain(|m| routes.profiles.contains(&m.profile)),
            _ => {}
        }
    }
}

fn card(k: &Kit, shown: &Shown, task: &Task) -> El {
    // Card's own title neither wraps nor truncates, so the name is body text that wraps.
    let name = text(task.name.clone())
        .font(k.ty.body_medium)
        .color(k.c.text_base)
        .wrap()
        .w_full();
    let sentence = text(task.sentence.clone())
        .font(k.ty.body)
        .color(k.c.text_muted)
        .wrap()
        .max_lines(3)
        .w_full();
    let card = Card::new()
        .child(name)
        .child(sentence)
        .build(k)
        .key(format!("card-{}", task.id))
        .role("button")
        .label(task.name.clone())
        .w(280.0);
    match shown.installation.clone() {
        Some(installation) => {
            let (run, machine) = (task.run.clone(), shown.name.clone());
            card.focusable(true).on_press(move |board: &mut App| {
                board.go_to_pane(installation.clone(), run.clone(), machine.clone())
            })
        }
        None => card,
    }
}

fn machine(k: &Kit, shown: &Shown) -> El {
    let heading = row()
        .gap(8.0)
        .center_y()
        .child(
            text(shown.name.clone())
                .font(k.ty.ui_medium)
                .color(k.c.text_strong)
                .a11y_hidden(),
        )
        .child(Badge::new(shown.status()).build(k));
    col()
        .key(format!("machine-{}", shown.profile))
        .role("group")
        .label(shown.label())
        .gap(8.0)
        .child(heading)
        .child(
            row()
                .flex_wrap()
                .items_start()
                .gap(8.0)
                .children(shown.cards.iter().map(|task| card(k, shown, task))),
        )
}

/// Each Machine and its cards.
pub fn view(board: &App, k: &Kit) -> El {
    let machines = board.machines.iter().map(|shown| machine(k, shown));
    let ended = board
        .ended
        .iter()
        .map(|why| text(why.clone()).color(k.c.text_strong).role("alert"));
    col()
        .padding(16.0)
        .gap(20.0)
        .grow(1.0)
        .min_h(0.0)
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .children(ended)
        .children(
            board
                .flow
                .as_ref()
                .map(|map| flow::flow_map(map, flow_of, k)),
        )
        .children(machines)
}
