//! What the Machines, Workflows, Schedules and Usage pages draw alike: what came of an action,
//! headings, tones, and a request id.

use rune::{Color, El, col, el, row, text};
use rune_kit::{Kit, Toast, ToastRegion};

/// What came of an action, said for a while.
#[derive(Debug, Clone, PartialEq)]
pub struct Said {
    pub text: String,
    pub ok: bool,
    pub shown: crate::toasts::Shown,
}

/// What came of each action a page took, the newest last.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Told {
    pub said: Vec<(u64, Said)>,
    next: u64,
}

impl Told {
    pub fn say(&mut self, text: impl Into<String>, ok: bool) {
        self.next += 1;
        self.said.push((
            self.next,
            Said {
                text: text.into(),
                ok,
                shown: Default::default(),
            },
        ));
        // A long session keeps only the latest few.
        if self.said.len() > 4 {
            self.said.remove(0);
        }
    }

    pub fn close(&mut self, id: u64) {
        self.said.retain(|(at, _)| *at != id);
    }

    /// Takes down what has been said long enough; whether any went.
    pub fn expire(&mut self, now: f64) -> bool {
        let said = self.said.len();
        self.said.retain_mut(|(_, s)| !s.shown.over(now));
        said != self.said.len()
    }

    pub fn hold(&mut self, id: u64, held: bool) {
        if let Some((_, s)) = self.said.iter_mut().find(|(at, _)| *at == id) {
            s.shown.hold(held);
        }
    }

    /// The texts said, oldest first.
    pub fn texts(&self) -> Vec<&str> {
        self.said.iter().map(|(_, s)| s.text.as_str()).collect()
    }
}

/// Draws what `told` says as toasts in the overlay layer, each closed through `lens`.
pub fn toasts<S: 'static>(
    app: &crate::App,
    told: &Told,
    lens: fn(&mut S) -> &mut Told,
    k: &Kit,
    layer: &mut Vec<El>,
) {
    if told.said.is_empty() {
        return;
    }
    let region = told
        .said
        .iter()
        .fold(ToastRegion::new(), |region, (id, said)| {
            let id = *id;
            let dot = el().size(8.0, 8.0).radius(4.0).fill(if said.ok {
                k.c.success.icon
            } else {
                k.c.danger.icon
            });
            region.toast(
                Toast::new(format!("said-{id}"), said.text.clone())
                    .lead(el().size(16.0, 20.0).center().child(dot))
                    .on_close(move |s: &mut S| lens(s).close(id))
                    .build(k)
                    .on_hover_change(move |s: &mut S, inside, _| lens(s).hold(id, inside)),
            )
        });
    layer.push(crate::toasts::beside_chat(app, region.build(k)));
}

/// A fresh request id, so a retried action is the same request to its host.
pub fn request_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut words = [0u64; 2];
    for (i, word) in words.iter_mut().enumerate() {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        h.write_usize(i);
        *word = h.finish();
    }
    let hex = format!("{:016x}{:016x}", words[0], words[1]);
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        ["8", "9", "a", "b"][(words[1] & 3) as usize],
        &hex[17..20],
        &hex[20..32]
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Warn,
    Bad,
    Quiet,
}

pub fn tone_color(k: &Kit, tone: Tone) -> Color {
    match tone {
        Tone::Ok => k.c.success.icon,
        Tone::Warn => k.c.warning.icon,
        Tone::Bad => k.c.danger.icon,
        Tone::Quiet => k.c.icon_faint,
    }
}

/// A state as a coloured dot and its word, read as the word.
pub fn status(k: &Kit, word: &str, tone: Tone) -> El {
    row()
        .role("status")
        .label(word.to_string())
        .gap(6.0)
        .center_y()
        .child(
            el().size(7.0, 7.0)
                .radius(3.5)
                .fill(tone_color(k, tone))
                .a11y_hidden(),
        )
        .child(
            text(word.to_string())
                .font(k.ty.text_small_medium)
                .color(k.c.text_muted)
                .a11y_hidden(),
        )
}

/// A small upper-case label over a section.
pub fn heading(k: &Kit, title: &str) -> El {
    text(title.to_uppercase())
        .role("heading")
        .label(title.to_string())
        .font(k.ty.text_xsmall_medium)
        .color(k.c.text_faint)
}

/// One line of muted text that wraps.
pub fn muted(k: &Kit, said: impl Into<String>) -> El {
    text(said.into())
        .font(k.ty.text_small)
        .color(k.c.text_muted)
        .wrap()
        .w_full()
}

/// One line in a tone's colour that wraps.
pub fn toned(k: &Kit, said: impl Into<String>, tone: Tone) -> El {
    let color = match tone {
        Tone::Ok => k.c.success.fg,
        Tone::Warn => k.c.warning.fg,
        Tone::Bad => k.c.danger.fg,
        Tone::Quiet => k.c.text_muted,
    };
    text(said.into())
        .font(k.ty.text_small)
        .color(color)
        .wrap()
        .w_full()
}

/// Monospace text that wraps anywhere, for paths and commands.
pub fn code(k: &Kit, said: impl Into<String>) -> El {
    text(said.into())
        .font(k.ty.mono)
        .color(k.c.text_base)
        .wrap_anywhere()
        .selectable(true)
        .selection_color(k.selection())
}

/// The page's scrolling column, as wide as reads well.
pub fn page(key: &str, label: &str, children: Vec<El>) -> El {
    let scroller = col()
        .key(key.to_string())
        .label(label.to_string())
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .scroll(rune::ScrollSpec {
            stick_bottom: false,
        })
        .scroll_edge_fade(16.0)
        .child(
            col()
                .w_full()
                .max_w(920.0)
                .padding(20.0)
                .gap(20.0)
                .children(children),
        );
    collie_desktop_chat::glide::smooth::<crate::App>(scroller, key)
}

/// A raised panel that groups one thing's lines.
pub fn panel(k: &Kit, key: impl Into<String>, label: impl Into<String>) -> El {
    col()
        .key(key.into())
        .role("group")
        .label(label.into())
        .w_full()
        .padding(16.0)
        .gap(10.0)
        .radius(k.radius.md)
        .fill(k.c.layer_01)
        .border(1.0, k.c.border_muted)
}
