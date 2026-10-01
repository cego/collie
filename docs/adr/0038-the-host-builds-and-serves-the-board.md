# The host builds and serves the board

**Status: accepted.** The host serves the board stream on `FrontDoorRpcs`. The Home
follows it; the text view, chat's `collie_herd` and `collie --json board` read its
snapshot. Nothing else builds a board.

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
directory's installation id, the build, the protocol version, the Herds and every
TaskView), then `Upsert` and `Remove` messages keyed by Task id, each with a sequence
number higher than the last. A client that reconnects gets a fresh snapshot, the same
"current first" rule `watch` follows. The host builds again when anything under its state
directory is written, by itself or by anyone else, and every few seconds, so a time-based
sentence ("silent for") stays true.

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
- Each subscribed client costs one build per change. That is cheap for the handful of
  clients a Machine has. A board shared between clients is the upgrade if it ever is not.
- The host reads every running herdr session on the Machine, and a Task records the Herd
  its workspace is in, so a card names its Herd whichever session started the host.
- The merge watch, News and worktree pruning run in the host, because it is always
  running: Collie learns a merge with no pane open. Each Herd's News comes from the Runs
  whose Task is in it; a Task with no Herd recorded is the host's own Herd's. Event turns stay with each conversation, which reads its Herd's
  News.
