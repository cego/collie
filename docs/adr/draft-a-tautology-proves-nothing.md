# A tautology proves nothing

**Status: proposed.** Extends [ADR-0010](0010-a-run-proves-its-outcome.md) and
[ADR-0023](0023-a-rally-is-a-loop-and-a-claim-is-not-proof.md) from claims to work that
cannot be wrong, and [ADR-0036](0036-a-runs-own-plan-bounds-it.md) from the goal as evidence
to the judgement that is counted.

A **Tautology** is work that cannot be wrong, so it shows nothing
([`CONTEXT.md`](../../CONTEXT.md)). Every agent Collie launches is told not to make one and to
raise one it finds. A gate never counts one as proof.

## What was true before

Collie already refused claims as proof. It did not refuse work that could not fail:

- **A bug's reproduction.** `outcome.ts` counted any record named `regression` with
  `--expect fail` on an earlier tree. That record did not have to be the same command as the
  pass after the fix. `false`, or a test file that did not exist yet, reproduced the bug.
- **The goal judgement.** At a Run's finish, the drift judge was asked about the goal. Every
  report it returned was dropped, because only a semantic constraint can be reported
  against. The goal was still recorded as judged, and the Run read `aligned: true`. A Run
  with nothing to judge read `aligned: true — every constraint was checked`
  (cego/collie#164: run-b5556e3a, run-89ed3b4a, run-e504edf5, run-69cd995e, run-b8723b86).
- **Criteria.** A criterion's `met` was any text that did not start `not met`. A criterion
  the base branch already met passed before anything was built. A criterion whose command
  already failed on the base could never pass (cego/collie#165).
- **The goal as evidence.** Drift reports cited the Run's own goal text against the
  constraints its plan cut from it (cego/collie#129, fixed in #147). That is the same kind of
  error: a judgement reading back what it was given.
- **Where the rules lived.** Nothing in Collie shares text between prompts or personas.
  "Code comment hygiene" was written twice, once for the implementer and once for the
  reviewer. Each persona carried its own copy of the rules it shares with the others. A fork
  in a user's Layer kept the copy it was forked with. Collie's own suite had the rule
  ([internals](../internals.md#keeping-the-suite-and-a-start-fast): "A test can go red"), and
  no agent was told it.

## Decision

**D1. What a Tautology is.** Each of these is one:

- a test that restates the implementation, asserts that a mock returns what it was told,
  or cannot fail;
- a verification that checks nothing a change could break, such as a text search for code
  the change just wrote;
- a comment or doc that says what the code already says;
- an acceptance criterion true by construction, including one the base already meets and one
  that only says text the change adds is there;
- a finding, summary or hand-off that only repeats the goal or the diff;
- a judgement that cannot report anything, or that cites the goal it was given as evidence.

**D2. The rule is stated once, and every agent is given it.** One shipped text states D1 and
what each role does about it: a builder does not make one, and a reviewer or judge raises one
as a finding. Collie gives that text to every agent it launches, after the persona. That holds
on every harness, for a persona from any Layer, and for a role with no persona. The Home chat
is given it too. The text is the persona named `every-agent`, so a Layer replaces it the way it
replaces any persona, and a user's copy is shared across the Flock like any persona
([ADR-0061](0061-a-users-definitions-are-the-flocks.md)). Personas do not copy it. The implementer's and the reviewer's "Code comment hygiene" become part of it. A
user's forks therefore follow it without being edited.

**D3. Each step applies it where its work is made or judged.**

- **Planner.** A criterion is one the ticket's absence would make false. Text a ticket adds is
  never a criterion by being present: its criterion is a reviewer's confirmation that the text
  describes the behaviour as built. Before a criterion names a command, the planner runs that
  command on the base:
  - where the base already passes, the criterion is a guard and says so;
  - where the base already fails, the criterion is that the branch adds no failure over the
    base.
- **Builder.** A new test is run failing first, through `collie verify --expect fail`, before
  the code that makes it pass. A text search is never the verification of anything.
- **Reviewer, second opinion and criteria review.** A Tautology is a finding:
  - a `blocker` where it is the only proof of a criterion or promised check, which is then
    unproved;
  - a `minor` otherwise, with comments grouped as before.

  The reviewer is shown, for each promised check, whether a failing run of the same command
  was recorded on an earlier tree. A new test that was never seen failing is a finding.

- **Retrospective.** A finding is a record. It is never a Run's goal or summary read back.

**D4. A gate never counts a Tautology as proof.**

- A bug's reproduction and the pass that proves the fix are the same command, executable and
  arguments, on two different trees.
- A text search (`grep`, `egrep`, `fgrep`, `rg`, `ag`, `ack`, `git grep`) does not prove a
  promised check, a regression, a documented command or a migration.
- `aligned: true` means that every constraint was judged and none is open. A Run with no
  constraint to judge is `unverified — nothing was judged`. A judgement nothing can be
  reported against is neither asked for nor counted, so a goal alone is not judged. This
  follows ADR-0036: the goal is what was asked, never evidence.

**D5. A feature's new tests are not gated on red-first.** The human chose this on run-f67f869a.
The builder records each new test failing (D3), and the reviewer judges what was recorded. The
outcome table holds red-first only for a bug's regression, as before. Outside bun's runner,
Collie cannot tell a failing test from a test file that does not exist yet, so a gate on it
could be met by a missing file.

**D6. The rule is proved against a fixture.** The fixture is a change holding every kind of
Tautology in D1 that a reviewer is shown, beside honest tests, comments and criteria. A live
tool runs the shipped reviewer over it with a real model, told what a launched reviewer is
told. Every Tautology must be raised and no honest item may be. The tool must be seen failing
on the personas as they were before this ADR. A judgement that cannot report is a gate's, not
a reviewer's, and is proved by the drift tests (D4). It is a tool, like
`tools/evaluator-probe.ts`, and not part of `bun test`, whose tests are unit tests.

## Consequences

- A Run that proved a bug with two different commands no longer proves it. Its gate fixes
  are told why.
- Runs with a goal and no constraint read `unverified — nothing was judged` where they read
  `aligned: true`. Taking a goal from a plan's spec, which cego/collie#164 also asks for, is
  separate work.
- A text search is still recorded, and an agent may run one for its own use. It just proves
  nothing.
- Whether a feature's test is a Tautology stays a reviewer's judgement. A model can miss one,
  and the human at the merge request is the last check.
- One text reaches every agent, so a change to it changes every workflow at once. The live
  tool is how a change to it is checked.

## Considered

- **A shipped skill that every persona mentions.** Rejected. An agent reads a skill only if it
  follows the mention. Each persona, and each fork of one, would have to carry the mention,
  which is the same copy problem again.
- **The rule in every persona, kept the same by a test.** Rejected. That test would assert
  that each file contains the text, which restates the files. A fork in a user's Layer would
  still keep the copy it was forked with.
- **Gating a feature's new tests on fail-then-pass, like a bug's.** Rejected by D5.
- **Collie running each new test against the base's source.** That is the real proof that a
  test can fail. It is a feature of its own and is not taken here.
- **Letting a goal be reported against.** Rejected for now. A fan-out child's goal can be its
  whole plan's, and every child would then be judged against all of it, the error #129 was.
