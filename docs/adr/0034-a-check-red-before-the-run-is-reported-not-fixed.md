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
