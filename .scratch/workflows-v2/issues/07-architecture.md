# 07: architecture workflow (attended + unattended bodies)

**What to build:** Standalone architecture: architect runs the real interactive skill, writes report to the run dir (never opens a browser), ends with Choice Implement now / Stop here. Unattended body: Strong candidates only, apply top, re-scan, max 2 passes, deferred list in Output.

**Blocked by:** 02, 03, 04, 05

**Status:** done

- [x] both sections present and selectable via prompt override
- [x] Output carries deferred list; summary prints it
- [x] live smoke: attended run produces report file in run dir

## Decisions where the design was silent

- **A step may be `standalone: true`**, and is then dropped as soon as its workflow is
  embedded with `use:`. That is what lets `architecture` end with a menu on its own while
  `implement` embeds only the unattended work: a Choice needs the human, and the embedding
  workflow already decides what comes next. `plan`'s menu is *not* standalone, so
  `ticket` (`use: plan`) keeps it.
- **The report is `{{run.dir}}/plan/ARCHITECTURE.md`**, next to the spec and tickets the
  attended grill may write, so "Implement now" can chain with `plan: {{run.dir}}/plan`.
- **`deferred` is collected from any Output that carries a verdict**, deduplicated by file
  and title, and printed at the end of the summary like `disputed`.

## Live run

`architecture` attended in the sandbox repo (run `architecture-run-20260827-124125`):
report written to `plan/ARCHITECTURE.md` in the run dir, a schema-valid Output with one
`weak` deferred candidate, the menu offering Implement now / Stop here in the runner pane,
and "Stop here" ending the run with the deferred list printed in the summary. The architect
asked no questions — it said so in the report, because the sandbox has no seam whose place
depends on anything only a human knows. Nothing was written into the repo.
