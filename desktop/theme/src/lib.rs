//! Collie's own look: OpenCode's kit (its type, radii, motion and shadows) with Collie's palette,
//! shared by the board, the record and the chat. Paper by day and ink by night: surfaces are warm
//! cream in light and a faintly violet near-black in dark, never flat grey. The accent is iris,
//! kept for what the human acts on or has chosen, and no state borrows it: amber needs you, sky
//! blue is working, orchid is ready and waiting, red failed, green done.

use std::sync::OnceLock;

use rune::color::hex;
use rune::{Color, El, Image, ImageCache, el};
use rune_kit::{Kit, Palette, StateColors};

/// Colours Collie means something by that the kit has no field for.
#[derive(Clone, Copy, Debug)]
pub struct Tones {
    /// Collie's iris: the chosen page, the human's own words, the mark.
    pub brand: StateColors,
    /// Orchid: work that is done and waits on the human to release it.
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
    /// An opaque edge a step stronger than `weak`: a checkbox, a switch's thumb, a menu.
    edge: &'static str,
    scrim: &'static str,
    hover: &'static str,
    pressed: &'static str,
    focus: &'static str,
    /// The solid brand fill of a primary button or a switch that is on, and the ink on it.
    fill: &'static str,
    on_fill: &'static str,
    /// What the pointer over that fill, and a press on it, lay over it: white, so it lightens.
    fill_hover: &'static str,
    fill_pressed: &'static str,
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
    page: "#f4f0e8",
    deep: "#ede8de",
    base: "#fdfbf7",
    layers: ["#f8f5ef", "#f3efe7", "#e9e3d8", "#cfc5b5"],
    raised: "#ffffff",
    text: ["#1a1625", "#231f2e", "#5a5468", "#6b657a"],
    icon: ["#3a3447", "#6b657a", "#a39cae"],
    borders: ["#3d2f1a1a", "#3d2f1a24", "#3d2f1a3d", "#6a5ae0"],
    weak: "#e6e0d4",
    edge: "#d3cbbd",
    scrim: "#1a16254d",
    hover: "#3d2f1a0d",
    pressed: "#3d2f1a17",
    focus: "#6a5ae0",
    fill: "#5647d6",
    on_fill: "#ffffff",
    fill_hover: "#ffffff1f",
    fill_pressed: "#ffffff3d",
    chosen: "#ffffffc7",
    brand: ["#ebe8ff", "#4636c2", "#c4bcf7", "#6a5ae0"],
    ready: ["#fbe8f6", "#a01f7c", "#efb9dd", "#c9369e"],
    success: ["#e0f4e6", "#126b3c", "#a6dcb8", "#1c9550"],
    warning: ["#fff0d1", "#8a4a00", "#f0cd85", "#bd7300"],
    danger: ["#ffe8e3", "#b3261a", "#f5bcb1", "#e0442f"],
    info: ["#e1f1fd", "#0f5f9e", "#abd4f5", "#1784cc"],
};

const DARK: Spec = Spec {
    page: "#131218",
    deep: "#0f0e13",
    base: "#18171e",
    layers: ["#1e1d26", "#25232e", "#2f2d3a", "#454254"],
    raised: "#201f28",
    text: ["#f5f3fa", "#e6e3ee", "#aba6b9", "#8f8a9e"],
    icon: ["#d9d5e3", "#948fa3", "#676277"],
    borders: ["#e0d8ff14", "#e0d8ff1a", "#e0d8ff33", "#9d8cff"],
    weak: "#2a2834",
    edge: "#3d3a4a",
    scrim: "#07060b99",
    hover: "#e0d8ff0f",
    pressed: "#e0d8ff1a",
    focus: "#9d8cff",
    fill: "#6b5ae6",
    on_fill: "#ffffff",
    // Lighter iris still carries white at AA, so only a little.
    fill_hover: "#ffffff0d",
    fill_pressed: "#ffffff1a",
    chosen: "#e0d8ff1c",
    brand: ["#231f45", "#b5a8ff", "#3f3780", "#9d8cff"],
    ready: ["#3a1a33", "#f5a3dc", "#70305f", "#ec7ac8"],
    success: ["#12301f", "#6ddc9c", "#1f5a39", "#45d184"],
    warning: ["#30260f", "#fcc44f", "#6b5119", "#f8b13a"],
    danger: ["#3a1816", "#ff9485", "#74302a", "#ff6b57"],
    info: ["#0f2536", "#7cc8fb", "#1e4c6e", "#45b0f5"],
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
        submit_hover: colour(s.fill_hover),
        contrast_hover: colour(s.fill_hover),
        contrast_pressed: colour(s.fill_pressed),
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
        // What OpenCode's kit left grey or blank: a hovered surface, a disabled control and
        // the "standard" inks its menus, switches and checkboxes draw with.
        surface_hover: over(s.hover),
        surface_disabled: layer_02,
        border_disabled: colour(s.weak),
        std_border: colour(s.edge),
        std_text: muted,
        std_icon: icon_muted,
        std_icon_strong: icon,
        std_icon_invert: on_fill,
        scrim: colour(s.scrim),
        ..k.c
    };
    k.blend_over = Some(base);
    k
}

/// The kit for the sidebar: the chosen page is a lighter slip of the surface, its icon iris.
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

/// The kit a dialog is built with: rune-kit's Dialog fills its panel with `layer_01`, and here
/// that is the raised surface menus and cards stand on.
pub fn dialog(dark: bool) -> &'static Kit {
    static KITS: [[OnceLock<Kit>; 2]; 2] = [const { [const { OnceLock::new() }; 2] }; 2];
    let srgb = rune::theme::blends_srgb();
    KITS[dark as usize][srgb as usize].get_or_init(|| {
        let mut k = kit(dark).clone();
        k.c.layer_01 = k.c.surface_raised;
        k
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

/// The official Collie tile, embedded so installed apps need no source checkout.
/// Decode during app construction, once; drawing only shares its immutable pixels.
pub struct Logo(Image);

impl Default for Logo {
    fn default() -> Self {
        let images = ImageCache::new(std::sync::Arc::new(|| {}));
        let logo =
            images.load(&include_bytes!("../../../assets/brand/logos/collie-tile-256.png")[..]);
        logo.wait().expect("the bundled Collie logo is a valid PNG");
        Self(logo)
    }
}

pub fn mark(logo: &Logo, size: f32) -> El {
    el().size(size, size).a11y_hidden().pixels(logo.0.pixels())
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
