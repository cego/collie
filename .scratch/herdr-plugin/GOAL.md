# Goal: implement herdr-plugin (all tickets)

You are working in the `cego/herdr-plugin` repo (local git, branch `master`, no remote — commit locally as you go, one commit per ticket at minimum; never push).

Read first, in this order: `CONTEXT.md` (glossary — use its terms), `docs/adr/0001-*.md`, `docs/SPEC.md`, then every ticket in `.scratch/herdr-plugin/issues/` (01–07). The design is settled; do not re-open decisions recorded there. If a decision is genuinely missing, pick the simplest option consistent with the spec and note it in the ticket file.

Work the tickets in dependency order (01 → 02 → 03 → 04 → 05 → 06; 07 can follow 02). For each ticket:
1. Write tests first at the seams named in the spec: the fake-`herdr` recorder behind `HERDR_BIN_PATH`/`HERDR_SOCKET_PATH`, and the pure definition loader.
2. Implement until green under `bun test`.
3. Verify live where the ticket says so: `herdr plugin link <repo>` then `herdr plugin action invoke` (you are inside herdr, HERDR_ENV=1; the `herdr` skill/CLI is available — inspect `herdr api schema --json` for exact params). Use `herdr plugin log` when an action fails.
4. Tick the acceptance criteria in the ticket file and set its Status to `done`, then commit.

Constraints: Bun/TypeScript, no other runtime; comments say only why, very short; never mention the company npm scope with an @ in commit text (a hook blocks it); keep the tool surface to the plugin actions `pick`, `resume`, `fork` and the popup `picker` — no extra CLI. Harness adapter table covers claude, codex, opencode, pi with model flags (`claude --model`, `codex -m`, `opencode --model`).

Finish by writing `.scratch/herdr-plugin/REPORT.md`: what shipped per ticket, what was verified live vs. only by tests, and anything left open. Stop when all seven tickets are done or when you are blocked on something only mk can decide.
