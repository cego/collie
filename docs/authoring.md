# Authoring workflows and personas

Every workflow and persona Collie ships is a starting point, not a restriction. This page
is the reference for changing them: where definitions live, how a fork follows or leaves
its parent, and every key a definition file accepts.

A definition is one markdown file: YAML frontmatter, then a body of prompt sections. For
what a Workflow, Step, Persona, Layer or Override _is_, see [`CONTEXT.md`](../CONTEXT.md).

## Layers and lookup order

Definitions come from three directories. The same name in a later layer wins:

1. `workflows/`, `personas/` in the Collie repo — the team baseline.
2. `$(herdr plugin config-dir cego.collie)/workflows`, `…/personas` — yours.
3. `.herdr/workflows`, `.herdr/personas` in the project you're in.

`use:` resolves through the same lookup, so overriding `workflows/review.md` in your layer
changes every workflow that embeds it — including `implement`.

`collie workflow list` prints the layer each definition came from, and
`collie workflow check` validates every layer without starting a run.

## Forking

`prefix+shift+f`, the Control Plane's `f` key, and `collie workflow fork` /
`collie persona fork` all do the same thing: copy a baseline definition into your layer
(`--layer user`) or the project's (`--layer project`).

There are two modes:

- **`extends` (the default)** writes a small stub that declares `extends: <name>` and
  changes only what it names. Everything you leave out keeps following the parent, so a
  baseline improvement reaches your fork. The fork asks which step you are changing and
  copies that step's prompt in, so there is something to edit; `--step <id>` says which up
  front.
- **`copy`** takes the whole definition and stops following the original. It records
  `forked_from_hash` — the parent's content hash at the moment of the copy. When the
  baseline moves on, that hash no longer matches, and the picker marks the fork
  `(stale — the original has changed since this copy)`. A stale fork still works; the mark
  tells you a baseline change has passed it by.

`--name` gives the fork a different name, which wins over the one it forked from, so you
can keep both.

## `extends:` merge semantics

A file that declares `extends: <name>` is the definition below it with your changes laid
over. The rules, exactly:

| What           | How it merges                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Steps          | Matched by `id`. A child step's keys are laid over the parent step's; keys you leave out stay.   |
| New steps      | A child step with an id the parent does not have is new work, appended after the parent's steps. |
| `inputs:`      | Merged by name; a name in both takes the child's strategy.                                       |
| Scalars        | `title:`, `description:`, `max_iterations:` — the child's wins where it names one.               |
| `parallel:`    | Replaced whole, never merged entry by entry.                                                     |
| `choices:`     | Replaced whole, never merged entry by entry.                                                     |
| `## <section>` | A child section replaces the parent's of the same name; new ones are appended.                   |
| Body preamble  | Replaced only when the child has one.                                                            |

`parallel:` and `choices:` are lists you reason about whole, which is why naming either
replaces it. An unknown parent, or a cycle, is a validation error naming the file.

## Workflow frontmatter

