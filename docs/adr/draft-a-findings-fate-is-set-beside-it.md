# A finding's fate is set beside it

**Status: draft.** Decided by plan Runs run-a1ee2c0f (2026-11-11) and run-e43dfea2
(2026-11-24), with the human's answers: Linear filing is a short agent Run, architecture's
deferred candidates are its findings, and review's Improve is its offer over selected
findings.

**Extends:** [ADR-draft-a-runs-own-records-are-rows-in-the-hosts-database](draft-a-runs-own-records-are-rows-in-the-hosts-database.md).

## What was true before

As of `cego/collie@6c0fe8cee` (1.0.28):

- **Only a review's findings could be read.** `findingsIn` read `findings.json` only
  beside a `review.md`. `investigate` returned its findings as Output alone, and
  `architecture` kept the candidates it deferred in its Output.
- **Ids existed only on re-reviews.** With an earlier ledger, a review gave each finding
  `<run>-F<n>` and a status (`open`, `fixed`, `disputed`, `obsolete`). A first review, an
  implement Run's leftovers and older files had none.
- **Open meant written.** Only the rally changed a status. Nobody could say a finding was
  not worth fixing, or send one finding anywhere.
- **The one offer over findings took all of them.** Review's Improve fixed every open
  finding at the reviewed head.

## Decision

**D1. Collie gives a finding its id when it is left.** The leave path keeps the id of a
finding it matches in the file already there (by id, or by file and title) and otherwise
gives the next free `<run>-F<n>`. A file with no ids reads them by position. An agent may
repeat an id it was shown and never invents one. A finding optionally carries `basis`
(`fact` or `inference`), `evidence` and `suggested` (`fix`, `ticket`, `investigate`,
`plan` or `none`).

**D2. A Run's findings are its `findings.json`, whichever report it sits beside.** Implement
takes any such Run directory as its work source.

**D3. Somebody sets a leftover finding's status, never a Choice.** A Choice blocks the Run,
cannot select several at once, and `investigate` has closed by the time a human reads it.
Besides the rally's four statuses, a finding can be `dismissed` with a reason, or `taken`
by the offer and Run that took it, and it can be set back to `open`. The host alone writes
these statuses, as lines in a Run journal with who and when, under a request id. The latest
line wins over the file. A finding is open while its status is `open` or `disputed`. The
host keeps the open count as a fact, so the board never decodes findings to draw a card.

**D4. Acting on findings is an offer that selects them.** An offer declares that it selects
`many` findings or `one`. The caller passes the chosen ids. The host refuses an id that is
not open, starts the child with only those, and records each as `taken` by it. A front door
that wants one Run per finding invokes the offer once per id.

**D5. The pane is Collie's, and the offers are the workflow's.** Desktop draws one findings
pane for any Run that left findings. Investigate and architecture declare Implement
selected. Review's Improve selects. All three declare Investigate further, Plan this and
File to Linear from one module under `workflows/`. Nothing in `src/` names the workflow an
offer starts ([ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).

**D6. Findings hold the card only while something can be built from them.** A settled Run
waits on a human while it has an open finding and an eligible `many` offer over it. A
review of somebody else's merge request and an implement Run's leftover minors do not wait.
Their findings are still listed and can still be acted on.

**D7. Filing to Linear is a short agent Run.** A shipped workflow, `file-issue`, files one
finding through the agent's Linear MCP and returns the issue. Collie adds no Linear client
or credential.

**D8. Architecture's findings are the candidates it deferred.** Its plan and its menu are
unchanged.

## Consequences

- A finding from an older Run gets an id by position and can be selected and dismissed like
  a new one.
- A review whose findings were all dismissed or taken no longer offers Improve, and its card
  can finish.
- Statuses need no table and no migration: they are Run journal lines and one fact.
