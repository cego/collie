# Baseline workflows & personas — design (2026-08-27)

**Status: implemented.** All eight tickets of workflows v2 shipped on `master`; this file
is the design as settled, and `.scratch/workflows-v2/issues/` records the decisions taken
where it was silent. The engine additions below exist as `choices:` (with `run`, `prompt`,
`post` and `stop`), `{{run.dir}}`, the `plan-dir` and `work-source` Input strategies,
chaining with a `parent`/`children` link, `prompt: <section>` overrides, `standalone:`
steps, `requires:`, `fan_in:`, `model: default` and `repeat.back_to`. What the design left open and the
implementation had to name: a `stop` choice, `follow_up` and `config` on a choice,
`standalone` for a menu that must not be embedded, and `fan_in` for the step that
reconciles several parallel Outputs into one.

Planning only; settled by interview. Vocabulary: `CONTEXT.md`. Respects ADR-0001, ADR-0002.

## Principles
- Skills are installed via skills.sh on every harness, so Personas name skills directly
  (grill-with-docs, to-spec, to-tickets, wayfinder, implement, tdd, code-review,
  code-review-and-quality, code-simplification, improve-codebase-architecture).
- Personas are thin: "run skill X under these constraints, then write the Output JSON",
  plus a one-paragraph fallback for a harness where the skill is missing.
- Nothing planning-related is written into the repo. Spec, tickets and reports live in
  the Run directory (ADR-0002). `tasks/` and `.scratch/` in the repo are gone.
- Multi-model = variants of one Persona. One implementer, always.

## Engine additions
1. **Choice step** — `choices:` renders a menu in the runner pane (picker TUI). Each choice
   is `run: <workflow>` (chain: start that Workflow with forwarded Inputs, e.g.
   `plan: {{run.dir}}/plan`), `prompt: <text>` (send to a named agent, then re-offer the
   menu after its Output), `post: true` (the engine sends the run's `review.md` to the
   merge request as one `glab mr note`) or `stop: true`. Selecting a choice records it in
   the run.
2. **Run-dir artefacts** — `{{run.dir}}` in prompts; `plan-dir` Input strategy = newest
   finished `plan` Run for this repo with `plan/SPEC.md`, else ask. `work-source` widens
   that to the three newest plus a Linear id from the branch, and asks with a menu.
3. **Chaining** — `run:` creates a child Run linked to the parent; tabs go in the same
   workspace; parent finishes when the child is launched.
4. **Summaries** carry `disputed` (implementer) and `deferred` (architect) lists.
5. **Bounded unattended variant** — an embedding step may override the embedded
   workflow's prompt section (`prompt: unattended`) so `architecture` has an attended and
   an unattended body.
6. **Fan-in step** — `fan_in: <earlier step>` gives a Step that Step's Output files as
   `{{fan_in}}` and puts its pane in that Step's tab. Its own Output must be a Synthesis
   (`verdict`, `findings`, `summary`, `dropped`, each dropped finding with a `reason`),
   which the engine renders to `{{run.dir}}/review.md` and prints in the run's pane. Reconciling
   several reviewers is that Step's job; the engine no longer unions findings.
7. **Step requirements** — `requires:` takes one name or a list. `gitlab` is glab plus a
   GitLab remote; `mr-target` is a run whose `target` is a merge request. An unmet
   requirement is a skip with a note that names the gap, never a failed run.
8. **The harness's own model** — `model: default`, at a Step or as the user's default,
   passes no model flag, so the harness starts on whatever it would start on by itself.
   Every harness accepts it, and a pane for such a variant is named after the harness.
9. **The workspace tab** — one `workflows` tab per workspace as the Session's control
   surface: live agents by role with a key that focuses each, active Runs with their
   step and iteration, this Session's finished Runs with their outcome, and quick
   actions (pick, resume, fork, send the last review to the implementer). It reads the
   run dirs and the live-agent register and holds no engine state of its own. Runs
   register their long-lived agents there — see **Session**.

## Tabs and panes
One tab per Step. A Step's parallel variants are equal side-by-side splits inside that
Step's tab, so two reviewers are one tab of two panes rather than two tabs. A Step with
`fan_in:` opens no tab either: it splits down from the last pane of the Step it
reconciles, so the synthesis sits under the reviews it came from. A Step
that continues an earlier agent (`agent: <step>`) opens no tab and no pane — it renames
the pane it inherited to its own id. Run tabs hold agents and nothing else.

The runner's own pane is not in them. One tab per workspace, labelled `workflows`, holds
the Session's board, and each Run's own pane moves in underneath it (40/60): that is
where the Run reports and where every Choice menu it opens appears, zoomed while it is
open. The tab is created by the first Run in the workspace, found by its label and
reused by every Run after it, and moved to the front of the workspace on every Run start
so it is always `prefix+1`. Closing it loses nothing — the next Run recreates it.

Tabs read `<glyph> <workflow> · <target>`: `!123`, a branch name (never a sha) or
`worktree` for `review`, the run's slug for the rest, and never a run id, harness or
model. `⚙` working, `⚠` waiting for the human, `✓` done — only when every pane in the tab
is — `✗` stopped. Panes are the model where variants differ (`opus`, `codex gpt-5`), the
step id where one runs alone, the run's slug on its own pane in the `workflows` tab.
Agent names stay herdr-legal and
unique, and are never what a label shows.

## Workflows

