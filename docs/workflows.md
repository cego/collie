# Workflows

Collie ships eight workflows. This page is the "which one do I want" level: what each is
for, what it needs from you, and how they chain. The files under
[`workflows/`](../workflows) are canonical for step-by-step behavior: each is a TypeScript
module with its Markdown beside it as content ([the SDK](sdk.md)). Any of them is a fork
away from being yours; see [Authoring](authoring.md).

For what a Workflow, an operation, a Choice or a Run _is_, see [`CONTEXT.md`](../CONTEXT.md).

## Choosing one

A task that is not planning, building a change to a merge request, reviewing, renovating
or an architecture survey is `general`'s, never `implement` or `plan` stretched to fit.

## How inputs reach a run

Every workflow declares the inputs it needs. Collie infers what it can from the branch
name, the working directory, an open merge request and earlier runs in the same repo, then
asks you only for the rest and shows one confirm line. Two inputs offer a menu rather than
a guess, because guessing them wrong is expensive: `implement`'s work source and `review`'s
target.

## `plan`

**For:** turning a goal you can describe into a spec and tickets someone — or something —
can build from.

**Inputs:** `goal` (what you want), supplied at launch or asked for when missing. A Linear
issue id or URL goes in the goal, alone or with your words around it: the planner fetches
it first. The goal is the only launch question, and the end menu is asked when the plan is
written rather than before it exists.

`then` is `implement` or empty. The Launch flow leaves it empty; an agent's start gives it,
`--input then=` where unused. With `then=implement` nobody is asked anything: each prompt
tells the planner that nobody is watching, so it decides what is open and records it under
`decided`, and the end menu is skipped for **Implement now** at once. A plan whose tickets
cannot be built then fails with why, rather than asking again.

**What happens:** a planner reads the goal and repository, asks only when a missing
decision changes the work, then writes `SPEC.md` and one ticket per slice into the run's
`plan/` directory. There is no mandatory interview, summary approval, or manual skill
handoff. Plans never enter the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)).

**Ends with a menu:** and you can answer it in conversation. Telling the planner
"proceed", "implement", "build" or "go" makes it answer the menu with
`collie run answer <run id> "Implement now"` — it starts nothing itself.

