//! The Artefacts page: retained material across the Flock's Runs and Machines, each result
//! opened on its owning Run's record.

use super::common::{heading, muted, page, request_id};
use crate::App;
use crate::shell::Page;
use collie_desktop_protocol::generated::{
    Artefact, ArtefactSearchPayload, ArtefactSeenPayload, FlockArtefacts, FoundArtefact,
    MachineSearched, MachineSearchedState,
};
use rune::{El, TextEdit, Tx, col, row, text};
use rune_kit::{Button, ButtonVariant, Checkbox, ControlSize, Kit, TextInput};

pub struct Found {
    pub found: FoundArtefact,
    /// Kept from an earlier search because its Machine could not be searched this time.
    pub stale: bool,
}

#[derive(Default)]
pub struct Artefacts {
    pub query: TextEdit,
    pub run: TextEdit,
    pub kind: TextEdit,
    pub role: TextEdit,
    pub unseen: bool,
    pub found: Vec<Found>,
    pub machines: Vec<MachineSearched>,
    pub next: Option<String>,
    pub searching: bool,
    pub failed: Option<String>,
    /// The filters the shown results answer.
    shown: Option<ArtefactSearchPayload>,
    asks: u64,
}

impl Artefacts {
    pub fn opened(app: &mut App) {
        app.search_artefacts();
    }

    fn asked(&self) -> ArtefactSearchPayload {
        let given = |edit: &TextEdit| {
            let said = edit.text.trim();
            (!said.is_empty()).then(|| Some(said.to_string()))
        };
        ArtefactSearchPayload {
            query: given(&self.query),
            run: given(&self.run),
            kind: given(&self.kind),
            role: given(&self.role),
            unseen: self.unseen.then_some(Some(true)),
            cursor: None,
            limit: None,
        }
    }
}

fn same(a: &FoundArtefact, b: &FoundArtefact) -> bool {
    a.installation == b.installation && a.item.run == b.item.run && a.item.id == b.item.id
}

/// The Machine `found` came from, when this search could not reach it.
fn away<'a>(machines: &'a [MachineSearched], found: &FoundArtefact) -> Option<&'a MachineSearched> {
    machines.iter().find(|one| {
        one.state != MachineSearchedState::Searched
            && (one.installation.as_deref() == Some(found.installation.as_str())
                || one.machine == found.machine)
    })
}

impl App {
    pub fn search_artefacts(&mut self) {
        let asked = self.pages.artefacts.asked();
        self.ask_artefacts(asked, false);
    }

    pub fn more_artefacts(&mut self) {
        let state = &self.pages.artefacts;
        let (Some(shown), Some(next)) = (&state.shown, &state.next) else {
            return;
        };
        let asked = ArtefactSearchPayload {
            cursor: Some(Some(next.clone())),
            ..shown.clone()
        };
        self.ask_artefacts(asked, true);
    }

    pub fn toggle_unseen_artefacts(&mut self) {
        self.pages.artefacts.unseen = !self.pages.artefacts.unseen;
        self.search_artefacts();
    }