### plan
Inputs: `goal` (ask), `ticket` (optional, from branch).
Steps (one agent throughout, `agent: grill`):
1. `grill` — planner; `/grill-with-docs` on the goal. Criterion: if the destination is not
   visible or the work exceeds one session, switch to `/wayfinder` with a local map in
   the run dir. Writes CONTEXT/ADRs into the repo (that part IS committed — it is domain
   knowledge, not a plan).
2. `spec` — `/to-spec` → `{{run.dir}}/plan/SPEC.md` (not published).
3. `tickets` — `/to-tickets` → `{{run.dir}}/plan/issues/NN-*.md`.
4. `next` — choices:
   - **Implement now** → `run: implement` with `plan: {{run.dir}}/plan`
   - **Second opinion** → fresh reviewer (opus, xhigh) reviews SPEC + tickets for
     plan-level problems only (missing stories, wrong seams, ordering); findings prompt
     the planner to revise; max 2 rounds; menu again.
   - **Offload to Linear** → planner uses Linear MCP: ONE issue, spec as body, tickets
     as a checklist. Team asked once, remembered in `config.json`.
   - **Refine** → prompt planner "the human wants changes; ask what", rewrite, menu again.
     No cap.

### implement
Inputs: `plan` (work-source: a plan dir, a Linear issue or free text). One implementer
agent (`agent: build`) for build/architecture/simplify/fix.
1. `build` — implementer, `model: default` at `effort: medium`. That is the whole
   implementer agent, so `architecture`, `simplify`, `fix` and `mr` run on it too.
   Branch off the default branch as `<slug>`; `/implement` over the tickets with `/tdd`
   at the spec's seams; commit per ticket. No separate commit step.
   The prompt branches on `{{inputs.plan_kind}}`: a plan dir is read as today; a Linear
   issue is fetched via MCP and a description is taken as given, and both are written to
   `{{run.dir}}/plan/` as SPEC + tasks before building.
2. `architecture` — `use: architecture` (unattended body): `/improve-codebase-architecture`
   scoped to the changed area; apply `Strong` candidates only, top first, re-scan, max 2
   passes; report saved to `{{run.dir}}`, never opened; others → `deferred`.
3. `simplify` — `/code-simplification`, behaviour-preserving, tests must stay green.
4. `review` — `use: review`, `fresh: true`, parallel variants opus/medium + sonnet/xhigh.
   The embedding step also carries `model: default` at `effort: medium`, which the named
   variants override and `synthesize` — which names none — takes.
5. `fix` — `repeat: {from: review.synthesize}`, max 5: apply the one synthesised review's
   findings, `disputed` allowed, fixup commits; then loop back through `simplify` →
   `review` (simplify IS in the loop, architecture is not).
6. `mr` — the same implementer pushes the branch and opens the merge request with `glab`,
   assigned to `gitlab.assignee` from `config.json` or whoever `glab api user` says. The
   description follows the repo's own template
   (`.gitlab/merge_request_templates/default.md`, the CIATF assessment) filled in by the
   agent, because `glab` does not pre-fill templates: one or two plain sentences per
   section, `No impact.` where that is the honest answer, no tables or matrices. Linear
   tickets come from the work source, the branch name and whatever a `plan` run offloaded,
   deduplicated; their links replace the template's Trello line and the MR URL is
   commented back onto each issue. Never merges. `push` is the run's only remote side
   effect. The step declares `requires: gitlab` and is skipped with a note where `glab`
   or a GitLab remote is missing.
Blocked at max with open findings (unchanged).

### review
Inputs: `target` (diff-target). The target is chosen, not guessed: the
picker lists this branch's open MR (or, failing that, the open MRs I am on either side
of), the branch against its base, and the working tree when it is dirty, in the order
plain inference would have picked them — so Enter reproduces the old behaviour — plus
"Type it…" for an MR iid/URL or a `base...head` range. Kinds are `mr`, `branch`,
`worktree` and the value keeps its `mr:<iid>` / `branch:<base>...<head>` / `worktree`
shape. Embedded in `implement` the target is inferred silently, because an embedded
step never asks. One `reviewer` Persona running BOTH
`/code-review` (standards + spec axes; spec = plan dir if inferable, else "no spec") and
`/code-review-and-quality` (five axes), merged into one Output. Parallel variants
opus + sonnet in baseline. Then `synthesize` (`fan_in: review`, a fresh agent on the
default model) reads both reviews and the diff and writes the one review this change
gets: findings deduplicated, disagreements settled from the diff, anything it cannot
defend listed under `dropped` with a reason. The engine renders that to `review.md` and
prints it. Standalone and pointed at an MR, a last Choice offers **Post to MR** — one
`glab mr note` with `review.md` verbatim — or **Don't post**; every other target and
every embedded review skips it (`standalone: true`, `requires: [mr-target, gitlab]`).

### architecture (standalone, attended)
Inputs: none (cwd). `architect` runs `/improve-codebase-architecture` with the real
grill; ends with choices: **Implement now** (`run: implement` with the resulting plan
dir — the grill writes SPEC/tickets like `plan` does), **Stop here** (report only).

## Personas
- `planner` — interview first, write nothing until agreed; knows the wayfinder criterion.
- `implementer` — plan-bound, thin slices, TDD, commits per ticket, never silently drops
  a finding (`disputed`).
- `reviewer` — reports, never fixes; runs both review skills; severity vocabulary;
  clean is a real answer.
- `architect` — deletion test, `Strong` only when unattended, records `deferred`.
Each ends with the Output contract and a skill-missing fallback paragraph.

## Config
`config.json` gains `linear.team`. `model` may be `default` — accepted by every harness,
and meaning no model flag is passed at all, so the harness starts on its own default.
