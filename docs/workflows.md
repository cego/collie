# Workflows

Collie ships four workflows. This page is the "which one do I want" level: what each is
for, what it needs from you, and how they chain. The definition files under
[`workflows/`](../workflows) are canonical for step-by-step behavior, and
`collie workflow show <name>` prints the resolved version — inputs and steps included,
including those inherited from an embedded workflow. Any of them is a fork away from being
yours; see [Authoring](authoring.md).

For what a Workflow, Step, Choice or Run _is_, see [`CONTEXT.md`](../CONTEXT.md).

## How inputs reach a run

Every workflow declares the inputs it needs. Collie infers what it can from the branch
name, the working directory, an open merge request and earlier runs in the same repo, then
asks you only for the rest and shows one confirm line. Two inputs offer a menu rather than
a guess, because guessing them wrong is expensive: `implement`'s work source and `review`'s
target.

## `plan`

**For:** turning a goal you can describe into a spec and tickets someone — or something —
can build from.

**Inputs:** `goal` (what you want), which you are always asked for, and `ticket` (a Linear
issue). `ticket` is read from the branch name and left empty when there is none — it is
never asked for. The goal is the only launch question: the grilling starts at once, and
the end menu is asked when the plan is written rather than before it exists.

**What happens:** a planner interviews you one question at a time, then writes `SPEC.md`
and one ticket per slice into the run's `plan/` directory. Plans never enter the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)).

**Ends with a menu:** and you can answer it in conversation. Telling the planner
"proceed", "implement", "build" or "go" makes it answer the menu with
`collie run answer <run id> "Implement now"` — it starts nothing itself.

- **Implement now** — chains `implement` with this run's `plan/` as the work source.
- **Second opinion** — one reviewer round over the plan, then the menu again; where it
  reports findings, the planner gets a follow-up round to revise.
- **Offload to Linear** — the planner files the tickets as Linear issues. It asks once
  which team they go to and remembers the answer in `config.json`.
- **Refine** — another planner round, as often as you like.

Definition: [`workflows/plan.md`](../workflows/plan.md).

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
plan, and is set by the fan-out below rather than by hand.

