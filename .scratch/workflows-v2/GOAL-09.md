Repo `cego/herdr-plugin`, branch `master`, local only; commit, never push.
Read `CONTEXT.md`, `docs/WORKFLOWS-DESIGN.md`, `src/README.md`, `.scratch/workflows-v2/REPORT.md`, then do
`.scratch/workflows-v2/issues/09-implement-work-source.md` exactly. Tests first at the existing seams
(fake herdr, definition loader, inputs with fake git). Live-verify inside herdr via `herdr plugin link`
+ `herdr plugin action invoke cego.workflows.pick` and `herdr plugin log`. Tick criteria, set Status done,
append a short section to `.scratch/workflows-v2/REPORT.md`, commit. Constraints as in GOAL.md
(Bun/TS only, why-comments, no @ npm scope in commit text). Stop when done or blocked on mk.
