# CLI

Every capability Collie has in herdr is also a command, because both front doors are thin
adapters over the same services ([ADR-0003](adr/0003-collie-is-one-effect-program.md)). This
page is the contract for driving Collie from a script or an agent.

`--json` is the machine-readable surface. Everything else Collie writes — run directory
files included — is internal mechanics that can change without notice; if you need it,
there is a command for it.

For the vocabulary, see [`CONTEXT.md`](../CONTEXT.md). For what each workflow is for, see
[Workflows](workflows.md).

## Global flags

Put these before the subcommand:

| Flag                | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `--json`            | Emit one machine-readable envelope instead of text.                |
| `--workspace <id>`  | Scope to that herdr workspace, and root the run at its directory.  |
| `--log-level <lvl>` | `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `none`. |

```sh
collie --json --workspace wT run start plan --input goal="ship it"
```

## Where a run roots

A run is rooted at the directory Collie is standing in. To run against another repository,
pick one of:

- `cd` into it.
- Set `COLLIE_CWD=<path>` — the working directory for the picker and the agents, and the
  root of a CLI run.
- Pass `--workspace <id>`, which re-roots the run at that workspace's directory as well as
  scoping to it.

`collie run list` lists every run, unless the selected workspace is a task workspace — then
it lists that Task's. See [Tasks](#tasks).

## Discover what is available

The environment is the source of truth for which workflows exist and what they take — a
user or project layer may have overridden any of them.

```sh
collie --json workflow list
collie --json workflow show implement
collie --json persona list
collie --json persona show implementer
collie --json workflow check          # validate every layer, without starting a run
```

A workflow is a TypeScript module — see [the SDK](sdk.md) — and `list` returns those under
`modules`, each read as `show` reads one: what you are shown is what would start. A Markdown
workflow an older Collie left in your layer is neither listed nor run; `collie doctor` names
it.

`workflow show <id>` gives the module's public id, the layer and file it came from, each
input with its strategy and its schema, the names the host settles beside your input, the
schemas of its result and its failure, and what its definition declares, under `metadata`:

```json
{
  "ok": true,
  "data": {
    "workflow": {
      "id": "implement",
      "title": "implement — build the plan, review it, fix until nothing blocks",
      "layer": "shipped",
      "path": "/home/you/.collie/workflows/implement.workflow.ts",
      "inputs": [
        {
          "name": "plan",
          "required": true,
          "strategy": "work-source",
          "schema": { "type": "string" },
          "limits": []
        }
      ],
      "options": [{ "name": "branch", "meaning": "Branch selection for mutating work, …" }],
      "success": { "schema": { "type": "string" }, "limits": [] },
      "error": { "schema": { "$ref": "#/$defs/WorkflowErrorEncoded" }, "limits": [] },
      "metadata": { "hints": { "plan": "work-source" }, "selectable": ["feature", "…"] },
      "broken": null
    }
  }
}
```

`limits` names each place the drawn JSON Schema constrains less than the module's own
schema does — a projection limit, not an invalid schema. `broken` is the sentence a module threw
when it was constructed, and null when it did not.

The same reading answers `collie_definitions` over MCP and Pi, and fills the `needs_input`
refusal you get from `run start` when a required input was not given — so every door names
the same file, the same schemas and the same diagnostics.

`workflow check [<workflow>]` loads each module, constructs it and typechecks it against
the SDK declarations, without starting a run, taking an agent or opening a worktree. It
reports three different things and keeps them apart: `problem(s)` is what stops it running,
`drawn without:` is a projection limit, and `ok, not typechecked` means no compiler was
installed in that directory — never silence. It exits non-zero for problems, so it fits a
pre-commit hook.

## Write one

```sh
collie --json workflow create tally                 # your own layer
collie --json workflow create tally --layer project # this project's
collie --json workflow fork implement --layer user --name ours
```

Both write `<id>.workflow.ts` where a run will find it, return its path, and never write
over a file that is already there. `create` writes the smallest definition that runs;
`fork` writes one that spreads the original's definition under the new id, so everything it
does not name is still the original's. Both then provision the authoring setup beside the file —
`package.json`, `tsconfig.json`, `collie.d.ts` — merging what it needs into a
`package.json` or `tsconfig.json` you already have, and installing the toolchain with the executable's own embedded Bun. With no network on a
first use the answer says `toolchain_unavailable`: the module still runs, and nothing was
typechecked.

Then: edit it, `collie workflow check <id>`, `collie run start <id> --input …`.

## Start a run

```sh
collie --json run start <workflow> --input k=v [--input k=v …]
collie --json run start <workflow> --inputs-json '{"goal":"ship it"}'
```

| Flag              | What it does                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `--input k=v`     | Repeatable. The names come from `workflow show`, plus `branch` (below).     |
| `--inputs-json`   | Every input at once, as one JSON object.                                    |
| `--decide s=t`    | Refused: a Run asks its questions when it reaches them.                     |
| `--task <id>`     | Continue that Task instead of starting a new one, as `task list` prints it. |
| `--continue-task` | Continue the Task whose workspace this is; `needs_input` outside one.       |
| `--here`          | Keep the Run in this workspace, as its Task, instead of opening one.        |
| `--verify <json>` | Repeatable. A check Collie may run to prove it, as one `verify.json` entry. |
| `--harness <h>`   | The harness this Run's agents run on, over the workflow's own preference.   |
| `--model <m>`     | The model this Run's agents run on, over the workflow's own preference.     |
| `--effort <e>`    | The effort this Run's agents are asked for, over the workflow's own.        |
| `--request-id`    | Idempotency key — see [Retrying safely](#retrying-safely).                  |

`--harness`, `--model` and `--effort` reach every agent the Run starts, and its children,
without the workflow doing anything for them; a piece of work that names its own still
wins. They are resolved together before anything starts, so a model the harness does not
take is `invalid_input` naming what it would take. [Which agent does the
work](sdk.md#which-agent-does-the-work) is the whole order.

### A workflow saved as a module

An id a TypeScript module claims is that module's, and `run start` starts it on the local
host rather than as an orchestration of agents — no flag says which, because what an id
runs is what is saved for this project ([`sdk.md`](sdk.md#where-a-module-lives) is where
that is). An id whose module will not load is refused by that file, and an id no module claims is a
workflow this installation does not have.

A module's inputs are schemas rather than text, and they are settled before a Run, a claim
or an execution exists — so a value one of them refuses costs nothing to refuse:

- **`--input k=v` is what a human typed.** It is tried as text first and read as JSON only
  where the schema will not take text. `--input count=3` is the number `3` for a number,
  `--input labels='["a","b"]'` is the list for a list, and `--input ref=12` is the string
  `"12"` for a string-or-number union, because text wins where both would do.
- **`--inputs-json` is typed, and settles what text cannot.** `false`, `0`, `[]` and `null`
  survive it; `--inputs-json '{"ref": 12}'` is the number where the text was the string.
- **Missing is absent, not empty.** An input nobody gave is one the module never sees, so
  an optional one stays optional and a required one is named back to you rather than
  quietly becoming `""`.
- **What it refuses names the field**: a value its schema will not take is `invalid_input`
  saying which input and what it takes, and an input the module needs and nobody gave is
  `needs_input` carrying each missing field's schema — fill them in and retry with the same
  `--request-id`, and it is still one Run.
- **The host's own names never reach a module's input.** `branch`, `task`, `workspace`,
  `repo`, `outcome`, `risks` and `previous` are options Collie supplies; a module may not
  declare one, and asking for an outcome a module always proves is refused rather than
  recorded as something it will not deliver.

`collie verify --run <run-id> -- <command>` records against a module's Run as it does
against any other: the same collector, the same binding to the tree the command ran on, and
the same refusal for a directory that is not that Run's. A module can ask for one itself,
but only for a command its approved set named when the Run started, or one granted it since
with `run intent verification` or chat's `set_verification`.

A module may be made of other modules. A child is a Run of its own — `run list` has it,
`run show` says whose it is, and the Task it belongs to is its parent's — and it is started
by the same lookup a front door uses, so a project that overrides that module overrides
what its parents run. [`sdk.md`](sdk.md#a-workflow-made-of-other-workflows) is how one is
written.

The Run it starts is shown, listed and waited on by the same commands as any other, and
`--request-id` deduplicates it the same way — the claim goes to the host, so the retry is
the same Run there too. `--goal` and `--constraint` seed the Run's [Intent](#intent);
`--decide` is refused rather than accepted and dropped, since a module asks its questions
when its work reaches them.

The picker asks for exactly what the module declares, in the way its own schema allows: a
closed set is a menu of the values it takes rather than a text box, and an input the module
attached a strategy to is worked out from this checkout and its Task before anyone is asked
for it. [ADR-0018](adr/0018-a-native-run-is-a-run.md) and
[ADR-0019](adr/0019-a-strategy-not-a-field-name.md) are why each of those is the way it
is.

#### Answering, holding and steering one

`run show` says what a module's Run is waiting on and what is set over it, and the ordinary
commands do the rest — whichever door you come in, it is the host that settles it:

```bash
collie --json run answer <run-id> yes --decision keep --request-id "$(uuidgen)"
collie --json run hold <run-id> --request-id "$(uuidgen)"
collie --json run release <run-id> --request-id "$(uuidgen)"
collie --json run stop <run-id> --request-id "$(uuidgen)"
collie --json run resume <run-id> --request-id "$(uuidgen)"
collie --json run steer <run-id> "check the migration too" --request-id "$(uuidgen)"
```

- **`--decision` names the question** where a module is waiting on more than one; leave it
  out and the one open question is answered, and being asked for is refused where that is
  not exactly one. A value the question does not take is refused with what it does take;
  one it takes is taken in any case, so `YES` answers `yes`.
- **One answer settles it.** A second is refused with what the Run already has; the same
  `--request-id` again is the same answer rather than another.
- **A control reaches one Run.** Its siblings and the host carry on. A control over a Run
  whose module is not loaded here is recorded and says so, naming the file to repair,
  rather than reporting a success nothing can stand behind.
- **`run stop` parks the Run and stops its agents.** Their panes are closed, and those of
  the Runs it started; the workspace keeps its own tab. `run resume` clears the stop and
  picks the Run up again, giving work whose agent has gone to a new one. On a Run that has
  already finished, a stop only closes its live agents' panes: no control is set, the
  status stays what it finished with, and with nothing alive it says nothing was running.
- **A Run parks itself when its agent's pane will not take a prompt.** herdr answering
  `agent_blocked` for ten minutes leaves the Run `suspended`, with `parked` in its view —
  and in `run show` — saying what held, for how long, and where the prompt is. `run resume`
  hands that prompt to the same agent rather than starting another.
- **A Run with nothing approved to prove it parks before its first agent**, where its
  outcome needs the approved set. `parked` names the repair: `run intent verification`
  grants this Run a command through the host, and `run resume` carries it on.
- **A Run's agents live in its Task's workspace**, opened by the start that made the Task.
  A stop closes only its agents' panes there. If herdr has closed that workspace by the next launch, it
  is reopened on the Run's checkout and the Task records the new id; with the checkout gone
  too, the Run parks with `parked` naming both and the way back. `run resume --workspace`
  does not move a Run: `--workspace` only chooses where the command looks, and the resume
  says so.
- **`run steer` says something to the Run's agent** through the one sender, with the same
  incarnation and harness-capability checks as every other delivery, and tells you whether
  it was delivered rather than that it was accepted for sending: anything not sent is
  `operation_failed`, with why. A finished Run's live agent takes one as a running Run's
  does, whether or not its module is still loaded. It carries out nothing:
  `collie steer` is still the only thing that proposes an action, and a proposal still
  names its exact payload to be confirmed.

[ADR-0021](adr/0021-one-host-answers-for-a-run.md) is why each of those is the way it is.

A module that has an agent do its work opens a tab and starts one on the harness, model and
permissions this installation is configured for, with the compaction controls every agent
Collie starts gets. What it was actually sent and what it wrote are files under the host's state
directory — `agents/<run>/<operation>.prompt.md` and `.json`, with the repair beside them —
so a Run that ended `output-unusable` can be read rather than reconstructed. An Output the
workflow's schema refuses buys exactly one rewrite from that same agent, and a second
unusable one ends the Run with the reasons named.
[ADR-0020](adr/0020-an-agent-is-launched-once-and-its-output-is-decoded.md) is why.

### Tasks

A **Task** is the work itself, and the Runs it takes: a plan, the implementation it chains
into, the review of that. A fresh start about a branch an open Task's checkout has out —
the branch it is placed on, or the one its diff target names; never merely the branch the
caller is standing on — is that Task's, and opens in its workspace wherever it was started from. Any other fresh
start is a new Task, and gets a herdr workspace of its own, created and never focused. The
default branch names no one piece of work, so a start on it is always new. Chains,
follow-ups and resumes stay in the Task they came from.

Continuing anything else is explicit. `--task <id>` names one; `--continue-task` means the
Task whose workspace this command was run in, and is `needs_input` anywhere else rather
than a prompt. Neither the workflow's name nor a similar label ever continues a Task on
its own.

`--here` keeps the work where you are: this workspace becomes the Run's Task — the one
already kept here, or a new one — and its agents open beside you. A mutating workflow
still gets its own worktree; only the workspace a fresh start would open is not. A `start`
proposed from chat does the same with `here: true`.

```sh
collie --json task list
collie --json run start review --task task-1a2b3c4d --input target=worktree
```

`task list` gives each Task's id, its label, its workspace and the Runs it owns. The label
is inferred when the Task is made — `<Project or theme> | <what this work is>`, from the
work and from the names already live in your herdr session — and is display only:
renaming a task workspace by hand changes nothing about what belongs to it, and Collie
does not rename it back. See [Using Collie](using.md#what-a-task-workspace-is-called).

Runs are scoped by Task, not by workspace. `collie run list` inside a task workspace lists
that Task's Runs; anywhere else it lists every Run, and a Run is reachable by id from the
workspace it was started in. `--workspace <id>` picks which workspace that is.

Checkouts are unchanged: a mutating run still gets a worktree of its own, keyed by its
branch. A task workspace groups the work; it does not isolate files or branches.

`--input branch=<name>` is the one input no workflow declares, and `workflow show` lists it
beside every module's own inputs as one of the names the host settles. It names the branch the run works on, and so which worktree it gets. Nobody is ever asked for one: a branch nobody named is resolved in this order:

1. `--input branch=<name>`, which wins over everything below. A follow-up is given its
   parent's branch this way.
2. The branch the reviewed work is already on, for a run fixing a review.
3. The `<name>` of a `branch:<base>...<name>` target **you gave** (`--input target=` takes a
   bare ref too, and turns it into one) — so the checkout and the review target agree. A
   target Collie inferred does not count: it names the branch you are standing on, and
   building that would hand the run your own checkout.

Those three are branches that already exist, or that you named, and are used exactly as
they came. Everything else is new work, and gets a new branch called
`<your GitLab login>/<the task>`:

4. `--input task=<slug>`, which is also what `plan` and `architecture` forward when you
   choose **Implement now**, and what a fan-out gives every repository run.
5. The plan directory's own name, for a run given a plan directory.
6. A slug of the work itself — the description, or the issue id.
7. Otherwise a slug of the run's own name.

The login is `GITLAB_USER_LOGIN` where the environment sets it, and otherwise whoever
`glab` is logged in as for this checkout's host. Neither is the merge request's assignee
and neither is your OS username. Where there is no login to be had the run does not start
and says to log in — it is an authentication failure, not a question about branches.

A name too long for the cap, or with nothing in it to slug at all, is cut to fit and given
a short digest of the whole of what it stands for: two plans under one directory, and two
runs with no name of their own, would otherwise clip to the same branch, and the branch is
what keys the worktree. The digest is of the work and not a counter, so the same work asked
for twice is the same branch — a retry reuses the checkout rather than opening a second
merge request. Every generated name is put to `git check-ref-format` before it is used.

The task half of the branch also names the run itself — its `slug`, and so its agents, its
tab and its row on the board — so what `run show` calls the run and what the checkout is on
always say the same thing. The login is left out of it: it is the same on every branch you
generate, and spending the slug's length cap on it would make two long plans one row.

It is ignored by a workflow that changes nothing.

**An agent's start names everything.** `run start` infers and routes nothing: that is the
[Launch flow](using.md)'s, for a human. Run inside a git checkout, the start has named that
checkout. Anywhere else it has to carry `--input workspace=<absolute path>` or
`--input workspace=projects-root`, and without one it is `needs_input` listing the
checkouts under the [Projects root](../CONTEXT.md) to choose from. Every Input the workflow
declares has to be given too, an optional one as an explicit empty string
(`--input plan=`): the prompt then says it was not given rather than leaving it out.

`--input workspace=` is the host's, not the workflow's, and it says where the checkout
comes from. `new` asks herdr for it, so the run gets a worktree workspace of its own
instead of living in its task's; a fresh task takes that workspace as its own rather than
opening a second one. An absolute path is an existing checkout the run starts from.
`projects-root` roots the run at the Projects root, which is not a repository: a workflow
that makes no checkout, like `plan`, works there, and one that cuts a worktree, like
`implement`, is refused because there is nothing to cut it from. It is decoded before
anything exists: any other value is `invalid_input` naming it, and so is `new` for a
workflow that makes no checkout. Nothing chains it on: an `implement` that a
`plan`, an `architecture` or a `review` starts is placed by its own declaration, in the
same task
([what a run does to your repository](using.md#what-a-run-does-to-your-repository)).
`--workspace <id>` is a different thing: it roots the run at that workspace's directory.

A workflow that builds on a worktree of its own, started from a directory that is not a
git checkout, is refused with `invalid_input` naming that directory, before a run, a
worktree, a workspace or an agent exists.

Examples:

```sh
collie run start review --input target=https://gitlab.example.com/acme/app/-/merge_requests/2 --input plan= --input proves=
collie run start review --input target=worktree --input plan= --input proves=
collie run start implement --input plan=ENG-123
collie run start plan --input goal="one registry" --input workspace=projects-root
```

A start that leaves anything out comes back as `needs_input`, one entry per missing field:
what it means (the field's own description, else what its strategy is) and the facts that
would fill it — the target inference would pick in this checkout for a diff target, the
plan directories of finished Runs for a work source, and the checkouts under the Projects
root for `workspace`:

```json
{
  "ok": false,
  "error": {
    "code": "needs_input",
    "message": "review needs \"target\", \"plan\", \"proves\". Nothing is inferred for an agent's start: give every Input, an optional one you leave empty as \"\".\n- target: …",
    "details": {
      "workflow": "review",
      "inputs": [
        {
          "name": "target",
          "meaning": "The change to review: mr:<iid>, mr:<group/project>!<iid>, branch:<base>...<head>, or worktree",
          "facts": ["mr:acme/app!2 (open merge request !2)"],
          "question": "review — an MR, a branch diff, or the working tree — target?",
          "required": true,
          "schema": { "type": "string" },
          "limits": []
        }
      ],
      "requestId": "33c306ee-…"
    }
  }
}
```

Retry with the same `--request-id` once you have the values.

## Watch a run

```sh
collie --json run wait <run-id> --follow
collie --json run wait <run-id> --timeout "10 minutes"
collie --json run wait <run-id> --until attention
collie --json run show <run-id>
collie --json run list
collie --json run output <run-id>
```

Without `--follow`, `run wait` prints one envelope when the run has ended — `complete` or
`failed`. A stopped or held run is suspended rather than ended, so a plain wait waits
through it. `--timeout` takes a spelled-out duration — `30 seconds`, `10 minutes`, `2 hours` — and
comes back as the `timeout` error code. Abbreviations like `30s` are refused as
`invalid_input`. A wait whose host is replaced under it reconnects and keeps waiting, and
one interrupted before it has an answer still prints an envelope: `operation_failed`,
"interrupted before it finished".

A Run is watched from the host's own stream: every update
is the whole current state rather than a change to apply, so a `wait` started long after
the work — or resumed after the last one was interrupted — reads where the Run is instead
of waiting for a notification that has already been and gone. `run show` names the module file the Run is on, and a
Run whose module has been deleted still reads, pending, with that file named: its history
is Collie's rows, and none of them went anywhere. `run list` shows those Runs beside the
rest; where the host will not start it says so and still lists the others.

A run that stops to ask a question is **not** ended, so a plain `run wait` waits straight
through it. `--until attention` is the wait that does not: it returns as soon as the run is
suspended — at a question, held, stopped or parked — or has ended, whichever comes first,
and returns immediately when that is already true. `--until terminal` is the default
spelled out; any other value is `invalid_input`.

Answer what the wait returned with `run answer <run-id> <option> --decision <name>` — see
[Answer a question](#answer-a-question).

`--follow` streams instead of returning one envelope: one newline-delimited
`{"type":"status","run":…}` line each time the run's status changes, carrying the same
`run` object as `run show`. Failures still arrive as a normal envelope — a timeout, or a
run the host could not watch — so a consumer reads each line as JSON and branches on
whether `type` is present.

`run show` is the Run as the host has it. Its `run` object carries:

| Field                                    | What it tells you                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`, `workflow`, `project`           | Which run this is, of which workflow, for which project.                                                                                                                                             |
| `task`, `parent`                         | The Task it belongs to and the run that started it, or `null`.                                                                                                                                       |
| `entry`, `registration`                  | The module file it was admitted on — named even once it is gone — and the name the engine registered it under.                                                                                       |
| `input`, `provenance`, `strategies`      | What it was given, where each value came from, and which inference each input carries.                                                                                                               |
| `options`                                | The host's own launch options: `branch`, `task`, `workspace`, `repo`, `outcome`, `risks`, `previous`.                                                                                                |
| `cwd`, `branch`, `workspace`, `worktree` | Where it works: its own worktree on `branch`, or the checkout it started from; a workspace of its own, or its Task's.                                                                                |
| `outcome`                                | What it has to prove.                                                                                                                                                                                |
| `created`, `status`                      | When it was admitted, and where the engine says it is: `pending`, `suspended`, `complete` with its `value` — the result as the workflow's success schema encodes it — or `failed` with its `reason`. |
| `waiting`                                | Every question it has been asked, oldest first: `name`, `prompt`, `options`, and `answer`, `null` while it is open.                                                                                  |
| `controls`                               | A `hold` or a `stop` someone set over it.                                                                                                                                                            |
| `parked`                                 | Why it parked its own work and what picks it up again, or `null`.                                                                                                                                    |
| `diagnostic`                             | Why the engine could not be asked about it — a module that is missing, with the file named — or `null`.                                                                                              |

