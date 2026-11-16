# A Run's own records are rows in the host's database

**Status: proposed** on the human's word (2026-11-16): make board and host reads fast by moving
host-owned structured records into SQLite, "do not add caches", and keep existing Runs, controls,
proof and history through a tested migration.

**Extends:** [ADR-draft-collies-own-records-live-in-the-hosts-database](draft-collies-own-records-live-in-the-hosts-database.md),
whose "Out of scope" left a Run's own files and when a Run last did anything as files.

## What was true before

The host kept a Run's journals (`steps.jsonl`, `operations.jsonl`, `steering/cards.jsonl`, ...)
and facts (`intent.json`, `landing.json`, `merge-request`, ...) as files in `runs/<run>/` and
`evidence/<run>/`, and derived when a Run last worked from the newest modification time under
three directories. At ~840 Runs one uncached board build made 26,148 stats and 5,330 directory
reads; with Git discovery removed it still took 2.81 s, and live builds reached 204 s. The Run
model and kept cards hid part of that behind caches with invalidation of their own.

## Decision

**D1. A Run's journals and facts are rows.** `collie_run_lines (run, journal, seq, line)` holds
each journal line as it was written, in order; `collie_run_facts (run, name, data)` holds each
fact's current value. A record is named by the path an older build kept it at, relative to the
Run's directory (`evidence/` first for that area's). A fact an older build kept beside others of
its kind, a ticket's progress checkpoint (recorded through `host.checkpoint`) or the count of
what a human typed into an agent's pane, is a row of its own, named the same way; the
checkpoints are read together by their prefix (`factsUnder`). Each owning module keeps its
schema and its torn-line and corruption rules; only where the text lives changed. A fact is
set or removed with `put`, and read-modify-write is one transaction (`RunRecords.update`).

**D2. Work moves a Run's activity; bookkeeping does not.** `collie_run_activity (run, at)` is
bumped in the same transaction as every write except bookkeeping (the operations audit,
disposition, seen). Readers take activity for every Run in one query; nothing walks a directory
to find it.

**D3. Readers ask many Runs at once.** `linesOf`, `factsOf` and `activity` answer for a list of
Runs in one query. A write names its Run to the Run model after it commits (`StoreWrites`), as
the other tables' writes do. The usual Step times are one query over every Run's Step rows
(`stepSamples`); no file of them is kept. Only the host writes these tables
([ADR-0040](0040-the-host-is-the-only-writer.md)); a reader outside it opens `host.db`
read-only (`recordsReadLayer`).

**D4. Files are imported once.** The migration that makes the tables imports every known
journal and fact file under `runs/` and `evidence/`, and each Run's last activity from the same
modification times the board used to read, in the migration's transaction. A torn last JSON
line is dropped; a corrupt line elsewhere is kept as written, so a reader that fails closed on
corruption still does. A missing file is no record; any other read failure fails the migration
and the next host retries. The files are left in place and never read again.

**D5. A downgrade is a rollback, not a surprise.** `collie host rollback` takes the host's
lock, and refuses while a host holds it. It writes every row back to its legacy path
(removing a fact file the host has since removed), then drops the tables and the records of
this migration and any later one in one transaction. A state directory never migrated is
left alone. An older build then reads current records, and the next upgrade imports them
again. Starting an older binary without the rollback leaves it reading the files as they were
at the upgrade.

## Out of scope

Documents and external contracts stay files: agent outputs, prompts, progress written by
agents, reports, plans, handoffs, `log.txt` and its index, a finished Run's diff, check logs,
screenshots, attachments, settings, workflow sources, credentials, Git trees, sockets, locks
and PID files.
Herd-wide journals are not a Run's and stay files.
