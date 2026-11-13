use super::{
    Record, act,
    view::{markdown, mono, quiet},
};
use crate::App;
use base64::Engine;
use collie_desktop_protocol::generated::{
    Artefact, ArtefactCollection, ArtefactImportPayload, ArtefactReadPayload,
    ArtefactRegisterPayload, ArtefactRegistered, ArtefactSeenPayload, ArtefactsPayload, RunFile,
    Tracking,
};
use rune::edit::TextEdit;
use rune::{El, SurfaceFit, Tx, col, row, text};
use rune_kit::{Button, Kit, TextInput};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const LIMIT: usize = 100 * 1024 * 1024;
const TEXT_LIMIT: usize = 256 * 1024;

#[derive(Default)]
pub struct Collection {
    pub items: Option<Vec<Artefact>>,
    pub loading: bool,
    pub dirty: bool,
    pub failed: Option<String>,
    pub selected: Option<(String, i64)>,
    pub generation: u64,
    pub preview: Option<Preview>,
    pub bytes: Option<Arc<Vec<u8>>>,
    pub attempted: AtomicBool,
    /// A path on the Run's own Machine to register.
    pub path: TextEdit,
}

pub enum Preview {
    Loading,
    Image(rune::Image),
    Text {
        text: String,
        markdown: bool,
        truncated: bool,
    },
    Unsupported,
    Failed(String),
    Video(crate::video::Player),
}

#[derive(Clone, PartialEq, Eq)]
struct Selection {
    installation: String,
    run: String,
    serial: u64,
    generation: u64,
    id: String,
    revision: i64,
}

impl Selection {
    fn current(&self, app: &App) -> bool {
        app.record_tab() == "artefacts"
            && app.record.open.as_ref().is_some_and(|r| {
                r.serial == self.serial
                    && r.installation == self.installation
                    && r.run == self.run
                    && r.artefacts.generation == self.generation
                    && r.artefacts.selected.as_ref() == Some(&(self.id.clone(), self.revision))
            })
    }
}

fn selection(record: &Record) -> Option<Selection> {
    let (id, revision) = record.artefacts.selected.clone()?;
    Some(Selection {
        installation: record.installation.clone(),
        run: record.run.clone(),
        serial: record.serial,
        generation: record.artefacts.generation,
        id,
        revision,
    })
}

pub fn selected(record: &Record) -> Option<&Artefact> {
    let (id, revision) = record.artefacts.selected.as_ref()?;
    record
        .artefacts
        .items
        .as_ref()?
        .iter()
        .find(|item| &item.id == id && &item.revision == revision)
}

fn prepare(item: &Artefact, bytes: &[u8]) -> Result<Preview, String> {
    if matches!(
        item.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        let cache = rune::ImageCache::new(Arc::new(|| {}));
        let image = cache.load(bytes.to_vec());
        image
            .wait()
            .map_err(|e| format!("This image could not be decoded: {e}"))?;
        return Ok(Preview::Image(image));
    }
    let md = item.media_type == "text/markdown" || item.title.to_ascii_lowercase().ends_with(".md");
    if md
        || item.media_type.starts_with("text/")
        || matches!(
            item.media_type.as_str(),
            "application/json" | "application/xml" | "application/javascript"
        )
    {
        let source = std::str::from_utf8(bytes)
            .map_err(|_| "This file is not valid UTF-8 text; use Open or Save.")?;
        let mut end = source.len().min(TEXT_LIMIT);
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        return Ok(Preview::Text {
            text: source[..end].into(),
            markdown: md,
            truncated: end < source.len(),
        });
    }
    Ok(Preview::Unsupported)
}

