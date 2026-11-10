# A Task's merge requests are its waves' changes

**Status: accepted.** Builds on
[ADR-draft-a-tasks-work-is-what-its-runs-worked-on](draft-a-tasks-work-is-what-its-runs-worked-on.md)
(a Task's work is read from its Runs' records, and nothing new is recorded),
[ADR-0050](0050-a-merge-request-is-its-forges.md) (one forge interface; Collie reads for
itself what it decides on),
[ADR-draft-a-merge-request-is-released-on-a-humans-go](draft-a-merge-request-is-released-on-a-humans-go.md)
(one Go per head) and
[ADR-draft-an-open-merge-request-is-staged-by-a-run-of-its-own](draft-an-open-merge-request-is-staged-by-a-run-of-its-own.md).

One piece of work often needs several merge requests. They can be in one repository, in
several, or in both. Collie already starts a plan's work as waves of Repo runs, one per
repository. Everything after a merge request opens, though, assumes a Task has one:

- the board takes the first merge request it finds among the Task's Runs (`findFirst`);
- the sentence, Ready to release, the Flow's release row, the drawer's panel, Desktop's tab
  and `collie_run` each name that one merge request;
- a human's Disposition takes its ref from it;
- when any merge request of the Task merges, the merge watch stops every running Run of
  the Task, including Runs working on a different merge request;
