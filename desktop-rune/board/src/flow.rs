//! The Flow map as Rune draws it: one tab stop, arrows moving as `flowKey` does, and the
//! changes `flowAnnouncements` names read out politely.
//! A narrow copy of `flowRows`, `nodeName`, `flowAnnouncements` and `flowKey` in
//! `desktop/src/shared/flow.ts`, which stays their owner.

pub mod actions;
pub mod inspector;

use collie_desktop_protocol::generated::{DetailFlow, DetailFlowCurrent, GlyphState, Node};
use rune::{El, Key, KeyEvent, LiveRegion, Mods, col, row, text};
use rune_kit::{Button, ButtonVariant, Kit};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spot {
    pub run: String,
    pub node: String,
}

pub struct Row<'a> {
    pub run: &'a str,
    pub name: String,
    pub nodes: &'a [Node],
}

/// A string enum as its Schema writes it.
pub(crate) fn written(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

pub fn rows(flow: &DetailFlow) -> Vec<Row<'_>> {
    let lanes = flow.lanes.iter().map(|lane| Row {
        run: &lane.run,
        name: format!(
            "{}, {}, on {}, {}",
            lane.title,
            lane.run,
            lane.machine,
            written(&lane.execution)
        ),
        nodes: &lane.nodes,
    });
    let release = flow.release.iter().map(|nodes| Row {
        run: "release",
        name: "Release".into(),
        nodes,
    });
    lanes.chain(release).collect()
}

// ponytail: without nodeName's missing, as-of and action parts; no Step here links a board.
pub fn node_name(node: &Node) -> String {
    let state = written(&node.state);
    let said = node
        .said
        .clone()
        .filter(|s| state != "expected" && !s.is_empty());
    [node.title.clone(), state.replace('-', " ")]
        .into_iter()
        .chain(said)
        .collect::<Vec<_>>()
        .join(", ")
}

fn spot_of(current: &Option<DetailFlowCurrent>) -> Option<Spot> {
    current.as_ref().map(|c| Spot {
        run: c.run.clone(),
        node: c.node.clone(),
    })
}

pub fn node_at<'a>(flow: &'a DetailFlow, spot: &Spot) -> Option<&'a Node> {
    let row = rows(flow).into_iter().find(|row| row.run == spot.run)?;
    row.nodes.iter().find(|node| node.id == spot.node)
}

pub fn announcements(before: &DetailFlow, after: &DetailFlow) -> Vec<String> {
    let mut said: Vec<String> = Vec::new();
    let current =
        spot_of(&after.current).filter(|now| Some(now) != spot_of(&before.current).as_ref());
    said.extend(current.and_then(|now| node_at(after, &now)).map(node_name));
    for row in rows(after) {
        for node in row.nodes {
            let spot = Spot {
                run: row.run.into(),
                node: node.id.clone(),
            };
            let asked_before =
                node_at(before, &spot).map(|n| &n.state) == Some(&GlyphState::NeedsYou);
            if node.state == GlyphState::NeedsYou && !asked_before {
                said.push(node_name(node));
            }
        }
    }
    let mut once = Vec::new();
    for message in said {
        if !once.contains(&message) {
            once.push(message);
        }
    }
    once
}

/// Where an arrow, Home or End moves focus from `focus`: by position between rows, staying at
/// the ends.
pub fn moved(flow: &DetailFlow, focus: &Spot, key: &Key) -> Option<Spot> {
    let rows: Vec<Row> = rows(flow)
        .into_iter()
        .filter(|row| !row.nodes.is_empty())
        .collect();
    let row = rows.iter().position(|row| row.run == focus.run)? as isize;
    let at = rows[row as usize]
        .nodes
        .iter()
        .position(|node| node.id == focus.node)? as isize;
    let (row, at) = match key {
        Key::Left => (row, at - 1),
        Key::Right => (row, at + 1),
        Key::Home => (row, 0),
        Key::End => (row, rows[row as usize].nodes.len() as isize - 1),
        Key::Up => (row - 1, at),
        Key::Down => (row + 1, at),
        _ => return None,
    };
    let target = &rows[row.clamp(0, rows.len() as isize - 1) as usize];
    let at = at.clamp(0, target.nodes.len() as isize - 1) as usize;
    Some(Spot {
        run: target.run.into(),
        node: target.nodes[at].id.clone(),
    })
}