## The board

```sh
collie --json board
```

The first snapshot of the board the host serves
([ADR-0038](adr/0038-the-host-builds-and-serves-the-board.md)): every Task on this Herd's
board, in the order the Home draws them: **Needs you** first, then **Waiting on you** (work
that ended and has not landed, what is `ready` to release first), then **Working** (`active`
and `quiet`), then **Finished** (landed), and inside each whatever changed last first. `state: blocked` is what puts a Task in Needs you,
and it means one of two things: a `decision` to answer, or an agent waiting for you in its
own pane — a harness dialog herdr will not answer, or a run that parked because its agent's
pane would not take a prompt. The `sentence` says which, and for the second kind it says which pane. It is the same model the pane renders, so an agent
reading this and a human reading the board cannot be told two different stories about one
Task.

Herd-wide, and never narrowed by which workspace you typed it in: one board per Herd
([ADR-0009](adr/0009-the-collie-tab-is-the-herds.md)). A Run belonging to no Task is a
Task of its own; a Repo run of a fan-out is its parent's `children` rather than a Task beside it.

| Field                     | What it says                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | The Task, or the Run's own id where it belongs to no Task.                                                                                                      |
| `name`, `project`         | The two halves of the task workspace's label. No herdr ids.                                                                                                     |
| `herd`                    | The Herd the Task's workspace is in: an `id` in `herds` while that session runs. Absent for a Task recorded before it was kept.                                 |
| `state`                   | `blocked`, `active`, `quiet`, `failed`, `stopped`, `abandoned` (a Run nothing drives and no agent works on) or `done`.                                          |
| `steps[]`                 | The pipeline across the Task's Runs, each `done`, `active`, `blocked`, `failed` or `todo`. A step that loops is one entry.                                      |
| `sentence`                | What is happening, in one plain sentence — no step names, counters or glyph codes. It names the round, the wave and the answer it resumed with.                 |
| `age`, `at`               | How long it has been going, and when it last changed.                                                                                                           |
| `drift`, `held`           | The one line each carries, or `null`.                                                                                                                           |
| `heldBy`                  | Who set the hold that stands — the front door it came through — and the reason given with it, or `null`.                                                        |
| `decision`                | The question, proposal or gate waiting on you, or `null`. One of the two ways into Needs you.                                                                   |
| `agents[]`                | The live agents on it, its Repo runs' included.                                                                                                                 |
| `children[]`              | A fan-out's repositories in wave order: `repo`, its `run` (`null` until it starts), its `state` (`done`, `active`, `blocked`, `failed` or `todo`) and its `mr`. |
| `mr`, `mrState`, `branch` | What it is building, where it can be read, and what the forge last said about the merge request.                                                                |
| `disposition`, `landed`   | What became of the work, where a person recorded it — never inferred from a merge request — and whether it needs nothing more, which is Finished.               |
| `ended`                   | When the leading Run ended, or `null` while it has not.                                                                                                         |
| `planReady`, `offer`      | A finished plan nobody has implemented, and the offer its card's first action invokes.                                                                          |
| `checks`                  | What checked an open merge request: `passed` or `failed` (with `name`) at revision `at`, `running`, or `unchecked`; else `null`.                                |
| `ready`                   | Ready to release: the leading Run succeeded, its merge request is open, and its `checks` passed.                                                                |
| `check`                   | The check Collie is running for the leading Run, as `collie run checks` gives `running` (with its `log` and `lastLines`), or `null`.                            |
| `reopened`                | A finished Run whose agent took a steer after it ended: the `delivery`, the `agent`, the first line it was `told` and its `status` now; else `null`.            |
| `run`, `runs[]`           | The Run a card acts on, and every Run of the Task.                                                                                                              |

