# 18: plain names — tabs are just the workflow or step, nothing else

**What to build:** Strip every label down to the word a human would say.
- Tab: `<glyph> <name>` where name is the workflow for its main tab (`implement`, `plan`, `architecture`) and the step for a step tab (`review`). No target, no slug, no run id, no model. Only when two live runs in the same workspace would produce the same tab name does the newer one get ` · <target>` appended (target as today: `!123`, branch, worktree, slug) — disambiguation on collision, never by default.
- Pane: single pane in a tab → no label at all (the tab already says it); parallel variants → model alone (`opus`, `gpt-5.6-sol` — strip the provider prefix), `harness` only when the model is `default`; the synthesize pane → `synthesize`.
- The workspace tab is `Control Plane`. Run slugs and agent names remain internal and never appear anywhere a human reads; the `workflows` tab shows target and run details instead.
- Everything a human reads is Capitalized: tabs `⚙ Implement`, `⚙ Review`, `⚙ Plan`, `Control Plane`; pane labels `Opus`, `Sonnet`, `Synthesize`, `Status`; model ids that are not words keep their own casing (`gpt-5.6-sol`). Workflow/persona file names and ids stay lowercase — capitalization is a display rule in the label functions only.
- Glyph rules unchanged (⚙ ⚠ ✓ ✗).

**Blocked by:** 16 (the workflows tab is what makes the target on the tab redundant)

**Status:** done

- [x] tabLabel/variantLabel tests: `⚙ Implement`, `⚙ Review`, collision ⇒ ` · <target>` on the second run only; `openai-codex/gpt-5.6-sol` ⇒ `gpt-5.6-sol`; single pane ⇒ no label
- [x] implement transcript: tabs `⚙ Implement` and `⚙ Review`, implementer pane unlabelled, reviewer panes `Opus`/`Sonnet`, synthesize pane `Synthesize`
- [x] README/design doc examples updated; bun test + tsc green
- [x] live smoke: review on this repo → tab reads `⚙ Review`, panes `Opus` and `gpt-5.6-sol` (mk's user layer), then `✓ Review`

## Decisions where the design was silent

**Which tab is "the main tab".** The run's own first tab — the first one any step opens —
takes the workflow; every tab after it takes its step. That makes `implement` read
`⚙ Implement` then `⚙ Review`, and a standalone `review` read `⚙ Review`, with no rule
about which step is special.

**A finished tab still counts as a collision.** The check is "is that name on a tab in this
workspace", not "is another run live": a finished run's tab is still open and still in the
way. So a second `review` while the first one's tab is up reads `⚙ Review · <target>`.

**Capitalisation is one function.** `displayName` capitalises a token that is a word
(letters and hyphens only) and leaves everything else — `gpt-5.6-sol`, `!123`, a branch
name — exactly as it is. It is applied in `tabLabel` and `paneLabel` and nowhere else, so
ids, file names, step ids, run slugs and agent names are untouched. A collision target
keeps its own casing: a branch prettied up is no longer that branch's name.

**The run's own pane takes the workflow, not the run.** Ticket 18 says slugs never appear
where a human reads. Two runs of the same workflow therefore have two panes both reading
`Review` on the Control Plane; the board's own rows carry the target and the run id, which
is where the ticket says that detail belongs.

**An embedded step's id keeps its prefix internally.** `use:` makes the synthesiser
`review.synthesize`, and the pane reads `Synthesize`: the prefix is bookkeeping for
back-references, not part of the name.

## What the live smoke caught

**A long model id truncated away the number that makes an agent name unique.** The first
smoke run died with herdr's `agent_name_taken`: `agentName` built
`review-pi-openai-codex-gpt-5-6-sol-r25`, sliced it to herdr's 32 characters, and the
`-r25` — the run's sequence number, the only part that makes the name unique across runs —
was what fell off the end. mk's own review in another workspace had produced the identical
name, so the second run could not start its pi reviewer. The suffix is now reserved before
the step and the variant are laid in, so it always survives; the step, the variant and then
the slug take whatever room is left. Verified live on the rerun:
`review-pi-openai-codex-gpt-5-r25` beside `review-sm-review-claude-opus-r25`, both started,
both working. It would have hit any provider-qualified model (`pi`, `opencode`), not just
this one.

**The board could not see an agent until its step had finished**, because `runStep` only
wrote the variants into the run record once every agent in the step was done — and never at
all when the step failed on the way. That is why the failed run above recorded
`variants: []` and why a working step showed `(none live here)`. Variants are now recorded
as soon as the agents exist.
