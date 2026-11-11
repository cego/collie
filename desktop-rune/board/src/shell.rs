//! The window's frame: the sidebar that picks a page, the page under its toolbar, and the
//! Flock chat as the trailing pane.

mod usage;

pub use usage::{UsageEntry, usage_due, usage_entries};

use crate::board::model::{Section, section_of};
use crate::calls::CallError;
use crate::pages::usage::Level;
use crate::{App, board_pane, chat_pane_in, icons, pages};
use rune::{Cx, El, Icon, Tx, row, text};
use rune_kit::shell::{PaneState, Sidebar, SidebarRow, SplitView, Toolbar};
use rune_kit::{IconButton, Kit};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Board,
    Workflows,
    Machines,
    Schedules,
    Usage,
    Settings,
}

impl Page {
    pub const ALL: [Page; 6] = [
        Page::Board,
        Page::Workflows,
        Page::Machines,
        Page::Schedules,
        Page::Usage,
        Page::Settings,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Page::Board => "Board",
            Page::Workflows => "Workflows",
            Page::Machines => "Machines",
            Page::Schedules => "Schedules",
            Page::Usage => "Usage",
            Page::Settings => "Settings",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Page::Board => "nav-board",
            Page::Workflows => "nav-workflows",
            Page::Machines => "nav-machines",
            Page::Schedules => "nav-schedules",
            Page::Usage => "nav-usage",
            Page::Settings => "nav-settings",
        }
    }

    fn icon(self) -> &'static Icon {
        match self {
            Page::Board => &icons::BOARD,
            Page::Workflows => &icons::WORKFLOWS,
            Page::Machines => &icons::MACHINES,
            Page::Schedules => &icons::SCHEDULES,
            Page::Usage => &icons::USAGE,
            Page::Settings => &icons::SETTINGS,
        }
    }
}

pub struct Nav {
    pub page: Page,
    pub sidebar: PaneState,
    /// The Flock chat's pane, closed until asked for.
    pub chat: PaneState,
    /// The chat's width as settings hold it, once they have been read.
    pub chat_saved: Option<f32>,
    /// When each Machine was last asked for its Usage (epoch ms).
    pub usage_asked: Option<f64>,
    /// The Machines live when Usage was last asked for.
    pub usage_asked_of: Vec<String>,
    /// Brings the chat's own window to the front while the chat is popped out of this one.
    pub chat_window: Option<Box<dyn Fn()>>,
}

impl Default for Nav {
    fn default() -> Self {
        Nav {
            page: Page::Board,
            sidebar: PaneState::new(224.0).range(168.0, 360.0),
            chat: PaneState::new(440.0).range(320.0, 820.0).collapsed(),
            chat_saved: None,
            usage_asked: None,
            usage_asked_of: Vec::new(),
            chat_window: None,
        }
    }
}

impl App {
    /// Shows `page`; the Board shows the board itself, leaving any open Run.
    pub fn open_page(&mut self, page: Page) {
        if page == Page::Board {
            self.back();
        }
        self.nav.page = page;
        match page {
            Page::Board => {}
            Page::Workflows => pages::workflows::Workflows::opened(self),
            Page::Machines => pages::machines::Machines::opened(self),
            Page::Schedules => pages::schedules::Schedules::opened(self),
            Page::Usage => pages::usage::Usage::opened(self),
            Page::Settings => pages::settings::Settings::opened(self),
        }
    }

    /// Shows or hides the chat beside the board; while it is in its own window, brings that
    /// window forward instead.
    pub fn toggle_chat(&mut self) {
        if self.chat.popped {
            if let Some(front) = &self.nav.chat_window {
                front();
            }
            return;
        }
        self.nav.chat.toggle();
    }

    /// Takes the chat's saved width once settings are read, then saves each width a drag
    /// leaves it at.
    pub fn keep_chat_width(&mut self) {
        let Some(settings) = &self.chat.settings else {
            return;
        };
        let Some(saved) = self.nav.chat_saved else {
            if let Some(width) = settings.chat_width {
                self.nav.chat.set_width(width as f32);
            }
            self.nav.chat_saved = Some(self.nav.chat.width());
            return;
        };
        let width = self.nav.chat.width();
        if self.nav.chat.is_resizing() || width == saved {
            return;
        }
        self.nav.chat_saved = Some(width);
        if let Some(core) = &self.core {
            core.request(
                "setSettings",
                json!({ "chatWidth": width }),
                |_: &mut App, _: Result<Value, CallError>| {},
            );
        }
    }
}

