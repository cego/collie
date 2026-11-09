# The host reads records on a thread of its own

**Status: proposed** by run-7edf83ac, on the human's word (2026-11-03): "I don't mind large
architecture changes. We don't want cache or anything that masks a bad architecture."

**Amends:** [ADR-draft-a-runs-record-is-read-from-its-hosts-run-model](draft-a-runs-record-is-read-from-its-hosts-run-model.md).
A record is still read from a Run model. This ADR says which thread reads it.

## What was true before

One event loop and one heap did everything: the engine's Steps, SQLite, the board, every
front door's request and every record. Under a start storm (one start every 200 ms, six Steps
each, on 520 Runs) the host allocated 89 MB/s with nothing open. Each collection of that heap
paused the loop for 18–30 ms. A record opened during the storm took p50 57–72 ms and p95
104–157 ms. A ping to the host (`identity`) waited up to 52 ms.

Two changes that kept one thread were measured and did not help:

- SQLite on tmpfs, so every fsync was free: p95 stayed near 103 ms, ping p99 near 26 ms.
- Fewer board builds: the board was not what the storm spent.

What delayed a record was the engine sharing a heap and a loop with it.

## Decision

**D1. A door thread owns the socket.** `src/door.ts` runs as a Bun Worker, which has its own
heap and its own loop. It binds `host.sock`, decodes each connection's frames and answers two
requests itself:

- `identity`;
- `runDetail`, while the Run model is on.

Every other frame goes to the engine on the main thread, tagged with its connection. That
includes each forwarded request's `Ack` and `Interrupt`. Each connection is still one client of
the engine's RPC server, so a connection's declared actor still holds (ADR-0039). The host stops
when its door stops.

Every connection's frames reach a server through one loop on each side (`passFrames`), so what
happens to one frame is that frame's alone. Effect's server refuses a frame from a client that
has already sent `Eof` while one of its requests still runs — a CLI half-closes on its way out —
by interrupting the effect that wrote it. Once that interruption ended the shared loop, so every
later request from every client waited forever while `identity`, the door's own, still answered.

**D2. The engine tells the door what only the engine knows.**

- After each board listing, the engine sends each Run whose view moved. The message holds the
  Run's facts and the revision its view was read at. A going Run's view is read every time, so
  it is sent with no revision.
- With the listing go the offers its board read: a record's Flow shows only a ready plan's
  first offer, which is the card's. Reading every Run's offers for the door held its first
  listing back by 2.9 s on 520 Runs.
- The engine sends the agents herdr last showed, as soon as it reads them anew. A drawer opened
  after `run show` read herdr then draws the same liveness.
- The engine sends every invalidation in its Run model.

The door asks the engine in two cases:

- for the Runs of a record, when the facts it holds are older than their Run's revision, or
  carry no revision;
- for a merge request panel, when the Run has a merge request;
- for a Run's offers, when its board has not read them.

**D3. One numbering.** Both Run models take revisions from one counter in shared memory. Each
tells the other every Run it moved. So a card's revision, a record's revision and an act's
`shown` still compare. A store write moves the revision of each Run it names, so a row or a
decision that moves shows up as a newer revision. The door tells the engine the revision at which
a record first showed a Step finished. The engine checks acts against it, and the door sends that
before it passes on any act a human pressed afterwards.

**D4. Read-your-writes holds across the threads.** The engine posts an invalidation or a revision
before it answers the write that caused it. One port carries both, in order. So a client that
opens a record after a write sees the write.

## Considered

- **SQLite on a worker of its own.** It moves 1.7 ms of fsync per commit. It leaves the
  collections that pause the loop. Measured: not enough (see above).
- **Caching more of the record.** The human ruled it out. It would hide the contention, not
  remove it.
- **The engine on a worker, the door on the main thread.** The same split the other way round.
  But signals, the lock, `chdir` and the stop would all move with the engine. The door is the
  smaller thing to move.

## Consequences

- A record's live updates follow the board's listing: a write is re-read once the board has
  listed it, or at once through an ask.
- The release binary carries `src/door.ts` as a second entrypoint (`tools/build.ts`).
- The door loads the record's modules a second time, on its own heap. That heap's JIT has
  compiled none of them, so at its first listing the door reads the records of the first ten
  Runs listed, telling the engine nothing of them. Under a start storm, the first 20 opens
  after a start averaged 45 ms without that and 29 ms with it. It keeps no more than opening
  those records would.
