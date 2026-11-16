//! A row of cells painted into pixels as Ghostty's renderer would: each cell's background,
//! glyphs shaped in runs and blended with Ghostty's linear-corrected alpha, its own box
//! drawing, and the underline, overline and strikethrough of each style; and the cursor.

use crate::config::Look;
use crate::font::{Fonts, Raster, Style};
use crate::sprite;
use crate::vt::{Cell, Cursor, CursorStyle, Frame, Rgb, Underline};
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::LazyLock;
use swash::zeno::{Cap, Command, Mask, PathBuilder, Stroke};

/// Straight-alpha sRGB pixels, rows top first, as `rune::Pixels` takes them.
#[derive(Clone, Debug, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    fn new(width: u32, height: u32) -> Image {
        Image {
            width,
            height,
            rgba: vec![0; (width * height * 4) as usize],
        }
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let at = ((y * self.width + x) * 4) as usize;
        [
            self.rgba[at],
            self.rgba[at + 1],
            self.rgba[at + 2],
            self.rgba[at + 3],
        ]
    }
}

static LINEAR: LazyLock<[f32; 256]> = LazyLock::new(|| {
    std::array::from_fn(|i| {
        let v = i as f32 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    })
});

const SRGB_STEPS: usize = 1 << 16;
static SRGB: LazyLock<Vec<u8>> = LazyLock::new(|| {
    (0..SRGB_STEPS)
        .map(|i| (unlinearize(i as f32 / (SRGB_STEPS - 1) as f32) * 255.0).round() as u8)
        .collect()
});

fn linearize(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn unlinearize(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        v.powf(1.0 / 2.4) * 1.055 - 0.055
    }
}

fn srgb(linear: f32) -> u8 {
    SRGB[(linear.clamp(0.0, 1.0) * (SRGB_STEPS - 1) as f32) as usize]
}

fn lin(Rgb(r, g, b): Rgb) -> [f32; 3] {
    [LINEAR[r as usize], LINEAR[g as usize], LINEAR[b as usize]]
}

fn luminance([r, g, b]: [f32; 3]) -> f32 {
    r * 0.2126 + g * 0.7152 + b * 0.0722
}

/// Coverage `a` corrected so a blend in linear light looks like one in sRGB, as Ghostty's
/// `alpha-blending = linear-corrected` does; `fg` is premultiplied by its own alpha.
fn corrected(fg: [f32; 3], bg: [f32; 3], a: f32) -> f32 {
    let (fg_l, bg_l) = (luminance(fg), luminance(bg));
    if (fg_l - bg_l).abs() <= 0.001 {
        return a;
    }
    let blend_l = linearize(unlinearize(fg_l) * a + unlinearize(bg_l) * (1.0 - a));
    ((blend_l - bg_l) / (fg_l - bg_l)).clamp(0.0, 1.0)
}

/// The colours a cell is painted in.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Paint {
    fg: Rgb,
    bg: Rgb,
    /// The text's opacity: below one for faint text.
    alpha: f32,
}

struct Ramp {
    alpha: [f32; 256],
    over_bg: [[u8; 3]; 256],
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Deco {
    Underline(Underline),
    Overline,
    Strikethrough,
}

pub struct Painter {
    pub fonts: Fonts,
    look: Look,
    /// For each (fg, bg, opacity), each coverage's corrected alpha and the colour it makes
    /// over that background.
    ramps: HashMap<(Rgb, Rgb, u8), Rc<Ramp>>,
    sprites: HashMap<(char, u8), Option<Rc<Raster>>>,
    decos: HashMap<Deco, Rc<Raster>>,
    scale: f32,
}

impl Painter {
    pub fn new(look: &Look, scale: f32) -> Painter {
        Painter {
            fonts: Fonts::new(&look.families, look.font_size, scale),
            look: look.clone(),
            ramps: HashMap::new(),
            sprites: HashMap::new(),
            decos: HashMap::new(),
            scale,
        }
    }

    pub fn scale(&self) -> f32 {
        self.scale
    }

    /// A cell's width and height in device pixels.
    pub fn cell(&self) -> (u32, u32) {
        let m = self.fonts.metrics;
        (m.cell_width, m.cell_height)
    }

