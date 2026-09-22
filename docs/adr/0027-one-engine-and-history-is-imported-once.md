# ADR-0027: One engine, and history is imported once

Status: accepted

## Context

Collie has had two ways to run work. One read Markdown front matter — `steps:`, `extends:`,
`use:`, `when:`, `each:` — and drove it from a detached Driver process that owned a Run
directory, talked to itself through an inbox of JSON files, and froze the workflow it was
started on into a snapshot beside the record. The other is Effect's workflow engine, which
runs a TypeScript module and keeps what it has done in SQLite.

By the time the five shipped workflows were modules, the first engine ran nothing anybody
starts. What it still did was cost: every reader carried a decoder for a `run.json` written
by whichever version happened to be installed when that Run started, every control had two
implementations that could disagree, and every new feature had to be expressible twice.

The other half of the problem is what an installation already has. A machine that has been
running Collie for months has hundreds of run directories: what was asked for, what was
produced, the reviews, the cards, the verifications. None of it can be executed again —
the engine that wrote it is gone — but all of it is the answer to "has this been done here
before", which is a question Collie asks itself on every launch.

## Decision

**One executor.** The Markdown engine, the Driver, the per-Run inbox and the frozen
snapshot are removed. What runs work is the host, and a workflow is a module. An id with no
module is a workflow this installation does not have, said once, with what to do about it.

**Historical parsing belongs to one importer.** `history.ts` holds the only code that
reads a `run.json`, and its shape is deliberately forgiving: every field a later version
added decodes as absent rather than as a broken record. Nothing else in Collie reads one.

**The import is idempotent by Run identity, and the insert is what decides it.** A second
import keeps nothing and says so, which is what makes it safe to wire into every install,
upgrade and host start rather than into a migration somebody has to remember to run.

**A Run something still owns is not read at all.** Ownership is asked before the record, so
an import can never race a write, and "I could not tell" is a no: a claim whose identity
cannot be read may be a working installation, and is skipped until it is gone. Nothing is
adopted, signalled beyond asking whether a pid answers, terminated or rewritten.

**A malformed record is reported and left exactly where it is.** It is still the only copy
of that work, and rewriting it to fit is how history is lost.

**Imported work is readable and nothing else.** It cannot be answered, controlled, resumed
or amended, and every door says the same sentence about it: what it was recorded by, that
its record and everything it produced are still here, and that `collie run start` begins
new work. The run directory is untouched by the import — the cards, the drift, the
verifications and the outputs are files by design and stay where they were written.

## Consequences

An upgraded installation's past is a table rather than a directory scan, and the readers
that ask about it stopped carrying a decoder for every version Collie has ever written.

Work the old engine left unfinished cannot be picked up. That is not a gap to close: the
process that knew where it had got to is gone, and the honest answer to "carry on with
this" is a new Run of the same workflow against the same work source.

What a machine still has from the old engine is visible rather than silent:
`collie history list` is the Runs it imported, `collie doctor` names any Markdown workflow
files left in the operator's own layer, and neither interprets one.
