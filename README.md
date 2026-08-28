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
   for what could not be inferred, and shown one confirm line. Two inputs offer a menu
   instead of a guess: `implement`'s work source, and `review`'s target.
4. The workspace's **`workflows` tab** opens — always the first tab, so `prefix+1`
   lands on it — and the run's own pane joins it underneath the board. That pane is
   where the run reports and where every menu it shows you appears; see "The
   workflows tab" below.
5. The run's own tabs hold agents and nothing else: one tab per step, a step's
   parallel variants side by side in it with an even share each, a step that
   reconciles them (`fan_in:`) underneath them in the same tab, and a step that
   continues an earlier agent opening nothing at all — it renames that pane to
   itself, so `build` becomes `architecture`, then `simplify`, then `fix`. Tabs are
   named `⚙ <workflow> · <target>` and carry the run's state: `⚙` working, `⚠` your
   turn, `✓` done — only once every pane in the tab is — and `✗` stopped. Panes are
   named for what is in them: the model for parallel variants (`opus`, `sonnet`), the
   step's name when it runs alone. A toast tells you when a run is done or needs you.
6. `plan` and `architecture` end in a menu, which takes over the whole pane while it
   is open and hands it back afterwards; "Implement now" chains straight into
   `implement`. `prefix+u` picks up any run with unfinished steps.

## The workflows tab

One tab per workspace, created by the first run and reused by every run after it, and
moved to the front of the workspace each time so it is always `prefix+1`. It is a
board, not an engine: it watches the run dirs and the register of live agents and
draws what it finds, so closing it loses nothing — the next run opens it again.

```
workflows — herdr-plugin
/home/mk/work/cego/herdr-plugin

Agents
  1  implementer working  implement-add-a-picker-20260828-093012

Runs
  ⚙ implement · add-a-picker    fix · iteration 3/5

Finished
  ✓ review · smoke-synth        done

1-9 focus that agent · p run a workflow · u resume · f fork · s send the last review to the implementer · q close this tab
```

Every menu a run asks you about renders in that run's pane in this tab, and the runner
toasts and brings the tab to the front before it asks, so a menu is never left unseen
in a tab you are not looking at.

## Workflows

| Workflow | What it does |
| --- | --- |
| `plan` | Grills you, writes `SPEC.md` and tickets into the run dir, then a menu: implement now, second opinion, offload to Linear, refine |
| `implement` | Builds a plan dir, a Linear issue or a description on a branch (commit per ticket), improves the architecture it touched, simplifies, reviews with two models into one synthesised review, loops on its findings up to five times, then pushes and opens the merge request |
| `review` | Reviews an MR, a branch diff or the working tree with two models, synthesises them into one review, and offers to post it to the merge request |
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
through the same lookup, so overriding `workflows/review.md` changes every workflow that embeds
it — including `implement`.

## Your defaults

`config.json` in your config dir (layer 2), all keys optional:

```json
{
  "harness": "claude",
  "model": "default",
  "effort": "high",
  "max_iterations": 5,
  "handoff_timeout_ms": 7200000,
  "models": { "opencode": ["mycorp/local-model"] },
  "trust": "ask"
}
```

`models` adds models the harness adapter table does not already accept. `model:
"default"` means "pass no model flag" — the harness picks its own, and this plugin
never has to keep a list in step with it. `effort` is optional — leave it out and each
harness uses its own default. An unknown harness, model or effort fails validation
before a single tab opens. `trust` is what a run does
about a directory the harness has not been trusted with: see "The first run in a repo".

## Harnesses

| Harness | Model flag | Persona | Effort |
| --- | --- | --- | --- |
| `claude` | `--model` | `--append-system-prompt-file` | `--effort low\|medium\|high\|xhigh\|max` |
| `codex` | `-m` | prompt prefix | — |
| `opencode` | `--model <provider/model>` | prompt prefix | — |

`model: default` is accepted by every harness and means the model flag is left off
entirely, so the harness starts on whatever it would start on by itself. A pane for such
a variant is named after the harness (`claude`) rather than a model.

