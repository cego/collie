# A merge request is released by a Run of its own, on a human's go

**Status: accepted, to be built.** Builds on
[ADR-0050](0050-a-merge-request-is-its-forges.md) D4 (what Collie decides on, it reads
itself) and D5 (whose a merge request is),
[ADR-0054](0054-a-reviews-fix-works-in-the-reviewed-branchs-checkout.md) D1 (the reviewed
branch's checkout), [ADR-0022](0022-a-workflow-is-made-of-workflows.md) (children) and
[ADR-0025](0025-a-card-is-facts-and-an-offer-is-a-declaration.md) (offers). It takes the
claim, the stage step and the production wait from `renovate`.

An implement Run ends once its merge request is open and its checks left to CI are proved.
Everything after that is done by hand. Someone answers the reviewers' comments, fixes what
they found, pushes and chases the approval. Then they claim the project in Helle, deploy to
stage, merge, tag and play production. `renovate` already does the second half for its own
batch branch, under the claim. Nothing does it for a merge request a Run built.

The human set the rule on 2026-10-13. An agent merges, tags and stages only after a human
has said the merge request is good. Production goes only on a second ok. Nothing is
approved when a Run starts.

The merge watch also stands in the way. It stops every running Run of a Task that was
created before the Task's merge request merged. A Run that merges a merge request and then
goes on to tag and deploy would be stopped by its own merge. So would the implement Run
waiting on it.

## Decision

**D1. The `release` Workflow takes one merge request the rest of the way.** Its input is
the merge request. It works in the checkout of the merge request's source branch: the one
git already has, which is the implement Run's worktree where it was started from one, or
else one cut from the remote tip, as ADR-0054 D1 cuts it. It is held to the Checks of the
Run it was started from. A Release Run started on its own resolves its Checks as any Run
does. It works on GitLab and GitHub alike.

**D2. An implement Run offers it at its end.** Once its merge request is open and its
checks left to CI are settled, an implement Run asks on the Run "What next?", with
`Release` and `Finish`. The card's answer menu answers it, and so do the CLI and chat.

- `Release` starts `release` as the implement Run's child, on its merge request, and waits
  for it. A release that fails fails the implement Run, as `plan`'s chained children do.
- `Finish` ends the Run as it ends today.

A merge request set to merge itself once green is not asked about: it is already on its
way, and the Run ends as it does today.

A new `then` input on implement decides without asking. `finish` ends at the merge request
with nobody asked. `release` starts the child at once. A plan started with
`then=implement` starts implement with `then=finish`, and so do a fan-out's Repo runs. Work
nobody attends, an Improvement among it, still asks nobody anything before the merge. A
succeeded implement Run with an open merge request also offers `Release`, so a Run that
finished can still be released later.

**D3. Until the merge request is approved, the Release Run answers external review
comments.** An external review comment is one by anyone but the forge login Collie acts
as (ADR-0050 D5). A bot's comment and the forge's own system note are not one. A reply in
a thread counts as a comment of its own. Collie reads the comments and the approval through
the forge's adapter, never from an Output (ADR-0050 D4).

The host does the waiting. It reads the forge every 5 minutes and spends no model tokens.
The card says what the Run is waiting for. A Hold or a Stop ends the wait.

Each round hands the comments that are new since the last round to the Run's own agent:

- It checks each one against the code. What holds, it fixes test first, commits and pushes.
- One it judges wrong, it disputes, with a reason.

Collie then posts one reply per comment through the adapter: what fixed it and in which
commit, or why it was not changed. Each reply links the comment it answers. A comment is
answered once Collie's login has replied in its thread or posted a reply that links it, or
once its thread is resolved, so a later Run can tell what is still open. Collie never
resolves a thread, because that is the reviewer's call. It runs the Run's Checks on the pushed head and waits for each check left
to CI there. A failure is the next round's finding, and those rounds are bounded the way
implement's gate fixes are.

**D4. "Approved" is the forge's word.** On GitLab, its approval rules are met. On GitHub,
the review decision is approved. Where a repository requires no approval, the merge
request is approved unless an external reviewer's latest review asks for changes. An
approval by Collie's own login never counts. Collie's login does approve merge requests,
through `review`, and the forge counts that approval like any other, so dropping the login
from the list of approvers is not enough. The rules must be met without it. On GitLab,
each approval rule is counted again without Collie's approval. On GitHub, where Collie's
approval stands, the other approvals must reach the base branch's required count. Where
that count cannot be read, the merge request is not approved.

**D5. A go is asked when the work is ready, never at a start.** Collie asks whether to
start the release once all of these hold:

- the merge request is approved;
- no external comment is unanswered;
- Collie's Checks and the forge's pipeline passed at its head;
- the forge says it can merge.

The question names the merge request, its head and who approved it, and it raises the
Run's needs-you notification. A go holds for that head only. If the head has moved, a new
comment is unanswered or the approval is gone, the Run goes back to D3 and asks again once
the merge request is ready. A head somebody else pushed is proved like any other: the Run
fast-forwards its checkout to it and runs its Checks there before it can be asked about.
A head that does not fast-forward parks the Run, and nothing is reset. Whoever answers is
recorded, and who it was is never a reason to refuse ([AGENTS.md](../../AGENTS.md), Invariant 1). `Finish` ends the Run where it
stands, with the merge request open.

**D6. The Run decides what kind of repository it is before the go, and claims it after.**
Before the review wait, its agent reads the repository and decides, with the evidence,
whether it is a package or an application. This reads only, and no claim is held. A
package publishes from its tag pipeline and deploys nowhere. An application has deploy jobs
or environments of its own, and the agent names the stage deploy jobs of its merge
requests' pipelines and of its tags' pipelines. The first go's options depend on the
answer. After the go, the Run claims in Helle every project the release deploys under and
holds the claims until it ends, as `renovate` does. The agent also names the applications
the release deploys. A monorepo deploys several, and Helle keeps a project for each in the
repository's own group (`spilnu/frontend/monorepo` deploys `spilnu/frontend`'s `spilnu`), so
the projects are the repository's own, plus each project of its group that an application
or a deploy job's name names, unless the repository's `.collie/helle.json` names them.
Each of those names a project by its slug or one of its Helle shorthands (`spilnu`'s `sn`),
ignoring case. A name two projects answer to is unresolved, naming both, and nothing is
guessed from part of a name. A resolved project is claimed, recorded and given back by its
slug, because Helle's routes take the slug. The human asked for shorthands on 2026-10-22.
Claims fail closed: where the projects cannot be settled, or a claim cannot be taken,
nothing is merged or tagged and the human is asked; only their recorded say goes on without
one. A release that went on "without one" merged and tagged a monorepo holding no claim.

The human set the application's two paths on 2026-10-20. Its first go offers both, each
only where its stage jobs were found, and `Finish`:

- **`Stage the merge request`**, for a human who wants to test before anything merges.
  1. The agent deploys the merge request's own pipeline to stage and runs the repository's
     stage check. Collie proves from the forge that the named stage jobs passed at the go's
     head and that stage carries that head.
  2. Collie asks the second go while the human tests, with `Send to production`,
     `Leave production to me` and `Finish`. Nothing is merged yet, so this go holds for
     that head on stage. It is checked against D5's readiness and against stage still
     carrying the head. Where either fails, nothing is merged: stage is rolled back, the
     claim is given back, and the Run goes back to D3.
  3. On `Send to production`, Collie merges, the agent tags, and production is played with
     no further question. On `Leave production to me`, Collie merges and the agent tags. On
     `Finish`, nothing is merged and stage is rolled back.

  When this stage fails, the agent rolls stage back to the newest release production
  carries, and the claim is given back. The failure is the next round's finding under D3,
  so the go is asked again on the fixed head.

- **`Merge, tag and stage`.**
  1. Collie merges. The agent tags, and the tag's pipeline deploys to stage, where the
     agent runs the repository's stage check.
  2. Collie asks the second go, with `Send to production` and `Leave production to me`.
     The human verifies stage before answering. The merge request is merged and can no
     longer be ready in D5's sense. So this go holds for that tag and the production jobs
     it names, and never goes back to D3. On `Send to production`, Collie reads the tag and
     its jobs again. The agent plays only the jobs still waiting, and nothing where
     production already carries the merge. A tag that moved, or a job gone or failed,
     plays nothing and fails the Run with the claim kept.

  A stage that fails after the merge is rolled back the same way. The Run fails: nothing
  went to production, the merge stands, and the fix is a new merge request.

On both paths, the agent watches the tag's pipeline until only manual production jobs are
left. Collie proves the tag **ready for production**:

- it is on origin and carries the merged commit;
- where the tag's pipeline staged it, stage carries the merged commit and its stage jobs
  passed;
- each named production job waits to be started by hand;
- every job that finished passed, and no other job is still running or waiting to run.

It does not ask for the pipeline to have succeeded. A blocking manual job holds the
pipeline until it runs, and it must not run before the second go. The Run then waits until
the forge shows production carries the merge, whoever played it. That is the application's
proof that it finished. Then the Run gives the claim back.

For a package, Collie merges, and the agent tags. Where the package publishes from its
tags, the agent also makes the forge's release. The agent watches the tag's pipeline to
success, and then the claim is given back.

**D7. Collie merges, and the agent tags.** Collie merges through the forge's adapter, at
the head the go was given for and by the forge's own rules, with the merge method the
repository uses. It never merges as an admin, never skips a check, and never sets the
merge request to merge itself later. It reads the merged state back. The tag follows the repository's own conventions:

- the next version, chosen from the change since the previous tag;
- a release commit, where the repository makes one;
- an annotated tag, pushed.

Collie reads the tag back on origin rather than from the Output. Each agent step is told
its Clearance.

**D8. A merge does not stop the Run that lands it.** Before it merges, the Run records an
attempt to land that merge request, naming the head. The attempt becomes landed when the
forge answers the merge, and is withdrawn on a refusal or when the forge says the merge
request was already merged. When that merge request merges, the merge watch leaves the
landing Run running, and the Runs it was started from too. It spares a Run whose attempt
is in flight, too. It still stops every other Run of the Task. If a human merges the merge
request by hand first, the Release Run is stopped, as before.

A restart can lose the forge's answer. An attempt left by an earlier host is then settled
on the forge's word, the same way by the replayed merge and by the watch. A merge by
Collie's login, at the attempt's head, no earlier than the attempt, is the lost answer.
Any other merge is someone else's: the attempt is withdrawn and the Runs are stopped.
Collie's login is the operator's own, so a hand merge by that login, at the very head the
go approved, after the attempt, cannot be told from Collie's. It is taken as the merge the
go asked for.

**D9. A release that failed after its merge is finished, not started again.** A failed
Release Run offers `Release again`. A Release Run started on a merge request that is
already merged goes on only where it takes over the landing of a Run that landed it and
ended without succeeding, at the merged commit the forge reports. It then:

- skips the wait, the first go, the merge request's stage and the merge, because that go
  was spent;
- takes the claim over;
- finishes the tag, with its stage where the tag's pipeline deploys one;
- for an application, asks the second go afresh.

A merge request merged by hand, or one a Run already released, still fails at the start.

## What this does not decide

- Releasing several merge requests of one fan-out together. Each Repo run's merge request
  is released on its own, through its offer.
- Resolving a reviewer's thread.
- A new Outcome kind. What a release establishes is read from the forge.
- Rolling production back.

## Consequences

An implement Run started without `then` no longer ends as `succeeded` when its merge
request opens. It asks, and its card is in Needs you until somebody answers. While a
release runs, the implement Run, its builder and the Release Run's own agent stay live.
That can be days, while reviewers take their time. A requester that started an implement
Run hears from it once the question is answered and whatever it started has settled.

`renovate` merges its own batch merge request too, and can record that it lands it in the
same way.
