# The board is a projection of facts the host syncs

**Status: proposed** by cego/collie#523.

**Amends:** [ADR-draft-a-runs-record-is-read-from-its-hosts-run-model](draft-a-runs-record-is-read-from-its-hosts-run-model.md)
D1 (nothing about the Run model is persisted, and the state directory's watch dirties Runs) and D6
(incremental derivation, now persisted); [ADR-0038](0038-the-host-builds-and-serves-the-board.md)
D3 (a build follows any write under the state directory). **Extends:**
[ADR-0040](0040-the-host-is-the-only-writer.md), from `host.db` to every fact the board reads.

## What was true before

On vm-mk (1.0.23, about 880 Runs and 40 agents) the host's first board after a start took 64 s, and
every later build took 47–55 s. Desktop acts on a Machine only once its first board arrives, so for
a minute after each host start every action was refused with "still connecting".

The board was not read from the database. Each build derived every card again from the outside
world. A trace of one 47 s build:

- about 35 s asking the forge: each review card with open findings read its merge request,
  approvals, discussions and the forge login on every build;
- about 10 s hashing workflow source trees, about 120 times per build, to learn a revision that
  had not changed;
- under 1 s deriving the cards themselves.

The host also held a recursive watch over the state directory, a watch of each checkout's git
directories, a watch of each open record's `handoffs/` and `evidence/`, and watches of the user
directory for peers.

## Decision

**D1. The board is a projection in `host.db`.** `collie_cards` keeps one row per Task: its
TaskView, the digest of what it was derived from, the time it is next due to change and when it
was written. A row is written only when its view, digest or due time moved. The digest is taken
from content, not from epoch revisions: each Run's facts, when each Run last did anything, and
every other input the card read, including the forge, git, Connection and module rows below.

**D2. A host's first board is the rows.** Before the Run model has filled, a host serves the
previous host's cards, each with `confirmed: false` and the `asOf` time it was written. As the
first pass derives each Task's digest, a card whose digest still matches is confirmed without
deriving it. A changed one is derived and sent as an Upsert. The Run model itself stays memory
only. The engine answers the front door only once it has started its Runs, which takes seconds,
so until it serves the door thread answers a board itself: a Snapshot of the rows,
read over its own read-only connection, followed by whatever the engine sends.

**D3. A card's derivation reads only the Run model and `host.db`.** Syncers keep the outside
world as rows, and each write names what it moved through Reactivity:

- **Forge sync** is the Merge watch, widened. `collie_merge_requests` replaces
  `board/mr-states.json`, which the first start imports once and leaves for a downgrade. Each row
  also keeps author, approvals and whether a discussion is unresolved. A merge request on a card
  is read every minute, others every 5 minutes, and one a Run just published is read on the next
  round. The forge login per host is kept with its read time and read again hourly. A listing's
  offers read these rows. Taking an offer reads the forge again.
- **Git sync** keeps `collie_branches`: per checkout and branch, its head, the project its
  checkout pushes to, which resolves a bare or legacy merge request reference, and how the
  pushed branch moved past the finished record. It reads the branches of each card that moved
  (a turn, a Step's end, a publish or a push moves it) and every live card's on the 5-minute
  backstop. It also keeps what a follow-up would enter at, as the Run fact `synced-recovery`.
- **Module revisions** keep `collie_module_revisions`, one row per workflow layer directory.
  A listing reads the row. A Run's start, an offer taken, `collie workflow create`, `fork` and
  `check`, and the 5-minute backstop compute it and keep it. The revision also keys what
  discovery last read from the layer, its entries and faults, kept in the host's memory with
  nothing expiring on a clock. A listing whose revision has not moved reuses that
  read, so it imports no module and hashes no tree; any other read imports every entry
  again and replaces it (cego/collie#534).
- **Connection readings** keep `collie_connections`, per Connection and checkout. A listing
  reads the row. One it finds missing is read at once by the syncer and offered once it is.
  Taking an offer reads the Connection again.

**D4. Nothing is watched.** A write moves the board when it goes through the host's Run model,
when the host is told of it, or when an agent's turn starts or ends, which reads that agent's
Run directories again. A process other than the host says what it wrote with the front door's
`wrote`: the question hook, and the workflow commands. A 5-minute backstop poll covers git
checkouts and workflow layers changed outside Collie, and offers what peers share again. A file
written under the state directory by anything else moves nothing until one of those happens.
Under `COLLIE_HOST_REFUSES`, which the suite sets, the host's file system refuses `watch`, and a
card's derivation runs with a process spawner and HTTP client that refuse.

**D5. Sweepers read only this host's builds.** Cleanup's Task closing, worktree settling and idle
agents read the boards this host derived, never the rows a previous host left.

## Consequences

- A host's first Snapshot no longer waits on the forge, git, module trees or the engine's
  start. The bench gate `bench/board-reads/first.ts` measures spawn to first Snapshot on a
  snapshot and fails above 1 s: on vm-mk's state (11-18), the release binary took 439–558 ms.
- A card can show the forge, git or a module as the syncer last read them: at most a minute
  for a merge request on a card, and 5 minutes for a change made entirely outside Collie.
- A state directory an older host left has no rows. Its first start derives every card before
  its first Snapshot, as before, and writes the rows the next start serves.
- What an agent writes reaches its card when its turn ends. Output and findings submitted
  through the host (#518) will move it at once.
