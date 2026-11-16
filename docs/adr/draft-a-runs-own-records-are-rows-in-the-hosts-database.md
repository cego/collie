# A Run's own records are rows in the host's database

**Status: proposed** on the human's word (2026-11-16): make board and host reads fast by moving
host-owned structured records into SQLite, "do not add caches", and keep existing Runs, controls,
proof and history through a tested migration.

**Extends:** [ADR-draft-collies-own-records-live-in-the-hosts-database](draft-collies-own-records-live-in-the-hosts-database.md),
whose "Out of scope" left a Run's own files and when a Run last did anything as files.

**Amends:** [ADR-0021](0021-one-host-answers-for-a-run.md) D7, which kept a control a file.

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
What the host marks over a Run only while it works on it, the check it runs (`verifying`) and
each wait for memory (`memory-wait`, keyed as its file was named), is a control row: a host
that is not running has none live, so neither is imported or written back, and the old
one-line `verifying` shape ([ADR-0042](0042-a-check-collie-runs-is-seen-while-it-runs.md) D2)
went with its file.

**D2. Work moves a Run's activity; bookkeeping does not.** `collie_run_activity (run, at)` is
bumped in the same transaction as every write except bookkeeping (the operations audit,
disposition, seen). A line in the Run's log, an agent's Output accepted, a launch and a
delivery to the Run's agent are work too, and mark activity in their own record's transaction.
Readers take activity for every Run in one query; nothing walks a directory to find it.

**D3. Readers ask many Runs at once.** `linesOf`, `factsOf` and `activity` answer for a list of
Runs in one query. A write names its Run to the Run model after it commits (`StoreWrites`), as
the other tables' writes do. The usual Step times are one query over every Run's Step rows
(`stepSamples`); no file of them is kept. Retiring a Run keeps its latest ten times of each
Step in `collie_step_times`, which `stepSamples` reads beside the live rows, so a workflow's
usual times outlive the Runs they came from. A board build reads each journal or fact it
uses, and activity, for all of its Runs in one query, the first time it reads it for any of
them (`readAhead`): it makes as many queries for five Runs as for two. Only the host writes these tables
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
(removing a fact file the host has since removed), each file dated by when its Run last did
work, then drops this migration's tables and its record in one transaction. While a later
build's migration is recorded it refuses and changes nothing: the migrator runs only
migrations past the latest recorded, so dropping this one beneath a later one would never
import again, and that build is rolled back first. A state directory never migrated is left
alone. An older build then reads current records, and the next upgrade imports them
again. Starting an older binary without the rollback leaves it reading the files as they were
at the upgrade.

**D6. Controls are rows.** `collie_controls (control, run, key, data)` holds every control the
host sets over a Run: hold, stop, parked, its park's information and cause, awaiting, usage,
the notices already sent (one row per line), the children awaited (one per child), what each
agent was started with for a relaunch (one per agent), and each running check's record (under
no Run, one per check). Setting or clearing one is not work. The migration imports the
control files an older build kept in the state directory, and the rollback writes them back.
ADR-0021 D7 kept a control a file only so that a boundary's read was slow enough not to race a
resume; that race is now closed by ordering ([ADR-0021](0021-one-host-answers-for-a-run.md),
amended 2026-11-16).

## Out of scope

Documents and external contracts stay files: agent outputs, prompts, progress written by
agents, reports, plans, handoffs, `log.txt` and its index, a finished Run's diff, check logs,
screenshots, attachments, settings, workflow sources, credentials, Git trees, sockets, locks
and PID files.
Herd-wide journals are not a Run's and stay files.
