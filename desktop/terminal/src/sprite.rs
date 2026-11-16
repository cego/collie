//! The glyphs Ghostty draws itself rather than take from the font, so they meet their
//! neighbours across cells: box drawing, block elements, braille and powerline (after
//! Ghostty's `font/sprite/draw`, MIT; see THIRD-PARTY-NOTICES).

use crate::font::{Metrics, Raster};
use swash::zeno::{Cap, Command, Fill, Mask, PathBuilder, Stroke};

/// Whether Ghostty draws `c` itself.
pub fn drawn(c: char) -> bool {
    matches!(u32::from(c),
        0x2500..=0x259f | 0x2800..=0x28ff | 0x25e2..=0x25e5 | 0xe0b0..=0xe0bf)
}

struct Canvas {
    w: i32,
    h: i32,
    data: Vec<u8>,
}

impl Canvas {
    fn new(w: u32, h: u32) -> Canvas {
        Canvas {
            w: w as i32,
            h: h as i32,
            data: vec![0; (w * h) as usize],
        }
    }

    /// Fills x0..x1 by y0..y1 with `alpha`.
    fn rect(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, alpha: u8) {
        for y in y0.max(0)..y1.min(self.h) {
            for x in x0.max(0)..x1.min(self.w) {
                let at = (y * self.w + x) as usize;
                self.data[at] = self.data[at].max(alpha);
            }
        }
    }

    fn path(&mut self, path: &[Command], stroke: Option<f32>) {
        let mut mask = Mask::new(path);
        mask.size(self.w as u32, self.h as u32);
        match stroke {
            Some(width) => {
                let mut style = Stroke::new(width);
                style.cap(Cap::Butt);
                mask.style(style);
            }
            None => {
                mask.style(Fill::NonZero);
            }
        }
        let (coverage, _) = mask.render();
        for (to, from) in self.data.iter_mut().zip(coverage) {
            *to = (*to).max(from);
        }
    }

