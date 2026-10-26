# An open merge request is staged by a Run of its own, without its review

**Status: accepted, to be built.** Builds on
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md)
D6 (the claims, and staging a merge request before its merge) and
[ADR-0050](0050-a-merge-request-is-its-forges.md) D4 (what Collie decides on, it reads
itself). It keeps [AGENTS.md](../../AGENTS.md) Invariant 1.

On 2026-10-22, on vm-mk, the human wanted spilnu/frontend/monorepo!355 on stage to test it.
No Workflow puts a merge request on stage and nothing more, so Flock chat started `release`
on it. The goal said "do not merge it, create a release/tag, or deploy to production", but
`release` reads only its `mr`. It answered a comment round, proved its Checks, and then
waited in the review wait for "CI and a teammate's approval and the review threads to be
resolved". Its "Stage the merge request" path is offered only after that wait. The human
asked "Why is this stuck?" and said: "We don't need an approval to deploy to stage from a
mr". Chat then steered the agent to deploy by hand. Dann held six of the seven Helle
projects !355 deploys under, so the agent asked how to proceed, outside any rule the
Workflow keeps.

Staging an unmerged head is not a release. It ships nothing, the Run's rollback undoes it,
and while the Run holds the claims, stage is its own. The review, the approval and the Go
guard a merge and production. They protect nothing here.

## Decision

**D1. The `stage` Workflow puts one open merge request's head on stage for testing,
unmerged.** Its input is the merge request, hinted as the Run's diff target, so a start
about it joins its Task. It works in the checkout of the merge request's source branch, as
a Release Run does. The start is the request: it asks for no Go. It never asks for or
waits on any of these:

- an approval;
- answered comments or resolved threads;
- a passed pipeline;
- mergeability.

It never merges, tags, pushes, posts, approves or resolves anything, and never plays,
retries or approves a production job. It runs none of the Run's Checks, because it changes
nothing, and what it deploys is what the forge's own pipeline built. A passed pipeline
cannot be asked of it anyway: a merge request pipeline's stage checks run after its stage
deploy. Whoever starts it, a human or an agent, is recorded, and who it was is never a
reason to refuse.

**D2. What it still holds to.** Each of these fails closed, and the reason names the
merge request:

- **The merge request is open.** A merged one fails: its stage is its release's. A closed
  one fails too.
- **It is an application whose merge request pipeline has stage deploy jobs.** The agent's
  read-only assessment names them, per application, with the evidence. A package, or an
  application without such jobs, fails, saying which.
- **What goes on stage is the head the Run read.** The checkout is fast-forwarded to it,
  and a refusal parks the Run, as in a Release Run. Where the head moves before stage is
  proved, the Run stages the new head instead.
- **It holds the claims (D3), or the human said to go on without them.**
- **A failed stage is rolled back.** Where a stage deploy or stage check fails, the agent
  rolls stage back to the newest release production carries. Collie proves the rollback
  (D4) and gives the claims back. The Run then fails with what failed, and offers
  `Stage again`. A failed rollback the forge cannot show off stage fails the Run with the
  claims kept.

**D3. It never waits for one claim while it holds another.** The Run claims in Helle
every project the stage deploys under, resolved as a release resolves them. Before it
takes any, it reads who holds each one:

- **All free, or already the operator's:** it takes them all in Helle's order and stages.
- **Some held or queued for by someone else:** it asks:
  - `Wait for all` queues for every project in Helle's order, at no model cost, and stages
    everything once all are handed over.
  - `Stage what is free` takes only the free projects, and waits for none. It stages
    only the applications whose stage jobs deploy under projects it holds. A project
    taken by someone else meanwhile is left too, and every one left is named. It never
    plays, retries or rolls back an application it left: its rollback too touches only
    the environments it staged.
  - `Finish` ends the Run with nothing staged.

The human chose this on 2026-10-22 over staging each application as its claim is handed
over. That would hold one project while waiting for another, and two Runs on one
repository could each hold what the other waits for. Projects that cannot be resolved, a
claim the operator already holds, and going on without a claim are asked about as in a
Release Run.

**D4. Stage is proved per environment.** Collie reads it from the forge, never from an
Output:

- **On stage:** each named stage job passed on the head's pipeline, and every stage
  environment that pipeline deployed to has a newest successful deployment that carries
  the head.
- **Off stage:** every stage environment the Run deployed to has a newest successful
  deployment that no longer carries the head and carries what production's does.

A stage environment is the Run's only where a job the Run played deployed to it: on
GitLab, by the deployment's job; on GitHub, by the job its status's log points to. A
deployment of the same commit by anything else, such as a teammate's stage of the same
head, is not the Run's. It is never proved on and never rolled back, and it fails nothing.
Where the head moved before stage was proved, the environments the earlier head's jobs
reached stay the Run's to roll back. Stage is unproved where no environment is the
Run's.

This replaces reading only the newest stage deployment of the whole project, for the
Release Run's staging of a merge request too. A monorepo deploys one environment per
application, and the newest stage deployment showed only one of them.

**D5. While stage carries it, the Run holds the claims and asks.** The question names:

- the merge request and its head;
- the stage jobs at their addresses;
- the applications left off stage, if any;
- the claims it holds.

Its options:

- `Done` rolls stage back, proves it off and gives the claims back. The Run succeeds as
  staged and rolled back.
- `Stage again` stages the merge request's head as it is now. It stages the applications
  it holds, and any it left off whose projects are free by then. It takes only free
  projects and waits for none, because it already holds claims (D3).
- `Leave it on stage` gives the claims back and leaves stage as it is. The Run succeeds
  as on stage at that head.

**D6. Its words are staging words.** Its title, card, question and ending say what it
does: staging a merge request for testing, unmerged. None of them say release, approval,
merge or Go. The Task's Ready to release stays what it is, a fact about the merge request
and not something this Run waits for.

**D7. Implement offers it beside `Release`.** Implement's "What next?" offers `Release`,
`Stage` and `Finish`. `Stage` starts `stage` as a child on the merge request, waits for
it, and asks "What next?" again however it ended: staging decides nothing about what
follows. A succeeded implement Run with an open merge request offers `Stage` as it offers
`Release`. `then` gains no `stage`: an unattended Run would hold stage with nobody there to
test it.

## What this does not decide

- Staging an application as each of its claims is handed over (D3).
- Restaging by itself when the merge request's head moves after it is proved. `Stage
  again` does that on the human's say.
- Staging several merge requests together.
- Hiding Ready to release from a Run that does not merge.

## Consequences

`release` keeps "Stage the merge request" for an approved merge request it will merge
after the test. A merge request that only needs testing gets a Stage Run instead, and
chat finds it by its description. Both share one routine for the claims, staging, rollback
and their proofs, so a merge request is staged the same way either way. A Stage Run waiting
for the human to finish testing is in Needs you, and holds stage until they answer.
