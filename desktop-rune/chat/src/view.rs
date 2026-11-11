//! A Run's Diff tab as Rune draws it. The Flock chat is `pane`; its state is re-exported here
//! for the code that reached it through this module.

use crate::review::{Draft, add_draft, compose, diff_anchor, remove_draft};
use rune::edit::TextEdit;
use rune::{El, col, row, text};
use rune_kit::diff::{DiffMode, DiffState, DiffView, FileDiff};
use rune_kit::{Button, ButtonVariant, Kit, SegmentedControl, TextInput};

pub use crate::attachments::pasted_paths;
pub use crate::chat::{Chat, Say};
pub use crate::pane::chat;

pub struct DiffTab {
    pub state: DiffState,
    pub drafts: Vec<Draft>,
    pub comment: TextEdit,
    /// Counts the drafts made, for their ids.
    pub made: u64,
    /// The Delivery text the drafts compose, once asked for.
    pub delivery: Option<String>,
}

impl DiffTab {
    pub fn new(files: Vec<FileDiff>) -> DiffTab {
        DiffTab {
            state: DiffState::new(files),
            drafts: Vec::new(),
            comment: TextEdit::default(),
            made: 0,
            delivery: None,
        }
    }

    pub fn add_comment(&mut self) {
        let said = self.comment.text.trim().to_string();
        let Some(anchor) = diff_anchor(&self.state).filter(|_| !said.is_empty()) else {
            return;
        };
        self.made += 1;
        let draft = Draft {
            id: self.made.to_string(),
            anchor,
            text: said,
        };
        self.drafts = add_draft(&self.drafts, draft);
        self.comment.clear();
        self.state.set_selection(None);
    }
}

pub fn diff_tab<S: 'static>(
    s: &S,
    get: fn(&S) -> &DiffTab,
    get_mut: fn(&mut S) -> &mut DiffTab,
    k: &Kit,
) -> El {
    let tab = get(s);
    let split = tab.state.mode() == DiffMode::Split;
    let mode = SegmentedControl::new(&["Unified", "Split"], Some(split as usize))
        .label("Layout")
        .on_pick(move |s: &mut S, at, _| {
            get_mut(s).state.set_mode(if at == 1 {
                DiffMode::Split
            } else {
                DiffMode::Unified
            })
        })
        .build(k);
    let diff = DiffView::new(
        move |s: &S| &get(s).state,
        move |s: &mut S| &mut get_mut(s).state,
    )
    .on_select(move |s: &mut S, range, _| get_mut(s).state.set_selection(range))
    .key("diff")
    .build(s, k);
    let comment = TextInput::new(&tab.comment)
        .placeholder("Comment on the selected lines")
        .on_edit(move |s: &mut S| &mut get_mut(s).comment)
        .on_submit(move |s: &mut S, _| get_mut(s).add_comment())
        .build(k)
        .grow(1.0);
    let add = Button::new("Add comment")
        .on_press(move |s: &mut S| get_mut(s).add_comment())
        .build(k)
        .key("add-comment");
    let drafts = tab.drafts.iter().map(|draft| {
        let id = draft.id.clone();
        row()
            .key(format!("draft-{}", draft.id))
            .gap(8.0)
            .center_y()
            .w_full()
            .child(
                text(draft.text.clone())
                    .wrap()
                    .grow(1.0)
                    .color(k.c.text_base),
            )
            .child(
                Button::new("Remove")
                    .variant(ButtonVariant::Ghost)
                    .on_press(move |s: &mut S| {
                        let tab = get_mut(s);
                        tab.drafts = remove_draft(&tab.drafts, &id);
                    })
                    .build(k),
            )
    });
    let send = Button::new("Compose")
        .on_press(move |s: &mut S| {
            let tab = get_mut(s);
            tab.delivery = Some(compose(&tab.drafts));
        })
        .build(k)
        .key("compose");
    let delivery = tab.delivery.iter().map(|said| {
        text(said.clone())
            .key("delivery")
            .label(said.clone())
            .font(k.ty.mono)
            .color(k.c.text_base)
            .wrap()
            .w_full()
    });
    col()
        .gap(8.0)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .child(mode)
        .child(diff)
        .child(row().gap(8.0).center_y().w_full().child(comment).child(add))
        .children(drafts)
        .child(send)
        .children(delivery)
}