A `gate` is a Run parked at its evidence gate with nothing approved, listing the checks its
checkout's `.collie/verify.json` (or your config's `verify.json`) offers. Answer it with
`collie run answer <run-id> approve --decision evidence-gate`, or `approve:<name>,<name>`
for part of the list: the host grants those, as `run intent verification` does, and takes
the Run up again. It is not skipped, since with nothing approved no check could prove it.

## Answer a question

A run waiting on a question reports `status: "suspended"` and lists it in `waiting` with
`answer: null`. Relay the question and its options as written, then send the answer,
naming the question:

```sh
collie --json run show <run-id>                            # read waiting
collie --json run answer <run-id> "Implement now" --decision next-1 --request-id "$(uuidgen)"
collie --json run show <run-id>                            # confirm it took
```

`--decision` names the question you are answering, so an answer that arrives after the run
has moved on cannot land on another one: a question already answered is refused with what
the run already has. Leave it out and the one open question is answered; with more than one
open, that is refused. The answer is one of the question's options, in any case — `Yes`,
`yes` and `YES` are the same answer — and one it does not take is refused with the ones it
does. A refusal is `invalid_input` where your answer was the reason, and otherwise
`operation_failed` with the host's own sentence.

## Stop and resume

```sh
collie --json run stop <run-id> --request-id "$(uuidgen)"
collie --json run resume <run-id> --request-id "$(uuidgen)"
```

`stop` parks the run where it is — at its next boundary, or inside the wait it is in — and
closes its agents' panes, and those of the Runs it started, which is what stops them; the
workspace keeps its own tab. Only the process each launch recorded is closed, never another
under the same name, and a pane that will not close fails the stop and names the agent
still running. `resume`
asks the host to pick a suspended run up again. It re-enters the workflow's current code
and reuses every Activity already done, so completed work and its Outputs are kept and
never redone, and an agent still live is reattached to rather than started a second
time; one a stop closed is started again with the prompt it had. It clears a stop first, hands a run parked on a pane the same prompt, and registers
the modules as they are now — so a run whose module was missing and has been put back is
carried on without restarting the host. On a run the engine is already working it changes
nothing.

A workflow edited in a way that changes its shape has no promise of a seamless resume, and
not every such edit can be detected: begin new work where one will not carry on. A run an
older Collie recorded is read-only and is refused with what recorded it; `run start` begins
the same work again.

## Intent

A run's **Intent** is what it is for, what its work must respect, and what Collie may do
about it without asking; everything Collie says about drift is a comparison against one.

Every Run has one from the moment the host admits it, written before any of its work
runs, and a Run started from another — a child, or a follow-up offered on a card —
inherits that one's as it stands. `run intent` reads and amends it; `run intent
verification` grants the run a command through the host (below).

```sh
collie --json run start implement --input plan=./plans/steering \
  --goal "land steering behind the existing envelope" \
  --constraint "rule:protected_paths:src/**,test/**" --severity block \
  --constraint "no new dependencies"

