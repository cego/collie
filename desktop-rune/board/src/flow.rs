//! The Flow map as Rune draws it: one tab stop, arrows moving as `flowKey` does, and the
//! changes `flowAnnouncements` names read out politely.
//! A narrow copy of `flowRows`, `nodeName`, `flowAnnouncements` and `flowKey` in
//! `desktop/src/shared/flow.ts`, which stays their owner.

pub mod actions;
pub mod glyph;
pub mod inspector;

use collie_desktop_protocol::generated::{DetailFlow, DetailFlowCurrent, GlyphState, Node};
use rune::{El, Key, KeyEvent, LineCap, LiveRegion, Mods, Path, Shape, canvas, col, row, text};
use rune_kit::Kit;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spot {
    pub run: String,
    pub node: String,
}

pub struct Row<'a> {
    pub run: &'a str,
    pub name: String,
    /// The lane's title and what is said under it: its Machine and how it runs.
    pub title: String,
    pub meta: String,
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
        title: lane.title.clone(),
        meta: format!("{} · {}", lane.machine, written(&lane.execution)),
        nodes: &lane.nodes,
    });
    let release = flow.release.iter().map(|nodes| Row {
        run: "release",
        name: "Release".into(),
        title: "Release".into(),
        meta: String::new(),
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

/// The Run's active Step: the one under way, or else the first needing the human, or else the
/// latest reached.
pub fn active(flow: &DetailFlow) -> Option<Spot> {
    let all: Vec<Spot> = rows(flow)
        .iter()
        .flat_map(|row| {
            row.nodes.iter().map(move |node| Spot {
                run: row.run.into(),
                node: node.id.clone(),
            })
        })
        .collect();
    let state = |spot: &Spot| node_at(flow, spot).map(|n| n.state.clone());
    let first = |wanted: GlyphState| {
        all.iter()
            .find(|s| state(s) == Some(wanted.clone()))
            .cloned()
    };
    spot_of(&flow.current)
        .filter(|spot| node_at(flow, spot).is_some())
        .or_else(|| first(GlyphState::Running))
        .or_else(|| first(GlyphState::NeedsYou))
        .or_else(|| {
            all.iter()
                .rev()
                .find(|s| state(s).is_some_and(|st| st != GlyphState::Expected))
                .cloned()
        })
        .or_else(|| all.first().cloned())
}

pub struct FlowMap {
    pub flow: DetailFlow,
    /// The Step the map's one tab stop is on.
    pub focus: Option<Spot>,
    pub selected: Option<Spot>,
    /// What the live region last said.
    pub announcement: String,
    /// How wide the map was laid out, which decides how many Steps go on a line.
    pub width: f32,
    /// The Step to scroll into view once it is laid out.
    pub reveal: Option<Spot>,
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
            width: 0.0,
            reveal: None,
        }
    }

    /// Chooses the Run's active Step, its details shown and the Step scrolled into view.
    pub fn open_active(&mut self) {
        if let Some(spot) = active(&self.flow) {
            self.focus = Some(spot.clone());
            self.selected = Some(spot.clone());
            self.reveal = Some(spot);
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
        self.selected = self
            .selected
            .take()
            .filter(|spot| node_at(&fresh.flow, spot).is_some());
        self.reveal = self
            .reveal
            .take()
            .filter(|spot| node_at(&fresh.flow, spot).is_some());
        self.flow = fresh.flow;
    }
}

/// A Step's card, at least this wide.
const STEP_MIN: f32 = 176.0;
/// And at most this wide, where a lane has few Steps.
const STEP_MAX: f32 = 248.0;
const STEP_H: f32 = 52.0;
/// The run of an arrow between two Steps on a line.
const LINK: f32 = 28.0;
/// The height of the turn from the end of one line to the start of the next.
const TURN: f32 = 24.0;

/// How many Steps go on a line of a map `width` points wide, and how wide each is.
pub fn columns(width: f32, steps: usize) -> (usize, f32) {
    let width = if width > 0.0 { width } else { 960.0 };
    let fit = ((width + LINK) / (STEP_MIN + LINK)).floor().max(1.0) as usize;
    let cols = fit.min(steps.max(1));
    let each = ((width - LINK * (cols - 1) as f32) / cols as f32).min(STEP_MAX);
    (cols, each.max(1.0))
}

/// The arrow between two Steps on a line; dashed where the next is still to come.
fn link(to: &Node, k: &Kit) -> El {
    let ahead = to.state == GlyphState::Expected;
    let ink = if ahead {
        k.c.border_base
    } else {
        k.c.border_strong
    };
    let y = STEP_H / 2.0;
    let shape = if ahead {
        (0..4).fold(Shape::new(), |s, i| {
            let x = 3.0 + i as f32 * 5.5;
            s.line([x, y], [x + 2.5, y], 1.25, LineCap::Round, ink)
        })
    } else {
        Shape::new().line([3.0, y], [LINK - 5.0, y], 1.25, LineCap::Round, ink)
    }
    .stroke(
        vec![
            [LINK - 7.5, y - 3.0],
            [LINK - 4.0, y],
            [LINK - 7.5, y + 3.0],
        ],
        1.25,
        ink,
    );
    canvas(shape).size(LINK, STEP_H).a11y_hidden()
}

/// The turn from the last Step of one line down to the first of the next.
fn turn(cols: usize, each: f32, to: &Node, k: &Kit) -> El {
    let ink = if to.state == GlyphState::Expected {
        k.c.border_base
    } else {
        k.c.border_strong
    };
    let from = (cols - 1) as f32 * (each + LINK) + each / 2.0;
    let back = each / 2.0;
    let mid = TURN / 2.0;
    let r = 6.0_f32.min(mid);
    let path = Path::new()
        .move_to([from, 0.0])
        .line_to([from, mid - r])
        .quad_to([from, mid], [from - r, mid])
        .line_to([back + r, mid])
        .quad_to([back, mid], [back, mid + r])
        .line_to([back, TURN - 3.0]);
    let width = cols as f32 * each + (cols - 1) as f32 * LINK;
    let shape = Shape::new()
        .stroke_path(&path, 1.25, LineCap::Round, ink)
        .stroke(
            vec![
                [back - 3.0, TURN - 6.0],
                [back, TURN - 2.5],
                [back + 3.0, TURN - 6.0],
            ],
            1.25,
            ink,
        );
    canvas(shape).size(width, TURN).a11y_hidden()
}

fn step<S: 'static>(
    map: &FlowMap,
    lens: fn(&mut S) -> &mut FlowMap,
    run: &str,
    node: &Node,
    each: f32,
    current: bool,
    k: &Kit,
) -> El {
    let spot = Spot {
        run: run.into(),
        node: node.id.clone(),
    };
    let focused = map.focus.as_ref() == Some(&spot);
    let chosen = map.selected.as_ref() == Some(&spot);
    let key = format!("flow-{}-{}", spot.run, spot.node);
    let ahead = node.state == GlyphState::Expected;
    let edge = match node.state {
        GlyphState::Failed => k.c.danger.icon,
        GlyphState::NeedsYou => k.c.warning.icon,
        _ if current => k.c.info.icon,
        _ if chosen => k.c.border_strong,
        _ => k.c.border_weak,
    };
    let strong = matches!(node.state, GlyphState::Failed | GlyphState::NeedsYou) || current;
    let said = node
        .said
        .clone()
        .filter(|s| !s.is_empty() && (!ahead || node.pause.clone().flatten().is_some()));
    let title = text(node.title.clone())
        .font(k.ty.ui_medium)
        .color(if ahead {
            k.c.text_muted
        } else {
            k.c.text_strong
        })
        .truncate()
        .a11y_hidden();
    let words = col()
        .gap(1.0)
        .grow(1.0)
        .min_w(0.0)
        .child(title)
        .children(said.map(|said| {
            text(said)
                .font(k.ty.text_xsmall)
                .color(k.c.text_muted)
                .truncate()
                .a11y_hidden()
        }));
    let linked = node.link.clone().flatten().is_some();
    let revealed = (map.reveal.as_ref() == Some(&spot)).then(|| key.clone());
    let step = row()
        .key(key)
        .role("button")
        .label(node_name(node))
        .focusable(true)
        .focus_selected(focused)
        // ARIA's aria-pressed; Rune has no aria-current for the current Step.
        .checked(chosen)
        .w(each)
        .h(STEP_H)
        .px(10.0)
        .gap(9.0)
        .center_y()
        .radius(k.radius.md)
        .fill(if chosen {
            k.c.layer_03
        } else if linked {
            k.c.layer_01
        } else {
            k.c.layer_02
        })
        .border(if strong { 1.5 } else { 1.0 }, edge)
        .hover(k.c.surface_hover)
        .on_press(move |s: &mut S| {
            let map = lens(s);
            map.focus = Some(spot.clone());
            map.selected = Some(spot.clone());
        })
        .child(glyph::glyph(&node.state, 16.0, k))
        .child(words);
    match revealed {
        // Once laid out, it is scrolled to, and only the once.
        Some(key) => step.on_layout_tx(move |s: &mut S, _, tx| {
            if lens(s).reveal.take().is_some() {
                tx.scroll_into_view(key.clone());
            }
        }),
        None => step,
    }
}