    fn paint_of(&self, frame: &Frame, cell: &Cell) -> Paint {
        let bg = cell.bg.unwrap_or(frame.bg);
        let (fg, bg) = if cell.selected {
            (
                self.look.selection_fg.unwrap_or(bg),
                self.look.selection_bg.unwrap_or(cell.fg),
            )
        } else {
            (cell.fg, bg)
        };
        Paint {
            fg,
            bg,
            alpha: if cell.faint {
                self.look.faint_opacity
            } else {
                1.0
            },
        }
    }

    /// Row `y` of `frame`, with the link the pointer is over, by its columns, underlined.
    pub fn row(&mut self, frame: &Frame, y: usize, hover: Option<Range<usize>>) -> Image {
        let cells = &frame.rows[y];
        let paints: Vec<Paint> = cells
            .iter()
            .map(|cell| self.paint_of(frame, cell))
            .collect();
        self.paint(cells, &paints, hover)
    }

    /// The cursor over its cell, to lay over the row: a block with the cell's text in the
    /// background's colour, a bar, an underline, or the hollow block of an unfocused terminal.
    pub fn cursor(&mut self, frame: &Frame, cursor: &Cursor, focused: bool) -> Image {
        let (cw, ch) = self.cell();
        let cells = if cursor.wide { 2 } else { 1 };
        let width = cw * cells;
        let color = frame.cursor_color.unwrap_or(self.look.theme.cursor);
        let style = if focused {
            cursor.style
        } else {
            CursorStyle::BlockHollow
        };
        let thick = self.scale.round().max(1.0) as u32;
        let m = self.fonts.metrics;
        let mut image = Image::new(width, ch);
        let rect = |image: &mut Image, x0: u32, y0: u32, x1: u32, y1: u32| {
            for y in y0..y1.min(ch) {
                for x in x0..x1.min(width) {
                    let at = ((y * width + x) * 4) as usize;
                    image.rgba[at..at + 4].copy_from_slice(&[color.0, color.1, color.2, 255]);
                }
            }
        };
        match style {
            CursorStyle::Block => {
                let Some(cell) = frame
                    .rows
                    .get(usize::from(cursor.y))
                    .and_then(|row| row.get(usize::from(cursor.x)))
                else {
                    rect(&mut image, 0, 0, width, ch);
                    return image;
                };
                let under = cell.bg.unwrap_or(frame.bg);
                let paint = Paint {
                    fg: self.look.cursor_text.unwrap_or(under),
                    bg: color,
                    alpha: 1.0,
                };
                let lone = Cell {
                    selected: false,
                    underline: Underline::None,
                    overline: false,
                    strikethrough: false,
                    ..cell.clone()
                };
                let mut cells = vec![lone];
                if cursor.wide {
                    cells.push(Cell {
                        spacer: true,
                        ..Cell::default()
                    });
                }
                let paints = vec![paint; cells.len()];
                return self.paint(&cells, &paints, None);
            }
            CursorStyle::Bar => rect(&mut image, 0, 0, thick, ch),
            CursorStyle::Underline => {
                let top = (m.underline_position.max(0) as u32).min(ch.saturating_sub(thick));
                rect(&mut image, 0, top, width, top + thick)
            }
            CursorStyle::BlockHollow => {
                rect(&mut image, 0, 0, width, thick);
                rect(&mut image, 0, ch.saturating_sub(thick), width, ch);
                rect(&mut image, 0, 0, thick, ch);
                rect(&mut image, width.saturating_sub(thick), 0, width, ch);
            }
        }
        image
    }