collie --json run intent show <run-id>
collie --json run intent set-goal <run-id> "<goal>" --request-id "$(uuidgen)"
collie --json run intent add-constraint <run-id> "<text>" --severity block
collie --json run intent remove-constraint <run-id> <constraint-id>
collie --json run intent authority <run-id> auto_correct=true --propagate
```

Version 1 is the workspace's defaults, then what the work source itself asks for, then
what `--goal` and `--constraint` named — later beating earlier where they name the same
constraint. For a plan directory the work source's ask is read from its `SPEC.md`: the
bullets under a heading matching `Requirements`, `Success criteria`, `Boundaries`,
`Constraints`, `Out of scope` or `Done when` become `warn` constraints carrying the file,
heading and line they came from; an out-of-scope bullet reads `Out of scope: <bullet>`. In a
Run on a worktree of its own, its `plan/SPEC.md`, written by its planner, is read the same
way at every work boundary: new bullets are added, dropped ones are removed, and a
constraint anyone but the plan removed stays removed. **No text ever grants authority** —
not a plan, not the repository, not a prompt.

`--severity` pairs with the `--constraint` in the same position; a constraint given
without one is `warn`. A `block` constraint stops work; a `warn` one is reported.

A constraint spelled `rule:<kind>:<args>` is one Collie checks itself; anything else is
judged. The spellings:

| Rule                                         | What it holds the run to              |
| -------------------------------------------- | ------------------------------------- |
| `rule:protected_paths:<glob>[,<glob>…]`      | Changes stay inside these paths.      |
| `rule:branch_is:<branch>`                    | The run works on this branch.         |
| `rule:mr_target:<project>[:<iid>]`           | Its merge request targets this.       |
| `rule:output_field:<step>:<path>:eq\|ne:<v>` | A step's Output field reads this way. |
| `rule:command_exit:<name>:<code>`            | A named verification exits this way.  |

`authority` takes `k=v` pairs: `auto_correct`, `now_allowed`, `interrupt_allowed`,
`stop_allowed` and `exclusive_steering` are `true`/`false`; `max_corrections_per_constraint`
is a whole number. `auto_correct` is on by default and `auto_correct=false` turns it off for one
run; every other grant is off by default. On by default does not yet mean corrected: no
harness has proven attribution, so a correction also needs `exclusive_steering` until an
operator records it ([ADR-0037](adr/0037-collie-corrects-by-default.md)). A key that is not one of these is refused rather than stored. There is no model-call quota among them: how many calls a run
or the Herd makes, and what they cost, is recorded under `herd/<herdKey>/budget.jsonl` as
usage, and never used to refuse the next one. An Intent written by an earlier build with
`model_calls_per_run` still reads; the number decides nothing.

The one grant that is not a `k=v` word is a command Collie may run itself:

```sh
collie run intent verification <run-id> --name unit -- bun test
collie run intent verification <run-id> --name unit --remove
```

It is bound argument for argument — `bun test` and `bun test --bail` are two different
permissions — and `--cwd` is `worktree` or a path relative to the run's cwd. A granted
verification whose name a `rule:command_exit` constraint refers to is run once, at the
run's finish, so that rule is checked against a result rather than against nobody having
looked. Everything else on `steering/verifications.jsonl` is written by an agent calling
`collie verify`, and is recorded `by: agent`.

`--propagate` applies the amended Intent to every child run that is still going: the
child's own constraints are kept, the parent's are replaced, and anything the two disagree
about is reported rather than resolved. A child inherits its parent's constraints and goal
at birth, never its authority — a grant is per run.

```sh
collie --json run intent defaults show
collie --json run intent defaults add-constraint "<text>" --severity warn
collie --json run intent defaults remove-constraint <constraint-id>
collie --json run intent defaults set-authority max_corrections_per_constraint=3
```

Defaults are per workspace: every run started there begins with them.

## Talk to Collie

The Home's right-hand pane is an ordinary Claude Code (or Pi) session with Collie's role
and Collie's tools — that is where questions about the flock are asked, and it is
[docs/using.md](using.md#talking-to-collie-about-a-herd). From a terminal:

```sh
collie --json chat status
collie --json chat harness pi
collie chat status-line
collie chat status-line --install
collie chat context
collie --json tools list
collie --json tools call collie_herd
collie --json tools call collie_run --input '{"run":"<run-id>"}'
```

`chat status` says what is **running** and, separately, what is chosen for **next** time.
`chat harness` sets that preference: it never stops, replaces or summarises a conversation
already running, and it changes nothing about the harnesses your runs use. Claude Code is
the default, on an existing installation as much as a new one.

`chat status-line` prints `board selection: <name>`, or `board selection: none · whole
herd`, which is what Claude Code shows under the prompt so that chat and board agree on
what "it" means. `--install` is what `setup.sh` runs: it configures `statusLine` in your
own Claude Code settings — never `prepare.sh`, exactly like the keybindings — and leaves a
status line you already have alone, naming it instead. `collie doctor` reports which of
those it found. Outside a herdr session the command prints nothing, so a Claude Code you
opened somewhere else carries no line about a board it is nowhere near.

`chat context` is the same fact for the conversation: the Home's Claude Code runs it as a
`UserPromptSubmit` hook, so each message you send carries one line naming the open card,
and nothing at all while none is open. You never type it, and it is wired per launch —
nothing in your own Claude Code settings changes. A second hook beside it, `chat heard`,
hands each message you send to Collie's tool host, so what `collie_do` carries out that
turn is recorded with your words; the same command on Claude's `Stop` hook forgets them
when the turn ends, and a message from any other Claude session is not used.

`tools` is the same contract native chat is given, and it is the whole of what chat can
reach. Claude gets it over a local MCP server (`collie mcp`, which you never type) and Pi
through a generated extension; this is the third way in.

| tool                  | What it does                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `collie_herd`         | Every run in the Herd, bounded, saying how many it left out                                 |
| `collie_run`          | One run: its goal, constraints, steps, cards and open drift                                 |
| `collie_workspaces`   | The workspaces this session has, and the workflows that can be started                      |
| `collie_receipts`     | One run's pending proposals, and what state each message to its agents actually reached     |
| `collie_definitions`  | The Workflows and Personas there are; one resolved and checked, or one Persona's body       |
| `collie_installation` | What Collie needs, which workspace the Home is, what a cleanup would close, the defaults    |
| `collie_news`         | What this conversation has not been told; reading it settles those items for it             |
| `collie_hold`         | Hold a run, or every unfinished run in a workspace, until someone releases it               |
| `collie_do`           | Carry out, at once, a board action or decision on a named run the human asked for           |
| `collie_propose`      | Carry out the rest of what the human can ask for, with a request id that makes retries safe |

The reads are Herd-wide and are never narrowed **implicitly**: no read is filtered by what
the board is showing or which card is open. The selection is an **input** a tool may be
given instead ([ADR-0012](adr/0012-the-boards-selection-is-an-explicit-chat-input.md)).
Chat is told it at each prompt, and `collie_run`, `collie_receipts`, `collie_hold` and
`collie_do` act on it when you name no run — saying which run that was, in the answer.
`collie_installation` is the one read that is not read-only: the installation checks
include a bounded `git fetch`, and it says so rather than letting a client assume.

Three of them write, and every one carries out what the human asked for in the
conversation, at once ([ADR-0011](adr/0011-the-conversation-is-a-native-harness.md)):
chat may do what they could do on the board themselves, because sending them to the UI for
it is chat obstructing the person it serves. What Collie wants of its own accord never
comes through these: the evaluator's proposals wait on the board, and chat asks in words.

`collie_do` takes the board's own actions on a named run — `stop`, `resume`, `release`,
`answer`, `deliver`, `followup` and `start` — through the same closed union, the same
last-moment admission check and the same executors a confirmation runs. It also takes the
board's decisions, which are not actions on a run: `confirm` a waiting proposal by its id
and the hash `collie_receipts` lists beside it, `decline` one by the same two, and `disposition` to record
what became of a finished run's work. It answers a line per action saying what each one
came to. A kind outside that set is refused with the name of the tool that does take it:
amending an Intent, forking a definition, changing the defaults, keeping a run's checks for
its repository, a cleanup and an upgrade are `collie_propose`'s.

`collie_propose` takes the same closed action set a steer produces — `stop`, `resume`,
`hold`, `release`, `answer`, `deliver`, `start`, `followup`, `update_intent`,
`set_verification`, `remember_verification`, `clear_override`, `navigate`, `update_defaults`, `fork_definition`, `home_cleanup`,
`upgrade` — through the same `validate`, the same proposals journal and
the same executors. It executes the request immediately, with no separate confirmation.
Supply `request_id` and reuse it on retries to return the original receipt rather than
repeat the action. There is no arbitrary shell-command action for chat to run — but
`set_verification`, carried out in the same call with no yes, names a command Collie
spawns itself at the gate, outside any agent's permission rules, and it may be `sh -c`
anything. The merge request lists each check with its command, and that is where the human
reads it ([ADR-0011](adr/0011-the-conversation-is-a-native-harness.md#amended-2026-09-29-chat-may-choose-what-proves-a-run)).

`update_defaults` names the workspace whose new runs it changes, for the reason `start`
names one: defaults are filed per workspace, and the board carrying out a confirmation is
in the Home. Its `text` adds a constraint in your own words, or names the id of the one to
remove — prose there matches no id, and is refused rather than reported as applied. A
proposal about the installation names no run, so the board draws it whichever row is
selected.

Settling is not in that set: there is no action kind that confirms, declines or
reconciles, so a proposal can never contain its own yes. Settling is a separate act, and
chat takes it as the human does — `collie_do` confirms against an id and hash, or
declines. Everything else a human can type, chat does too. The checks that prove a Run have tools of
their own: a `start` carries the ones chat chose as `verify`, `set_verification` adds or
withdraws one, and `remember_verification` keeps a Run's set for its repository's later
Runs. What no tool covers — setting a
Run's or the Herd's **authority**, reconciling, `collie verify`, `chat harness` — it runs
with the `collie` CLI, through the same validation and executors
([`AGENTS.md`](../AGENTS.md), invariant 1). `test/chat-parity.test.ts` walks the command
tree itself and fails on a command with no route, so this list cannot quietly fall behind.

A run it names that does not exist is refused rather than retargeted; an agent the run
does not have comes back as a question for you rather than being dropped. `start` takes a
`workspace`, so a launch asked for from the Home lands in the repository it is about
rather than in Collie's own namespace directory — and it needs no existing run.

Requests retain their origin (`chat:`, `cli:`, or the board). A `collie` command is a
human's (`cli-tty`) only at a terminal, in a pane herdr does not report as an agent's or
outside herdr; anywhere else it is `cli`. Attribution is an audit record, not an approval requirement. Launches into Collie's Home state directory return
`needs_input`: choose the project with `--workspace` or `COLLIE_CWD` before starting work.
Legacy Runs rooted there cannot be resumed into the state directory; start a new Run
against the project instead.

```sh
collie --json steer "why is this on main?" --target run:<run-id>
collie --json steer "hold it and look at the branch" --target run:<id> --dry-run
```

A steer carries out your request about one run and returns execution results. A question
asking for an explanation is answered without changing the run. Use `--dry-run` to preview
actions without executing them. Suggestions triggered by background events remain proposals.

`--target` is required. Without one the call is refused with `target_required`: Collie does
not guess which run you meant from what you typed.

`--from <card>` binds the proposal to that card's revision, so confirming it after the
tree moved is refused rather than applied to different work. `--dry-run` prints what
Collie would propose and records no proposal.

```sh
collie --json confirm <proposal-id>
collie --json decline <proposal-id>
collie --json proposal reconcile <proposal-id> <index> --as applied|not-applied
```

`confirm` executes an existing proposal and `decline` refuses one. Optional
`--hash <content-hash>` checks that you are addressing those exact contents. Expired or stale-target proposals are still rejected.
Ordinary chat requests and steers do not need this command.

Actions run in order, each one re-checked immediately before it runs and journalled on
both sides. The first failure stops the rest. An action whose kind this build cannot carry
out is `skipped: executor_missing`. A failed or skipped action makes the envelope `ok: false`
and stops the sequence, instead of reporting success or running dependent actions.
Multiple Intent edits in one request use the same initial `base_version`; execution
advances that version for its own successful edits. Changes made by another request still
invalidate the stale snapshot.
An action that started and never settled makes the next
`confirm` refuse with `reconcile_required` until you say what happened to it.

```sh
collie --json run deliveries <run-id>
collie --json run deliveries <run-id> --reconcile <delivery-id> --as sent|not-sent
```

What has been sent to a run's agents. Explicitly settle an unknown delivery, or an
`unobserved` one a Run parked on, once you have checked whether it arrived; a timeout
alone never authorizes a resend. A parked step's prompt settled `not-sent` is sent once
more by `run resume` — see
[Delivery](steering.md#delivery).

## Carry on from a finished run

A finished run's status is never rewritten and its Workflow is never re-entered, but its
live agents still take `run steer` and `run stop`
([ADR-0041](adr/0041-a-finished-run-still-takes-steering.md)). New work with steps of
its own is a follow-up, and so is a request to an agent whose pane is gone: a steer to one
fails and names this route. What a Run offers to do next is its own declaration, so
carrying on is one of its offers:

```sh
collie --json run actions <run-id>
collie --json run action <run-id> follow-up --input plan="the docs change is still outside src/"
```

A follow-up carries on its parent's work, so it runs on the parent's branch — in the
worktree that branch already has — and updates the parent's merge request rather than
opening another. `--input` is only what is left to say, under whatever name the follow-up's
workflow gives it (`plan` for implement); the board's **Follow up** asks for those words and
sends them there.

## What became of the work

```sh
collie --json run disposition <run-id>
collie --json run disposition <run-id> --as merged --ref "cego/collie!43"
collie --json run disposition <run-id> --as superseded --ref <other-run-id> --note "restarted clean"
```

A run's status says how its execution ended, and it is never rewritten. When the work it
was for lands by some other route — a person finishes it by hand and merges — that is a
different fact, recorded beside the status rather than over it, with what backs it up.
This is not a [Delivery](../CONTEXT.md), which is one message to one agent; `run
deliveries` is that.

The board records the same thing: **Mark merged** and **Mark abandoned** in a finished
Task's drawer, with its merge request as the reference. See
[the Control Plane](using.md#the-control-plane).

Without `--as` the command reads. With it, `--as` is `merged`, `abandoned`, or
`superseded`, and there is deliberately no value meaning the run succeeded after all.
`run show` then says both: `failed · merged cego/collie!43 by mk`. Nothing is inferred —
Collie does not decide that a merge request it did not open was this run's work, so a
person says so and the record says who and when.

A correction is a new record rather than an edit, so what was believed before is still
readable. The most recent one is what `run show` reports.

This is integrated here and not yet on the board: the Home's rows and Live region do not
read it, so a Run whose work shipped still reads as a plain failure there.

## What a finished Run offers next

```sh
collie --json run actions <run-id>
collie run action <run-id> <offer-id> --input k=v
```

What to do next is the Workflow's own declaration — a module's `actions` and `followUps`,
a definition's `offers:` — never something Collie knows about a particular workflow. An
offer is listed when the Run's facts meet what it needs: a finding left open, a branch, a
merge request, tickets it wrote, something it was pointed at. The first eligible one is
marked as the obvious thing to do, and one that cannot be made is listed with the reason
rather than hidden.

An offer says where its inputs come from — the Run's own directory, its plan, what it was
pointed at, its branch, its merge request — and Collie fills those in, so `--input` is for
what only you know. What you pass wins where both have an answer.

Everything is decided again when you invoke one. The declaration is re-read from the code
as it is now, its eligibility is asked about the facts as they are now, and the arguments
are decoded by the workflow it starts — so an offer edited away, one whose facts have
moved and arguments the child will not take each start nothing at all. The board's keys
carry the same offer ids into the same operation, so both doors refuse in the same words.

Once somebody has recorded what became of the work, its follow-ups are no longer offered.
Actions are given that fact and decide for themselves: looking at what was merged is still
worth offering.

## Drift

```sh
collie --json run drift <run-id>
```

What this run has drifted from, and the evidence for each. Two kinds, and the difference
matters: a **rule** constraint is one Collie checks itself — which paths changed, which
branch, which exit code — with no model involved at all; a **semantic** one is judged, and
judged against a capped diff of the files it names rather than a summary of them.

A rule check never passes on an absence. A `command_exit` rule whose verification nobody
ran is a breach, not a pass; so is an `output_field` rule against a step that wrote
nothing, and an `mr_target` rule with no merge request. "Nobody looked" and "it was fine"
are different answers.

`run drift` reads what those checks recorded. An unresolved report there shows on the board
and as attention `drift_unresolved`, and a cross-run check that was owed and never made as
`cross_run_pending`.

## Outcomes

```sh
collie run start implement --input plan=<source> --input outcome=bug
```

What kind of result a run has to prove, and so what evidence closes it:

| `outcome`       | What closes it, beyond the approved verifications passing on the final tree                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(empty)_       | nothing more. Unclassified work is not a feature by default.                                                                                                |
| `feature`       | the tickets it built are named, every check a ticket's `**Checks:**` line promised has a passing verification, and the review says the agreed scope was met |
| `bug`           | a `regression` recorded with `--expect fail` before the fix, and passing after                                                                              |
| `refactor`      | the review says behaviour was preserved                                                                                                                     |
| `investigation` | a conclusion, references inside the run, and whether there is a patch at all                                                                                |
| `docs`          | the documented commands, run as written, each with a passing verification                                                                                   |
| `migration`     | `migrate-up` and `migrate-down` (or `rollback`) both passing                                                                                                |

The gate runs before the merge request, which is where the claim is made. Collie runs the
run's own approved set itself at the tree as it stands, then says what is missing. A check
that failed runs once more; gaps a check could still close go to the implementer for up to
four fixes, a reviewer's judgement or an Output's claim goes straight to the merge request
since no fix moves it, and whatever is still unproved is named in the merge request, which opens anyway: the
human verifies before it lands. Only the latest of Collie's results on that tree counts, so a
pass a later fail contradicts is not one. In `implement`, a check that fails at the gate is run once more,
before any fix, where the branch leaves the default branch, in the run's own checkout. One that
fails there too is named in the merge request as failing before the run's changes, with that
revision, and is not handed to the implementer. A run with nothing approved is told so rather than passed —
an empty set would make the gate say yes to anything — and a run whose outcome needs the
approved set is refused at `run start` when it has none (see [What Collie may run
itself](#what-collie-may-run-itself)). A grant withdrawn while the run works parks it at its
gate; `collie run intent verification <run-id> --name … -- <command>` and then `collie run
resume <run-id>` carry it on.

An investigation that concludes there is nothing to change skips the merge request with a
note and finishes. That is a real outcome, and nothing is invented to have something to
merge.

`plan` settles the outcome during its interview and forwards it, so a chained build is not
asked again. A value that is not one of these is refused at the front door rather than
discovered at the gate.

`plan` and `review` runs have a kind of their own that nobody chooses — `plan` proves it
wrote tickets (`issues_dir` in its Output), `review` that it wrote a summary a human can
read — and neither opens a merge request, so there is no gate to stop them. Their row is
read once when the run finishes, and what is missing is recorded on the run and shown on
the board and in `run show`.

## Metrics

```sh
collie --json run metrics <run-id>
```

What a Run actually did, from its own journal: time to the first collected verification,
how many passed, failed or were unstable and how many Collie ran itself, how many slices
landed, how much rework (fix rounds and halts), and the largest context sample any of its
agents reported. Plus the outcome it is being held to, what the evidence gate found
missing, and the obstacle where there is one.

Terminal activity is not on this list, on purpose. A changing pane says an agent is alive;
it does not say anything was produced. The pane clock is liveness; this is progress.

Nothing here is a limit. Counts, tokens, costs and timings are recorded and shown; none of
them refuses anything, and there is no quota to exceed.

**Obstacles.** Where one command fails several times in a row the same way — same exit,
same last line — Collie says so: on the record, in `run show`, and in the next prompt, so
the agent can change approach rather than repeat itself. It is a sentence, not a stop. A
counter reaching a number is not evidence that work cannot be done, and what prevents a
false claim of success is the evidence gate reading collected results.

## Checks

```sh
collie --json run checks <run-id>
```

Every check Collie ran for the Run, oldest first, and the one it is running now
([ADR-0042](adr/0042-a-check-collie-runs-is-seen-while-it-runs.md)). Each says its pass —
`gate`, `baseline`, `recheck`, `fix` with its round, `finish`, or a plain `check` — so
three runs of the same suite read as what each was for.

| Field     | What it says                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` | The check running now, or `null`: `name`, `pass`, `round`, the `revision` it runs at, `elapsedMs`, `usualMs` (the median of its last five runs in this repository, `null` for none), `others` (checks this host is running beside it), `base` (the default branch a `baseline` runs where the branch left), the `sentence` the card says, its `log` and `lastLines`. |
| `done[]`  | Each finished one: `name`, `pass`, `round`, `result`, `seconds`, the `revision` it ended on, when it ended (`at`) and its `log`.                                                                                                                                                                                                                                     |

