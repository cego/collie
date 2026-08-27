# herdr-plugin — implementation report

All seven tickets are `done` and committed on `master` (local only, never pushed).
`bun test` is green: 75 tests, 12 files. `bunx tsc --noEmit` is clean. The runner
compiles for linux and darwin on x64 and arm64.

```
f6615e1 Return a success code from a successful fork
d4528cc Add fork and the tagged release pipeline              (07)
81ad659 Resume a run, skipping finished steps                 (06)
3983bb4 Fan out parallel reviews and loop on findings         (05)
cfd37bc Run the review workflow standalone                    (04)
7226e2a Run the plan workflow end to end from the picker      (03)
978a611 Load definitions from three layers                    (02)
b779803 Runner skeleton and the herdr boundary test seam      (01)
```

## What shipped, per ticket

**01 — runner skeleton + herdr boundary seam.** `src/main.ts` dispatches the three
plugin actions (`pick`, `resume`, `fork`) and the two pane entrypoints (`picker`,
`runner`). `src/herdr.ts` is the only channel to herdr: the CLI at `HERDR_BIN_PATH`
for everything 0.7.5 exposes, the socket at `HERDR_SOCKET_PATH` for the three methods
it does not (`agent.view.set`, `agent.view.clear`, `popup.close`). `src/env.ts` reads
the plugin environment herdr provides. The test rig (`test/support/`) is a fake herdr
binary plus a fake socket server recording both transports into one ordered log.

**02 — definition loader.** Layers resolve baseline → user config dir → project
`.herdr/`, later wins by name. `use:` expands another workflow's steps inline through
the same lookup, with the embedding step's own keys winning, so overriding `review.md`
changes every workflow that embeds it. Validation runs before anything opens and names
the step together with the unknown harness, model, persona, prompt or back-reference.
`src/yaml.ts` is a frontmatter-sized YAML subset, so the compiled binary has no
dependency.

**03 — plan end to end.** The picker lists workflows from all layers with the layer
each came from, filters as you type (name prefix, then substring, then in-order
characters), asks only for inputs inference could not supply, and shows one confirm
line. The `runner` pane then drives the run and is the status pane; the first step
splits off it, later steps get their own tabs, tabs are marked `✓`/`⚠`/`✗`, and a
toast fires on finish or block. Baseline `plan`, `review`, `implement` workflows and
`planner`, `implementer`, `reviewer` personas.

**04 — review standalone.** `diff-target` infers open merge request → branch vs the
default base → working tree. `post` is a flag input, always inferred `false`, never
asked. Any Output carrying a `verdict` is validated against the review schema when
collected.

**05 — implement loop.** `repeat: {from, max}` on a step: the reviewers' verdicts at
`from` are the gate; all clean skips the repeating step, otherwise the union of every
reviewer's findings goes into the fix prompt and the loop runs again. Reviewers fan
out to one tab each (`<run>/review/<harness>-<model>`), restart fresh every iteration;
the implementer keeps its pane and context via `agent: build`. The sidebar is filtered
to the run's panes and cleared at the end. Disputed findings land in the summary.

**06 — resume.** The resume picker lists runs with unfinished steps and what is left
in each. The engine needed no resume flag: a step reuses its recorded pane and agent
only if it ran in *this* process, which makes a loop-back reuse and a resume start
fresh. `agent: <step>` follows the same rule, so `fix` never prompts an agent that
died with the previous session.

**07 — fork + release.** `fork` shares the picker: choose a definition, then "my
layer" or "this project". It never overwrites an existing fork. `.gitlab-ci.yml` runs
tests and typecheck on every push and, on a tag, cross-compiles four targets, uploads
them to the generic package registry, and links them from the release, which is what
`install.sh` downloads.

## Verified live vs. by tests only

Verified live, inside this herdr 0.7.5 session:

- `herdr plugin link` registering all three actions and both panes, from this repo and
  from a fresh clone.
- `pick` invoked as an action, opening the real popup pane.
- The picker TUI: listing, type-to-filter, selection, being asked for the goal, the
  confirm line. (Driven in a plain pane, because popup panes are client-side overlays
  with no pane id — `pane send-keys` cannot reach them. Same code path, same binary.)
- `plan` end to end: runner tab created and renamed, first step split off the status
  pane, a real claude agent with the planner persona interviewing through five
  questions, `tasks/version-flag/PLAN.md` written, hand-off toast, pane marked `✓`,
  run dir recording inputs, sources, per-step status and `plan.json`.
- `review` end to end on the working tree: target inferred as `worktree`, a real
  reviewer printing its summary in the tab and writing a schema-valid `review.json`,
  `post: false` respected, run recorded done.
- `resume` listing the interrupted run with its status, remaining steps and start time.
- `fork` copying `review` into a project layer and the `reviewer` persona into a user
  layer, both byte-identical to the baseline.
