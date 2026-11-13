# A Run's record is read from its host's Run model

**Status: proposed** by run-a0ae10bb; to be built by its plan.

**Amends:** [ADR-0038](0038-the-host-builds-and-serves-the-board.md), its consequence that "a
drawer's Run details come from the host too, on a subscription of their own". They still do. This
ADR says what the subscription is read from, and what it promises about freshness.

## What was true before

Desktop opens a Run's record with one `runDetail` stream. Every value it sends is built from
scratch:

- every Run's view;
- the global board inputs, with a marker file per Run;
- a scan of every Run for plan tickets;
- for a live Run, a `git diff`.

It is built again on every write, every herdr change and every 5 s board tick, on the same event
loop as the board, which is also rebuilt from scratch each time (4–8 s on vm-mk at ~550 Runs). The
stream carries no revision. Desktop drops it when the record closes. A click took several seconds to
show a Flow. The tune-ups that sped up `collie_run`, `shown` and `runs` never reached it, because
nothing timed a stream.

## Decision

**D1. One Run model per host.** The host keeps each Run's facts in memory, with indexes by Task,
parent, requester and plan. A host write, a `store.changes` event or the state directory's watch
dirties exactly the Runs a change names. The board and every Run's record are derived from the
model. Nothing derives them from a fresh read of every Run. The model is memory only: a host start
fills it from disk, and nothing about it is persisted.

**D2. A revision is a host epoch and a change sequence.** It is a Run revision, not a commit. The
epoch is the installation id plus that host's start id. Each change to a Run takes the next number of one monotonic sequence. A Task's
revision is the highest across its Runs. Every record frame and board item carries its revision.

**D3. A record is the Flow first, then its parts.** The first frame holds the Flow and everything it
draws, at one revision. The record's other parts follow in later frames of the same stream, each at
a revision: the diff, the log tail, the merge request's forge state, which shows its `asOf`, and
the long texts. A frame is sent only when its revision moves. A bare tick moves nothing. Time-derived
text is computed from timestamps where it is drawn.

**D4. Current or labelled, never silently stale.** A front door shows a record as current only while
a live subscription at the host's current epoch backs it. A kept record is resumed by sending the
epoch and revision it holds: the host answers `unchanged`, or sends a fresh frame. Until that answer
arrives, and while the Machine is unreachable, the record says so, with its `as of` time, and its
actions are disabled with that reason.

**D5. An action names the revision it was shown at.** The host checks the action against the Run's
current state. A precondition that no longer holds is refused with a typed error, which the record
shows: an act on a Step is stale only where that Step finished after the revision it was shown at,
and a Step shown going again finishes anew. Read-your-writes keeps the board's rule: after a write, a reader sees that write's revision
or a later one.

**D6. Interactive reads come first.** Every front-door answer is served first, ahead of board
derivations, the Cleanup sweep and Measurements. Background work yields in bounded slices:

- The board is derived incrementally. A Task's card is kept with the key it was derived from: its
  Runs' revisions, their markers, its agents, its pending work and its merge requests' states. It is
  derived again only when that key moves, or when the time it shows is due to change. A tick that
  moves nothing derives nothing.
- A pass over many Runs (the model's fill, a re-derive, the engine's sweep, Cleanup) takes a slice
  boundary before each Run. While any front-door answer is being served, a boundary
  holds its pass, for at most 250 ms, so a busy front door cannot starve the board.
- Every RPC handler is served through the shared wrapper. A stream's lease ends on its first
  value, termination or after 250 ms, whichever comes first. Expiry clears its producer's
  foreground priority without cancelling it or changing its values or errors. Idle notifications
  and ongoing Measurements stay background. `bench/front-door-wait.ts` measures `verify` first values, `read` answers and board builds
  on the record-open fixture's host.
- A read awaiting a fresh board suspends only its own lease, so the build can advance. It
  restores that lease only while live, including after errors or cancellation. The board still
  covers the writes seen before the read; readiness and merge-request facts are not taken from an older board.
- Physical file operations and commands temporarily release only the requesting lease's background hold.
  The lease keeps its scheduler priority and original deadline. Its hold returns after all overlapping
  waits finish, only while the lease remains live. Errors and cancellation follow the same cleanup.
  The physical FileSystem service and its file handles apply this uniformly; stream reads and sink
  writes use those handles. Other requests' holds remain effective.
- The host's scheduler ends a turn of the event loop once it has run fibers for 8 ms, so a request
  waiting behind background fibers is read at the next turn. A fiber serving a read queues its
  tasks ahead of every other fiber's, and the others yield while one waits, so a Run start steps
  aside at its next yield without boundaries of its own. Under a storm of 5 starts a second this
  does not reach 60 ms: no single step of a start is long, but together they fill the thread.
- Cleanup judges through the model, as the board reads, and its decisions are unchanged.
- A record reads herdr's agents as the board last read them, and does not wait on a read in flight.

## Considered

- **Cache Desktop's last record and show it at once.** Fast, but it shows a Flow that may be wrong.
  Rejected unless it is labelled as D4 says, and a labelled record does not count as having been
  shown.
- **Cache file contents (the read model of PR #271).** It made the board build cheaper but left the
  record O(all Runs), and its entries cost memory per file read. Superseded in its role by D1.
- **A worker thread for the board.** It isolates CPU, but copies the whole state across a thread
  boundary. It was kept as the fallback if D6's event-loop guardrail failed with D1 in place. With D1
  and D6 built, it is not built. The lag that remains comes from JavaScriptCore's Eden collections on
  the main thread. Their stop-the-world pauses are 11 to 27 ms, at most 40 ms, about once a second at
  a ~100 MB live heap. They come with no board pass running: an idle host with three live Runs
  pauses 15 to 22 ms. A worker would not remove them. Much of that pause was ~46k live `Error`
  objects: each kept read held its lookup's fiber with a call-site `Error`, and each missing
  file's failure held three more. Kept as plain values, the heap holds under 1k, and the pause
  under back-to-back record opens fell from 25 to 11 ms.
- **Raise or remove timeouts.** It hides the latency and fixes nothing.

## Consequences

- The record's cost scales with its Task, not with the Machine's number of Runs.
- An older Desktop still receives a full record. Revisions and parts are additive, so the protocol
  version stays unless a field is removed (ADR-0038 D5).
- A host setting switches the model off for one release, restoring today's from-scratch path.
  Because the model is memory only, rollback needs no migration.
