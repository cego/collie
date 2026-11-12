//! The terminal's font, as Ghostty sets it up: the faces of one family, the cell they make
//! (Ghostty's `Metrics.calc`), a fallback face for whatever the family lacks, and each glyph
//! shaped and rasterised once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};
use swash::scale::image::Content;
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::shape::ShapeContext;
use swash::zeno::{Format, Transform, Vector};
use swash::{FontRef, GlyphId};

/// Ghostty's own default family, which it embeds: JetBrains Mono, here as its Nerd Font build
/// from Ghostty's sources (OFL-1.1; see THIRD-PARTY-NOTICES).
static BUNDLED: [&[u8]; 4] = [
    include_bytes!("../../vendor/ghostty/src/font/res/JetBrainsMonoNerdFont-Regular.ttf"),
    include_bytes!("../../vendor/ghostty/src/font/res/JetBrainsMonoNerdFont-Bold.ttf"),
    include_bytes!("../../vendor/ghostty/src/font/res/JetBrainsMonoNerdFont-Italic.ttf"),
    include_bytes!("../../vendor/ghostty/src/font/res/JetBrainsMonoNerdFont-BoldItalic.ttf"),
];
pub const BUNDLED_FAMILY: &str = "JetBrains Mono";

/// Regular, bold, italic and bold italic, as a cell's style picks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Style {
    Regular = 0,
    Bold = 1,
    Italic = 2,
    BoldItalic = 3,
}

impl Style {
    pub fn of(bold: bool, italic: bool) -> Style {
        match (bold, italic) {
            (false, false) => Style::Regular,
            (true, false) => Style::Bold,
            (false, true) => Style::Italic,
            (true, true) => Style::BoldItalic,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Face {
    pub font: FontRef<'static>,
    /// Drawn heavier or slanted where the family has no such face, as Ghostty synthesises.
    pub embolden: bool,
    pub slant: bool,
    /// A colour emoji face, whose glyphs keep their own colours.
    pub emoji: bool,
}

impl Face {
    fn new(data: &'static [u8], index: u32) -> Option<Face> {
        let font = FontRef::from_index(data, index as usize)?;
        let emoji = font.table(u32::from_be_bytes(*b"CBDT")).is_some()
            || font.table(u32::from_be_bytes(*b"COLR")).is_some()
            || font.table(u32::from_be_bytes(*b"sbix")).is_some();
        Some(Face {
            font,
            embolden: false,
            slant: false,
            emoji,
        })
    }

    pub fn covers(&self, c: char) -> bool {
        self.font.charmap().map(c) != 0
    }
}

/// Font files, read once and kept for the life of the process.
fn file(path: &Path) -> Option<&'static [u8]> {
    static FILES: OnceLock<Mutex<HashMap<PathBuf, &'static [u8]>>> = OnceLock::new();
    let mut files = FILES.get_or_init(Default::default).lock().unwrap();
    if let Some(data) = files.get(path) {
        return Some(data);
    }
    let data: &'static [u8] = Box::leak(std::fs::read(path).ok()?.into_boxed_slice());
    files.insert(path.to_path_buf(), data);
    Some(data)
}

fn be16(table: &[u8], at: usize) -> Option<i16> {
    Some(i16::from_be_bytes([*table.get(at)?, *table.get(at + 1)?]))
}

fn table<'a>(font: &FontRef<'a>, tag: &[u8; 4]) -> Option<&'a [u8]> {
    font.table(u32::from_be_bytes(*tag))
}

/// A face of an installed family, by fontconfig: (file, index, weight, slant).
#[cfg(not(target_os = "macos"))]
fn installed(family: &str) -> Vec<(PathBuf, u32, f32, f32)> {
    let Ok(out) = std::process::Command::new("fc-list")
        .args([
            "-f",
            "%{file}|%{index}|%{weight}|%{slant}|%{family}\n",
            &format!(":family={family}"),
        ])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('|');
            let file = PathBuf::from(parts.next()?);
            let index = parts.next()?.parse().ok()?;
            // A variable font lists a range of weights; it stands for its regular.
            let weight = parts.next()?.parse().unwrap_or(80.0);
            let slant = parts.next()?.parse().unwrap_or(0.0);
            let families = parts.next()?;
            families
                .split(',')
                .any(|f| f.eq_ignore_ascii_case(family))
                .then_some((file, index, weight, slant))
        })
        .collect()
}