- four different keys (`mrLabel`, `mrKey`, `mrKeyOf` and a Disposition's `ref`) compare
  merge requests, and they disagree on host and case.

In a multi-repository fan-out, the card shows no merge request at all.

On 2026-11-06 the human decided that several merge requests come from the wave system. The
model of one Run with one merge request as its output is not to be stretched to cover them.

## Decision

**D1. A Change is one merge request's worth of a plan's work.** A ticket may name its
Change with a `**Change:** <name>` line beside its `**Repo:**` line. A ticket with no such
line belongs to its repository's default Change. A plan written today therefore still has
one Change per repository, and nothing about it changes. Each Change has its own branch:

- the default Change uses the plan's branch;
- a named Change uses the plan's branch with `--<name>` appended.

git checks a branch out in only one worktree, so two Changes in one repository cannot
share a branch.

**D2. A fan-out starts one Change run per Change, in waves.** A Change run is today's Repo
run with its key widened from a repository to a repository and a Change. It still owns one
checkout, one branch and one merge request, and it opens that merge request with the
delivery contract it has today: one `mr_url`. Waves order Changes, not repositories, and
"Blocked by" works the same between Changes as it does between repositories now.

A Change blocked by another Change in the same repository is **stacked**. Its branch is
cut from the blocker's branch, and its merge request targets the blocker's source branch.
When the blocker merges, Collie reads the retarget from the forge and does not do it
itself.

Any plan with two or more Changes fans out, even when they are all in one repository.

**D3. A Run still opens at most one merge request.** The Run's `merge-request` file, the
landing record, the claims, the Checks and the Go stay per Run. A Follow-up Run that opens
a merge request records it on itself, not on its parent. A Task's merge requests are its
Runs' merge requests: each one a Run opened, and each `mr:` diff target a Run was given.
They are read from the records, as the earlier ADR's D1 says. A Task stores no list of its
own, and no merge request is singled out as primary.

**D4. One identity per merge request.** An **MR id** is the forge host, the project path
and the number, compared in lower case: `gitlab.cego.dk/spilnu/app!42` or
`github.com/cego/collie#300`.

- Every comparison goes through this one function: joining a Task, the merge watch,
  landing, cleanup, Dispositions and deduplication.
- A legacy bare `mr:42`, and a Disposition `ref` stored as a hostless label, are resolved
  to an MR id when they are read, against the Run's checkout. Nothing on disk is rewritten.
- A human is still shown the forge's own word and name.
- A project renamed or moved on the forge is out of scope here.

**D5. Facts are kept per merge request, and the Task's state is their aggregate.**

- The merge watch reads each of the Task's merge requests separately: open, merged,
  closed, on stage or in production.
- A Disposition names the merge request it is about. Its ref is the MR id, and it is
  recorded on the Run that owns that merge request. Each merge request has its own latest
  Disposition.
- A Task has **Landed** only when every one of its merge requests is merged, or carries an
  `abandoned` or `superseded` Disposition, and no Run of the Task is still going.
- A merge request that closed without merging and has no Disposition keeps the Task in
  Waiting on you, and the card names that merge request.
- **Ready to release** is judged per merge request, at its own head. A Task leads Waiting
  on you as Ready to release when at least one of its merge requests is ready. The
  sentence says which ones are ready and which are not, for example `1 of 3 merged;
  app!12 ready to release; api!7 waits on app!12`.

**D6. A merge stops only the work on that merge request.** When a merge request merges,
the merge watch stops the running Runs whose work is that merge request:

- the Run that owns it;
- Runs given it as their target;
- its Release Runs and Stage Runs;
- Follow-up Runs on its branch.

The landing exemptions in the release ADR's D8 still apply. Runs of the same Task that are
working on other merge requests are not stopped.

**D7. Every action names its merge requests.** Release, stage, review, review again, post,
open, fix findings and dispose each take one MR id, or a set that the human selected. An
offer on a Task or on a fan-out lists its merge requests and does not default to all of
them. With one merge request, the offer looks as it does today. No action reaches a merge
request outside what was named, and chat's `collie_do` takes the same explicit argument.

**D8. A set is released as a wave of Release Runs.**

- Releasing a selected set starts one Release Run for each merge request in it.
- The Release Runs follow the Changes' wave order. A Release Run whose Change is blocked
  waits, at no model cost, until its blocker's merge request has merged.
- A Go stays per merge request and per head. Where several merge requests in the set are
  ready together, Collie asks once and lists each ready merge request at its head, and the
  human picks which of them go. Each pick is recorded as that merge request's own Go on
  its own Release Run.
- A head that moves withdraws only that merge request's Go. The second Go, for
  production, works the same way.
- Each Release Run claims its own Helle projects under the stage ADR's D3 rule: it never
  waits for one claim while holding another.
- A failed release fails only that merge request's Release Run. The Run the set was
  started from reports how many released and how many failed, and offers `Release again`
  for each failed merge request.

**D9. Dependencies come from evidence, never from manual tracking.** Collie reads two
sources:

- the plan's "Blocked by" lines between Changes, which give the waves;
- the forge's target branch: a merge request that targets another merge request's source
  branch is stacked on it.

A merge request created or retargeted on the forge outside Collie is picked up the next
time the merge watch reads it.

**D10. A Task stays one host's.** Desktop shows the same MR id across Machines once, with
links to each Machine's Task that has it. No action and no Go is taken across Machines on
the strength of that link.

**D11. Nothing stored is migrated.** Old records, old Outputs, old plans and older Desktops
all keep working:

- A Run's `merge-request` file, a legacy `mr:42` and an old hostless Disposition ref are
  read as they are.
- `TaskView` gains an optional list of merge requests, so the protocol stays at 5. Its
  scalar `mr` keeps its old meaning, the first merge request, for readers older than the
  list. An older Desktop therefore shows one merge request until it upgrades.

## Considered options

- **One Run opens several merge requests.** This breaks one checkout per branch, landing,
  the claims and the delivery contract. The wave system already runs several Runs side by
  side. Rejected.
- **A Task-level list of merge requests that a human keeps.** It is duplicate tracking,
  and it drifts from the records. Rejected by the earlier ADR's D1.
- **A primary merge request plus "others".** The others would be hidden from the
  sentence, from readiness and from the actions. Rejected.
- **One Go for the whole set.** A head that moved on one merge request would take back
  every other merge request's Go. Picking from one question gives the same single
  interaction and keeps a Go per head (D8).

## Glossary

To be added to `CONTEXT.md` in the merge request that builds D1:

- **Change**: one merge request's worth of a plan's work in one repository. Its tickets
  are named by a `Change:` line, or belong to the repository's default Change. It has its
  own branch.
- **Change run**: replaces **Repo run**. It is one child Run of a fan-out, owning one
  Change's branch and merge request.
- **Stacked**: a Change blocked by another Change in the same repository. Its branch and
  merge request build on the blocker's.
- **MR id**: a merge request's one identity, made of its host, project path and number in
  lower case.

## Consequences

- A Task card can show several merge requests. With one, the card looks as it does today.
- Ready to release, Landed and the merge watch change meaning for Tasks that have several
  merge requests.
- The questionnaire plan (run-5520175a) asks each Go as a Choice. The pick-several Go in D8
  is a selection with several answers, so it is built after that plan's host contract
  lands.
- Desktop's work goes into today's view and `board-model` Schemas. A Rune view generates
  its types from those Schemas, so it gets the list without a ticket of its own.
- `renovate`, `tune-up` and `self-improve` are unchanged. Each still opens its own merge
  request or merge requests as it does now.
