# 18: plain names — tabs are just the workflow or step, nothing else

**What to build:** Strip every label down to the word a human would say.
- Tab: `<glyph> <name>` where name is the workflow for its main tab (`implement`, `plan`, `architecture`) and the step for a step tab (`review`). No target, no slug, no run id, no model. Only when two live runs in the same workspace would produce the same tab name does the newer one get ` · <target>` appended (target as today: `!123`, branch, worktree, slug) — disambiguation on collision, never by default.
- Pane: single pane in a tab → no label at all (the tab already says it); parallel variants → model alone (`opus`, `gpt-5.6-sol` — strip the provider prefix), `harness` only when the model is `default`; the synthesize pane → `synthesize`.
- The workspace tab stays `workflows`. Run slugs and agent names remain internal and never appear anywhere a human reads; the `workflows` tab shows target and run details instead.
- Glyph rules unchanged (⚙ ⚠ ✓ ✗).

**Blocked by:** 16 (the workflows tab is what makes the target on the tab redundant)

**Status:** ready-for-agent

- [ ] tabLabel/variantLabel tests: `⚙ implement`, `⚙ review`, collision ⇒ ` · <target>` on the second run only; `openai-codex/gpt-5.6-sol` ⇒ `gpt-5.6-sol`; single pane ⇒ no label
- [ ] implement transcript: tabs `⚙ implement` and `⚙ review`, implementer pane unlabelled, reviewer panes `opus`/`sonnet`, synthesize pane `synthesize`
- [ ] README/design doc examples updated; bun test + tsc green
- [ ] live smoke: review on this repo → tab reads `⚙ review`, panes `opus` and `gpt-5.6-sol` (mk's user layer), then `✓ review`