/// A face of an installed family, by its file's name.
#[cfg(target_os = "macos")]
fn installed(family: &str) -> Vec<(PathBuf, u32, f32, f32)> {
    let squash = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase()
    };
    let wanted = squash(family);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs = [
        home.map(|h| h.join("Library/Fonts")),
        Some("/Library/Fonts".into()),
        Some("/System/Library/Fonts".into()),
    ];
    let mut found = Vec::new();
    for dir in dirs.into_iter().flatten() {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let stem = squash(&path.file_stem().unwrap_or_default().to_string_lossy());
            let Some(rest) = stem.strip_prefix(&wanted) else {
                continue;
            };
            let weight = if rest.contains("bold") { 200.0 } else { 80.0 };
            let slant = if rest.contains("italic") || rest.contains("oblique") {
                100.0
            } else {
                0.0
            };
            if ["regular", "bold", "italic", "bolditalic", ""].contains(&rest)
                || rest.trim_end_matches("italic").is_empty()
            {
                found.push((path, 0, weight, slant));
            }
        }
    }
    found
}

/// The four faces of `family`, or none when it is not installed. A style the family lacks is
/// synthesised from the nearest face it has.
fn family_faces(family: &str) -> Option<[Face; 4]> {
    let faces = installed(family);
    let pick = |weight: f32, italic: bool| {
        faces
            .iter()
            .filter(|f| (f.3 > 0.0) == italic)
            .min_by(|a, b| {
                (a.2 - weight)
                    .abs()
                    .partial_cmp(&(b.2 - weight).abs())
                    .unwrap()
            })
            .and_then(|(path, index, ..)| Face::new(file(path)?, *index))
    };
    let regular = pick(80.0, false)?;
    let bold = pick(200.0, false).filter(|_| faces.iter().any(|f| f.3 == 0.0 && f.2 >= 180.0));
    let italic = pick(80.0, true);
    let bold_italic = pick(200.0, true).filter(|_| faces.iter().any(|f| f.3 > 0.0 && f.2 >= 180.0));
    Some(complete(regular, bold, italic, bold_italic))
}

fn complete(
    regular: Face,
    bold: Option<Face>,
    italic: Option<Face>,
    bold_italic: Option<Face>,
) -> [Face; 4] {
    let synth_bold = Face {
        embolden: true,
        ..regular
    };
    let synth_italic = Face {
        slant: true,
        ..regular
    };
    let bold_italic = bold_italic.unwrap_or(match (italic, bold) {
        (Some(italic), _) => Face {
            embolden: true,
            ..italic
        },
        (None, Some(bold)) => Face {
            slant: true,
            ..bold
        },
        (None, None) => Face {
            embolden: true,
            slant: true,
            ..regular
        },
    });
    [
        regular,
        bold.unwrap_or(synth_bold),
        italic.unwrap_or(synth_italic),
        bold_italic,
    ]
}

fn bundled() -> [Face; 4] {
    BUNDLED.map(|data| Face::new(data, 0).expect("the bundled face"))
}

/// The faces of the first of `families` installed, else the bundled family's, with the name
/// of the family they are.
pub fn faces(families: &[String]) -> ([Face; 4], String) {
    for family in families {
        if family == BUNDLED_FAMILY {
            break;
        }
        if let Some(faces) = family_faces(family) {
            return (faces, family.clone());
        }
    }
    (bundled(), BUNDLED_FAMILY.to_string())
}

/// A face that draws `c`, from the system's fonts, asked once for each character.
fn system_fallback(c: char, emoji: bool) -> Option<(PathBuf, u32)> {
    type Asked = HashMap<(char, bool), Option<(PathBuf, u32)>>;
    static ASKED: OnceLock<Mutex<Asked>> = OnceLock::new();
    let mut asked = ASKED.get_or_init(Default::default).lock().unwrap();
    if let Some(found) = asked.get(&(c, emoji)) {
        return found.clone();
    }
    let found = ask_system(c, emoji);
    asked.insert((c, emoji), found.clone());
    found
}

