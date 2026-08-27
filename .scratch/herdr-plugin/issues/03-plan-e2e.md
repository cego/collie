# 03: plan end to end

**What to build:** Pick `plan` from the popup picker (built-in TUI), be asked for a goal, get one tab with the planner Persona in the default harness that interviews you and writes tasks/<slug>/PLAN.md; tab marked ✓ and toast on finish.

**Blocked by:** 01, 02

**Status:** done

- [x] popup picker lists workflows, filters by typing
- [x] inferred/asked inputs shown on a confirm line
- [x] run dir records inputs and step status
- [x] live demo: PLAN.md written

**Notes:** Three herdr 0.7.5 facts forced filled-in decisions, all verified live:

1. `agent start` rejects arguments it "cannot encode safely for the target shell",
   so a Persona cannot be passed as text. Personas are written to
   `<run>/personas/<name>.md` and claude gets `--append-system-prompt-file <path>`.
   Harnesses without such a flag still get the Persona as a prompt prefix.
2. `agent prompt` silently swallows multi-line text. The rendered prompt is written
   to `<run>/steps/<step>[/<variant>]/prompt-<iteration>.md` and the agent gets the
   one-line `Your task for this step is in <path> — read it and follow it.` This also
   puts the exact prompt in the audit trail.
3. Agent names must match `^[a-z][a-z0-9_-]{0,31}$`, so agent names and tab/pane
   labels are separate: `src/naming.ts` builds a truncated unique agent name
   (`<slug-head>-<step>[-<variant>]-r<seq>`) while tabs and panes keep the readable
   `<slug>/<step>[/<harness>-<model>]`.

Also: `tab create --cwd` and `pane split --cwd` are ignored in 0.7.5, so the runner
runs `cd <project>` in a new pane before starting the agent. Popup plugin panes must
target the active pane, so `plugin.pane.open` passes `--workspace` only for the
`runner` (tab) pane. Manifest pane commands are not resolved against the plugin root,
so they run via `sh -c 'exec "$HERDR_PLUGIN_ROOT/bin/herdr-workflows" ...'`.

A Step is finished when its Output file exists, not when the agent goes idle: an
interviewing agent settles while waiting for the human. The runner toasts once
("needs you") and keeps polling for the Output, which is what makes `plan` work.

**Live demo:** picked `plan` in the picker, filtered by typing, answered the goal,
confirmed, and the planner interviewed through five questions and wrote
`tasks/version-flag/PLAN.md`. Run dir recorded inputs, sources, step status and
`plan.json`; the pane was marked `✓` and a toast fired.