/// One lane: its title, its Machine and how it runs, then its Steps, line after line.
fn lane<S: 'static>(
    map: &FlowMap,
    lens: fn(&mut S) -> &mut FlowMap,
    lane: Row<'_>,
    current: Option<&Spot>,
    k: &Kit,
) -> El {
    let (cols, each) = columns(map.width, lane.nodes.len());
    let mut lines = col().gap(0.0);
    let chunks: Vec<&[Node]> = lane.nodes.chunks(cols).collect();
    for (at, chunk) in chunks.iter().enumerate() {
        let mut line = row().key(format!("flow-line-{}-{at}", lane.run)).center_y();
        for (i, node) in chunk.iter().enumerate() {
            if i > 0 {
                line = line.child(link(node, k));
            }
            let here = current.is_some_and(|c| c.run == lane.run && c.node == node.id);
            line = line.child(step(map, lens, lane.run, node, each, here, k));
        }
        lines = lines.child(line);
        if let Some(next) = chunks.get(at + 1).and_then(|c| c.first()) {
            lines = lines.child(turn(cols, each, next, k));
        }
    }
    let header = row()
        .gap(8.0)
        .center_y()
        .child(
            text(lane.title.clone())
                .font(k.ty.text_small_medium)
                .color(k.c.text_strong)
                .truncate()
                .a11y_hidden(),
        )
        .children((!lane.meta.is_empty()).then(|| {
            text(lane.meta.clone())
                .font(k.ty.text_xsmall)
                .color(k.c.text_faint)
                .truncate()
                .a11y_hidden()
        }));
    col()
        .key(format!("flow-row-{}", lane.run))
        .role("group")
        .label(lane.name)
        .gap(8.0)
        .w_full()
        .child(header)
        .children((!lane.nodes.is_empty()).then_some(lines))
}

/// The Flow as a map: each lane's Steps as cards joined by arrows, wrapping line after line.
pub fn flow_map<S: 'static>(map: &FlowMap, lens: fn(&mut S) -> &mut FlowMap, k: &Kit) -> El {
    let current = spot_of(&map.flow.current);
    let lanes: Vec<El> = rows(&map.flow)
        .into_iter()
        .map(|row| lane(map, lens, row, current.as_ref(), k))
        .collect();
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
    let mut body = col().gap(20.0).w_full();
    for (at, lane) in lanes.into_iter().enumerate() {
        if at > 0 {
            body = body.child(rune::el().h(1.0).w_full().fill(k.c.border_weak));
        }
        body = body.child(lane);
    }
    col()
        .key("flow")
        .role("group")
        .label("Flow")
        .focus_group()
        .focus_follows()
        .on_key(keys)
        .w_full()
        .on_layout(move |s: &mut S, [_, _, w, _]| {
            let map = lens(s);
            if (map.width - w).abs() > 0.5 {
                map.width = w;
            }
        })
        .child(body)
        .child(
            text(map.announcement.clone())
                .key("flow-announcement")
                .live_region(LiveRegion::Polite)
                .font(k.ty.small)
                .color(k.c.text_muted),
        )
}