- **Implement now** — starts `implement` with this run's `plan/` as the work source, as a
  child of this run: stopping the plan reaches the build, and the build is its own Run with
  its own card. A plan whose tickets name several repositories is one per repository,
  which that `implement` starts; see [Plans that span repositories](#plans-that-span-repositories).
- **Second opinion** — one reviewer round over the plan, then the menu again; where it
  reports findings, the planner gets a follow-up round to revise.
- **Offload to Linear** — the planner files the tickets as Linear issues. It asks once
  which team they go to, and that answer stands for the rest of the run.
- **Refine** — another planner round, as often as you like.
- **Finish planning** — finish without starting implementation or another planning round.

Module: [`workflows/plan.workflow.ts`](../workflows/plan.workflow.ts), with its prompts in
[`workflows/plan.md`](../workflows/plan.md).

## `implement`

**For:** building a change end to end on a branch, reviewing it, fixing what the review
found, and opening the merge request.

**Inputs:** `plan`, a work source, and `repo`, optional. It does not need a plan run: inference gathers the three
newest finished `plan` runs for this repo and a Linear issue id in the branch name. One
candidate is taken as the answer; none or several bring up a menu of them plus **Type it…**,
which accepts a Linear id or URL, a path to a plan directory, or a plain description of the
work. What was resolved is recorded with its kind, and the build prompt reads both
`{{inputs.plan}}` and `{{inputs.plan_kind}}` (`plan-dir`, `linear`, `review` or `text`).
`review` is what a run chained from a review carries: the findings are the tickets. For
`linear` and `text` the implementer writes the spec and a task list into the run's `plan/`
before it builds, so every run leaves the same audit trail.

`repo` is one repository's share of a plan that spans several, as the tickets' `Repo:`
line names it: given one, the build step builds only the tickets naming it and leaves the
rest to their own run. It is empty for every single-repository run, which builds the whole
plan, and for the parent of a fan-out, which sets it on each repository's run; see
[Plans that span repositories](#plans-that-span-repositories).

**Branch:** named after the work, not the path to it — an explicit `--input branch=`, else
the reviewed branch, else the `<name>` of a `branch:<base>...<name>` target you gave, else
a new `<your GitLab login>/<task>` from `--input task=`, the plan directory's own name, or
the work itself. Nobody is asked for one ([the full order](cli.md#start-a-run)).

**What happens:** one implementer agent builds, a commit per ticket. It reviews what it
built with the same pass `review` runs — one complete review — and loops on the findings for
at most four review and fix rounds. Every commit is pushed, so the reviewers read the change
rather than the state before it. The merge request is opened or updated last, and not at
all only where there is no GitLab to open one on. Missing evidence does not keep it
closed: an opened merge request is not a gate that passed, and what is unproved is
written into it (see **Ends:**).

**Outcome.** `--input outcome=bug|refactor|investigation|docs|migration|feature` says what
kind of result this run has to prove, and so what evidence closes it — see
[Outcomes](cli.md#outcomes). `plan` settles it during the interview and forwards it, so a
chained build is never asked again. Left empty, a run is held to its checks and nothing
more: unclassified work is not a feature by default, and asking
documentation for a feature's evidence would ask for tickets that do not exist.

**Checks.** A run is held to the checks it started with: `--verify`, else the project's
`.collie/verify.json`, else the ones remembered for its remote, else the user's
`verify.json`. Where none of those names any, the builder names the repository's checks
before it changes anything, from its `package.json` scripts, a Makefile or its CI config,
each with `collie run intent verification`. Nobody approves them, and the merge request
lists each with its command ([ADR-0055](adr/0055-a-run-never-asks-to-run-its-checks.md)).

**Ends:** with the merge request, or fails with the reason there is none — a ticket stopped
on a blocking finding, acceptance criteria still unmet, a review that halted — and says to
continue with a follow-up Run, which **Keep going on this** starts. Nobody is asked along
the way: the human verifies the work in the merge request, before it lands. Where a failed check's
output names the tests that failed (bun test's does), the gate reruns each of those tests
once, alone, on the same tree. A test that then passes is a **Flake**: it is not handed to a
fix and never counts as a pass, and the merge request names it under **Not settled by the
run**. A failed check whose output names no tests is re-run whole once instead, since a check
that fails and then passes is a flake. The gate then hands
what a check could still prove to the implementer for up to four fixes; a reviewer's
judgement or an Output's claim is not handed over, since no fix moves it. Before any fix, each
test still failing after its rerun is run alone once where the branch leaves the default
branch. The merge request names each test that fails there too, with that revision, as
failing before the Run's changes, and a check whose every such test does is not handed to the
implementer; a test that passes there, or that the base does not have, is the Run's own. A check
whose failures name no tests has no baseline and is handed to the fixes. A fix that changes nothing and disputes every finding it was
handed ends the fixes, since another would check the same tree: the outcome stays unproved,
and the merge request names each disputed gap with the fixer's reason. A gate fix lands after the last
review, so the merge request says it was not re-reviewed. What the Run could not settle —
checks still unproved, blocking disputes the reviewers left unanswered, and the assumptions
an implementer made where the spec was silent — goes into the description under **Not
settled by the run**, and the merge request opens anyway.

Once the `mr` step has pushed and the merge request is recorded — opened by the step, or
found from the Task's branch by the merge watch — each check
[left to CI](cli.md#what-collie-may-run-itself) is proved by its pipeline job on the merge
request's head, which must be the checkout's `HEAD`. The run reads the job through the
forge every 30 s while it is pending or running, and its log and `collie run checks` say
which check, job and commit it waits on. A pass is recorded as a verification of the check,
with the job's URL; on GitLab a merged-results pipeline counts for the head it was built
from, and records the merge commit beside it. A job that failed, was skipped or cancelled,
is missing from the pipeline, or has not finished after 2 hours parks the run unproved,
naming the check, the job and the commit, and a resume waits again; a job already recorded
is not recorded twice. A merge of the merge request while the run waits stops it, through
the merge watch, and records nothing for the job.

A failed job is settled before anyone fixes it. The run reads the same job where the branch
leaves its target branch, or on the target branch's latest pipeline where that commit has
none: failed there too, it failed before the run's changes, and the merge request and the
run's log say so, with the commit, and the job gets no fix (ADR-0034). Anything else there —
no merge-base, no pipeline, no such job, any other result — makes the failure the run's own.
That job is then retried once through the forge; a pass on the retry is a Flake, named on
the merge request and the log, and recorded as the check's proof. A job that still fails
starts a **CI fix round**, `ci-fix-<n>`, on the builder: its prompt names every failed
check with its job, the job's URL and the forge adapter's command for its log, and has it
push without `ci.skip`. The run then waits on the job again on the new head commit, and the
merge request is updated by that push, never opened again; a note on it says the fix
landed after the last review and was not re-reviewed. A round that pushes no new commit
parks the run saying so. A round that changes nothing and disputes every failure ends the
rounds by the gate's own rule: the dispute is named on the merge request and the log, the
check stays unproved, and the run completes. The rounds stop at the gate's limit of 4;
after the last, a job still failing parks the run unproved, naming the check, the job and
the commit. The CI fix loop is kept apart from the gate's: what fails, how it is read
again and the steps a replay depends on all differ, and only the round limit and the
dispute rule are shared.

Module: [`workflows/implement.workflow.ts`](../workflows/implement.workflow.ts), with its
content in [`workflows/implement.md`](../workflows/implement.md).

## Plans that span repositories

Most plans worth the name touch more than one checkout: a backend contract, its generated
client, a frontend. `plan` writes one plan directory for all of it, and every ticket in it
carries a `**Repo:**` line — the checkout it changes, relative to the plan run's root and
as it is on disk, or `.` when the root is itself a repository.

A `plan` or `architecture` started from the Home runs at the
[Projects root](../CONTEXT.md) — `workspace=projects-root` — and its agent is told the root
is not a repository: it finds the repositories under it, and each `Repo:` is relative to it.

A plan is single-repository only when its tickets all say `.`, or carry no line at all. A
plan whose tickets all name one repository _by path_ is not one of those: that repository
is somewhere under the root, and its run has to be rooted there.

Every other plan fans out, whether **Implement now** hands it to `implement` or you start
it yourself from the plan's root with `collie run start implement --input plan=<the plan
directory>`. That `implement` cuts no checkout of its own and builds nothing itself: it
starts one Run of itself per repository, each from that repository's checkout under the
root, each with the shared plan directory, its own `repo` and every other option it was
started with — `risks`, `outcome` — and all on one branch name: the `branch` you gave,
else `<login>/<task>`, else one named after the Run that fanned out, so the sibling merge
requests are findable by it. Each is held to its own checkout's `.collie/verify.json`, else
the checks remembered for its remote, else the ones its builder names. See [Repo run](../CONTEXT.md) for the term.

They start in **waves**. A repository's run starts once every repository its tickets are
blocked by has been built; repositories that block nothing start together. Ticket order
inside a repository is that run's own business, as in a single-repository run. The
`implement` that fanned out is their parent until the last one ends, so stopping it stops
them, resuming it goes on with the ones it already has rather than starting them again, and
its result names what each repository ended as.

- **A repository that did not build** fails, as a single repository does, so no wave
  starts on work that is not there.
- **A repository that fails or cannot start** starts no further wave. The others in its
  wave are left to finish, and the parent fails naming the repository that stopped it and
  the ones that never ran.
- **A plan the fan-out cannot run** starts nothing. Picked as **Implement now**, the reason
  is recorded and shown on the Run, and the menu comes back; started directly, the start is
  refused with it before any Run is admitted. The same reading checks
  the tickets when the planner writes them, and a plan it refuses goes back to the planner
  once, so most of these never reach the menu. The reasons are a repository-level cycle, a
  ticket with no `Repo:` line where its siblings have one, a repository with no checkout
  under the root — Collie does not clone — a `Repo:` that is not a path under the root, two
  tickets wearing one number, or a "Blocked by" line naming something that is not a ticket
  of this plan. The `Repo:` rule is why the line cannot be absolute or contain `..`: it
  becomes the directory a run is rooted at and a branch is cut in, and a plan is prose an
  agent wrote. A ticket number is a word that is nothing but digits: unpadded ones are fine
  (`2` finds `02-…`), and the digits inside a word like `v2` are part of that word, not an
  edge.
- **A card does not fan out.** The plan's own offer on its card, and `collie run action`,
  refuse a plan that spans repositories and name the start that does:
  `collie run start implement --input plan=<the plan directory>`.

A workflow of your own can fan out the same way with the SDK's `planReposOf`
([the SDK](sdk.md#a-workflow-made-of-other-workflows)).

## `review`

**For:** getting one complete review of a change you did not necessarily write.

**Inputs:** `target` — a merge request (anyone's, from any directory), a branch diff, or
the working tree, chosen from a menu. `plan`, `previous` and `risks` are optional: a spec
to hold the change to, an earlier review run to compare against, and extra axes to apply
on top of the complete review (`--input risks=security`) where this change has a risk that
earns one. `outcome` is optional too, and `implement` forwards its own: it names the one
judgement field the reviewer is asked for — `scope_met` for a feature, `behavior_preserved`
for a refactor, `supported`, `accurate` or `compatible` — which is the field the gate before
the merge request reads ([Outcomes](cli.md#outcomes)).

**What happens:** one reviewer reads the target and writes the review — the whole spec, the
whole change, and the code around it. Where a fork seats more than one reviewer, a
synthesis then reconciles what they wrote into the one review a human reads; a lone
reviewer's review is that review — findings deduplicated across models, disagreements
settled against the diff, and anything that cannot be defended listed under `dropped` with
a reason — rendered to `review.md` in the run directory, which is what you read and what
**Post to MR** sends. The shipped review has one reviewer; a fork that wants another adds an
entry to the list in `workflows/reviewing.ts`, not a new step.

Every `blocker` and `major` has to say **where** and **why**: a `file` it is about and a
`detail`. One that says neither goes back to its own reviewer once, rather than to the
implementer. The file does not have to be one the change touched — an unchanged caller the
change breaks is exactly the blocker worth raising. Minor findings are exempt.

**Ends with a question:**

- **Fix findings** — handed, through the one sender, to the implementer already live in
  this workspace where there is one, so no second agent works the same checkout; otherwise
  an implementer of this run's own, given the findings, which fixes them in the reviewed
  branch's checkout — the one git already has for it, or one cut from the branch. That
  checkout is recorded as this Run's own, so the fixer, every later reviewer and every
  verification of the Run work there
  ([ADR-0054](adr/0054-a-reviews-fix-works-in-the-reviewed-branchs-checkout.md)). A target
  with no branch to fix — another project's merge request, `HEAD`, a sha range — starts no
  fixer: the Run's log says why and the menu comes back. Where the branch has an open merge
  request, the fixer pushes each round's commits to it — plainly, never forced, and not where
  the merge request merges itself once green; it never opens or edits one, or comments. A
  fix Collie ran is reviewed again at once, and the rally
  goes on by itself, through the same `settleRound` as implement's, until nothing blocking
  is left, a round raises the same blockers, a dispute stands unanswered, or four rounds
  have run. Then the menu comes back. A hand-off to a live implementer offers **Review
  again** instead, for when it is done.
- **Fix findings in a full implement run** — chains `implement` with this run as the work
  source. The build is placed on the branch this review was pointed at — a branch target's
  head, or a merge request's source branch — read from the review's own Run.
- **Post to merge request** (or **Post to pull request**) — sends `review.md` to the merge
  request it reviewed, verbatim and as a single note, and approves it where nothing live is
  left to fix. Offered only where the target is a merge request, on either forge.
- **Don't post** — ends the run.

Module: [`workflows/review.workflow.ts`](../workflows/review.workflow.ts), with its prompts
in [`workflows/review.md`](../workflows/review.md).

## `renovate`

**For:** the month's dependency chore on one repository, end to end: every Renovate Bot
merge request merged or accounted for, a version tag whose pipeline published or deployed,
and the repository checked off the team's shared Renovate issue.

**Inputs:** `repository`, an existing local checkout or a GitLab or GitHub repository URL,
which is cloned through its forge — empty means the workspace the run was started from. `team`, the Linear team whose
Renovate issue this run records itself on — empty falls back to `linear.team` in your
`config.json`, and the run asks once when neither is set.

**Needs:** Helle credentials in `~/.config/helle/env` and a Linear MCP in Claude Code —
see [Optional integrations](using.md#optional-integrations). The run is refused at start,
with the fix, when the credentials are missing or Helle refuses them.

**Checkout:** its own, and unlike `implement`'s it is **detached** at the repository's
default branch with no branch bound to it, because the run moves across every Renovate
branch it merges. Your own checkout is never touched or switched. See
[A run that roams across branches](using.md#a-run-that-roams-across-branches).

**What happens:** the run binds the team's Renovate issue and appends the repository to its
checklist unchecked, then assesses the whole batch of Renovate merge requests, read only,
and decides whether the repository is a package or an application. Once it has said there is
something to land it blocks — at no token cost — until it holds the repository in
Helle; a repository that is already up to date takes nobody's turn.
For an application it then gathers every update into one batch branch and merge request,
deploys the batch to stage and proves it there — rolling stage back to the latest stable
release, reading the logs `renovate.logs` names, fixing the batch and redeploying, on its
own, when it does not — and waits for another team member's approval before merging the
batch. A package never reaches those three steps at all, and its merge requests are merged
one at a time under the same claim, fixing conflicts and routine dependency fallout on each
merge request's own branch.
Either way it then chooses a version from the whole diff since the previous tag, tags
annotated with changelog-style notes (and creates a GitLab release only where the repository
is a package), waits for the tag pipeline to publish or deploy, and checks the repository
off. Helle is released when the run finishes, and also when a batch nobody approved ends it
with nothing merged. A run that fails keeps the claim, since what it guards may be
half-done, and so does a stage that was not proved: nothing shows stage is back on its
stable release. The run says `claim retained; recovery required` beside where it failed, and
**Recover the retained claim** starts a renovation of the same repository that takes the
claim over, first stopping the failed run and every child it started as `run stop` does,
waiting for them to stop, and closing their agents again. An agent that will not close, or
a run still in the middle of a step, stops the takeover rather than being left to work on.
A run that fails holding no claim offers **Renovate again** instead: the same repository,
team and issue, in the checkout the failed run left, which the new run takes over while it
holds nothing to lose ([A run that roams across branches](using.md#a-run-that-roams-across-branches)).

**On GitHub** the procedure is GitHub's, from its own content file, and the agent never
runs `glab` there. Renovate's pull requests are the ones Renovate Bot opened. A repository
is an application where it has a deploy workflow or a `staging` or `production`
environment, and a package where it publishes from a tag or release. The batch pull
request is gated by its required checks; stage is deployed by dispatching the
repository's own Actions deploy workflow on the batch branch, and rolled back by the same
workflow to the ref production last deployed successfully. The approval is an approving
review on the batch's current head by someone other than this Run's own `gh` login, a
Renovate pull request is merged only at the head that was reviewed
(`--match-head-commit`), and a package's release is a GitHub release.

**It asks you** at the points where asking is the work: a breaking or substantial
migration, an update that cannot be merged safely, a bounded retry that made no progress,
several matching Linear issues, a failing tag pipeline. The Helle claim is held through
every one of them. A run with no open Renovate merge requests reports the repository up to
date, creates no tag, and still leaves the checklist correct.

**Ends:** with the repository checked off, or with what stopped it. There is no menu.

Module: [`workflows/renovate.workflow.ts`](../workflows/renovate.workflow.ts), with its
content in [`workflows/renovate.gitlab.md`](../workflows/renovate.gitlab.md) for a GitLab
repository and [`workflows/renovate.github.md`](../workflows/renovate.github.md) for a
GitHub one.

## `architecture`

**For:** looking at what a project already has and improving the parts whose cost you can
name.

**Inputs:** `goal` (what you are asking about), required. It works on the repo the run is
rooted at, and the architect is told the goal so it knows where to look.

**What happens:** an architect rates every candidate by the deletion test, applies the
strong ones only, and writes a report into the run directory. Everything else is deferred
with a reason rather than half-applied.

**Ends with a menu:** **Implement now** (chains `implement` on the report) or **Stop here**.
**Implement now** names the branch after the `slug` the architect put in its Output, which
is the work you agreed on: `architecture`'s goal is a question rather than a name for the work, so without it
every architecture run in a repo would be handed the same branch
([how the branch is chosen](cli.md#start-a-run)).

Module: [`workflows/architecture.workflow.ts`](../workflows/architecture.workflow.ts), with
its prompts in [`workflows/architecture.md`](../workflows/architecture.md).

## `general`

**For:** one ad-hoc task that is none of the others — upgrade an install, find out why a
job failed, bump one version and commit it. Not planning, not building a change to a merge
request, not reviewing, renovating or an architecture survey: a change that should land as
a merge request is `implement`'s.

**Inputs:** `goal`, the task in your words.

**Checkout:** none of its own. It works in place, in the checkout the run was started for;
started from the Home, it works at the Projects root and its agent finds the repository the
task is about. No branch is cut, so a run that changed no repository has nothing to file
and lands in Finished by itself
([ADR-0056](adr/0056-ad-hoc-work-is-a-general-run-in-place.md)).

**What happens:** one agent does the task. It can ask you in its pane where a decision
changes the result, and it does not push, open a merge request, merge, deploy to production
or do anything irreversible unless the task or your own message in its session says so.
Where it changed code and nothing names the run's checks, it names them with
`collie run intent verification` — with `--cwd` naming the repository, at the Projects
root — and Collie runs the named checks there when the run ends.

**Ends:** when the agent writes its Output. Its `summary` is the run's result and what the
card says, as `Finished; it says: “…”` — a claim, shown as one. A `blocked` reason fails the run with that reason. There
is no menu, and the agent takes steering after the run has ended.

Module: [`workflows/general.workflow.ts`](../workflows/general.workflow.ts), with its
prompt in [`workflows/general.md`](../workflows/general.md).

## How they chain

- `plan` → `implement`, with the plan directory forwarded as the work source.
- `architecture` → `implement`, the same way.
- `implement` imports the pass `review` runs (`workflows/reviewing.ts`), so the review a
  build gets is the review you would run standalone. It is an import, not a lookup:
  overriding `review` in your layer leaves `implement`'s review as it was, and a fork of
  `implement` imports the pass it wants.
- `plan` → `architecture`, for a plan whose tickets need architectural decisions, started
  with the plan's own goal. It is a Choice a human takes, not a pass every build makes.
- `review` → `implement`, from **Fix findings in a full implement run**. See
  [Hand-offs](using.md#hand-offs-between-runs).
- `general` chains into nothing.
- `self-improve` → `plan` with `then=implement`, once per Improvement, each its own card.

A chained run is a child of the one that started it, its input decoded against the child's
own schema before it is admitted. It has a card of its own, the parent waits for it and
ends with its result, and stopping the parent reaches it.

## `investigate`

**For:** reproducing a problem or gathering evidence on the Machine that can observe it.

**Input:** `goal`. Name the checkout with the host's `workspace` launch option and,
optionally, the branch with `branch`. A remote start can name the repository by URL or
`owner/name`; push the named branch first.

**What happens:** one investigator works in the Run's own checkout and returns
`{ summary, findings: [{ what, evidence }] }`. It changes only what the goal asks,
proves nothing beyond its decoded Output and offers no next steps. The host reports
the result to the agent that started it, then closes the investigator and its Task
workspace unless another Run or a human pane needs it (`closes: "reported"`).

Module: [`workflows/investigate.workflow.ts`](../workflows/investigate.workflow.ts),
with its prompt in [`workflows/investigate.md`](../workflows/investigate.md).

## `self-improve`

**For:** filing, and starting to fix, what a day of Runs shows is wrong with a project:
what its agents kept tripping over, what its checks and instructions missed. Usually run
daily from a Schedule.

**Inputs:** `runs`, which nothing infers: `checkout` reads the Runs of the project it runs
in, and `machine` reads every Run on its Machine and also files Collie's own `defect`s.
`improvements`, a whole number, bounds how many fixes it starts; `0` files without
building.

**What happens:** it works in a worktree of its own, detached at `origin`'s default branch
as just fetched, never in the checkout it was started in, which other Runs share; the
cleanup sweep removes it once the Run has ended. It reads the 24 hours of Runs before it
started. A `retrospective`
agent triages their records with the installed `retro` skill, and each finding that
recurs is filed on the forge of the checkout it runs in, or commented on the open issue it
matches. Up to `improvements` groups of newly filed issues start as `plan` Runs that build
themselves. Nobody is asked anything, and nothing is merged. See
[Self-improve](using.md#self-improve).

**Ends:** once its Improvements have, with `summary.md` in its Run directory.

Module: [`workflows/self-improve.workflow.ts`](../workflows/self-improve.workflow.ts),
with its prompt in [`workflows/self-improve.md`](../workflows/self-improve.md).