The baseline `implement` builds on `model: default` at `effort: medium` — one implementer
agent for `build`, `architecture`, `simplify`, `fix` and `mr` — and reviews with two
claude reviewers, `opus` and `sonnet`, both at `xhigh`; the synthesiser takes the
implementer's setting because it names none of its own. Mixing in codex or opencode is a
fork away.

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
  - id: synthesize
    persona: reviewer
    fan_in: review         # reconciles that step's parallel Outputs into one
    output: synthesized.json
  - id: fix
    agent: build           # keep the implementer's context
    persona: implementer
    output: fix.json
    repeat:
      from: synthesize     # the gate: loop while that step reports findings
      back_to: simplify    # where the next round starts (default: from)
---
Text before the first heading is prepended to every step's prompt.

## build

One `## <step-id>` section per step. Templates: `{{inputs.<name>}}`,
`{{outputs.<step>}}`, `{{findings}}`, `{{fan_in}}`, `{{iteration}}`,
`{{max_iterations}}`, `{{cwd}}`, `{{run.dir}}`, `{{config.<key>}}`, `{{output_path}}`,
`{{harness}}`, `{{model}}`, `{{effort}}`.
```

A step may also declare `requires:` — one name or a list of them. `gitlab` means glab
and a GitLab remote; `mr-target` means this run is pointed at a merge request. A
requirement this machine or this run cannot meet is a skip with a note that names the
gap, never a failed run.

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
      - title: Post to MR           # the engine sends review.md as one glab mr note
        post: true
      - title: Stop here
        stop: true
```

Each choice needs a `title` and exactly one of `run`, `prompt`, `post` or `stop`. A
`prompt` choice offers the menu again as soon as its round has written its Output, so
`Refine` can be taken as often as you like; `run`, `post` and `stop` end the step. A
`post` choice sends this run's `review.md` to the merge request it reviewed, verbatim
and as a single note — the engine runs `glab mr note`, so what you read in the run's pane is
exactly what lands on the MR. A note that will not send re-offers the menu. `run` starts that
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
which is where claude keeps the answer to its own dialog. The previous file is copied to
`claude.json.bak` in the plugin state dir first, every other project and setting is carried
over as it was, and the new file is renamed into place with the old one's permissions, so no
reader ever sees it half-written. It is still a read-modify-write of a file claude owns: if
a claude session saves in the same instant, that save is the one that loses. Once per
directory, so the window is opened once.

It asks the first time you run a workflow in a directory. `trust` in `config.json` answers
it in advance: `ask` (default), `auto`, or `never` (leave the dialog to claude).

`auto` trusts every directory a run starts in, without asking. Be deliberate about it:
claude's question is "is this a project you created or one you trust?", and it says plainly
that claude will then read, edit and execute files there — it is not bookkeeping about where
claude has been. `auto` is for a machine where every repo you run workflows in is already
one you would answer yes for.

If you do let claude ask, nothing breaks: `agent start` reports the agent blocked, which is
not a failure, so the runner says which pane wants you, toasts, and waits. It cannot answer
for you — the dialog shuffles its options between runs, so there is no safe key to send.

### Fan-in, and the one review that comes out

Two reviewers produce two `review.json` files. A step with `fan_in: <that step>` is
handed their paths as `{{fan_in}}`, opens in their tab, and writes the one review the
change gets: findings deduplicated across models, disagreements settled against the diff,
and anything it cannot defend from the diff itself listed under `dropped` with a reason —
nothing is dropped silently. Its Output is a review plus `summary` and `dropped`:

```json
{"verdict": "findings",
 "summary": "Two sentences: what the change does, and what is wrong with it.",
 "findings": [{"file": "cli.js", "line": 4, "severity": "blocker",
               "title": "Exits 1 on success", "detail": "A caller cannot tell it worked."}],
 "dropped": [{"file": "pkg.json", "severity": "minor", "title": "no engines field",
              "reason": "one reviewer only, and the diff does not support it"}]}
```

The engine renders that to `review.md` in the run dir — the summary, then the findings
under their severity, and nothing about the process or the models — and prints it in the
run's own pane. That file is what a `post` choice sends to the merge request, and inside
`implement` it is what the fix step is given: one reconciled review per round, never the
reviewers' raw union.

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
sent and the Output written, `personas/` with the persona as injected, `review.md`
where the run produced one, and `log.txt`.
That is the audit trail and what `resume` reads.

## Working on the plugin

```sh
bun install
bun test
bun run build          # bin/herdr-workflows for this platform
```

See `CONTEXT.md` for the vocabulary and `docs/` for the spec and decisions.
