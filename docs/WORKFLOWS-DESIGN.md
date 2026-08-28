# Baseline workflows & personas — design (2026-08-27)

**Status: implemented.** All eight tickets of workflows v2 shipped on `master`; this file
is the design as settled, and `.scratch/workflows-v2/issues/` records the decisions taken
where it was silent. The engine additions below exist as `choices:` (with `run`, `prompt`
and `stop`), `{{run.dir}}`, the `plan-dir` and `work-source` Input strategies, chaining with a
`parent`/`children` link, `prompt: <section>` overrides, `standalone:` steps and
`repeat.back_to`. What the design left open and the implementation had to name:
a `stop` choice, `follow_up` and `config` on a choice, and `standalone` for a menu that
must not be embedded.

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
   is either `run: <workflow>` (chain: start that Workflow with forwarded Inputs, e.g.
   `plan: {{run.dir}}/plan`) or `prompt: <text>` (send to a named agent, then re-offer the
   menu after its Output). Selecting a choice records it in the run.
2. **Run-dir artefacts** — `{{run.dir}}` in prompts; `plan-dir` Input strategy = newest
   finished `plan` Run for this repo with `plan/SPEC.md`, else ask. `work-source` widens
   that to the three newest plus a Linear id from the branch, and asks with a menu.
3. **Chaining** — `run:` creates a child Run linked to the parent; tabs go in the same
   workspace; parent finishes when the child is launched.
4. **Summaries** carry `disputed` (implementer) and `deferred` (architect) lists.
5. **Bounded unattended variant** — an embedding step may override the embedded
   workflow's prompt section (`prompt: unattended`) so `architecture` has an attended and
   an unattended body.

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
1. `build` — implementer; branch off default branch as `<slug>`; `/implement` over the
   tickets with `/tdd` at the spec's seams; commit per ticket. No separate commit step.
   The prompt branches on `{{inputs.plan_kind}}`: a plan dir is read as today; a Linear
   issue is fetched via MCP and a description is taken as given, and both are written to
   `{{run.dir}}/plan/` as SPEC + tasks before building.
2. `architecture` — `use: architecture` (unattended body): `/improve-codebase-architecture`
   scoped to the changed area; apply `Strong` candidates only, top first, re-scan, max 2
   passes; report saved to `{{run.dir}}`, never opened; others → `deferred`.
3. `simplify` — `/code-simplification`, behaviour-preserving, tests must stay green.
4. `review` — `use: review`, `fresh: true`, parallel variants opus/xhigh + sonnet/xhigh.
5. `fix` — `repeat: {from: review}`, max 5: apply union of findings, `disputed` allowed,
   fixup commits; then loop back through `simplify` → `review` (simplify IS in the loop,
   architecture is not).
Blocked at max with open findings (unchanged).

### review
Inputs: `target` (diff-target), `post` (flag). One `reviewer` Persona running BOTH
`/code-review` (standards + spec axes; spec = plan dir if inferable, else "no spec") and
`/code-review-and-quality` (five axes), merged into one Output. Parallel variants
opus + sonnet in baseline. Post to GitLab only on `post: true`.

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
`config.json` gains `linear.team`. Defaults unchanged (claude/opus).