#[cfg(not(target_os = "macos"))]
fn ask_system(c: char, emoji: bool) -> Option<(PathBuf, u32)> {
    let pattern = format!(
        "{}:charset={:x}",
        if emoji { "emoji" } else { "monospace" },
        u32::from(c)
    );
    let out = std::process::Command::new("fc-match")
        .args(["-f", "%{file}|%{index}", &pattern])
        .output()
        .ok()?;
    let out = String::from_utf8_lossy(&out.stdout);
    let (path, index) = out.split_once('|')?;
    Some((PathBuf::from(path), index.trim().parse().unwrap_or(0)))
}

#[cfg(target_os = "macos")]
fn ask_system(_: char, emoji: bool) -> Option<(PathBuf, u32)> {
    let path = if emoji {
        "/System/Library/Fonts/Apple Color Emoji.ttc"
    } else {
        "/System/Library/Fonts/Menlo.ttc"
    };
    Some((PathBuf::from(path), 0))
}

/// Candidates to try for a character no face yet loaded draws, before asking the system.
#[cfg(target_os = "macos")]
const KNOWN: &[&str] = &[
    "/System/Library/Fonts/Apple Color Emoji.ttc",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
];
#[cfg(not(target_os = "macos"))]
const KNOWN: &[&str] = &[];

/// Whether `text` shows as a colour emoji: an emoji by default, or one asked for with VS16.
pub fn is_emoji(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let rest: Vec<char> = chars.collect();
    if rest.contains(&'\u{fe0e}') {
        return false;
    }
    if rest.contains(&'\u{fe0f}') || rest.iter().any(|c| ('\u{1f3fb}'..='\u{1f3ff}').contains(c)) {
        return true;
    }
    let c = u32::from(first);
    matches!(c,
        0x1f000..=0x1faff | 0x231a..=0x231b | 0x23e9..=0x23ec | 0x23f0 | 0x23f3 | 0x25fd..=0x25fe
        | 0x2614..=0x2615 | 0x2648..=0x2653 | 0x267f | 0x2693 | 0x26a1 | 0x26aa..=0x26ab
        | 0x26bd..=0x26be | 0x26c4..=0x26c5 | 0x26ce | 0x26d4 | 0x26ea | 0x26f2..=0x26f3
        | 0x26f5 | 0x26fa | 0x26fd | 0x2705 | 0x270a..=0x270b | 0x2728 | 0x274c | 0x274e
        | 0x2753..=0x2755 | 0x2757 | 0x2795..=0x2797 | 0x27b0 | 0x27bf | 0x2b1b..=0x2b1c
        | 0x2b50 | 0x2b55)
        && !(0x1f100..=0x1f1e5).contains(&c)
}

/// A cell's measures in device pixels, as Ghostty's `Metrics.calc` derives them from the face.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    pub cell_width: u32,
    pub cell_height: u32,
    /// From the top of the cell.
    pub baseline: i32,
    /// The top of each line, from the top of the cell.
    pub underline_position: i32,
    pub underline_thickness: u32,
    pub strikethrough_position: i32,
    pub strikethrough_thickness: u32,
    pub box_thickness: u32,
    /// The face's height before rounding, for sizing what falls back from it.
    pub face_height: f32,
    pub ascent: f32,
}

