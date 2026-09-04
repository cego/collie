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
never asked for.

**What happens:** a planner interviews you one question at a time, then writes `SPEC.md`
and one ticket per slice into the run's `plan/` directory. Plans never enter the repository
([ADR-0002](adr/0002-plan-artefacts-live-in-the-run-directory.md)).

**Ends with a menu:**

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

**Inputs:** `plan`, a work source. It does not need a plan run: inference gathers the three
newest finished `plan` runs for this repo and a Linear issue id in the branch name. One
candidate is taken as the answer; none or several bring up a menu of them plus **Type it…**,
which accepts a Linear id or URL, a path to a plan directory, or a plain description of the
work. What was resolved is recorded with its kind, and the build prompt reads both
`{{inputs.plan}}` and `{{inputs.plan_kind}}` (`plan-dir`, `linear`, `review` or `text`).
`review` is what a run chained from a review carries: the findings are the tickets. For
`linear` and `text` the implementer writes the spec and a task list into the run's `plan/`
before it builds, so every run leaves the same audit trail.

**Branch:** named after the work, not the path to it — an explicit `--input branch=`, else
the reviewed branch, else the `<name>` of a `branch:<base>...<name>` target you gave, else
the plan directory's own name ([the full order](cli.md#start-a-run)).

**What happens:** one implementer agent builds (a commit per ticket), then improves the
architecture it touched, then simplifies. It embeds `review` — two models in parallel, one
synthesized review — and loops on the findings up to `max_iterations` (5 by default). Every
step that commits pushes what it committed, so the reviewers read the change rather than
the state before it. The last step opens or updates the merge request, and is skipped where
there is no GitLab to open one on.

**Ends:** with the merge request, or with the reason the `mr` step was skipped. There is no
menu.

Definition: [`workflows/implement.md`](../workflows/implement.md).

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
**Implement now** asks which branch to build on: `architecture` takes no input that names
the work, so there is nothing to name a branch after, and every architecture run in a repo
would otherwise be handed the same one ([how the branch is chosen](cli.md#start-a-run)).

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
shows the two independently.