- `install.sh` on a fresh clone under `env -i` with bun and mise stripped from PATH,
  fetching `herdr-workflows-linux-x64` and running it.
- All four cross-compile targets producing the right binaries.

Verified by tests only (fake herdr):

- The `implement` fix loop — terminating on clean and on `max_iterations`, per-variant
  tabs, `fresh` restarting agents, the finding union and the disputed list. Real
  multi-harness fan-out was not run live because codex is not installed on this
  machine; the loop's every observable herdr call and file is asserted instead.
- Resume's skip-and-restart behaviour.
- `diff-target` inference (fake `glab`/`git` in front of PATH) — the merge-request
  branch was not exercised against a real GitLab.
- The Output schema's rejections.

## herdr 0.7.5 facts that shaped the design

Each of these was found by hitting it live, and each is recorded in the relevant
ticket file:

1. `agent start` refuses arguments it "cannot encode safely for the target shell", so
   a persona cannot be passed as text. Personas are written to
   `<run>/personas/<name>.md`; claude gets `--append-system-prompt-file <path>`
   (undocumented in `--help`, but real). Harnesses without such a flag get the persona
   as a prompt-file prefix.
2. `agent prompt` silently swallows multi-line text. The rendered prompt goes to
   `<run>/steps/<step>[/<variant>]/prompt-<iteration>.md` and the agent gets a
   one-line pointer to it. This also puts the exact prompt in the audit trail.
3. Agent names must match `^[a-z][a-z0-9_-]{0,31}$`, so agent names and tab labels are
   generated separately (`src/naming.ts`).
4. `tab create --cwd` and `pane split --cwd` are ignored, so the runner `cd`s in a new
   pane before starting the agent.
5. Popup plugin panes must target the active pane, so `--workspace` is passed only for
   the `runner` (tab) pane.
6. Manifest *pane* commands are not resolved against the plugin root (actions are), so
   they run via `sh -c 'exec "$HERDR_PLUGIN_ROOT/bin/herdr-workflows" ...'`.
7. `agent.view.set`/`clear` and `popup.close` have no CLI in 0.7.5; the runner calls
   them over the socket.

Also, unrelated to herdr: `Bun.spawn` does not honour a mutated `process.env.PATH`
unless the env is passed explicitly.

## Decisions filled in where the spec was silent

Each is noted in the ticket it belongs to.

- **A step is finished when its Output file exists**, not when the agent goes idle. An
  interviewing agent goes idle waiting for the human, so the runner toasts once
  ("needs you") and keeps polling. Without this, `plan` could never complete.
- **Hitting `max_iterations` with findings still open blocks the run** instead of
  continuing to `commit`. Committing work the reviewers still object to would be worse
  than stopping, and the spec already wants a blocked step to hand off.
- **Per-step prompts come from `## <step-id>` sections** of the one markdown body,
  with the text before the first heading as a shared preamble. A one-step workflow with
  no headings uses its whole body.
- **User defaults live in `config.json`** in the plugin config dir: `harness`, `model`,
  `max_iterations`, `handoff_timeout_ms`, and `models` for models the adapter table
  does not list.
- **Model validation** accepts the adapter's alias list, the adapter's pattern
  (`opencode` requires `provider/model`), or a user-listed extra.
- **An embedded workflow's Inputs are inherited**, with the embedder's own declared
  first (the first input names the run) and winning on conflict.
- **`install.sh` falls back to building with bun** when there is no release asset and
  bun is present — for a machine developing the plugin, not for consumers.
- **`fork` never overwrites**: an existing fork is the file you already edited.

## Left open

- **No remote, no tag, no release.** The CI job is unrun: the repo is local only, and
  `install.sh`'s download was verified against a `file://` stand-in. The first real
  `git push` + tag will be the first test of `.gitlab-ci.yml`. `oven/bun:1.3` needs to
  be reachable from cego runners, and the release job needs the generic package
  registry enabled on the project.
- **The baseline `implement` names codex.** Its two parallel reviewers are
  `claude/sonnet` and `codex/gpt-5-codex`, which is the multi-harness review the spec
  asks for, but a teammate without codex gets a failing step with a clear error. The
  fix is a one-line fork; the README says so. If codex is not actually standard on the
  team, mk should decide whether the baseline should be single-harness instead — that
  is a team call, not mine.
- **`opencode --model` is unverified.** It is in the adapter table because the goal
  named it. claude's flags were verified live; codex's `-m` and opencode's `--model`
  were not (neither is installed in a usable state here).
- **The plugin version is still `0.0.1`.** `install.sh` derives the release URL from
  it, so the first tag must match whatever the manifest says.
- **Model lists will age.** `src/harness.ts` carries alias lists and patterns so an
  unknown model fails before any tab opens. That is the spec's requirement, but it
  means a new model alias needs either a `config.json` entry or a code change.
- **Findings are unioned, never reconciled.** v1 by design (spec, out of scope); two
  reviewers disagreeing both reach the implementer.
