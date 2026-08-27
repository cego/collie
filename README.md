# herdr-plugin

Codified agent workflows for herdr: `plan`, `implement`, `review` — deterministic multi-tab orchestrations you pick from a popup.
A shared starting point, not a restriction: fork any workflow or persona into your own layer.

## Install (local link, no GitHub needed)

```sh
git clone git@gitlab.cego.dk:cego/herdr-plugin.git ~/.herdr-plugin
herdr plugin link ~/.herdr-plugin
```

`herdr plugin link` runs `install.sh`, which downloads the prebuilt runner for your
platform from the matching tag's release. You do not need bun. (If bun happens to be
installed — because you are working on the plugin itself — `install.sh` builds from
source when there is no release asset.)

Add a keybinding in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+w"
type = "plugin_action"
command = "cego.workflows.pick"
```

## Actions

| Action | What it does |
| --- | --- |
| `cego.workflows.pick` | Popup picker of workflows; infers inputs, asks for the rest, then runs |
| `cego.workflows.resume` | Popup picker of runs with unfinished steps; finished steps are skipped |
| `cego.workflows.fork` | Copy a workflow or persona into your layer or this project's |

Each action opens a pane, because that is where a terminal is: `picker` (popup) does
the choosing, `runner` (tab) is the run's status pane and drives the run.

## Layers

Definitions are markdown files with YAML frontmatter. Same name in a later layer wins:

1. `workflows/`, `personas/` in this repo (team baseline)
2. `$(herdr plugin config-dir cego.workflows)` (yours)
3. `.herdr/workflows`, `.herdr/personas` in the project you're in

`fork` copies a baseline definition into layer 2 or 3 for editing. `use:` resolves
through the same lookup, so overriding `review.md` changes every workflow that embeds
it — including `implement`.

## Your defaults

`config.json` in your config dir (layer 2), all keys optional:

```json
{
  "harness": "claude",
  "model": "sonnet",
  "effort": "high",
  "max_iterations": 5,
  "handoff_timeout_ms": 7200000,
  "models": { "opencode": ["mycorp/local-model"] }
}
```

`models` adds models the harness adapter table does not already accept. `effort` is
optional — leave it out and each harness uses its own default. An unknown harness,
model or effort fails validation before a single tab opens.

## Harnesses

| Harness | Model flag | Persona | Effort |
| --- | --- | --- | --- |
| `claude` | `--model` | `--append-system-prompt-file` | `--effort low\|medium\|high\|xhigh\|max` |
| `codex` | `-m` | prompt prefix | — |
| `opencode` | `--model <provider/model>` | prompt prefix | — |

The baseline `implement` reviews with two claude reviewers, `opus` and `sonnet`, both
at `xhigh`. Mixing in codex or opencode is a fork away.

## Writing a workflow

```markdown
---
name: implement
title: implement — build from a plan, review in parallel, fix until clean
description: One line for the picker.
inputs:
  plan: plan-dir           # goal | plan-dir | diff-target | ticket | flag
max_iterations: 5
steps:
  - id: build
    persona: implementer
    output: build.json
  - id: review
    use: review            # embeds another workflow by reference
    fresh: true            # start a new agent each iteration
    parallel:
      - { harness: claude, model: opus, effort: xhigh }
      - { harness: claude, model: sonnet, effort: xhigh }
  - id: fix
    agent: build           # keep the implementer's context
    persona: implementer
    output: fix.json
    repeat:
      from: review         # loop back while that step reports findings
---
Text before the first heading is prepended to every step's prompt.

## build

One `## <step-id>` section per step. Templates: `{{inputs.<name>}}`,
`{{outputs.<step>}}`, `{{findings}}`, `{{iteration}}`, `{{max_iterations}}`,
`{{cwd}}`, `{{run.dir}}`, `{{output_path}}`, `{{harness}}`, `{{model}}`,
`{{effort}}`.
```

A step is finished when its `output:` file exists, not when the agent goes quiet — an
interviewing agent goes quiet waiting for you. Until the file appears you get one
toast and the runner keeps waiting.

Outputs are JSON. One carrying a `verdict` is validated against the review schema, so
a loop gate can always read it:

```json
{"verdict": "clean" | "findings",
 "findings": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
               "title": "one line", "detail": "what goes wrong"}],
 "disputed": []}
```

## Runs

Plans are never written into the repository (ADR-0002): `plan` writes `SPEC.md` and
its tickets into `{{run.dir}}/plan`, and `plan-dir` inference hands that directory to
`implement` — the newest finished run that planned this project.

Every run is recorded under the plugin state dir: `runs/<id>/run.json` with the
inputs and where each came from, `steps/<step>[/<variant>]/` with the exact prompt
sent and the Output written, `personas/` with the persona as injected, and `log.txt`.
That is the audit trail and what `resume` reads.

## Working on the plugin

```sh
bun install
bun test
bun run build          # bin/herdr-workflows for this platform
```

See `CONTEXT.md` for the vocabulary and `docs/` for the spec and decisions.
