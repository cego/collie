# Ready to ship is a section of its own

Builds on [ADR-0025](0025-a-card-is-facts-and-an-offer-is-a-declaration.md) (an offer is a
declaration), [ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)
(a workflow's name decides nothing),
ADR-draft-a-merge-request-is-released-on-a-humans-go and
ADR-draft-a-task-lands-when-what-it-owes-is-settled.

**Ready to release** sorted mergeable work to the top of Waiting on you. A Release Run's
**Go** was a Decision, so it sat in Needs you beside real blockers. A human could not see at a
glance which cards needed only their go and which needed work. The human asked for this on
2026-11-11 and kept Waiting on you for handoffs that are not ready.

## Decision

**D1. The board has five sections:** Needs you, Ready to ship, Waiting on you, Working,
Finished.

- Needs you: a question, a blocker, or a decision needed before work can go on.
- Ready to ship: every gate of the next shipping action holds at the merge request's
  current head, read fresh, and only the human's go is left.
- Waiting on you: work that has ended and still owes something, and is not ready.
- Working: something is doing the work, or the Task waits on CI or a teammate while a Run
  is going.
- Finished: everything the Task owes is settled.

**D2. The card names its action: Merge, Stage or Deploy.** Each action keeps its own gates,
and staging gets no merge gates.

- Merge: a Task in Waiting on you whose owed merge request is Ready to release. The card's
  action is the existing `Release` offer. The Release Run it starts still asks its own Go,
  so who may do what is unchanged.
- Merge, Stage or Deploy: a Run asking a Go whose question declares the action it ships.
  Collie reads the declaration, never the workflow's or question's name.
- A Stage Run asks for no Go, so it is never Ready to ship.

**D3. Readiness is derived, fresh and revocable.** It is computed only from forge answers
read within the freshness window (two merge-watch rounds) at the merge request's current
head, and from the Run's own proof for that head. An unknown, stale or unreadable fact
never makes a Task ready. A moved head, a failed gate or an answer that has gone stale
takes the card out of Ready to ship. A Go that no longer holds is a blocker in Needs you
and names what failed.

**D4. One reading at the host.** The section and its action are part of the TaskView the
host builds. The CLI, the text board, Desktop and chat read that TaskView, and none of them
decides readiness again. A card entering Ready to ship raises no notification of its own.

## Rejected

- **A Ready to release sub-list inside Needs you.** That puts healthy handoffs back in
  among blockers.
- **One gate list for every action.** Staging an open merge request needs no approval
  (ADR-draft-an-open-merge-request-is-staged-by-a-run-of-its-own).
- **Pre-answering the Release Run's Go from the card.** The Go is asked on the Run once
  the work is ready, and it holds for one head.
