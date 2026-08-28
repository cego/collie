# 21: skill references render per harness — `/name` in Claude Code, `/skill:name` in pi

**Bug:** personas and workflow bodies hardcode Claude Code syntax (`/to-spec`, `/code-review`, …). In pi a bare `/name` is a prompt template, not a skill; skills are `/skill:<name>`. The skills themselves are shared via `~/.agents/skills` (skills.sh) and exist for every harness, so only the syntax is wrong.

**What to build:** Personas and bodies reference skills by name through a template: `{{skill:code-review}}`. The harness adapter owns the rendering: claude → `/code-review`; pi → `/skill:code-review`; codex/opencode → the sentence `the "code-review" skill` (they surface skills to the model by description; no slash form). The `skill:` step key uses the same rendering. Replace every hardcoded `/name` in `personas/*.md` and `workflows/*.md` with the template (list: grill-with-docs, wayfinder, to-spec, to-tickets, implement, tdd, code-review, code-review-and-quality, code-simplification, improve-codebase-architecture). Validation fails fast when a referenced skill is not present in `~/.agents/skills` (or a project `.agents/skills`), naming the skill and the `npx skills add` command to install it — skills are a prerequisite, like the harness binary. The skill-missing fallback paragraphs in personas stay.

**Blocked by:** none — small; slot after 20.

**Status:** ready-for-agent

- [ ] template rendering tested per harness (claude, pi, codex, opencode)
- [ ] no hardcoded `/<skill>` remains in personas/workflows (grep in a test)
- [ ] missing skill ⇒ validation error naming the skill and the install command (tested with a fake skills dir)
- [ ] live smoke: review with mk's user layer → the pi pane receives `/skill:code-review` and `/skill:code-review-and-quality`, the claude pane `/code-review`
- [ ] README documents `{{skill:name}}` and the skills.sh prerequisite
