//! The Diff tab: the Run's changed files as a tree beside rune-kit's Diff, each file's patch read
//! from `runFile`, viewed ticks, big files closed, and selected lines made review comments. Its
//! logic is a copy of `diff-view.ts`, which stays its owner.

use super::review::{Anchor, Draft, add_draft, diff_anchor};
use crate::App;
use collie_desktop_protocol::generated::{File, FileStatus};
use rune::edit::TextEdit;
use rune::{El, Tx, col, row, text};
use rune_kit::diff::{Annotation, DiffMode, DiffState, DiffView, FileDiff, LineRef, parse};
use rune_kit::{Button, ButtonVariant, Checkbox, Kit, SegmentedControl, TextInput};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum TreeNode {
    Folder {
        key: String,
        label: String,
        children: Vec<TreeNode>,
    },
    File {
        key: String,
        label: String,
        file: File,
    },
}

/// The folders a path is in, each as its full path with a trailing `/`.
pub fn folders_on(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    (1..parts.len())
        .map(|n| format!("{}/", parts[..n].join("/")))
        .collect()
}

fn merged(nodes: Vec<TreeNode>) -> Vec<TreeNode> {
    nodes
        .into_iter()
        .map(|node| match node {
            TreeNode::Folder {
                key,
                label,
                children,
            } => {
                let children = merged(children);
                match children.as_slice() {
                    [
                        TreeNode::Folder {
                            key: inner,
                            label: below,
                            children: deeper,
                        },
                    ] => TreeNode::Folder {
                        key: inner.clone(),
                        label: format!("{label}/{below}"),
                        children: deeper.clone(),
                    },
                    _ => TreeNode::Folder {
                        key,
                        label,
                        children,
                    },
                }
            }
            file => file,
        })
        .collect()
}

fn insert(level: &mut Vec<TreeNode>, folders: &[String], parts: &[&str], file: &File) {
    match folders.split_first() {
        None => level.push(TreeNode::File {
            key: file.path.clone(),
            label: parts.last().copied().unwrap_or("").into(),
            file: file.clone(),
        }),
        Some((key, rest)) => {
            let at = level
                .iter()
                .position(|n| matches!(n, TreeNode::Folder { key: k, .. } if k == key))
                .unwrap_or_else(|| {
                    level.push(TreeNode::Folder {
                        key: key.clone(),
                        label: parts[parts.len() - 1 - folders.len()].into(),
                        children: Vec::new(),
                    });
                    level.len() - 1
                });
            if let TreeNode::Folder { children, .. } = &mut level[at] {
                insert(children, rest, parts, file);
            }
        }
    }
}

/// The changed files as folders, one-child folders merged into their parent's row.
pub fn diff_tree(changed: &[File]) -> Vec<TreeNode> {
    let mut root = Vec::new();
    for file in changed {
        let parts: Vec<&str> = file.path.split('/').collect();
        insert(&mut root, &folders_on(&file.path), &parts, file);
    }
    merged(root)
}

/// The tree's files in drawn order.
pub fn files_of(tree: &[TreeNode]) -> Vec<File> {
    tree.iter()
        .flat_map(|node| match node {
            TreeNode::File { file, .. } => vec![file.clone()],
            TreeNode::Folder { children, .. } => files_of(children),
        })
        .collect()
}

/// Only the files whose path holds `text`, and the folders they are in.
pub fn filter_tree(tree: &[TreeNode], text: &str) -> Vec<TreeNode> {
    let wanted = text.trim().to_lowercase();
    if wanted.is_empty() {
        return tree.to_vec();
    }
    fn kept(nodes: &[TreeNode], wanted: &str) -> Vec<TreeNode> {
        nodes
            .iter()
            .filter_map(|node| match node {
                TreeNode::File { key, .. } => {
                    key.to_lowercase().contains(wanted).then(|| node.clone())
                }
                TreeNode::Folder {
                    key,
                    label,
                    children,
                } => {
                    let children = kept(children, wanted);
                    (!children.is_empty()).then(|| TreeNode::Folder {
                        key: key.clone(),
                        label: label.clone(),
                        children,
                    })
                }
            })
            .collect()
    }
    merged(kept(tree, &wanted))
}

