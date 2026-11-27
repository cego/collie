//! The window's frame: the sidebar that picks a page, the page under its toolbar, and the
//! Flock chat as the trailing pane.

mod files;
pub mod panes;
mod usage;

pub use files::shell_quoted;
pub use usage::{UsageEntry, usage_due, usage_entries};

use crate::board::model::{
    Ordered, ProjectRow, Scope, Section, needs_by_project, project_rows, section_of,
};
use crate::calls::CallError;
use crate::pages::usage::Level;
use crate::{App, board_pane, chat_pane_in, icons, pages};
use collie_desktop_terminal::view::Keyed;
use rune::{Cx, El, Icon, Tx, col, row, text};
use rune_kit::shell::{PaneState, Sidebar, SidebarHeader, SidebarRow, SplitView, Toolbar};
use rune_kit::{Button, ButtonVariant, ControlSize, IconButton, Kit};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Board,
    Workflows,
    Machines,
    Schedules,
    Usage,
    Artefacts,
    Settings,
}

impl Page {
    pub const ALL: [Page; 7] = [
        Page::Board,
        Page::Workflows,
        Page::Machines,
        Page::Schedules,
        Page::Usage,
        Page::Artefacts,
        Page::Settings,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Page::Board => "Board",
            Page::Workflows => "Workflows",
            Page::Machines => "Machines",
            Page::Schedules => "Schedules",
            Page::Usage => "Usage",
            Page::Artefacts => "Artefacts",
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
            Page::Artefacts => "nav-artefacts",
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
            Page::Artefacts => &icons::ARTEFACTS,
            Page::Settings => &icons::SETTINGS,
        }
    }
}

const CHAT_MIN: f32 = 320.0;
const CHAT_MAX: f32 = 820.0;
/// The window the chat leaves to the sidebar and the board: 224 and stable's `boardMin`, 480.
const CHAT_BESIDE: f32 = 224.0 + 480.0;

/// How one scope of the board is left: whether it shows followed Tasks only, and its chat beside
/// the board.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScopeView {
    pub following: bool,
    pub chat: PaneState,
}
impl Default for ScopeView {
    fn default() -> Self {
        ScopeView {
            following: false,
            chat: default_chat(),
        }
    }
}
pub struct Nav {
    pub page: Page,
    /// The Project the board and its chat are scoped to; none is the whole Flock.
    pub scope: Option<Scope>,
    /// Each scope's own view, by `Scope::key`; `""` is the Flock's.
    pub views: Ordered<ScopeView>,
    /// Where each scope's board was scrolled to, recorded as it scrolls.
    pub scroll: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String, f32>>>,
    pub sidebar: PaneState,
    /// The Flock chat's pane, open beside the board until closed or popped out.
    pub chat: PaneState,
    /// The chat's width as settings hold it, once they have been read.
    pub chat_saved: Option<f32>,
    /// When each Machine was last asked for its Usage (epoch ms).
    pub usage_asked: Option<f64>,
    /// The Machines live when Usage was last asked for.
    pub usage_asked_of: Vec<String>,
    /// Brings the chat's own window to the front while the chat is popped out of this one.
    pub chat_window: Option<Box<dyn Fn()>>,
    /// The page Back returns to from a record opened there.
    pub returns_to: Option<Page>,
}

fn default_chat() -> PaneState {
    PaneState::new(440.0).range(CHAT_MIN, CHAT_MAX)
}
impl Default for Nav {
    fn default() -> Self {
        Nav {
            page: Page::Board,
            scope: None,
            views: Ordered::default(),
            scroll: std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashMap::new())),
            sidebar: PaneState::new(224.0).range(168.0, 360.0),
            chat: default_chat(),
            chat_saved: None,
            usage_asked: None,
            usage_asked_of: Vec::new(),
            chat_window: None,
            returns_to: None,
        }
    }
}