impl Metrics {
    pub fn of(face: &Face, px: f32) -> Metrics {
        let font = &face.font;
        let head = table(font, b"head");
        let units = head
            .and_then(|t| be16(t, 18))
            .map_or(1000.0, |u| u as u16 as f32);
        let per_unit = px / units;
        let hhea = table(font, b"hhea");
        let os2 = table(font, b"OS/2");
        let read = |t: Option<&[u8]>, at: usize| t.and_then(|t| be16(t, at)).map(f32::from);
        let (h_asc, h_desc, h_gap) = (read(hhea, 4), read(hhea, 6), read(hhea, 8));
        let (t_asc, t_desc, t_gap) = (read(os2, 68), read(os2, 70), read(os2, 72));
        let use_typo = os2
            .and_then(|t| be16(t, 62))
            .is_some_and(|s| s as u16 & (1 << 7) != 0);
        let (ascent, descent, gap) = match (use_typo, t_asc, h_asc) {
            (true, Some(a), _) => (a, t_desc.unwrap_or(0.0), t_gap.unwrap_or(0.0)),
            (_, _, Some(a)) if a != 0.0 || h_desc.unwrap_or(0.0) != 0.0 => {
                (a, h_desc.unwrap_or(0.0), h_gap.unwrap_or(0.0))
            }
            (_, Some(a), _) => (a, t_desc.unwrap_or(0.0), t_gap.unwrap_or(0.0)),
            _ => (units * 0.8, -units * 0.2, 0.0),
        };
        let (ascent, descent, gap) = (ascent * per_unit, descent * per_unit, gap * per_unit);
        let glyphs = font.glyph_metrics(&[]).scale(px);
        let charmap = font.charmap();
        let width = (32u8..127)
            .map(|c| glyphs.advance_width(charmap.map(c as char)).round())
            .fold(0.0f32, f32::max);
        let width = if width > 0.0 { width } else { px * 0.6 };
        let face_height = ascent - descent + gap;
        let cell_width = width.round().max(1.0);
        let cell_height = face_height.round().max(1.0);
        let face_baseline = gap / 2.0 - descent;
        let cell_baseline = (face_baseline - (cell_height - face_height) / 2.0).round();
        let top_to_baseline = cell_height - cell_baseline;
        let cap = read(os2, 88)
            .filter(|c| *c > 0.0)
            .map_or(0.75 * ascent, |c| c * per_unit);
        let ex = read(os2, 86)
            .filter(|c| *c > 0.0)
            .map_or(0.75 * cap, |x| x * per_unit);
        let post = table(font, b"post");
        let underline_thickness = read(post, 10)
            .filter(|t| *t > 0.0)
            .map_or(0.15 * ex, |t| t * per_unit);
        let underline_position = read(post, 8).map_or(-underline_thickness, |p| p * per_unit);
        let strike_thickness = read(os2, 26)
            .filter(|t| *t > 0.0)
            .map_or(underline_thickness, |t| t * per_unit);
        let strike_position = read(os2, 28).map_or((ex + strike_thickness) * 0.5, |p| p * per_unit);
        let underline_thickness = underline_thickness.ceil().max(1.0) as u32;
        Metrics {
            cell_width: cell_width as u32,
            cell_height: cell_height as u32,
            baseline: top_to_baseline as i32,
            underline_position: (top_to_baseline - underline_position).round() as i32,
            underline_thickness,
            strikethrough_position: (top_to_baseline - strike_position).round() as i32,
            strikethrough_thickness: strike_thickness.ceil().max(1.0) as u32,
            box_thickness: underline_thickness,
            face_height,
            ascent,
        }
    }
}

/// What Ghostty sizes a fallback face by, in ems of the face.
#[derive(Clone, Copy, Debug)]
struct Measures {
    /// The advance of 水, when the face has a sound one.
    ic_width: Option<f32>,
    ex_height: Option<f32>,
    cap_height: Option<f32>,
    ascii_height: Option<f32>,
    line_height: f32,
    cell_width: f32,
}

