# 09: implement accepts a local plan, a Linear ticket, or free text; drop the ticket workflow

**What to build:** `implement`'s `plan` input becomes a `work-source`. The runner gathers candidates: the newest finished local plan runs for this repo (existing `plan-dir` logic, keep up to 3 newest) and a Linear issue id found in the branch name. Exactly one candidate → inferred with the usual confirm line. Zero or several → the picker shows a menu listing each candidate plus "Type it…", where the human pastes a Linear id/URL or writes free text. The resolved value is recorded with its kind (`plan-dir`, `linear`, `text`) and both are available in prompts as `{{inputs.plan}}` and `{{inputs.plan_kind}}`. The `build` step prompt branches on the kind: plan dir → work from its SPEC and tickets as today; linear → fetch the issue via the Linear MCP, treat its body as the spec, write a short task list into `{{run.dir}}/plan/` before building; text → same from the text. Remove the `ticket` workflow and the `issue` input strategy entirely (README, design doc, tests). `plan`'s optional `ticket` input stays.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `work-source` in INPUT_STRATEGIES; `issue` and workflows/ticket.md gone, no dangling references (grep clean)
- [ ] one candidate → inferred, confirm line shows kind (tested)
- [ ] none/several → menu with candidates + "Type it…"; free text and Linear id/URL both classified correctly (tested; URL like https://linear.app/<team>/issue/ABC-123/... → linear)
- [ ] `{{inputs.plan_kind}}` substituted; build prompt has the three branches
- [ ] README + docs/WORKFLOWS-DESIGN.md updated; `bun test` and `bunx tsc --noEmit` green
- [ ] live smoke: pick implement in a repo with no plan run and a non-ticket branch → menu appears
