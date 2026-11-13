# A check red before the Run is reported, not fixed

The gate before `implement` opens a merge request runs every approved check on the final
tree and hands each failure to the implementer, for up to four gate fixes. It could not tell
a failure the Run caused from one already on the default branch, so Runs spent their fixes,
or died, on checks that were red before they began, and a human hardcoded master's typecheck
errors into a verify script to get past it. [ADR-0010](0010-a-run-proves-its-outcome.md)
still holds: evidence is collected against a revision, and no gate is satisfied by a claim.

The first form ran the whole approved set before the build, on the tree the Run started
from, and was abandoned for two reasons. A fresh worktree has no dependencies until the
build agent installs them, so every check failed there and every later breakage would have
been excused. A fix round or a follow-up starts from the branch it continues, so the
branch's own failures would have been excused too.

## Decision

At the gate, a check that failed is run once more by Collie, before any gate fix, at the
merge-base of the Run's checkout and the default branch, in that same checkout: that
revision is "before this branch" for a fresh Run, a fix round and a follow-up alike, and the
checkout already has what the build installed. This is the **baseline**, journaled so a
resume does not run it again. A check that fails there too and still fails at the gate is
not a gap for the gate fixes: the merge request names it as failing before the Run's
changes, with the revision it also failed at. The rule covers a check a ticket promised as
well as the approved set, since both are statements about the same check.

The comparison fails safe. A checkout with changes of its own, no default branch, no
merge-base, or a result other than a clean fail at the base means the failure is the Run's
own, and it is fixed as before. The checkout is put back afterwards, and a comparison a
crash interrupted is put back by the next verification. Nothing becomes a pass.

The latest of Collie's results for a check on a tree is the one that counts, so a pass
contradicted by a later fail on the same tree is a failure.

## Consequences

Each check that fails at the gate runs once more, at the base, adding its wall-clock time:
on the frontend monorepo, minutes of typechecks. Nothing more is known before the build, so
the implementer learns of a pre-existing failure only if the gate reaches it. A check red on
the base hides any new failure in the same check, because only the exit code is compared.
The base runs with the branch's installed dependencies, so a lockfile the branch changed can
make it fail when it would not have, and excuse a real breakage. The merge request says the
comparison is by exit code only rather than claiming more. A promise that such a check cannot
keep is reported in the merge request, not fixed. Comparing the failure output as well is
the upgrade, when a hidden new failure happens in practice.

While a check runs at the base, the Run's checkout is detached there, for as long as the
check takes. A worktree a human also works in — a Task's, or one a follow-up reopened — is
not theirs in that window: a commit made then lands on the detached HEAD and is left off the
branch when it is checked out again, and an edit to a file that differs between the two
makes the restore fail, which stops the Run with the checkout left at the base for the next
verification to put back. A comparison in a separate checkout would avoid this, at the price
of installing the project's dependencies there, which Collie does not know how to do.

## Amended 2026-10-15: compared test by test

#89 (e35fc570) removed the exemption above. It rewrote the glossary's **Baseline** as
diagnostic context, because an exit code cannot establish that a Run added no failures —
the hole named under Consequences. It left this record and `docs/workflows.md` promising
the exemption, and left the merge request's "also fails at" line where nothing could reach
it. What that cost was measured on 2026-10-14 (investigation run-556cba08): run-42a58022 and
run-c9e655bd.implement each spent four gate fixes, about an hour, on Collie's own
2,800-test suite at load 35–68, then parked. Their `check` had failed at the base too. Across
24 of that day's check logs, 15 different tests failed, one to three per run and a different
set each time. Every fix agent disputed the failure, with evidence, and changed nothing, and
the gate ran the same tree again regardless.

The exemption comes back, decided per test, which answers #89's reason where a check's
output says which tests failed and leaves #89's rule standing where it does not.

- **Which tests failed is read from the check's own output.** When a check fails, the host
  reads the failing tests from its log, for a runner whose output it knows — bun test first,
  another runner when a project needs one — and keeps them on the record.
- **A test that fails and then passes alone is a flake.** The host runs only those tests
  again, once, on the same tree, with the runner's own command in the check's directory, as
  a `rerun` pass. One that passes is a **Flake**: not a gap for the gate fixes, never a pass,
  and named in the merge request under **Not settled by the run**. For such a check the
  rerun takes the place of the whole-check recheck. A check whose failures name no tests
  keeps the whole recheck and the exit-code flake rule.
