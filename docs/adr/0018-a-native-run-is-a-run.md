# A native Run is a Run

**Status: accepted, and proven through the doors an operator uses.** The shared operations
are `src/lifecycle.ts`, the read model is `Native.Registry.view`, and the proof is
`test/lifecycle.test.ts` — which starts a module from the command line and from the picker,
shows, lists and waits on it, and puts a deleted module back.
[ADR-0014](0014-native-workflows-run-on-effects-own-engine.md) put execution on Effect's
engine, [ADR-0015](0015-one-local-host-owns-a-state-directory.md) put it in one host,
[ADR-0016](0016-a-workflow-module-is-found-where-it-was-saved.md) said where a module is
found and [ADR-0017](0017-one-request-is-one-run.md) said what a start records. This is how
an operator reaches all of it, and why that needs no second way of running anything.

## Decision

**D1. What an id runs is decided by what is saved, never by a flag.** A workflow id that a
module claims is that module's, whichever front door was used — and an id whose module will
not load is refused by that file rather than quietly falling back to the Markdown
definition it was written to replace. There is no `--native`, no engine column and nothing
to choose.

**D2. Both front doors do the same things in the same place.** `src/lifecycle.ts` is the
client side of a native Run: which id is a module's, the claim a start is admitted under,
and the read model show, list and wait are drawn from. The CLI and the picker call it; the
sentence a caller sees comes from the host rather than from whoever asked.

**D3. The caller's request id is the claim.** The CLI's own idempotency key is what the
host is given, so a retried command, a replayed receipt and a re-clicked row are one Run.
Two doors sharing one admission is the whole of the deduplication; neither keeps a second
record of what it started.

**D4. The status is read, not kept.** A view is the row Collie owns plus what the engine
says when asked. Nothing copies a status into a table of Collie's, so nothing can disagree
with the engine — and a Run whose module is missing reads as pending with the file to
repair named, because that is what is true, rather than as failed or gone.

**D5. One fiber asks the engine, and everybody reads the answer.** Upstream's tables are
upstream's: a write there invalidates no key of Collie's. So the host polls what it has not
finished with on one shared schedule and invalidates the runs key when something changed;
every client's stream reruns its own query. A run the engine has finished with is asked
about no more, so the cost is one poll per unfinished Run per tick however many clients
are watching, and none when none is.

**D6. A stream opens with the current state, not with what changed.** Every update is a
full reread, so a client that was closed while the work moved — a board, an interrupted
wait — sees where the work is rather than waiting for a notification that has been and
gone. Nothing depends on a client having been connected at the right moment.

**D7. Resuming a native Run is recovery, not a new Driver.** `run resume` has the host
register what current files allow and hand over what is outstanding. A module that was
missing and has been put back is picked up by that, without restarting the host and without
a second engine having to be chosen.

## What this does not decide

Typed inputs and inference belong to ticket 07: a module's inputs are passed as the text
the caller typed and settled by the module's own schema, which refuses a launch before any
row exists. Agents, worktrees and Outputs belong to 08; answering, holding and stopping a
native Run belong to 09; cards and actions to 13. `--decide`, `--goal` and `--constraint`
are refused on a module rather than accepted and dropped, because a goal nobody recorded is
worse than being told it is not taken yet.

## Consequences

- A native Run has no run directory. Its rows are the host's SQLite, so `run list` reads
  two sources and says so in one listing rather than inventing a record for the second.
- Listing native Runs starts no host where none has ever run: a state directory with no
  `native.db` in it has nothing to ask about.
- The picker asks for exactly what a module declares. It has no inference, so a module
  with a work-source input is asked for by name until 07 gives it one.