/// What a viewed tick saw, so a file the Run changes again loses it.
#[derive(Debug, Clone, PartialEq)]
pub struct Tick {
    pub status: FileStatus,
    pub added: Option<i64>,
    pub removed: Option<i64>,
    pub base: String,
}

pub type Ticks = HashMap<String, Tick>;

pub fn tick_viewed(ticks: &Ticks, file: &File, base: &str) -> Ticks {
    let mut ticks = ticks.clone();
    ticks.insert(
        file.path.clone(),
        Tick {
            status: file.status.clone(),
            added: file.added,
            removed: file.removed,
            base: base.into(),
        },
    );
    ticks
}

pub fn untick_viewed(ticks: &Ticks, path: &str) -> Ticks {
    let mut ticks = ticks.clone();
    ticks.remove(path);
    ticks
}

fn still_true(seen: Option<&Tick>, file: &File, base: &str) -> bool {
    seen.is_some_and(|seen| {
        seen.status == file.status
            && seen.added == file.added
            && seen.removed == file.removed
            && seen.base == base
    })
}

pub fn is_viewed(ticks: &Ticks, file: &File, base: &str) -> bool {
    still_true(ticks.get(&file.path), file, base)
}

/// The ticks the diff now shown still bears out; the rest are gone even if it changes back.
pub fn ticks_still_true(ticks: &Ticks, files: &[File], base: &str) -> Ticks {
    files
        .iter()
        .filter_map(|file| {
            let seen = ticks.get(&file.path)?;
            still_true(Some(seen), file, base).then(|| (file.path.clone(), seen.clone()))
        })
        .collect()
}

pub fn viewed_count(ticks: &Ticks, files: &[File], base: &str) -> String {
    let viewed = files.iter().filter(|f| is_viewed(ticks, f, base)).count();
    format!("{viewed} of {} viewed", files.len())
}

const BIG_FILE_LINES: i64 = 500;

/// The human's choice for the file, else open for a text file of at most 500 changed lines.
pub fn file_open(file: &File, choices: &HashMap<String, bool>) -> bool {
    choices.get(&file.path).copied().unwrap_or_else(|| {
        file.added
            .is_some_and(|added| added + file.removed.unwrap_or(0) <= BIG_FILE_LINES)
    })
}

/// Expand all or Collapse all: one choice for each file in the diff now.
pub fn choice_for_every(files: &[File], open: bool) -> HashMap<String, bool> {
    files.iter().map(|f| (f.path.clone(), open)).collect()
}

/// The file one step from the active one in drawn order; the first while none is active.
pub fn file_beside(files: &[File], active: Option<&str>, step: isize) -> Option<String> {
    let at = files.iter().position(|f| Some(f.path.as_str()) == active);
    let next = match at {
        None => Some(0),
        Some(at) => at.checked_add_signed(step),
    };
    next.and_then(|n| files.get(n)).map(|f| f.path.clone())
}

/// A file row's status mark, its line counts or `binary`, and its drafts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowFacts {
    pub status: &'static str,
    pub lines: Option<(i64, i64)>,
    pub drafts: usize,
}

pub fn row_facts(file: &File, drafts: &[String]) -> RowFacts {
    RowFacts {
        status: match file.status {
            FileStatus::Added => "A",
            FileStatus::Modified => "M",
            FileStatus::Deleted => "D",
        },
        lines: file.added.map(|added| (added, file.removed.unwrap_or(0))),
        drafts: drafts.iter().filter(|p| **p == file.path).count(),
    }
}

/// The Diff tab's own state; the drafts are the Run's, in `Records`.
pub struct DiffTab {
    pub state: DiffState,
    pub base: String,
    /// The changed files in the tree's drawn order.
    pub files: Vec<File>,
    /// Whether every file's patch is read and drawn.
    pub built: bool,
    /// Expand or collapse, as the human chose it per file.
    pub choices: HashMap<String, bool>,
    pub filter: TextEdit,
    pub comment: TextEdit,
}

