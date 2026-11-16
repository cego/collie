//! A Step's state as a small drawn mark, as `FlowGlyph.vue` draws it: a filled disc with a check,
//! a cross, a square or a bang for what is settled or asks; a ring with a turn, hands or a slash
//! for what is under way, waiting or skipped; a dashed ring for what is still to come.

use collie_desktop_protocol::generated::GlyphState;
use rune::{Color, El, LineCap, Path, Shape, canvas};
use rune_kit::Kit;

/// How strongly a state is drawn: its own hue where it is settled or asks, quiet otherwise.
pub fn tone(state: &GlyphState, k: &Kit) -> Color {
    match state {
        GlyphState::Done => k.c.success.icon,
        GlyphState::Running => k.c.info.icon,
        GlyphState::NeedsYou => k.c.warning.icon,
        GlyphState::Failed => k.c.danger.icon,
        GlyphState::Stopped | GlyphState::Waiting => k.c.icon_muted,
        GlyphState::NotRun | GlyphState::Expected => k.c.icon_faint,
    }
}

/// A circle of radius `r` around `c`, as four quarter curves.
fn circle(c: [f32; 2], r: f32) -> Path {
    let k = r * 0.552_284_8;
    let [x, y] = c;
    Path::new()
        .move_to([x + r, y])
        .cubic_to([x + r, y + k], [x + k, y + r], [x, y + r])
        .cubic_to([x - k, y + r], [x - r, y + k], [x - r, y])
        .cubic_to([x - r, y - k], [x - k, y - r], [x, y - r])
        .cubic_to([x + k, y - r], [x + r, y - k], [x + r, y])
        .close()
}

/// The arc of radius `r` around `c` from `from` to `to` radians, clockwise from three o'clock.
fn arc(c: [f32; 2], r: f32, from: f32, to: f32) -> Vec<[f32; 2]> {
    let steps = 12;
    (0..=steps)
        .map(|i| {
            let a = from + (to - from) * i as f32 / steps as f32;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect()
}

/// The mark for `state`, `size` points square; hidden from the tree, as the Step's name says it.
pub fn glyph(state: &GlyphState, size: f32, k: &Kit) -> El {
    let hue = tone(state, k);
    let c = [8.0, 8.0];
    let ink = k.c.bg_base;
    let shape = match state {
        GlyphState::Done => Shape::new().fill_path(&circle(c, 7.0), hue).stroke(
            vec![[5.0, 8.2], [7.1, 10.2], [11.0, 6.1]],
            1.6,
            ink,
        ),
        GlyphState::Failed => Shape::new()
            .fill_path(&circle(c, 7.0), hue)
            .line([5.6, 5.6], [10.4, 10.4], 1.6, LineCap::Round, ink)
            .line([10.4, 5.6], [5.6, 10.4], 1.6, LineCap::Round, ink),
        GlyphState::Stopped => Shape::new().fill_path(&circle(c, 7.0), hue).fill(
            vec![[5.6, 5.6], [10.4, 5.6], [10.4, 10.4], [5.6, 10.4]],
            ink,
        ),
        GlyphState::NeedsYou => Shape::new()
            .fill_path(&circle(c, 7.0), hue)
            .line([8.0, 4.4], [8.0, 8.9], 1.7, LineCap::Round, k.c.black)
            .fill_path(&circle([8.0, 11.3], 1.0), k.c.black),
        GlyphState::Running => Shape::new()
            .stroke_path(&circle(c, 6.5), 1.4, LineCap::Round, hue.alpha(0.3))
            .stroke(arc(c, 6.5, -std::f32::consts::FRAC_PI_2, 0.0), 1.6, hue)
            .fill_path(&circle(c, 2.4), hue),
        GlyphState::Waiting => Shape::new()
            .stroke_path(&circle(c, 6.5), 1.4, LineCap::Round, hue)
            .stroke(vec![[8.0, 4.8], [8.0, 8.0], [10.2, 9.4]], 1.4, hue),
        GlyphState::NotRun => Shape::new()
            .stroke_path(&circle(c, 6.5), 1.4, LineCap::Round, hue)
            .line([3.6, 3.6], [12.4, 12.4], 1.4, LineCap::Round, hue),
        GlyphState::Expected => (0..8).fold(Shape::new(), |shape, i| {
            let from = i as f32 * std::f32::consts::FRAC_PI_4;
            shape.stroke(
                arc(c, 6.5, from, from + std::f32::consts::FRAC_PI_4 * 0.55),
                1.4,
                hue,
            )
        }),
    };
    canvas(shape.view_box(16.0, 16.0))
        .size(size, size)
        .a11y_hidden()
}