Each check's output is written to a log in the Run's evidence directory as it arrives —
both streams, in the order they came — and kept after it ends, up to 8 MiB; past that the
log says it was cut. `running.log`, `running.lastLines` (its last 40) and each `done[].log`
say where it is.

```sh
collie run checks <run-id> --follow
```

`--follow` prints the running check's output as it is written and exits when the check
ends, with a line saying how it ended; with no check running it says so and exits. Under
`--json` the output goes to stderr and the envelope carries what the check ended as. The
board's **Open check output** opens a pane in the Task's workspace running exactly this.

## Report

```sh
collie --json run report [--since <iso-date>]
```

Where Runs end, across every Run the host knows, whatever workspace is selected. For each
workflow: how many Runs completed, failed, are suspended or pending, how many recorded a
merge request, how many a human stopped, how many decisions were answered or are still
open, and the rework and verifications summed from each Run's metrics. Then each Run that
failed, with its reason, each that completed, with its result, and each that was stopped.
`--since` keeps only Runs admitted at or after that date.

Like metrics, the report is data: no number in it is a threshold, and it refuses nothing.

## Verify

```sh
collie --json verify --run <run-id> -- bun test
collie verify --run <run-id> --name typecheck --cwd <path> -- bun run typecheck
```

Runs the command, watches its exit, and records the result against the run's tree — the
commit it was on and a digest of everything not committed, taken **before and after**.
That pair is the point: a pass on a tree that changed while the command ran says nothing
about either tree, so such a result is `unstable` and never `pass`. So is a tree too large
to fingerprint at all, because two unmeasured trees are not one tree.

What the command prints is shown as it runs — its stdout on stdout and its stderr on
stderr, or both on stderr under `--json`, where stdout is the one envelope — and the exit
status is the command's own, so a failure says why the first time.

