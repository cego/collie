# Collie

Codified agent workflows for herdr: `plan`, `implement`, `review`, `architecture` — deterministic multi-tab orchestrations you pick from a popup.
A shared starting point, not a restriction: fork any workflow or persona into your own layer.

## Install

One command, safe to re-run:

```sh
git clone git@gitlab.cego.dk:mk/collie.git ~/.collie && ~/.collie/setup.sh
```

`setup.sh` links Collie (`herdr plugin link`, which runs `install.sh` to fetch the
prebuilt runner — no bun needed; with bun present it builds from source instead), adds
the three keybindings below to `~/.config/herdr/config.toml` if they are missing, and
reloads the running herdr. Run it again after a `git pull` to pick up changes; from a
non-checkout location it clones/updates `~/.collie` itself (`COLLIE_DIR`,
`COLLIE_REPO` and `HERDR_CONFIG` override the defaults). It also links
`~/.local/bin/collie` without changing PATH.

Keys it adds (`prefix` is `ctrl+b` by default; edit them in `config.toml` afterwards).
Plain letters on purpose: `alt` chords after the prefix are not delivered reliably over
SSH or through some terminals, and herdr's own config notes the same.

| Key | Action |
| --- | --- |
| `prefix+f` | `cego.collie.pick` — run a workflow |
| `prefix+u` | `cego.collie.resume` — resume a run with unfinished steps |
| `prefix+shift+f` | `cego.collie.fork` — copy a workflow or persona into your layer |

They show up in herdr's keybind help (`prefix+?`). Without a binding, any action still
runs from a shell inside herdr: `herdr plugin action invoke cego.collie.pick`.

## Command line

The same operations are available without opening UI:

```sh
collie workflow list
collie workflow show plan
collie persona list
collie --workspace <id> run start plan --input goal="ship it"
collie run list
collie run show <run-id>
collie run wait <run-id> --follow
collie run answer <run-id> <answer>
collie run stop <run-id>
collie run resume <run-id>
```

Put `--workspace <id>` and `--json` before the command. Mutations accept
`--request-id`; retrying it returns the original result without repeating the effect.

## Using it

1. Focus a pane in the workspace of the repo you want to work on and press `prefix+f`.
2. Pick a workflow in the popup (type to filter, Enter).
3. Inputs are inferred from the branch, open MR and earlier runs; you are asked only
   for what could not be inferred, and shown one confirm line. Two inputs offer a menu
   instead of a guess: `implement`'s work source, and `review`'s target.
4. The workspace's **Control Plane** tab opens, and it is always the workspace's *first*
   tab, so `prefix+1` lands on it — the first run creates it, every run after it reuses
   it and puts it back at the front. It is the **only pane Collie keeps open**: the
   run itself is driven by a background process with no pane at all, which reports into
   its run directory. The board lists the live agents this session has, the runs going on
   now with the step and iteration each is at and the last thing each said, and the runs
   that have finished with their outcome. **Every question a run asks appears there**,
   under the run asking it — the driver toasts and jumps you to the tab first, so a
   question is never left unseen. Deleting the tab is harmless: it drives nothing and
   remembers nothing, and the next run opens it again. See "The Control Plane" below.
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

## The Control Plane

One tab per workspace, created by the first run and reused by every run after it, and
moved to the front of the workspace each time so it is always `prefix+1`. It is a
board, not an engine: it watches the run dirs and the register of live agents and
draws what it finds, so closing it loses nothing — the next run opens it again.

```
Control Plane — Collie
/home/mk/work/cego/collie

Agents
  1  Implementer           working  implement-add-a-picker-20260828-093012
  2  Review · Opus         idle     review-2367-20260828-112336
  3  Review · gpt-5.6-sol  done     review-2367-20260828-112336

Runs
  ⚙ Implement · add-a-picker    fix · iteration 3/5

Finished
  ✓ Review · !2367              done
  ⚠ Review · worktree           abandoned

1-9 focus that agent · p run a workflow · u resume · f fork · s send the last review to the implementer · q close this tab
```

**Agents** is every agent of this session's runs that herdr still has — reviewers and
synthesisers as well as the implementer and the planner. The ones a hand-off can name
are called by their role and come first; the rest are called by their step and model.
A role is a label, not a filter.

**Runs** is what is going on now. A run whose runner died — no agent of its own left and
nothing written for a minute — moves to **Finished** as `⚠ abandoned` rather than sitting
there pretending to work.

`p`, `u` and `f` open the same picker the keybindings do, in this tab and for this
workspace's repo; `1`–`9` focus that agent's pane; `s` hands the newest review in this
session to a live implementer; `l` opens a run's `runner.log` in a temporary pane; `k`
stops the newest run — closing a pane no longer does that, because the run has none; `q`
closes the tab. Keys are offered only when there is something to act on.

