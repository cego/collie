//! Collie's own look: OpenCode's kit (its type, radii, motion and shadows) with Collie's palette,
//! shared by the board, the record and the chat. Surfaces carry a faint meadow-green tint, the
//! accent is Collie green, and each state has a hue of its own: amber needs you, sky blue is
//! working, violet is ready and waiting, coral failed, green done.

use std::sync::OnceLock;

use rune::color::hex;
use rune::{Color, El, Icon, el, icon};
use rune_kit::{Kit, Palette, StateColors};

/// Colours Collie means something by that the kit has no field for.
#[derive(Clone, Copy, Debug)]
pub struct Tones {
    /// Collie green: the chosen page, the human's own words, the mark.
    pub brand: StateColors,
    /// Violet: work that is done and waits on the human to release it.
    pub ready: StateColors,
    /// The terminal's background, so a pane sits in the record like the page around it.
    pub terminal: Color,
}

/// One appearance's colours, as `#rrggbb` (or `#rrggbbaa` for an overlay).
struct Spec {
    page: &'static str,
    deep: &'static str,
    base: &'static str,
    layers: [&'static str; 4],
    raised: &'static str,
    text: [&'static str; 4],
    icon: [&'static str; 3],
    borders: [&'static str; 4],
    weak: &'static str,
    hover: &'static str,
    pressed: &'static str,
    focus: &'static str,
    /// The solid brand fill of a primary button or a switch that is on, and the ink on it.
    fill: &'static str,
    on_fill: &'static str,
    chosen: &'static str,
    /// bg, fg, border, icon.
    brand: [&'static str; 4],
    ready: [&'static str; 4],
    success: [&'static str; 4],
    warning: [&'static str; 4],
    danger: [&'static str; 4],
    info: [&'static str; 4],
}

const LIGHT: Spec = Spec {
    page: "#f4f8f6",
    deep: "#edf3f0",
    base: "#fbfdfc",
    layers: ["#f3f7f5", "#e8f0ec", "#dde7e2", "#c3d3cb"],
    raised: "#eef4f1",
    text: ["#0d1a14", "#14221c", "#43554d", "#566960"],
    icon: ["#2c3d35", "#5b6e65", "#93a59c"],
    borders: ["#1e50371a", "#1e50371f", "#1e503738", "#1e9a64"],
    weak: "#d6e2dc",
    hover: "#1e64410d",
    pressed: "#1e644117",
    focus: "#1e9a64",
    fill: "#0b7a52",
    on_fill: "#ffffff",
    chosen: "#1e9a6424",
    brand: ["#dcf3e7", "#06704a", "#9fdcbf", "#0b8c58"],
    ready: ["#efe9ff", "#5b34c4", "#cdbdfa", "#8a5cf6"],
    success: ["#dcf3e7", "#06704a", "#9fdcbf", "#0b8c58"],
    warning: ["#fff1d4", "#8f4c00", "#f1cf86", "#bb7000"],
    danger: ["#ffe9e5", "#b42318", "#f6bdb3", "#e5483a"],
    info: ["#e5f0ff", "#1a5ac4", "#b2d0fa", "#2f80ed"],
};

const DARK: Spec = Spec {
    page: "#0e1513",
    deep: "#0b110f",
    base: "#111916",
    layers: ["#17211d", "#1d2924", "#26342e", "#3a4b43"],
    raised: "#1a2420",
    text: ["#f1f7f4", "#e1eae6", "#a6b6ae", "#8a9b93"],
    icon: ["#d5e1db", "#8fa199", "#62756c"],
    borders: ["#c8f0dc14", "#c8f0dc1a", "#c8f0dc33", "#4fdc9c"],
    weak: "#22302a",
    hover: "#c8ffe10f",
    pressed: "#c8ffe11a",
    focus: "#4fdc9c",
    fill: "#3ccf8e",
    on_fill: "#04170f",
    chosen: "#3ccf8e26",
    brand: ["#123326", "#62e0a8", "#1f5c42", "#3ddc97"],
    ready: ["#251d3f", "#c7adff", "#4a3a7c", "#a685ff"],
    success: ["#123326", "#62e0a8", "#1f5c42", "#3ddc97"],
    warning: ["#30260f", "#fcc44f", "#6b5119", "#f8b13a"],
    danger: ["#3a171a", "#ff8f80", "#74302c", "#ff6a5c"],
    info: ["#0f2338", "#80c4ff", "#1f4a73", "#4fa9ff"],
};

#[track_caller]
fn colour(s: &str) -> Color {
    hex(s).unwrap_or_else(|| panic!("{s} is not a colour"))
}

fn state([bg, fg, border, icon]: [&str; 4]) -> StateColors {
    StateColors {
        bg: colour(bg),
        fg: colour(fg),
        border: colour(border),
        icon: colour(icon),
    }
}

fn spec(dark: bool) -> &'static Spec {
    if dark { &DARK } else { &LIGHT }
}

/// Collie's kit for one appearance, resolved for the blend mode of the window building the view,
/// as `rune_theme_opencode::kit` is. Get it in the view rather than keeping it.
pub fn kit(dark: bool) -> &'static Kit {
    static KITS: [[OnceLock<Kit>; 2]; 2] = [const { [const { OnceLock::new() }; 2] }; 2];
    let srgb = rune::theme::blends_srgb();
    KITS[dark as usize][srgb as usize].get_or_init(|| rune::theme::with_blend(srgb, || build(dark)))
}

fn build(dark: bool) -> Kit {
    let s = spec(dark);
    let mut k = rune_theme_opencode::kit(dark).clone();
    let base = colour(s.base);
    // Overlays are authored for sRGB blending, as OpenCode's are.
    let over = |x: &str| rune::theme::for_blend(colour(x), base);
    let [strong, text, muted, faint] = s.text.map(colour);
    let [icon, icon_muted, icon_faint] = s.icon.map(colour);
    let [layer_01, layer_02, layer_03, layer_04] = s.layers.map(colour);
    let (fill, on_fill) = (colour(s.fill), colour(s.on_fill));
    let brand = state(s.brand);
    k.c = Palette {
        page: colour(s.page),
        bg_base: base,
        bg_deep: colour(s.deep),
        layer_01,
        layer_02,
        layer_03,
        layer_04,
        bg_contrast: fill,
        bg_icon_button_contrast: fill,
        bg_accent: fill,
        submit_fg: on_fill,
        submit_icon: on_fill,
        text_base: text,
        text_muted: muted,
        text_faint: faint,
        text_contrast: on_fill,
        text_accent: brand.fg,
        icon_base: icon,
        icon_muted,
        icon_faint,
        icon_contrast: on_fill,
        icon_accent: brand.icon,
        border_muted: over(s.borders[0]),
        border_base: over(s.borders[1]),
        border_strong: over(s.borders[2]),
        border_focus: colour(s.focus),
        hover: over(s.hover),
        pressed: over(s.pressed),
        success: state(s.success),
        warning: state(s.warning),
        danger: state(s.danger),
        info: state(s.info),
        surface_base: layer_01,
        surface_weak: layer_02,
        surface_raised: colour(s.raised),
        surface_raised_base: colour(s.raised),
        surface_raised_hover: layer_02,
        surface_float: colour(s.raised),
        border_weak: colour(s.weak),
        border_hover: over(s.borders[2]),
        border_active: colour(s.borders[3]),
        text_strong: strong,
        text_weak: muted,
        icon_weaker: icon_faint,
        ..k.c
    };
    k.blend_over = Some(base);
    k
}

/// The kit for the sidebar: the chosen page is washed in Collie green, its icon green.
pub fn sidebar(dark: bool) -> &'static Kit {
    static KITS: [[OnceLock<Kit>; 2]; 2] = [const { [const { OnceLock::new() }; 2] }; 2];
    let srgb = rune::theme::blends_srgb();
    KITS[dark as usize][srgb as usize].get_or_init(|| {
        rune::theme::with_blend(srgb, || {
            let mut k = kit(dark).clone();
            k.c.pressed = rune::theme::for_blend(colour(spec(dark).chosen), k.c.bg_deep);
            k.c.icon_base = tones(dark).brand.icon;
            k
        })
    })
}

pub fn tones(dark: bool) -> &'static Tones {
    static TONES: [OnceLock<Tones>; 2] = [const { OnceLock::new() }; 2];
    TONES[dark as usize].get_or_init(|| {
        let s = spec(dark);
        Tones {
            brand: state(s.brand),
            ready: state(s.ready),
            terminal: colour(s.base),
        }
    })
}

/// Collie's mark: a collie's head, floppy ears and the white blaze from brow to nose, in one colour.
pub static MARK: Icon = Icon {
    name: "collie-mark",
    view: 24.0,
    body: r#"<path fill="currentColor" d="M6.4 6C4 5.4 1.6 6.8 1.4 9.8C1.2 12.6 2.2 15.6 3.6 16.2C4.4 16.6 4.9 15.9 4.6 14.8C4.1 13 3.9 10.8 4.3 9.2C4.7 7.6 5.5 6.6 6.4 6ZM17.6 6C20 5.4 22.4 6.8 22.6 9.8C22.8 12.6 21.8 15.6 20.4 16.2C19.6 16.6 19.1 15.9 19.4 14.8C19.9 13 20.1 10.8 19.7 9.2C19.3 7.6 18.5 6.6 17.6 6Z"/><path fill="currentColor" fill-rule="evenodd" d="M12 5C16 5 19 7.6 19 11.6C19 16.2 15.8 19.6 12 19.6C8.2 19.6 5 16.2 5 11.6C5 7.6 8 5 12 5ZM12 5.6C11.5 5.6 11.2 6.1 11.1 6.8L10.8 11.8C9.3 12.3 8.4 13.8 8.4 15.4C8.4 17.4 10 18.9 12 18.9C14 18.9 15.6 17.4 15.6 15.4C15.6 13.8 14.7 12.3 13.2 11.8L12.9 6.8C12.8 6.1 12.5 5.6 12 5.6ZM9.65 10.8C9.65 11.38 9.18 11.85 8.6 11.85C8.02 11.85 7.55 11.38 7.55 10.8C7.55 10.22 8.02 9.75 8.6 9.75C9.18 9.75 9.65 10.22 9.65 10.8ZM16.45 10.8C16.45 11.38 15.98 11.85 15.4 11.85C14.82 11.85 14.35 11.38 14.35 10.8C14.35 10.22 14.82 9.75 15.4 9.75C15.98 9.75 16.45 10.22 16.45 10.8Z"/><path fill="currentColor" d="M12 13.2C13.1 13.2 13.8 13.7 13.8 14.4C13.8 15.2 12.9 15.8 12 15.8C11.1 15.8 10.2 15.2 10.2 14.4C10.2 13.7 10.9 13.2 12 13.2Z"/>"#,
};

/// Collie's mark on a green tile `size` points square, for the sidebar and empty states.
pub fn mark(k: &Kit, size: f32) -> El {
    let brand = tones(k.dark).brand;
    el().size(size, size)
        .radius(size * 0.3)
        .fill(brand.bg)
        .border(1.0, brand.border)
        .center()
        .a11y_hidden()
        .child(icon(&MARK, size * 0.75).color(brand.fg))
}

/// `top` painted over `under` as a browser blends it, in sRGB.
pub fn flat(top: Color, under: Color) -> Color {
    use rune::color::{srgb_decode as dec, srgb_encode as enc};
    let a = top.a;
    let mix = |t: f32, u: f32| dec(enc(t) * a + enc(u) * (1.0 - a));
    Color {
        r: mix(top.r, under.r),
        g: mix(top.g, under.g),
        b: mix(top.b, under.b),
        a: 1.0,
    }
}

/// WCAG's contrast ratio between `fg` and `bg`, with `fg` painted over `bg`.
pub fn contrast(fg: Color, bg: Color) -> f32 {
    let (a, b) = (flat(fg, bg).luminance(), bg.luminance());
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}
