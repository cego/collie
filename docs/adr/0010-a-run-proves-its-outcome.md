# A Run proves its outcome

**Status: accepted.** Built: definitions are frozen per Run, verifications are collected
against a revision, `implement` is `build → review → fix → mr`, plans build in slices, and
a gate reads evidence before a merge request is opened. What remains outstanding is live
evidence rather than design — see Consequences.

A Run has an **outcome** it must prove, and the proof is a collected **Verification**
bound to the tree it ran on. An agent writing `"verdict": "clean"` is a claim, and Collie
shows it as one.

## What was true before

Three things, measured on the three Runs that produced 0.7.0 and 0.8.0.

**Completion was an agent's own word.** `fix.json.checks[].passed` was a boolean the
implementer wrote. Nothing bound it to a revision, nothing had run the command, and the
`mr` step ran whenever the loop was clean. "Done" meant an agent had said so.

**Every Run paid for passes it did not need.** `implement` ran `architecture` unattended
and `simplify` after every build and after every fix, gated on nothing. Two reviewers and
a model to reconcile them ran whether or not there was anything to reconcile. On MR !41
that was 48 minutes of 180; on the steering branch, 85 minutes and counting, with
`simplify` alone taking 58 minutes over a 17,000-line branch.

**One prompt carried a whole plan.** The steering Run reached 552,080 tokens before its
first compaction. Every later ticket was built by an agent re-reading work it had done
hours earlier, and compaction at work boundaries was the only bound.

And underneath all three: a Driver re-resolved its workflow from the _current_ layers
every time it started, so changing any of this would have changed what Runs already going
would do on resume — or crashed them, since `Run.step(id)` throws for a step id the record
does not have.

## Decision

**D1. Freeze the definition per Run.** _Superseded by [ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md): a resume runs the module as it
is now, and reuses the work already done._ `RunStore.create` writes the resolved workflow into
the run directory and records `definition: {hash, layer, path, snapshot}`. The Driver
resolves from the snapshot. What is frozen is the _resolved_ workflow — after `extends:`
and `use:` — because that is what the engine executes; re-emitting Markdown and reading it
back would resolve it again against today's files, which is the thing being prevented. A
Run recorded before this has none and resolves from the layers as it always did, but only
while its steps still match: otherwise `resume` refuses with `definition_changed` and
writes nothing, and a Driver stops the Run `blocked` rather than running a workflow the
Run never started.

**D2. Evidence is collected, never claimed.** A verification is a command Collie or an
agent ran through the collector, with the tree fingerprinted before and after. A result on
a tree that moved is `unstable` and never `pass`. `--expect fail` is how a bug is proved
to exist. What _Collie itself_ may run is a Run's approved set, read from
`.herdr/verify.json` or the config directory when the Run starts and copied into
`run.json`: a permission that moved under a Run is not a permission.

**D3. An outcome decides what closes a Run.** One pure table (`src/outcome.ts`): a feature
names what it built and the review says the scope was met; a bug records a regression that
failed before the fix and passes after, on two different trees; a refactor preserves
behaviour; an investigation reaches a supported conclusion and may legitimately have no
patch; docs prove the documented commands by running them; a migration proves it can go
back. A gate before the `mr` step runs the approved set and halts with `evidence_missing`
listing what is not there.

**The default outcome is `unspecified`, not `feature`.** A Run nobody classified proves
its approved set and nothing else. Documentation, an investigation and a bug fix are not
features, and asking them for a feature's evidence would ask for tickets that do not exist.

**D4. One complete review by default.** With one review there is nothing to fan in, so the
`synthesize` step is skipped and the review that was written is the review. A layer that
keeps two or more reviewers runs the fan-in exactly as before. Blocking findings must say
where and why — a `file` and a `detail` — but deliberately **not** "the file is in the
diff": an unchanged caller this change breaks is exactly the blocker worth having.

**D5. No mandatory architecture or simplification.** `implement` is
`build → review → fix → mr`. `architecture` remains its own workflow, embeddable, and a
`plan` Choice a human takes for work that actually needs architectural decisions.

**D6. Large plans build in slices.** A step with `each: tickets` runs once per ticket, on
one agent, in an order the tickets' `Blocked by` lines allow, with a hand-off of a few
lines of fact — the earlier tickets and the commits they left, never the transcript.
Concurrency stays between repositories, in the fan-out. No second writer in a worktree.

**D7. Progress is evidence; liveness is the pane.** `metrics.jsonl` records what was
produced and when. The pane clock still nudges a quiet agent, and is not on the list.
Where one command fails several times in a row the same way, that is recorded as an
**obstacle**: a sentence on the record, in `run show` and in the next prompt, so the agent
can change approach. It is not a halt. A counter reaching a number is not evidence that
work cannot be done, and what prevents a false claim of success is the gate reading
collected results.

**D8. The board says what a Run is for.** Outcome, evidence gaps, obstacle and next action
on the row and in the detail, from `run.json` alone.

## Alternatives rejected

**Mandatory passes, kept but gated.** Deciding whether a change "needs architecture" is
itself a judgement call that costs a model call, and a wrong answer is invisible. A human
choosing at the plan step is cheaper and more honest.

**Runtime-generated workflows.** ADR-0004 stands: every behaviour here is bundled
Markdown, a pure function, or an engine gate reading files already in the run directory.
A workflow generated per Run could not be reviewed, forked, or frozen.

**A second planner to classify work.** The outcome is settled during the interview `plan`
already holds, and forwarded. A clear request needs no extra interview, and a Run nobody
classified is `unspecified` rather than guessed at.

**A hard stop after N identical failures.** Proposed as policy, rejected as one: three is
not a number that means anything about whether work is possible. The obstacle says what is
repeating and asks for a different approach; the gate is what refuses a false claim.

**Spending caps and model-call quotas.** Usage is recorded — counts, tokens, costs,
timings — and never enforced. The budget machinery removed in 0.8.0 is not reintroduced.

## Consequences

A Run started before this resumes only while its workflow still has the steps it recorded.
That is visible and intended: the alternative is a Run silently doing something else.

A project with no `.herdr/verify.json` is told so at the gate rather than passed: an empty
approved set would make the gate say yes to anything.

The gate asks before it collects: it is a decision on the board, answered with **Approve**,
the list cut down, or **Skip**. What it refuses is a Run claiming more than it proved, not
a human deciding what this Run has to prove — and either way the answer is on the record,
so a merge request opened past a skipped gate can be read back as one.

A merge request now says what was actually verified and by whom, which is a smaller claim
than the one the description used to make.

What is not proved here: the wall-clock and token effect of all of it on a representative
mix of real Runs. The baseline in this ADR is measured; the improvement is not, and a
smaller step count is not a result. `plans/productive-execution/REPORT.md` records what was
measured and what was not.
