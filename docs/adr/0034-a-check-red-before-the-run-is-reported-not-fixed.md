# A check red before the Run is reported, not fixed

The gate before `implement` opens a merge request runs every approved check on the final
tree and hands each failure to the implementer, for up to four gate fixes. It could not tell
a failure the Run caused from one already on the default branch, so Runs spent their fixes,
or died, on checks that were red before they began, and a human hardcoded master's typecheck
errors into a verify script to get past it. [ADR-0010](0010-a-run-proves-its-outcome.md)
still holds: evidence is collected against a revision, and no gate is satisfied by a claim.

## Decision

Before the build, `implement` runs the approved set once on the tree the Run starts from:
the **baseline**, journaled so a resume does not run it again. A check that failed there is
named to the build agent. At the gate, a check that failed on the baseline and still fails
is not a gap for the gate fixes: the merge request names it as failing before the Run's
changes. Only a baseline that surely failed counts; a check that was unstable or refused
there is fixed as before. The rule covers a check a ticket promised as well as the approved
set, since both are statements about the same check. Nothing becomes a pass.

The latest of Collie's results for a check on a tree is the one that counts, so a pass
contradicted by a later fail on the same tree is a failure. Without this, a baseline pass on
a tree the build left unchanged would satisfy a gate whose own run failed.

## Consequences

The whole approved set runs once more per Run, before the build, adding its wall-clock
time: on the frontend monorepo, several minutes of typechecks. A check red on the base hides
any new failure in the same check, because only the exit code is compared, and the merge
request says the check was failing before rather than claiming more. A promise that such a check
cannot keep is reported in the merge request, not fixed. Comparing the failure
output as well is the upgrade, when a hidden new failure happens in practice.