| Key                | Type   | What it does                                                                    |
| ------------------ | ------ | ------------------------------------------------------------------------------- |
| `name`             | string | How the workflow is referred to. Defaults to the filename.                      |
| `title`            | string | One line for the picker's list. Defaults to `name`.                             |
| `description`      | string | One paragraph for the picker's detail pane.                                     |
| `inputs`           | map    | `name: strategy` — see [Input strategies](#input-strategies).                   |
| `max_iterations`   | number | How many times a `repeat:` loop may go round. Falls back to your `config.json`. |
| `steps`            | list   | The steps, in order — see [Step keys](#step-keys).                              |
| `extends`          | string | Follow this definition and change only what this file names.                    |
| `forked_from_hash` | string | Written by a `copy` fork; how a stale copy is spotted. Do not write it by hand. |

### Input strategies

An input's strategy is how Collie tries to fill it before asking you.

| Strategy      | What it means                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`        | Free text describing what you want. Always asked.                                                                                                                    |
| `plan-dir`    | A path to a plan directory. Inferred from the newest finished plan run for this repo; asked when there is none.                                                      |
| `work-source` | A plan directory, a Linear issue, a review to fix, or a description. Offers a menu, and records `<name>_kind` alongside it (`plan-dir`, `linear`, `review`, `text`). |
| `diff-target` | A merge request, a branch diff or the working tree. Offers a menu, and records `<name>_kind`.                                                                        |
| `ticket`      | A Linear issue id, inferred from the branch name. Left empty when there is none; never asked.                                                                        |
| `flag`        | A boolean. Defaults to `false` and is never asked; something forwarding it sets it.                                                                                  |
| `optional`    | Left empty unless something forwards it. Never asked.                                                                                                                |

`implement`'s `repo` is an `optional` input the engine forwards itself: fanning a plan that
spans repositories out gives each child run the repository it owns, and every other run
leaves it empty. A workflow of your own that wants one repository's share of a plan
declares it the same way and reads `{{inputs.repo}}`; see
[Plans that span repositories](workflows.md#plans-that-span-repositories).

## Step keys

| Key           | Type           | What it does                                                                                         |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `id`          | string         | The step's name, and the `## <id>` body section it sends. Required in practice.                      |
| `persona`     | string         | The persona injected when its agent starts.                                                          |
| `harness`     | string         | Which agent CLI. Falls back to your `config.json`.                                                   |
| `model`       | string         | Which model. `default` uses the harness adapter's pinned default.                                    |
| `effort`      | string         | Reasoning effort, where the harness takes one.                                                       |
| `permissions` | string         | `bypass` or `harness` — who answers this step's tool-call prompts. Falls back to your `config.json`. |
| `fresh`       | boolean        | Start a new agent each iteration instead of reusing the last one.                                    |
| `output`      | string         | The JSON file this step must write. The step is finished when the file exists.                       |
| `agent`       | string         | Continue the agent an earlier step started, keeping its context, instead of starting one.            |
| `skill`       | string         | Send the prompt as `/<skill> …` — see [Skills](#skills).                                             |
| `use`         | string         | Embed another workflow's steps here by reference.                                                    |
| `parallel`    | list           | Run this step once per entry, side by side. Each entry is `{harness, model, effort, permissions}`.   |
| `prompt`      | string         | Send a body section other than the step's own id.                                                    |
| `standalone`  | boolean        | Run only when this workflow is the one being run, not when it is embedded.                           |
| `requires`    | string or list | What the environment must provide — see [Requirements](#requirements).                               |
| `fan_in`      | string         | Reconcile that earlier step's parallel outputs into one — see [Fan-in](#fan-in).                     |
| `choices`     | list           | Ask instead of running an agent — see [Choice steps](#choice-steps).                                 |
| `repeat`      | map            | `{from, back_to, max}` — the fix loop; see [Loops](#loops).                                          |

### Requirements

`requires:` takes one name or a list of them:

- `mr-target` — this run is pointed at a merge request.
- `gitlab` — `glab` can do the work this step needs. Alongside `mr-target` that means
  `glab` is authenticated for the target merge request's own host, so a review needs no
  checkout of that project; on its own it means this directory is a checkout with a GitLab
  remote, which is what a step that pushes needs.

A requirement this machine or this run cannot meet is a skip with a note naming the gap,
never a failed run.

### Fan-in

A step with `fan_in: <step>` is handed the paths of that step's parallel outputs as
`{{fan_in}}`, opens in that step's tab, and writes the one output the group produces. The
engine does not union anything: reconciling is the step's job. Over reviewers this is what
produces `review.md` — see [Outputs](#outputs).

### Loops

```yaml
- id: fix
  agent: build
  persona: implementer
  output: fix.json
  repeat:
    from: review.synthesize # the gate: loop while that step reports findings
    back_to: simplify # where the next round starts (default: from)
    max: 5 # falls back to the workflow's max_iterations
```

The gate is read from the named step's output `verdict`, never from terminal text. A
finding the implementer marked `disputed`, with its reason, stops driving the loop: the two
sides cannot settle it, so the run finishes and you decide. A reviewer who can answer the
reason raises it again with a `rebuttal`, which clears the dispute and puts the finding back
in front of the implementer.

Note the step id: a step embedded with `use:` is addressed as `<embedding step>.<its id>`.

## Choice steps

A step with `choices:` asks you instead of running an agent:

```yaml
- id: next
  choices:
    - title: Implement now # chain: a child run of another workflow
      run: implement
      inputs:
        plan: "{{run.dir}}/plan"
    - title: Second opinion # one agent round, then the menu again
      prompt: second-opinion # sends the "## second-opinion" section
      persona: reviewer
      model: opus
      effort: xhigh
      fresh: true
      output: opinion.json
      max: 2 # how often this choice may be taken
      follow_up: # only when that round reported findings
        agent: grill
        prompt: revise
        output: revise.json
    - title: Post to MR
      post: true
      requires: [mr-target, gitlab]
    - title: Stop here
      stop: true
```

Each choice needs a `title` and exactly one of `run`, `prompt`, `post`, `handoff` or
`stop`.

| Key         | Type           | What it does                                                                                       |
| ----------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `title`     | string         | What the menu shows, and what `run answer` and `--decide` name.                                    |
| `run`       | string         | Chain that workflow as a child run in the same workspace.                                          |
| `prompt`    | string         | Run one agent round on that body section, then offer the menu again.                               |
| `post`      | true           | Send this run's `review.md` to the merge request it reviewed, as one `glab mr note`.               |
| `handoff`   | string         | Give this run's result to the session's live agent for that role.                                  |
| `stop`      | true           | End the step.                                                                                      |
| `unless`    | string         | Offer this only when no agent for that role is live in this session.                               |
| `requires`  | string or list | What the environment must provide for this choice to be offered at all.                            |
| `inputs`    | map            | Inputs forwarded to a chained workflow. Values are templated.                                      |
| `max`       | number         | How often this choice may be taken in one run.                                                     |
| `config`    | map            | `{key, question}` — ask for a value once, keep it in `config.json`, read it as `{{config.<key>}}`. |
| `follow_up` | map            | A second round, run only when the first reported findings. Same keys as a round.                   |

A `prompt` choice is a **round**, and takes the round keys inline: `prompt` (the section),
`agent`, `persona`, `harness`, `model`, `effort`, `permissions`, `fresh`, `skill` and
`output`. `follow_up` takes the same set.

`run`, `post`, `stop` and `handoff` end the step; a `prompt` choice offers the menu again
as soon as its round has written its output, so a **Refine** choice can be taken as often
as you like. A note that will not send re-offers the menu. Esc leaves the step unfinished,
so `resume` finds the run again.

Titles name decisions, so two choices that can never both be offered — a `handoff` and its
`unless:` twin — may share one title. A choice with one thing left to offer is taken rather
than asked.

Every Choice is asked when the run reaches it, with the work it decides about in front of
you; launching a workflow asks its Inputs and nothing else.
[`run start --decide <step>=<title>`](cli.md#start-a-run) is the one way to pre-answer one,
for a run nobody will be there for.

## Body and template substitution

Text before the first heading is prepended to every step's prompt. Each `## <step-id>`
section is that step's prompt.

`{{a.b}}` substitutes a value. An unknown key renders empty and is recorded in the run's
log, so a typo is visible rather than silent.

| Placeholder                                                                | What it renders                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `{{inputs.<name>}}`                                                        | An input's value; `{{inputs.<name>_kind}}` for a work-source or diff-target.    |
| `{{outputs.<step>}}`                                                       | That step's output JSON — a list where the step ran in parallel.                |
| `{{findings}}`                                                             | The findings this step is meant to act on, formatted.                           |
| `{{disputed}}`                                                             | The findings the implementer disputed, with their reasons.                      |
| `{{fan_in}}`                                                               | The paths of the outputs a `fan_in:` step reconciles.                           |
| `{{previous.review}}`, `{{previous.when}}`, `{{previous.run}}`             | The last review of this target.                                                 |
| `{{run.dir}}`, `{{run.id}}`, `{{run.slug}}`                                | The run directory and its identifiers.                                          |
| `{{output_path}}`                                                          | Where this step must write its output.                                          |
| `{{iteration}}`, `{{max_iterations}}`                                      | Where the loop is, and how far it may go.                                       |
| `{{cwd}}`                                                                  | The directory the run is rooted at.                                             |
| `{{step}}`                                                                 | This step's id.                                                                 |
| `{{harness}}`, `{{model}}`, `{{effort}}`                                   | What this variant is running as.                                                |
| `{{config.<key>}}`                                                         | A value from your `config.json`.                                                |
| `{{target_repo}}`                                                          | `--repo <project>` for an MR target, so a command can be run from anywhere.     |
| `{{session.ask}}`                                                          | How to reach the session's live planner. Resolved only when a body asks for it. |
| `{{mr.assignee}}`, `{{mr.template}}`, `{{mr.issues}}`, `{{mr.has_issues}}` | Merge request facts. Available in a step that declares `requires: gitlab`.      |
| `{{skill:<name>}}`                                                         | A skill mention — see [Skills](#skills).                                        |

Collie itself puts the person glab is logged in as (or `gitlab.assignee` from `config.json`)
on the merge request: as assignee when a step reports an `mr_url`, and as reviewer when a
`fan_in:` review of an MR target completes. No prompt has to ask for either.

## Outputs

Outputs are JSON files a step writes into the run directory. Gates and loops read outputs,
never terminal text, and a step is finished when its `output:` file exists — not when its
agent goes quiet, because an interviewing agent goes quiet waiting for you. Until the file
appears you get one toast and the Driver keeps waiting.

An output carrying a `verdict` is validated against the review schema, so a loop gate can
always read it:

```json
{"verdict": "clean" | "findings",
 "findings": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
               "title": "one line", "detail": "what goes wrong",
               "rebuttal": "why a dispute of this finding does not hold"}],
 "disputed": []}
```

A fan-in over reviewers writes a review plus `summary` and `dropped`:

```json
{
  "verdict": "findings",
  "summary": "Two sentences: what the change does, and what is wrong with it.",
  "findings": [
    {
      "file": "cli.js",
      "line": 4,
      "severity": "blocker",
      "title": "Exits 1 on success",
      "detail": "A caller cannot tell it worked."
    }
  ],
  "dropped": [
    {
      "file": "pkg.json",
      "severity": "minor",
      "title": "no engines field",
      "reason": "one reviewer only, and the diff does not support it"
    }
  ]
}
```

The engine renders that to `review.md` in the run directory — the summary, then the
findings under their severity, and nothing about the process or the models — and prints it
in the run's own pane. That file is what a `post` choice sends to the merge request, and
inside `implement` it is what the fix step is given: one reconciled review per round, never
the reviewers' raw union.

## Persona frontmatter

A persona is much smaller: instructions injected when an agent starts, harness-agnostic and
never installed as harness-native config.

| Key                | Type   | What it does                                                |
| ------------------ | ------ | ----------------------------------------------------------- |
| `name`             | string | How steps refer to it. Defaults to the filename.            |
| `description`      | string | One line for the picker.                                    |
| `extends`          | string | Follow another persona and replace only the sections named. |
| `forked_from_hash` | string | Written by a `copy` fork. Do not write it by hand.          |

The body is the persona. Sections merge the same way a workflow body's do, so a fork can
replace `## Output` and keep everything else.

## Skills

Workflows and personas name the skills they drive, and there are two ways to refer to one.

**A mention** is what an agent reads. `{{skill:code-review}}` in a prompt or a persona
renders the skill's name and the file to read, identically for every harness:

```
the `code-review` skill (read `/home/you/.agents/skills/code-review/SKILL.md` and follow it)
```

A path is a path — nothing expands a slash command inside a file a model is handed — so a
mention is never harness-specific. A skill that is not installed says so in the same place,
`(not installed here)`, which is what a persona's fallback paragraph is for.

**A command** is what the human channel types to _start_ a skill, and that is
harness-specific: `/code-review` for `claude`, `/skill:code-review` for `pi`, and
`the "code-review" skill` for `codex` and `opencode`, which surface skills by description. A
step's `skill:` key is sent that way, which is the only way to run a skill that refuses to
be started by the model itself.

So a definition never spells either form: write `{{skill:name}}` in a body, or name it in a
step's `skill:`, and the same definition works on every harness.

Skills are a prerequisite, like the harness binary. A workflow naming a skill you have not
installed fails validation before a tab opens, naming the skill and the command that
installs it:

```
implement step "build": the skill "implement" is not installed — run `npx skills add implement`
```

`.agents/skills` in the project you are in is checked first, then `~/.agents/skills`.

## Harnesses, models and effort

| Harness    | Model flag                 | Persona                                                  | Effort                                                   | Unattended switch                            |
| ---------- | -------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| `claude`   | `--model`                  | `--append-system-prompt-file`                            | `--effort low\|medium\|high\|xhigh\|max`                 | `--permission-mode bypassPermissions`        |
| `codex`    | `-m`                       | prompt prefix                                            | —                                                        | `--dangerously-bypass-approvals-and-sandbox` |
| `pi`       | `--model <provider/model>` | `--append-system-prompt` (reads the persona file's path) | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` | none — pi has no tool-approval prompt        |
| `opencode` | `--model <provider/model>` | prompt prefix                                            | —                                                        | `--auto`                                     |

`claude` accepts `fable`, `opus`, `sonnet`, `haiku`, `opusplan` and any `claude-…` id. `codex`
accepts `gpt-5-codex`, `gpt-5`, `gpt-5-mini` and any `gpt…`/`o…` id. `pi` and `opencode`
take provider-qualified ids (`openai-codex/gpt-5.6-sol`). Add more with `models` in your
`config.json`.

`model: default` is accepted by every harness and uses its adapter's pinned default. Claude
pins that default to `opus`, so every base Claude agent receives `--model opus`; adapters
without a pinned default omit the model flag. Effort is optional — leave it out and each
harness uses its own default.

The unattended switch is passed unless `permissions` says `harness`, in your `config.json`
or on the step; see [Permissions](using.md#permissions-unattended-by-default) for what it
means. pi's column says none because it does not ask before a tool call — its `--approve`
only trusts project-local files — so `bypass` and `harness` start it identically.

```yaml
steps:
  - id: deploy
    persona: implementer
    permissions: harness # this one should ask; the rest of the run does not
```

The mode is settled when an agent starts, so a step with `agent:` cannot change it: naming
a mode that differs from the step whose agent it continues fails validation. Set it on the
step that starts the agent, or drop `agent:` so the later step starts one of its own
(`agent` and `fresh` are mutually exclusive, so `fresh` is not the way out). Repeating the
same mode is
allowed, which is what every step of an embedded workflow does when the `use:` step names
one.

An unknown harness, model, effort or permissions mode fails validation before a single tab
opens.

## Worked example: two different reviewers

The canonical fork. You want one reviewer on a different harness, and nothing else changed.
`collie workflow fork review --layer user --step review --mode extends` writes the stub;
this is what it should end up as:

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

Nine lines instead of ninety. The `target` input, the synthesis step, the end menu and every
prompt body are still the baseline's, and a baseline improvement to any of them reaches
this fork.

Because `implement` embeds `review` with `use:`, and `use:` resolves through the same
layers, this also changes the reviewers inside every `implement` run.

Check it before you rely on it:

```sh
collie workflow check review      # validates it in every layer
collie workflow show review       # prints the resolved steps and inputs
```

## YAML in frontmatter

Frontmatter is parsed as YAML 1.2 — block and flow collections, quoted and block scalars,
anchors and aliases. Four things to know:

- A block sequence must be indented under its key. `steps:` followed by `- id: a` in the
  same column is refused, naming the key, rather than read as a mapping.
- A key may not be set twice in one mapping. `a: 1` over `a: 2` is an error where the
  parser Collie used before this took the last value, so a definition that relied on that
  needs the duplicate removed.
- Date-like values stay strings, which is what `forked_from_hash` and version-shaped inputs
  need.
- The parser is close to YAML 1.2's core schema without being conformant to it: `.inf` and
  `.nan` read as null, and `1_000` as `1000`. No frontmatter key takes any of those, so
  this matters only if you were relying on one.