    fn flip(&mut self) {
        for row in self.data.chunks_mut(self.w as usize) {
            row.reverse();
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Line {
    None,
    Light,
    Heavy,
    Double,
}

/// Each box-drawing character from U+2500 as its up, right, down and left lines: 0 none,
/// 1 light, 2 heavy, 3 double. Dashes, arcs and diagonals are drawn apart.
const LINES: [&str; 128] = [
    "0101", "0202", "1010", "2020", "", "", "", "", "", "", "", "", "0110", "0210", "0120", "0220",
    "0011", "0012", "0021", "0022", "1100", "1200", "2100", "2200", "1001", "1002", "2001", "2002",
    "1110", "1210", "2110", "1120", "2120", "2210", "1220", "2220", "1011", "1012", "2011", "1021",
    "2021", "2012", "1022", "2022", "0111", "0112", "0211", "0212", "0121", "0122", "0221", "0222",
    "1101", "1102", "1201", "1202", "2101", "2102", "2201", "2202", "1111", "1112", "1211", "1212",
    "2111", "1121", "2121", "2112", "2211", "1122", "1221", "2212", "1222", "2122", "2221", "2222",
    "", "", "", "", "0303", "3030", "0310", "0130", "0330", "0013", "0031", "0033", "1300", "3100",
    "3300", "1003", "3001", "3003", "1310", "3130", "3330", "1013", "3031", "3033", "0313", "0131",
    "0333", "1303", "3101", "3303", "1313", "3131", "3333", "", "", "", "", "", "", "", "0001",
    "1000", "0100", "0010", "0002", "2000", "0200", "0020", "0201", "1020", "0102", "2010",
];

fn lines(m: &Metrics, canvas: &mut Canvas, [up, right, down, left]: [Line; 4]) {
    use Line::*;
    let (w, h) = (m.cell_width as i32, m.cell_height as i32);
    let light = m.box_thickness as i32;
    let heavy = light * 2;
    let h_light_top = (h - light).max(0) / 2;
    let h_light_bottom = h_light_top + light;
    let h_heavy_top = (h - heavy).max(0) / 2;
    let h_heavy_bottom = h_heavy_top + heavy;
    let h_double_top = (h_light_top - light).max(0);
    let h_double_bottom = h_light_bottom + light;
    let v_light_left = (w - light).max(0) / 2;
    let v_light_right = v_light_left + light;
    let v_heavy_left = (w - heavy).max(0) / 2;
    let v_heavy_right = v_heavy_left + heavy;
    let v_double_left = (v_light_left - light).max(0);
    let v_double_right = v_light_right + light;

    let up_bottom = if left == Heavy || right == Heavy {
        h_heavy_bottom
    } else if left != right || down == up {
        if left == Double || right == Double {
            h_double_bottom
        } else {
            h_light_bottom
        }
    } else if left == None && right == None {
        h_light_bottom
    } else {
        h_light_top
    };
    let down_top = if left == Heavy || right == Heavy {
        h_heavy_top
    } else if left != right || up == down {
        if left == Double || right == Double {
            h_double_top
        } else {
            h_light_top
        }
    } else if left == None && right == None {
        h_light_top
    } else {
        h_light_bottom
    };
    let left_right = if up == Heavy || down == Heavy {
        v_heavy_right
    } else if up != down || left == right {
        if up == Double || down == Double {
            v_double_right
        } else {
            v_light_right
        }
    } else if up == None && down == None {
        v_light_right
    } else {
        v_light_left
    };
    let right_left = if up == Heavy || down == Heavy {
        v_heavy_left
    } else if up != down || right == left {
        if up == Double || down == Double {
            v_double_left
        } else {
            v_light_left
        }
    } else if up == None && down == None {
        v_light_left
    } else {
        v_light_right
    };
    let on = 255;
    match up {
        None => {}
        Light => canvas.rect(v_light_left, 0, v_light_right, up_bottom, on),
        Heavy => canvas.rect(v_heavy_left, 0, v_heavy_right, up_bottom, on),
        Double => {
            let left_bottom = if left == Double {
                h_light_top
            } else {
                up_bottom
            };
            let right_bottom = if right == Double {
                h_light_top
            } else {
                up_bottom
            };
            canvas.rect(v_double_left, 0, v_light_left, left_bottom, on);
            canvas.rect(v_light_right, 0, v_double_right, right_bottom, on);
        }
    }
    match right {
        None => {}
        Light => canvas.rect(right_left, h_light_top, w, h_light_bottom, on),
        Heavy => canvas.rect(right_left, h_heavy_top, w, h_heavy_bottom, on),
        Double => {
            let top_left = if up == Double {
                v_light_right
            } else {
                right_left
            };
            let bottom_left = if down == Double {
                v_light_right
            } else {
                right_left
            };
            canvas.rect(top_left, h_double_top, w, h_light_top, on);
            canvas.rect(bottom_left, h_light_bottom, w, h_double_bottom, on);
        }
    }
    match down {
        None => {}
        Light => canvas.rect(v_light_left, down_top, v_light_right, h, on),
        Heavy => canvas.rect(v_heavy_left, down_top, v_heavy_right, h, on),
        Double => {
            let left_top = if left == Double {
                h_light_bottom
            } else {
                down_top
            };
            let right_top = if right == Double {
                h_light_bottom
            } else {
                down_top
            };
            canvas.rect(v_double_left, left_top, v_light_left, h, on);
            canvas.rect(v_light_right, right_top, v_double_right, h, on);
        }
    }
    match left {
        None => {}
        Light => canvas.rect(0, h_light_top, left_right, h_light_bottom, on),
        Heavy => canvas.rect(0, h_heavy_top, left_right, h_heavy_bottom, on),
        Double => {
            let top_right = if up == Double {
                v_light_left
            } else {
                left_right
            };
            let bottom_right = if down == Double {
                v_light_left
            } else {
                left_right
            };
            canvas.rect(0, h_double_top, top_right, h_light_top, on);
            canvas.rect(0, h_light_bottom, bottom_right, h_double_bottom, on);
        }
    }
}

/// `count` dashes across the cell, half a gap at each end so they tile.
fn dashes(m: &Metrics, canvas: &mut Canvas, count: i32, thick: i32, vertical: bool) {
    let (along, across) = if vertical {
        (m.cell_height as i32, m.cell_width as i32)
    } else {
        (m.cell_width as i32, m.cell_height as i32)
    };
    let gap = (m.box_thickness as i32 * 2).min(along / (2 * count)).max(1);
    let dash = (along - gap * count) / count;
    let at = (across - thick).max(0) / 2;
    let mut pos = gap / 2;
    for _ in 0..count {
        if vertical {
            canvas.rect(at, pos, at + thick, pos + dash, 255);
        } else {
            canvas.rect(pos, at, pos + dash, at + thick, 255);
        }
        pos += dash + gap;
    }
}

fn arc(m: &Metrics, canvas: &mut Canvas, c: u32) {
    let thick = m.box_thickness as f32;
    let (w, h) = (m.cell_width as f32, m.cell_height as f32);
    let cx = ((m.cell_width - m.box_thickness.min(m.cell_width)) / 2) as f32 + thick / 2.0;
    let cy = ((m.cell_height - m.box_thickness.min(m.cell_height)) / 2) as f32 + thick / 2.0;
    let r = w.min(h) / 2.0;
    let s = 0.25;
    let mut path: Vec<Command> = Vec::new();
    match c {
        // ╭ down and right
        0x256d => {
            path.move_to([cx, h])
                .line_to([cx, cy + r])
                .curve_to([cx, cy + s * r], [cx + s * r, cy], [cx + r, cy])
                .line_to([w, cy]);
        }
        // ╮ down and left
        0x256e => {
            path.move_to([cx, h])
                .line_to([cx, cy + r])
                .curve_to([cx, cy + s * r], [cx - s * r, cy], [cx - r, cy])
                .line_to([0.0, cy]);
        }
        // ╯ up and left
        0x256f => {
            path.move_to([cx, 0.0])
                .line_to([cx, cy - r])
                .curve_to([cx, cy - s * r], [cx - s * r, cy], [cx - r, cy])
                .line_to([0.0, cy]);
        }
        // ╰ up and right
        _ => {
            path.move_to([cx, 0.0])
                .line_to([cx, cy - r])
                .curve_to([cx, cy - s * r], [cx + s * r, cy], [cx + r, cy])
                .line_to([w, cy]);
        }
    }
    canvas.path(&path, Some(thick));
}

fn diagonal(m: &Metrics, canvas: &mut Canvas, down: bool) {
    let (w, h) = (m.cell_width as f32, m.cell_height as f32);
    let (sx, sy) = ((w / h).min(1.0), (h / w).min(1.0));
    let mut path: Vec<Command> = Vec::new();
    if down {
        path.move_to([-0.5 * sx, -0.5 * sy])
            .line_to([w + 0.5 * sx, h + 0.5 * sy]);
    } else {
        path.move_to([w + 0.5 * sx, -0.5 * sy])
            .line_to([-0.5 * sx, h + 0.5 * sy]);
    }
    canvas.path(&path, Some(m.box_thickness as f32));
}

fn block(m: &Metrics, canvas: &mut Canvas, c: u32) {
    let (w, h) = (m.cell_width as i32, m.cell_height as i32);
    let part = |n: f32, of: i32| (of as f32 * n).round() as i32;
    let (hw, hh) = (part(0.5, w), part(0.5, h));
    match c {
        0x2580 => canvas.rect(0, 0, w, hh, 255),
        0x2581..=0x2587 => {
            let eighths = (c - 0x2580) as f32 / 8.0;
            canvas.rect(0, h - part(eighths, h), w, h, 255);
        }
        0x2588 => canvas.rect(0, 0, w, h, 255),
        0x2589..=0x258f => {
            let eighths = (0x2590 - c) as f32 / 8.0;
            canvas.rect(0, 0, part(eighths, w), h, 255);
        }
        0x2590 => canvas.rect(w - hw, 0, w, h, 255),
        0x2591 => canvas.rect(0, 0, w, h, 0x40),
        0x2592 => canvas.rect(0, 0, w, h, 0x80),
        0x2593 => canvas.rect(0, 0, w, h, 0xc0),
        0x2594 => canvas.rect(0, 0, w, part(0.125, h), 255),
        0x2595 => canvas.rect(w - part(0.125, w), 0, w, h, 255),
        _ => {
            // Quadrants: top left, top right, bottom left, bottom right.
            let quads: [bool; 4] = match c {
                0x2596 => [false, false, true, false],
                0x2597 => [false, false, false, true],
                0x2598 => [true, false, false, false],
                0x2599 => [true, false, true, true],
                0x259a => [true, false, false, true],
                0x259b => [true, true, true, false],
                0x259c => [true, true, false, true],
                0x259d => [false, true, false, false],
                0x259e => [false, true, true, false],
                _ => [false, true, true, true],
            };
            let (mx, my) = (w / 2, h / 2);
            if quads[0] {
                canvas.rect(0, 0, mx, my, 255);
            }
            if quads[1] {
                canvas.rect(mx, 0, w, my, 255);
            }
            if quads[2] {
                canvas.rect(0, my, mx, h, 255);
            }
            if quads[3] {
                canvas.rect(mx, my, w, h, 255);
            }
        }
    }
}

fn braille(m: &Metrics, canvas: &mut Canvas, c: u32) {
    let (width, height) = (m.cell_width as i32, m.cell_height as i32);
    let mut w = (width / 4).min(height / 8);
    let mut x_spacing = width / 4;
    let mut y_spacing = height / 8;
    let mut x_margin = x_spacing / 2;
    let mut y_margin = y_spacing / 2;
    let mut x_left = width - 2 * x_margin - x_spacing - 2 * w;
    let mut y_left = height - 2 * y_margin - 3 * y_spacing - 4 * w;
    if x_left >= 2 && y_left >= 4 && w == 0 {
        w += 1;
        x_left -= 2;
        y_left -= 4;
    }
    if x_left >= 2 && x_margin == 0 {
        x_margin = 1;
        x_left -= 2;
    }
    if y_left >= 2 && y_margin == 0 {
        y_margin = 1;
        y_left -= 2;
    }
    if x_left >= 1 {
        x_spacing += 1;
        x_left -= 1;
    }
    if y_left >= 3 {
        y_spacing += 1;
        y_left -= 3;
    }
    if x_left >= 2 {
        x_margin += 1;
        x_left -= 2;
    }
    if y_left >= 2 {
        y_margin += 1;
        y_left -= 2;
    }
    if x_left >= 2 && y_left >= 4 {
        w += 1;
    }
    let x = [x_margin, x_margin + w + x_spacing];
    let y = [
        y_margin,
        y_margin + w + y_spacing,
        y_margin + 2 * (w + y_spacing),
        y_margin + 3 * (w + y_spacing),
    ];
    // Dots 1-3 and 7 down the left, 4-6 and 8 down the right, as bits 0 to 7.
    let dots = [
        (0, 0),
        (0, 1),
        (0, 2),
        (1, 0),
        (1, 1),
        (1, 2),
        (0, 3),
        (1, 3),
    ];
    for (bit, (col, row)) in dots.iter().enumerate() {
        if c & (1 << bit) != 0 {
            canvas.rect(x[*col], y[*row], x[*col] + w, y[*row] + w, 255);
        }
    }
}

fn powerline(m: &Metrics, canvas: &mut Canvas, c: u32, width: f32) {
    let h = m.cell_height as f32;
    let w = width;
    let k = (std::f32::consts::SQRT_2 - 1.0) * 4.0 / 3.0;
    let thin = m.box_thickness as f32;
    let mut path: Vec<Command> = Vec::new();
    let (stroke, flip) = match c {
        0xe0b0 | 0xe0b2 => {
            path.move_to([0.0, 0.0])
                .line_to([w, h / 2.0])
                .line_to([0.0, h])
                .close();
            (None, c == 0xe0b2)
        }
        0xe0b1 | 0xe0b3 => {
            path.move_to([0.0, 0.0])
                .line_to([w, h / 2.0])
                .line_to([0.0, h]);
            (Some(thin), c == 0xe0b3)
        }
        0xe0b4..=0xe0b7 => {
            let r = w.min(h / 2.0);
            let open = matches!(c, 0xe0b5 | 0xe0b7);
            path.move_to([0.0, 0.0])
                .curve_to([r * k, 0.0], [r, r - r * k], [r, r])
                .line_to([r, h - r])
                .curve_to([r, h - r + r * k], [r * k, h], [0.0, h]);
            if !open {
                path.close();
            }
            (open.then_some(thin), matches!(c, 0xe0b6 | 0xe0b7))
        }
        // The slanted halves: ◢ ◤ and their outlines.
        0xe0b8 | 0xe0bc => {
            if c == 0xe0b8 {
                path.move_to([0.0, 0.0])
                    .line_to([w, h])
                    .line_to([0.0, h])
                    .close();
            } else {
                path.move_to([0.0, 0.0])
                    .line_to([w, 0.0])
                    .line_to([0.0, h])
                    .close();
            }
            (None, false)
        }
        0xe0ba | 0xe0be => {
            if c == 0xe0ba {
                path.move_to([w, 0.0])
                    .line_to([w, h])
                    .line_to([0.0, h])
                    .close();
            } else {
                path.move_to([0.0, 0.0])
                    .line_to([w, 0.0])
                    .line_to([w, h])
                    .close();
            }
            (None, false)
        }
        0xe0b9 | 0xe0bf => {
            path.move_to([0.0, 0.0]).line_to([w, h]);
            (Some(thin), false)
        }
        _ => {
            path.move_to([w, 0.0]).line_to([0.0, h]);
            (Some(thin), false)
        }
    };
    canvas.path(&path, stroke);
    if flip {
        canvas.flip();
    }
}

fn corner_triangle(m: &Metrics, canvas: &mut Canvas, c: u32) {
    let (w, h) = (m.cell_width as f32, m.cell_height as f32);
    let mut path: Vec<Command> = Vec::new();
    let [a, b, d]: [[f32; 2]; 3] = match c {
        0x25e2 => [[w, 0.0], [w, h], [0.0, h]],
        0x25e3 => [[0.0, 0.0], [w, h], [0.0, h]],
        0x25e4 => [[0.0, 0.0], [w, 0.0], [0.0, h]],
        _ => [[0.0, 0.0], [w, 0.0], [w, h]],
    };
    path.move_to(a).line_to(b).line_to(d).close();
    canvas.path(&path, None);
}

/// `c` drawn into one cell (two for a wide one), as coverage placed like a glyph whose pen
/// is the cell's left on the baseline.
pub fn draw(c: char, m: &Metrics, cells: u8) -> Option<Raster> {
    let c = u32::from(c);
    let width = m.cell_width * u32::from(cells.max(1));
    let mut canvas = Canvas::new(width, m.cell_height);
    match c {
        0x2500..=0x257f => {
            let spec = LINES[(c - 0x2500) as usize];
            let light = m.box_thickness as i32;
            match c {
                0x2504..=0x250b | 0x254c..=0x254f => {
                    let (count, heavy, vertical) = match c {
                        0x2504 => (3, false, false),
                        0x2505 => (3, true, false),
                        0x2506 => (3, false, true),
                        0x2507 => (3, true, true),
                        0x2508 => (4, false, false),
                        0x2509 => (4, true, false),
                        0x250a => (4, false, true),
                        0x250b => (4, true, true),
                        0x254c => (2, false, false),
                        0x254d => (2, true, false),
                        0x254e => (2, false, true),
                        _ => (2, true, true),
                    };
                    dashes(
                        m,
                        &mut canvas,
                        count,
                        if heavy { light * 2 } else { light },
                        vertical,
                    );
                }
                0x256d..=0x2570 => arc(m, &mut canvas, c),
                0x2571 => diagonal(m, &mut canvas, false),
                0x2572 => diagonal(m, &mut canvas, true),
                0x2573 => {
                    diagonal(m, &mut canvas, false);
                    diagonal(m, &mut canvas, true);
                }
                _ => {
                    let line = |b: u8| match b {
                        b'1' => Line::Light,
                        b'2' => Line::Heavy,
                        b'3' => Line::Double,
                        _ => Line::None,
                    };
                    let b = spec.as_bytes();
                    lines(
                        m,
                        &mut canvas,
                        [line(b[0]), line(b[1]), line(b[2]), line(b[3])],
                    );
                }
            }
        }
        0x2580..=0x259f => block(m, &mut canvas, c),
        0x2800..=0x28ff => braille(m, &mut canvas, c),
        0x25e2..=0x25e5 => corner_triangle(m, &mut canvas, c),
        0xe0b0..=0xe0bf => powerline(m, &mut canvas, c, m.cell_width as f32),
        _ => return None,
    }
    Some(Raster {
        left: 0,
        top: m.baseline,
        width,
        height: m.cell_height,
        color: false,
        data: canvas.data,
    })
}
