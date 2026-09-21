# One request is one run

**Status: accepted, and proven rather than argued.** The rows are `src/store.ts`, the
admission is `Native.Registry.start`, and the proofs are `test/store.test.ts` and
`test/admission.test.ts` — the second one kills real hosts in both windows a start has.
[ADR-0014](0014-native-workflows-run-on-effects-own-engine.md) put execution on Effect's
engine and [ADR-0015](0015-one-local-host-owns-a-state-directory.md) put it in one host;
this is what that host records beside it, and why a retry is not a second Run.

A start is two things that cannot be made one: a row saying this work was accepted, and an
engine that has been told about it. A crash can land between them whichever order they are
done in, and a caller that does not hear an answer will ask again. Neither may produce two
Runs, and neither may lose the work.

## Decision

**D1. Effect's tables are the authority on execution; Collie's rows are the other half.**
The journal, the activities and the deferreds are the engine's, and none of it is copied.
What is stored here is which request claimed which run, which generation it was admitted
on, which execution it became, and the arguments it was claimed with. Status is read from
the engine when asked, never mirrored into a second state machine.

**D2. The request id is the claim, and a unique constraint settles it.** A start inserts
its row with `ON CONFLICT(request) DO NOTHING RETURNING run`: the caller that gets a row
back made the run, and everyone else reads the one that exists. Four clients sending one
request at the same moment therefore agree without a lock, a queue or a leader.

**D3. Same request and same arguments is the same answer; other arguments is a refusal.**
Arguments are compared canonically, so key order is not a difference. A request reused for
something else is `RequestConflict` naming it — an idempotency key that quietly became
something else would be worse than either outcome.

**D4. The row is written before the engine is told, and the receipt after.** Recovery is
therefore one rule: any row without a receipt is handed to the engine again, under the
execution identity it was admitted with. A crash before the engine heard starts the work;
a crash after it heard is a no-op, because that identity is already running. There is no
outbox, no dispatch queue and no replay journal — the pending row is all of it.

**D5. Nothing of this is a file a second process could be editing.** Routing lived in a
JSON file next to the database and is now rows in it, so what a restart reads is what the
last committed transaction wrote. Reports, prompts, Outputs, logs and worktrees stay files;
they are artifacts, not coordination.

**D6. Writes are short, and subscribers are told after they commit.** A mutation is one
statement, and none of them spans an agent, a network call or a human waiting. Committed
writes invalidate a reactivity key, so a reader reruns its own query instead of being
handed an event to believe.

## What this does not decide

Which Run a start belongs to in production, and what else Collie will keep about one:
tasks, outcomes, dispositions, artifact references and decisions are later tickets, and the
columns here are the ones the proof needs. The run id a host mints is its own; a caller
that already has an identity for the work may bring it, which is what the fixture host
does. Importing the old engine's history is ticket 17, and nothing here touches it.

## Consequences

- A host reads `collie_runs` at startup and hands every un-receipted row over before it
  serves anyone. That is a bounded cost, and it is what makes the two crash windows equal.
- Two writes with one connection: the engine's tables and these live in one SQLite file,
  and the one connection is the host's. A second process writing that file is not a
  supported arrangement — the pid lock is what keeps there being one.
- `collie native --crash-at admitted|executed` exists so the proof can be run rather than
  reasoned about. Only that fixture host takes it.
