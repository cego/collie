//! The spike's board: each Machine `flock` names, its status and its cards; pressing a card goes
//! to its pane's terminal.
//! The fold is a narrow copy of `applyItem` in `desktop/src/shared/flock.ts`, enough to
//! draw; the TypeScript stays its owner.

use collie_desktop_protocol::generated::{FlockItem, LostState, Message, Task, TerminalPayload};
use collie_desktop_terminal::view::{Tab, terminal};
use rune::{Cx, El, col, row, text};
use rune_kit::{Badge, Button, Card, Kit};

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

/// Opens a pane's terminal on the core, named for its Machine, as the `opened`th.
pub type GoTo = Box<dyn Fn(TerminalPayload, String, u64) -> Tab>;

#[derive(Default)]
pub struct Board {
    pub machines: Vec<Shown>,
    /// Why the board stopped hearing from the core, once it has.
    pub ended: Option<String>,
    pub terminal: Option<Tab>,
    /// Counts the terminals opened, so a closed one's late frames are dropped.
    pub opened: u64,
    pub go_to: Option<GoTo>,
}

/// The cols and rows a terminal opens at, until its layout says otherwise.
const OPEN_AT: (i64, i64) = (100, 30);

impl Board {
    pub fn go_to_pane(&mut self, installation: String, run: String, machine: String) {
        let Some(go_to) = &self.go_to else { return };
        if let Some(open) = self.terminal.take() {
            open.leave();
        }
        let payload = TerminalPayload {
            installation,
            run_id: run,
            agent: None,
            cols: OPEN_AT.0,
            rows: OPEN_AT.1,
        };
        self.opened += 1;
        self.terminal = Some(go_to(payload, machine, self.opened));
    }

    pub fn back(&mut self) {
        if let Some(open) = self.terminal.take() {
            open.leave();
        }
    }

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
        .role("article")
        .label(task.name.clone())
        .w(280.0);
    match shown.installation.clone() {
        Some(installation) => {
            let (run, machine) = (task.run.clone(), shown.name.clone());
            card.focusable(true).on_press(move |board: &mut Board| {
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

fn tab_of(board: &mut Board) -> Option<&mut Tab> {
    board.terminal.as_mut()
}

pub fn view(board: &Board, cx: &mut Cx<Board>) -> El {
    let k = Kit::neutral(cx.system_dark());
    if let Some(tab) = &board.terminal {
        let back = Button::new("Back to the board")
            .on_press(Board::back)
            .build(&k)
            .key("back");
        let body = col()
            .padding(16.0)
            .gap(8.0)
            .fill(k.c.bg_base)
            .child(back)
            .child(terminal(tab, tab_of));
        return rune_kit::root(body, []);
    }
    let machines = board.machines.iter().map(|shown| machine(&k, shown));
    let ended = board
        .ended
        .iter()
        .map(|why| text(why.clone()).color(k.c.text_strong).role("alert"));
    let body = col()
        .padding(16.0)
        .gap(20.0)
        .fill(k.c.bg_base)
        .children(ended)
        .children(machines);
    rune_kit::root(body, [])
}
