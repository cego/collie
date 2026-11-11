//! The window's frame: the sidebar that picks a page, the page under its toolbar, and the
//! Flock chat as the trailing pane.

use crate::calls::CallError;
use crate::{App, board_pane, chat_pane_in, icons, pages};
use rune::{Cx, El, Icon, Tx};
use rune_kit::shell::{PaneState, Sidebar, SidebarRow, SidebarSection, SplitView, Toolbar};
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
}

impl Default for Nav {
    fn default() -> Self {
        Nav {
            page: Page::Board,
            sidebar: PaneState::new(224.0).range(168.0, 360.0),
            chat: PaneState::new(440.0).range(320.0, 820.0).collapsed(),
            chat_saved: None,
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

    pub fn toggle_chat(&mut self) {
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
    SidebarRow::new(page.title())
        .icon(page.icon())
        .selected(app.nav.page == page)
        .on_select(move |app: &mut App, _: &mut Tx| app.open_page(page))
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

pub fn view(app: &App, cx: &mut Cx<App>) -> El {
    let k = rune_theme_opencode::kit(cx.system_dark());
    let mut layer = Vec::new();
    let rows = Page::ALL[..Page::ALL.len() - 1]
        .iter()
        .map(|page| nav_row(app, *page, k));
    let sidebar = Sidebar::new()
        .label("Collie")
        .section(SidebarSection::new("Collie").key("nav").rows(rows))
        .footer(nav_row(app, Page::Settings, k))
        .build(k);
    let chat_toggle = IconButton::new(&icons::CHAT)
        .label(if app.nav.chat.is_open() {
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
