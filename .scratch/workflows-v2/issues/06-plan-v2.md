# 06: plan and ticket workflows v2

**What to build:** plan: single agent across grill → spec → tickets writing into {{run.dir}}/plan, then the Choice menu Implement now / Second opinion (fresh opus reviewer of SPEC+tickets, plan-level findings only, max 2 rounds) / Offload to Linear (one issue, spec body, ticket checklist; team from config.json linear.team, asked once) / Refine (no cap). ticket: use plan with goal from a Linear issue.

**Blocked by:** 01, 02, 03, 05

**Status:** done

- [x] plan validates; steps share agent grill
- [x] second-opinion loop capped at 2 (tested)
- [x] linear.team read from and written to config.json
- [x] live: plan end to end reaching the menu; Implement now chains

## Decisions where the design was silent

- **plan's menu has no "Stop here"**: the design names four choices, and Esc already
  leaves the run open for `resume`, which is the honest state — a plan nobody acted on.
- **A new `issue` Input strategy** for `ticket`: the Linear id from the branch
  (`ENG-42`), else "Which Linear issue? (id or URL)". `ticket` stays optional and
  never asks, so `plan` is unchanged.
- **`ticket` is `use: plan` and nothing else.** Its own `goal: issue` is declared first,
  so it wins over plan's `goal: goal`, and plan's grill prompt starts by fetching the
  issue over MCP when the goal looks like an id or a URL.
- **Embedded steps' back-references are rebased.** `use: plan` renames the steps to
  `plan.grill`, `plan.spec`, …, so `agent: grill` inside plan (and inside its choices)
  now moves with them. Without this, `ticket` could not validate at all.
- The engine forgets a step's note when the step starts again, so a step that failed and
  then succeeded no longer carries the old failure into the summary (found by the live run
  below).

## Live run

`plan` in a sandbox repo (`scratchpad/demo-cli`), goal "Add a --version flag …",
run `plan-…-20260827-121724`:

- The planner interviewed in its own tab (three questions), the runner printed
  "⏸ … is waiting for you in its tab" and kept waiting for the Output — the handoff rule
  from v1 still holds with four steps.
- One agent across grill → spec → tickets: one `agent start`, three prompts, and
  `plan/SPEC.md` + `plan/issues/01-version-flag.md` written into the run dir, nothing into
  the repo.
- The menu rendered in the runner pane with all four choices and their hints
  ("runs implement", "a fresh agent", "prompts grill").
- **Implement now chained**: child run `implement-add-a-version-flag-…`, `plan` forwarded
  as an input with source "chained from …", its own runner tab opened in the same
  workspace and reached its build step. That also closes 03's live criterion. The child was
  stopped and deleted afterwards: `implement` v2 lands in 08.

### Two herdr/claude facts this run turned up

1. **`agent start` fails in a directory claude has not been trusted with**:
   `agent_not_ready … blocked during startup`, because claude is sitting on its
   "Is this a project you trust?" dialog. Accepting it once in that pane fixes it for good.
   Nothing the plugin can do about it — but it is the first thing to check when a workflow
   fails instantly in a fresh clone.
2. **A skill marked `disable-model-invocation` cannot be run by an agent.**
   `/grill-with-docs` refused with "Ask the user to run /grill-with-docs themselves". The
   planner used its Fallback paragraph and interviewed by hand, which is exactly why every
   persona has one — for this skill it is the normal path, not the edge case.
