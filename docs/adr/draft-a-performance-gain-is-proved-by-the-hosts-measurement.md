# A performance gain is proved by the host's measurement

**Status: accepted, to be built** with the `tune-up` Workflow.

A **Tune-up Run** says its merge request makes a project faster. Under
[ADR-0010](0010-a-run-proves-its-outcome.md) that is a claim until Collie has evidence for it,
collected against a revision. A Check can't be that evidence. It answers a pass or fail of
one command on one tree, and the host does not run a passed Check again on the same tree
([ADR-draft-a-runs-checks-are-run-by-its-gate](draft-a-runs-checks-are-run-by-its-gate.md)). A speed-up
is a difference between two trees. Showing it takes many samples of each, taken
alternately, and a judgement over all of them. An agent's timings in an Output are a claim
like any other, and an agent that keeps re-running until it gets a good number is
cherry-picking.

## Decision

**D1. A Measurement is a host record, like a Verification.** The host runs a Run's declared
benchmark commands on two trees of the same Machine: a base tree and a candidate tree. It
alternates between them (A B B A …) for a fixed number of samples, after a warmup it records
but does not judge. It keeps every raw sample, together with the commands, both trees'
heads and fingerprints, the environment, the dependency lockfiles' digests and the Machine's
load and memory pressure at each sample. A front door asks for one with `collie measure`,
and a workflow with `host.measure`. Neither the agent nor the human chooses which samples
count.

**D2. The judgement is pure code, and it is the gate's.** One function turns the samples
into a verdict per metric: a 95% bootstrap interval, with a recorded seed, on the ratio of
medians. The verdict is `gain`, `no-change`, `regression` or `inconclusive`, read against
the Run's `threshold` for the primary metric and its `tolerance` for each guardrail metric.
A guardrail is held only when its interval's worse bound is within `tolerance`, so an
inconclusive guardrail is not safe. An inconclusive comparison is a result. The same
comparison, the same two trees under the same plan, is measured once: asking again returns
the recorded Measurement, as a passed Check is not run again on its tree. Only a changed
tree or a new plan, recorded with its reason, is measured again, and every Measurement
stays on the record.

**D3. `performance` is an outcome kind of its own.** It is fixed by the Workflow and not
requestable. It closes when four things hold for the final tree:

- a Measurement against the merge base the merge request targets shows a `gain` on the
  primary metric;
- every guardrail metric is held;
- the Run's checks pass;
- a review of that tree says `behavior_preserved` and `measurement_valid`.

A Run whose tree is back to its base tree, every change reverted, ends without a patch and
with its findings, not failed.

**D4. Base and candidate share a Machine and a harness.** The base tree is a detached
worktree Collie makes at the base commit, with the Run's harness-only commits applied on
top. It is Collie's to clean up ([ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md)).
Measurements on different Machines are never compared. Only one Measurement runs on a
Machine at a time. Others wait, and say so, while no other work does. A Measurement waits
while its Machine is **Short of memory**, like a Check.

## Considered

- **Benchmarks as Checks.** A Check is a pass or fail on one tree, and the host does not
  run it again on that tree. Forcing samples through it would mean a check that may never
  be relied on, and the gate would still have nothing to compare.
- **The agent measures and the reviewer judges.** A reviewer would then be judging numbers
  whose selection nobody saw. The proof would rest on an Output field, which Invariant 8
  rules out.
- **Production telemetry as proof.** It ranks what to try, but a production window is not
  a controlled comparison of two trees.