impl App {
    pub fn read_artefacts(&mut self, refresh: bool) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let Some(record) = &mut self.record.open else {
            return;
        };
        if record.artefacts.loading {
            return;
        }
        if !refresh && !record.artefacts.dirty && record.artefacts.items.is_some() {
            let again = record
                .artefacts
                .preview
                .is_none()
                .then(|| record.artefacts.selected.clone())
                .flatten();
            if let Some((id, _)) = again {
                self.select_artefact(&id);
            }
            return;
        }
        record.artefacts.loading = true;
        record.artefacts.dirty = false;
        record.artefacts.failed = None;
        let serial = record.serial;
        core.request(
            "artefacts",
            ArtefactsPayload {
                installation: record.installation.clone(),
                run_id: record.run.clone(),
                refresh: Some(Some(refresh)),
            },
            move |app: &mut App, answer: Result<ArtefactCollection, _>| {
                let Some(record) = app.record.open.as_mut().filter(|r| r.serial == serial) else {
                    return;
                };
                record.artefacts.loading = false;
                match answer {
                    Ok(collection) => {
                        let previous = record.artefacts.selected.clone();
                        record.artefacts.items = Some(collection.items);
                        let next = previous.as_ref().and_then(|(id, _)| {
                            record
                                .artefacts
                                .items
                                .as_ref()?
                                .iter()
                                .find(|item| &item.id == id)
                                .map(|item| (item.id.clone(), item.revision))
                        });
                        if next != previous {
                            app.hide_artefact();
                            if let Some((id, _)) = next {
                                app.select_artefact(&id);
                            }
                        } else if app.record_tab() == "artefacts"
                            && app
                                .record
                                .open
                                .as_ref()
                                .is_some_and(|r| r.artefacts.preview.is_none())
                            && let Some((id, _)) = previous
                        {
                            app.select_artefact(&id);
                        }
                    }
                    Err(error) => record.artefacts.failed = Some(error.to_string()),
                }
                if app.record.open.as_ref().is_some_and(|r| r.artefacts.dirty) {
                    app.read_artefacts(false);
                }
            },
        );
    }

    /// A file on this computer, sent to the Run's Machine where that is another.
    pub fn pick_artefact(&mut self, tx: &mut Tx) {
        let Some(record) = &self.record.open else {
            return;
        };
        let serial = record.serial;
        let options = rune::FileDialogOptions {
            title: "Register a file".into(),
            ..Default::default()
        };
        tx.open_file(options, move |app: &mut App, chosen, _| {
            if app.record.open.as_ref().is_none_or(|r| r.serial != serial) {
                return;
            }
            match chosen {
                Ok(Some(path)) => app.register_artefact(false, path.display().to_string()),
                Ok(None) => {}
                Err(why) => {
                    app.record.open.as_mut().unwrap().artefacts.failed =
                        Some(format!("Register failed: {why}"))
                }
            }
        });
    }

    pub fn register_artefact_path(&mut self) {
        let Some(record) = &mut self.record.open else {
            return;
        };
        let path = record.artefacts.path.text.trim().to_string();
        if path.is_empty() {
            return;
        }
        record.artefacts.path = TextEdit::default();
        self.register_artefact(true, path);
    }

    /// `on_machine` names a path on the Run's Machine; otherwise it is on this computer.
    fn register_artefact(&mut self, on_machine: bool, path: String) {
        let (Some(core), Some(record)) = (self.core.clone(), &mut self.record.open) else {
            return;
        };
        record.artefacts.failed = None;
        let serial = record.serial;
        let (installation, run_id, request) =
            (record.installation.clone(), record.run.clone(), act::new_request());
        let done = move |app: &mut App, answer: Result<ArtefactRegistered, _>| {
            let Some(record) = app.record.open.as_mut().filter(|r| r.serial == serial) else {
                return;
            };
            match answer {
                Ok(_) => {
                    record.artefacts.dirty = true;
                    app.read_artefacts(false);
                }
                Err(why) => record.artefacts.failed = Some(format!("Register failed: {why}")),
            }
        };
        if on_machine {
            core.request(
                "artefactRegister",
                ArtefactRegisterPayload {
                    installation,
                    run_id,
                    request,
                    path,
                    id: None,
                    title: None,
                    kind: None,
                    role: None,
                    snapshot: None,
                },
                done,
            )
        } else {
            core.request(
                "artefactImport",
                ArtefactImportPayload {
                    installation,
                    run_id,
                    path,
                    request,
                },
                done,
            )
        }
    }

    pub fn hide_artefact(&mut self) {
        if let Some(record) = &mut self.record.open {
            record.artefacts.generation += 1;
            record.artefacts.preview = None;
            record.artefacts.bytes = None;
            record.artefacts.attempted.store(false, Ordering::Release);
        }
    }

    pub fn select_artefact(&mut self, id: &str) {
        let Some(record) = &self.record.open else {
            return;
        };
        let Some(item) = record
            .artefacts
            .items
            .as_ref()
            .and_then(|items| items.iter().find(|one| one.id == id))
            .cloned()
        else {
            return;
        };
        if record.artefacts.selected.as_ref() == Some(&(id.into(), item.revision))
            && record.artefacts.preview.is_some()
        {
            return;
        }
        self.hide_artefact();
        let Some(record) = &mut self.record.open else {
            return;
        };
        record.artefacts.selected = Some((id.into(), item.revision));
        record.artefacts.preview = Some(Preview::Loading);
        let key = selection(record).unwrap();
        self.read_artefact_part(key, item, Vec::new());
    }

    fn read_artefact_part(&mut self, key: Selection, item: Artefact, bytes: Vec<u8>) {
        let Some(core) = self.core.clone() else {
            return;
        };
        core.request("artefactRead", ArtefactReadPayload { installation: key.installation.clone(), run_id: key.run.clone(), id: key.id.clone(), revision: key.revision, offset: bytes.len() as i64 }, move |app: &mut App, answer: Result<RunFile, _>| {
            if !key.current(app) { return; }
            let part = answer.map_err(|e| e.to_string()).and_then(|part| {
                if part.size != item.size || part.size < 0 || part.size as usize > LIMIT || part.encoding != collie_desktop_protocol::generated::Encoding::Base64 {
                    return Err("The retained file has an invalid size or encoding".into());
                }
                base64::engine::general_purpose::STANDARD.decode(part.content).map_err(|e| e.to_string())
            });
            let mut bytes = bytes;
            match part {
                Err(why) => { app.artefact_failed(&key, why); return; },
                Ok(part) => {
                    if (part.is_empty() && bytes.len() < item.size as usize) || bytes.len() + part.len() > item.size as usize {
                        app.artefact_failed(&key, "The retained transfer ended at an invalid size".into()); return;
                    }
                    bytes.extend(part);
                }
            }
            if bytes.len() < item.size as usize { app.read_artefact_part(key, item, bytes); return; }
            let Some(core) = app.core.clone() else { return };
            std::thread::spawn(move || {
                let verified = bytes.len() == item.size as usize && format!("{:x}", Sha256::digest(&bytes)) == item.digest;
                let mut content = if verified { prepare(&item, &bytes) } else { Err("The retained file's size or digest does not match this revision. Refresh and try again.".into()) };
                if content.is_ok() && item.media_type.starts_with("video/") {
                    let path = super::evidence::aside(&key.installation, &key.run, &format!("{}-r{}-{}", item.id, item.revision, item.title.rsplit('/').next().unwrap_or("file")));
                    let written = path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&path, &bytes));
                    content = written.map_err(|e| format!("The retained video could not be staged: {e}")).map(|_| {
                        let posted = Arc::new(AtomicBool::new(false));
                        let changes = core.clone();
                        let notify: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                            if posted.swap(true, Ordering::AcqRel) { return; }
                            let posted = posted.clone();
                            changes.post(move |_: &mut App| { posted.store(false, Ordering::Release); });
                        });
                        let player = crate::video::Player::open(&path, notify);
                        let once = Arc::new(AtomicBool::new(false));
                        let shown = core.clone();
                        let selected = key.clone();
                        player.surface().set_observer(Arc::new(move |timing| {
                            if timing.completed_at.is_none() || once.swap(true, Ordering::AcqRel) { return; }
                            let selected = selected.clone();
                            shown.post(move |app: &mut App| {
                                if selected.current(app) && app.record.open.as_ref().is_some_and(|r| matches!(&r.artefacts.preview, Some(Preview::Video(player)) if player.state().error.is_none())) && !app.record.open.as_ref().unwrap().artefacts.attempted.swap(true, Ordering::AcqRel) { app.mark_artefact(true); }
                            });
                        }));
                        Preview::Video(player)
                    });
                }
                core.post(move |app: &mut App| {
                    if !key.current(app) { return; }
                    let record = app.record.open.as_mut().unwrap();
                    record.artefacts.bytes = verified.then(|| Arc::new(bytes));
                    record.artefacts.preview = Some(content.unwrap_or_else(Preview::Failed));
                });
            });
        });
    }

    fn artefact_failed(&mut self, key: &Selection, why: String) {
        if key.current(self) {
            self.record.open.as_mut().unwrap().artefacts.preview = Some(Preview::Failed(why));
        }
    }

    pub fn mark_artefact(&self, seen: bool) {
        let Some(record) = &self.record.open else {
            return;
        };
        let Some(key) = selection(record) else { return };
        let Some(core) = self.core.clone() else {
            return;
        };
        core.request(
            "artefactSeen",
            ArtefactSeenPayload {
                installation: key.installation.clone(),
                run_id: key.run.clone(),
                id: key.id.clone(),
                revision: seen.then_some(key.revision),
                request: act::new_request(),
            },
            move |app: &mut App, answer: Result<Artefact, _>| {
                if !key.current(app) {
                    return;
                }
                match answer {
                    Ok(_) => {
                        if let Some(record) = &mut app.record.open {
                            record.artefacts.items = None;
                        }
                        app.read_artefacts(false);
                    }
                    Err(why) => {
                        app.record.open.as_mut().unwrap().artefacts.failed = Some(why.to_string())
                    }
                }
            },
        );
    }

    pub fn open_artefact(&mut self) {
        let Some(record) = &self.record.open else {
            return;
        };
        let Some(item) = selected(record) else { return };
        let Some(bytes) = record.artefacts.bytes.clone() else {
            return;
        };
        let path = super::evidence::aside(
            &record.installation,
            &record.run,
            &format!(
                "{}-r{}-{}",
                item.id,
                item.revision,
                item.title.rsplit('/').next().unwrap_or("file")
            ),
        );
        let report = super::evidence::is_report(&item.title);
        let key = selection(record).unwrap();
        let Some(core) = self.core.clone() else {
            return;
        };
        std::thread::spawn(move || {
            let written = path
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|_| {
                    if report {
                        std::fs::write(
                            &path,
                            super::evidence::confined(&String::from_utf8_lossy(&bytes)),
                        )
                    } else {
                        std::fs::write(&path, bytes.as_slice())
                    }
                });
            core.post(move |app: &mut App| {
                if !key.current(app) {
                    return;
                }
                match written {
                    Ok(()) => app.open_link_in_record(format!("file://{}", path.display())),
                    Err(why) => {
                        app.record.open.as_mut().unwrap().artefacts.failed =
                            Some(format!("Open failed: {why}"))
                    }
                }
            });
        });
    }

    pub fn save_artefact(&mut self, tx: &mut Tx) {
        let Some(record) = &self.record.open else {
            return;
        };
        let Some(item) = selected(record) else { return };
        let Some(bytes) = record.artefacts.bytes.clone() else {
            return;
        };
        let key = selection(record).unwrap();
        tx.save_file(
            rune::FileDialogOptions {
                title: "Save retained revision".into(),
                file_name: Some(item.title.rsplit('/').next().unwrap_or("file").into()),
                ..Default::default()
            },
            move |app: &mut App, answer, _| {
                if !key.current(app) {
                    return;
                }
                match answer {
                    Ok(Some(path)) => {
                        let Some(core) = app.core.clone() else { return };
                        std::thread::spawn(move || {
                            let result = std::fs::write(path, bytes.as_ref());
                            core.post(move |app: &mut App| {
                                if key.current(app)
                                    && let Err(why) = result
                                {
                                    app.record.open.as_mut().unwrap().artefacts.failed =
                                        Some(format!("Save failed: {why}"));
                                }
                            });
                        });
                    }
                    Err(why) => {
                        app.record.open.as_mut().unwrap().artefacts.failed =
                            Some(format!("Save failed: {why}"))
                    }
                    Ok(None) => {}
                }
            },
        );
    }

    pub fn play_artefact(&mut self) {
        if let Some(Preview::Video(player)) = self
            .record
            .open
            .as_ref()
            .and_then(|r| r.artefacts.preview.as_ref())
        {
            if player.state().playing {
                player.pause();
            } else {
                player.play();
            }
        }
    }
    pub fn seek_artefact(&mut self, seconds: f64) {
        if let Some(Preview::Video(player)) = self
            .record
            .open
            .as_ref()
            .and_then(|r| r.artefacts.preview.as_ref())
        {
            player.seek(seconds);
        }
    }
    pub fn mute_artefact(&mut self) {
        if let Some(Preview::Video(player)) = self
            .record
            .open
            .as_ref()
            .and_then(|r| r.artefacts.preview.as_ref())
        {
            player.mute(!player.state().muted);
        }
    }
}

