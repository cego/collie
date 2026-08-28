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

**Status:** done

- [x] fake-herdr transcript for review with two variants: exactly one tab, two agent panes + one status strip, ratios as specified
- [x] implement transcript: build/architecture/simplify/fix in one pane with label changes; review variants in one tab per iteration (reuse the tab across iterations, fresh agents in the same panes when possible)
- [x] label functions tested: sha never appears, MR shows as `!iid`, default-harness variants show model only
- [x] choice menu zooms the strip and restores it (transcript)
- [x] README "Using it" and docs/WORKFLOWS-DESIGN.md describe the new layout
- [x] live smoke: review on this repo → one tab, side-by-side panes, thin status strip, tab named `⚙ review · <branch>`

## Decisions where the design was silent

- **The strip is made by splitting down at 0.85 and swapping, not by splitting at 0.15.**
  herdr's `--ratio` sizes the *first* pane's slot and the original pane keeps the top
  slot, so a plain `--direction down --ratio 0.15` puts the strip on top. `pane swap`
  exchanges occupants, not slot sizes, so the order is: split at 0.85, then swap the
  runner's pane into the small bottom slot. Probed live before it was written.
- **The i-th of N even splits uses `1 / (N - i + 1)`.** Each split leaves the left pane
  exactly 1/N of the tab, because the pane being split still holds everything to its right.
- **A tab names the run, not the step**, so a run's tabs share a name and differ by glyph.
  That reads badly only if a run has many tabs, and it does not: `agent:` reuse collapses
  build/architecture/simplify/fix/mr into one pane, so a full `implement` run is two tabs —
  the runner's and the reviewers'. The step is on the pane, where it changes.
- **A target names the run only where the workflow owns that input.** `implement` inherits
  `target` from the `review` it embeds, so naming it `implement · worktree` would describe
  the wrong thing; it uses its slug instead. This reuses ticket 10's `embeddedInputs`.
- **`HEAD` counts as opaque, like a sha.** `branch:b5571dc...HEAD` has no human name on
  either side, so the tab says `diff` rather than showing either.
- **A restarted variant keeps its slot rather than its ratio.** `fresh:` splits the old
  pane and closes it, so the replacement inherits the combined space — which is why the
  reviewers stay side by side across every iteration without re-splitting.
- **Zoom failures are swallowed.** A pane that will not zoom is still a pane the human can
  scroll; failing a run over a cosmetic call would be worse. The unzoom is in a `finally`.