impl App {
    /// The key of the scope the board is in: `""` for the whole Flock.
    pub fn view_key(&self) -> String {
        self.nav.scope.as_ref().map(Scope::key).unwrap_or_default()
    }
    fn view_of(&self) -> ScopeView {
        self.nav
            .views
            .get(&self.view_key())
            .copied()
            .unwrap_or_default()
    }
    pub fn following(&self) -> bool {
        self.view_of().following
    }
    /// Follows Tasks only, or every Task of the scope again.
    pub fn toggle_following(&mut self) {
        let key = self.view_key();
        let mut view = self.view_of();
        view.following = !view.following;
        view.chat = self.nav.chat;
        self.nav.views.set(&key, view);
    }
    /// Scopes the board and its chat to `scope`, keeping what the one left had and restoring
    /// what the one entered had: its Following, its chat, and where its board was scrolled.
    pub fn open_scope(&mut self, scope: Option<Scope>, tx: &mut Tx) {
        let leaving = self.view_key();
        let mut left = self.view_of();
        left.chat = self.nav.chat;
        self.nav.views.set(&leaving, left);
        self.nav.scope = scope;
        self.nav.page = Page::Board;
        self.nav.returns_to = None;
        let entering = self.view_of();
        self.nav.chat = entering.chat;
        let scroll = self
            .nav
            .scroll
            .borrow()
            .get(&self.view_key())
            .copied()
            .unwrap_or(0.0);
        tx.scroll_to_y("board-scroll", scroll);
    }
    /// This computer's Machine: the one no route names a target for.
    pub fn local_installation(&self) -> Option<&str> {
        self.machines
            .iter()
            .find(|shown| shown.machine.target.is_none())
            .map(|shown| shown.machine.installation.as_str())
    }
    pub fn scoped_project(&self) -> Option<(&str, &collie_desktop_protocol::generated::Project)> {
        let scope = self.nav.scope.as_ref()?;
        self.machines.iter().find_map(|shown| {
            if shown.machine.installation != scope.installation {
                return None;
            }
            shown
                .projects
                .iter()
                .find(|project| project.id == scope.id)
                .map(|project| (scope.installation.as_str(), project))
        })
    }
    pub fn title(&self) -> String {
        match (self.nav.page, self.scoped_project()) {
            (Page::Board, Some((_, project))) => project.name.clone(),
            (page, _) => page.title().to_string(),
        }
    }
    /// Shows `page`; the Board shows the board itself, leaving any open Run.
    pub fn open_page(&mut self, page: Page) {
        if page == Page::Board {
            self.back();
        }
        self.nav.returns_to = None;
        self.nav.page = page;
        match page {
            Page::Board => {}
            Page::Workflows => pages::workflows::Workflows::opened(self),
            Page::Machines => pages::machines::Machines::opened(self),
            Page::Schedules => pages::schedules::Schedules::opened(self),
            Page::Usage => pages::usage::Usage::opened(self),
            Page::Artefacts => pages::artefacts::Artefacts::opened(self),
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

    /// Keeps the chat to what a `window` points wide leaves the board, as `chatWidthMax` in
    /// `desktop/src/shared/chat-width.ts` does; the width the human chose comes back as it widens.
    pub fn fit_chat(&mut self, window: f32) {
        let max = (window - CHAT_BESIDE).clamp(CHAT_MIN, CHAT_MAX);
        if max == self.nav.chat.max_width() || self.nav.chat.is_resizing() {
            return;
        }
        self.nav.chat = self.nav.chat.range(CHAT_MIN, max);
        if let Some(chosen) = self.nav.chat_saved {
            self.nav.chat.set_width(chosen);
        }
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
            let chosen = settings.chat_width.map(|w| w as f32);
            self.nav.chat_saved = Some(chosen.unwrap_or(self.nav.chat.width()));
            return;
        };
        let width = self.nav.chat.width();
        let drawn = saved
            .round()
            .clamp(self.nav.chat.min_width(), self.nav.chat.max_width());
        // A width the window narrowed is drawn, not chosen.
        if self.nav.chat.is_resizing() || width == saved || width == drawn {
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

fn project_row(
    app: &App,
    row: &ProjectRow<'_>,
    needs: &std::collections::HashMap<Scope, usize>,
    k: &Kit,
) -> El {
    let scope = row.scope();
    let needs = needs.get(&scope).copied().unwrap_or(0);
    let mut built = SidebarRow::new(row.project.name.clone())
        .depth(1)
        .selected(app.nav.scope.as_ref() == Some(&scope));
    if needs > 0 {
        built = built.badge(needs.to_string());
    }
    // WARNING: a Machine is only worth naming where the Flock has more than one.
    if app.machines.len() > 1
        && let Some(machine) = machine_of(app, row.installation)
    {
        built = built.detail(machine.to_string());
    }
    built
        .on_select(move |app: &mut App, tx: &mut Tx| app.open_scope(Some(scope.clone()), tx))
        .build(k)
        .key(row.key())
}
fn machine_of<'a>(app: &'a App, installation: &str) -> Option<&'a str> {
    app.machines
        .iter()
        .find(|shown| shown.machine.installation == installation)
        .map(|shown| shown.machine.name.as_str())
}
/// What the board's toolbar offers of the scope it is in: Following everywhere, and the Project's
/// own star and archive where one is selected.
fn project_controls(app: &App, k: &Kit) -> Vec<El> {
    let mut controls = vec![
        Button::new("Following")
            .variant(if app.following() {
                ButtonVariant::Contrast
            } else {
                ButtonVariant::Ghost
            })
            .control_size(ControlSize::Small)
            .expanded(app.following())
            .help("Show only the Tasks you follow, in this scope")
            .on_press(|app: &mut App| app.toggle_following())
            .build(k)
            .key("following"),
    ];
    controls.push(
        Button::new("New Project")
            .icon(&icons::PLUS)
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .disabled(app.local_installation().is_none())
            .help("Create a Project on this computer")
            .on_press(|app: &mut App| app.new_project())
            .build(k)
            .key("new-project"),
    );
    let Some((installation, project)) = app.scoped_project() else {
        return controls;
    };
    let (installation, project) = (installation.to_string(), project.id.clone());
    let owner = installation.clone();
    let starred = app
        .scoped_project()
        .is_some_and(|(_, project)| project.starred);
    let archived = app
        .scoped_project()
        .is_some_and(|(_, project)| project.archived);
    controls.push(
        Button::new(if starred { "Unstar" } else { "Star" })
            .icon(&icons::STAR)
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .expanded(starred)
            .help("Move this Project to the top of the Projects list")
            .on_press({
                let project = project.clone();
                move |app: &mut App| {
                    app.change_project(
                        owner.clone(),
                        project.clone(),
                        if starred { "unstar" } else { "star" },
                    )
                }
            })
            .build(k)
            .key("star-project"),
    );
    controls.push(
        Button::new(if archived { "Restore" } else { "Archive" })
            .icon(&icons::ARCHIVE)
            .variant(ButtonVariant::Ghost)
            .control_size(ControlSize::Small)
            .help("Put this Project away; its work stays on the global Board")
            .on_press({
                let installation = installation.clone();
                let project = project.clone();
                move |app: &mut App| {
                    app.change_project(
                        installation.clone(),
                        project.clone(),
                        if archived { "restore" } else { "archive" },
                    )
                }
            })
            .build(k)
            .key("archive-project"),
    );
    controls
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
    row.on_select(move |app: &mut App, tx: &mut Tx| {
        // WARNING: the Board is the whole Flock, so choosing it leaves whatever Project was open.
        if page == Page::Board {
            app.open_scope(None, tx);
            return;
        }
        app.open_page(page);
    })
    .build(k)
    .key(page.key())
}

/// Collie's mark and name over the pages.
fn signature(app: &App, k: &Kit) -> El {
    row()
        .key("signature")
        .a11y_hidden()
        .gap(8.0)
        .center_y()
        .px(8.0)
        .pb(6.0)
        .child(collie_desktop_theme::mark(&app.chat.logo, 24.0))
        .child(text("collie").font(k.ty.body_medium).color(k.c.text_strong))
}

fn page_pane(app: &App, k: &Kit, layer: &mut Vec<El>) -> El {
    match app.nav.page {
        Page::Board => board_pane(app, k, layer),
        Page::Workflows => pages::workflows::view(app, k, layer),
        Page::Machines => pages::machines::view(app, k, layer),
        Page::Schedules => pages::schedules::view(app, k, layer),
        Page::Usage => pages::usage::view(app, k, layer),
        Page::Artefacts => pages::artefacts::view(app, k, layer),
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
    let k = collie_desktop_theme::kit(cx.system_dark());
    let side = collie_desktop_theme::sidebar(cx.system_dark());
    let mut layer = Vec::new();
    let rows = Page::ALL[..Page::ALL.len() - 1]
        .iter()
        .map(|page| nav_row(app, *page, side));
    let mut sidebar = Sidebar::new()
        .label("Pages")
        .row_gap(1.0)
        .header(signature(app, k));
    for row in rows {
        sidebar = sidebar.child(row);
    }
    // WARNING: the rows are the list's own children, so the arrows reach them: only the heading
    // is grouped, which is what keeps two headings from sharing a sibling key.
    let (live, archived) = project_rows(&app.machines);
    let needs = needs_by_project(&app.machines);
    sidebar = sidebar.child(
        col()
            .key("projects")
            .role("group")
            .label("Projects")
            .w_full()
            .child(SidebarHeader::new("Projects").build(side)),
    );
    for row in &live {
        sidebar = sidebar.child(project_row(app, row, &needs, side));
    }
    if !archived.is_empty() {
        sidebar = sidebar.child(
            col()
                .key("projects-archive")
                .w_full()
                .child(SidebarHeader::new("Archive").build(side)),
        );
        for row in &archived {
            sidebar = sidebar.child(project_row(app, row, &needs, side));
        }
    }
    let sidebar = sidebar
        .footer(nav_row(app, Page::Settings, side))
        .build(side);
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
    let main = match crate::updates::notice(app, k) {
        Some(notice) => col()
            .grow(1.0)
            .min_h(0.0)
            .w_full()
            .child(notice)
            .child(page_pane(app, k, &mut layer)),
        None => page_pane(app, k, &mut layer),
    };
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
        .toolbar({
            let mut toolbar = Toolbar::new().title(app.title());
            if let Some(update) = crate::updates::toolbar(app, k) {
                toolbar = toolbar.trailing(update);
            }
            for control in project_controls(app, side) {
                toolbar = toolbar.trailing(control);
            }
            toolbar.trailing(usage_button(app, k)).trailing(chat_toggle)
        })
        .titlebar_inset(cx.titlebar_inset())
        .reduced_motion(cx.is_reduced_motion())
        .build(k);
    crate::standing::view(app, k, &mut layer);
    rune_kit::root(split, layer)
        .on_layout_tx(|app: &mut App, [_, _, width, _], _| app.fit_chat(width))
        .on_window_focus(|app: &mut App, focused: bool, _: &mut Tx| {
            if let Some(tab) = &mut app.terminal {
                tab.focus(focused);
            }
        })
        .on_paste_content(
            |app: &mut App, pasted: &rune::ClipboardContent, _: &mut Tx| {
                app.paste_into_pane(pasted)
            },
        )
        .on_drop_files(|app: &mut App, files: &[std::path::PathBuf], _: &mut Tx| {
            app.drop_on_pane(files.to_vec())
        })
}

/// The window's own keys (`AppSpec::on_key`), which Rune offers first while nothing has
/// focus: a key typed then goes to the pane the record shows, as stable Desktop's pane takes
/// the keys once Go to pane opens it. Tab still moves focus into the app, and nothing is
/// typed into a pane under a dialog.
pub fn on_key(app: &mut App, key: &rune::KeyEvent, tx: &mut Tx) -> bool {
    let over = app.board.dialog.is_some()
        || app.board.menu.is_some()
        || app.standing.open
        || app.pages.machines.job.is_some();
    key.key != rune::Key::Tab && !over && app.type_into_pane(key, tx)
}

impl App {
    /// A key typed into the shown pane, as its grid takes one. Ctrl+V reads the clipboard
    /// first, so files on it are given to the pane rather than left to the pane's program.
    fn type_into_pane(&mut self, key: &rune::KeyEvent, tx: &mut Tx) -> bool {
        // A Step's pane on Flow takes keys only once it is focused, as the grid's own.
        if self.record_tab() != "terminal" {
            return false;
        }
        let Some(tab) = self.shown_pane() else {
            return false;
        };
        if files::is_ctrl_v(key) {
            let key = key.clone();
            tx.read_clipboard(move |app: &mut App, held, _| app.ctrl_v_into_pane(&key, held));
            return true;
        }
        match tab.key(key) {
            Keyed::Passed => false,
            Keyed::Taken => true,
            Keyed::Copy(text) => {
                tx.copy(text);
                true
            }
            Keyed::Paste => {
                tx.request_paste();
                true
            }
        }
    }
}
