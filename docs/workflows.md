# Workflows

Collie ships eleven workflows. This page is the "which one do I want" level: what each is
for, what it needs from you, and how they chain. The files under
[`workflows/`](../workflows) are canonical for step-by-step behavior: each is a TypeScript
module with its Markdown beside it as content ([the SDK](sdk.md)). Any of them is a fork
away from being yours; see [Authoring](authoring.md).

For what a Workflow, an operation, a Choice or a Run _is_, see [`CONTEXT.md`](../CONTEXT.md).

## Choosing one

A task that is not planning, building a change to a merge request, reviewing, releasing
or staging one, renovating, making a repository faster or an architecture survey is
`general`'s, never `implement` or `plan` stretched to fit. Making a repository faster is
`tune-up`'s, never `implement` asked to: only `tune-up` proves the `performance` outcome.

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
`decided`, and it writes nothing in its checkout: each glossary or ADR change it decides goes
into the ticket that needs it, for that ticket's build to land. The end menu is skipped for
**Implement now** at once. The `implement` it starts is given `then=finish`, so nobody is
asked at its end either. A plan whose tickets cannot be built then fails with why, rather
than asking again.

**What happens:** a planner reads the goal and repository, asks only when a missing
decision changes the work, then writes `SPEC.md` and one ticket per slice into the run's
`plan/` directory. A design artifact the work follows is copied into `plan/design/`, and the
spec and tickets name that copy before its URL, so the build reads the copy. There is no
mandatory interview, summary approval, or manual skill handoff. Plans never enter the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)).

A criterion is one the ticket's absence would make false, never a text search. Before a
criterion names a command, the planner runs it on the default branch's head: one that passes
there is labelled a guard, and one that fails there becomes "the branch adds no failure over
the base", naming the failures already present. The second opinion raises a criterion true
by construction, a guard not labelled as one, and one whose only proof is a text search
([ADR-draft-a-tautology-proves-nothing](adr/draft-a-tautology-proves-nothing.md)).

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

**Its [Flow](../CONTEXT.md)** forecasts **Grill**, **Spec**, **Tickets** and **End menu**,
the menu a run per round. Unbuildable, Second opinion and its Revise, Offload to Linear and
Refine are drawn off the path, each after the Step before it. Started with `then=implement`,
End menu is never asked and ends not run. The implement or architecture Run it starts is a
row of its own.

Module: [`workflows/plan.workflow.ts`](../workflows/plan.workflow.ts), with its prompts in
[`workflows/plan.md`](../workflows/plan.md).

## `implement`

**For:** building a change end to end on a branch, reviewing it, fixing what the review
found, and opening the merge request.

**Inputs:** `plan`, a work source, and `repo` and `then`, optional. It does not need a plan run: inference gathers the three
newest finished `plan` runs for this repo and a Linear issue id in the branch name. One
candidate is taken as the answer; none or several bring up a menu of them plus **Type it…**,
which accepts a Linear id or URL, a path to a plan directory, or a plain description of the
work. What was resolved is recorded with its kind, and the build prompt reads both
`{{inputs.plan}}` and `{{inputs.plan_kind}}` (`plan-dir`, `linear`, `review`, `followup` or
`text`). It carries only that kind's instructions, its `## source.<kind>` section of
[`implement.md`](../workflows/implement.md), and only the outcome's, its
`## outcome.<kind>` section; a Run with no outcome kind is told only its checks have to pass.
`review` is what a run chained from a review carries: the findings are the tickets. For
`linear` and `text` the implementer writes the spec and a task list into the run's `plan/`
before it builds, so every run leaves the same audit trail.

