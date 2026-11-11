//! Every text and fill the palette pairs reads at WCAG AA: 4.5:1 for text, 3:1 for icons,
//! rings and marks, in light and dark.

use collie_desktop_theme::{Tones, contrast, flat, kit, sidebar, tones};
use rune::Color;
use rune_kit::Kit;

const TEXT: f32 = 4.5;
const MARK: f32 = 3.0;

fn pairs(k: &Kit, t: &Tones, side: &Kit) -> Vec<(String, Color, Color, f32)> {
    let c = &k.c;
    let mut all = Vec::new();
    let mut add = |name: String, fg: Color, bg: Color, min: f32| all.push((name, fg, bg, min));
    let surfaces = [
        ("page", c.page),
        ("bg_deep", c.bg_deep),
        ("bg_base", c.bg_base),
        ("layer_01", c.layer_01),
        ("layer_02", c.layer_02),
        ("layer_03", c.layer_03),
        ("surface_raised_base", c.surface_raised_base),
        ("hovered layer_01", flat(c.hover, c.layer_01)),
        ("pressed bg_base", flat(c.pressed, c.bg_base)),
    ];
    for (name, fill) in surfaces {
        add(format!("text_strong on {name}"), c.text_strong, fill, TEXT);
        add(format!("text_base on {name}"), c.text_base, fill, TEXT);
        add(format!("text_muted on {name}"), c.text_muted, fill, TEXT);
        add(format!("icon_muted on {name}"), c.icon_muted, fill, MARK);
    }
    for (name, fill) in &surfaces[..5] {
        add(format!("text_faint on {name}"), c.text_faint, *fill, TEXT);
    }
    let roles = [
        ("success", c.success),
        ("warning", c.warning),
        ("danger", c.danger),
        ("info", c.info),
        ("brand", t.brand),
        ("ready", t.ready),
    ];
    for (role, s) in roles {
        add(format!("{role}.fg on {role}.bg"), s.fg, s.bg, TEXT);
        add(format!("text_base on {role}.bg"), c.text_base, s.bg, TEXT);
        add(format!("text_muted on {role}.bg"), c.text_muted, s.bg, TEXT);
        for (name, fill) in &surfaces[..5] {
            add(format!("{role}.fg on {name}"), s.fg, *fill, TEXT);
            add(format!("{role}.icon on {name}"), s.icon, *fill, MARK);
        }
        add(format!("{role}.icon on {role}.bg"), s.icon, s.bg, MARK);
    }
    // A card that needs the human, and the board's callouts, are washed in warning.
    for (name, wash) in [("needs-you card", 0.35), ("callout", 0.45)] {
        let fill = flat(k.alpha(c.warning.bg, wash), c.bg_base);
        add(format!("text_strong on {name}"), c.text_strong, fill, TEXT);
        add(format!("text_muted on {name}"), c.text_muted, fill, TEXT);
        add(format!("warning.fg on {name}"), c.warning.fg, fill, TEXT);
    }
    add(
        "text_contrast on bg_contrast".into(),
        c.text_contrast,
        c.bg_contrast,
        TEXT,
    );
    add(
        "text_contrast on bg_accent".into(),
        c.text_contrast,
        c.bg_accent,
        TEXT,
    );
    add(
        "submit_fg on bg_icon_button_contrast".into(),
        c.submit_fg,
        c.bg_icon_button_contrast,
        TEXT,
    );
    add(
        "text_accent on bg_base".into(),
        c.text_accent,
        c.bg_base,
        TEXT,
    );
    add(
        "border_focus on bg_base".into(),
        c.border_focus,
        c.bg_base,
        MARK,
    );
    add(
        "bg_accent on layer_01".into(),
        c.bg_accent,
        c.layer_01,
        MARK,
    );
    let chosen = flat(side.c.pressed, side.c.bg_deep);
    add(
        "the chosen page's name".into(),
        side.c.text_base,
        chosen,
        TEXT,
    );
    add(
        "the chosen page's icon".into(),
        side.c.icon_base,
        chosen,
        MARK,
    );
    add(
        "terminal text on its background".into(),
        c.text_base,
        t.terminal,
        TEXT,
    );
    all
}

#[test]
fn every_text_and_fill_the_palette_pairs_meets_wcag_aa_in_both_appearances() {
    let mut failed = Vec::new();
    let mut checked = 0;
    for dark in [false, true] {
        let mode = if dark { "dark" } else { "light" };
        let k = kit(dark);
        for (name, fg, bg, min) in pairs(k, tones(dark), sidebar(dark)) {
            checked += 1;
            let ratio = contrast(fg, bg);
            if ratio < min {
                failed.push(format!(
                    "{mode}: {name} is {ratio:.2}:1, under {min}:1 ({} on {})",
                    fg.hex(),
                    bg.hex()
                ));
            }
        }
    }
    assert!(checked > 200, "only {checked} pairs");
    assert!(
        failed.is_empty(),
        "{} pairs under AA:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

#[test]
fn contrast_is_wcags_ratio() {
    let hex = |s| rune::color::hex(s).unwrap();
    assert!((contrast(hex("#000000"), hex("#ffffff")) - 21.0).abs() < 0.01);
    assert!((contrast(hex("#767676"), hex("#ffffff")) - 4.54).abs() < 0.01);
    // Half-transparent black over white is the grey a browser paints.
    assert_eq!(flat(hex("#00000080"), hex("#ffffff")).hex(), "#7f7f7fff");
}

#[test]
fn collie_has_a_colour_of_its_own_in_both_appearances() {
    for dark in [false, true] {
        let k = kit(dark);
        let stock = rune_theme_opencode::kit(dark);
        assert_ne!(
            k.c.bg_accent, stock.c.bg_accent,
            "the accent is Collie's, not OpenCode's blue"
        );
        assert_ne!(
            k.c.bg_base, stock.c.bg_base,
            "surfaces are tinted, not flat grey"
        );
        let b = tones(dark).brand.icon;
        assert!(
            b.g > b.r && b.g > b.b,
            "Collie's brand is green: {}",
            b.hex()
        );
    }
}
