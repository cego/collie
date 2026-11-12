# A Change waits on another Run's Change to merge, as a Wait

**Status: draft.** Decided for cego/collie#373. Builds on
ADR-draft-a-tasks-merge-requests-are-its-waves-changes (Changes and Waves) and
ADR-draft-a-run-recovers-where-it-parks (Park causes).

## Context

A plan orders its own tickets with `**Blocked by:**`, which names only tickets of that plan.
Nothing let a ticket say it needs a Change another plan's Run is building. Builders found the
prerequisite missing from the default branch, asked their planner again and again, and waited
only once a human put a Hold on the Run.

## Decision

- **D1. A ticket names what it needs on a `**Needs merged:**` line.** Each entry is a Run id,
  then optionally the name of that Run's Change; no name means that Run's default Change. For
  example: `**Needs merged:** run-ac644eef card, run-e15f4a62`. Entries are separated by commas.
  The Change is in the ticket's own repository. A line Collie cannot read stops the hand-off,
  like a bad `**Blocked by:**` line.
- **D2. It is a Wait, not a park.** The Change run builds every ticket whose blockers are built
  and whose prerequisites have landed. When none is left, it waits on the next ticket's
  prerequisites. The card reads `Waiting for <run>'s <change> to merge.` It polls every 5
  minutes and spends no model tokens. A Hold or a Stop ends it.
  - Rejected: a park with a `rechecks` cause. A park counts as something that went wrong.
    `self-improve` would file `park-<cause>` as a defect every day for an ordinary wait.
  - Rejected: building anyway. That is the defect.
  - Rejected: stacking on the other Run's branch. That Change belongs to another Task, and
    its review and merge belong to its own Run.
- **D3. Landed means the commit is on the default branch.** The forge says the prerequisite's
  merge request is merged, and its merge commit is reachable from the default branch the
  waiting Run fetches. Before the ticket's build, that branch is merged in, the same way as at
  every ticket boundary. This includes the first ticket.
- **D4. The wait ends only on facts.**
  - It ends when every named Change has landed, or when the ticket no longer names it, since
    the ticket file is read again on each poll. Editing the ticket is how a human or an agent
    says "go anyway".
  - It needs you, through a park caused by a failed Step, when the named Run is not on this
    host, or is this Run or one of its ancestors. It also needs you when the named Run ended
    without a merge request for that Change, or when that merge request was closed unmerged.
  - A wait that lasts past the 2 days a person is given becomes the existing overdue park.

## Consequences

- A Change that needs another plan's work is built on a default branch that already has that
  work. Nobody has to place a Hold.
- A Run on another Machine of the Flock cannot be named yet. The wait says so and needs you.
