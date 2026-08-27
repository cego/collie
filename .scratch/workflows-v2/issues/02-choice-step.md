# 02: Choice step

**What to build:** A step with `choices:` renders a menu in the runner pane using the picker TUI. A choice with `prompt:` sends text to a named agent and re-offers the menu once that agent's next Output exists; the selection is recorded in the run and the step is done only when a choice without re-offer is taken.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] choices validated: each has title and exactly one of run/prompt (plus `stop`, see below)
- [x] prompt choice → agent prompted → menu shown again (fake herdr test)
- [x] selection recorded in run dir

## Decisions where the design was silent

- **A third form, `stop: true`**, joins `run:` and `prompt:`. `architecture`'s menu
  needs a "Stop here" (07) and faking it as a prompt round would waste an agent turn.
  Validation reads "needs exactly one of run, prompt or stop".
- **`prompt:` names a body section, not literal text.** Long prompt text belongs in the
  markdown body like every step's, and it makes the same key mean the same thing on a
  step (04) and on a choice.
- **A round is a Step in everything but its id.** `persona`, `harness`, `model`,
  `effort`, `fresh`, `agent` and `output` mean what they mean on a step, so a choice can
  prompt the workflow's own agent (`agent: grill`) or start a fresh reviewer. Its files
  land in `steps/<step>/<choice-slug>-<n>/`, which keeps every round in the audit trail.
- **`max:` on a choice**, counted from the recorded selections; an exhausted choice is
  simply no longer offered.
- **`follow_up:` on a choice** — a second round, run only when the first round's Output
  reported findings, with those findings in `{{findings}}`. This is the design's
  "findings prompt the planner to revise" for `plan`'s Second opinion, and it is the one
  place two agents take part in one choice.
- **`config: {key, question}`** asks for a value once, writes it to `config.json`, and
  exposes the whole config as `{{config.<dotted.key>}}`. That is how `linear.team` is
  remembered (06).
- **Esc leaves the step unfinished** (`blocked`, note "no choice taken") so the run
  stays resumable, rather than ending the run as if a choice had been made.
- **A round that never writes its Output does not fail the run**: the human is already
  at the menu, so the error is printed and the menu comes back.
- **The menu is a seam** (`EngineOptions.prompts`), so the runner passes the real picker
  and the tests script the answers.
