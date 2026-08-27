# 01: Run-dir plan artefacts and plan-dir inference

**What to build:** Prompts can reference {{run.dir}}; a new Input strategy `plan-dir` resolves to the newest finished plan Run for this repo that has plan/SPEC.md, else asks. Remove tasks/ and .scratch/ assumptions from baseline prompts and inference. (ADR-0002)

**Blocked by:** None (can start immediately)

**Status:** done

- [x] {{run.dir}} substituted in every step prompt (tested)
- [x] plan-dir picks newest finished plan run for the same repo, ignores other repos (tested)
- [x] plan-file strategy removed; no baseline text mentions tasks/

## Decisions where the design was silent

- **`{{run.dir}}` replaces `{{run_dir}}`** rather than joining it: one spelling, and
  `run` now carries `dir`, `id` and `slug`.
- **plan-dir does not check the workflow's name.** Having written `plan/SPEC.md` is the
  test, so a plan from `ticket` or from `architecture`'s grill counts too. It still
  ignores other repos (`cwd`) and unfinished runs.
- **A Resolution may carry a short `label`**, used to name the Run instead of the value.
  Without it `implement` would be called `implement-home-mk-local-state-herdr-…`; with
  it, chaining off `plan-add-a-picker` gives `implement-add-a-picker`.
- **A headingless body is the prompt, not the preamble as well.** v1 sent such a body
  twice (plan's whole prompt was duplicated in every run). Fixed here because plan.md is
  exactly that shape; asserted in `plan-e2e`.
- `docs/SPEC.md` still describes v1's `tasks/<slug>/PLAN.md`; it is the historical v1
  spec and ADR-0002 supersedes it. Noted for the docs update in 08.