pub struct FlowMap {
    pub flow: DetailFlow,
    /// The Step the map's one tab stop is on.
    pub focus: Option<Spot>,
    pub selected: Option<Spot>,
    /// What the live region last said.
    pub announcement: String,
}

impl FlowMap {
    pub fn new(flow: DetailFlow) -> FlowMap {
        let first = rows(&flow).iter().find_map(|row| {
            row.nodes.first().map(|node| Spot {
                run: row.run.into(),
                node: node.id.clone(),
            })
        });
        FlowMap {
            focus: spot_of(&flow.current).or(first),
            flow,
            selected: None,
            announcement: String::new(),
        }
    }

    // ponytail: the same words twice aren't read again; clear for a frame first if that bites.
    pub fn set(&mut self, flow: DetailFlow) {
        let said = announcements(&self.flow, &flow);
        if !said.is_empty() {
            self.announcement = said.join(". ");
        }
        let kept = self
            .focus
            .as_ref()
            .filter(|spot| node_at(&flow, spot).is_some())
            .cloned();
        let fresh = FlowMap::new(flow);
        self.focus = kept.or(fresh.focus);
        self.flow = fresh.flow;
    }
}

/// A Step's state as one mark before its title; its name says the state in words.
fn glyph(state: &GlyphState) -> &'static str {
    match state {
        GlyphState::Done => "✓",
        GlyphState::Running => "●",
        GlyphState::NeedsYou => "!",
        GlyphState::Waiting => "◌",
        GlyphState::Failed => "✗",
        GlyphState::Stopped => "■",
        GlyphState::NotRun => "–",
        GlyphState::Expected => "○",
    }
}

pub fn flow_map<S: 'static>(map: &FlowMap, lens: fn(&mut S) -> &mut FlowMap, k: &Kit) -> El {
    let current = spot_of(&map.flow.current);
    let lanes = rows(&map.flow).into_iter().map(|lane| {
        let nodes = lane.nodes.iter().map(|node| {
            let spot = Spot {
                run: lane.run.into(),
                node: node.id.clone(),
            };
            let variant = if current.as_ref() == Some(&spot) {
                ButtonVariant::Contrast
            } else if map.selected.as_ref() == Some(&spot) {
                ButtonVariant::Outline
            } else {
                ButtonVariant::Ghost
            };
            let focused = map.focus.as_ref() == Some(&spot);
            let chosen = map.selected.as_ref() == Some(&spot);
            let key = format!("flow-{}-{}", spot.run, spot.node);
            Button::new(format!("{} {}", glyph(&node.state), node.title))
                .variant(variant)
                .on_press(move |s: &mut S| {
                    let map = lens(s);
                    map.focus = Some(spot.clone());
                    map.selected = Some(spot.clone());
                })
                .build(k)
                .key(key)
                .label(node_name(node))
                .focus_selected(focused)
                // ARIA's aria-pressed; Rune has no aria-current for the current Step.
                .checked(chosen)
        });
        row()
            .key(format!("flow-row-{}", lane.run))
            .role("group")
            .label(lane.name)
            .gap(4.0)
            .center_y()
            .children(nodes)
    });
    // Rune's own roving is linear; this runs first and moves the map's stop, which focus follows.
    let keys = move |s: &mut S, ev: &KeyEvent, _: &mut rune::Tx| {
        let map = lens(s);
        let Some(focus) = map.focus.clone().filter(|_| ev.mods == Mods::default()) else {
            return false;
        };
        if ev.key == Key::Enter {
            map.selected = Some(focus);
            return true;
        }
        let Some(spot) = moved(&map.flow, &focus, &ev.key) else {
            return false;
        };
        map.focus = Some(spot);
        true
    };
    col()
        .key("flow")
        .role("group")
        .label("Flow")
        .focus_group()
        .focus_follows()
        .on_key(keys)
        .gap(6.0)
        .children(lanes)
        .child(
            text(map.announcement.clone())
                .key("flow-announcement")
                .live_region(LiveRegion::Polite)
                .font(k.ty.small)
                .color(k.c.text_muted),
        )
}
