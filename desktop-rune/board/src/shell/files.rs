//! Files pasted or dropped on a Run's pane: staged on this computer, placed on the pane's
//! Machine through its host (`placeFiles`), then typed into the pane as their paths there in
//! one paste, without Enter (ADR-draft-a-file-given-to-a-pane-is-placed-on-its-machine).

use crate::App;
use crate::calls::CallError;
use base64::Engine;
use collie_desktop_chat::attachments::{iso_of, pasted_name, pasted_paths};
use collie_desktop_protocol::generated::{StagedOrRefusedItem, StagedOrRefusedItem0};
use collie_desktop_protocol::{epoch_ms, log};
use rune::{ClipboardContent, Key, KeyEvent};
use serde_json::json;
use std::path::PathBuf;

/// How many bytes of a pasted image go to the core in one `stage` call, as the chat sends them.
const PART: usize = 1024 * 1024;

/// What a paste or a drop gives the pane.
enum Given {
    Paths(Vec<PathBuf>),
    Image(Vec<u8>),
    /// A paste that named nothing: the files the system clipboard holds, if any.
    Clipboard,
}

/// The pane the files are for: the terminal opened under `opened`, on `machine`.
#[derive(Clone)]
struct For {
    opened: u64,
    installation: String,
    machine: String,
}

