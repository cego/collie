# The board is cards of Tasks, not a table of Runs

**Status: accepted.** Built with the Control Plane redesign: three sections of cards, a
decision answered on its own card, the record drawer, the card menu, and the nav rail,
the views, the marks column and the key footer gone.

The Home's board is **one card per Task**, in three sections that answer three questions —
what needs you, what is working, what finished. Everything else about a Task is in its
record, over the board.

**Supersedes:** the parts of [ADR-0005](0005-collie-tab-is-an-application.md) that describe
what the application draws — views behind a nav rail, a row per Run, and a detail panel
beside the list. Its decision is untouched: the tab is still an OpenTUI + Solid application
with Effect owning state and Solid owning rendering, the CLI still must not import OpenTUI,
and the one-screen text view is still the escape hatch. Only what is drawn changed.

## What was true before

The board was a dense table. Every Run was a row; every row carried a dozen columns and
marks; four views sat behind a nav rail; which actions were offered depended on which scope
the board was narrowed to; and a footer of keys changed meaning as the selection moved.
Reading it did not make the human smarter. With ten parallel tasks it said everything and
answered nothing — and the thing a human actually wanted, "what needs me", was a header
inside one view that a filter could hide.

It also drew the wrong unit. A piece of work is a plan Run, an implement Run and a review
of it; the table showed three rows, in three places, and left the human to join them.

## Decision

**D1. The card is a Task.** One card per Task, whatever Runs it took, built by one function
from the Runs, the live agents and the run directories. A Run belonging to no Task is a
card of its own. No herdr id reaches the screen.

**D2. Four sections, in the order the questions are asked.** Needs you (every Task with a
pending Decision), Working (a Run with a live Driver or a live agent — never a record's
`running` on its own), Waiting on you (work that ended without landing: an open merge
request, a plan ready to implement, a failed, stopped or abandoned Run with a branch or
merge request nobody disposed of), Finished (work that landed: a disposition, a Workflow
with nothing to land, or an ending with nothing to file — no branch, merge request, plan or
question; folded to one line until opened). _Amended after a week on the real herd:_ 56
cards read as waiting, 31 of them failed or stopped Runs that never got a checkout, and a
human with four decisions read 56 obligations. Nothing anyone could file is nothing to
wait for. A decision beats liveness, liveness beats history, and history is split
by whether the work landed — because "finished" describing what the process did, while the
human reads it as what their work needs, put their newest work under Finished and two-week
dead Runs under Working. Collie records a `merged` disposition itself when GitLab reports
the merge, in the background; a closed merge request changes only the sentence. The header
sentence counts the whole Herd rather than what the search left, because a decision a query
is hiding is still waiting. Its waiting count is the week's endings; the fold's own line
counts the older ones, because a header saying 56 over four cards worth a look is the
same 56 obligations again.

**D3. One plain sentence per card.** "Fixing the review findings, round 3 of 5." No step
names, counters or glyph codes, so a card is read rather than decoded. Deterministic, and
tested without a renderer.

**D4. Everything else is the record, as an overlay.** Intent, steps, agents, branch and
merge request, review, plan, cards and log are one drawer over the board — over it, never
instead of it, so reading one Task never costs the overview of the others.

**D5. Every action is on the card it acts on.** The menu is computed from that Task's own
state, so nothing is offered that would come back "this run has already finished", and
nothing is withheld because of what the board is showing. There is no scope to be in.

**D6. A Decision is answered where it is.** A question's options, a proposal's Confirm and
Decline, and an evidence gate's Approve / Edit the list / Skip are buttons on the card, with
nothing to select first. All three live in the Run directory, so the CLI and chat answer the
same decision and a closed board loses none of them.

**What is removed:** the nav rail and its four views, the legend row, the filter chips, the
herd meter, the pulse bars, the agent dots, the marks column, the group-by toggle, the
detail panel, the key-hint footer and the per-workspace narrowing. The search is the only
thing that narrows the board; `?` still lists every key over the pane, because a footer
nobody could read is not a reason to stop answering "what are the keys".

## Alternatives rejected

**Keep the table and add a card strip above it.** Two models of the same Runs on one screen,
disagreeing the first time one of them was filtered. The table's problem is that it is the
unit of work that is wrong, not that it is too small.

**A card per Run.** It keeps the join the human should not be doing, and a plan that spans
four repositories becomes five cards that each say a quarter of the truth.

**Lanes, and a wall of tiles** (the round-one sketches). Both trade the sentence for
density, and the sentence is the thing that answers "what is happening" without decoding.

## Consequences

One model, three renderings: the Home's cards, the one-screen text view and
`collie --json board` are the same `TaskView` list, so an agent reading the CLI and a human
reading the pane cannot disagree about a Task.

Keys are shortcuts for what is on screen, not a vocabulary to learn: `Tab`, `/`, `Esc`, `m`,
`r`, `?`, `q`, and the key beside each menu item. Nothing is reachable by key alone, and
`?` is the one list of them.

The board no longer narrows to a workspace, which leaves `scope` in `config.json` deciding
nothing a human can see. It is read at launch and still validated; what to do with it is
open.

The Live region went with the detail panel, and two things it carried have no home on the
board yet: the Home's ownership question and the count of news the conversation has not
taken. Ownership is answered before a board is drawn — the shortcut refuses to open a board
it cannot prove is this Herd's, names the candidates and prints `collie home reconcile` —
and `collie chat status` counts the news. Neither is on the board, and that is a gap rather
than a decision.