    fn paint(&mut self, cells: &[Cell], paints: &[Paint], hover: Option<Range<usize>>) -> Image {
        let (cw, ch) = self.cell();
        let m = self.fonts.metrics;
        let width = cw * cells.len() as u32;
        let mut image = Image::new(width, ch);
        // A wide character's spacer takes the colours of the character it is half of.
        let paints: Vec<Paint> = (0..cells.len())
            .map(|x| {
                if cells[x].spacer && x > 0 && cells[x - 1].wide {
                    paints[x - 1]
                } else {
                    paints[x]
                }
            })
            .collect();
        // Every scanline of the backgrounds is the same: paint one and copy it down.
        let line = (width * 4) as usize;
        for (x, paint) in paints.iter().enumerate() {
            let x0 = x * cw as usize * 4;
            for px in image.rgba[x0..x0 + cw as usize * 4].as_chunks_mut::<4>().0 {
                px.copy_from_slice(&[paint.bg.0, paint.bg.1, paint.bg.2, 255]);
            }
        }
        for y in 1..ch as usize {
            image.rgba.copy_within(0..line, y * line);
        }
        let bgs: Vec<Rgb> = paints.iter().map(|p| p.bg).collect();

        for (x, cell) in cells.iter().enumerate() {
            let hovered = hover.as_ref().is_some_and(|h| h.contains(&x));
            let underline = match cell.underline {
                Underline::None if hovered => Underline::Single,
                other => other,
            };
            let color = cell.underline_color.unwrap_or(paints[x].fg);
            let at = x as i32 * cw as i32;
            if underline != Underline::None {
                let mask = self.deco(Deco::Underline(underline));
                self.blit(&mut image, &bgs, &mask, at, 0, color, paints[x].alpha);
            }
            if cell.overline {
                let mask = self.deco(Deco::Overline);
                self.blit(
                    &mut image,
                    &bgs,
                    &mask,
                    at,
                    0,
                    paints[x].fg,
                    paints[x].alpha,
                );
            }
        }

        let mut x = 0;
        while x < cells.len() {
            let cell = &cells[x];
            let wide = if cell.wide { 2u8 } else { 1 };
            if cell.spacer || cell.text.is_empty() || cell.text == " " {
                x += 1;
                continue;
            }
            let mut chars = cell.text.chars();
            if let (Some(c), None) = (chars.next(), chars.next())
                && sprite::drawn(c)
            {
                if let Some(mask) = self.sprite(c, wide) {
                    let at = x as i32 * cw as i32;
                    self.blit(
                        &mut image,
                        &bgs,
                        &mask,
                        at,
                        0,
                        paints[x].fg,
                        paints[x].alpha,
                    );
                }
                x += 1;
                continue;
            }
            let style = Style::of(cell.bold, cell.italic);
            let face = self.fonts.face_for(&cell.text, style);
            let start = x;
            let mut end = x + 1;
            while end < cells.len() {
                let next = &cells[end];
                if next.spacer {
                    end += 1;
                    continue;
                }
                let lone = {
                    let mut chars = next.text.chars();
                    matches!((chars.next(), chars.next()), (Some(c), None) if sprite::drawn(c))
                };
                if next.text.is_empty()
                    || next.text == " "
                    || lone
                    || Style::of(next.bold, next.italic) != style
                    || self.fonts.face_for(&next.text, style) != face
                {
                    break;
                }
                end += 1;
            }
            let run: Vec<(&str, u8)> = cells[start..end]
                .iter()
                .filter(|c| !c.spacer)
                .map(|c| (c.text.as_str(), if c.wide { 2 } else { 1 }))
                .collect();
            let at = start as i32 * cw as i32;
            for placed in self.fonts.shape(face, &run, at) {
                let column = ((placed.x.max(0) as u32) / cw).min(cells.len() as u32 - 1) as usize;
                let column = if cells[column].spacer && column > 0 {
                    column - 1
                } else {
                    column
                };
                let Some(raster) = self.fonts.raster(placed.face, placed.glyph, placed.cells)
                else {
                    continue;
                };
                let left = placed.x + raster.left;
                let top = m.baseline - raster.top + placed.y;
                if raster.color {
                    // An emoji is placed in its cells rather than on the pen.
                    let left = column as i32 * cw as i32 + raster.left;
                    blit_color(&mut image, &raster, left, m.baseline - raster.top);
                } else {
                    let paint = paints[column];
                    self.blit(&mut image, &bgs, &raster, left, top, paint.fg, paint.alpha);
                }
            }
            x = end;
        }

        for (x, cell) in cells.iter().enumerate() {
            if cell.strikethrough {
                let mask = self.deco(Deco::Strikethrough);
                let at = x as i32 * cw as i32;
                self.blit(
                    &mut image,
                    &bgs,
                    &mask,
                    at,
                    0,
                    paints[x].fg,
                    paints[x].alpha,
                );
            }
        }
        image
    }

