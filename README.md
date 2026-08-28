# herdr-plugin

Codified agent workflows for herdr: `plan`, `implement`, `review`, `architecture` — deterministic multi-tab orchestrations you pick from a popup.
A shared starting point, not a restriction: fork any workflow or persona into your own layer.

## Install

One command, safe to re-run:

```sh
git clone git@gitlab.cego.dk:cego/herdr-plugin.git ~/.herdr-plugin && ~/.herdr-plugin/setup.sh
```

`setup.sh` links the plugin (`herdr plugin link`, which runs `install.sh` to fetch the
prebuilt runner — no bun needed; with bun present it builds from source instead), adds
the three keybindings below to `~/.config/herdr/config.toml` if they are missing, and
reloads the running herdr. Run it again after a `git pull` to pick up changes; from a
non-checkout location it clones/updates `~/.herdr-plugin` itself (`HERDR_PLUGIN_DIR`,
`HERDR_PLUGIN_REPO` and `HERDR_CONFIG` override the defaults).

Keys it adds (`prefix` is `ctrl+b` by default; edit them in `config.toml` afterwards).
Plain letters on purpose: `alt` chords after the prefix are not delivered reliably over
SSH or through some terminals, and herdr's own config notes the same.

| Key | Action |
| --- | --- |
| `prefix+f` | `cego.workflows.pick` — run a workflow |
| `prefix+u` | `cego.workflows.resume` — resume a run with unfinished steps |
| `prefix+shift+f` | `cego.workflows.fork` — copy a workflow or persona into your layer |

They show up in herdr's keybind help (`prefix+?`). Without a binding, any action still
runs from a shell inside herdr: `herdr plugin action invoke cego.workflows.pick`.

## Using it

1. Focus a pane in the workspace of the repo you want to work on and press `prefix+f`.
2. Pick a workflow in the popup (type to filter, Enter).
3. Inputs are inferred from the branch, open MR and earlier runs; you are asked only
   for what could not be inferred, and shown one confirm line.
4. A `runner` tab opens as the status pane; each step gets its own tab, marked
   `✓`/`⚠`/`✗` as it finishes. A toast tells you when a run is done or needs you.
5. `plan` and `architecture` end in a menu; "Implement now" chains straight into
   `implement`. `prefix+u` picks up any run with unfinished steps.

## Workflows

| Workflow | What it does |
| --- | --- |
| `plan` | Grills you, writes `SPEC.md` and tickets into the run dir, then a menu: implement now, second opinion, offload to Linear, refine |
| `implement` | Builds a plan dir, a Linear issue or a description on a branch (commit per ticket), improves the architecture it touched, simplifies, reviews with two models, loops on findings up to five times |
| `review` | Reviews an MR, a branch diff or the working tree with two models and writes one verdict each |
| `architecture` | Runs the architect over the project, reports into the run dir, then a menu: implement now or stop |

`plan` and `architecture` can chain `implement`, which embeds `review` and the
unattended half of `architecture`. Any of them is a fork away from being yours.

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
  "models": { "opencode": ["mycorp/local-model"] },
  "trust": "ask"
}
```

`models` adds models the harness adapter table does not already accept. `effort` is
optional — leave it out and each harness uses its own default. An unknown harness,
model or effort fails validation before a single tab opens. `trust` is what a run does
about a directory the harness has not been trusted with: see "The first run in a repo".

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
  plan: work-source        # goal | plan-dir | work-source | diff-target | ticket | flag
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
      from: review         # the gate: loop while that step reports findings
      back_to: simplify    # where the next round starts (default: from)
---
Text before the first heading is prepended to every step's prompt.

## build

One `## <step-id>` section per step. Templates: `{{inputs.<name>}}`,
`{{outputs.<step>}}`, `{{findings}}`, `{{iteration}}`, `{{max_iterations}}`,
`{{cwd}}`, `{{run.dir}}`, `{{config.<key>}}`, `{{output_path}}`, `{{harness}}`,
`{{model}}`, `{{effort}}`.
```

### Choices

A step with `choices:` asks you instead of running an agent:

```yaml
  - id: next
    choices:
      - title: Implement now        # chain: a child run of another workflow
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
      - title: Second opinion       # one agent round, then the menu again
        prompt: second-opinion      # sends the "## second-opinion" section
        persona: reviewer
        model: opus
        effort: xhigh
        fresh: true
        output: opinion.json
        max: 2                      # how often this choice may be taken
        follow_up:                  # only when that round reported findings
          agent: grill
          prompt: revise
          output: revise.json
      - title: Stop here
        stop: true