    fn ask_artefacts(&mut self, asked: ArtefactSearchPayload, more: bool) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let state = &mut self.pages.artefacts;
        state.asks += 1;
        state.searching = true;
        let ask = state.asks;
        let filters = ArtefactSearchPayload {
            cursor: None,
            ..asked.clone()
        };
        core.request(
            "artefactSearch",
            asked,
            move |app: &mut App, answer: Result<FlockArtefacts, _>| {
                let state = &mut app.pages.artefacts;
                if state.asks != ask {
                    return;
                }
                state.searching = false;
                let page = match answer {
                    Ok(page) => page,
                    Err(why) => {
                        state.failed = Some(why.to_string());
                        return;
                    }
                };
                state.failed = None;
                let mut found: Vec<Found> = Vec::new();
                if more {
                    found.append(&mut state.found);
                }
                for one in page.items {
                    if !found.iter().any(|kept| same(&kept.found, &one)) {
                        found.push(Found {
                            found: one,
                            stale: false,
                        });
                    }
                }
                if !more && state.shown.as_ref() == Some(&filters) {
                    for kept in state.found.drain(..) {
                        if away(&page.machines, &kept.found).is_some()
                            && !found.iter().any(|one| same(&one.found, &kept.found))
                        {
                            found.push(Found {
                                stale: true,
                                ..kept
                            });
                        }
                    }
                }
                state.found = found;
                state.machines = page.machines;
                state.next = page.next;
                state.shown = Some(filters);
            },
        );
    }

    /// Opens the `index`th result on its owning Run's record, at its artefact; Back returns here.
    pub fn open_found(&mut self, index: usize) {
        let Some(one) = self.pages.artefacts.found.get(index) else {
            return;
        };
        let found = one.found.clone();
        self.board.opened = None;
        self.open_record(
            found.installation,
            found.item.run,
            found.machine,
            Some("artefacts"),
        );
        if let Some(record) = &mut self.record.open {
            record.artefacts.selected = Some((found.item.id, found.item.revision));
        }
        self.nav.page = Page::Board;
        self.nav.returns_to = Some(Page::Artefacts);
    }

    /// Marks the `index`th result seen or unseen on its host; a saved result takes no mark.
    pub fn mark_found(&mut self, index: usize, seen: bool) {
        let Some(one) = self
            .pages
            .artefacts
            .found
            .get(index)
            .filter(|one| !one.stale)
        else {
            return;
        };
        let Some(core) = self.core.clone() else {
            return;
        };
        let found = one.found.clone();
        let ask = self.pages.artefacts.asks;
        core.request(
            "artefactSeen",
            ArtefactSeenPayload {
                installation: found.installation.clone(),
                run_id: found.item.run.clone(),
                id: found.item.id.clone(),
                revision: seen.then_some(found.item.revision),
                request: request_id(),
            },
            move |app: &mut App, answer: Result<Artefact, _>| {
                let state = &mut app.pages.artefacts;
                if state.asks != ask {
                    return;
                }
                match answer {
                    Ok(item) => {
                        if let Some(row) = state
                            .found
                            .iter_mut()
                            .find(|one| !one.stale && same(&one.found, &found))
                        {
                            row.found.item = item;
                        }
                    }
                    Err(why) => state.failed = Some(why.to_string()),
                }
            },
        );
    }
}

fn query_of(app: &mut App) -> &mut TextEdit {
    &mut app.pages.artefacts.query
}
fn run_of(app: &mut App) -> &mut TextEdit {
    &mut app.pages.artefacts.run
}
fn kind_of(app: &mut App) -> &mut TextEdit {
    &mut app.pages.artefacts.kind
}
fn role_of(app: &mut App) -> &mut TextEdit {
    &mut app.pages.artefacts.role
}

fn field(
    k: &Kit,
    edit: &TextEdit,
    label: &str,
    placeholder: &str,
    lens: fn(&mut App) -> &mut TextEdit,
    key: &str,
) -> El {
    TextInput::new(edit)
        .width(None)
        .placeholder(placeholder)
        .label(label)
        .on_edit(lens)
        .on_submit(|app: &mut App, _: &mut Tx| app.search_artefacts())
        .build(k)
        .key(key.to_string())
        .grow(1.0)
        .min_w(0.0)
}

fn status_of(item: &Artefact) -> &'static str {
    match &item.seen {
        Some(seen) if seen.revision == item.revision => "Seen",
        Some(_) => "Updated",
        None => "Unseen",
    }
}