    fn sprite(&mut self, c: char, cells: u8) -> Option<Rc<Raster>> {
        let m = self.fonts.metrics;
        self.sprites
            .entry((c, cells))
            .or_insert_with(|| sprite::draw(c, &m, cells).map(Rc::new))
            .clone()
    }

    fn deco(&mut self, deco: Deco) -> Rc<Raster> {
        let m = self.fonts.metrics;
        self.decos
            .entry(deco)
            .or_insert_with(|| Rc::new(decoration(deco, &m)))
            .clone()
    }

    fn ramp(&mut self, fg: Rgb, bg: Rgb, alpha: f32) -> Rc<Ramp> {
        let opacity = (alpha * 255.0).round() as u8;
        if self.ramps.len() > 4096 {
            self.ramps.clear();
        }
        self.ramps
            .entry((fg, bg, opacity))
            .or_insert_with(|| {
                let fa = f32::from(opacity) / 255.0;
                let f = lin(fg).map(|c| c * fa);
                let b = lin(bg);
                let alpha: [f32; 256] = std::array::from_fn(|i| corrected(f, b, i as f32 / 255.0));
                let over_bg = std::array::from_fn(|i| {
                    let a = alpha[i];
                    std::array::from_fn(|c| srgb(f[c] * a + b[c] * (1.0 - fa * a)))
                });
                Rc::new(Ramp { alpha, over_bg })
            })
            .clone()
    }