`repo` is one repository's share of a plan that spans several, as the tickets' `Repo:`
line names it: given one, the build step builds only the tickets naming it and leaves the
rest to their own run. It is empty for every single-repository run, which builds the whole
plan, and for the parent of a fan-out, which sets it on each repository's run; see
[Plans that span repositories](#plans-that-span-repositories).

`then` says what follows the merge request: `finish` ends there, `release` releases it, and
empty, the default, asks (see **Ends:**). A start nobody attends passes `finish`: plan's
`then=implement`, and so a Self-improve Run's Improvements, and each Repo run of a fan-out.

**Branch:** named after the work, not the path to it — an explicit `--input branch=`, else
the reviewed branch, else the `<name>` of a `branch:<base>...<name>` target you gave, else
a new `<your GitLab login>/<task>` from `--input task=`, else, given another Run's own
plan directory, the branch that Run's Task is on until its merge request lands, else a new
one from the plan directory's own name, or the work itself. Nobody is asked for one ([the full order](cli.md#start-a-run)).

**What happens:** one implementer agent builds, a commit per ticket. It reviews what it
built with the same pass `review` runs — one complete review — and loops on the findings for
at most four review and fix rounds. Every commit is pushed, so the reviewers read the change
rather than the state before it. Before any reviewer sees a ticket, each of its acceptance
criteria needs an answer, and one left unanswered or not met goes back to the builder. The
criteria are read from the ticket again before each hand-back, so a ticket the planner
amended is judged as it reads now. A ticket goes back twice at most, and the Run then asks
rather than fails: the question names the ticket and the criteria still unmet, so the
ticket can be amended. It asks sooner when a hand-back leaves the tree as it found it and
reports a blocking finding, since another could not move that blocker, and that question
names the blockers too. **Hand back** reads the ticket again, goes on with no builder turn if
nothing is unmet any more, and otherwise hands it back with two tries fresh. **Stop** fails
the Run with that reason, before any review. An unattended Run waits on either question. A ticket's `## After merge` outcomes are not criteria:
the merge request names them under **Not settled by the run**. A criterion only CI, a merge
or a deploy can show may be answered `after merge: <reason>`: it does not end the Run, the
reviewer blocks one the Run could have shown, and the merge request names the ticket, the
criterion and the reason under the same heading
([ADR-draft-a-criterion-is-what-the-run-can-show-before-its-merge-request](adr/draft-a-criterion-is-what-the-run-can-show-before-its-merge-request.md)).
The builder records each new test failing before the code that makes it pass, never offers a
text search as a verification, and does not count as met a criterion only a
[Tautology](../CONTEXT.md) shows.
The merge request is opened or updated last, and not at
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
`.collie/verify.json` as the run's base has it, else the ones remembered for its remote, else
the user's `verify.json`. The base is the ref a checkout for the run is cut from, so a
checkout that is behind, ahead or has uncommitted edits does not decide them
([ADR-draft-a-runs-checks-are-read-where-its-checkout-starts](adr/draft-a-runs-checks-are-read-where-its-checkout-starts.md)). Where none of those names any, the builder names the repository's checks
before it changes anything, from its `package.json` scripts, a Makefile or its CI config,
each with `collie run intent verification`. Nobody approves them, and the merge request
lists each with its command ([ADR-0055](adr/0055-a-run-never-asks-to-run-its-checks.md)).

**Ends:** with the merge request, then a question where `then` is empty. Once the merge
request is open and its checks left to CI are settled, the Run asks **What next?**, named
`next`, naming the merge request, with three answers:

- **Release** starts a [`release`](#release) Run of the merge request as this Run's child,
  in this Run's own checkout and held to its Checks, and waits for it. The Run ends with
  `<merge request URL>; <the release's result>`, and a release that fails fails this Run
  with its reason. While the release waits on the review and the go, which can take days,
  this Run and its implementer stay live and idle.
- **Stage** starts a [`stage`](#stage) Run of the merge request as this Run's child, in
  this Run's checkout, and waits for it. Its result or failure reason is recorded, then
  **What next?** is asked again as `next-2`, `next-3`, and so on, with the same three
  answers. Each Stage child is named `stage-<n>`. A failed Stage child leaves the implement
  Run asking what next, and that question names it and its reason, as in `<merge request>
  is open. stage-1 failed: <reason>. What next?`; **Release** and **Finish** still end it as
  above and below. Where that Stage's checkout was refused, the Run asks whether another
  would still be refused, by the same resolution and cutting nothing, both before it asks
  and when **Stage** is picked. While it would, **Stage** is left out, and the question
  says why: `Stage is not offered: <the refusal>.` **Check Stage again** takes its place
  and asks what next again, with **Stage** back once the refusal is gone. A Stage that
  failed for any other reason is offered again.
- **Finish** ends the Run with the merge request URL.

`then=finish` ends at the merge request and `then=release` starts the release, without
asking. A merge request set to merge itself once green is not asked about: the Run ends at
it. `then` has no `stage` value: an unattended Run never starts a Stage child.
A succeeded Run with a merge request also offers **Release** and **Stage** on its card,
through `collie run action` and in chat, so it can be released or staged later; once its
merge request has merged, or anybody recorded what became of the work, neither is offered.

A Run whose gate passed with nothing to land completes without a merge request: its branch
has no commits over where it leaves the default branch, the same base the gate's baseline
runs at, and nothing uncommitted, as when a ticket is proved met by work already merged. The
merge request step does not run and **What next?** is not asked. The Run ends with, and its
log records, `nothing to land: no commits over <base>, where this branch leaves <default
branch>, and nothing uncommitted`, and its card offers no follow-up. A branch with commits
that cannot be pushed still fails, as below.

It fails with the reason there is no merge request — a ticket stopped
on a blocking finding, acceptance criteria unreadable or still unmet when Stop was answered, a review that halted — and says to
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
and the merge request names each disputed gap with the fixer's reason. A check is not run whole
again on a tree it failed on: after a fix that left HEAD and the fingerprint as they were,
nothing runs and the round is read from the records already on that tree, and a check whose
failures named tests is read from its runs alone and at the base rather than rechecked. A
check re-granted with another command or directory still runs. When the four fixes run out
with a check still failing and no stall, the Run is parked "Outcome unproved after 4 gate
fixes …", naming the gaps; repair the checks and resume it, and a resume from that park runs
each check still failing whole once more, since a repair can be outside the tree. A gate fix lands after the last
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
is not recorded twice. A job missing because the merge request conflicts with its target
branch, by the forge's word, is that conflict and not a missing job: the run parks unproved
saying the merge request conflicts with its target branch and its branch must take the
target. A job missing while the forge has not yet said whether it can merge is waited on as
pending. A merge of the merge request while the run waits stops it, through
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

**Its [Flow](../CONTEXT.md)** forecasts **Build**, a run per ticket, then **Review**, a run
per review-and-fix round, **Checks**, the gate with its fix rounds, **Merge request** and
**What next**. A CI fix round is drawn off the path. A plan that spans repositories forecasts
again once it is read, to **Repo runs** alone, a run per repository. **What next** has a run
per question, and each Stage Run and the release Run it starts is a row of its own. Checks still unproved after the gate's fixes park the Run with **Checks** failed,
and a resume runs them again.

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
root, each with the shared plan directory, `then=finish`, its own `repo` and every other
option it was started with — `risks`, `outcome` — and all on one branch name: the `branch` you gave,
else `<login>/<task>`, else one named after the Run that fanned out, so the sibling merge
requests are findable by it. Each is held to its own repository's `.collie/verify.json` at that
repository's base, else the checks remembered for its remote, else the ones its builder names. See [Repo run](../CONTEXT.md) for the term.

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

The reviewer is shown each recorded check with whether a failing run of the same command was
recorded on an earlier tree, and raises a new test never seen failing. A
[Tautology](../CONTEXT.md) is a `blocker` where it is the only proof of a criterion or a
promised check, and a `minor` otherwise. The synthesis drops a finding that only repeats the
goal or the diff.

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
  ([ADR-0054](adr/0054-a-reviews-fix-works-in-the-reviewed-branchs-checkout.md)). Before
  the first question the review asks whether that branch can be established. A target with
  no branch to fix — another project's merge request, one reviewed from a checkout with no
  remote, `HEAD`, a sha range — is offered neither fix option, and the question says why.
  **Fix findings** stays only where a Run this one came from may have a live implementer
  to hand the findings to. Where the checkout is refused when the fix starts, neither fix
  option is offered again, and the next question says why. Where the branch has an open merge
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

Its Flow forecasts Review and What next, with Synthesis between them when a fork seats
multiple reviewers. Fix findings is drawn off the path; each review and menu round keeps
its own run. Implement starts a separate row in the same Task.

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
checklist unchecked. Where several issues match, it takes the one whose title names the
current month or cycle, else the one with the earliest due date, else the newest, and says
which and why on that issue and as `picked_because` in its Output. It then assesses the whole batch of Renovate merge requests, read only,
and decides whether the repository is a package or an application. Once it has said there is
something to land it blocks — at no token cost — until it holds the repository in
Helle; a repository that is already up to date takes nobody's turn.
For an application it then gathers every update into one batch branch and merge request,
deploys the batch to stage and proves it there — rolling stage back to the latest stable
release, reading the logs `renovate.logs` names, fixing the batch and redeploying, on its
own, when it does not — and waits for another team member's approval before merging the
batch. It asks for that approval once with its harness's question tool, so the question is
on the Run, where a teammate or you answer. A package never reaches those three steps at all, and its merge requests are merged
one at a time under the same claim, fixing conflicts and routine dependency fallout on each
merge request's own branch.
Either way it then chooses a version from the whole diff since the previous tag, tags
annotated with changelog-style notes (and creates a GitLab release only where the repository
is a package), waits until every job of the tag pipeline has finished except manual jobs that
deploy to production, and checks the repository off. Production deploy jobs are yours: the
run never plays, retries or asks about them, and names each, with its URL, as `prod_jobs`
in its release Output.

Holding the claim, the run then waits, at no token cost and with no agent turn, until the
forge shows production carries the default branch's head as it was right after the merge
step, read through the same deployments a card's `in-prod` comes from. Whatever the Output
names, an older deployment, a failed one, a forge that cannot be read and a repository with
no production environment all keep it waiting. With a job left for you to play, the run
parks as Needs you: "Waiting for production: play `<job>` at `<url>`. The claim on `<slug>`
is held until the forge shows production carries `<sha>`." With no job named, nobody has to
act, and the card stays under Working: "Waiting for production to carry `<sha>` of `<url>`,
holding the claim on `<slug>`." While it waits its turn for the claim in Helle's queue, the
card says so too, under Working: "Waiting for its turn for the Helle claim on `<slug>`, at 2
in its queue." A stop or hold ends the
wait with the claim kept, and a restarted host goes back into it. A run holding no claim
does not wait, and its result names the production jobs left to play.

Helle is released once production carries the merge, and also when a batch nobody approved ends it
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
a failing tag pipeline job other than a production deploy. The Helle claim is held through
every one of them. A run with no open Renovate merge requests reports the repository up to
date, creates no tag, and still leaves the checklist correct.

**Ends:** with the repository checked off, or with what stopped it. There is no menu.

Its Flow forecasts Bind the Renovate issue, Assess, Claim, Merge, Tag and watch the
release, Record the result, and Watch production. An application's path also includes
Batch, Stage and Approval before Merge. Merge has one run and one agent turn per Renovate
merge request, on the same conversation. Each turn preserves the approval and held-branch
rules and returns newly discovered requests for turns of their own. The application batch
is merged once; later turns settle each original request against that merged batch.
Recording still precedes the final wait for production, so the shared issue is updated
while the claim remains held.

Module: [`workflows/renovate.workflow.ts`](../workflows/renovate.workflow.ts), with its
content in [`workflows/renovate.gitlab.md`](../workflows/renovate.gitlab.md) for a GitLab
repository and [`workflows/renovate.github.md`](../workflows/renovate.github.md) for a
GitHub one.

## `release`

**For:** one merge request taken the rest of the way, on your go: merged at the head its
review approved and its checks proved, tagged, and the tag read back on origin. A
**package** ends there. An **application** goes to stage, from its merge request before the
merge or from its tag after it, and to production on your go.

**Inputs:** `mr`, the merge request or pull request, picked from the same target menu
`review` offers ([Reviewing someone else's merge request](using.md#reviewing-someone-elses-merge-request)).

**Checkout:** its own, of the merge request's source branch (the pull request's head
branch on GitHub): the one git already has for it, which is the implement Run's worktree
for a release that Run started, or one cut from the branch. Collie only ever fast-forwards it. A checkout with uncommitted
changes, or a head that does not fast-forward it, as after a force push, parks the Run
with why: nothing is reset or discarded.

**What happens:** one agent assesses, read only, whether the repository is a package or an
application, by renovate's own rule, and for an application names the stage deploy jobs of
its merge request pipelines and of its tag pipelines. An application whose pipelines of
neither kind deploy to stage fails here, before any wait, saying it has no stage deploy
Collie can prove. Collie then proves the head with the Run's checks, and
waits, at no token cost, reading the review every five minutes until the merge request is
approved, has no unanswered external comment, is green and mergeable at the proved head.
Changes requested keep it from being ready. While what it waits for comes by itself — CI
still running, a teammate's approval, review threads to be resolved — the Run is working,
not needing you: the card stays under Working and says "Waiting for CI and a teammate's
approval on `<mr>`.", with no notification and nothing in News, until the wait outlasts 2
hours (2 days for a person), when it parks. A red pipeline, changes requested or a merge the
forge refuses (a conflict, a rebase, a draft) parks it as Needs you, naming what holds it
back; it keeps reading the review, and goes on by itself once that is repaired. A head that moves is fast-forwarded to and proved before anything
can be asked about it. A merge request someone else merges, or closes, ends the Run with
nothing tagged.

**Review comments** are answered as they come. An **external** comment is a person's,
by anyone but the forge login Collie works as: a bot's comment, a system note and your
own comments start nothing, so to direct the Run you steer it rather than comment. Each
new external comment, or a reply in a thread after Collie's, starts a comment round,
`answer-<n>`: the agent checks each against the code, fixes what holds test first and
pushes with a plain push, and disputes what it judges wrong, with a reason. Collie then
replies to each comment on the forge, linking it: "Fixed in `<sha>`: …" once the merge
request's head carries that commit, or "Not changed: …" with the reason. Each reply ends
with a line naming the Run and its Machine ("Posted by Collie's Run … on …"), so a reviewer
can tell it from your own words though it is posted as your login. The host records every
reply on the Run, where `collie run show`, the drawer and Desktop's record list it, and a
reply that disputes a comment reaches the board and chat as News; nothing waits for you. It
never resolves a thread, and a restart never posts a reply twice. A comment a round left out,
or whose commit the head does not carry, goes to the next round, and a round that
answers none of its comments parks the Run, naming them. Comment rounds are not bounded:
they follow the reviewers.

**Sharing for approval** is off until you turn on `release.share_for_approval` and name a
Slack channel in `release.approval_channel` ([Your defaults](using.md#your-defaults)); the
Run reads both once, so a restart asks what it asked before. On, before each wait, it reads
the review once, and where the merge request waits on a teammate's approval it asks
**`share-for-approval`** (`share-for-approval-<n>` after the first), naming the merge
request and its head and saying to check it first. **Post for approval** reads the review
again, posts nothing where the merge request no longer waits on an approval, and otherwise
has the agent's `share` step post one message in that channel: the merge request's address,
linked by its title, and nothing else. Collie records the permalink, or why nothing was posted, such as an
agent with no Slack tool; a share that fails never fails the release, and is asked again at
the next head. **Wait for changes** posts nothing and is asked again only once the head
moves; a teammate who approves meanwhile takes the Run on to its go. Turned on with no
channel, the Run says so on its log and asks nothing.

**Checks** run on every head before it can be asked about, the one a round pushed
included, and a check Collie leaves to CI is waited on there. A failure goes to a fix
round, `fix-<n>`, which fixes and pushes as implement's gate fixes do. Four rounds in a
row that leave a check failing, or one that changes nothing, park the Run with why;
resuming it runs the checks again. Collie's own `check` is left to CI's `test` job, so a
Release of Collie is proved by that job at its head, never by a local `bun run check`.

Once ready, it asks **`go-<n>`**, naming the head and who approved it: **Release** or
**Finish** for a package. For an application it offers **Stage the merge request** where
the assessment named a stage deploy of its merge request pipelines, **Merge, tag and stage**
where it named one of its tag pipelines, and **Finish**, and says what each does. Anyone
may answer, from any door, and the answer is recorded with who gave it. **Finish** ends the
Run with the merge request left open. Any other answer claims, in Helle, every project the
release deploys under, one at a time in a fixed order and each waited for — before it waits
for one it does not hold, whether it lost it, or is resumed or tried again, it gives back
the later ones it holds or is queued for, and takes them again in order — asking first to
take over any that were already the operator's — so two releases never each hold what the
other waits for: the repository's own Helle project alone, where Helle has one by its name
in whatever group Helle files it; otherwise each project of the repository's group that an
application the assessment named, or a deploy job's name (`stage:spilnu`), names, by the
project's slug or one of its Helle shorthands, ignoring case — a monorepo, which is no
project of its own, needs several. A name two projects answer to is not guessed
between: it is unsettled, naming both. A repository's `.collie/helle.json`,
`{"projects": [...]}`, names them instead, by slug or shorthand, and `[]` declares none.
Where they cannot be settled — an application with no project, nothing found, Helle
refusing — nothing is merged or tagged: it asks **`go-<n>.claim.unclaimed`**, saying why,
with **Try again**, **Release without a Helle claim**, recorded on its log as the human's
say, and **Finish**. Either of the last two first gives back what it did take; a claim
Helle will not take back parks the Run, naming it, until a resume gives it back. A Run gives
back only what is still in its record, and a project you claim through Desktop's
`collie_helle` leaves every Run's record
([the Flock chat](using.md#the-flock-chat)); one claimed in Slack does not. Holding
them, it reads the review again, as
the claims may have waited. A pipeline still running at the go's head is waited out, as the
wait before the go waits, and a Hold or Stop ends that wait. The go no longer holds where the
head moved, a comment is unanswered, the pipeline failed, changes are requested, the forge
refuses the merge, or the merge request was merged or closed: the claim is given back, and
the Run says why on its log and waits for a fresh go. Where it holds, Collie merges at exactly the head the go named — never an admin
merge, never auto-merge. A head that moved before the merge gives the claim back and goes
back to waiting. The agent then tags by the repository's own conventions, and Collie reads
the tag back on origin, carrying the merged commit, with its pipeline finished and
succeeded by the forge's word: the pipeline the agent named, or the newest the forge shows
the tag started, and only one the forge shows ran for that tag and its commit in this
repository. A job waiting to be started by hand has not finished.
A merge request set to merge itself once green is refused at the start: it is already on
its way.

**An application** is tagged without a release on the forge, and the agent plays and
watches the tag pipeline's stage deploy and the repository's own stage checks
(`e2e-stage`, smoke or the like), until the only jobs left are production jobs waiting
for somebody to start them: a manual job on GitLab, which blocks the pipeline, or a job
waiting on its environment's approval on GitHub. Collie then reads from the forge that
the tag carries the merged commit, that stage's newest successful deployment carries it
(this tag path still reads stage's newest deployment across the project, not each
environment),
that each named stage job passed, that every other job passed and none is still running or
waiting to run, and that at least
one production job waits to be started by hand. The pipeline's own state is not read: it
cannot succeed before production runs. Where a stage job failed, or stage does not carry
the merge, the agent rolls stage back to the newest release production carries; once the
forge shows stage there, the claim is given back and the Run fails saying stage failed
after the merge, nothing went to production, and the merge stands, so the fix is a new
merge request. A rollback the forge cannot show, or any other failed proof, fails the Run
and keeps the claim.

**Staging the merge request** tests it before anything is merged. The Run claims the
repository and its `stage` step deploys the merge request's own pipeline at the go's head
to stage, then runs the repository's stage checks there. Collie reads each stage job back
on the merge request's head pipeline: every one passed and the head is still the go's. It
then reads stage one environment at a time, as a monorepo deploys one stage environment per
application: at least one staging environment has a deployment of the commit that pipeline
ran on (its merge commit, for a merged-results pipeline), and the newest successful
deployment of every such environment carries the head. A stage environment the pipeline
never deployed to is not read. Where any of that does not hold, the failure names each
environment that does not carry the head, and the `unstage` step rolls stage back to the
newest release production carries; the rollback is read in exactly the environments the
head reached, each of which must no longer carry the head and must carry production's
newest. Once the forge shows that, the claim is given back, the failure is the finding of a fix round,
and the Run goes back to the wait, so go 1 is asked again on the fixed head. A head that
moved instead goes back to the wait with no fix round.

Then, with the claim held while you test, it asks **`production`**: **Send to production**,
**Leave production to me** or **Finish**, naming the merge request, its head and the stage
jobs at their addresses. Nothing is merged yet, so **Send to production** and **Leave
production to me** read again that go 1 still holds at that head, waiting out a pipeline
still running there as go 1's own reading does, and that stage still carries it. Where
either does not, nothing is merged, stage is rolled back and the claim
given back, and the Run says why and goes back to the wait: a comment that arrived while
you tested is answered in its round there. Where both hold, Collie merges at that head, the
agent tags (where the tag's pipeline deploys stage too, it plays and checks those jobs as
**Merge, tag and stage** does) and Collie proves the tag ready for production. **Send to
production** then plays production with no further question, and **Leave production to
me** plays nothing; either waits until the forge shows production carries the merge.
**Finish** merges nothing, rolls stage back and ends with the merge request left open.
Every rollback after staging the merge request is read in the stage environments the head
reached; one that leaves any of them on the head, or off production's newest, fails
the Run naming that environment and keeps the claim, so **Release again** takes it over.

Choose **Stage the merge request** where you want to test the change on stage before it is
on the default branch; choose **Merge, tag and stage** where reviewing it was enough and
stage only has to check the release.

After **Merge, tag and stage**, it asks **`production`**: **Send to production** or **Leave production to me**,
naming the tag, saying stage carries it, and naming each production job with its address.
You verify stage before you answer. It holds for that tag and those jobs: the head go 1
was given for is merged, so it never goes back to the review wait. **Send to production**
reads the tag and its jobs again first: nothing is played where production already
carries the merge or somebody already started the job, and nothing at all where the tag
moved or a job is gone or failed, which fails the Run with the claim kept. The jobs still
waiting go to the agent's `production` step, cleared for exactly those. Either answer then
waits, at no token cost, until the forge shows production carries the merge, whoever
played it; the card names the production jobs meanwhile, and a Hold or Stop suspends it.
After **Send to production** the jobs are playing and the wait is under Working; after
**Leave production to me** they are yours to play, and the Run is in Needs you until
production carries the merge.

**Ends:** with `<mr> merged at <sha>, released as <tag>` and the claim given back, for an
application `… released as <tag>, in production`, with `<mr> was left open, and stage rolled
back` after staging the merge request, or with what stopped it. A rollback the forge cannot
show fails the Run and keeps the claim. A failed Run offers **Release again**: before the merge it is a fresh
release; after it, the new Run takes over the failed Run's landing — never a merge someone
made outside a Release Run — and only tags, asking to adopt the claim the failed Run kept. For an application it
finishes the tag that already carries the merge, stage included, and asks `production`
afresh; where production already carries the merge it asks nothing and ends. A Run whose
checkout was refused offers **Release again** only where another would get past its
checkout, as [Stage again](#stage) does.

**Its [Flow](../CONTEXT.md)** forecasts **Checkout**, **Assess**, **Prove the head**, **Review wait**,
**Merge go**, **Helle claim** and **Merge**, then for an application **Stage**, **Production
go** and **Production**. A checkout Collie cannot give fails the Run on **Checkout**, with
why. Once the assessment finds a package, the path ends at **Tag** instead. A comment round, staging the merge request and, with sharing on, **Share for
approval** and **Share** are drawn off the path, and the fix
rounds belong to the Step that proved the head they fix. Proved checks that still fail park
the Run with that Step failed, and a resume runs them again.

Module: [`workflows/release.workflow.ts`](../workflows/release.workflow.ts), with its
content in [`workflows/release.gitlab.md`](../workflows/release.gitlab.md) and
[`workflows/release.github.md`](../workflows/release.github.md). Why it is shaped this way:
[ADR-draft-a-merge-request-is-released-on-a-humans-go](adr/draft-a-merge-request-is-released-on-a-humans-go.md),
and for sharing it:
[ADR-draft-a-release-shares-its-merge-request-on-a-humans-say](adr/draft-a-release-shares-its-merge-request-on-a-humans-say.md).

## `stage`

**For:** one open merge request's head put on stage for you to test, unmerged, and nothing
more. It asks for no approval, answered or resolved comments, passed pipeline,
mergeability or go, and runs none of the Run's checks: it changes nothing, and what it
deploys is what the forge's own pipeline built. It never merges, tags, pushes, posts or
plays a production job. A merge request you want released after testing is `release`'s
**Stage the merge request**; one you only want to test is this.

**Inputs:** `mr`, the merge request or pull request, as `release` takes it. A Stage Run on a
merge request joins that merge request's Task.

**Checkout:** the merge request's source branch, as `release`'s, only ever fast-forwarded. A
refusal parks the Run with why.

**What happens:** it reads the merge request once: a merged one fails, saying its stage is
its release's, and a closed one fails. One agent assesses, read only and by release's own
rule, whether the repository is a package or an application, and names the stage deploy
jobs of its merge request pipelines: a package fails, and so does an application with
none. Collie fast-forwards the checkout to the head, and reads in Helle who holds each
project the stage deploys under, found as a Release Run finds them, by slug or Helle
shorthand, joining no queue. Each application needs the repository's own project where it
has one, and otherwise its own; with a `.collie/helle.json`, every application needs every
project it declares. Where every
project is free or already the operator's, it claims them all, as a Release Run does: in
Helle's order, asking first to take over any already the operator's. Where someone else holds
or queues for some of them, it asks **`claims-1`**, naming each such project and who has it:

- **Wait for all** queues for every project in Helle's order, at no token cost, and stages
  everything once all are handed over.
- **Stage what is free** takes only the free projects, waiting for none, and stages only the
  applications whose projects it holds: only their stage jobs are played, read back and
  rolled back. An application it left is never played, retried or rolled back, so a
  teammate's stage of it stays as it was. A project someone takes between the read and the
  take is given back and left off too. It is offered only where it would stage something: a
  stage job that names no application belongs to every one, and a declared set is all or
  nothing.
- **Finish** ends the Run, claiming and staging nothing.

Where the claims cannot be settled it asks **`claim.unclaimed`** with **Try again**, **Stage
without a Helle claim**, recorded on its log as the human's say, and **Finish**, which
stages nothing.

Holding them, it reads the head again and fast-forwards to it, as the claims may have
waited, and the agent's `stage` step plays, retries and watches those jobs of the merge
request's pipeline, and the stage checks after them. Collie reads stage back from the
forge, one environment at a time, as `release` does: each stage job passed on the head's
pipeline, and every stage environment those jobs deployed to carries the head. Other jobs'
deployments of the same commit are left untouched. Where the head moved first, that head
is staged in its turn, keeping the earlier head's environments in the rollback proof.
On GitLab, a deployment at a different commit counts for an earlier head only when its
job's pipeline ran at that deployment's commit on this merge request's merged-results
ref and the head is a parent of that commit. An ordinary descendant does not count.
Then it asks **`staged-<n>`**, in Needs you, naming
the merge request, the head, each stage job at its address, each application left off with
who holds its projects, and the claims it holds:

- **Done** rolls stage back, proves it off in each environment the head reached, and gives
  the claims back.
- **Stage again** stages the merge request's head as it is then, keeping the claims, and
  asks again. Under **Stage what is free** it also takes, free-only, any left-off project
  that is free by then, and stages that application too.
- **Leave it on stage** gives the claims back and leaves stage as it is.

If refreshing claims for **Stage again** fails, the existing claims stay held. **Finish**
rolls stage back before giving them back; continuing without the refresh stages only the
applications the Run already holds.

If Helle refuses a give-back, the Run parks with the names of the claims still held.
Resuming retries the give-back before the Run can end.

**Ends:** with `<mr> was staged at <head> for testing; stage is rolled back`, or `stage
carries <mr> at <head>, unmerged`. A stage that fails is rolled back and proved off, its
claims are given back, and the Run fails with `stage of <mr> at <head> failed: <why>; stage
is back on what production carries`. A rollback the forge cannot show fails the Run and
keeps the claims, including where the environments a stage attempt reached could not be
discovered. A failed Run offers **Stage again** of the same merge request. Where its
checkout was refused, the card asks the checkout's resolution again, cutting nothing, each
time it lists the offer and when it is picked. While another attempt would be refused,
**Stage again** is listed as unavailable with the refusal, naming each path's occupant, and
once one is freed it is offered again. Every follow-up that starts a Run's own workflow
again is decided this way after a refused reviewed checkout, so Release's
**Release again** is too.

**Its [Flow](../CONTEXT.md)** forecasts **Checkout**, **Assess**, **Helle claim**, **Stage**,
**Test on stage** and **Roll stage back**. A Stage that `implement`'s **What next?** started
works in that Run's checkout while implement is blocked on it alone, and the checkout is clean, at the merge request's
head as the remote has it now and has no working agent. Otherwise it gets one of its own, and its log says which and why.
Release never takes implement's checkout: it commits and pushes to the merge request's branch, which that checkout is not on. A checkout Collie cannot give fails the Run on
**Checkout**, with why. Stage and Test on stage have a run per staging, a moved head
adding one to Stage alone. Leave it on stage ends with Roll stage back not run.

Module: [`workflows/stage.workflow.ts`](../workflows/stage.workflow.ts), with its content in
[`workflows/stage.gitlab.md`](../workflows/stage.gitlab.md) and
[`workflows/stage.github.md`](../workflows/stage.github.md); the claims and the staging are
[`workflows/staging.ts`](../workflows/staging.ts), shared with `release`. Why:
[ADR-draft-an-open-merge-request-is-staged-by-a-run-of-its-own](adr/draft-an-open-merge-request-is-staged-by-a-run-of-its-own.md).

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

Its Flow forecasts Architecture, which produces the plan, and What next. Implement now
starts a separate row in the same Task.

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
card says, as `Completed. It reported: “…”` — its status, then its claim, shown as one. A `blocked` reason fails the run with that reason. There
is no menu, and the agent takes steering after the run has ended.

Its Flow forecasts one Step, Task, containing the generalist's work.

Module: [`workflows/general.workflow.ts`](../workflows/general.workflow.ts), with its
prompt in [`workflows/general.md`](../workflows/general.md).

## What a shipped step is cleared for

A step that pushes, merges, tags or plays a job says so in its agent's own turn, as its
Clearance ([`docs/sdk.md`](sdk.md#having-an-agent-do-the-work)), in the forge's own noun.
Each names only what that step's content tells the agent to do:

- **`implement`'s `mr`**: pushing the checkout's branch to origin (its web address) and
  opening or updating its merge request there. Not merging: it merges only when a message
  of its own asks it to.
- **`review`'s fix step**: pushing new commits to the reviewed branch on origin with a
  plain push.
- **`renovate`'s `stage`**: playing, retrying and watching the stage deploy, e2e-stage and
  smoke jobs of the repository's pipelines, and rolling stage back to the newest tag whose
  production deploy succeeded — never a production job.
- **`renovate`'s `merge`**: approving the reviewed head of, and merging, Renovate's own merge
  requests; merging the Run's batch merge request once a teammate has approved it; using
  the forge's own commands as the content names them.
- **`renovate`'s `release`**: pushing an annotated version tag of the default branch,
  creating its release where the repository is a package, and watching the tag's
  pipeline — never playing a production deploy job.
- **`release`'s `answer`** and **`fix`**: committing to the merge request's source branch
  and pushing it with a plain push, never a force push. `answer` is told too that it
  never posts on the forge or resolves a thread: Collie replies.
- **`release`'s `tag`**: a release commit to the repository's default branch where it makes
  one, pushing an annotated version tag, creating its release where the package publishes
  from its tags, and watching the tag's pipeline — never playing a production job. The
  merge is Collie's, on the human's go, and clears nothing. For an application it is
  cleared instead for the release commit, pushing the annotated tag with no release on the
  forge, playing, retrying and watching the stage deploy and stage check jobs of the tag's
  pipeline, rolling stage back to the newest release production carries, and watching the
  pipeline until only production jobs waiting to be started are left — never a production
  job. After the merge request was staged, and where the tag's pipeline deploys no stage,
  it is cleared for the release commit, pushing the annotated tag with no release on the
  forge, and watching the tag's pipeline — never a production job.
- **`release`'s `stage`**: playing, retrying and watching the stage deploy job and stage
  check jobs (e2e-stage, smoke or the like) of the merge request's pipeline, and rolling
  stage back to the newest release production carries — never a production job.
- **`release`'s `rollback`** and **`unstage`**: rolling stage back to the newest release
  production carries, never a production job.
- **`release`'s `production`**: playing exactly the production jobs the go named, at their
  addresses, and no other job.
- **`release`'s `share`**: posting one Slack message in the approval channel, the merge
  request linked by its title, and nothing else.
- **`stage`'s `stage`**: playing, retrying and watching the stage deploy jobs the assessment
  named, by name, and the stage check jobs that follow them in the merge request's pipeline,
  and rolling back only the stage environments those jobs deploy to — never a production
  job.
- **`stage`'s `unstage`**: rolling back only the stage environments those jobs deployed to,
  to the newest release production carries, never a production job.

Every other shipped step clears nothing.

## How they chain

- `plan` → `implement`, with the plan directory forwarded as the work source, and
  `then=finish` where the plan was started with `then=implement`.
- `architecture` → `implement`, the same way.
- `implement` imports the pass `review` runs (`workflows/reviewing.ts`), so the review a
  build gets is the review you would run standalone. It is an import, not a lookup:
  overriding `review` in your layer leaves `implement`'s review as it was, and a fork of
  `implement` imports the pass it wants.
- `implement` imports its delivery the same way (`workflows/delivering.ts`): the gate and
  its fixes, the merge request, and CI's proof of the checks left to it, with CI's fixes.
  It takes the outcome kind, the prompts and the merge request's Output from the workflow
  that calls it, and a step to run after a gate or CI fix moves the tree; `implement`
  passes none.
- `plan` → `architecture`, for a plan whose tickets need architectural decisions, started
  with the plan's own goal. It is a Choice a human takes, not a pass every build makes.
- `review` → `implement`, from **Fix findings in a full implement run**. See
  [Hand-offs](using.md#hand-offs-between-runs).
- `general` chains into nothing.
- `release` chains into nothing; a failed one offers **Release again** of the same merge
  request.
- `stage` chains into nothing; a failed one offers **Stage again** of the same merge request.
- `self-improve` → `plan` with `then=implement`, once per Improvement, each its own card.
- `implement` → `release`, on its merge request, from **Release** at its end, `then=release`,
  or the **Release** offer on a succeeded Run's card.
- `implement` → `stage`, on its merge request, from **Stage** at its end or the **Stage**
  offer on a succeeded Run's card. A Stage child returns to **What next?** however it ended.

A chained run is a child of the one that started it, its input decoded against the child's
own schema before it is admitted. It has a card of its own, the parent waits for it, and
stopping the parent reaches it. The parent's Workflow decides whether to end with the
child's result or ask what next again.

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

Its Flow forecasts one Step, Investigate, which produces evidence.

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
matches. Each finding cites a record that shows it, a journal line, a verification, a
transcript or an issue, and never a Run's goal, summary or Output read back. Up to
`improvements` groups of newly filed issues start as `plan` Runs that build
themselves. Nobody is asked anything, and nothing is merged. See
[Self-improve](using.md#self-improve).

**Ends:** once its Improvements have, with `summary.md` in its Run directory.

Its Flow forecasts Retrospective window, Retro, Triage, Filing and Improvements. The
window is read from the requested scope without a question. Improvements has one run per
named improvement, each starting a plan in its own Task.

Module: [`workflows/self-improve.workflow.ts`](../workflows/self-improve.workflow.ts),
with its prompt in [`workflows/self-improve.md`](../workflows/self-improve.md).

## `tune-up`

**For:** making a repository measurably faster without giving up behaviour, proved by the
host's Measurements and never by an agent's own timings
([ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement](adr/draft-a-performance-gain-is-proved-by-the-hosts-measurement.md)).
It proves the fixed `performance` outcome, which no other workflow can be asked for.

**Inputs**, each optional:

| Input        | Default                       | What it is                                                                               |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `repository` | the checkout it is started in | The checkout to tune. See below.                                                         |
| `focus`      | empty, the whole              | A journey, endpoint or page to spend the Cycles on.                                      |
| `cycles`     | `5`                           | How many Cycles at most, a whole number from 1 to 20. A reverted Cycle counts.           |
| `threshold`  | `5`                           | The smallest gain, in percent, that counts.                                              |
| `tolerance`  | `2`                           | How far, in percent, a guardrail may worsen and still hold.                              |
| `samples`    | `10`                          | Samples per side of each Measurement, at least 2.                                        |
| `wall_time`  | none                          | A duration, such as `2 hours`, after which no new Cycle starts.                          |
| `external`   | `ask`                         | `ask` puts each external finding to you, `report` only writes them, `off` collects none. |

A `cycles` of 0, 21 or 2.5, or a `wall_time` that is not a duration, is refused at the
start, before any Run exists. The Run works on
a branch of its own, in a worktree of the checkout it is started in, and never clones. From
Home, a repository URL or path places it in the local checkout it names. From the CLI or
another Run's agent, start it in the checkout you want tuned: a `repository` naming any
other checkout, or a URL, is refused at the start.

**What happens:**

1. **Discover.** A `tuner` agent reads the stack, loads the installed skills that fit it,
   and writes down the journeys that matter with their objectives. It records each
   telemetry source it tried as used, with release, window, sample and a sanitised link, or
   unavailable, with why. It records the documentation and prior work it read, each with
   the opportunity it raised, lowered or ruled out, or what it searched where it found
   nothing. It ranks the opportunities, each marked measured, telemetry or hypothesis and
   citing what it rests on. An Output with no research, or an opportunity citing nothing,
   is refused and repaired. Each telemetry source and research link is written to the
   Run's log.
2. **Harness.** The tuner commits a benchmark harness on commits of its own, touching only
   the harness paths it declares, and writes the benchmark plan: journeys, cases, commands,
   prepare, metrics with direction and role, warmup, and for a metric this Machine may be
   too noisy to prove, a low-variance counter of the same work. The Run's `samples`,
   `threshold` and `tolerance` complete it. The plan is recorded before anything is
   measured by it, and a later change is a new plan with its reason.
3. **Calibrate.** The host measures the base, the merge base with the harness commits on
   it, against the Run's own checkout, which holds nothing else yet. A primary metric that
   comes back `inconclusive` there, or a guardrail that is not held, cannot be proved on
   this Machine. Where the plan declared a counter for it, the Run switches to the counter,
   records the switch as a new plan and calibrates again; otherwise it ends.
4. **Cycles**, at most `cycles` of them. In each, the tuner is given the ranked
   opportunities and every earlier Cycle's result, and commits one change on the Run's
   branch. Collie runs the Run's checks, all but those left to CI, and measures the
   checkout against the tree the Cycle started on. The Cycle is kept only where those checks pass,
   the primary metric shows a `gain` and every guardrail holds. Otherwise the tuner takes
   back only that Cycle's commits, with `git reset --keep` to its starting commit, and does
   nothing where a commit landed after the Cycle or uncommitted work would be lost. Collie
   then checks that the head and files are that tree again before anything else; a revert
   that leaves another tree fails the Run, naming both, rather than lose anyone's work. The findings are rewritten after each Cycle. A reverted Cycle, or one that
   changed nothing, still counts, and a restarted host resumes in the Cycle it was in.

   The Cycles stop early, with the reason in the Run's log and its findings, when the tuner
   says no measured opportunity is left or names an unsafe tradeoff, when two Cycles in a
   row are not kept, or when `wall_time` is spent. `wall_time` counts from the Run's start
   and is read before each Cycle: it never interrupts one, and never cuts short Discover,
   Harness or Calibrate, or anything after the Cycles. Spent by the end of Calibrate, it
   means no Cycle runs.

5. **Integrate.** With a Cycle kept, Collie merges the default branch where it has moved,
   and the tuner settles a conflict. The host makes the base tree again at the merge base
   the merge request will target, and takes a `final` Measurement of the branch against it.
   Where the default branch moved, the branch is also measured against the base the Run
   started from, for the merge request.
6. **Review.** The shared review, with a Tune-up prompt, judges `behavior_preserved`
   (behaviour, APIs, accessibility, reliability, security, data integrity, no weakened test
   or disabled validation) and `measurement_valid` (realistic fixtures, no hidden caching
   tradeoff, the harness apart from the product, no secret or personal data in what is
   published). The tuner fixes what blocks in the same bounded rally as `implement`'s, and
   each review round starts with a new `final` Measurement of the tree it reads.
7. **Checks** and **Merge request**, through the delivery `implement` uses: Collie runs the
   Run's checks on the tree, the tuner fixes what they lack, opens the merge request and
   fixes what a check left to CI fails on its head. A gate or CI fix that moves the tree is
   measured and reviewed again before the outcome is read. The merge request's description
   is `handoffs/tune-up-merge-request.md`, which Collie writes from the Measurements, with
   credential-shaped values taken out: the base and candidate table with each metric's
   ratio and interval, the commands and harness commits, the guardrails and Cycles not
   kept, the checks and the review, the opportunities left, what to monitor after
   deploying, and, collapsed, every sample of the `final` Measurement, the frozen plan,
   every plan and `final` Measurement, the commands to reproduce it and the Run id.
8. **External report**, at whichever end the Run reaches, after the merge request or with
   its findings alone. Discover and each Cycle hand on what only another repository could
   change, and Collie writes each to `handoffs/tune-up-external.md`: the owning repository
   and team where known, evidence links, the journey, the change it needs, its estimated
   impact apart from anything measured, acceptance criteria and how it relates to the local
   change. Each is keyed by a digest of its repository and change, the same in any Run.
   With `external` at `ask`, each finding is put to you one at a time, with `Ignore` and
   `Post` only, its question showing the finding. A finding with no known team asks for the
   team in your own words first. Post has the tuner search Linear, read-only, for the issue
   carrying the key's marker and for open issues asking for the same change, and file one
   issue carrying the marker only where it found none. A finding that already matched an
   issue when it was found is recorded as `existing` and not asked. Your answer and the
   issue's URL go in the Run's log. A host restarted while an issue was being filed never
   files blind: it searches again, records the issue it finds, and otherwise asks again,
   saying an earlier Post may have filed it. With no Linear MCP server in Claude Code, the
   report is written, nothing is asked, and the log says why. `report` writes the report
   and asks nothing, and `off` writes none. None of it counts toward a Measurement, the
   outcome or the merge request's readiness.

**Ends:** with `handoffs/tune-up-findings.md` in its Run directory, and with a merge request
only where `performance` is proved: a `final` Measurement of the delivered head against the
merge base showing a `gain` with every guardrail held, the checks passing, and a review of
that same tree reporting both `behavior_preserved` and `measurement_valid`. Where
calibration rules out proof, no Cycle was kept, or the `final` Measurement shows no gain or
a guardrail not held, there is no merge request and the Run is not failed. Its result names
that file and why it ended: `proof unavailable`, naming each metric, why the Cycles stopped,
or the `final` Measurement's verdict. The Run is then back on its base tree: with no kept
Cycle the branch already is, and a change that lost its gain is dropped back to the base
tree at the latest merge base, in a commit that changes only the files it needs, keeps
uncommitted work, and takes back nothing once a commit not the Run's own is on the branch,
which Collie checks from the trees, failing the Run naming both where the drop did not land. A fix after the merge
request is open that loses the gain or a reviewer's verdict fails the Run, saying the merge
request is not ready and why, on the merge request too. A forge that refuses the merge
request fails the Run with the forge's reason. A harness commit touching a path outside its
harness paths, a base that cannot be built, or a calibration that ends without a verdict
fails the Run, naming the paths or the tree.

**Never:** load against production, which it only reads, bounded; auto-merge; a deploy; a
change to another repository; or an issue filed without your Post.

Its Flow forecasts Discover, Harness, Calibrate, Cycles, Integrate, Review, Checks, Merge
request and External report.

Module: [`workflows/tune-up.workflow.ts`](../workflows/tune-up.workflow.ts), with its
prompts in [`workflows/tune-up.md`](../workflows/tune-up.md) and its agent's Persona in
[`personas/tuner.md`](../personas/tuner.md).
