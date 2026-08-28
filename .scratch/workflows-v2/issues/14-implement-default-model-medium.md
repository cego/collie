# 14: implement runs on the harness's default model at medium effort

**What to build:** A step (or config) may say `model: default`, meaning "do not pass a model flag; let the harness pick its own default". Validation accepts it for every harness; `startArgs` omits the model args; labels show the harness name (`claude`) instead of a model for such variants. Baseline `implement` sets `model: default` and `effort: medium` on the implementer's agent (build, and therefore every step reusing it: architecture, simplify, fix, mr). The embedded `review` variants keep opus/sonnet at xhigh; `synthesize` (13) follows the implementer's setting unless it names its own. Document `default` in README's model section and in `config.json` docs (a user may set `"model": "default"` globally).

**Blocked by:** 13 (same engine files)

**Status:** ready-for-agent

- [ ] `model: default` validates for claude/codex/opencode; startArgs has no model flag (tested)
- [ ] implement transcript: implementer started with `--effort medium` and no `--model`; reviewers unchanged
- [ ] pane/tab labels for default-model variants show the harness name
- [ ] README + docs/WORKFLOWS-DESIGN.md updated; bun test + tsc green