fn nav_row(app: &App, page: Page, k: &Kit) -> El {
    let mut row = SidebarRow::new(page.title())
        .icon(page.icon())
        .selected(app.nav.page == page);
    // The Board row counts what needs the human, as the board's first section does.
    if page == Page::Board {
        let needs = app
            .placed()
            .iter()
            .filter(|p| section_of(p.task) == Section::NeedsYou)
            .count();
        if needs > 0 {
            row = row.badge(needs.to_string());
        }
    }
    row.on_select(move |app: &mut App, _: &mut Tx| app.open_page(page))
        .build(k)
        .key(page.key())
}

fn page_pane(app: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    match app.nav.page {
        Page::Board => board_pane(app, k, layer),
        Page::Workflows => pages::workflows::view(app, k, layer),
        Page::Machines => pages::machines::view(app, k, layer),
        Page::Schedules => pages::schedules::view(app, k, layer),
        Page::Usage => pages::usage::view(app, k, layer),
        Page::Settings => pages::settings::view(app, k, layer),
    }
}

/// Each account's busiest window, in its level's tone; pressing it opens the Usage page.
fn usage_button(app: &App, k: &Kit) -> El {
    let entries = app.usage_entries();
    let mut words = row().gap(6.0).center_y().a11y_hidden();
    if entries.is_empty() {
        words = words.child(text("Usage").font(k.ty.ui).color(k.c.text_muted));
    }
    for (at, entry) in entries.iter().enumerate() {
        if at > 0 {
            words = words.child(text("·").font(k.ty.ui).color(k.c.text_faint));
        }
        let (font, color) = match entry.level {
            Level::Ok => (k.ty.ui, k.c.text_muted),
            Level::Warn => (k.ty.ui_medium, k.c.warning.fg),
            Level::Out => (k.ty.ui_medium, k.c.danger.fg),
        };
        words = words.child(
            text(entry.text.clone())
                .key(format!("toolbar-usage-{}", entry.key))
                .font(font)
                .color(color),
        );
    }
    let said: Vec<String> = entries.iter().map(|e| e.text.clone()).collect();
    let titles: Vec<String> = entries
        .iter()
        .map(|e| format!("{}: {}", e.text, e.title))
        .collect();
    let shown = app.nav.page == Page::Usage;
    let mut button = row()
        .key("usage")
        .role("button")
        .label(if said.is_empty() {
            "Usage".to_string()
        } else {
            format!("Usage: {}", said.join(", "))
        })
        .checked(shown)
        .focusable(true)
        .h(28.0)
        .px(10.0)
        .radius(6.0)
        .center_y()
        .hover(k.c.hover)
        .on_press(move |app: &mut App| app.open_page(if shown { Page::Board } else { Page::Usage }))
        .child(words);
    if shown {
        button = button.fill(k.c.pressed);
    }
    if !titles.is_empty() {
        button = button.help(titles.join("\n"));
    }
    button
}

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    let k = rune_theme_opencode::kit(cx.system_dark());
    let mut layer = Vec::new();
    let rows = Page::ALL[..Page::ALL.len() - 1]
        .iter()
        .map(|page| nav_row(app, *page, k));
    let mut sidebar = Sidebar::new().label("Pages").row_gap(1.0);
    for row in rows {
        sidebar = sidebar.child(row);
    }
    let sidebar = sidebar.footer(nav_row(app, Page::Settings, k)).build(k);
    let chat_toggle = IconButton::new(&icons::CHAT)
        .label(if app.chat.popped {
            "Show the chat's window"
        } else if app.nav.chat.is_open() {
            "Hide the chat"
        } else {
            "Show the chat"
        })
        .on_press(|app: &mut App| app.toggle_chat())
        .build(k)
        .key("open-chat");
    if let Some(tab) = &app.terminal {
        tab.set_scale(cx.env().scale);
    }
    let main = page_pane(app, k, &mut layer);
    let split = SplitView::new(main)
        .sidebar(
            &app.nav.sidebar,
            |app: &mut App| &mut app.nav.sidebar,
            sidebar,
        )
        .inspector(
            &app.nav.chat,
            |app: &mut App| &mut app.nav.chat,
            chat_pane_in(app, k, &mut layer),
        )
        .toolbar(
            Toolbar::new()
                .title(app.nav.page.title())
                .trailing(usage_button(app, k))
                .trailing(chat_toggle),
        )
        .titlebar_inset(cx.titlebar_inset())
        .reduced_motion(cx.is_reduced_motion())
        .build(k);
    crate::standing::view(app, k, &mut layer);
    rune_kit::root(split, layer).on_window_focus(|app: &mut App, focused: bool, _: &mut Tx| {
        if let Some(tab) = &mut app.terminal {
            tab.focus(focused);
        }
    })
}