pub fn frame_drawn(runtime: &rune::Runtime<App>) {
    let app = &runtime.state;
    let Some(record) = &app.record.open else {
        return;
    };
    if app.record_tab() != "artefacts" {
        return;
    }
    let Some(([x, y, w, h], opacity)) = runtime.presented("artefact-preview") else {
        return;
    };
    if opacity <= 0.0
        || w <= 0.0
        || h <= 0.0
        || x >= runtime.viewport.0
        || y >= runtime.viewport.1
        || x + w <= 0.0
        || y + h <= 0.0
    {
        return;
    }
    let loaded = match &record.artefacts.preview {
        Some(Preview::Image(_) | Preview::Text { .. }) => true,
        Some(Preview::Video(player)) => {
            player.surface().counts().1 > 0 && player.state().error.is_none()
        }
        _ => false,
    };
    if !loaded {
        return;
    }
    if selected(record).is_none_or(|item| {
        item.seen
            .as_ref()
            .is_some_and(|seen| seen.revision == item.revision)
    }) {
        return;
    }
    if !record.artefacts.attempted.swap(true, Ordering::AcqRel) {
        app.mark_artefact(true);
    }
}

fn path_of(app: &mut App) -> &mut TextEdit {
    &mut app.record.open.as_mut().unwrap().artefacts.path
}