/// `path` as one word for a POSIX shell: as it is where nothing in it is special, else quoted.
pub fn shell_quoted(path: &str) -> String {
    let plain = !path.is_empty()
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

/// Files a paste carries, as the chat's composer reads them: the clipboard's own list or
/// `file://` text, else an image; none for text.
fn files_in(pasted: &ClipboardContent) -> Option<Given> {
    let paths = pasted_paths(pasted);
    if !paths.is_empty() {
        return Some(Given::Paths(paths));
    }
    pasted
        .image()
        .map(|image| Given::Image(image.png().to_vec()))
}

/// Ctrl+V with nothing else held, which a pane's program reads as its own paste.
pub fn is_ctrl_v(key: &KeyEvent) -> bool {
    let v = match &key.key {
        Key::Command(c) => c.eq_ignore_ascii_case(&'v'),
        Key::Text(text) => text.eq_ignore_ascii_case("v"),
        _ => false,
    };
    v && key.mods.ctrl && !key.mods.shift && !key.mods.alt && !key.mods.logo
}

impl App {
    /// The pane the record shows, while its Terminal tab is up.
    pub(crate) fn shown_pane(&mut self) -> Option<&mut collie_desktop_terminal::view::Tab> {
        let shown = self.record.open.is_some() && self.record_tab() == "terminal";
        self.terminal.as_mut().filter(|_| shown)
    }

    /// A paste while the pane is shown: files are given to it, text is typed as it always was,
    /// and an empty paste gives the files the system clipboard holds.
    pub fn paste_into_pane(&mut self, pasted: &ClipboardContent) {
        let Some(tab) = self.shown_pane() else {
            return;
        };
        match files_in(pasted) {
            Some(given) => self.give_pane(given),
            None if pasted.text().is_empty() => self.give_pane(Given::Clipboard),
            None => tab.paste(pasted.text()),
        }
    }

    /// Ctrl+V's clipboard, read: its files are given to the pane, else the key is typed.
    pub fn ctrl_v_into_pane(&mut self, key: &KeyEvent, held: &ClipboardContent) {
        if self.shown_pane().is_none() {
            return;
        }
        match files_in(held) {
            Some(given) => self.give_pane(given),
            None => {
                if let Some(tab) = self.shown_pane() {
                    tab.key(key);
                }
            }
        }
    }

    /// Files dropped on the window while the pane is shown.
    pub fn drop_on_pane(&mut self, paths: Vec<PathBuf>) {
        if self.shown_pane().is_some() && !paths.is_empty() {
            self.give_pane(Given::Paths(paths));
        }
    }

    fn give_pane(&mut self, given: Given) {
        let (Some(record), Some(core)) = (&self.record.open, self.core.clone()) else {
            return;
        };
        let to = For {
            opened: self.opened,
            installation: record.installation.clone(),
            machine: record.machine.clone(),
        };
        self.record.terminal_said = Some(format!("Placing files on {}…", to.machine));
        match given {
            Given::Paths(paths) => {
                let paths: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                core.request(
                    "stagePaths",
                    json!({ "paths": paths }),
                    move |app: &mut App, staged: Result<Vec<StagedOrRefusedItem>, CallError>| {
                        app.staged_for_pane(to, staged)
                    },
                );
            }
            Given::Clipboard => core.request(
                "clipboardFiles",
                (),
                move |app: &mut App, staged: Result<Vec<StagedOrRefusedItem>, CallError>| {
                    match staged {
                        Ok(staged) if staged.is_empty() => app.pane_said(&to, None),
                        staged => app.staged_for_pane(to, staged),
                    }
                },
            ),
            Given::Image(png) => {
                let name = pasted_name(&iso_of(epoch_ms()), "image/png");
                let key = format!("pane-{}-{}", epoch_ms(), png.len());
                self.stage_part(to, key, name, png, 0);
            }
        }
    }

    /// One part of a pasted image to the core; the last is answered with Desktop's copy.
    fn stage_part(&mut self, to: For, key: String, name: String, png: Vec<u8>, offset: usize) {
        let Some(core) = self.core.clone() else {
            return;
        };
        let end = (offset + PART).min(png.len());
        let content = base64::engine::general_purpose::STANDARD.encode(&png[offset..end]);
        let payload = json!({
            "key": key, "name": name, "mediaType": "image/png", "size": png.len(),
            "offset": offset, "content": content,
        });
        core.request(
            "stage",
            payload,
            move |app: &mut App, staged: Result<Option<StagedOrRefusedItem0>, CallError>| {
                match staged {
                    Ok(None) if end < png.len() => app.stage_part(to, key, name, png, end),
                    Ok(None) => app.not_given(&to, format!("{name} could not be staged")),
                    Ok(Some(copy)) => app.place_on_pane(to, vec![copy.id]),
                    Err(why) => app.not_given(&to, format!("{name} could not be staged: {why}")),
                }
            },
        );
    }

    fn staged_for_pane(&mut self, to: For, staged: Result<Vec<StagedOrRefusedItem>, CallError>) {
        let staged = match staged {
            Ok(staged) => staged,
            Err(why) => {
                return self.not_given(&to, format!("the files could not be staged: {why}"));
            }
        };
        let mut ids = Vec::new();
        let mut refused = Vec::new();
        for one in staged {
            match one {
                StagedOrRefusedItem::StagedOrRefusedItem0(copy) => ids.push(copy.id),
                StagedOrRefusedItem::StagedOrRefusedItem1(no) => refused.push(no.refused),
            }
        }
        if !refused.is_empty() {
            return self.not_given(&to, refused.join("; "));
        }
        self.place_on_pane(to, ids);
    }

    fn place_on_pane(&mut self, to: For, ids: Vec<String>) {
        let Some(core) = self.core.clone() else {
            return;
        };
        core.request(
            "placeFiles",
            json!({ "installation": to.installation, "ids": ids }),
            move |app: &mut App, placed: Result<Vec<String>, CallError>| match placed {
                Ok(paths) => app.type_paths(&to, &paths),
                Err(why) => app.not_given(&to, why.to_string()),
            },
        );
    }

    /// The placed files' paths, typed into the pane they were given to if it is still shown.
    fn type_paths(&mut self, to: &For, paths: &[String]) {
        let words: Vec<String> = paths.iter().map(|p| shell_quoted(p)).collect();
        let same = self.opened == to.opened;
        match self.shown_pane().filter(|_| same) {
            Some(tab) => {
                tab.paste(&words.join(" "));
                self.pane_said(to, None);
            }
            None => log::event(
                "terminal",
                "files placed after their pane closed",
                None,
                &[("machine", &to.machine)],
            ),
        }
    }

    fn not_given(&mut self, to: &For, why: String) {
        log::event(
            "terminal",
            "files not given to the pane",
            Some(&why),
            &[("machine", &to.machine)],
        );
        self.pane_said(to, Some(format!("Nothing was pasted: {why}")));
    }

    /// What the pane's tab says of its files, while it is still the pane they were for.
    fn pane_said(&mut self, to: &For, said: Option<String>) {
        if self.opened == to.opened {
            self.record.terminal_said = said;
        }
    }
}