**Branch:** named after the work, not the path to it — an explicit `--input branch=`, else
the reviewed branch, else the `<name>` of a `branch:<base>...<name>` target you gave, else
a new `<your GitLab login>/<task>` from `--input task=`, the plan directory's own name, or
the work itself. Nobody is asked for one ([the full order](cli.md#start-a-run)).

**What happens:** one implementer agent builds (a commit per ticket), then improves the
architecture it touched, then simplifies. It embeds `review` — two models in parallel, one
synthesized review — and loops on the findings up to `max_iterations` (5 by default). Every
step that commits pushes what it committed, so the reviewers read the change rather than
the state before it. The last step opens or updates the merge request, and is skipped where
there is no GitLab to open one on.

**Ends:** with the merge request, or with the reason the `mr` step was skipped. There is no
menu.

Definition: [`workflows/implement.md`](../workflows/implement.md).

## Plans that span repositories

Most plans worth the name touch more than one checkout: a backend contract, its generated
client, a frontend. `plan` writes one plan directory for all of it, and every ticket in it
carries a `**Repo:**` line — the checkout it changes, relative to the plan run's root and
as it is on disk, or `.` when the root is itself a repository.

A plan is single-repository only when its tickets all say `.`, or carry no line at all: the
run is then rooted where the plan run is and behaves exactly as it always did. A plan whose
tickets all name one repository _by path_ is not one of those — it is a fan-out of one
wave, because that repository is somewhere under the root and its run has to be rooted
there.

Where they name several, **Implement now** fans out: one `implement` run per repository,
each rooted at that repository's checkout under the plan's root, each with the shared plan
directory and its own `repo`, and all of them on one branch name — so the sibling merge
requests are findable by it. See [Repo run](../CONTEXT.md) for the term.

The runs start in **waves**. A repository's run starts once every repository its tickets
are blocked by has succeeded; repositories that block nothing start together. Ticket order
inside a repository is that run's own business, exactly as in a single-repository run. One
rule holds over the whole plan and the planner is told it: taken repository by repository
the blocking edges must not form a cycle — once a repository's tickets are blocked by
another's, none of that other one's may be blocked by this one.

The plan run stays alive as their parent until the last one ends, so one row says whether
the whole plan is built, and its summary lists each repository's merge request. On the
Control Plane the children [nest under it](using.md#the-control-plane).

- **A child that fails or is stopped** starts no further wave. The children already
  running are left to finish, the parent ends `blocked` naming the repository that stopped
  it, and the repositories that never started are recorded as `not run: waiting on <repo>`.
- **Stopping the parent** stops its running children first: "stop this" on a plan run
  means the whole plan. A repository run that will not stop — a Driver Collie cannot
  identify well enough to signal — leaves the parent running and is named in the failure,
  because a parent reported as stopped while one of its runs is still building is worse
  than a stop you have to repeat.
- **Resuming the parent** re-derives the waves from its children: the repositories that
  succeeded are skipped, the ones that failed or were stopped are resumed as themselves,
  and the rest start when their blockers are done. So a second attempt opens no second
  merge requests.
- **A plan the fan-out cannot run** is refused when you pick **Implement now**, and the
  message names what is wrong: a repository-level cycle and the tickets that interleave, a
  ticket with no `Repo:` line where its siblings have one, a repository with no checkout
  under the root — Collie does not clone — a `Repo:` that is not a path under the root at
  all, two tickets wearing one number, or a "Blocked by" line naming something that is not
  a ticket of this plan. Numbers have to be unique because a "Blocked by" line names one:
  two tickets called `01` are two answers to which ticket an edge points at. The
  `Repo:` rule is why the line cannot be absolute or contain `..`: it becomes the
  directory a run is rooted at and a branch is cut in, and a plan is prose an agent wrote.
  The "Blocked by" rule is because the waves are built from those lines — an edge nobody
  can resolve would start a frontend run beside the backend run it depends on. A ticket
  number is a word that is nothing but digits: unpadded ones are fine (`2` finds `02-…`),
  and so is a number followed by prose about it — the digits inside a word like `v2` are
  part of that word, not an edge. Nothing starts, and the menu comes back. The planner is still live, so ask it to fix the
  tickets and pick again.

## `review`

**For:** getting one reconciled review of a change you did not necessarily write.

**Inputs:** `target` — a merge request (anyone's, from any directory), a branch diff, or
the working tree, chosen from a menu. `plan` and `previous` are optional: a spec to hold
the change to, and an earlier review run to compare against.

**What happens:** two reviewers look at the same target in parallel, then a fan-in step
reconciles them into one review — findings deduplicated across models, disagreements
settled against the diff, and anything neither can defend from the diff listed under
`dropped` with a reason. The engine renders that to `review.md` in the run directory, which
is what you read and what a menu choice can post.

**Ends with a menu:**

- **Fix findings** — exactly one of two shapes, never both. When an implementer is live in
  this session it is a hand-off to that agent; when none is, it chains a fresh `implement`
  run on the reviewed target.
- **Fix findings in a full implement run** — chains `implement` with this run as the work
  source, regardless.
- **Post to MR** — sends `review.md` to the merge request it reviewed, verbatim and as a
  single note. Offered only where the target is a merge request and `glab` can reach it.
- **Don't post** — ends the run.

Definition: [`workflows/review.md`](../workflows/review.md).

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

Definition: [`workflows/architecture.md`](../workflows/architecture.md).

## How they chain

- `plan` → `implement`, with the plan directory forwarded as the work source.
- `architecture` → `implement`, the same way.
- `implement` embeds `review` with `use:`, so the review a build gets is the same review
  you would run standalone — override `review` in your layer and `implement` changes too.
- `implement` also embeds the unattended half of `architecture`, which is why that
  workflow's menu step is marked `standalone:` and does not run when embedded.
- `review` → `implement`, or a hand-off to a live implementer. See
  [Hand-offs](using.md#hand-offs-between-runs).

A chained run is a child of the one that started it, forwarded inputs first and the rest
inferred. The parent finishes once the child has its own Driver; `collie run list` then
shows the two independently. The one exception is a plan that spans repositories, where
the parent chains one run per repository and stays alive until the last of them ends —
see [Plans that span repositories](#plans-that-span-repositories).
