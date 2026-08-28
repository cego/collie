# 21: skill references render per harness — `/name` in Claude Code, `/skill:name` in pi

**Bug:** personas and workflow bodies hardcode Claude Code syntax (`/to-spec`, `/code-review`, …). In pi a bare `/name` is a prompt template, not a skill; skills are `/skill:<name>`. The skills themselves are shared via `~/.agents/skills` (skills.sh) and exist for every harness, so only the syntax is wrong.

**What to build:** Personas and bodies reference skills by name through a template: `{{skill:code-review}}`. The harness adapter owns the rendering: claude → `/code-review`; pi → `/skill:code-review`; codex/opencode → the sentence `the "code-review" skill` (they surface skills to the model by description; no slash form). The `skill:` step key uses the same rendering. Replace every hardcoded `/name` in `personas/*.md` and `workflows/*.md` with the template (list: grill-with-docs, wayfinder, to-spec, to-tickets, implement, tdd, code-review, code-review-and-quality, code-simplification, improve-codebase-architecture). Validation fails fast when a referenced skill is not present in `~/.agents/skills` (or a project `.agents/skills`), naming the skill and the `npx skills add` command to install it — skills are a prerequisite, like the harness binary. The skill-missing fallback paragraphs in personas stay.

**Blocked by:** none — small; slot after 20.

**Status:** done

- [x] template rendering tested per harness (claude, pi, codex, opencode)
- [x] no hardcoded `/<skill>` remains in personas/workflows (grep in a test)
- [x] missing skill ⇒ validation error naming the skill and the install command (tested with a fake skills dir)
- [x] live smoke: review with mk's user layer → the pi pane receives `/skill:code-review` and `/skill:code-review-and-quality`, the claude pane `/code-review`
- [x] README documents `{{skill:name}}` and the skills.sh prerequisite

## Decisions where the design was silent

**One persona file per harness.** A persona is written into the run dir and passed to the
agent as a file, and the same persona now renders differently for claude and for pi — so it
is written as `personas/<persona>.<harness>.md`. One file per persona would have meant the
second variant overwriting what the first had already been given, and the run dir is
supposed to show what each agent actually received.

**Bodies too, not just personas.** A step's own prompt body goes through the same renderer
with the same per-harness function, and so does the `skill:` key the engine sends as a
command. There is one function — `skillFor(harness)` — and everything a harness reads goes
through it.

**Skills are rendered before variables.** `{{skill:x}}` is substituted first, so it can
never be reported as an unknown template key; with no renderer supplied it is left alone
rather than blanked, which is what makes `renderTemplate` safe to call for other purposes.

**Codex and opencode get a sentence, not a slash.** They surface skills to the model by
description, so `/code-review` would arrive as literal text and do nothing. `the
"code-review" skill` is what the adapter renders, which is a thing the model can act on.

**Validation is opt-in at the call site.** `validateWorkflow(..., skillDirs(env))` does the
check; called without the dirs it skips it. The picker passes them, so a real run fails
before a tab opens, and tests that are not about skills do not need a fixture directory.

**Project skills win.** `.agents/skills` in the project is checked before
`~/.agents/skills`, the same order the definition layers use.

## Verified live

One `review` run in a workspace on the smoke worktree, with mk's user-layer `review.md`
(claude `opus` + pi `openai-codex/gpt-5.6-sol`). The run dir holds two persona files from
the one baseline `reviewer` definition:

- `personas/reviewer.claude.md` — ``- `/code-review` — the standards axis`` and
  ``- `/code-review-and-quality` — the five axes``
- `personas/reviewer.pi.md` — ``- `/skill:code-review``` and
  ``- `/skill:code-review-and-quality```

Both agents started with their own file (`--append-system-prompt-file` for claude,
`--append-system-prompt` for pi), and all ten skills the baseline names are installed here,
so validation passed rather than being skipped.
