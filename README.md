# herdr-plugin

Codified agent workflows for herdr: `plan`, `ticket`, `implement`, `review`, `architecture` — deterministic multi-tab orchestrations you pick from a popup.
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

## Workflows

| Workflow | What it does |
| --- | --- |
| `plan` | Grills you, writes `SPEC.md` and tickets into the run dir, then a menu: implement now, second opinion, offload to Linear, refine |
| `ticket` | `plan`, with a Linear issue id or URL as the goal |
| `implement` | Builds the plan on a branch (commit per ticket), improves the architecture it touched, simplifies, reviews with two models, loops on findings up to five times |
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
  plan: plan-dir           # goal | plan-dir | diff-target | ticket | issue | flag
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

To do it in advance, for as many repos as you like:

```sh
bin/herdr-workflows trust ~/work/repo-a ~/work/repo-b   # no argument: the current directory
```

`trust` in `config.json` decides what a run does when it meets an untrusted directory:
`ask` (default), `auto` (trust it and say so), or `never` (leave it to claude).

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
its tickets into `{{run.dir}}/plan`, and `plan-dir` inference hands that directory to
`implement` — the newest finished run that planned this project. `plan` ends with a menu:
implement now, get a second opinion, offload to Linear, or refine. Esc there leaves the
run open for `resume`.

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
