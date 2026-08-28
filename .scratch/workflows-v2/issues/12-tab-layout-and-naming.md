# 12: one tab per step, variants side by side, a thin status strip, short names

**What to build:** Simplify the run's tab/pane topology and its labels.

Layout rules:
1. **One tab per Step, not per pane.** Parallel variants of a step share that step's tab as equal side-by-side splits (`--ratio` so N variants get 1/N each). Today's review run (tab 1 = status + opus, tab 2 = sonnet) becomes one tab: opus | sonnet.
2. **The status pane is a thin strip** (`--direction down`, ratio ≈ 0.15, never wider than the tab) at the bottom of the run's first tab only. It never sits beside an agent pane.
3. **Steps that reuse an agent (`agent: <step>`) create no new tab or pane**; the existing pane's label changes to the current step id (build → architecture → simplify → fix), and the tab glyph follows.
4. Choice menus render in the status strip, zoomed while the menu is open (`pane zoom`), then unzoomed.

Naming rules:
- Tab: `<glyph> <workflow> · <target>` where target is short and human: review → `!123`, the branch name (never a sha), or `worktree`; implement/plan/architecture → the slug. No run id, no harness/model, no repeated workflow name.
- Pane: the variant's short name — model alone when the harness is the default (`opus`, `sonnet`), `codex gpt-5` otherwise; a single-variant step's pane is the step id; the strip is `status`.
- Glyphs: ⚙ running, ⚠ needs you, ✓ done, ✗ failed/blocked. A tab shows ✓ only when all its panes are done.
- Agent names stay herdr-legal and unique (naming.ts) but are never shown in labels.

**Blocked by:** 11 (avoid engine merge conflicts; the rules above do not depend on it)

**Status:** ready-for-agent

- [ ] fake-herdr transcript for review with two variants: exactly one tab, two agent panes + one status strip, ratios as specified
- [ ] implement transcript: build/architecture/simplify/fix in one pane with label changes; review variants in one tab per iteration (reuse the tab across iterations, fresh agents in the same panes when possible)
- [ ] label functions tested: sha never appears, MR shows as `!iid`, default-harness variants show model only
- [ ] choice menu zooms the strip and restores it (transcript)
- [ ] README "Using it" and docs/WORKFLOWS-DESIGN.md describe the new layout
- [ ] live smoke: review on this repo → one tab, side-by-side panes, thin status strip, tab named `⚙ review · <branch>`
