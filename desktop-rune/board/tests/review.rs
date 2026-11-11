//! `desktop/test/review-comments.test.ts`, with each diff anchor taken from a rune-kit Diff's
//! selection.

use collie_desktop_board::record::review::{
    Anchor, Draft, add_draft, clear_sent, compose, diff_anchor, edit_draft, in_hunks, plan_anchor,
    remove_draft,
};
use rune_kit::diff::{DiffState, LineRange, LineRef, Side, parse};

fn plan(id: &str, file: &str, quote: &str, text: &str) -> Draft {
    Draft {
        id: id.into(),
        anchor: Anchor::Plan {
            file: file.into(),
            quote: quote.into(),
        },
        text: text.into(),
    }
}

const HEAD: &str = "2 review comments from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.";
const REVISE: &str = "Revise the plan and tickets where these comments call for changes. Preserve the Run's scope and constraints. Leave its next-choice menu unanswered.";

#[test]
fn a_selection_that_is_empty_or_only_whitespace_is_no_anchor() {
    assert_eq!(plan_anchor("SPEC.md", ""), None);
    assert_eq!(plan_anchor("SPEC.md", " \n\t "), None);
    assert_eq!(
        plan_anchor("issues/01-a.md", "  the words  "),
        Some(Anchor::Plan {
            file: "issues/01-a.md".into(),
            quote: "  the words  ".into()
        })
    );
}

#[test]
fn drafts_are_added_in_order_edited_and_removed_by_id() {
    let one = plan("a", "SPEC.md", "x", "first");
    let two = plan("b", "SPEC.md", "y", "second");
    let drafts = add_draft(&add_draft(&[], one), two.clone());
    let ids: Vec<&str> = drafts.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["a", "b"]);
    assert_eq!(edit_draft(&drafts, "b", "sharper")[1].text, "sharper");
    assert_eq!(remove_draft(&drafts, "a"), [two]);
}

#[test]
fn a_send_clears_only_the_drafts_it_carried_as_they_were_sent() {
    let drafts = [
        plan("a", "SPEC.md", "x", "1"),
        plan("b", "SPEC.md", "y", "2"),
    ];
    let meanwhile = plan("c", "SPEC.md", "z", "3");
    let edited = edit_draft(&drafts, "b", "2, sharper");
    let all = [edited.clone(), vec![meanwhile.clone()]].concat();
    assert_eq!(clear_sent(&all, &drafts), [edited[1].clone(), meanwhile]);
}

#[test]
fn the_message_numbers_each_comment_in_the_order_written_with_its_place_quote_and_words() {
    let words = "Drop this.\n\n  Keep *that*, exactly as I typed it  ";
    assert_eq!(
        compose(&[
            plan(
                "a",
                "SPEC.md",
                "The tab reads\nthe files again",
                "Is this true?"
            ),
            plan("b", "issues/02-plan.md", "stamp", words),
        ]),
        [
            HEAD,
            "",
            "1. the plan's `SPEC.md`",
            "> The tab reads",
            "> the files again",
            "",
            "Is this true?",
            "",
            "2. the plan's `issues/02-plan.md`",
            "> stamp",
            "",
            words,
            "",
            REVISE,
        ]
        .join("\n")
    );
}

#[test]
fn a_plan_revision_instruction_preserves_exact_comments_and_does_not_select_an_implementation_choice()
 {
    let words = "  Start with DEV only.\nDo not lose this whitespace.  ";
    let message = compose(&[plan("p", "SPEC.md", "STAGE", words)]);
    assert!(message.contains(words));
    assert!(message.contains("Revise the plan and tickets"));
    assert!(message.contains("Leave its next-choice menu unanswered."));
}

#[test]
fn one_comment_is_said_as_one() {
    assert_eq!(
        compose(&[plan("a", "SPEC.md", "q", "c")]).lines().next(),
        Some(
            "1 review comment from the human in Desktop. Each names where it is, quotes what it is about, then says what they want."
        )
    );
}