- **The baseline is per test.** The tests still failing after the rerun are run at the
  merge-base, in the same checkout and with the same detach and restore as above. A test
  counts as failing there only where the runner reports it failing, so one that does not
  exist at the base is the Run's own. When every still-failing test fails at the base too,
  the check is not a gap for the gate fixes, and the merge request names those tests and
  the revision. Any other still-failing test makes the check a gap, as before.
- **A check whose failures name no tests gets no exemption, and no baseline run.** #89's
  reason holds for it: the exit code cannot tell. It goes to the gate fixes.
- **A gate fix that changes nothing ends the fixes.** When a round leaves HEAD and the
  fingerprint as they were and disputes every finding it was handed, another round would
  check the same tree again. The gate goes on to the merge request, which names the
  still-failing check and the dispute under **Not settled by the run**. The Run's outcome
  stays unproved ([ADR-0010](0010-a-run-proves-its-outcome.md)): no gate is satisfied, and
  the human decides in the merge request before it lands, as the gate did before #89.

What a check's result on a tree is stays as it was: the latest of Collie's results counts,
and nothing here turns a failure into a pass.

### Consequences of the amendment

- A flaky test costs a rerun of itself, seconds rather than a suite, and no fix.
- A test that fails twice at the gate under load but not at the base is the Run's own. The
  fixes are handed it, and a fixer that disputes it without a change ends them.
- The rerun runs the runner directly, not the check's own wrapper. Collie's suite runs
  against compiled executables (`tools/test.ts`) and a bare `bun test` runs the sources, so
  a failure only the compiled executable shows would read as a flake. A check that declares
  its own rerun command is the upgrade, when that is seen to happen.
- A check whose one command reports test failures beside a failure of another kind (a lint
  that runs alongside the tests) is judged on its tests. Collie's own `check` stops before
  its tests when lint or typecheck fails, so its failures name no tests then and get no
  exemption.
- A check red on the base no longer hides a new failure in it: a new failing test is not
  one the base reports, and a check that names no tests is not exempted at all.

## Amended 2026-10-19: a check is not run whole again on a tree it failed on

The stall rule above ended the gate fixes, but it was read only after the stalled round had
run every failing check whole again on the unchanged tree, and the proof then ran each
unsettled failing check whole once more as a `recheck` (cego/collie#123). On Collie's own
suite under load that is two more suites, often 20 minutes or more each, on a tree whose
result Collie already held.

- **A check's result on a tree stands for that tree.** After a gate fix that left HEAD and
  the fingerprint as they were, no check runs again: the round is read against the records
  already on that tree. A tree that moved is checked whole, as before, and so is a check
  re-granted with another command or directory.
- **The whole `recheck` is only for a check whose failures name no tests.** A check whose
  failures named tests has had them run alone and at the base already; the proof reads
  those records rather than running the check again.
- **Fixes that run out still hold the Run.** When the rounds are spent and a gap is left
  that is not a stall, the Run is held unproved, as
  [ADR-0023's 2026-10-09 amendment](0023-a-rally-is-a-loop-and-a-claim-is-not-proof.md) and
  [ADR-0055](0055-a-run-never-asks-to-run-its-checks.md) D2 say. `docs/workflows.md` lists
  that end beside the others.
- **A resume is the ask to run them again.** The Run held unproved asks a human to repair
  the checks and resume, and a repair can be outside the tree: a tool, an environment, a
  file a check reads. So the first proof after that resume runs each check still failing
  on the tree whole once more, and its named failures alone and at the base, as before.
  From there the rule above holds again, so a resume with nothing repaired costs one more
  run of each failing check and holds the Run again.

## Amended 2026-11-11: the branch's own test is never a Flake

A test that failed and then passed alone was a Flake whoever wrote it, so a branch's flaky new
test reached its merge request merely unsettled, and could merge and turn the default branch
red for the Runs after it. The same happened to a check left to CI through its retried job
(ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job, D4, amended the same day).

- **A test the branch adds or changes is the Run's own.** Collie decides it when it records
  the test's rerun alone: its file is one the branch adds or modifies since its merge-base
  with the default branch, or its name contains a string literal of 16 or more characters on
  a line the branch adds.
- **Such a test that passes alone is still a gap.** It goes to the gate fixes with the rest,
  its finding saying it failed and then passed alone, and it is not run at the base: the base
  cannot have it fail before a change that wrote it.
- **Any other test that passes alone is a Flake, as before.**