```

Each choice needs a `title` and exactly one of `run`, `prompt` or `stop`. A `prompt`
choice offers the menu again as soon as its round has written its Output, so `Refine`
can be taken as often as you like; `run` and `stop` end the step. `run` starts that
workflow as a child run in the same workspace — forwarded inputs first, the rest
inferred, anything left over asked here — and the parent finishes once the child has
its own runner pane. `resume` then lists the two runs independently. Esc leaves the step
unfinished, so `resume` finds the run again. `config: {key, question}` asks for a value
once and keeps it in `config.json`, where prompts read it as `{{config.<key>}}`.

A step may also set `prompt: <section>` to send a section other than its own id —
that is how one workflow carries an attended and an unattended body.

`skill: <name>` sends the step's prompt as `/<name> …`. Many skills are marked
`disable-model-invocation` — `/grill-with-docs`, `/to-spec`, `/to-tickets`, `/implement`,
`/wayfinder`, `/improve-codebase-architecture` — and an agent that tries to start one is
refused and told to ask you. `agent prompt` is your channel, so a slash command sent that
way runs the skill exactly as if you had typed it. The baseline sets `skill:` on every
step that drives one.

A step is finished when its `output:` file exists, not when the agent goes quiet — an
interviewing agent goes quiet waiting for you. Until the file appears you get one
toast and the runner keeps waiting.

### The first run in a repo

claude asks once per directory whether it may work there, and it asks inside its own tab,
where it is easy to miss. So the runner asks you first, before a single tab opens:

```
claude has not worked in /home/mk/work/some-repo before
❯ Trust it now                  records it where the harness looks
  Let claude ask me in its tab  the run waits for you
```

`Trust it now` writes `hasTrustDialogAccepted` for that directory into `~/.claude.json`,
which is where claude keeps the answer to its own dialog — atomically, leaving every other
project and setting untouched, and with the previous file copied to
`claude.json.bak` in the plugin state dir. Nothing else in the file is read or changed.

It asks once per directory, the first time you run a workflow there. `trust` in
`config.json` answers it in advance: `ask` (default), `auto` (trust it and say so in the
runner), or `never` (leave the dialog to claude).

If you do let claude ask, nothing breaks: `agent start` reports the agent blocked, which is
not a failure, so the runner says which pane wants you, toasts, and waits. It cannot answer
for you — the dialog shuffles its options between runs, so there is no safe key to send.

Outputs are JSON. One carrying a `verdict` is validated against the review schema, so
a loop gate can always read it:

```json
{"verdict": "clean" | "findings",
 "findings": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
               "title": "one line", "detail": "what goes wrong",
               "rebuttal": "why a dispute of this finding does not hold"}],
 "disputed": []}
```

A finding the implementer put in `disputed`, with its reason, is shown to the reviewers
on the next round and stops driving the loop: the two of them cannot settle it, so the
run finishes and you decide, instead of spending rounds re-arguing it. A reviewer who
can answer the reason raises it again with a `rebuttal`, which clears the dispute and
puts the finding back in front of the implementer.

## Runs

Plans are never written into the repository (ADR-0002): `plan` writes `SPEC.md` and
its tickets into `{{run.dir}}/plan`. `plan` ends with a menu: implement now, get a
second opinion, offload to Linear, or refine. Esc there leaves the run open for
`resume`.

`implement` does not need a plan run, though. Its `plan` input is a **work-source**, and
inference gathers what this repo offers: the three newest finished runs that planned it,
and a Linear issue id in the branch name. One candidate is taken as the answer; none or
several bring up a menu of them plus **Type it…**, where a Linear id or URL, a path to a
plan directory, or a plain description of the work are all accepted. What was resolved is
recorded with its kind, and the `build` prompt reads both: `{{inputs.plan}}` and
`{{inputs.plan_kind}}` (`plan-dir` | `linear` | `text`). For `linear` and `text` the
implementer writes the spec and a task list into `{{run.dir}}/plan/` before it builds,
so every run leaves the same audit trail.

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