pub fn view(record: &Record, k: &Kit) -> El {
    let state = &record.artefacts;
    let register = row()
        .gap(8.0)
        .center_y()
        .w_full()
        .child(
            Button::new("Refresh")
                .on_press(|app: &mut App| app.read_artefacts(true))
                .build(k)
                .key("artefacts-refresh"),
        )
        .child(
            Button::new("Register file…")
                .build(k)
                .key("artefact-pick")
                .on_press_tx(App::pick_artefact),
        )
        .child(
            TextInput::new(&state.path)
                .width(None)
                .placeholder("Path on the Run's Machine")
                .label("Path on the Run's Machine to register")
                .on_edit(path_of)
                .on_submit(|app: &mut App, _: &mut Tx| app.register_artefact_path())
                .build(k)
                .key("artefact-path")
                .grow(1.0)
                .min_w(0.0),
        )
        .child(
            Button::new("Register path")
                .disabled(state.path.text.trim().is_empty())
                .on_press(App::register_artefact_path)
                .build(k)
                .key("artefact-register"),
        );
    let mut body = col().key("artefacts").gap(12.0).w_full().child(register);
    if state.loading {
        body = body.child(quiet("Reading artefacts…", k).role("status"));
    }
    if let Some(why) = &state.failed {
        body = body.child(quiet(why, k).role("alert"));
    }
    if let Some(items) = &state.items {
        if items.is_empty() {
            body = body.child(quiet("This Run has no retained material.", k));
        }
        for item in items {
            let id = item.id.clone();
            let status = if item
                .seen
                .as_ref()
                .is_some_and(|seen| seen.revision == item.revision)
            {
                "Seen"
            } else if item.seen.is_some() {
                "Updated"
            } else {
                "Unseen"
            };
            let tracking = match (&item.tracking, item.stale, item.pending) {
                (Some(Tracking::Snapshot), ..) => " · retained snapshot",
                (_, Some(true), Some(true)) => " · stale, refresh pending",
                (_, Some(true), _) => " · stale",
                (_, _, Some(true)) => " · refresh pending",
                _ => "",
            };
            body = body.child(
                Button::new(format!("{} · {} · {status}{tracking}", item.title, item.role))
                    .on_press(move |app: &mut App| app.select_artefact(&id))
                    .build(k)
                    .key(format!("artefact-{}", item.id)),
            );
        }
    }
    let Some(item) = selected(record) else {
        return body;
    };
    let date = item
        .created
        .as_ref()
        .and_then(|d| d.as_ref())
        .map(|d| format!("{} ({})", d.at, d.provenance))
        .unwrap_or_else(|| "Unknown".into());
    let updated = item
        .updated
        .as_ref()
        .and_then(|d| d.as_ref())
        .map(|d| format!("{} ({})", d.at, d.provenance))
        .unwrap_or_else(|| "Unknown".into());
    let header = col()
        .gap(4.0)
        .child(text(item.title.clone()).selectable(true))
        .child(quiet(
            format!(
                "{} · {} bytes · revision {}",
                item.media_type, item.size, item.revision
            ),
            k,
        ))
        .child(quiet(
            format!("Created: {date} · Observed: {}", item.observed_at),
            k,
        ))
        .child(quiet(
            format!("Updated: {updated} · Detected: {}", item.detected_at),
            k,
        ))
        .child(quiet(format!("Registered: {}", item.registered_at), k))
        .child(quiet(
            format!(
                "Source: {} · Retained: {}",
                item.source_availability, item.retained_availability
            ),
            k,
        ));
    let header = header.children(item.reason.as_ref().map(|reason| quiet(reason, k)));
    let actions = row()
        .gap(8.0)
        .child(
            Button::new("Open")
                .disabled(state.bytes.is_none())
                .on_press(App::open_artefact)
                .build(k)
                .key("artefact-open"),
        )
        .child(
            Button::new("Save")
                .disabled(state.bytes.is_none())
                .build(k)
                .key("artefact-save")
                .on_press_tx(App::save_artefact),
        )
        .child(
            Button::new("Mark seen")
                .on_press(|app: &mut App| app.mark_artefact(true))
                .build(k)
                .key("artefact-seen"),
        )
        .child(
            Button::new("Mark unseen")
                .on_press(|app: &mut App| app.mark_artefact(false))
                .build(k)
                .key("artefact-unseen"),
        );
    let preview = match &state.preview {
        Some(Preview::Image(image)) => rune::el().pixels_fit(image.pixels(), SurfaceFit::Fit).w_full().h(320.0).role("img").label(item.title.clone()),
        Some(Preview::Text { text, markdown: md, truncated }) => col().w_full().child(if text.is_empty() { quiet("This file is empty.", k) } else if *md { markdown(text, k) } else { mono(text, "artefact-text", k) }).children(truncated.then(|| quiet("Preview truncated at 256 KiB. Open or Save provides the complete retained file.", k))),
        Some(Preview::Unsupported) => quiet("Inline preview is unavailable for this type. Use Open or Save.", k),
        Some(Preview::Failed(why)) => quiet(format!("Preview failed: {why}"), k).role("alert"),
        Some(Preview::Video(player)) => {
            let state = player.state();
            let (w, h) = state.size.unwrap_or((16, 9));
            let width = (record.width - 64.0).clamp(100.0, 920.0);
            let duration = state.duration.unwrap_or(0.0);
            let seek_back = (state.time - 5.0).max(0.0);
            let seek_forward = (state.time + 5.0).min(duration);
            col().w_full().gap(8.0)
                .child(player.element().w_full().h(width * h as f32 / w.max(1) as f32).label(item.title.clone()))
                .children(state.loading.then(|| quiet("Loading video decoder…", k).role("status")))
                .children(state.error.as_ref().map(|why| quiet(why, k).role("alert")))
                .child(row().gap(8.0)
                    .child(Button::new(if state.playing { "Pause" } else { "Play" }).on_press(App::play_artefact).build(k).key("artefact-play"))
                    .child(Button::new("Seek back 5 seconds").on_press(move |app: &mut App| app.seek_artefact(seek_back)).build(k).key("artefact-seek-back"))
                    .child(Button::new("Seek forward 5 seconds").on_press(move |app: &mut App| app.seek_artefact(seek_forward)).build(k).key("artefact-seek-forward"))
                    .child(text(format!("{:.1} / {duration:.1} seconds", state.time)).key("artefact-time").role("status").label("Elapsed and duration"))
                    .child(Button::new(if state.muted { "Unmute" } else { "Mute" }).on_press(App::mute_artefact).build(k).key("artefact-mute")))
        },
        _ => quiet("Loading selected revision…", k).role("status"),
    }.key("artefact-preview");
    body.child(header).child(actions).child(preview)
}
