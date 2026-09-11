# The Collie tab is the Herd's

**Status: accepted.** Built, and the board is the Home's: ownership, the shortcut, the
filters, the new-run target question and the legacy redirect all land here. What remains
outstanding is live evidence rather than design — see Consequences.

There is one Collie per herdr session — the **Herd** — and its board lives in one
workspace of that session, the **Home**. Not one board per workspace.

**Supersedes:** the sentence in [ADR-0006](0006-a-run-stays-in-the-workspace-it-was-started-from.md)
about where the Collie tab is created. Nothing else in that ADR changes: a Run still stays
in the workspace it was started from, its steps still open there, and its worktree is still
local to it. Only the board moved.

## What was true before

A Collie tab was created per workspace, found by its label, and used for three unrelated
things at once: rendering the board, receiving a Run's questions, and anchoring tab order.
The label was the identity, so two workspaces called the same thing were indistinguishable,
and a Run in one workspace reordered tabs in another whenever the board it found was not
where its work was.

## Decision

**One Home per Herd**, keyed by the canonical path of the session's socket. Never by a
directory: a cwd keys two sessions in one repository together and one session across two
repositories apart.

**Ownership is a record plus proof**, never a label. Collie's own `home.json` names a
workspace; what makes that still true is either a live `collie_home` token on the workspace
or the recorded pane still carrying the recorded `terminal_id`. Either alone is enough, and
the second is what heals an expired token — the pane is still there, so the claim was true
and the TTL merely lapsed.

**A label is never proof.** Two workspaces can be called the same thing. A live token with
no record is not proof either: it is a previous Collie's Home or another state directory's,
and adopting it silently would be one Herd taking over another's board.

**Anything uncertain stops.** `ownership_unknown` names the candidates and waits for
`collie home reconcile --adopt` or `--forget`. Two things must never happen: a second Home
created because a token expired, and a workspace adopted because it looks right.

**Filters are a view property.** What the board shows — `all`, one workspace, one Run —
never changes what Collie supervises. A Run outside the current filter is still driven,
still checked and still corrected.

**Workers stay local.** Step tabs and worktrees remain in the Run's own workspace. The
board tab (`RunCtx.boardTabId`) and the tab-ordering anchor (`RunCtx.orderAnchorTabId`) are
now separate values, because they were always separate questions.

**Focus is only ever a question.** `questions: focus` brings a pending human question to
the Home, exactly as it did to the workspace tab. Cards, corrections and proposals never
focus anything: something arriving must not move a human off what they are doing.

**Legacy panes redirect rather than being closed.** A per-workspace Collie pane shows a
redirect notice on its next launch on the new binary. `collie home cleanup --confirm`
closes only panes that carry the legacy token **and** are alone in their tab; anything
sharing a tab is listed, because closing it would take somebody's window away.

## Alternatives rejected

- **The first workspace that invokes it hosts the board.** Whichever workspace happened to
  be first is not a property anybody can predict or explain afterwards.
- **Mirror tabs in every workspace.** Several views of one state, each able to drift, and
  nothing to say which one a human is looking at.
- **Read-only pointer mini-boards.** A pointer is a thing to keep in sync; the maintainer
  rejected them for that reason.

## Consequences

`prefix+1` is no longer promised to be Collie outside the Home; inside a workspace that is
not the Home, that key is whatever herdr's own ordering makes it. The shortcut therefore
switches workspace, which is a visible change and is documented as one.

The Home rests on herdr features the pinned contract cannot vouch for at runtime, so there
is a **runtime capability gate** distinct from `contract:check`:
`bun run tools/herdr-runtime-check.ts` asks the installed binary, and a missing feature
makes the board refuse with `herdr_capability_missing:<name>`. There is no label-only
fallback, deliberately — falling back would reintroduce exactly the ambiguity this ADR
exists to remove.

What is **not** proven here is the live half: the gate and the ownership matrix are tested
against a fake herdr, and nothing in this repository can show a real herdr session moving
a workspace out from under a live Home. That needs an operator at a running session, and
until then the honest claim is "the rules are the rules, and the fake obeys them".
