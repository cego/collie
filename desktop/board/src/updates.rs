//! Desktop's own update as the whole app hears it: one `updates` stream from the start, a
//! notice above every page once a verified update is ready, and Restart now or Later.

use crate::App;
use crate::calls::{CallError, Stop};
use collie_desktop_protocol::generated::{News, UpdatesSuccess};
use rune::{El, col, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::Value;

#[derive(Default)]
pub struct Updates {
    /// Desktop's version and what its latest check found, once `updates` has said.
    pub heard: Option<UpdatesSuccess>,
    /// Why `updates` could not be heard; what was heard before is kept.
    pub trouble: Option<String>,
    /// A check the human asked for is running.
    pub checking: bool,
    /// Restart was pressed and the core has not refused it.
    pub restarting: bool,
    /// Why the latest restart did not happen.
    pub refused: Option<String>,
    /// The ready version the human put off with Later.
    pub later: Option<String>,
    stop: Option<Stop>,
}

impl Updates {
    /// The version downloaded, verified and waiting on a restart.
    pub fn ready(&self) -> Option<&str> {
        match &self.heard.as_ref()?.news {
            News::Ready(ready) => Some(&ready.version),
            _ => None,
        }
    }

    /// Whether the notice stands above the page: a ready update not put off, or a restart
    /// pressed or refused, which is never hidden.
    pub fn notice_shown(&self) -> bool {
        self.ready().is_some_and(|ready| {
            self.later.as_deref() != Some(ready) || self.restarting || self.refused.is_some()
        })
    }
}

impl App {
    /// Hears Desktop's update news for as long as the app runs; once, whoever asks.
    pub fn listen_updates(&mut self) {
        let Some(core) = &self.core else { return };
        if self.updates.stop.is_some() {
            return;
        }
        self.updates.stop = Some(core.stream(
            "updates",
            (),
            |app: &mut App, said: Result<UpdatesSuccess, CallError>| app.heard_updates(said),
        ));
    }

    fn heard_updates(&mut self, said: Result<UpdatesSuccess, CallError>) {
        match said {
            Ok(said) => {
                self.updates.trouble = None;
                self.took_news(said.news.clone());
                self.updates.heard = Some(said);
            }
            Err(why) => self.updates.trouble = Some(why.0),
        }
    }

    fn took_news(&mut self, news: News) {
        // A refusal is said for the version it was about; a newer ready one starts afresh.
        if self.updates.ready()
            != match &news {
                News::Ready(ready) => Some(ready.version.as_str()),
                _ => None,
            }
        {
            self.updates.refused = None;
        }
        if let Some(heard) = self.updates.heard.as_mut() {
            heard.news = news;
        }
    }

    /// Checks now, or joins the check running; `then` hears what it found.
    pub fn check_for_updates_then(&mut self, then: fn(&mut App, Result<&News, &str>)) {
        let Some(core) = self.core.clone() else {
            return;
        };
        self.updates.checking = true;
        core.request(
            "checkForUpdates",
            (),
            move |app: &mut App, news: Result<News, CallError>| {
                app.updates.checking = false;
                match news {
                    Ok(news) => {
                        app.took_news(news.clone());
                        then(app, Ok(&news));
                    }
                    Err(why) => {
                        app.updates.trouble = Some(why.0.clone());
                        then(app, Err(&why.0));
                    }
                }
            },
        );
    }

    /// Installs the ready update, which quits Desktop and starts the new one; asked once
    /// however often it is pressed, and said where the core would not.
    pub fn restart_to_update(&mut self) {
        let Some(core) = self.core.clone() else {
            return;
        };
        if self.updates.restarting || self.updates.ready().is_none() {
            return;
        }
        self.updates.restarting = true;
        self.updates.refused = None;
        core.request(
            "restart",
            (),
            |app: &mut App, done: Result<Value, CallError>| {
                if let Err(why) = done {
                    app.updates.restarting = false;
                    app.updates.refused = Some(why.0);
                }
            },
        );
    }

    /// Puts the ready update off: the notice goes until a newer one is ready.
    pub fn update_later(&mut self) {
        self.updates.later = self.updates.ready().map(str::to_string);
        self.updates.refused = None;
    }

    /// Brings back the notice of an update put off.
    pub fn show_update(&mut self) {
        self.updates.later = None;
    }
}

/// The notice above the page: which version is ready, and Restart now or Later.
pub fn notice(app: &App, k: &Kit) -> Option<El> {
    let updates = &app.updates;
    if !updates.notice_shown() {
        return None;
    }
    let version = updates.ready()?;
    let title = format!("Collie {version} is ready");
    let said = match (&updates.refused, updates.restarting) {
        (Some(why), _) => format!("Collie did not restart: {why}"),
        (None, true) => "Restarting Collie…".to_string(),
        (None, false) => "Downloaded and verified. Restart Collie to install it.".to_string(),
    };
    let restart = Button::new(if updates.restarting {
        "Restarting…"
    } else {
        "Restart now"
    })
    .variant(ButtonVariant::Contrast)
    .control_size(ControlSize::Small)
    .disabled(updates.restarting)
    .on_press(|app: &mut App| app.restart_to_update())
    .build(k)
    .key("update-restart");
    let later = Button::new("Later")
        .variant(ButtonVariant::Ghost)
        .control_size(ControlSize::Small)
        .disabled(updates.restarting)
        .on_press(|app: &mut App| app.update_later())
        .build(k)
        .key("update-later");
    let (fill, border, words) = if updates.refused.is_some() {
        (k.c.danger.bg, k.c.danger.border, k.c.danger.fg)
    } else {
        (k.c.info.bg, k.c.border_weak, k.c.text_base)
    };
    Some(
        row()
            .key("update-notice")
            .role("status")
            .label(title.clone())
            .description(said.clone())
            .gap(12.0)
            .px(16.0)
            .py(10.0)
            .w_full()
            .center_y()
            .fill(fill)
            .border(1.0, border)
            .child(
                col()
                    .gap(2.0)
                    .grow(1.0)
                    .min_w(0.0)
                    .a11y_hidden()
                    .child(text(title).font(k.ty.ui_medium).color(k.c.text_strong))
                    .child(
                        text(said)
                            .key("update-said")
                            .font(k.ty.text_small)
                            .color(words)
                            .wrap()
                            .w_full(),
                    ),
            )
            .child(later)
            .child(restart),
    )
}

/// The toolbar's word on Desktop's update: a download running, or a ready update put off,
/// which brings its notice back.
pub fn toolbar(app: &App, k: &Kit) -> Option<El> {
    let updates = &app.updates;
    if let Some(ready) = updates.ready() {
        if updates.notice_shown() {
            return None;
        }
        return Some(
            Button::new("Update ready")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(|app: &mut App| app.show_update())
                .build(k)
                .key("update-toolbar")
                .label(format!("Collie {ready} is ready to install")),
        );
    }
    match &updates.heard.as_ref()?.news {
        News::Downloading(next) => Some(
            text(format!("Downloading Collie {}…", next.version))
                .key("update-downloading")
                .role("status")
                .font(k.ty.ui)
                .color(k.c.text_muted),
        ),
        _ => None,
    }
}