impl Measures {
    fn of(face: &Face, scale: &mut ScaleContext) -> Measures {
        let font = face.font;
        let units = table(&font, b"head")
            .and_then(|t| be16(t, 18))
            .map_or(1000.0, |u| u as u16 as f32);
        let mut scaler = scale.builder(font).size(units).hint(false).build();
        let advances = font.glyph_metrics(&[]).scale(units);
        let charmap = font.charmap();
        let (mut widest, mut top, mut bottom) = (0.0f32, 0.0f32, 0.0f32);
        for c in 32u8..127 {
            let glyph = charmap.map(c as char);
            if glyph == 0 {
                continue;
            }
            widest = widest.max(advances.advance_width(glyph));
            if let Some(outline) = scaler.scale_outline(glyph) {
                let bounds = outline.bounds();
                top = top.max(bounds.max.y);
                bottom = bottom.min(bounds.min.y);
            }
        }
        let mut height_of = |c: char| {
            let glyph = charmap.map(c);
            (glyph != 0)
                .then(|| scaler.scale_outline(glyph))
                .flatten()
                .map(|o| o.bounds().height())
        };
        let os2 = table(&font, b"OS/2").filter(|t| be16(t, 0).is_some_and(|v| v >= 2));
        let (cap_height, ex_height) = match os2 {
            Some(t) => (be16(t, 88).map(f32::from), be16(t, 86).map(f32::from)),
            None => (height_of('H'), height_of('x')),
        };
        let water = charmap.map('水');
        let ic_width = (water != 0)
            .then(|| {
                let advance = advances.advance_width(water);
                let width = scaler.scale_outline(water)?.bounds().width();
                (width <= advance).then_some(advance)
            })
            .flatten();
        let m = Metrics::of(face, units);
        Measures {
            ic_width: ic_width.map(|v| v / units),
            ex_height: ex_height.filter(|v| *v > 0.0).map(|v| v / units),
            cap_height: cap_height.filter(|v| *v > 0.0).map(|v| v / units),
            ascii_height: (top - bottom > 0.0).then(|| (top - bottom) / units),
            line_height: m.face_height / units,
            cell_width: widest / units,
        }
    }

    fn cap(&self) -> f32 {
        self.cap_height.unwrap_or(0.75 * self.line_height)
    }

    fn ex(&self) -> f32 {
        self.ex_height.unwrap_or(0.75 * self.cap())
    }

    fn ic(&self) -> f32 {
        self.ic_width.unwrap_or_else(|| {
            let ascii = self.ascii_height.unwrap_or(1.5 * self.cap());
            ascii.min(2.0 * self.cell_width)
        })
    }

    /// How much larger `self` is drawn than its size to match `primary`, as Ghostty's
    /// fallback `size_adjustment` (`ic_width`, else ex, cap and line height) has it.
    fn scale_to(&self, primary: &Measures) -> f32 {
        let (theirs, ours) = if self.ic_width.is_some() {
            (self.ic(), primary.ic())
        } else if self.ex_height.is_some() {
            (self.ex(), primary.ex())
        } else if self.cap_height.is_some() {
            (self.cap(), primary.cap())
        } else {
            (self.line_height, primary.line_height)
        };
        if theirs > 0.0 { ours / theirs } else { 1.0 }
    }
}

/// A rasterised glyph: coverage, or premultiplied RGBA for a colour one, placed from the pen
/// on the baseline.
pub struct Raster {
    pub left: i32,
    /// Above the baseline.
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub color: bool,
    pub data: Vec<u8>,
}

/// A glyph placed in a row: its face, its id, and where its pen is, in pixels from the row's
/// left; `cells` is how many cells it is given.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub face: usize,
    pub glyph: GlyphId,
    pub x: i32,
    pub y: i32,
    pub cells: u8,
}

/// One size of the terminal's font: its faces, the faces fallen back to, and what has been
/// rasterised.
pub struct Fonts {
    pub px: f32,
    pub family: String,
    pub metrics: Metrics,
    /// The family's four faces, then fallbacks as they are needed.
    faces: Vec<Face>,
    fallback_for: HashMap<(char, bool), Option<usize>>,
    scale: ScaleContext,
    shape: ShapeContext,
    rasters: HashMap<(usize, GlyphId, u8, i32), Option<Rc<Raster>>>,
    primary: Option<Measures>,
    sizes: HashMap<usize, f32>,
}

impl Fonts {
    /// The terminal's font at `points` (Ghostty's points) on a display of `scale`.
    pub fn new(families: &[String], points: f32, scale: f32) -> Fonts {
        let dpi = if cfg!(target_os = "macos") {
            72.0
        } else {
            96.0
        };
        let px = points * dpi / 72.0 * scale;
        let (faces, family) = faces(families);
        let metrics = Metrics::of(&faces[0], px);
        Fonts {
            px,
            family,
            metrics,
            faces: faces.to_vec(),
            fallback_for: HashMap::new(),
            scale: ScaleContext::new(),
            shape: ShapeContext::new(),
            rasters: HashMap::new(),
            primary: None,
            sizes: HashMap::new(),
        }
    }