fn result(k: &Kit, index: usize, one: &Found, machines: &[MachineSearched]) -> El {
    let item = &one.found.item;
    let seen = status_of(item) == "Seen";
    let mut said = col()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .gap(2.0)
        .child(
            text(item.title.clone())
                .font(k.ty.body_medium)
                .color(k.c.text_strong),
        )
        .child(muted(k, format!("{} · {}", one.found.machine, item.run)))
        .child(muted(
            k,
            format!("{} · {} · {}", item.kind, item.role, status_of(item)),
        ))
        .child(muted(k, format!("Last observed: {}", item.observed_at)));
    said = said.child(muted(k, item.url.as_ref().unwrap_or(&item.source).clone()));
    if one.stale {
        let why = match away(machines, &one.found).map(|m| &m.state) {
            Some(MachineSearchedState::Unsupported) => "cannot search Artefacts on its build",
            _ => "is unreachable",
        };
        said = said.child(
            text(format!(
                "Saved from an earlier search; {} {why}",
                one.found.machine
            ))
            .font(k.ty.text_small)
            .color(k.c.warning.fg)
            .wrap()
            .w_full(),
        );
    }
    row()
        .key(format!(
            "found-{}-{}-{}",
            one.found.installation, item.run, item.id
        ))
        .w_full()
        .gap(8.0)
        .center_y()
        .child(said)
        .child(
            Button::new("Open")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .on_press(move |app: &mut App| app.open_found(index))
                .build(k)
                .key("found-open"),
        )
        .child(
            Button::new(if seen { "Mark unseen" } else { "Mark seen" })
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .disabled(one.stale)
                .on_press(move |app: &mut App| app.mark_found(index, !seen))
                .build(k)
                .key("found-seen"),
        )
}

fn machine_note(one: &MachineSearched) -> Option<String> {
    match one.state {
        MachineSearchedState::Searched if one.indexed < one.runs => Some(format!(
            "{} has indexed {} of its {} retained Runs so far",
            one.machine, one.indexed, one.runs
        )),
        MachineSearchedState::Searched => None,
        _ => Some(format!(
            "{} was not searched: {}",
            one.machine,
            one.reason.as_deref().unwrap_or("its host did not answer")
        )),
    }
}

pub fn view(app: &App, k: &Kit, _layer: &mut Vec<El>) -> El {
    let state = &app.pages.artefacts;
    let filters = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(field(
            k,
            &state.query,
            "Search names, descriptions, URLs and paths",
            "Name, description, URL or path",
            query_of,
            "artefacts-query",
        ))
        .child(field(
            k,
            &state.run,
            "Run, as its id or machine:run",
            "Run",
            run_of,
            "artefacts-run",
        ));
    let narrow = row()
        .w_full()
        .gap(8.0)
        .center_y()
        .child(field(
            k,
            &state.kind,
            "Kind",
            "Kind",
            kind_of,
            "artefacts-kind",
        ))
        .child(field(
            k,
            &state.role,
            "Role",
            "Role",
            role_of,
            "artefacts-role",
        ))
        .child(
            Checkbox::new(state.unseen)
                .label("Unseen only")
                .on_toggle(App::toggle_unseen_artefacts)
                .build(k)
                .key("artefacts-unseen"),
        )
        .child(
            Button::new("Search")
                .on_press(App::search_artefacts)
                .build(k)
                .key("artefacts-search"),
        );
    let mut children = vec![
        text("Artefacts")
            .role("heading")
            .font(k.ty.body_medium)
            .color(k.c.text_strong),
        filters,
        narrow,
    ];
    if state.searching {
        children.push(muted(k, "Searching each Machine…").role("status"));
    }
    if let Some(why) = &state.failed {
        children.push(muted(k, why.clone()).role("alert"));
    }
    let notes: Vec<El> = state
        .machines
        .iter()
        .filter_map(machine_note)
        .map(|note| muted(k, note).role("status"))
        .collect();
    if !notes.is_empty() {
        children.push(
            col()
                .w_full()
                .gap(4.0)
                .child(heading(k, "Coverage"))
                .children(notes),
        );
    }
    if state.shown.is_some() && state.found.is_empty() {
        children.push(muted(k, "No retained material matches."));
    }
    children.extend(
        state
            .found
            .iter()
            .enumerate()
            .map(|(index, one)| result(k, index, one, &state.machines)),
    );
    if state.next.is_some() {
        children.push(
            Button::new("Load more")
                .disabled(state.searching)
                .on_press(App::more_artefacts)
                .build(k)
                .key("artefacts-more"),
        );
    }
    page("artefacts-page", "Artefacts", children)
}