    /// Coverage `mask` blended over `image` in `fg` at `alpha`, placed with its top-left at
    /// (`left`, `top`); `bgs` is each column's background, which the correction is against.
    #[allow(clippy::too_many_arguments)]
    fn blit(
        &mut self,
        image: &mut Image,
        bgs: &[Rgb],
        mask: &Raster,
        left: i32,
        top: i32,
        fg: Rgb,
        alpha: f32,
    ) {
        let (cw, _) = self.cell();
        let f = lin(fg).map(|c| c * alpha);
        let mut ramp_for: Option<(usize, Rc<Ramp>)> = None;
        for my in 0..mask.height as i32 {
            let y = top + my;
            if y < 0 || y >= image.height as i32 {
                continue;
            }
            for mx in 0..mask.width as i32 {
                let x = left + mx;
                if x < 0 || x >= image.width as i32 {
                    continue;
                }
                let coverage = mask.data[(my * mask.width as i32 + mx) as usize];
                if coverage == 0 {
                    continue;
                }
                let column = (x as u32 / cw) as usize;
                let ramp = match &ramp_for {
                    Some((c, ramp)) if *c == column => ramp.clone(),
                    _ => {
                        let ramp = self.ramp(fg, bgs[column], alpha);
                        ramp_for = Some((column, ramp.clone()));
                        ramp
                    }
                };
                let at = ((y as u32 * image.width + x as u32) * 4) as usize;
                let bg = bgs[column];
                if image.rgba[at..at + 3] == [bg.0, bg.1, bg.2] {
                    image.rgba[at..at + 3].copy_from_slice(&ramp.over_bg[coverage as usize]);
                    continue;
                }
                let a = ramp.alpha[coverage as usize];
                for c in 0..3 {
                    let dst = LINEAR[image.rgba[at + c] as usize];
                    image.rgba[at + c] = srgb(f[c] * a + dst * (1.0 - alpha * a));
                }
            }
        }
    }
}

/// A colour glyph, premultiplied, laid over `image` in linear light.
fn blit_color(image: &mut Image, raster: &Raster, left: i32, top: i32) {
    for my in 0..raster.height as i32 {
        let y = top + my;
        if y < 0 || y >= image.height as i32 {
            continue;
        }
        for mx in 0..raster.width as i32 {
            let x = left + mx;
            if x < 0 || x >= image.width as i32 {
                continue;
            }
            let from = ((my * raster.width as i32 + mx) * 4) as usize;
            let a = f32::from(raster.data[from + 3]) / 255.0;
            if a == 0.0 {
                continue;
            }
            let at = ((y as u32 * image.width + x as u32) * 4) as usize;
            for c in 0..3 {
                let straight = (f32::from(raster.data[from + c]) / 255.0 / a).min(1.0);
                let src = linearize(straight) * a;
                let dst = LINEAR[image.rgba[at + c] as usize];
                image.rgba[at + c] = srgb(src + dst * (1.0 - a));
            }
        }
    }
}

/// A line over one cell, as coverage from the cell's top-left, after Ghostty's sprites.
fn decoration(deco: Deco, m: &crate::font::Metrics) -> Raster {
    let (w, h) = (m.cell_width, m.cell_height);
    let thick = m.underline_thickness;
    let mut data = vec![0u8; (w * h) as usize];
    let rect = |data: &mut Vec<u8>, x0: u32, y0: i32, x1: u32, height: u32| {
        for y in y0.max(0) as u32..((y0 + height as i32).max(0) as u32).min(h) {
            for x in x0..x1.min(w) {
                data[(y * w + x) as usize] = 255;
            }
        }
    };
    let low = |extra: u32| m.underline_position.min(h as i32 - extra as i32);
    match deco {
        Deco::Underline(Underline::Single) | Deco::Underline(Underline::None) => {
            rect(&mut data, 0, low(thick), w, thick)
        }
        Deco::Underline(Underline::Double) => {
            let y = low(2 * thick);
            rect(&mut data, 0, y - thick as i32, w, thick);
            rect(&mut data, 0, y + thick as i32, w, thick);
        }
        Deco::Underline(Underline::Dashed) => {
            let dash = w / 3 + 1;
            let y = low(thick);
            let mut i = 0;
            while i < w / dash + 1 {
                rect(&mut data, i * dash, y, i * dash + dash, thick);
                i += 2;
            }
        }
        Deco::Underline(Underline::Dotted) => {
            let (fw, t) = (w as f32, thick as f32);
            let radius = std::f32::consts::FRAC_1_SQRT_2 * t;
            let y = (m.underline_position as f32 + 0.5 * t).min(h as f32 - radius.ceil());
            let count = (fw / (4.0 * radius))
                .ceil()
                .min((fw / (3.0 * radius)).floor())
                .min((fw / (2.0 * radius + 1.0)).floor())
                .max(1.0);
            for i in 0..count as u32 {
                let cx = fw / count * (i as f32 + 0.5);
                for py in 0..h {
                    for px in 0..w {
                        let d =
                            ((px as f32 + 0.5 - cx).powi(2) + (py as f32 + 0.5 - y).powi(2)).sqrt();
                        let a = (radius + 0.5 - d).clamp(0.0, 1.0);
                        let at = (py * w + px) as usize;
                        data[at] = data[at].max((a * 255.0) as u8);
                    }
                }
            }
        }
        Deco::Underline(Underline::Curly) => {
            let fw = w as f32;
            let amplitude = fw / std::f32::consts::PI;
            let line = thick as f32;
            let top = (m.underline_position as f32).min(h as f32 - amplitude - line);
            let bottom = top + amplitude;
            let (r, center) = (0.4, 0.5 * fw);
            let mut path: Vec<Command> = Vec::new();
            path.move_to([0.0, bottom])
                .curve_to(
                    [center * r, bottom],
                    [center - center * r, top],
                    [center, top],
                )
                .curve_to(
                    [center + center * r, top],
                    [fw - center * r, bottom],
                    [fw, bottom],
                );
            let mut mask = Mask::new(&path);
            mask.size(w, h);
            let mut stroke = Stroke::new(line);
            stroke.cap(Cap::Round);
            mask.style(stroke);
            let (coverage, _) = mask.render();
            data = coverage;
        }
        Deco::Overline => rect(&mut data, 0, 0, w, thick),
        Deco::Strikethrough => rect(
            &mut data,
            0,
            m.strikethrough_position,
            w,
            m.strikethrough_thickness,
        ),
    }
    Raster {
        left: 0,
        top: m.baseline,
        width: w,
        height: h,
        color: false,
        data,
    }
}
