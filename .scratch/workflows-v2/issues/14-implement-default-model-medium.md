# 14: implement runs on the harness's default model at medium effort

**What to build:** A step (or config) may say `model: default`, meaning "do not pass a model flag; let the harness pick its own default". Validation accepts it for every harness; `startArgs` omits the model args; labels show the harness name (`claude`) instead of a model for such variants. Baseline `implement` sets `model: default` and `effort: medium` on the implementer's agent (build, and therefore every step reusing it: architecture, simplify, fix, mr). The embedded `review` variants keep opus/sonnet at xhigh; `synthesize` (13) follows the implementer's setting unless it names its own. Document `default` in README's model section and in `config.json` docs (a user may set `"model": "default"` globally).

**Blocked by:** 13 (same engine files)

**Status:** done

- [x] `model: default` validates for claude/codex/opencode; startArgs has no model flag (tested)
- [x] implement transcript: implementer started with `--effort medium` and no `--model`; reviewers unchanged
- [x] pane/tab labels for default-model variants show the harness name
- [x] README + docs/WORKFLOWS-DESIGN.md updated; bun test + tsc green

## Decisions where the design was silent

**`default` is a model name, not a flag of its own.** `knownModel` accepts it for every
harness, `startArgs` drops the model args for it, and `modelHint` lists it first, so a typo
in a definition still gets an error message that names the way out. Nothing else in the
engine knows about it: a variant carries `model: "default"` end to end, which is what makes
it work as a user default in `config.json` too.

**Only two steps in `implement` say it.** `build` names it once for the implementer agent —
`architecture`, `simplify`, `fix` and `mr` reuse that agent, so they run on it whatever
their own definition says. And the `review` embedding step names it for `synthesize`: the
two reviewer variants name their own model and effort, so `stepVariants` lets them win,
and `synthesize` — which names none — takes the embedding step's. Saying it on all six
steps would only invite them to disagree.

**A reused agent now records the model it is actually on.** `architecture`, `simplify`,
`fix` and `mr` were recording their own step's variant, which after this ticket would have
read `sonnet` for four steps running on the implementer's `default`. The record now carries
the borrowed agent's harness, model and effort, because that is the agent that is running.
Nothing displays it — a lone variant's pane is named after its step (ticket 12) — but
`run.json` is the audit trail, and it was quietly wrong.

**A default-model pane is named after its harness.** `variantLabel` has nothing to say when
there is no model, so it says `claude` (or `codex`). That only shows where a step has
several variants; a lone one is still the step's name.

## Verified live

`herdr agent start nomodel14 --kind claude --pane … -- --effort medium
--append-system-prompt-file …` in a throwaway workspace: herdr reported
`argv: ["claude", "--effort", "medium", "--append-system-prompt-file", …]` — no `--model`
anywhere — the agent came up `idle` and `interactive_ready`, and its status line read
`[Fable 5]`, i.e. claude's own current default rather than anything this plugin named. That
is the only thing about this ticket that could not be settled by a transcript: whether the
harness is happy to be started with no model at all.
