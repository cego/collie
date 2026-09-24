# A rally is a loop, and a claim is not proof

**Status: accepted, and proven against real agents through the real dispatcher, over a real
repository.** The seams are `src/output.ts` (`settleRound` beside `splitDisputed` and
`settleFinalFix`), `src/sdk.ts` (what a module may reach for), `src/native.ts` (the host's
`evidence` and `verify`) and `src/commands/verify.ts` (the one collector). The proofs are
`test/rally.test.ts` and `test/lifecycle.test.ts`.
[ADR-0020](0020-an-agent-is-launched-once-and-its-output-is-decoded.md) settled what a
workflow does with an agent; this is what it may believe afterwards.

## Decision

**D1. The rally's decisions are functions, not an engine.** A module writes its loop in
TypeScript — a `for` over rounds — and calls the same three functions a declared loop
does: `splitDisputed` for what is still the implementer's, `settleRound` for where the
round goes, `settleFinalFix` for whether the last fix stands. No repeat declaration, no
scheduler, and nothing about convergence written twice.

**D2. `settleRound` was extracted rather than written again.** It is the engine's own gate,
lifted out of `afterStep` and called from there. A second implementation of "the same
blocking findings twice running is not progress" would be two readings of one rule, and the
one that drifted would be the one nobody was looking at.

**D3. A shared schema carries its own type.** The Output shapes the shipped steps write are
published as codecs with their types rather than as `Schema.Top`: an author hands
`ReviewOutputSchema` to `agentWork` and is given a review, not an `unknown`. Without this
the shapes were shared in name only, and the fixture that proves it typechecks against the
declarations an author is actually given.

**D4. A check is a claim until the journal has it.** `settleFinalFix` reads
`host.evidence(runId, cwd)`: a check the fix names with no verification record refuses the
fix, and one that passed before the tree moved refuses it too. The fix's own `verdict:
"clean"` buys nothing. This is the existing evidence rule, not a new one — what is new is
that a Run with no steps can be held to it.

**D5. One collector, two kinds of Run.** `collie verify --run <id>` records for a Run the
host owns exactly as it does for one with steps: the same `collect`, the same journal
shape, the same refusal for a directory outside the Run's tree. The journal lives beside
the Run rather than in a table, because what makes a result evidence is the collector and
the revision it bound the result to, not where the line was written.

**D6. The approved set is frozen when the Run starts.** `host.verify` will run only a
command named in the list the Run was admitted under, argument for argument. Editing
`.collie/verify.json` changes the next Run and never a live one, and a workflow cannot add
to its own authority.

**D7. The outcome is a fact on the Run, never a reading of its name.** What a Run has to
prove is the kind its module fixed or the caller selected, recorded at admission and shown
by `run show`. A renamed or user-authored workflow is held to what it declared.

**D8. Usage is recorded, not enforced.** A verification becomes a metric where the Run's
metrics are, so a card counts the same fact whichever kind of Run collected it. Nothing
here is a budget, a limit or a counter that stops anything.

## What this does not decide

No new outcome kind, and no weakening of what any of them needs — `evidenceGaps` is
unchanged. A native Run has no step Outputs, so the gate that reads them has no native
counterpart; what a native rally is held to is its own settle, which is the same rule
applied where the claim actually is. Synthesis of several reviewers stays a step an author
writes with the same schemas; nothing here reconciles reviews for them.

## Consequences

`settleRound` takes `live` — what `splitDisputed` left — rather than a raw review, because
that is what the engine already had at the point it decided. A module therefore calls the
two in order, and the order matters: settling a round against findings nobody split would
count a dispute as work.

`HostServices` gained `Path`, and the host's layer now takes a process spawner, because
running an approved command is the host's to do. That is the cost of a workflow being able
to ask for a verification without asking for a filesystem.