impl DiffTab {
    pub fn new(files: Vec<FileDiff>) -> DiffTab {
        DiffTab {
            state: DiffState::new(files),
            base: String::new(),
            files: Vec::new(),
            built: true,
            choices: HashMap::new(),
            filter: TextEdit::default(),
            comment: TextEdit::default(),
        }
    }

    fn reading(base: String, files: Vec<File>) -> DiffTab {
        DiffTab {
            base,
            files: files_of(&diff_tree(&files)),
            built: false,
            ..DiffTab::new(Vec::new())
        }
    }

    /// The file shown at the top of the diff.
    pub fn active(&self) -> Option<String> {
        self.state
            .files()
            .get(self.state.visible_file())
            .map(|f| f.path().to_string())
    }

    /// Draws `drafts` at the last line each is about.
    pub fn annotate(&mut self, drafts: &[Draft]) {
        let notes = drafts
            .iter()
            .filter_map(|draft| match &draft.anchor {
                Anchor::Diff {
                    path, side, last, ..
                } => {
                    let file = self.state.file_index(path)?;
                    Some(Annotation::new(
                        file,
                        LineRef::new(*side, *last),
                        draft.id.clone(),
                    ))
                }
                Anchor::Plan { .. } => None,
            })
            .collect();
        self.state.set_annotations(notes);
    }

    fn apply_choices(&mut self) {
        for (at, file) in self.files.iter().enumerate() {
            if let Some(index) = self.state.file_index(&file.path) {
                let _ = at;
                self.state
                    .set_collapsed(index, !file_open(file, &self.choices));
            }
        }
    }
}

fn diff_of(app: &App) -> &DiffState {
    &app.diff.as_ref().expect("an open diff").state
}

fn diff_of_mut(app: &mut App) -> &mut DiffState {
    &mut app.diff.as_mut().expect("an open diff").state
}

impl App {
    /// Shows a diff read whole for the `opened`th record, on its Diff tab.
    pub fn diff_read(&mut self, opened: u64, patch: &str) {
        if !self.current(opened) {
            return;
        }
        self.diff = Some(DiffTab::new(parse(patch)));
        if let Some(record) = &mut self.record.open {
            record.chosen = Some("diff".into());
        }
    }

    /// Starts reading the record's diff, file by file, unless it is read for these files.
    pub fn read_diff(&mut self) {
        let Some(record) = &self.record.open else {
            return;
        };
        let Some(diff) = record.detail().and_then(|d| d.diff.clone()) else {
            return;
        };
        let same = self.diff.as_ref().is_some_and(|tab| {
            tab.base == diff.base && {
                let mut had = tab.files.clone();
                let mut now = diff.files.clone();
                had.sort_by(|a, b| a.path.cmp(&b.path));
                now.sort_by(|a, b| a.path.cmp(&b.path));
                had == now
            }
        });
        if same {
            return;
        }
        let key = record.key();
        if let Some(ticks) = self.record.viewed.get_mut(&key) {
            *ticks = ticks_still_true(ticks, &diff.files, &diff.base);
        }
        let tab = DiffTab::reading(diff.base.clone(), diff.files.clone());
        let items: Vec<String> = tab
            .files
            .iter()
            .map(|f| format!("diff:{}", f.path))
            .collect();
        self.diff = Some(tab);
        for item in &items {
            self.reread_item(item);
        }
        if items.is_empty() {
            self.diff_part_read();
        }
    }

    /// The record's diff changed while open: read it again where its tab is shown.
    pub(super) fn diff_files_changed(&mut self) {
        if self.diff.is_some() && self.record_tab() == "diff" {
            self.read_diff();
        }
    }

    /// Draws the diff once every file's patch has come.
    pub(super) fn diff_part_read(&mut self) {
        let (Some(record), Some(tab)) = (&self.record.open, &mut self.diff) else {
            return;
        };
        if tab.built {
            return;
        }
        let mut drawn = Vec::new();
        for file in &tab.files {
            match record.items.get(&format!("diff:{}", file.path)) {
                Some(super::Item::Read(bytes)) => {
                    drawn.extend(parse(&String::from_utf8_lossy(bytes)))
                }
                Some(super::Item::Failed(_)) => {}
                _ => return,
            }
        }
        tab.state.set_files(drawn);
        tab.built = true;
        tab.apply_choices();
        let drafts = self
            .record
            .drafts
            .get(&record.key())
            .cloned()
            .unwrap_or_default();
        tab.annotate(&drafts);
    }