    /// The pixel size face `index` is drawn at: a fallback's matched to the family's.
    fn px_of(&mut self, index: usize) -> f32 {
        if index < 4 || self.faces[index].emoji {
            return self.px;
        }
        if let Some(px) = self.sizes.get(&index) {
            return *px;
        }
        let primary = *self
            .primary
            .get_or_insert_with(|| Measures::of(&self.faces[0], &mut self.scale));
        let theirs = Measures::of(&self.faces[index], &mut self.scale);
        let px = self.px * theirs.scale_to(&primary);
        self.sizes.insert(index, px);
        px
    }

    pub fn face(&self, index: usize) -> &Face {
        &self.faces[index]
    }

    /// The face that draws `text` in `style`: the family's own, else a fallback.
    pub fn face_for(&mut self, text: &str, style: Style) -> usize {
        let Some(c) = text.chars().next() else {
            return style as usize;
        };
        let emoji = is_emoji(text);
        if !emoji && self.faces[style as usize].covers(c) {
            return style as usize;
        }
        if !emoji && self.faces[0].covers(c) {
            return 0;
        }
        if let Some(found) = self.fallback_for.get(&(c, emoji)) {
            return found.unwrap_or(style as usize);
        }
        let found = self.find_fallback(c, emoji);
        self.fallback_for.insert((c, emoji), found);
        found.unwrap_or(style as usize)
    }

    fn find_fallback(&mut self, c: char, emoji: bool) -> Option<usize> {
        let loaded = (4..self.faces.len())
            .filter(|i| self.faces[*i].emoji == emoji)
            .chain(4..self.faces.len())
            .find(|i| self.faces[*i].covers(c));
        if loaded.is_some() {
            return loaded;
        }
        let known = KNOWN.iter().map(|p| (PathBuf::from(p), 0));
        for (path, index) in known.chain(system_fallback(c, emoji)) {
            let Some(face) = file(&path).and_then(|data| Face::new(data, index)) else {
                continue;
            };
            if face.covers(c) && (face.emoji == emoji || !emoji) {
                self.faces.push(face);
                return Some(self.faces.len() - 1);
            }
        }
        if emoji {
            return self.find_fallback(c, false);
        }
        None
    }

    /// Shapes `cells` (each a cell's text and how many cells wide it is) in face `face`, as
    /// one run starting `at` pixels from the row's left. Ligatures stay in the cells they
    /// came from.
    pub fn shape(&mut self, face: usize, cells: &[(&str, u8)], at: i32) -> Vec<Placed> {
        let font = self.faces[face].font;
        let cw = self.metrics.cell_width as i32;
        let mut text = String::new();
        let mut starts = Vec::with_capacity(cells.len());
        let mut x = at;
        let mut lefts = Vec::with_capacity(cells.len());
        for (cell, wide) in cells {
            starts.push(text.len());
            lefts.push((x, *wide));
            text.push_str(cell);
            x += cw * i32::from(*wide);
        }
        let mut placed = Vec::new();
        let mut shaper = self
            .shape
            .builder(font)
            .size(self.px)
            .features(&[("liga", 1), ("calt", 1)])
            .build();
        shaper.add_str(&text);
        shaper.shape_with(|cluster| {
            let start = cluster.source.start as usize;
            let i = starts.partition_point(|s| *s <= start).saturating_sub(1);
            let (left, wide) = lefts[i];
            let mut pen = 0.0f32;
            for glyph in cluster.glyphs {
                placed.push(Placed {
                    face,
                    glyph: glyph.id,
                    x: left + (pen + glyph.x).round() as i32,
                    y: -glyph.y.round() as i32,
                    cells: wide,
                });
                pen += glyph.advance;
            }
        });
        placed
    }

