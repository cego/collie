# The host builds and serves the board

**Status: accepted.** The host serves the board stream on `FrontDoorRpcs`. The Home
follows it; the text view, chat's `collie_herd` and `collie --json board` read its
snapshot. Nothing else builds a board.

**Amended** by [ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs](draft-the-board-is-a-projection-of-facts-the-host-syncs.md):
D3's rebuild on any write under the state directory is gone; nothing is watched.

**Reverses:** where [ADR-0013](0013-the-board-is-cards-of-tasks.md) D1 has the board built.
The card is still a Task, built by one function; that function now runs in the host and
nowhere else.

## What was true before

Every front door built its own board. The Home pane, the text view, `collie --json board`
and chat's `collie_herd` each called the TaskView builder with inputs of their own, so
they disagreed: the text view never saw a Stalled agent. A builder in the client also
needs the client to read the Machine's files, which a front door on another computer
cannot do.

## Decision

**D1. One builder, in the host.** Each Machine's host builds its TaskViews from its own
state directory. Every front door reads what the host serves; none builds a board.

**D2. A public RPC group beside the internal one.** `FrontDoorRpcs`, in
`src/board-model.ts` with the Schemas it carries, is served on the host's socket beside
`HostRpcs`. `HostRpcs` stays internal and same-build only: a Collie client of another build
stops before sending it anything (ADR-0015). `FrontDoorRpcs` is what a client of another
build, or on another computer, may use. It neither starts nor stops a host. The socket is
still local and nothing listens off the Machine; another computer reaches it through a
bridge on the Machine itself.

**D3. A snapshot, then keyed changes.** `board` streams a `Snapshot` (the state
directory's installation id, the build and whether it is a development checkout, the
protocol version, the Herds and every TaskView), then `Upsert` and `Remove` messages keyed
by Task id, each with a sequence number higher than the last. A client that reconnects
gets a fresh snapshot, the same "current first" rule `watch` follows. The host builds
again when anything under its state directory is written, by itself or by anyone else, and
every few seconds, so a time-based sentence ("silent for") stays true.

**D4. A stable installation id.** The first host to own a state directory writes an id
into it, and every later host reads that id back. Restarts and upgrades keep it, so two
routes to one state directory are one Machine.

**D5. A protocol version, not a build match.** `identity` and the snapshot carry an
integer. An optional field, a new operation or a new kind of stream message does not bump
it. A client reads a message kind it does not know as `Unknown` and skips it. A removal or
a change of meaning bumps it, and from that bump on the host serves its current version
and the one before. Version 1 has none before it.

## Consequences

- One board per Machine. Front doors stop disagreeing about a Task.
- One build per change, however many clients follow the board (amended 2026-10-07, below).
- The host reads every running herdr session on the Machine, and a Task records the Herd
  its workspace is in, so a card names its Herd whichever session started the host.
- A drawer's Run details come from the host too, on a subscription of their own, with
  large items fetched by reference; the TUI reads no Run's files to draw one.
- The merge watch, News and worktree pruning run in the host, because it is always
  running: Collie learns a merge with no pane open. Each Herd's News comes from the Runs
  whose Task is in it; a Task with no Herd recorded is the host's own Herd's. Event turns stay with each conversation, which reads its Herd's
  News.

## Amended 2026-10-13: ready means mergeable now

A TaskView's `ready` used to mean that the leading Run succeeded, its merge request was
open and its checks passed. It now means the forge would merge it now: no draft, Collie's
approved checks passed at the head, CI passed or there is none, no blocking review finding
open, and the forge says it can merge. A client of protocol 3 would read the new `ready`
with the old meaning, which is a change of meaning, so `PROTOCOL` is 4. `readiness`, which
names each missing fact, and the `progress` operation that serves one Run's readiness, steps
and CI to `run show`, `run wait` and chat, are additive.

## Amended 2026-10-12: a paired Machine reaches it over a link

D2's "another computer reaches it through a bridge on the Machine itself" is now one of two
ways. A paired Machine reaches the host through the relay socket its own host keeps for
this one, piped to a TLS WebSocket and declared here by the listener, and it is served the
whole host protocol as a bridge is
([ADR-0057](0057-a-machine-reaches-another-over-a-paired-link.md)). `Where.machine` is
additive, so `PROTOCOL` stays at 2.

## Amended 2026-10-07: one build, shared by every client

Each client used to cost a build of its own per change. On a loaded Machine one build took
27–29 s, so a client's first snapshot came after any front door had stopped waiting, and
every client made every other one slower.

The host keeps one board, the latest TaskViews it built. One builder rebuilds it on the
host's change stream (writes under the state directory, the board tick and herdr events),
starting with the first subscriber and running as long as the host does. At most one build
runs at a time, and changes that arrive during one are folded into the next. A build that
fails, or dies, is logged and skipped, and the last board stands; a client that arrived
before the first good build waits for one.

A subscriber is told a `Snapshot` of the latest board at once, or once the first build is
done, with the head (installation, build, development, protocol, Herds) read for it as before. Then it
is told `Upsert` and `Remove` messages diffed against what it was told, each time the board
is rebuilt. `FrontDoorRpcs` and `PROTOCOL` are unchanged, and a reconnect is still a fresh
snapshot. The side jobs' own board, built without herdr for the merge watch and News, is
not this one.