    fn diff_drafts_changed(&mut self) {
        let Some(record) = &self.record.open else {
            return;
        };
        let drafts = self
            .record
            .drafts
            .get(&record.key())
            .cloned()
            .unwrap_or_default();
        if let Some(tab) = &mut self.diff {
            tab.annotate(&drafts);
        }
    }

    /// Makes the comment written a draft about the lines selected.
    pub fn add_diff_comment(&mut self) {
        let (Some(record), Some(tab)) = (&self.record.open, &mut self.diff) else {
            return;
        };
        let said = tab.comment.text.trim().to_string();
        let Some(anchor) = diff_anchor(&tab.state).filter(|_| !said.is_empty()) else {
            return;
        };
        self.record.made += 1;
        let draft = Draft {
            id: format!("d{}", self.record.made),
            anchor,
            text: said,
        };
        let drafts = self.record.drafts.entry(record.key()).or_default();
        *drafts = add_draft(drafts, draft);
        tab.comment.clear();
        tab.state.set_selection(None);
        self.diff_drafts_changed();
    }

    /// Ticks a file viewed, or unticks it.
    pub fn toggle_viewed(&mut self, path: &str) {
        let (Some(record), Some(tab)) = (&self.record.open, &mut self.diff) else {
            return;
        };
        let Some(file) = tab.files.iter().find(|f| f.path == path) else {
            return;
        };
        let ticks = self.record.viewed.entry(record.key()).or_default();
        *ticks = if is_viewed(ticks, file, &tab.base) {
            untick_viewed(ticks, path)
        } else {
            tick_viewed(ticks, file, &tab.base)
        };
        // A file ticked viewed closes, as a reviewed file does on a forge.
        let open = !is_viewed(ticks, file, &tab.base);
        tab.choices.insert(path.into(), open);
        tab.apply_choices();
    }

    pub fn open_every_file(&mut self, open: bool) {
        if let Some(tab) = &mut self.diff {
            tab.choices = choice_for_every(&tab.files, open);
            tab.apply_choices();
        }
    }

    /// Scrolls the diff to the file one step from the one shown: `j` and `k`.
    pub fn file_step(&mut self, step: isize, tx: &mut Tx) {
        let Some(tab) = &mut self.diff else { return };
        let Some(next) = file_beside(&tab.files, tab.active().as_deref(), step) else {
            return;
        };
        self.go_to_file(&next, None, tx);
    }

    /// Scrolls the diff to a file, or a line of it as it is now, opening it.
    pub fn go_to_file(&mut self, path: &str, line: Option<u32>, tx: &mut Tx) {
        let Some(tab) = &mut self.diff else { return };
        let Some(index) = tab.state.file_index(path) else {
            return;
        };
        tab.choices.insert(path.into(), true);
        tab.state.set_collapsed(index, false);
        match line {
            Some(line) => {
                tab.state
                    .scroll_to_line(index, LineRef::new(rune_kit::diff::Side::New, line), tx)
            }
            None => tab.state.scroll_to_file(index, tx),
        }
    }
}

