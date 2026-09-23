# Workflows

Collie ships five workflows. This page is the "which one do I want" level: what each is
for, what it needs from you, and how they chain. The files under
[`workflows/`](../workflows) are canonical for step-by-step behavior: each is a TypeScript
module with its Markdown beside it as content ([the SDK](sdk.md)). Any of them is a fork
away from being yours; see [Authoring](authoring.md).

For what a Workflow, an operation, a Choice or a Run _is_, see [`CONTEXT.md`](../CONTEXT.md).

## How inputs reach a run

Every workflow declares the inputs it needs. Collie infers what it can from the branch
name, the working directory, an open merge request and earlier runs in the same repo, then
asks you only for the rest and shows one confirm line. Two inputs offer a menu rather than
a guess, because guessing them wrong is expensive: `implement`'s work source and `review`'s
target.

## `plan`

**For:** turning a goal you can describe into a spec and tickets someone — or something —
can build from.

**Inputs:** `goal` (what you want), supplied at launch or asked for when missing, and `ticket` (a Linear
issue). `ticket` is read from the branch name and left empty when there is none — it is
never asked for. The goal is the only launch question, and
the end menu is asked when the plan is written rather than before it exists.

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
all where there is no GitLab to open one on or the evidence is not there.

**Outcome.** `--input outcome=bug|refactor|investigation|docs|migration|feature` says what
kind of result this run has to prove, and so what evidence closes it — see
[Outcomes](cli.md#outcomes). `plan` settles it during the interview and forwards it, so a
chained build is never asked again. Left empty, a run is held to this project's approved
verifications and nothing more: unclassified work is not a feature by default, and asking
documentation for a feature's evidence would ask for tickets that do not exist.

**Ends:** with the merge request, or with the reason there is none. There is no question
at the end.

Module: [`workflows/implement.workflow.ts`](../workflows/implement.workflow.ts), with its
content in [`workflows/implement.md`](../workflows/implement.md).

## Plans that span repositories

Most plans worth the name touch more than one checkout: a backend contract, its generated
client, a frontend. `plan` writes one plan directory for all of it, and every ticket in it
carries a `**Repo:**` line — the checkout it changes, relative to the plan run's root and
as it is on disk, or `.` when the root is itself a repository.

A plan is single-repository only when its tickets all say `.`, or carry no line at all. A
plan whose tickets all name one repository _by path_ is not one of those: that repository
is somewhere under the root, and its run has to be rooted there.

Every other plan fans out, whether **Implement now** hands it to `implement` or you start
it yourself from the plan's root with `collie run start implement --input plan=<the plan
directory>`. That `implement` cuts no checkout of its own and builds nothing itself: it
starts one Run of itself per repository, each from that repository's checkout under the
root, each with the shared plan directory and its own `repo`, and all on one branch name —
so the sibling merge requests are findable by it. See [Repo run](../CONTEXT.md) for the
term.

They start in **waves**. A repository's run starts once every repository its tickets are
blocked by has been built; repositories that block nothing start together. Ticket order
inside a repository is that run's own business, as in a single-repository run. The
`implement` that fanned out is their parent until the last one ends, so stopping it stops
them, resuming it goes on with the ones it already has rather than starting them again, and
its result names what each repository ended as.

- **A repository that did not build** fails rather than ending with its reason — a ticket
  stopped on a blocking finding, a review that halted, a merge request with no evidence for
  it — so no wave starts on work that is not there.
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
whole change, and the code around it. A synthesis then reconciles what the reviewers wrote
into the one review a human reads — findings deduplicated across models, disagreements
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
  an implementer of this run's own, given the findings and the target, which fixes them
  where the review was pointed. Offered once: a second round of it would be the same
  findings again.
- **Fix findings in a full implement run** — chains `implement` with this run as the work
  source. The build is placed on the branch this review was pointed at — a branch target's
  head, or a merge request's source branch — read from the review's own Run.
- **Post to MR** — sends `review.md` to the merge request it reviewed, verbatim and as a
  single note. Offered only where the target is a merge request and `glab` can reach it.
- **Don't post** — ends the run.

Module: [`workflows/review.workflow.ts`](../workflows/review.workflow.ts), with its prompts
in [`workflows/review.md`](../workflows/review.md).

## `renovate`

**For:** the month's dependency chore on one repository, end to end: every Renovate Bot
merge request merged or accounted for, a version tag whose pipeline published or deployed,
and the repository checked off the team's shared Renovate issue.

**Inputs:** `repository`, an existing local checkout — empty means the workspace the run
was started from, and cloning from a URL is out of scope. `team`, the Linear team whose
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
off. Helle is released when the run finishes successfully.

**It asks you** at the points where asking is the work: a breaking or substantial
migration, an update that cannot be merged safely, a bounded retry that made no progress,
several matching Linear issues, a failing tag pipeline. The Helle claim is held through
every one of them. A run with no open Renovate merge requests reports the repository up to
date, creates no tag, and still leaves the checklist correct.

**Ends:** with the repository checked off, or with what stopped it. There is no menu.

Module: [`workflows/renovate.workflow.ts`](../workflows/renovate.workflow.ts), with its
content in [`workflows/renovate.md`](../workflows/renovate.md).

## `architecture`

**For:** looking at what a project already has and improving the parts whose cost you can
name.

**Inputs:** none. It works on the repo the run is rooted at.

**What happens:** an architect rates every candidate by the deletion test, applies the
strong ones only, and writes a report into the run directory. Everything else is deferred
with a reason rather than half-applied.

**Ends with a menu:** **Implement now** (chains `implement` on the report) or **Stop here**.
**Implement now** names the branch after the `slug` the architect put in its Output, which
is the work you agreed on: `architecture` takes no input that names the work, so without it
every architecture run in a repo would be handed the same branch
([how the branch is chosen](cli.md#start-a-run)).

Module: [`workflows/architecture.workflow.ts`](../workflows/architecture.workflow.ts), with
its prompts in [`workflows/architecture.md`](../workflows/architecture.md).

## How they chain

- `plan` → `implement`, with the plan directory forwarded as the work source.
- `architecture` → `implement`, the same way.
- `implement` imports the pass `review` runs (`workflows/reviewing.ts`), so the review a
  build gets is the review you would run standalone. It is an import, not a lookup:
  overriding `review` in your layer leaves `implement`'s review as it was, and a fork of
  `implement` imports the pass it wants.
- `plan` → `architecture`, for a plan whose tickets need architectural decisions. It is a
  Choice a human takes, not a pass every build makes.
- `review` → `implement`, from **Fix findings in a full implement run**. See
  [Hand-offs](using.md#hand-offs-between-runs).

A chained run is a child of the one that started it, its input decoded against the child's
own schema before it is admitted. It has a card of its own, the parent waits for it and
ends with its result, and stopping the parent reaches it.
