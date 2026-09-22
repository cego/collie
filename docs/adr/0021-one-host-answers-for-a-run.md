# One host answers for a Run

**Status: accepted, and proven against real hosts over real SQLite, restarted and run two
at a time.** The seams are `src/native.ts` (the registry's `answer`, `control` and `steer`),
`src/store.ts` (the questions), `src/sdk.ts` (`decision` and `ask`) and `src/agents.ts`
(the delivery). The proofs are `test/control.test.ts`, `test/lifecycle.test.ts` and
`test/agents.test.ts`. [ADR-0020](0020-an-agent-is-launched-once-and-its-output-is-decoded.md)
settled what a workflow does with an agent; this is what a human can then do to the work.

## Decision

**D1. A question is asked through the host, not only awaited.** `ask(runId, decision)`
records what the run is waiting on and then waits on Effect's own durable deferred. Both
halves matter: waiting is Effect's, and it survives a restart because of that. Saying so is
Collie's, because a host that does not know what a run is asking cannot show the question,
cannot refuse an answer to one nobody asked, and cannot tell a second answer from the first.

**D2. A question declares what it takes.** `decision(name, { prompt, options })` carries its
own identity and its answers. An answer outside them is refused before the run is told
anything, so a value the workflow would not have understood never becomes work.

**D3. The database settles a race, not the code around it.** An answer is one UPDATE over
the row while it is still unanswered; whoever that write returns a row to is the answer, and
everybody else is told what landed. Only the winner completes the deferred, so two answers
in flight at once make one piece of work.

**D4. The same claim twice is the same answer.** An answer carries the caller's request id,
as a start does. Retrying one is not a second answer; changing one is refused with what the
run already has. A question the run has answered is distinguished in the refusal from one it
never asked, because an operator is owed the difference.

**D5. A control is the host's, and it says whether it arrived.** `control` sets or clears a
hold or a stop over exactly one run. It records the intent either way and reports whether the
run was told: a control over work whose module is not registered here comes back as recorded
and not applied, naming the file to repair, rather than as a confirmation nobody can stand
behind.

**D6. Clearing a control returns only once the run has settled.** A woken run runs before it
parks again, and anything delivered inside that window reaches a run that is not waiting on
it yet — it is lost, and resuming afterwards does not bring it back. So a control that wakes
a run waits for the engine to stop saying it is running before it answers. That is what makes
answering a run immediately after releasing it land on it.

**D7. A control is a file the host owns, and only the host writes it.** No client writes one,
nothing consumes it as a command, and it is not in a run directory. It stays a file rather
than a row because a workflow reads it at its boundaries, from the engine's own fiber:
answering that read from this process's memory or its database settles the boundary fast
enough to race a resume, and the run parks again before the resume has landed. The measurement
is below.

**D8. Stopping a Run is not halting its agent.** A stop parks the wait where the run next
looks; the agent keeps whatever it is holding, and asking a harness to stop is its own action.
The wait suspends its own Activity's instance, never a captured parent, and what comes back
reattaches to the launch that was recorded rather than starting a second agent.

**D9. Steering goes out through the one sender, or not at all.** A human's words reach the
run's agent through the dispatcher: one transaction per incarnation, the incarnation
revalidated, the capability gate in front of every send, and the request id as the causal key
so the same message twice is one message. What comes back says whether it was delivered, and
never that it was accepted for sending.

## What this does not decide

Collie's model-mediated steering — where a model proposes actions and a human confirms one by
naming its exact payload — is unchanged and is not reachable from here: `run steer` delivers
what a human typed and carries out nothing. The board's cards for native Runs are C7's.
Native interrupt stays internal; no public stop mode was added.

## Consequences

An author waits on a decision with `ask` rather than `DurableDeferred.await`, and a module
that awaits one directly gets a run nobody can answer. That is the cost of the host knowing
what is open, and it is why `ask` is what the SDK documents.

The stall behind D7 is reproducible. With the control read from SQLite or from an in-memory
index, `test/native-runtime.test.ts`'s two stop-and-resume cycles fail: the run logs that it
has re-entered, parks on its question, and the answer that follows never reaches it — the
engine's own resume does not recover it either. With the same control read from a file the
same test passes in three seconds. The difference is only how long the boundary takes, which
is why this is recorded as a measurement rather than as a preference.
