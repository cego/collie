# A fixable failure parks its Step

**Status: proposed** with #301. It amends
[ADR-0020](0020-an-agent-is-launched-once-and-its-output-is-decoded.md) D6 and its "a second
unusable Output is the end of it", and
[ADR-0024](0024-a-list-of-work-is-known-by-its-names.md) D7's "an unusable Output does [end a
list]".

## Context

A Run that ends `failed` cannot be resumed: the engine journals every Activity's result,
failures included, and a replay meets the same failure again. Two tune-up Runs ended that way
on 2026-11-06 over things that could have been fixed in minutes: a plan naming a placeholder
commit (run-a57800b1), and a harness prepare that failed and was fixed straight after
(run-1f9e6aca). Each time, the next Run had to be told by hand to reuse the failed Run's
branch and Outputs.

## Decision

**D1. A failure that a person or an agent can correct parks the Step; it does not end the
Run.** The Step is recorded failed with the reason and what to correct, the Run parks, and
`run resume` (or `retry-noted`) enters that Step again on the same worktree, branch and
agents. A workflow parks this way already when a merge request cannot be opened or an
outcome is unproved, and when the Merge request step's agent left delivery undone: the
branch not pushed, no merge request URL, or a blocking finding. A resume asks that agent
again under a new operation, since its first Output would replay. A finding that does not
block delivery never stops the step. It is recorded and noted on the merge request. Each resume is one more bounded attempt, and only a human or an agent
can trigger it, so this adds no automatic retry.

In implement, these four stops park: an unreadable spec, a stopped builder, a ticket's
unresolved blocking findings, and a halted final rally, including a disputed blocker.
A resume reads the spec again or asks the stopped builder under a new operation and reads
its new Output. A stopped rally gets one more fix-and-review round with the same builder
and reviewers. If that round does not converge, it parks again with the new reason.

**D2. An Output still unusable after its one repair parks.** It no longer ends the Run
`output-unusable`. On resume, the file is read again. If it decodes now, the work goes on. If
not, the agent that wrote it gets one more repair, and an Output still unusable after that
parks again. A list stops at that item the same way, and goes on from it.

**D3. In a tune-up, a calibration the host refused, or that ended without a verdict, is a
broken harness.** It goes through the same bounded repair as any broken harness. Once the
repairs are spent, a broken harness parks at Calibrate. A resume gives the tuner one more
repair turn, and the plan it writes is calibrated even if it is unchanged: no verdict was
taken, so measuring it again cannot fish for a better one. A Cycle's or the final
Measurement that the host refuses parks its Step, and a resume measures again.

**D4. A verdict stays terminal.** A work's own verdict ends the Run as it does now: proof
unavailable against itself, no gain, an outcome no reviewer can change, or an input that
names nothing this Run can find.

## Rejected

**Resuming any failed Run by replaying it.** A replay returns each journaled result again, so
the failure comes back with it. Getting past it would mean deleting journaled Activity
results, and that breaks "an Activity happened once" for the Activities with side effects:
agent launches, merge requests and Linear posts. Whether a failure can be fixed is known
where it happens, so it is decided there.

## Consequences

- More Runs wait for a human (Needs you) where they used to end. That is what #301 asks for:
  the work, its worktree and its agents' context stay.
- The `output-unusable` toast becomes the `needs-you` raised by the park.
- A Run that already ended `failed` stays failed. A tune-up carries the findings of an earlier
  Run with `from` (run-85b81582).
