# A list of work is known by its names

**Status: accepted, and proven against real agents over a real plan directory, and against
real child Runs over two repositories.** The seams are `src/slices.ts` (the identities and
the hand-off), `src/agents.ts` (`agent` and the operation's own name), `src/sdk.ts` (the
plan reading a module may reach for) and `src/native.ts` (a child's host options). The
proofs are `test/listing.test.ts`, `test/repos.test.ts`, `test/slices.test.ts` and the
list tests in `test/agents.test.ts`.
[ADR-0022](0022-a-workflow-is-made-of-workflows.md) settled what a child Run is; this is
what a list of them, or of agent work, is allowed to forget.

## Decision

**D1. An item is identified, never numbered.** `agentWork`'s `operation` is the item's
identity, and everything durable about it — the launch, the collection, the repair, the
Output file — is recorded under that name. A reordered list therefore reuses what is done
and moves only what is left. There is no cursor, no index and no "the third item" anywhere.

**D2. The list is enumerated again on every pass.** A plan that gained a ticket between
attempts has work left; one that lost a ticket has less; one that was reordered has neither.
Freezing the enumeration in an Activity would make all three invisible, and freezing it is
what a positional cursor needs. Where a list genuinely cannot be re-derived — an agent
produced it — an Activity records it, which is Effect's own answer and needs nothing here.

**D3. Two items nobody can tell apart are refused before any of them starts.**
`identityProblem` says why a set of identities cannot key a list: a name that is not a name
of its own, or one claimed twice. `agentWork` refuses an unsafe operation for the same
reason at the one place every identity becomes a path — its Output, its prompt and its
recorded launch all live under it.

**D4. The hand-off was extracted, not written again.** `renderProgress` is the engine's own
rendering of what the slices before this one left behind, lifted out of `runSlices` and
called from there. A module writing its own list gives its next item exactly what a
declared `each:` gives its own — their work, their commits, their evidence, and never a
transcript.

**D5. A list is one agent's.** `agentWork` takes the agent by name, so several operations
are one implementer's work in order rather than one agent each. That is what the baseline
does and why the hand-off exists: the point is a fresh prompt per item on an agent that has
the context, not parallelism.

**D6. Skipping is the author's `continue`.** A skip records its reason through the host's
own journal, opens no tab, starts no agent and writes no Output. Eligibility is decided
before anything expensive, which is the only place where deciding it is free.

**D7. Findings do not end a list, and an unusable Output does.** An item that found
something is an item that finished; the findings are carried and the summary is where they
add up. An Output the contract refuses is the work not having been done — after the one
repair `agentWork` allows — and the list stops there with the reason visible.

**D8. A repository's share is settled by the parent, and its identity is the repository.**
Fan-out is `readPlanRepos` for the waves and `child()` for the Runs: the parent settles
which tickets are this repository's, the child's own schema decides whether it takes them,
and `invocation: repo-<path>` makes a replay come back to the Run it already started. The
host's own options — `repo`, `workspace` — travel as options, so nothing of the host's is
injected into a payload its author never declared.

## What this does not decide

No list language, no loop declaration and no parallelism policy: concurrency in a list is
`Effect.forEach`'s own option and the author's call. Nothing here reconciles a _plan_ that
changed under a Run beyond identity — an arbitrary structural edit still has no seamless
resume, exactly as [ADR-0014](0014-native-workflows-run-on-effects-own-engine.md) says.
Cards gain no multi-repository launch: a fan-out is a workflow that starts children, and a
card starts a workflow.

## Consequences

`Registration.layer` may now require `FileSystem` and `Path`. A module that reads the plan
it was given has to read it, and the host already holds both — so this is the type catching
up with what was true, not new authority. Nothing is sandboxed here and never was.

`refuseOptions` now refuses a host option nobody declared, on a start and on a child alike.
A caller that was passing an unknown option had it silently recorded before; now it is told.
