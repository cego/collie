# A review's fix works in the reviewed branch's checkout, and pushes to its open merge request

**Status: accepted, to be built.**

`review` declares no checkout, so its Run is placed where it was started: often the
operator's own checkout, on the default branch. **Fix findings**, when no live implementer
takes the findings, starts a fixer on that Run and tells it to check out the target's head
itself: `git checkout <head>` or `glab mr checkout` in the operator's checkout. Where git
refuses because the branch already has a worktree, the fixer goes to that worktree instead.
Either way the tree it fixed was never the Run's.

run-d1caf911 shows the cost. It reviewed `branch:master...mk/flock-chat-harness` from
`/home/mk/.collie`. The fixer committed in that branch's worktree, and `collie verify
--cwd <that worktree>` was refused with "is not inside run", for the fixer and for the next
round's reviewer alike. Its green `bun run check` stayed a claim. The approved checks the
host runs at the finish resolve the Run's tree from the same record, so they would have run
on `master` with the operator's uncommitted changes: a real result about a tree nobody
fixed. The fixer was also told not to push. The pull request kept its failing head, the
next review raised that as a blocker the fixer had to dispute, and the human pushed by hand.
A rally on a merge request target is worse off: its reviewers read the forge's diff, so
without a push every round re-reviews the change from before the fix.

## Decision

**D1. The fix is given the reviewed branch's checkout.** When Fix findings runs a fixer of
the review Run's own, the workflow first asks the host, through the SDK's Host, for the
checkout of the branch its diff target names. The host resolves it exactly as it places an
`implement` Run of a review's findings. The branch is a merge request's source branch, a
`branch:` target's head, or the branch a `worktree` target is on. The checkout is the one
git already has for that branch, or else a new one cut from the branch's remote tip. A
branch that exists only locally is checked out as it is, without asking the remote. What
the resolver cannot establish is refused in its own words: a merge request of another
project, a range of two shas, `HEAD`, a detached checkout. The refusal is recorded on the
Run, no agent starts, and the menu comes back.

**D2. The checkout is recorded as the Run's own.** The host writes it on the Run as
placement would have done. The Run's cwd moves to the checkout, and its branch and
worktree record are set, `created_by_collie` false for a checkout it found. From then on
everything that reads where the Run works reads the checkout: the fixer and every later
reviewer, `collie verify`, the approved checks a workflow asks for, and the approved set
the host runs at the finish. The tree the Run started in is no longer its tree. The rule
that a verification names a tree the Run owns does not change, because the Run now owns
this one. Asking again, in a later round or on a replay, returns the recorded checkout.
The host decides this from the Run's diff target, never from which workflow asks
([ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).

**D3. `review` still declares no checkout.** Declaring `branch` would cut a worktree at
admission for every review, fixed or not. It would also refuse reviews that never fix
anything: of another project's merge request, of a sha range, of `HEAD`. So the checkout
is made only when a fix needs it.

**D4. The fixer pushes to an open merge request.** Where the reviewed branch has an open
merge request, the fixer pushes its commits at the end of each round. The push is plain,
never forced, so the merge request, its pipeline and the next round's review all see the
fixes. Where that merge request merges itself once green, the fixer does not push and says
why, because that push would be a merge. This is the rule of `implement`'s merge request
step. Where the branch has no open merge request, the fixer does not push. It never opens
or edits a merge request and never comments anywhere. This is the push an `implement` Run
of the same findings would make, so the two ways of saying "fix this" agree.

## Consequences

`place.cwd` is no longer fixed for the whole life of a Run. A workflow that asks for the
reviewed branch's checkout moves it, and [`docs/sdk.md`](../sdk.md) says so. Nothing else
moves a placed Run.

Verifications recorded before the move stay in the journal, bound to the tree they ran
on. A check counts only on the revision it ran at, so they count for nothing on the
branch.

Where the operator's own checkout has the reviewed branch out, the fix works there, as it
did before, because git allows no second worktree on a branch.

A host that stops after cutting a checkout and before recording it leaves a checkout
behind. The next attempt finds it and records it as not made by Collie, so pruning never
removes it. That leaks a checkout but never removes work. Recording a placing receipt, as
admission does, is the upgrade if this happens in practice.

Whether the fixer pushed is a claim in its Output, and nothing gates on it. The fixer
checks auto-merge itself, as `implement`'s does, until the forge adapter of
ADR-0050 reads it for Collie. The prompt names no
forge's CLI for the push.

Handing the findings to a live implementer, and **Fix findings in a full implement run**,
are unchanged: each works in its own Run's checkout.

## Amended 2026-10-22: a fix that cannot run is not offered

D1 let a review offer **Fix findings** for a target with no branch to fix, refuse the
answer, and offer it again. Every answer was refused the same way, and replays wrote the
refusal to the Run's log again each time (cego/collie#185).

- **The review asks the host before its first menu.** The host answers whether the reviewed
  branch can be established, by the same resolution as the checkout, without cutting or
  recording one. The answer is taken once per Run, inside an Activity.
- **What the answer refuses is not offered.** Where it refuses, **Fix findings in a full
  implement run** is withheld, because its build is placed by the same resolution. **Fix
  findings** is withheld too, unless a Run in this one's lineage may have a live implementer
  to hand the findings to, since a hand-off needs no checkout. The menu's question names
  the refusal.
- **A refusal at fix time stands for the rest of the Run.** The checkout can still be
  refused when the fix starts. Then neither fix is offered again, and the next question
  names why.
- **A refusal is logged once per answer.** It is recorded inside the Activity that met it,
  so a replay does not write it again.