#[test]
fn a_long_quote_keeps_its_start_and_end_300_characters_in_all() {
    let quote = format!("{}{}", "a".repeat(200), "b".repeat(200));
    let said = compose(&[plan("a", "SPEC.md", &quote, "c")]);
    assert_eq!(
        said.lines().nth(3),
        Some(format!("> {}…{}", "a".repeat(150), "b".repeat(149)).as_str())
    );
    let short = "c".repeat(300);
    let said = compose(&[plan("a", "SPEC.md", &short, "c")]);
    assert_eq!(said.lines().nth(3), Some(format!("> {short}").as_str()));
}

const CHANGED: &str = "diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
@@ -20,3 +20,5 @@ fn
 twenty
+inserted
+again
 twentyone
 twentytwo
";

const DELETED: &str = "diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1111111..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
";

/// The anchor of a rune-kit Diff of `CHANGED` with `start..end` selected.
fn selected(start: (Side, u32), end: (Side, u32)) -> Anchor {
    let mut diff = DiffState::new(parse(CHANGED));
    diff.set_selection(Some(LineRange {
        file: 0,
        start: LineRef::new(start.0, start.1),
        end: LineRef::new(end.0, end.1),
    }));
    diff_anchor(&diff).expect("a selection")
}

fn on(side: Side, first: u32, last: u32, lines: &[&str]) -> Anchor {
    Anchor::Diff {
        path: "src/a.ts".into(),
        side,
        first,
        last,
        lines: lines.iter().map(|l| l.to_string()).collect(),
    }
}

#[test]
fn a_diff_anchor_quotes_a_line_range_on_either_side() {
    use Side::{New, Old};
    assert_eq!(
        selected((New, 21), (New, 21)),
        on(New, 21, 21, &["inserted"])
    );
    assert_eq!(
        selected((New, 22), (New, 20)),
        on(New, 20, 22, &["twenty", "inserted", "again"])
    );
    assert_eq!(selected((Old, 2), (Old, 2)), on(Old, 2, 2, &["two"]));
    assert_eq!(
        selected((Old, 1), (Old, 3)),
        on(Old, 1, 3, &["one", "two", "three"])
    );
}

#[test]
fn a_range_from_one_side_to_the_other_is_only_its_first_line_so_no_line_is_misquoted() {
    assert_eq!(
        selected((Side::Old, 2), (Side::New, 3)),
        on(Side::Old, 2, 2, &["two"])
    );
}

#[test]
fn nothing_selected_is_no_anchor() {
    assert_eq!(diff_anchor(&DiffState::new(parse(CHANGED))), None);
}

#[test]
fn a_line_is_in_the_hunks_only_where_the_patch_shows_it_on_the_side_asked() {
    let changed = &parse(CHANGED)[0];
    let deleted = &parse(DELETED)[0];
    assert!(in_hunks(changed, 2, Side::New));
    assert!(in_hunks(changed, 24, Side::New));
    assert!(!in_hunks(changed, 10, Side::New));
    assert!(!in_hunks(changed, 25, Side::New));
    assert!(in_hunks(changed, 22, Side::Old));
    assert!(!in_hunks(changed, 23, Side::Old));
    assert!(in_hunks(deleted, 2, Side::Old));
    assert!(!in_hunks(deleted, 1, Side::New));
}

#[test]
fn a_diff_draft_is_located_by_its_path_and_lines_and_by_the_side_as_it_was_for_removed_ones() {
    use Side::{New, Old};
    let diff = |id: &str, start: (Side, u32), end: (Side, u32)| Draft {
        id: id.into(),
        anchor: selected(start, end),
        text: id.into(),
    };
    let said = compose(&[
        diff("one", (New, 21), (New, 21)),
        diff("many", (New, 20), (New, 22)),
        diff("was", (Old, 1), (Old, 2)),
        diff("was-one", (Old, 2), (Old, 2)),
    ]);
    let places: Vec<&str> = said
        .lines()
        .filter(|line| {
            line.split_once(". ")
                .is_some_and(|(n, _)| n.parse::<u32>().is_ok())
        })
        .collect();
    assert_eq!(
        places,
        [
            "1. `src/a.ts:21`",
            "2. `src/a.ts:20-22`",
            "3. `src/a.ts:1-2` (as it was)",
            "4. `src/a.ts:2` (as it was)",
        ]
    );
    assert!(said.contains("> twenty\n> inserted\n> again"));
}