| Flag       | What it does                                                                |
| ---------- | --------------------------------------------------------------------------- |
| `--run`    | Required. The run this is a verification of, and whose tree is snapshotted. |
| `--cwd`    | Where to run it. Must be inside that run's own checkout; defaults to it.    |
| `--name`   | What to call it on a card. The executable by default.                       |
| `--expect` | What a pass looks like: `pass` (default), or `fail` for a reproduction.     |

`--expect fail` is how a bug is proved to exist. A regression test that exits non-zero on
the tree before the fix is the evidence, so that record is a `pass`; the same command
succeeding is the reproduction failing, not the bug being fixed. Stability comes first
either way — a tree that moved under the command is `unstable` whatever was expected.

```sh
collie verify --run <run-id> --name regression --expect fail -- bun test test/bug.test.ts
```

### What Collie may run itself

An agent may `collie verify` anything; Collie runs only this run's
[approved set](../CONTEXT.md), matched argument for argument. The set is settled when the run starts — the `--verify`
entries given with it, else `.collie/verify.json` in the project, else the checks remembered
for the checkout's remote (`~/.collie/user/verify/<host>/<path>.json`, by `origin`, then
`upstream`), else `~/.collie/user/verify.json`, whichever is found first and taken whole — and copied into the run's Intent as its `run_verification` grant. Editing the file afterwards changes the next run and never a
running one. From then on the Intent is the set: `run intent verification` adds to it or
removes from it, and an Intent whose list has been emptied is a run Collie may run nothing
for — the seed is not put back behind the human who removed it. A Run of a workflow module
keeps its set with the host rather than in an Intent, and the same command amends it there.

```json
[{ "name": "tests", "executable": "bun", "argv": ["test"], "cwd": "worktree" }]
```