    /// The glyph rasterised, fitted to `cells` cells where it is a fallback's or an emoji.
    pub fn raster(&mut self, face: usize, glyph: GlyphId, cells: u8) -> Option<Rc<Raster>> {
        let key = (face, glyph, cells, 0);
        if let Some(raster) = self.rasters.get(&key) {
            return raster.clone();
        }
        let raster = self.rasterise(face, glyph, cells).map(Rc::new);
        self.rasters.insert(key, raster.clone());
        raster
    }

    fn rasterise(&mut self, index: usize, glyph: GlyphId, cells: u8) -> Option<Raster> {
        let face = self.faces[index];
        let m = self.metrics;
        let fallback = index >= 4;
        let px = self.px_of(index);
        let mut scaler = self
            .scale
            .builder(face.font)
            .size(px)
            .hint(!face.emoji)
            .build();
        let sources = [
            Source::ColorOutline(0),
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::Outline,
        ];
        let mut render = Render::new(&sources);
        render.format(Format::Alpha).offset(Vector::new(0.0, 0.0));
        if face.embolden {
            render.embolden((px / 32.0).max(0.5));
        }
        if face.slant {
            render.transform(Some(Transform::skew(
                swash::zeno::Angle::from_degrees(12.0),
                swash::zeno::Angle::from_degrees(0.0),
            )));
        }
        let mut image = render.render(&mut scaler, glyph)?;
        let color = matches!(image.content, Content::Color);
        if color && matches!(image.source, Source::ColorBitmap(_)) {
            // A bitmap comes straight from its PNG; an outline's layers are premultiplied.
            for px in image.data.chunks_mut(4) {
                let a = u16::from(px[3]);
                for c in &mut px[..3] {
                    *c = ((u16::from(*c) * a + 127) / 255) as u8;
                }
            }
        }
        let p = image.placement;
        if p.width == 0 || p.height == 0 {
            return None;
        }
        let mut raster = Raster {
            left: p.left,
            top: p.top,
            width: p.width,
            height: p.height,
            color,
            data: match image.content {
                Content::SubpixelMask => image.data.chunks(4).map(|p| p[1]).collect(),
                _ => image.data,
            },
        };
        let span = m.cell_width * u32::from(cells);
        if color || (fallback && raster.width > span) {
            raster = fit(raster, span, m.cell_height, m.baseline);
        }
        Some(raster)
    }
}

/// `raster` scaled down to fit a box of `width` by `height`, centred in it, as Ghostty fits
/// an emoji or a too-wide fallback glyph to its cells.
fn fit(raster: Raster, width: u32, height: u32, baseline: i32) -> Raster {
    let k = (width as f32 / raster.width as f32)
        .min(height as f32 / raster.height as f32)
        .min(1.0);
    let (w, h) = (
        ((raster.width as f32 * k).round() as u32).max(1),
        ((raster.height as f32 * k).round() as u32).max(1),
    );
    let channels = if raster.color { 4 } else { 1 };
    let mut data = vec![0u8; (w * h) as usize * channels];
    // A box filter over the source pixels each target pixel covers.
    for ty in 0..h {
        let y0 = (ty as f32 / k) as u32;
        let y1 = (((ty + 1) as f32 / k).ceil() as u32).clamp(y0 + 1, raster.height);
        for tx in 0..w {
            let x0 = (tx as f32 / k) as u32;
            let x1 = (((tx + 1) as f32 / k).ceil() as u32).clamp(x0 + 1, raster.width);
            let mut sum = [0u32; 4];
            let mut n = 0;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let at = (sy * raster.width + sx) as usize * channels;
                    for (total, v) in sum.iter_mut().zip(&raster.data[at..at + channels]) {
                        *total += u32::from(*v);
                    }
                    n += 1;
                }
            }
            let at = (ty * w + tx) as usize * channels;
            for c in 0..channels {
                data[at + c] = (sum[c] / n.max(1)) as u8;
            }
        }
    }
    let (left, top) = if k < 1.0 || raster.color {
        (
            ((width - w) / 2) as i32,
            baseline - ((height - h) / 2) as i32,
        )
    } else {
        (raster.left, raster.top)
    };
    Raster {
        left,
        top,
        width: w,
        height: h,
        color: raster.color,
        data,
    }
}