When a run asks you something, its options appear indented under its row and the keys
become that question's — `↑↓`, Enter, Esc, or just type where it wants text. The question
lives in the run's directory, so closing this tab, reopening it, or resuming later shows
you the same question again rather than losing it.

The board shows this session's work and nothing else: one herdr session, one workspace,
one repo. Another workspace's runs never appear, even for the same repo, and a workspace
id that herdr has since given to a different workspace is caught by its label.

Every menu a run asks you about renders in that run's pane in this tab, and the runner
toasts and brings the tab to the front before it asks, so a menu is never left unseen
in a tab you are not looking at.

## Workflows

| Workflow | What it does |
| --- | --- |
| `plan` | Grills you, writes `SPEC.md` and tickets into the run dir, then a menu: implement now, second opinion, offload to Linear, refine |
| `implement` | Builds a plan dir, a Linear issue or a description on a branch (commit per ticket), improves the architecture it touched, simplifies, reviews with two models into one synthesised review, loops on its findings up to five times, then pushes and opens the merge request |
| `review` | Reviews an MR (anyone's, from any directory), a branch diff or the working tree with two models, synthesises them into one review, and offers to post it to the merge request |
| `architecture` | Runs the architect over the project, reports into the run dir, then a menu: implement now or stop |

`plan` and `architecture` can chain `implement`, which embeds `review` and the
unattended half of `architecture`. Any of them is a fork away from being yours.

## Actions

| Action | What it does |
| --- | --- |
| `cego.collie.pick` | Popup picker of workflows; infers inputs, asks for the rest, then runs |
| `cego.collie.resume` | Popup picker of runs with unfinished steps; finished steps are skipped |
| `cego.collie.fork` | Copy a workflow or persona into your layer or this project's |

Each action opens the `picker` popup, because that is where a terminal is. The run itself
is not a pane: the picker starts a detached `drive` process that outlives it and writes
what it is doing into the run directory (`progress.jsonl`, `runner.log`), and the Control
Plane is what renders that. A run therefore survives the picker closing, the Control Plane
closing, and the terminal being detached; the driver claims the run atomically, so
`resume` refuses to start a second driver for a run something is already driving.

## Layers

Definitions are markdown files with YAML frontmatter. Same name in a later layer wins:

1. `workflows/`, `personas/` in this repo (team baseline)
2. `$(herdr plugin config-dir cego.collie)` (yours)
3. `.herdr/workflows`, `.herdr/personas` in the project you're in

`use:` resolves through the same lookup, so overriding `workflows/review.md` changes every
workflow that embeds it — including `implement`.

### `extends:` — change one part, follow the rest

A file that declares `extends: <name>` is not a replacement: it is the definition below it
with your changes laid over. Steps match by `id`, inputs merge by name, scalars you name
win, and each `## <section>` you write replaces that section of the parent. Everything you
leave out keeps following the original, so a baseline improvement reaches your fork.

The canonical use — two different reviewers, and nothing else changed:

```markdown
---
name: review
extends: review
steps:
  - id: review
    parallel:
      - { harness: claude, model: opus, effort: medium }
      - { harness: pi, model: openai-codex/gpt-5.6-sol, effort: medium }
---
```

Nine lines instead of ninety. The target input, the synthesis step, the end menu and every
prompt body are still the baseline's.

`parallel:` and `choices:` are lists a human reasons about whole, so naming either replaces
it rather than merging entries. A child step with an id the parent does not have is new work,
appended after the parent's steps. An unknown parent, or a cycle, is a validation error
naming the file.

`fork` writes one of these stubs by default — it asks which step you are changing and copies
that step's prompt in so there is something to edit. **A full copy** is the other option: it
stops following the original and records `forked_from_hash`, so when the baseline moves on
the picker marks it `(stale — the original has changed since this copy)`.

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
"default"` means "pass no model flag" — the harness picks its own, and Collie
never has to keep a list in step with it. `effort` is optional — leave it out and each
harness uses its own default. An unknown harness, model or effort fails validation
before a single tab opens. `trust` is what a run does
about a directory the harness has not been trusted with: see "The first run in a repo".

## Skills

Workflows and personas name the skills they drive, and the harness decides how to ask:

| Harness | `{{skill:code-review}}` renders as |
| --- | --- |
| `claude` | `/code-review` |
| `pi` | `/skill:code-review` |
| `codex`, `opencode` | `the "code-review" skill` — they surface skills by description, so a slash would just be text |

The skills themselves are shared: one set in `~/.agents/skills`, installed by `skills.sh`
(`npx skills add <name>`), and every harness reads the same files. So a definition never
spells a slash command — write `{{skill:name}}` and the same body works on every harness,
including the `skill:` key a step uses to drive one.

They are a **prerequisite, like the harness binary**. A workflow that names a skill you have
not installed fails validation before a tab opens, naming the skill and the command that
installs it:

```
implement step "build": the skill "implement" is not installed — run `npx skills add implement`
```

`.agents/skills` in the project you are in is checked first, then `~/.agents/skills`. Each
persona still ends with a fallback paragraph for a harness where the skill is missing at
runtime rather than at validation.

## Harnesses

| Harness | Model flag | Persona | Effort |
| --- | --- | --- | --- |
| `claude` | `--model` | `--append-system-prompt-file` | `--effort low\|medium\|high\|xhigh\|max` |
| `codex` | `-m` | prompt prefix | — |
| `pi` | `--model <provider/model>` | `--append-system-prompt` (reads the persona file's path) | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `opencode` | `--model <provider/model>` | prompt prefix | — |

`model: default` is accepted by every harness and means the model flag is left off
entirely, so the harness starts on whatever it would start on by itself. A pane for such
a variant is named after the harness (`claude`) rather than a model.

The baseline `implement` builds on `model: default` at `effort: medium` — one implementer
agent for `build`, `architecture`, `simplify`, `fix` and `mr` — and reviews with two
claude reviewers, `opus` at `medium` and `sonnet` at `xhigh`; the synthesiser takes the
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
      - { harness: claude, model: opus, effort: medium }
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
`claude.json.bak` in Collie state dir first, every other project and setting is carried
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

## Hand-offs between runs

Runs in the same **session** — one herdr session, one workspace, one repo — know about each
other's long-lived agents, and hand work over rather than starting a second one. There is
only ever one implementer and one planner per session.

**A review, to whoever can act on it.** After the synthesis, a standalone review's menu
offers exactly one of these, never both:

- **Send to implementer** — when an implementer is already working here. It is the first
  option, so Enter takes it: that agent is prompted with `review.md` and the findings JSON
  and applies them as a fix round, `disputed` and all. Both runs record the hand-off.
- **Fix findings** — when none is. It chains `implement` with the review itself as the work
  source: `review.md` is the spec, the findings are the tickets, and the implementer works
  **where the review was pointed** — checking out the branch, or `glab mr checkout` for a
  merge request, so the fixes land on that MR's own branch and its `mr` step updates that
  merge request instead of opening a second one.

**A plan that changes under an implementer.** The planner keeps its tab after its run ends.
If you Refine the plan, take a second opinion, or just talk to the planner, and an
implementer is building from that plan, the runner sends it the diff of `plan/` and the
planner's own `changelog` — once per change — and asks it to reconcile: finish what is
unaffected, adjust what is, and flag what now conflicts.

**A decision the plan does not cover.** The implementer's prompt names the live planner's
agent and pane and tells it to ask there (`herdr agent prompt …`, then `herdr agent read …`)
rather than stopping. With no planner live, the same prompt tells it to stop and ask you.

## Reviewing someone else's merge request

An MR target carries its project, not just its iid:
`mr:<host>/<group>/<project>!<iid>`. Paste an MR URL and the project comes from the URL; type
a bare `!42` and it comes from the remote of the directory you are in. Every `glab` call the
runner makes — and every command the review prompt hands the reviewers — then passes
`--repo <host>/<group>/<project>`, so **no checkout of that project is needed**: you can
review and comment on a colleague's MR from a group folder that is not a git repository at
all. The tab still reads `⚙ Review`, and the board row still says `!42`.

What a step pointed at a merge request needs is glab and `glab auth status --hostname
<host>` for that host; the "does this directory have a GitLab remote" check stays where it
belongs, on `implement`'s `mr` step, which is the one that pushes. In a directory that is
not a checkout there is no branch and no working tree to review, so the target menu is one
entry — **Type it…**.

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

Every run is recorded under Collie state dir: `runs/<id>/run.json` with the
inputs and where each came from, `steps/<step>[/<variant>]/` with the exact prompt
sent and the Output written, `personas/` with the persona as injected, `review.md`
where the run produced one, and `log.txt`.
That is the audit trail and what `resume` reads.

## Working on Collie

**Bun 1.4 or newer** (`engines` in `package.json`, `.mise.toml`, and the CI image all say
so). The runner is compiled by bun and the tests are `bun:test`, so the version is a
prerequisite rather than a preference.

```sh
bun install
bun test
bun run typecheck      # the same TypeScript gate CI runs
bun run build          # bin/collie for this platform
```

`bun run build` compiles beside the binary and renames over it, because replacing a
running runner's own file kills the process executing it.

See `CONTEXT.md` for the vocabulary and `docs/` for the spec and decisions.