A file that is there and does not decode is an error naming it, never an empty set, and
the start is refused. So is a start of a workflow that [declares](sdk.md#what-a-definition-declares)
`verifies` when its outcome needs the set and nothing is approved: nothing could prove it,
so it is `invalid_input` with the repair, and no Run, worktree or Task is made.

```sh
collie run start implement --input plan=… \
  --verify '{"name":"tests","executable":"bun","argv":["test"],"cwd":"worktree"}'
```

Everything after `--` is the executable and its arguments, spawned directly. There is no
shell: what was written down is what ran. The command's own exit status is passed
through, so anything wrapping `collie verify -- bun test` behaves as it would around
`bun test`.

Results go to the run's `steering/verifications.jsonl`. An agent's Output saying the tests
passed is a **claim** and is shown as one; only a collected result is a verification.

A repository's checks are remembered from a Run that already has them:

```sh
collie run intent remember <run-id> [--replace] [--request-id <id>]
```

It writes the Run's current set, whole, to the file for its checkout's remote, and every
Run started in that repository later begins with it. It refuses a file that is already
there unless `--replace` is given. Chat does the same with `remember_verification`
([ADR-0035](adr/0035-a-repositorys-checks-are-remembered-by-its-remote.md)). Edit the file
to change the set, or delete it to withdraw it.

## Hold and release

```sh
collie --json run hold <run-id> --request-id "$(uuidgen)"
collie --json run hold --workspace <workspace-id> --request-id "$(uuidgen)"
collie --json run release <run-id> --request-id "$(uuidgen)"
```

`hold` stops a run taking on **new** work; whatever is already running carries on. The run
reads it at its next boundary and parks there, so work in flight finishes rather than
being cut off, and `run show` lists the `hold` under `controls`. It lasts until `release`:
nothing lifts a hold at a time.

`--workspace` holds every unfinished run of the Task that workspace belongs to instead of a
single run. Each run takes its own hold, so releasing one lifts that one and leaves the
rest held. `--reason "<why>"` is recorded with the hold, and the board's `heldBy` says it
beside who held it.

## Fork a workflow or a persona

```sh
collie --json workflow fork implement --layer user --name ours
collie --json persona fork reviewer --layer project --name strict-reviewer
```

| Flag           | What it does                                                                       |
| -------------- | ---------------------------------------------------------------------------------- |
| `--layer`      | `user` (where you save workflow modules) or `project` (this project's `.collie/`). |
| `--name`       | The id the fork takes; it wins over the one it forked from.                        |
| `--request-id` | Idempotency key.                                                                   |

A workflow is forked by importing it: the fork imports everything it does not name, so
there is nothing to merge and no step to pick. A persona is Markdown and is copied whole.

An existing file at the target path comes back as `target_exists` rather than being
overwritten. See [Authoring](authoring.md) for what the resulting file means.

## Envelopes

With `--json`, every command prints exactly one line: a success or a failure envelope. That
holds for a crash too — a defect is caught and reported as `operation_failed` rather than
leaving you an empty stream and an exit status. The exceptions are
[`run wait --follow`](#watch-a-run), which streams events and ends without an envelope when
the run finishes, and [`onboard`](#onboarding-a-machine), which prints a line per step
before its envelope. The examples on this page are indented for reading; Collie writes each on
one line.

Success:

```json
{"ok":true,"data":{ … }}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "run_not_found",
    "message": "Run \"nope\" was not found.",
    "details": { "run": "nope" }
  }
}
```

`details` is command-specific and always an object. Without `--json`, a success prints its
human line and a failure prints `error.message`.

### Exit statuses

| Status | Meaning                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `0`    | Success.                                                                                                                                |
| `1`    | The operation failed. Something happened, or tried to.                                                                                  |
| `2`    | The command line was wrong: `invalid_input`, `needs_input` or `workspace_required`. Nothing happened, so there is no receipt to replay. |

### Error codes

| Code                  | When                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_required`  | The command needs a workspace and none could be determined.                                                                                                |
| `workspace_not_found` | The `--workspace` id is not a workspace herdr has.                                                                                                         |
| `workflow_not_found`  | No layer defines that workflow.                                                                                                                            |
| `persona_not_found`   | No layer defines that persona.                                                                                                                             |
| `run_not_found`       | No run with that id, or none by that id in the Task this command is scoped to.                                                                             |
| `task_not_found`      | `--task` named a Task that does not exist.                                                                                                                 |
| `target_exists`       | A fork would overwrite a file that is already there.                                                                                                       |
| `needs_input`         | Inputs are missing; `details.inputs` says which, with their questions.                                                                                     |
| `timeout`             | `run wait --timeout` gave up.                                                                                                                              |
| `invalid_state`       | The run, or the installation, is not in a state where that makes sense — resuming one that already succeeded, or `upgrade --to` on a development checkout. |
| `invalid_input`       | A flag or argument was wrong.                                                                                                                              |
| `operation_failed`    | Anything else, including a caught defect.                                                                                                                  |

## Retrying safely

Every mutation — `run start`, `run answer`, `run stop`, `run resume`, `workflow fork`,
`persona fork` — accepts `--request-id`. Collie writes a receipt under its state directory
keyed by that id, so retrying the same id returns the original result instead of repeating
the effect. Generate one per intended action and reuse it for every retry of that action:

```sh
id=$(uuidgen)
collie --json run start implement --input plan="$PWD/plan" --request-id "$id" \
  || collie --json run start implement --input plan="$PWD/plan" --request-id "$id"
```

A receipt is reserved before the action starts. If execution is interrupted before its
result is saved, retrying reports `outcome: unknown` instead of running the action again.
Check the Run and its recorded effects before submitting a new request.

A failure carries the request id back in `error.details.requestId`, including when the id
was generated for you — so a failed send always leaves you something to retry with rather
than forcing a fresh id, which would be a second run rather than a retry. A `needs_input`
or `invalid_input` rejection writes no receipt, so the same id is free to reuse once you
have fixed the command.

Native chat returns `Request: <id>` with its result; pass that value as `request_id` to
retry. A partially applied sequence keeps its receipt even if its last action asks a
question, so retrying cannot repeat the earlier actions.

`run start` and `run answer` are the two worth being careful with: without a request id, a
retried `run start` is a second run.

## Settings

```sh
collie settings list
collie settings set <key> <value> [--request-id <id>]
```

`list` prints every one of Collie's settings as this Machine has it, with its default.
`set` sets one through the host, refused as the TUI's Settings refuses it; an empty value
unsets it. It is an edit made now, so a Desktop that shares settings with its Flock gives it
to every Machine: the latest edit of a key wins
([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)). Remembered answers and
anything else in `config.json` are not settings and are refused.

## Cleaning up

```sh
collie cleanup
collie cleanup --apply [--request-id <id>]
```

`cleanup` lists exactly what the host's sweep would remove now: one line per item with its
kind, what it is, its size and why it goes, then one line per thing Collie made and keeps,
with the one condition that keeps it, then the total a sweep would free. `--apply` sweeps
now, through the host, and prints what it removed and what it freed. There is no
confirmation: the host sweeps the same way on its own every ten minutes. What each kind
keeps, and why, is [ADR-0045](adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md);
[Cleanup](using.md#cleanup) says what a sweep covers.

Under `--json`, both answer with the same `data`:

```json
{
  "remove": [
    {
      "kind": "generation",
      "target": "/home/me/.cache/collie/entries/generations/…",
      "bytes": 81920,
      "reason": "unused for 8 days"
    }
  ],
  "keep": [
    { "kind": "worktree", "target": "/home/me/.herdr/worktrees/…", "reason": "uncommitted changes" }
  ],
  "bytes": 81920
}
```

`remove` is what a sweep would remove, or, with `--apply`, what it removed, each with the
bytes it freed; `bytes` is their total. A thing a sweep could not judge — herdr not
answering, say — is in `keep` with that reason, never removed.

## Upgrading

```sh
collie upgrade
```

Pulls first where the installation is a checkout (`--ff-only`), then runs `prepare.sh` —
the one routine every entry point ends in, so this brings the plugin link, the runner and
shim, the operator skill and the skills up to date together rather than replacing the
runner alone. A pull it cannot do is reported rather than installed over. A runner
`install.sh` downloads replaces the one there only once its signature checks out
([Build and release](internals.md)). Otherwise an install with bun builds the runner from
source, and one without keeps the runner already there and the `runner` step fails.

The report names what moved: the commit range where the checkout advanced, and one line
per preparation step saying whether it was done, was already in place, or was skipped —
so "nothing to do" reads differently from "the runner updated but the skills step could
not run". A skipped step is not a failure: `upgrade` still succeeds. Under `--json` the
same steps are in `data.steps`.

The last step, `desktop`, brings [Collie Desktop](using.md#collie-desktop) on this computer
to the version `upgrade` moved to, where this user has a released Desktop installed that
is older. It downloads that release's Desktop update and stages it where Desktop's own
updater would (`$XDG_DATA_HOME/dk.cego.collie.desktop/stable/self-extraction/`, else under
`~/.local/share`), only once its tar verifies against the release key, as Desktop's own
updates are checked. A Desktop that is running is never replaced underneath it: the step
says the update "applies when you restart Desktop", and Desktop announces it as ready within
a minute. Otherwise it installs when Desktop next starts. An update already staged that is
newer, by Desktop's own download or an earlier `upgrade`, is never replaced by an older one,
and one it replaces has its tar removed. A download that does not verify is not
staged, and the step is `failed` with the reason. A Desktop already at the version is
`already in place`, so Desktop upgrading this computer to its own version changes nothing.
There is no `desktop` step where no released Desktop is installed, where Desktop runs from
a checkout, or on a platform Desktop is not released for (only `linux-x64` is).

```sh
collie upgrade --to 0.27.0
```

Moves a released install to exactly that version (fetching tags, then resetting to the
tag), and reports the same way, with `data.version`. A development checkout — on a branch
other than `master`, detached on a commit that is not a release, with uncommitted changes,
or ahead of its remote — is refused as `invalid_state` with the reason, and its checkout is left as it was.
A host's `identity` names such a checkout's build as `development: "<version>+<sha>"`.

## Onboarding a Machine

```sh
collie onboard [--to 0.27.0] [--secrets-stdin] [--skip helle] [--skip linear] [--gitlab-host <host>]
```

Takes a Machine from bare to a working Collie host, and repairs a half-onboarded one: every
step looks before it acts, so running it again does only what is missing. `--to` is the
release to install, this runner's own version when it is not given. Nothing runs sudo.

Its GitLab is one host: `--gitlab-host`, else `GITLAB_HOST`, else the
[`gitlab_host` setting](using.md#your-defaults), `gitlab.cego.dk` by default. The token
page, the glab login, the push and the closing doctor all name that host.

| Step           | What it does                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`       | Checks for `git`, `curl` and an OpenSSL 3.0 or later (which checks a downloaded runner's signature; LibreSSL and 1.1 cannot). Any missing stops here with `needs_root` and the exact command; an older OpenSSL gets one only where a package gives OpenSSL 3 (EPEL's `openssl3` with dnf, `brew install openssl`), and otherwise needs OpenSSL 3 or bun installed by hand |
| `collie`       | Clones `https://github.com/cego/collie.git` (or `COLLIE_REPO`) into `~/.collie` (or `COLLIE_DIR`) and resets `master` to the tag, so a plain `collie upgrade` can still pull; or moves a released checkout to the tag as `upgrade --to` does                                                                                                                              |
| `herdr`        | `curl -fsSL https://herdr.dev/install.sh \| sh`, if there is no `herdr`                                                                                                                                                                                                                                                                                                   |
| `claude`       | Anthropic's user-level installer, `curl -fsSL https://claude.ai/install.sh \| bash`, if there is no `claude`                                                                                                                                                                                                                                                              |
| `path`         | Adds `~/.local/bin` (and `COLLIE_BIN_DIR`) to PATH in the shell's profile (`~/.bashrc`, `~/.zshrc` or `~/.profile`)                                                                                                                                                                                                                                                       |
| `plugin`       | `prepare.sh`: the plugin link, the runner and shim, the operator skill and the skills. A runner `install.sh` downloads is installed only once the release key's signature (`<asset>.sig`) checks out                                                                                                                                                                      |
| `claude-login` | `claude auth login` in this terminal, if `claude auth status --json` says Claude Code is not logged in; without a terminal, `needs_human` with that command                                                                                                                                                                                                               |
| `gitlab`       | `glab auth login --hostname <host> --stdin` with `GITLAB_TOKEN`, if glab is not already logged in there, or is logged in with another token than the one given. Without a token: `needs_human`, with the token page and its `api` and `write_repository` scopes as `url`                                                                                                  |
| `push`         | Generates `~/.ssh/id_ed25519` if there is none and registers it with `glab ssh-key add`, unless the Machine can already push (over HTTPS with glab's login, or with its own key). GitLab's host key is trusted on first use, and a key GitLab already has counts as registered                                                                                            |
| `helle`        | Writes `HELLE_API_TOKEN`, and `HELLE_API_URL=https://helle.cego.dk` for other Helle clients, to Helle's credentials file, owner-only; with no token given and no file, `needs_human`, saying how Slack's `/helle token` makes one                                                                                                                                         |
| `linear`       | `claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp`, then `claude mcp login linear-server` in a terminal of its own, whose URL is streamed: the one it prints, or the one with its callback port it hands `$BROWSER`, which a shim writes down                                                                                        |
| `doctor`       | [`collie doctor`](#checking-an-installation); onboarded means it is ready                                                                                                                                                                                                                                                                                                 |

A development checkout — the one this runner belongs to when that is a checkout, or
`COLLIE_DIR` — is judged as [`upgrade --to`](#upgrading) judges one, and gets the checks
only and the logins: nothing is installed and its checkout is not moved.

Secrets are never arguments. `--secrets-stdin` reads `KEY=value` lines from stdin —
`GITLAB_TOKEN` and `HELLE_API_TOKEN` — and the token reaches glab on its
stdin too. Helle and Linear count toward onboarded unless `--skip` names them; a skipped
step reports `skipped`. Doctor's own checks for them stay optional.

Each step prints a line when it starts and one when it ends. Under `--json` each is a JSON
line, then the envelope:

```json
{"event":"start","step":"system","title":"Checking for git, curl and openssl"}
{"event":"result","step":"system","status":"needs_root","detail":"git must be installed as root; run the command, then onboard again","command":"sudo apt-get install -y git"}
```

A step that needs the human in the middle of it streams a `human` line first, as the Linear
login does with its URL and the local port its redirect comes back to:

```json
{
  "event": "human",
  "step": "linear",
  "detail": "open this to let Claude Code reach Linear",
  "url": "https://mcp.linear.app/authorize?…",
  "port": 62074
}
```

In a terminal the login also takes a pasted redirect URL. Chat can propose an onboarding
too (the `onboard` action, with an optional `skip`); nobody is watching that stream, so its
logins are left as `needs_human` steps rather than started.

`status` is `done`, `in_place`, `skipped`, `needs_root`, `needs_human` or `failed`; a
result may carry the `command` to run by hand and the `url` to open. The envelope's
`data.ready` is true only when every step ended `done`, `in_place` or `skipped`, and
`data.steps` repeats every result; otherwise it is an `operation_failed` that lists what is
left, and the exit status is 1. Re-running is the retry.

## Checking an installation

```sh
collie doctor
collie doctor --json
collie doctor --gitlab-host gitlab.example.com
```

Every prerequisite in one pass, each with the command that fixes it: herdr present and at
least the `min_herdr_version` the plugin manifest declares; the plugin linked from this
installation; the runner built and the `collie` shim on PATH (installed-but-not-on-PATH is
its own reported state); every skill and every harness
the loaded workflows and personas name; whether the checkout is behind its remote; the
Projects root and its source — `projects.root`, `GITTE_CWD`, or the home directory, the last
a `!` warning that never fails the run; Claude Code logged in, from
`claude auth status --json`, where `claude` is on PATH; and, for the one GitLab host Collie
works against, `glab` present and logged in there, the token's expiry — a `!` warning within
14 days of it and a failure once it has passed — and whether this Machine can push there,
over SSH with its own key, or over HTTPS where glab configured git to use it. An agent sshd
forwarded into the session does not count, since it goes when the computer it came from
sleeps. That host is `--gitlab-host`, else `GITLAB_HOST`, else the
[`gitlab_host` setting](using.md#your-defaults). Any other host glab knows is named in one
`other gitlabs` note, unchecked, and never fails the run.

**Disk** covers each filesystem holding the state directory, `~/.cache/collie`, herdr's
worktrees and the temporary directory, once each. One with less than 10% or 5 GiB free is a
`!` warning naming it, with what [`collie cleanup`](#cleaning-up) would free where a host has
served this state directory, and `collie cleanup --apply` as the fix. It never fails the run.

Two more are optional, and reported rather than required. **Helle**, where a loaded
workflow waits on it (`renovate` does): the credentials file the Helle MCP wrapper sources,
`~/.config/helle/env` (or `HELLE_ENV_FILE`), whose token is tried against
`https://helle.cego.dk`'s `/me`; a `HELLE_API_URL` line in it is ignored. **A
Linear MCP server in Claude Code**, where a workflow routes a step to Claude: user and
local scope in `.claude.json`, project scope in the project's `.mcp.json`, matched by name
or URL. Each has three states, and the glyph says which: `✓` there and working, a note
with the setup command when it is not set up at all, and `!` — set up and not working, a
file without a token, a token Helle refuses, a settings file that is not JSON —
with the file to look in. Neither ever fails the run: the bundled `implement` and `review`
need neither. A run that does need one is refused at `collie run start` with the same
detail and fix, before any tab opens.

The skills and harnesses come from the loaded definitions rather than a list in the code,
so a forked workflow naming a different skill is checked against that one. Every executable
it looks for has to be executable, not merely present: a shim without its bit set fails
with permission denied at the point of use, which is the confusion this command exists to
end. It fetches before answering whether the checkout is behind, because you are waiting
on it.

It exits non-zero when a prerequisite is missing, so it can gate a script of your own. A
checkout that is merely behind its remote is not one of those: it is reported, with
`collie upgrade` under it, and the run still passes — the same line the Control Plane
shows rather than sends. `--json` carries the same checks as data. `setup.sh` ends by
running it, and exits with its status: the last word of an install is either that
everything is ready, or what is missing and how to fix each one.

## The local workflow host

```sh
collie host --dir <state-dir>
```

The process durable work runs in. Nobody is expected to type this: a client that needs a
host and finds none starts one, detached, and leaves it running — so the work outlives the
command, the board or the chat turn that asked for it. Typing it is how you watch one in a
terminal.

One host owns one state directory, and the pid lock beside its SQLite decides which. Start
four clients at once and they converge on one owner; the three hosts that lost the lock
exit without touching anything. A lock left by a host that crashed is broken and taken
over — by its recorded start time, so a pid that now belongs to an unrelated process is
never adopted and never signalled.

Clients talk to it over a unix socket in that same directory, with Effect's own RPC: the
same schemas at both ends, and nothing listening off this machine. It answers `identity`,
`discover`, `load`, `registrations`, `status`, `run`, `runs`, `watch`, `recover`, `offers`, `grant` and `steer` — one
registry, in front of as many clients as ask. `run` and `runs` are the read model the front
doors show; `watch` streams it, current state first and a whole state each time; `recover`
registers what current files now allow and hands over what is outstanding. One fiber in the
host asks the engine about the work it has not finished, on a schedule every client shares,
and speaks up when anything a run shows has changed, so watching costs the same whether one
client is looking or the whole board is. Closing a client cancels nothing it started;
stopping the host with `kill` leaves suspended work suspended, and the next client starts a
host that picks it up.

The operations above are `HostRpcs`: internal, and a Collie client of another build stops
before sending them anything. Beside them on the same socket is `FrontDoorRpcs`, the door
any front door uses whatever its build or computer, declared with its Schemas in
`src/board-model.ts`. `board` streams the board: a `Snapshot` (the state directory's
`installation` id, `build`, `development` — `<version>+<sha>`, only where the host runs a
development checkout — `protocol`, the `herds` — every running herdr session, by Herd
`id` and herdr's `name` — and every TaskView), then an `Upsert` or a `Remove` keyed by Task
id for each change, each with a `seq` higher than the last. A client that reconnects gets a
fresh snapshot. The host builds again when anything under its state directory is written,
when herdr pushes an event from any of its sessions (a pane opening or closing, or an
agent's status changing), and every five seconds. The installation id is written once, by
the first host to own the directory, and survives restarts and upgrades.

The host also runs what nobody has to have a pane open for: the merge watch, which asks
GitLab about each waiting merge request every 5 minutes and records a merge; each Herd's
News, which it also supersedes once an item's cause no longer holds; and the
[cleanup](#cleaning-up) sweep, every ten minutes.

The operations that change a Run are on `FrontDoorRpcs` too: `start`, `answer`, `control`
(a hold or a stop, set or cleared, and every watcher hears about it), `resume` and
`invoke` (an offer). Two reads tell a front door on another computer what those take:
`offers`, what a Run offers to do next as its module decides now, with each offer's
arguments as JSON Schema; and `workflows`, what may be started in a project and the Inputs
each asks for. `start` then takes what a human typed in `text`, and the host settles it
against the workflow's own schema. `cleanup` reads what a sweep would remove and keep, and
`sweep` sweeps now, recorded with its Actor in the state directory's `cleanup/operations.jsonl`
as well as in `cleanup.jsonl`. `grant` and `steer` stay on `HostRpcs`. Each takes a request id, and the same id twice is one operation. A
channel first sends `declare` with its front door, and the host stamps every operation on
it with that, as a line in the Run's `operations.jsonl`: the operation, the request, the
Actor and what came of it ([ADR-0039](adr/0039-every-operation-records-who-asked.md)). A
channel that declares nothing is `cli`. `declare` may also carry `session`, the herdr
session socket the front door runs in: a confirmed, asked or proposed action looks its
workspaces, panes and Herd up there. A channel that names none has them looked up in the
session the host was started from. A `chat` channel may carry `conversation` and `said`,
the human's message that turn as its tool host heard it; the host puts both in the Actor of
everything done on that channel, the executors' own operations included.

```sh
collie bridge --as <board|desktop|chat> [--client <name>]
```

A front door on another computer reaches the host through this, run on the Machine — over
SSH for Desktop, or spawned without it for Local. It starts the host if none runs, handing
it the state directory and the herdr session socket (asked of `herdr status server` when a
login shell sets none), declares the channel as the front door it was started as, prints
`collie-bridge-ready` on a line of its own, and from then on copies bytes between its stdio
and the host's socket. Whatever came before that line is a login shell's and is discarded.
The declaration is the bridge's: a `declare` of another front door on the channel is
refused, and the client at the other end never starts, stops or signals a process.
`desktop` is a human, as `board` and `cli-tty` are, and its Actor carries `from`: the
`--client` name and the SSH client address the bridge saw.

So are the ones that write anything else: `confirm` (a proposal's id and content hash) and
`decline` (its id and content hash too), recorded in its Herd's proposals journal under the Actor; `dispose`,
what became of a Run's work; `steerAbout`, which has the evaluator turn free words about a
Run into actions and carries them out; `followUp`, which starts the follow-up the Run's
Workflow declares; `propose`, which records what chat was asked for as a proposal and
carries it out; `act`, which carries out the board's own actions on a Run (`stop`, `resume`,
`release`, `hold`, `answer`, `deliver`, `followup`, `start`) with no proposal, anything else
being refused as `propose`'s; `reconcile`, which settles a proposal step nobody can account
for; `settleDelivery`, which does the same for a message to an agent; `focus`, which focuses
a Run's newest live agent, or its workspace, on the host's own herdr and answers with the
session, workspace and tab it is in; `setSettings`, which writes the Flock's settings into
the Machine's `config.json`, each with its own edit's time and only where that is later than
the Machine's own last edit of the key, records when each was set in `settings-set.json`
and, when Desktop asks, that a Desktop gave them, and refuses the whole batch over any value the TUI's Settings
would refuse ([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)); `settings`
reads them back, each with when it was set; and `news`, which
hands one conversation its Herd's pending News, each item with its Significance, and
records it `read`, `sent` or `uncertain` for that conversation alone. Given `keys`, it hands
over every pending item and records only those keys: what Desktop's Flock chat actually
gave the model, out of a batch it put together across Machines. Actions travel as
JSON and the host decodes them. `collie confirm`, `decline`, `steer`, `run disposition`,
`proposal reconcile`, `run deliveries --reconcile` and `chat news --sent`, the board and
chat's tools all go through these, so the host is the only writer of what they record
([ADR-0040](adr/0040-the-host-is-the-only-writer.md)).

`runDetail` streams one Run's details while a drawer is open — intent, plan, review,
log tail, verifications, metrics, steering cards, the files it kept as evidence, its diff
and its merge request — current first, then again whenever they change. The diff is the
Run's branch against its merge base with the default branch, per file: the checkout as it
is while the Run works, the branch's commits once it has ended. The host keeps that in the
Run's directory as soon as the Run ends, with the branch head it was taken at, so a merged
branch or a pruned checkout does not lose it and a resumed Run that committed more is read
again. An untracked file reached through a link, or that is not a regular file, is listed
without being read. The review's findings come as
a list. The merge request is what the merge watch last read, asked again after 5 minutes or
when `refreshMr` is set. Large items are fetched by reference with `runFile`: `log`,
`review`, `diff:<path>`, `evidence:<name>`, `verification:<id>`, `plan:<file>`, `file:<path>` (read
only, from the Run's checkout) and `pipeline:<url>` (the status glab reads for that pipeline), text as it is and anything else as base64. Each answer is
at most 4 MiB from `offset` (or `length` bytes where asked) and says the item's whole
`size`, so a long log or a video is read in parts. A part of an item is base64 whatever it
is, so a character split across two parts is whole once they are joined. A reference is refused where it leaves
the directory it belongs to, links followed, or where it is not a regular file.

`protocol` is an integer, also in `identity`. An optional field, a new operation or a new
kind of message does not change it, and a client reads a kind it does not know as
`Unknown` and skips it. A removal or a change of meaning bumps it, and from then on the
host serves its current version and the one before; version 1 has none before it.
Version 2 changed two meanings: a `chat` channel's repeated `declare` replaces the words it
speaks with rather than being ignored, and `news` with `keys` settles only those. A version
1 client repeats no declaration and sends no `keys`, so it is still served as before.
Desktop's Flock chat writes through no host older than version 2, and says so.

`discover` and `start` name the project asking, because one host serves the machine and a
project's own `.collie/workflows` is its own: two projects can run different implementations
of one public id at the same time, each on its own registration.
[`sdk.md`](sdk.md#where-a-module-lives) is where a module is saved and when an edit takes
effect.

`start` carries the author's input in two halves — `input` for values that already have a
type and `text` for values as a human typed them — and `options` for the host's own names
beside them. The module's own schemas settle all of it there, because that is where the
module was loaded; what they refuse is `invalid_input` naming the field, and the row keeps
what they settled rather than the text it arrived as.

`start` also names the caller's `request` — its own id for the work it is asking for — and
answers with the run that claim became. Sending it again is that same run rather than a
second one, whether the first attempt was answered, lost, or interrupted by a host that
died mid-start; sending it with other arguments is `RequestConflict` rather than a quiet
change of mind. A host that died after asking for the run's checkout or workspace, and
before recording what it got, cannot tell whether one was made: that start is refused
with what may be left behind, and keeps its claim, so the same request never makes a
second one. The rows behind that are in the same SQLite file as the engine's own, and
[ADR-0017](adr/0017-one-request-is-one-run.md) is why each of them is there.

It says which build it is, and which installation it serves. A client newer than the host,
from the same installation (after `collie upgrade`), stops it and starts itself in its
place. Any other client of another build is told which build is running and which pid to
stop, and sends nothing else. That includes a checkout under development, which is pointed
at a state directory of its own rather than replacing the installed host. Such a
checkout's host also says `development: "<version>+<sha>"`; a release's does not.
A host that cannot be started at all is `HostUnavailable`, with whether anything owns the
directory. [ADR-0015](adr/0015-one-local-host-owns-a-state-directory.md) is why each of
those is the way it is.

`COLLIE_HOST` names the command a client starts a host with — one path, or a JSON array of
the executable and its arguments. Unset, it is this executable.

`COLLIE_HOST_CRASH_AT=admitted|executed` is for the recovery proof alone: the host kills
itself in one of the two windows a start has — with the run recorded and the engine not yet
told, or told and the receipt not yet written — so that recovery is demonstrated rather
than argued. Nothing else sets it.

## Authoring against the SDK

`workflow create` and `workflow fork` write `package.json`, `tsconfig.json` and
`collie.d.ts` beside the module, and install the toolchain with the executable's own
embedded Bun — so typechecking a module needs neither Bun nor Node on the machine. A
`package.json` or `tsconfig.json` already there keeps everything of yours: the `effect` and
`typescript` it lacks and the `collie` path mapping are added to it. One that is not plain
JSON is left alone, and the answer says what to add. `workflow check` typechecks each module and
reports each diagnostic with its file and line; an error in one module says nothing about
the one beside it. With nothing installed to check with, that is `ok, not typechecked`
rather than a module reported as fine.

The `effect` the toolchain pins is the one the host runs, and at runtime the executable
serves its own `effect` and `collie` to the module it loads, so what an author typechecks
against and what executes are the same Effect.
