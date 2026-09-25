# ADR-0027: One engine, and a hard cutover

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

A machine that has been running Collie has run directories the old engine wrote. Carrying
them over would take an importer with a forgiving decoder for every version of `run.json`,
a probe for whether an old Driver still owns each one, a table of their rows, and a
read-only kind of Run that every door has to recognise and refuse.

## Decision

**One executor.** The Markdown engine, the Driver, the per-Run inbox and the frozen
snapshot are removed. What runs work is the host, and a workflow is a module. An id with no
module is a workflow this installation does not have, said once, with what to do about it.

**Nothing the old engine recorded is carried over.** The host starts from empty rows. No
code reads a `run.json`, and there is no imported kind of Run: every Run a reader sees is
one the host holds, so every door treats every Run the same way. The old directories are
neither read nor deleted.

## Consequences

An upgraded installation starts with an empty board, and "has this been done here before"
finds only work the host has done. Work the old engine left unfinished is started again as
a new Run of the same workflow against the same work source.

`collie doctor` still names any Markdown workflow files left in the operator's own layer,
and does not interpret one.