fn tree_rows(app: &App, nodes: &[TreeNode], depth: usize, k: &Kit, out: &mut Vec<El>) {
    let Some(record) = &app.record.open else {
        return;
    };
    let Some(tab) = &app.diff else { return };
    let ticks = app.record.viewed.get(&record.key());
    let drafted: Vec<String> = app
        .record
        .drafts_of(record)
        .iter()
        .filter_map(|d| match &d.anchor {
            Anchor::Diff { path, .. } => Some(path.clone()),
            Anchor::Plan { .. } => None,
        })
        .collect();
    let active = tab.active();
    for node in nodes {
        let indent = 8.0 + 12.0 * depth.min(4) as f32;
        match node {
            TreeNode::Folder {
                key,
                label,
                children,
            } => {
                out.push(
                    text(format!("{label}/"))
                        .key(format!("tree-{key}"))
                        .font(k.ty.small)
                        .color(k.c.text_faint)
                        .truncate()
                        .pl(indent)
                        .py(2.0),
                );
                tree_rows(app, children, depth + 1, k, out);
            }
            TreeNode::File { key, label, file } => {
                let facts = row_facts(file, &drafted);
                let viewed = ticks.is_some_and(|t| is_viewed(t, file, &tab.base));
                let mark = match file.status {
                    FileStatus::Added => k.c.success.icon,
                    FileStatus::Deleted => k.c.danger.icon,
                    FileStatus::Modified => k.c.warning.icon,
                };
                let counts = match facts.lines {
                    Some((added, removed)) => format!("+{added} −{removed}"),
                    None => "binary".into(),
                };
                let mut said = vec![label.clone()];
                if viewed {
                    said.push("viewed".into());
                }
                if facts.drafts > 0 {
                    said.push(format!("{} drafts", facts.drafts));
                }
                said.push(counts.clone());
                let path = key.clone();
                let shown = active.as_deref() == Some(key.as_str());
                out.push(
                    row()
                        .key(format!("tree-file-{key}"))
                        .role("button")
                        .label(said.join(", "))
                        .focusable(true)
                        .checked(shown)
                        .gap(6.0)
                        .center_y()
                        .pl(indent)
                        .pr(8.0)
                        .py(3.0)
                        .radius(k.radius.sm)
                        .fill(if shown { k.c.layer_03 } else { k.c.layer_01 })
                        .on_press_tx(move |app: &mut App, tx| app.go_to_file(&path, None, tx))
                        .child(
                            text(facts.status)
                                .font(k.ty.small_medium)
                                .color(mark)
                                .w(10.0),
                        )
                        .child(
                            text(label.clone())
                                .font(k.ty.small)
                                .color(if viewed {
                                    k.c.text_faint
                                } else {
                                    k.c.text_base
                                })
                                .truncate()
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .children((facts.drafts > 0).then(|| {
                            text(format!("✎{}", facts.drafts))
                                .font(k.ty.small)
                                .color(k.c.info.icon)
                        }))
                        .children(
                            viewed.then(|| text("✓").font(k.ty.small).color(k.c.success.icon)),
                        )
                        .child(text(counts).font(k.ty.small).color(k.c.text_faint)),
                );
            }
        }
    }
}

fn diff_tab_of(app: &mut App) -> &mut DiffTab {
    app.diff.as_mut().expect("an open diff")
}

/// The Diff tab: the tree, the toolbar, the diff, and the composer for a selection.
pub fn view(app: &App, k: &Kit) -> El {
    let Some(tab) = &app.diff else {
        return text("Reading the diff…")
            .color(k.c.text_muted)
            .key("diff-reading");
    };
    let Some(record) = &app.record.open else {
        return col();
    };
    if !tab.built {
        let read = tab
            .files
            .iter()
            .filter(|f| {
                record
                    .items
                    .get(&format!("diff:{}", f.path))
                    .is_some_and(|i| !matches!(i, super::Item::Reading))
            })
            .count();
        return text(format!(
            "Reading the diff: {read} of {} files",
            tab.files.len()
        ))
        .key("diff-reading")
        .role("status")
        .color(k.c.text_muted);
    }
    let ticks = app
        .record
        .viewed
        .get(&record.key())
        .cloned()
        .unwrap_or_default();
    let split = tab.state.mode() == DiffMode::Split;
    let layout = SegmentedControl::new(&["Unified", "Split"], Some(split as usize))
        .label("Layout")
        .on_pick(|app: &mut App, at, _| {
            diff_of_mut(app).set_mode(if at == 1 {
                DiffMode::Split
            } else {
                DiffMode::Unified
            })
        })
        .build(k)
        .key("diff-layout");
    let wrap = Checkbox::new(tab.state.wrap())
        .label("Wrap")
        .on_toggle(|app: &mut App| {
            let state = diff_of_mut(app);
            state.set_wrap(!state.wrap());
        })
        .build(k)
        .key("diff-wrap");
    let every = |label: &str, key: &str, open: bool| {
        Button::new(label)
            .variant(ButtonVariant::Ghost)
            .on_press(move |app: &mut App| app.open_every_file(open))
            .build(k)
            .key(key.to_string())
    };
    let toolbar = row()
        .key("diff-toolbar")
        .gap(12.0)
        .center_y()
        .w_full()
        .child(
            text(viewed_count(&ticks, &tab.files, &tab.base))
                .key("diff-viewed")
                .font(k.ty.small)
                .color(k.c.text_muted),
        )
        .child(rune::spacer())
        .child(every("Expand all", "diff-expand", true))
        .child(every("Collapse all", "diff-collapse", false))
        .child(wrap)
        .child(layout);
    let filter = TextInput::new(&tab.filter)
        .placeholder("Filter files")
        .label("Filter files")
        .on_edit(|app: &mut App| &mut diff_tab_of(app).filter)
        .build(k)
        .key("diff-filter");
    let mut rows = Vec::new();
    tree_rows(
        app,
        &filter_tree(&diff_tree(&tab.files), &tab.filter.text),
        0,
        k,
        &mut rows,
    );
    let tree = col()
        .key("diff-tree")
        .role("group")
        .label("Changed files")
        .w(280.0)
        .gap(6.0)
        .min_h(0.0)
        .child(filter)
        .child(
            col()
                .gap(1.0)
                .grow(1.0)
                .min_h(0.0)
                .scroll(rune::ScrollSpec {
                    stick_bottom: false,
                })
                .children(rows),
        );
    let kit = k.clone();
    let header = move |app: &App, file: usize| -> El {
        let Some(tab) = &app.diff else { return row() };
        let Some(path) = tab.state.files().get(file).map(|f| f.path().to_string()) else {
            return row();
        };
        let ticks = app
            .record
            .open
            .as_ref()
            .and_then(|r| app.record.viewed.get(&r.key()));
        let viewed = tab
            .files
            .iter()
            .find(|f| f.path == path)
            .is_some_and(|f| ticks.is_some_and(|t| is_viewed(t, f, &tab.base)));
        let key = format!("viewed-{path}");
        Checkbox::new(viewed)
            .label("Viewed")
            .on_toggle(move |app: &mut App| app.toggle_viewed(&path))
            .build(&kit)
            .key(key)
    };
    let kit = k.clone();
    let note = move |app: &App, note: &Annotation| -> El {
        let draft = app.record.open.as_ref().and_then(|r| {
            app.record
                .drafts_of(r)
                .iter()
                .find(|d| d.id == note.id)
                .cloned()
        });
        match draft {
            Some(draft) => super::view::draft_note(&draft, &kit),
            None => row(),
        }
    };
    let diff = DiffView::new(diff_of, diff_of_mut)
        .on_select(|app: &mut App, range, _| diff_of_mut(app).set_selection(range))
        .on_comment(|app: &mut App, range, _| diff_of_mut(app).set_selection(Some(range)))
        .header_actions(header)
        .annotation(note)
        .key("diff")
        .build(app, k);
    let composer = diff_anchor(&tab.state).map(|anchor| {
        let at = super::view::anchor_said(&anchor);
        row()
            .key("diff-composer")
            .gap(8.0)
            .center_y()
            .w_full()
            .child(text(at).font(k.ty.small).color(k.c.text_muted))
            .child(
                TextInput::new(&tab.comment)
                    .placeholder("Comment on the selected lines")
                    .label("Comment on the selected lines")
                    .on_edit(|app: &mut App| &mut diff_tab_of(app).comment)
                    .on_submit(|app: &mut App, _| app.add_diff_comment())
                    .build(k)
                    .key("diff-comment")
                    .grow(1.0),
            )
            .child(
                Button::new("Add comment")
                    .on_press(App::add_diff_comment)
                    .build(k)
                    .key("add-comment"),
            )
    });
    row()
        .key("diff-tab")
        .gap(12.0)
        .grow(1.0)
        .min_h(0.0)
        .w_full()
        .child(tree)
        .child(
            col()
                .gap(8.0)
                .grow(1.0)
                .min_w(0.0)
                .min_h(0.0)
                .child(toolbar)
                .children(composer)
                .child(diff),
        )
}
