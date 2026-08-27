# Goal: workflows v2 — baseline package + engine additions

Repo: `cego/herdr-plugin`, branch `master`, local only. Commit per ticket, never push.

Read in order: `CONTEXT.md`, `docs/adr/0001-*`, `docs/adr/0002-*`, `docs/WORKFLOWS-DESIGN.md`
(the settled design — do not re-open it), `.scratch/herdr-plugin/REPORT.md` (what v1 shipped
and the herdr 0.7.5 gotchas), `src/README.md`, then every ticket in
`.scratch/workflows-v2/issues/` (01–08).

Work the frontier: 01, 02, 04, 05 can start immediately; then 03; then 06, 07; then 08.
Per ticket: tests first at the existing seams (fake herdr recorder, definition loader),
implement until `bun test` and `bunx tsc --noEmit` are green, live-verify where the ticket
says (you are inside herdr; `herdr plugin link` this repo; use `herdr plugin log` on
failures), tick criteria, set Status done, commit.

Constraints: Bun/TypeScript only; comments say why, very short; keep the plugin surface to
actions pick/resume/fork + panes picker/runner; personas name skills by their slash names
(skills are installed on every harness via skills.sh); no plan artefacts in the repo (ADR-0002);
never write the company npm scope with an @ in commit text. Where the design is silent choose
the simplest option and note it in the ticket.

Finish with `.scratch/workflows-v2/REPORT.md`: shipped per ticket, verified live vs tests,
open items. Stop when all eight are done or blocked on a decision only mk can make.
