# Collie's own records live in the host's database

**Status: proposed** on the human's word (2026-11-09): "Caching is a last resort", and, asked
whether the records could move into the host's SQLite database, "yes please".

## What was true before

The host kept four kinds of its own records as files in the state directory. Each file was
the only truth, even about a change the host had just made:

- Tasks: one JSON file each under `tasks/`.
- The agent registry: one JSON file per scope under `agents/`.
- Delivery ledgers: one `deliveries.jsonl` per agent incarnation under `agents/<hash>/`.
- The proposals journal: `herd/<key>/proposals.jsonl`.
- Launch records: one `agents/<run>/<operation>.launch.json` per launch, and the Run's
  launch order in `agents/<run>/launches`.

Any write under the state directory rebuilt the board, about once a second on a busy
Machine. Each build listed and schema-decoded every Task file (419 of them) and every
registry file. When a card asked whether a finished Run had been reopened, the build also
decoded every delivery ledger and then filtered every delivery for each such Run. Traces of
the live host (0.119.1, 2026-11-09) put a build at p50 435 ms and p90 1.15 s. Listing Tasks
took 18 % of build time, and the delivery read behind `reopenedOf` took 15 %. Nearly all of
those files had been written by the host itself, which already held the typed value it
wrote.

Caching the decoded files would have hidden that cost, not removed it.

## Decision

**D1. The five kinds are tables in `host.db`.** These are `collie_tasks`, `collie_agents`,
`collie_deliveries`, `collie_proposals` and `collie_launches`, created by the same migrations
as `collie_runs` and `collie_decisions`. A row holds the fields that callers look up by, which
are then indexed: a Task by workspace, a delivery by Run, agent and causal key, a proposal by
Run, a launch by Run and operation, and by agent, with its place in the Run's launch order.
The rest of the record is kept as its JSON. Launch records joined after 0.120.0, whose host
still read every Run's launch files on every pass of its question tending, about every 190 ms.

**D2. The host is the only writer.** The registry, ledgers, proposals and launch records
were already written only by the host. A Task created by `collie run start --here` from the CLI or the
board is now created by the host as part of the start request. The file locks around these
records (`withTaskLock`, the registry's and ledgers' locks) go away: a write is a
transaction.

**D3. Every other process reads through the host.** The board process, `collie mcp`,
`collie tools` and the CLI ask the host over its RPCs. This leaves the tables' shape the
host's to change. The door Worker runs in the host's process, from the same build, so it
reads with a read-only connection of its own.

**D4. A write says what it changed.** Each table's writes invalidate their own Reactivity
key, as the Run store's already do. The board learns which Tasks moved from the rows that
changed, not from a write somewhere under the state directory.

**D5. Existing files are imported once.** The first host to run the migration imports every
file of each kind into its table, in one transaction, and records that it did. It
leaves the files where they are and never reads them again. A host of an older build, after a
downgrade, still finds the records as they were at the upgrade. A later release deletes the
files.

## Out of scope

- **The test budget journal** (`herd/<key>/budget.jsonl`). Task naming in the CLI and the
  board writes it, and no board build reads it.
- **When a Run last did anything.** That is still read from the files its agents write. Those
  writers are not Collie's.

## Considered

- **Caching each decoded file by its text.** This keeps the files as the truth and every
  build still asks every file, so the cost stays wherever the cache misses. Rejected.
- **The host's memory as the truth, with files as its persistence.** Tasks are written from
  the CLI and the board too, so this needed the single writer of D2 anyway, and it gives
  neither queries nor transactions. Rejected for SQLite, which `host.db` already provides.
- **Other processes opening `host.db` themselves.** Two writers would need the same
  migrations in every client, and readers would be tied to the tables' shape across version
  skew. Rejected, except for the door Worker (D3).
