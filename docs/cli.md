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
| `--machine <name>`  | Reach that paired Machine, by herdr's name for it.                 |
| `--log-level <lvl>` | `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `none`. |

```sh
collie --json --workspace wT run start plan --input goal="ship it" --input then=
```

`--machine` is for a command that names no Run: `board`, `run start`, `run list`,
`schedule` and `cleanup`. A
command that names a Run needs none (see [Another Machine's Runs](#another-machines-runs)).
A start on another Machine opens its own Task there, so `--task`, `--continue-task` and
`--here` are refused with it, and the module is the one that Machine has saved.

## Another Machine's Runs

A Run id names one Run, so a command about one goes to the Machine that has it: `run show`,
`run wait`, `run steer`, `run answer`, `run hold`, `run stop`, `run resume`, `run action`,
`run follow-up`, the Run's records (`output`, `metrics`, `cards`, `drift`, `disposition`,
`deliveries` and `checks`), Intent edits and `verify` ask this Machine's host first, then each paired Machine, then each
machine herdr lists that is not paired yet, pairing it on the way. The envelope is the one
the command gives at home; `run show` adds `machine`, the Machine the Run is on. A Run no
Machine has is `run_not_found`, and its `details` name every Machine asked (`machines`) and
any that did not answer (`away`).

Intent edits, override clearing and remembered checks execute on the owning host, with
the caller recorded. `verify` runs inside its checkout and streams output back.
`run checks --follow` streams that host's live log; paths it returns belong to that Machine.

Adding a Machine to herdr (`herdr machine add`) is all it takes. The first command that
reaches it opens this computer's SSH connection to it, as
[`collie machine connect`](#collie-machine) does, which asks for that login's approval
once, where the command runs, and pairs the two through it; from then on the Machines talk
over a TLS WebSocket the dialled one listens for on port 47217. A connection already
open, as one Desktop opened, is ridden and nothing is asked. A pairing whose connection has gone before it asks fails with what ssh said; it never logs
in by itself. Removing the Machine from herdr forgets the pairing on both sides. A host's
own jobs never start an SSH login, so a Machine no command has reached yet is
`invalid_state` for them: not paired yet.

A command that reaches a Machine whose link waits on an SSH connection (`waits` in
[`machine list`](#collie-machine)) opens one the same way, then reaches it once more. A
host's own jobs — Schedules, reports, settings and definitions sync — open nothing: theirs
is `machine_unreachable` with `details.waits` `ssh_connection`, naming
`collie machine connect <name>`.

The receiving host records each operation as the front door that asked — `cli`, or
`cli-tty` for a person at a terminal — with `from.machine` naming the Machine it came from
(the installation id and the name it was paired under).

### `collie machine`

```sh
collie machine list
collie machine connect <name>
collie machine invite --for <installation> --name <name> [--address <host>]
```

`list` names each Machine paired with this one, which side dials (`out`: this one dials it;
`in`: it dials this one), and whether it answers now. Its `data.machines` is each one's
`installation`, `name`, `dials`, `url`, `build` (last read, or null), `state` (`live`, `connecting` or `away`), `since`
and `failure`, never the secret. `data.build` is this Machine's build. A listener that could not take its port says why in
`failure`. Each also says which way its link goes, and what each way saw:

- `transport`: `direct` or `ssh` for a live link, else null. The side that is dialled
  says what its dialler declared.
- `direct`: what the direct way saw when it last failed; a live `ssh` link keeps why
  direct failed.
- `ssh`: what the SSH way saw when it was last tried and failed.
- `connection`: for a Machine this one dials, whether this computer holds an SSH
  connection to it; null for one that dials in.
- `waits`: `ssh_connection` while the link is not up because direct failed and no SSH
  connection is open, else null.

Each is null in an older Machine's answer. The human line puts the transport after the
state, as `live	ssh (direct: <why>)` or `live	direct`, and a link not up as
`connecting	direct: <why>; ssh: <what it saw>`.

**Over SSH by itself.** Each connect tries the peer's port first, bounded to five seconds.
Where that fails and this computer holds an SSH connection to the Machine, the link goes
through a tunnel that connection forwards, with the same pinned certificate and secret.
Its channels and dial-backs go the same way while it is up, and its next connect tries
direct again. The host never logs in: with no connection open, the link waits, and
`machine list` says what opens one.

`connect` opens this computer's SSH connection to herdr's machine by that name, where
none is open: one `ssh` master with `ControlPersist`, under the user's SSH config, whose
login prompt or SSO banner shows on this command's stderr. ssh keeps it open after the
command returns. It is bounded to two minutes, after which it is `machine_unreachable`
naming the Machine and the last thing ssh said. It then wakes this host's link to that
Machine, so the link does not wait out its backoff. Its `data` is `machine`, `path` (the
control path) and `opened`, false where a connection was already open. A name herdr does
not list is `invalid_input`.

**Closing.** Each time the host reads herdr's machines — at start, at `machine list`, and
when a link comes up — it ends every SSH connection under its state directory that is not
the one for a machine herdr lists now, with `ssh -O exit`: a Machine herdr forgot, after it
is told and forgotten, and one herdr lists at another target. It opens none for the new
target. Where herdr cannot say, nothing is closed.

`live` means the control link is up. `connecting` names the dialler's last failure while
it retries. `away` says when the listener lost its peer's control link and why. A call
to an away Machine is `machine_unreachable`, with its name and what was seen, within
five seconds. After sleep, the dialling host reconnects without an SSH login.

`invite` is plumbing: it is what pairing runs on the other Machine over SSH, and nobody
types it. It makes this Machine's certificate the first time (with `openssl`, an EC P-256
key, its names and addresses and `--address` on it), mints a secret for the installation
asking, keeps the pairing and starts the listener. Its `data` is this Machine's
`installation`, the `port`, the `certificate` and the `secret`.

## Where a run roots

A run is rooted at the directory Collie is standing in. To run against another repository,
pick one of:

- `cd` into it.
- Set `COLLIE_CWD=<path>` — the working directory for the picker and the agents, and the
  root of a CLI run.
- Pass `--workspace <id>`, which re-roots the run at that workspace's directory as well as
  scoping to it.

`collie run list` lists local and live peers' Runs with their `machine`. Its JSON includes
`machines`, naming any peer that was away. A selected Task narrows local Runs to that
Task; peer Runs stay visible. `--machine` lists only that Machine. See [Tasks](#tasks).

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
input with its strategy and its schema (a `default` there is what an input left out takes),
the names the host settles beside your input, the schemas of its result and its failure,
and what its definition declares, under `metadata`, its `path` of Steps among it:

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
      "metadata": {
        "hints": { "plan": "work-source" },
        "selectable": ["feature", "…"],
        "path": [{ "id": "build", "title": "Build" }, "…"]
      },
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
installed in that directory — never silence. Where the `effect` installed there is not the
host's, as after an upgrade, it provisions the toolchain again before typechecking. It
exits non-zero for problems, so it fits a pre-commit hook.

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
| `--title <t>`     | What a new Task is called, instead of a name inferred from the work.        |
| `--verify <json>` | Repeatable. A check Collie may run to prove it, as one `verify.json` entry. |
| `--harness <h>`   | The harness this Run's agents run on, over the workflow's own preference.   |
| `--model <m>`     | The model this Run's agents run on, over the workflow's own preference.     |
| `--effort <e>`    | The effort this Run's agents are asked for, over the workflow's own.        |
| `--attach <file>` | Repeatable. A file to give the Run — see [Attachments](#attachments).       |
| `--request-id`    | Idempotency key — see [Retrying safely](#retrying-safely).                  |

`--harness`, `--model` and `--effort` reach every agent the Run starts, and its children,
without the workflow doing anything for them; a piece of work that names its own still
wins. They are resolved together before anything starts, so a model the harness does not
take is `invalid_input` naming what it would take. [Which agent does the
work](sdk.md#which-agent-does-the-work) is the whole order.

### Attachments

```sh
collie --json run start plan --input goal="the picker is cut off" --input then= --attach shot.png
collie --json run steer <run-id> "this is what it does now" --attach after.png
collie --json run action <run-id> carry-on --input work="still cut off" --attach log.txt
```

`--attach` names a file to give the work, and is repeatable on `run start`, `run steer`
and `run action`. A relative path is resolved against where the command runs; the CLI
sends the absolute path and uploads nothing, so the file has to be on the host's Machine.
The host copies each into the Run's own `runs/<id>/attachments/` — a copy, never a link —
before its first step, or for a steer before the message is delivered, and every step's
prompt lists the Run's attachments with their paths
([`sdk.md`](sdk.md#what-every-step-prompt-is-given)). A steer's message gains an
`Attached: <path>` line for each file it brought. A Run started from another — a
follow-up, a child, an implementation of a plan Run — starts with copies of that Run's
attachments. Two files of one name and different content are both kept, the later under a
short sha256 prefix.

A path that does not exist, is not a regular file, cannot be read or is larger than
100 MB is `invalid_input` naming it, before anything is claimed: no Run, Task, worktree or
workspace is made. The files are part of the request: at the host, the same request id with other
attachments is `RequestConflict`, and with the same ones it is the same Run. The CLI
answers a `--request-id` it already has a receipt for from that receipt, before the host
is asked, so there it is the first Run whatever is attached. They are not
an Input, so the Workflow's own input, and with it the execution, is the same either way.
The operation's line in the Run's `operations.jsonl` names each file under `asked`, by the
name the Run keeps it under and the path it came from. Chat's `start`, `followup`,
`take_offer` and `deliver` actions take the same paths as `attachments`
([ADR-0046](adr/0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md)).

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

`collie verify -- <command>` records against a module's Run as it does
against any other: the same collector, the same binding to the tree the command ran on, and
the same refusal for a directory that is not that Run's. A module can ask for one itself,
but only for one of the Run's checks: those it started with, or one named since with
`run intent verification` or chat's `set_verification`.

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
collie --json run answer <run-id> yes --decision keep [--request-id <id>]
collie --json run hold <run-id> [--request-id <id>]
collie --json run release <run-id> [--request-id <id>]
collie --json run stop <run-id> [--request-id <id>]
collie --json run resume <run-id> [--request-id <id>]
collie --json run steer <run-id> "check the migration too" [--to builder] [--request-id <id>]
```

- **`--decision` names the question** where a module is waiting on more than one; leave it
  out and the one open question is answered, and being asked for is refused where that is
  not exactly one. A value the question does not take is refused with what it does take;
  one it takes is taken in any case, so `YES` answers `yes`.
- **One answer settles it.** A second is refused with what the Run already has; the same
  `--request-id` again is the same answer rather than another.
- **An agent's question is answered the same way.** A Claude agent Collie launched that
  calls `AskUserQuestion` is told its question is on its Run and ends its turn. Each
  question is a decision named `ask-<operation>-<n>`, numbered from 1 in the order asked,
  whose prompt lists its options. It takes any words, an option's label among them. Once
  every question of that one call is answered, from here, the card or chat, the answers
  go to the agent together as its next message. While one is open, the step's Output
  budget is paused. One still open when the step's Output comes is closed with
  `closed: <operation> finished before it was answered`, and nothing is sent
  ([ADR-0062](adr/0062-an-agents-question-is-asked-on-its-run.md)). A question no step is
  waiting on — the Run finished, parked, or the agent between steps — is put on its Run
  and its answer sent back all the same, numbered under the work it was given last. One still
  open once its agent is gone is closed with `closed: <agent> is gone`. With no host
  running for the state directory, nothing can put it on the Run, so the agent is let ask
  in its pane instead.
- **A control reaches one Run.** Its siblings and the host carry on. A control over a Run
  whose module is not loaded here is recorded and says so, naming the file to repair,
  rather than reporting a success nothing can stand behind.
- **`run stop` parks the Run and stops its agents where their work runs.** A Codex
  agent's turns run in the App Server Collie started for it, so its stop drains that
  server, interrupts every running turn on it, a sub-agent's included, and waits thirty
  seconds for the server to be gone, then two more for what it started. Agents are
  stopped one after another, and a stop already under way for the same agent is waited
  for first. Nothing is signalled twice, however often it is stopped. Only an agent that is
  then **Quiet** has its pane closed and is reported as stopped; Claude, Pi and OpenCode
  run in their panes, and closing the pane is their stop. An agent that is not Quiet makes
  the stop fail, naming the agent, its thread and turn ids, its server's endpoint and pid,
  and how far it got (`submitted`, `acknowledged` or `failed`); its pane stays open and
  its record is kept ([ADR-0059](adr/0059-a-stopped-agent-is-stopped-where-its-turn-runs.md)).
  The Runs it started are stopped the same way; the workspace keeps its own tab.
  `run resume` clears the stop and picks the Run up again, giving work whose agent has
  gone to a new one — once the agent it replaces is Quiet. A restart beside a Codex turn
  that has not stopped parks instead, with `parked` naming the agent's thread, turn and
  server, and starts nothing; resume again once that server has stopped. A stop that lands
  while an agent is being started stops that agent too, so the stop leaves none running.
  It also reaches an agent whose start herdr never admitted: its App Server is stopped to
  Quiet the same way, though its pane, which Collie never learned, stays open.
  On a Run that has already finished, a stop only stops its live agents: no control is
  set, the status stays what it finished with, and with nothing alive it says nothing was
  running.
- **A Run parks itself when its agent's pane will not take a prompt.** herdr answering
  `agent_blocked` for ten minutes leaves the Run `suspended`, with `parked` in its view —
  and in `run show` — saying what held, for how long, and where the prompt is. `run resume`
  hands that prompt to the same agent rather than starting another.
- **A Run never waits for its checks.** Where nothing written down names any, its agent
  names them before it builds with `run intent verification`, through the host, and Collie
  runs them at the gate without asking anyone
  ([ADR-0055](adr/0055-a-run-never-asks-to-run-its-checks.md)). A Run parked at the old
  evidence gate by an earlier build goes on with `run resume`.
- **A Run's agents live in its Task's workspace**, opened by the start that made the Task.
  A stop closes only its agents' panes there. If herdr has closed that workspace by the next launch, it
  is reopened on the Run's checkout and the Task records the new id; with the checkout gone
  too, the Run parks with `parked` naming both and the way back. `run resume --workspace`
  does not move a Run: `--workspace` only chooses where the command looks, and the resume
  says so.
- **`run steer` says something to the Run's agent** through the one sender, with the same
  incarnation and harness-capability checks as every other delivery. With no `--to`, it
  goes to the agent whose step is active, else the builder; `--to builder|reviewer|planner`
  names a role and `--to <agent>` an agent, and `--operation` still names one by its
  operation ([steering](steering.md#who-a-steer-reaches-and-what-it-says-came-of-it)). It
  tells you whether the agent was seen to take it: `Delivered to <agent> (observed: <how>).`,
  or `Sent to <agent>, not observed.` with how to go to its pane, and `data.observed` and
  `data.how` say the same. An unproven `now` mode keeps the message durably until the agent
  is idle, returning `data.queued: true, data.delivered: false` with an explicit queued
  receipt. The host submits it automatically without answering any Run Choice.
  Other messages not sent are `operation_failed`, with why. The agent sees who sent it on its
  first line. A message whose typed form would pass 3 lines or 700 characters is kept whole
  as a file in the Run's `attachments/`, the agent is told where to read it, and the
  receipt says to ask for an action auto mode must clear in a shorter message
  ([steering](steering.md#the-paste-budget)). A finished Run's live agent takes one as a running Run's
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
into, the review of that, the release of its merge request. A Task's work is what its Runs
worked on, read from their records: each branch one was placed on, and each merge request
one opened or was given. A fresh start about that work is that Task's, and opens in its
workspace wherever it was started from: one whose diff target names one of the Task's merge
requests, whatever state the Task is in, or one about a branch of an open Task's — the
branch it is placed on, or the one its diff target names; never merely the branch the
caller is standing on. Where several Tasks have it, the one whose Run had it first wins. A
start that joins a Task this way has no parent. Any other fresh start is a new Task, and
gets a herdr workspace of its own, created and never focused. The default branch names no
one piece of work, so a start on it alone is always new. Chains,
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
that Task's local Runs and live peers' Runs; elsewhere it lists every reachable Run. A Run is reachable by id from the
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
5. For a run given another Run's own plan directory (`<state>/runs/<id>/plan`), the branch
   that Run's Task was placed on, used as it is and cut from its remote tip, so the run
   joins that Task. Not once its merge request has merged or closed: the run's own name
   then names a fresh branch.
6. The plan directory's own name, for a run given a plan directory that is no Run's own.
7. A slug of the work itself — the description, or the issue id. Never a Run's own plan
   directory, whose path names nothing.
8. Otherwise a slug of the run's own name.

The login is the checkout's forge's (ADR-0050 D5). On GitLab it is `GITLAB_USER_LOGIN`
where the environment sets it, and otherwise whoever `glab` is logged in as for this
checkout's host; on GitHub it is `GITHUB_ACTOR`, and otherwise whoever `gh` is logged in
as. Neither is the merge request's assignee
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
collie run start review --input target=https://github.com/acme/app/pull/30 --input plan= --input proves=
collie run start review --input target=worktree --input plan= --input proves=
collie run start implement --input plan=ENG-123 --input then=
collie run start plan --input goal="one registry" --input then= --input workspace=projects-root
```

`plan` takes `goal` and `then`. `then=implement` builds the plan as soon as its tickets are
written, with nothing asked of anyone; empty, its end menu is asked
([`plan`](workflows.md#plan)). `implement` takes `plan` and `then`: `then=release` releases
its merge request on a human's go, `finish` ends at the merge request, and empty asks
([`implement`](workflows.md#implement)).

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
          "meaning": "The change to review: mr:<iid>, mr:<host>/<group/project>!<iid>, mr:github.com/<owner>/<repo>#<n>, a merge request or pull request URL, <owner>/<repo>#<n>, branch:<base>...<head>, or worktree",
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
collie --json run wait <run-id> --until ready
collie --json run wait <run-id> --until needs-human
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
of waiting for a notification that has already been and gone. `run show` lists the handoff notes the Run's agents left under its `handoffs/` directory,
by path (`data.handoffs`), and the replies it posted to reviewers, each with when, the merge
request, the comment's URL, whether it was `fixed` or `disputed`, and its body as posted
(`data.replies`). It names the module file the Run is on, and a
Run whose module has been deleted still reads, pending, with that file named: its history
is Collie's rows, and none of them went anywhere. `run list` shows those Runs beside the
rest; where the host will not start it says so and still lists the others.

A run that stops to ask a question is **not** ended, so a plain `run wait` waits straight
through it. `--until attention` is the wait that does not: it returns as soon as the run is
suspended — at a question, held, stopped or parked — or has ended, whichever comes first,
and returns immediately when that is already true. A Run that parked its own work while
its status is still `pending` counts too. `--until terminal` is the default spelled out.

`--until ready` returns once the Run is Ready to release (see `ready` below). When what is
missing can only be moved by a human — the Run is at attention, or it has ended and nothing
missing may still come by itself — it ends instead as `invalid_state`, naming what is
missing. `--until needs-human` returns at either: ready, or nothing will move without you.
Both ask the host for the Run's readiness every two seconds; the envelope they return
carries it as `data.ready`. A host that cannot say five times running, such as an older build, ends the wait as `operation_failed`. Any other value is `invalid_input`.

Answer what the wait returned with `run answer <run-id> <option> --decision <name>` — see
[Answer a question](#answer-a-question).

`--follow` streams instead of returning one envelope: one newline-delimited
`{"type":"status","run":…}` line each time the run's status changes, carrying the same
`run` object as `run show`, and one line for each other change, with the Run's id as `run`:
`{"type":"operation","operation":…,"agent":…,"state":"started"|"finished"}` for an agent's
Operation, which a Step may hold several of or none,
`{"type":"agent","agent":…,"operation":…}` when an agent is launched,
`{"type":"parked","reason":…}`, `{"type":"awaiting","on":…,"who":…}` when it starts
waiting for something that comes by itself, `{"type":"mr","mr":…}` when the merge request opens and
`{"type":"ci","ci":…}` when the forge's pipeline changes state. Without `--json` each is
one line: `run-1a2b: operation 01-a.md finished`, `run-1a2b: parked: …`, `run-1a2b: CI running`. Failures still arrive as a normal envelope — a timeout, or a
run the host could not watch — so a consumer reads each line as JSON and branches on
whether `type` is present.

`run show` is the Run as the host has it. Beside `run`, `data.ready` is Ready to release
for this Run — `ready`, and `missing[]`, each a `fact` (`succeeded`, `leads`, `mr-open`,
`not-draft`, `checks`, `ci`, `review` or `mergeable`), what is `said` of it, and whether it
is `settling`, may still come by itself — or `null` from a host that cannot say. A Run that
does not lead its Task's card is never ready. `data.flow` is the **Flow** of the Run's Task,
the same whichever of its Runs you asked for, and the same value its details carry to
Desktop: `lanes`, one row per Run of the Task, oldest first, with its `execution`, the
`startedBy` Run and Step of a child started into the Task, and its `nodes` — each Step's
`state`, the `wait` holding it up, the one fact line it `said`, its `attempts`, `questions`,
`ranOn`, the `link` to a child started as a Task of its own and, for a Step called per item
or round or a fan-out's Repo runs by `wave`, its `runs`; then `current`, the node the
leading Run's work is at, `null` once the Task has settled; and `release`, the merge
request's CI, Merged and furthest deploy, `null` until there is one
([ADR-draft-a-step-is-declared-where-its-work-is-written](adr/draft-a-step-is-declared-where-its-work-is-written.md)).
A Step's `links` are Runs its agents started, without expanding those Runs' Steps.
Each node's `usual` is a duration in milliseconds or null until three completed
calls exist on this Machine for the same Workflow and Step. The median uses the
last ten calls, counting each item and round separately. `long` is true while a
running call exceeds twice its usual time. `data.flow.notice` names that current
Step and its elapsed and usual times; it is null otherwise. These are observations
and do not change the card's section or sentence.

`pause` records who armed a pause and when, or is null. `notes` holds ids, authors,
times, text and read times (null until read). Chat and CLI can arm a hold with
`before`, deliver a note with `step`, or `withdraw_note` before it is read. A
failed resumable Step also offers `retry-noted`, a note followed by resume.
Their `link.asOf` is null for live local state, or the last admission or settlement
notice from a paired Machine. `run.linkNotices` records those deliveries on the started
Run; human output names undelivered notices. A missed notice is not retried or polled.

Each node's optional `primary` names its first action and `actions` lists the rest,
without repeating it. A lane's `actions` are its own Run controls. `agent` names the
latest agent launched in that Step; open `questions` carry their Choice `id`, text
and options. A supplied forge address is in `url`. These are the same capabilities
Desktop draws, recomputed on every read. Their state-changing routes are:

| Action                | Route                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `retry`, `resume`     | `run resume <run>`; a linked Run's retry names `link.run`                                  |
| `answer`              | `run answer <run> <value> --decision <questions[].id>`                                     |
| `proposal`            | `confirm <proposal.id>` or `decline <proposal.id>`                                         |
| `continue`, `release` | `run release <run>`                                                                        |
| `hold`, `stop`        | `run hold <run>` or `run stop <run>`                                                       |
| `tell`                | `run steer <run> --operation <agent> <text>`                                               |
| `start`               | `run action <run> <offer-id>`                                                              |
| `follow-up`           | `run actions <run>`, then `run action <run> <follow-up-offer> --input <work-field>=<text>` |

`terminal` addresses `agent` in the inspector's live Terminal, through the bridge's
existing `focus` route and herdr's pane controller. `open` follows `url`, or opens
the record named by `link`. A terminal Workflow error has no retry: the engine
cannot resume it. A resumable failed Step records its failure and parks, keeping
the completed work before it.

`log` and `evidence` open those inspector parts. A node's `log` is the one-based
line of its latest run's start marker in `log.txt`; each item or round carries its
own. `why` holds at most twenty lines of the failing command and output, or the
failure reason. `evidence` counts the Step's Verifications. Verification records and
RunDetail's verification list carry optional `step` and `place`, so another Step's
checks are never presented as this Step's proof. `RunDetail.logStart` is the first
absolute line in its bounded log tail.

Its `run` object carries:

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
| `awaiting`                               | What it waits for that comes without anyone repairing anything: `on`, `who` acts (`null` for nobody) and `since`, or `null`. It is not attention, and `run wait` waits through it.                   |
| `diagnostic`                             | Why the engine could not be asked about it — a module that is missing, with the file named — or `null`.                                                                                              |

Beside `run`, `data.startedBy` says who started it, as the Run's record says it: "Started by
schedule `<name>` for <occurrence>", "Started from chat", "Started from Desktop", "Started
from the board", "Started from the CLI", or, for a child, "Started by <parent run> as
<invocation>". It is `null` where nothing recorded who did, and the human output prints it
under the Run's inputs.

`data.agents` lists every agent the Run started, in launch order: `operation`,
`agent` (its herdr name), and the `harness`, `model` and `effort` it ran on, read from the
launch records (`model` and `effort` are `null` where a launch recorded none). The human
lines say the same, one per agent: `  review  claude/opus xhigh`. An operation that reused a
running agent names the agent it reused. `from` is the choice the work fell back from, where
its **Subscription** was Exhausted or past the workflow's `upTo`, and `why` says which window
and when it resets; both are `null` otherwise
([ADR-0049](adr/0049-work-goes-to-an-agent-with-usage-left.md)). The human line then reads
`  review  codex/default (fell back from claude/opus: session 100%, resets 15:45)`. Where
nothing in the `fallbacks` chain had room, the work stays on its preferred agent with only
`why` set, saying when each Subscription resets:
`  review  claude/opus (nothing has room; claude/opus: session 100%, resets 15:45)`.

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
| `decision`                | The question or proposal waiting on you, or `null`. One of the two ways into Needs you.                                                                         |
| `questions[]`             | Every question the Task's Runs have open, in the order the card asks them; `decision` is the first unless a proposal waits. Absent from an older host.          |
| `agents[]`                | The live agents on it, its Repo runs' included.                                                                                                                 |
| `children[]`              | Its plan's repositories, in wave order: `repo`, its `run` (`null` until it starts), its `state` (`done`, `active`, `blocked`, `failed` or `todo`) and its `mr`. |
| `mr`, `mrState`, `branch` | What it is building, where it can be read, and what the forge last said about the merge request; a single-repository fan-out's is its Repo run's.               |
| `disposition`, `landed`   | What became of the work, the latest on any of its Runs, recorded by a person or by the merge watch, and whether it needs nothing more, which is Finished.       |
| `ended`                   | When the leading Run ended, or `null` while it has not.                                                                                                         |
| `planReady`, `offer`      | A finished plan nobody has implemented, and the offer its card's first action invokes.                                                                          |
| `checks`                  | What checked an open merge request: `passed` or `failed` (with `name`) at revision `at`, `running`, or `unchecked`; else `null`.                                |
| `ready`, `readiness`      | Ready to release: the forge would merge it now. `readiness` names each fact missing, as `run show`'s `data.ready` does.                                         |
| `check`                   | The check Collie is running for the leading Run, as `collie run checks` gives `running` (with its `log` and `lastLines`), or `null`.                            |
| `reopened`                | A finished Run whose agent took a steer after it ended: the `delivery`, the `agent`, the first line it was `told` and its `status` now; else `null`.            |
| `run`, `runs[]`           | The Run a card acts on, and every Run of the Task.                                                                                                              |
| `flow`                    | The card's **Flow** strip: `glyphs`, the leading Run's then the Release row's, `release`, how many are the Release row's, and `current`, or `null`.             |

A fan-out finds its plan from its work source even where the kind was never recorded with
its input, as for an implement Run started from a plan's end menu: a plan directory is the
plan, so `children` lists every repository it names, those not started as `todo`.

## Credentials never go in a goal or a steer

Every operation that carries words to a Run — `run start` (its goal, Inputs and
constraints), `run intent set-goal` and `add-constraint`, `run steer`, `steer`, a follow-up,
`run answer`, and the same actions through chat and the board — has any credential-shaped
value replaced by its kind before the host records or forwards it. It is never refused for
one. The result says so in its text, and in `--json` as `redacted`: the kind of each value
taken out, `[]` or absent where there was none. Give an agent a credential through its
forge login instead ([Using Collie](using.md#credentials-never-go-in-a-goal-or-a-steer)).

## Answer a question

A run waiting on a question reports `status: "suspended"` and lists it in `waiting` with
`answer: null`. Relay the question and its options as written, then send the answer,
naming the question:

```sh
collie --json run show <run-id>                            # read waiting
collie --json run answer <run-id> "Implement now" --decision next-1 [--request-id <id>]
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
collie --json run stop <run-id> [--request-id <id>]
collie --json run resume <run-id> [--request-id <id>]
```

`stop` parks the run where it is — at its next boundary, or inside the wait it is in. It
enters no further Step, files or comments on no issue, and ends a check the host or one of
its agents is running, with that check's processes; a resume runs the host's check again.
It closes its agents' panes, and those of the Runs it started, which is what stops them; the
workspace keeps its own tab. Only the process each launch recorded is closed, never another
under the same name, and a pane that will not close fails the stop and names the agent
still running. `resume`
asks the host to pick a suspended run up again. It re-enters the workflow's current code
and reuses every Activity already done, so completed work and its Outputs are kept and
never redone, and an agent still live is reattached to rather than started a second
time; one a stop closed is started again with the prompt it had, once its predecessor is
Quiet — otherwise the run parks again, saying which server may still be writing. A launch
that cannot say whether its agent started or was given its work — herdr refused or timed out
the start, could not list its agents, or the step's prompt did not go out — parks the same
way, naming the prompt file, since a resume lists herdr's agents again and takes up the
agent or starts it. The host
registers the modules as they are now, then clears the stop before waking work. A
restored module is picked up without restarting the host.

Resume succeeds only when the host wakes suspended work or recovers this Run's unfinished
admission or unavailable module into the engine. It clears the old park note before work
starts; if work parks again, the new reason is shown. Take-up does not promise completion.
A Run already running, finished, failed, or still missing its module returns
`operation_failed` and a nonzero exit. A missing module's file is named. So does a stopped
Run whose merge request has merged, as its card reads the landing: the work is done, and
waking it could only redo answered Steps or give back a claim. It stays stopped, and
the refusal says so in every front door. A stopped Run whose merge request is open, closed
unmerged or absent resumes as before.
Repeating the same request returns its recorded result; a fresh request judges the Run again.
Delivery reconciliation remains explicit: `not-sent` permits one resend, while `sent` waits
for Output. An unresolved delivery stays uncertain.

A finished execution keeps its recorded result; `resume` does not reopen its steps. Use
the Run's follow-up action to continue unfinished work on the same Task and branch.

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
verification` names one of the run's checks through the host (below).

```sh
collie --json run start implement --input plan=./plans/steering \
  --goal "land steering behind the existing envelope" \
  --constraint "rule:protected_paths:src/**,test/**" --severity block \
  --constraint "no new dependencies"

collie --json run intent show <run-id>
collie --json run intent set-goal <run-id> "<goal>" [--request-id <id>]
collie --json run intent set-outcome <run-id> feature
collie --json run intent add-constraint <run-id> "<text>" --severity block
collie --json run intent remove-constraint <run-id> <constraint-id>
collie --json run intent authority <run-id> auto_correct=true --propagate
```

Version 1 is the workspace's defaults, then what the work source itself asks for, then
what `--goal` and `--constraint` named — later beating earlier where they name the same
constraint. For a plan directory the work source's ask is read from its `SPEC.md`: the
bullets under a heading matching `Requirements`, `Success criteria`, `Boundaries`,
`Constraints`, `Out of scope` or `Done when` become `warn` constraints carrying the file,
heading and line each bullet starts on; an out-of-scope bullet reads `Out of scope: <bullet>`.
A constraint is the whole bullet: it runs until a blank line, a heading or the next bullet at
its indent or shallower, and its wrapped lines and the bullets nested under it are joined
into it with single spaces. An Intent already seeded keeps what it stored, unless it
follows its own `plan/SPEC.md` as below. In a
Run on a worktree of its own, its `plan/SPEC.md`, written by its planner, is read the same
way at every work boundary: new bullets are added, dropped ones are removed, and a
constraint anyone but the plan removed stays removed. **No text ever grants authority** —
not a plan, not the repository, not a prompt.

`set-outcome` changes the [outcome](#outcomes) a live Run is held to: `feature`, `bug`,
`refactor`, `investigation`, `docs` or `migration`, or `unspecified` to clear it. Any other
word is refused with `invalid_input`, and so is a Run whose workflow always proves one kind.
Chat makes the same change with `update_intent`.

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

The one amendment that is not a `k=v` word is a check, a command Collie runs itself:

```sh
collie run intent verification <run-id> --name unit -- bun test
collie run intent verification <run-id> --name unit --remove
```

It is bound argument for argument — `bun test` and `bun test --bail` are two different
checks — and `--cwd` is `worktree` or a path relative to the run's cwd. Anyone may name or
withdraw one, the run's own agent included, and nobody approves it. A check whose name a
`rule:command_exit` constraint refers to is run once, at the run's finish, so that rule is checked against a result rather than against nobody having
looked. Everything else on `steering/verifications.jsonl` is written by an agent calling
`collie verify`, and is recorded `by: agent`.

`--propagate` applies the amended Intent to every child run that is still going: the
child's own constraints are kept, the parent's are replaced, and anything the two disagree
about is reported rather than resolved. A child inherits its parent's constraints and goal
at birth, never its authority, which is per run.

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

| tool                  | What it does                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collie_herd`         | Every run in the Herd, bounded, saying how many it left out                                                                                                                                                                                  |
| `collie_run`          | One run: its goal, constraints, the Choice it waits on and how to answer it, its answers with who and when, its result, the Runs it started, its merge request and branch, plan, findings, disposition, last log lines, cards and open drift |
| `collie_workspaces`   | The workspaces this session has (the Home marked as no checkout), the Tasks whose workspace is open, the Projects root, and each workflow with its Inputs                                                                                    |
| `collie_receipts`     | What one run waits on the human for — its Choice and proposals — and what state each message to its agents actually reached                                                                                                                  |
| `collie_definitions`  | The Workflows and Personas there are; one resolved and checked, or one Persona's body                                                                                                                                                        |
| `collie_installation` | What Collie needs, which workspace the Home is, what a cleanup would close, the defaults                                                                                                                                                     |
| `collie_news`         | What this conversation has not been told; reading it settles those items for it                                                                                                                                                              |
| `collie_hold`         | Hold a run, or every unfinished run in a workspace, until someone releases it                                                                                                                                                                |
| `collie_do`           | Carry out, at once, a board action or decision on a named run the human asked for                                                                                                                                                            |
| `collie_propose`      | Carry out the rest of what the human can ask for, with a request id that makes retries safe                                                                                                                                                  |

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
`answer`, `deliver`, `followup`, `take_offer` and `start` — through the same closed union, the same
last-moment admission check and the same executors a confirmation runs. `take_offer` takes
one of a run's offers by the id `collie_run` lists, with what its own arguments take as
`inputs`, as `collie run action` does: the offer is decided again as it is taken, one the
run no longer makes is refused with why, and the answer names the run it started. It also takes the
board's decisions, which are not actions on a run: `confirm` a waiting proposal by its id
and the hash `collie_receipts` lists beside it, `decline` one by the same two, and `disposition` to record
what became of a finished run's work. It answers a line per action saying what each one
came to. A kind outside that set is refused with the name of the tool that does take it:
amending an Intent, forking a definition, changing the defaults, keeping a run's checks for
its repository, a cleanup and an upgrade are `collie_propose`'s.

A `start` names its workspace by id, label, a checkout's path on this Machine, or a
repository's directory name under the Projects root (or `projects-root`). A path that is no
directory here is refused as that, with the Projects root; any other name that matches
nothing says what was searched. A workspace inside Collie's state directory — the Home's —
is refused as Collie's own namespace, not a checkout
([ADR-0033](adr/0033-a-run-started-from-the-home-is-placed-not-asked.md)).

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

## Acknowledging a finished Run

```sh
collie --json run seen <run-id>
```

A Finished Task whose leading Run succeeded by itself with a summary, and has no
disposition, is [Unseen](../CONTEXT.md) until someone opens or acknowledges it. `run seen`
acknowledges it: the Run's host records who and when once, in the Run's own record beside
its disposition, and every board in the Flock reads it from there. Asking again, under the
same request id or another, records nothing new and answers with the first record. The
board, a herdr action and an agent's `collie_do` `seen` go through the same operation.

Reading a Run records nothing: `run show`, `collie_run` and the Flock chat's turn about it
leave it unseen. A Run that ended before its host first started recording seen counts as
seen; that host writes the moment into its state directory, as `seen-since`, once.

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

| `outcome`       | What closes it, beyond the run's checks passing on the final tree                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(empty)_       | nothing more. Unclassified work is not a feature by default.                                                                                                                                                                                                  |
| `feature`       | the tickets it built are named, every check a ticket's `**Checks:**` line promised has a passing verification, and the review says the agreed scope was met                                                                                                   |
| `bug`           | one `regression` command, the same executable and arguments, recorded with `--expect fail` on a tree before the fix and passing after it                                                                                                                      |
| `refactor`      | the review says behaviour was preserved                                                                                                                                                                                                                       |
| `investigation` | a conclusion, references inside the run, and whether there is a patch at all                                                                                                                                                                                  |
| `docs`          | the documented commands, run as written, each with a passing verification                                                                                                                                                                                     |
| `migration`     | `migrate-up` and `migrate-down` (or `rollback`) both passing                                                                                                                                                                                                  |
| `performance`   | a [`final` Measurement](#measure) of the current tree against the merge base its merge request targets, a `gain` on the primary metric with every guardrail held, and the review says behaviour was preserved and the measurement is valid, of that same tree |

`performance` is fixed by a workflow and never asked for: starting `implement` with
`outcome=performance` is refused naming the kinds it may be asked for. A guardrail counts as
held only where its verdict is not `inconclusive` either. A `performance` Run whose tree is
its latest base tree again, every change reverted or dropped, ends without a patch and with
its findings, not failed; that is read from the trees (the Git tree its `HEAD` names and its
fingerprint against the latest Measurement's base tree), never from an Output. Its card and
`collie run show` name its latest `final` Measurement with its verdicts, and so does the
evidence a merge request is written from.

A reference inside the run is under its own directory or its checkout, or, for a run given
another Run's own plan directory, under that Run's directory, where its handoffs are.

Only a reviewer can move one kind of gap: the review's own verdict, `scope_met` for a
feature, `behavior_preserved` for a refactor, `supported` for an investigation, `accurate`
for docs, `compatible` for a migration, and both `behavior_preserved` and
`measurement_valid` for performance. Performance's two count only from a review of the tree
in front of the gate, which the workflow records beside the review (`reviewedOn`). A check that has not passed, or a reference
outside the run, is not a reviewer's to change.

A text search proves none of the rows above: a pass of `grep`, `egrep`, `fgrep`, `rg`, `ag`,
`ack` or `git grep`, also as the first word of a `sh -c` or `bash -c` script, shows the text
is there, not that anything works. A promised check, `regression`, documented command or
migration step whose only pass on the tree is a text search is a gap that says so. The record
stays in the journal, an agent may still run one for its own use, and the run's own checks,
which are the project's configured commands, are left alone. A bug reproduced by one command
and fixed by another is a gap naming both, each with the path its executable resolved to, so
a fix knows which one to run again. For `bug`, the same command is the executable as it was
asked, such as `bun`, with the same arguments in the same directory: a fail through a version
manager's shim and a pass through the binary it points at are one command, and the
environment each was recorded with still says which runtime ran. A record kept before the
asked executable was compares by the path it resolved to. Whether a record ran one of the
run's checks is still decided by the resolved path.

The gate runs before the merge request, which is where the claim is made. Collie runs the
run's own checks itself at the tree as it stands, reading them again at every pass, then
says what is missing. A check
that failed and named its failing tests has each of them run once more alone (`rerun`); one
that passes is a Flake, which is neither a gap nor a pass and is named in the merge request.
A failure outside any test, such as a file's `afterAll` (bun's `(unnamed)`), cannot be run
alone, so a check that has one names no tests.
A check that failed naming no tests runs once more whole (`recheck`). Gaps a check could
still close go to the implementer for up to four fixes. Checks still missing after those
fixes suspend the Run with the gaps named, except where a fix changed nothing and disputed
every finding it was handed: the gate then logs `outcome unproved` and goes on to the merge
request, which names each disputed gap with the fixer's reason.
Repair the checks and resume the Run: a check whose latest record on the tree failed runs
again, and so does one whose pass was collected in another environment or before this host
started. Every pass but a `rerun`, which always runs — gate, recheck, fix, finish and the proof — runs a check only where
nothing already answers for it: it relies on the latest record of exactly that check's
command on the same tree, where it is a pass collected in the same environment by this
host, whoever asked for it, and logs `<pass>: <check> relies on verification <id>`. So a
check that passed on a tree is not run again
on that tree, and nor is one whose every failed test there was a Flake or fails at the base too.
Nor is a check that failed on a tree run again on it after a gate fix that left the tree as
it was: the round is read from the records already there, and the proof's whole `recheck`
is only for a check whose failures named no tests and that has had none on that tree
(ADR-0034, amended 2026-10-19). A changed tree or set of checks also gets fresh proof while
completed build Activities are retained. A missing review verdict gets a fresh review, and no other gap does;
if the outcome is still unproved, the Run fails with the gaps named and a follow-up
can repair the work; implement offers one after success or failure on a branch. Apart from
that disputed gate fix, the merge request is reached only once the outcome is proved. Only the latest
record of a check's exact command on that tree counts, whoever asked for it, so a
pass a later fail contradicts is not one, and a record that only shares the check's name
is not the check. In `implement`, each test a failed check still fails on after its rerun
is run alone before any fix, where the branch leaves the default branch, in the run's own
checkout, once per base revision. The merge request names each test that fails there too,
and a check whose every such test does is not handed to a fix. A check whose failures name no
tests has no baseline and remains required on the Run's tree: its exit code at the base
cannot show whether the branch added different failures. If merge request handling is unavailable,
the Run suspends with the reason instead of completing without delivery. A run with no
check named is not passed — an empty set would make the gate say yes to anything — and
that is a gap the implementer closes: each gate fix is told to name the repository's checks
with `collie run intent verification`. Still none after the fixes, or every one withdrawn,
and the Run is held like a check that still fails; naming one with `collie run intent
verification <run-id> --name … -- <command>` and then `collie run resume <run-id>` proves
it again.

An investigation that concludes there is nothing to change skips the merge request with a
note and finishes. That is a real outcome, and nothing is invented to have something to
merge.

`plan` settles the outcome during its interview and forwards it, so a chained build is not
asked again. A value that is not one of these is refused at the front door rather than
discovered at the gate. A wrong one is corrected with `collie run intent set-outcome`
while the Run is live: each build and criteria turn, each review round, each gate pass and
the merge request read the kind as it stands then, and the merge request names the kind the Run was finally held to.
A dispute never changes the kind by itself.

`plan` and `review` runs have a kind of their own that nobody chooses — `plan` proves it
wrote tickets (`issues_dir` in its Output), `review` that it wrote a summary a human can
read — and neither opens a merge request, so there is no gate to stop them. Their row is
read once when the run finishes, and what is missing is recorded on the run and shown on
the board and in `run show`.

For an `implement` Run's final delivery, the checkout's forge — its `origin`'s host, else
`upstream`'s — decides: GitHub's adapter writes `gh` commands and GitLab's `glab` ones,
and the prompt names no other CLI. Both front doors ask the same host service for
readiness, assignee, template, Linear tickets and this branch's open merge request.
The commands quote repository, branch and assignee values so the shell passes them literally.
Readiness requires the forge's CLI installed and logged in to its host, and on GitHub able
to read the repository. An existing merge request on the branch is updated rather than
given a second one. Before every step that pushes — each build, fix round and gate fix,
and delivery — the host reads the branch's open merge request. Where it merges itself once
green, the step starts no agent: the Run records `not pushed: auto-merge is on for <url>`
and parks as Needs you until auto-merge is off and the Run is resumed. Where the forge
cannot be read, the step starts no agent either: the Run records `not pushed: whether it
merges itself is unknown: <why>` and parks until it is resumed with the forge readable.
`review`'s fix round is held to the same rule. The commands contain no command substitution: GitLab's
description and note are read from the file by `glab api` (`-F description=@<file>`).
An unavailable forge parks the Run with the repair it needs.
A delivery agent that did not push, supplied no merge request URL or reported findings
fails the Run with the reason and a follow-up repair; it cannot report successful delivery.

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
`gate`, `rerun` of one failed test alone, `baseline`, `recheck`, `fix` with its round,
`finish`, or a plain `check` — so three runs of the same suite read as what each was for.

| Field     | What it says                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` | The check running now, or `null`: `name`, `pass`, `round`, the `revision` it runs at, `elapsedMs`, `usualMs` (the median of its last five runs in this repository, `null` for none), `others` (checks this host is running beside it), `base` (the default branch a `baseline` runs where the branch left), the `sentence` the card says, its `log` and `lastLines`. |
| `done[]`  | Each finished one: `name`, `pass`, `round`, `result`, `seconds`, the `revision` it ended on, when it ended (`at`) and its `log`.                                                                                                                                                                                                                                     |

Each check's output is written to a log in the Run's evidence directory as it arrives —
both streams, in the order they came — and kept after it ends, up to 8 MiB; past that the
log says it was cut. `running.log`, `running.lastLines` (its last 40, including a short
log's first lines) and each `done[].log`
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

The JSON report's `runs` list includes each Run's `runId`, `workflow`, `parent`,
`project`, `created`, and `status`, in admission order.

Then the measures a change to Collie is judged by, under `measures` in `--json`. Each one is
counted from what the Runs in the window recorded, and each names the Run ids it counts
(`runs`), so an issue can cite them. Chat reads the same report through `collie_report`.

| Field           | What it counts                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rounds`        | Runs with a review rally (a review allowed more than one round): `runs[]` with the round each `reached` and its `cap`, the `median` round (`null` for none), and `atCap`, the Runs that reached their cap.                                                   |
| `dispositions`  | `merged`, `superseded` and `abandoned`, each a `count`, its `runs` and its `share` of the three (`null` where none was recorded).                                                                                                                            |
| `steering`      | `runs[]`: each Run's `steer`, `followup`, `deliver` and `correction` counts and `byOrigin`. `byOrigin`: who asked — `human` (the board, Desktop, a terminal), `chat`, `agent` (an agent or a non-interactive CLI) and `host` (Collie's own corrections).     |
| `verifications` | `total`, `runs[]` with each Run's `total` and how many an `agent` and `collie` collected, `byCollector`, `repeated` (same Run, check, start tree, result and collector as one before it) and `executableOnly` (named only by its executable, such as `bun`). |
| `parks`         | `byReason`: each park's `reason`, with the Run, pane, path and command it named taken out so like counts with like, and `collectExpiries`: an agent that had written nothing when its collect budget ran out.                                                |
| `peakContext[]` | Each Run's largest context sample at a work boundary, in `tokens`, and the `agent` it was on. A sample, not tokens consumed; `null` is not recorded, and is never estimated.                                                                                 |

Every field before `measures` is unchanged. A park is recorded as a `halt` line in the Run's
metrics each time it parks, or parks for a different reason, and a context sample as a
`context` line wherever Collie samples a reused agent's context at a work boundary. A Run
from before those were recorded counts none of either. The text caps each list at 20 lines and each list of Run ids
at 10.

Like metrics, the report is data: no number in it is a threshold, and it refuses nothing.

## Verify

```sh
collie verify -- bun test
collie --json verify --run <run-id> -- bun test
collie verify --name typecheck --cwd <path> -- bun run typecheck
```

From a Run's agent pane, `--run` can be left out: the Run is the one whose agent the pane
is, found as for any command an agent runs there — herdr's agent list says which agent the
pane holds, and the host says whose Run that agent is. Anywhere else, without `--run`, it
fails `invalid_input`: `verify needs --run outside a Run's agent pane.` A `--run` given
explicitly always wins.

Runs the command, watches its exit, and records the result against the run's tree — the
commit it was on and a digest of everything not committed, taken **before and after**.
That pair is the point: a pass on a tree that changed while the command ran says nothing
about either tree, so such a result is `unstable` and never `pass`. So is a tree too large
to fingerprint at all, because two unmeasured trees are not one tree.

What the command prints is shown as it runs — its stdout on stdout and its stderr on
stderr, or both on stderr under `--json`, where stdout is the one envelope — and the exit
status is the command's own, so a failure says why the first time.

| Flag       | What it does                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--run`    | The run this is a verification of, and whose tree is snapshotted. Defaults to the Run whose agent this pane is.                                                      |
| `--cwd`    | Where to run it. Must be inside the run's checkout, including one it was given later — a review's fix moves it to the reviewed branch's; defaults to it.             |
| `--name`   | What to call it on a card. By default the script it runs (`bun run typecheck` is `typecheck`), else the tool and its subcommand (`bun test`), else the tool (`tsc`). |
| `--expect` | What a pass looks like: `pass` (default), or `fail` for a reproduction.                                                                                              |

Every record carries the **environment** it ran in: a digest of the executable's real path
and content, the `node` and `bun` that `PATH` resolves to, again by path and content, and
`PATH`, `NODE_ENV` and `NODE_OPTIONS`. A gate relies on an earlier pass only where this
matches, so an upgraded toolchain is a fresh run. A record from before environments were
recorded has none, and is never relied on.

A command that is exactly one of the Run's checks — the executable as resolved, its
arguments and its directory — is never run by `collie verify`: only the gate runs a Run's
checks ([ADR-draft-a-runs-checks-are-run-by-its-gate](adr/draft-a-runs-checks-are-run-by-its-gate.md)).
Where this tree has a record of it — the latest one, collected by this host in the same
environment, whoever asked for it, passed or failed — `collie verify` answers with that
record: it says `not run again: verification <id> of "<check>" passed on this tree` (or
`failed`) and names the record's log, exits with the record's exit code, and its `--json`
envelope is `{ "verification": <that record>, "ran": false }`. Where the tree has none, it
refuses with `invalid_state`, naming the gate: Collie runs that check itself, on the final
tree. `--expect fail` makes no exception, and a human's `collie verify --run` is answered as
an agent's is. Any command that is not one of the Run's checks runs, and its envelope has
`"ran": true`; no script name is special.

While the Machine is [Short of memory](using.md#short-of-memory), the host holds the
command before it runs, reading again every 15 seconds: `collie verify` first prints
`waiting for memory on <Machine>: <a> of <t> GB available`, then runs it once the Machine
is no longer short. Its result is the command's, unchanged. There is no flag to run anyway,
and a human's `collie verify` waits as an agent's does. A stop of the Run ends the wait
with `invalid_state`, and the command never runs. While a verify an agent asked for waits,
that agent's Output budget does not run.

Before the command starts, a check of the same Run that an earlier host left running is
ended: `collie verify` first prints `check <name> (pass <pass>) of <run> (pid <pid>), left
running by host <pid> (started <time>): ending it before this check starts`. One that is
still running after its SIGTERM and SIGKILL refuses the verify with `invalid_state`, naming
the check and its pid; `collie cleanup --apply` tries to end it again and reports what is
left. Once the command is spawned, it prints `"<name>" started, pid <pid>`: a wait after
that line is the command's own. Each of these lines is also written to the Run's log.

`--expect fail` is how a bug is proved to exist. A regression test that exits non-zero on
the tree before the fix is the evidence, so that record is a `pass`; the same command
succeeding is the reproduction failing, not the bug being fixed. Stability comes first
either way — a tree that moved under the command is `unstable` whatever was expected.

```sh
collie verify --name regression --expect fail -- bun test test/bug.test.ts
```

An agent's `collie verify` left running in the background is reported back to it: where
herdr says the agent has settled and Collie is still collecting its Output when the
command ends, the host sends it a `boundary` delivery naming the check, its result and exit
status, the commit and the log, which it keeps in the state directory's `evidence/<run>/verify/`.
So an agent may end its turn waiting on a verify, and on nothing else in the background
([steering](steering.md#what-the-host-sends-on-its-own)).

### What Collie may run itself

An agent may `collie verify` anything but this run's own
[checks](../CONTEXT.md), which only the gate runs; Collie runs only those, matched argument for argument, and nobody approves them
([ADR-0055](adr/0055-a-run-never-asks-to-run-its-checks.md)). They are settled when the run starts — the `--verify`
entries given with it, else the project's `.collie/verify.json` at the run's base, else the checks remembered
for the checkout's remote (`~/.collie/user/verify/<host>/<path>.json`, by `origin`, then
`upstream`), else `~/.collie/user/verify.json`, whichever is found first and taken whole — and copied into the run's Intent as its `run_verification` list. Editing the file afterwards changes the next run and never a
running one. Where none of those has any, the run starts anyway and its agent names them
before it builds. From then on the Intent is the set: `run intent verification` adds to it
or removes from it, whoever calls it, and an Intent whose list has been emptied is a run
with no checks — the seed is not put back behind whoever removed them. A check whose
directory is outside the run's tree — `worktree` is its worktree, anything else is resolved
against its cwd — is refused when it is named, naming that directory and the run. A Run of
a workflow module keeps its set with the host rather than in an Intent, and the same command
amends it there.

```json
[{ "name": "tests", "executable": "bun", "argv": ["test"], "cwd": "worktree" }]
```

An entry may leave its check **to CI** with `"ci": "<job name>"`, the merge request pipeline
job that proves it
([ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job](adr/draft-a-check-left-to-ci-is-proved-by-its-pipeline-job.md)).
Its executable and arguments stay, to tell a human what the job runs. Nobody runs it locally:
the gate skips it, its missing local pass is no gap, and prompts list it as
`<name>: left to CI (job <job>), do not run it`. Once the merge request is open, the run
waits for that job on the merge request's head commit, read through the forge, and records
its pass as a verification of the check, with the job's URL. A failed job is first read
where the branch leaves its target branch: failed there too, it is reported as failing
before the run's changes, and left unproved. Otherwise it is retried once, and a pass on
the retry is reported as a Flake. A job that fails its retry goes to the builder in a CI
fix round, at most 4; see [`docs/workflows.md`](workflows.md). A job missing right after
its retry, as GitHub holds back a job behind `needs` until its needs finish, is waited on
like a pending one, up to 2 hours. A skipped, cancelled or missing job, a job not finished
after 2 hours, a checkout with no forge, or a job still failing after the last round parks
the run unproved, naming the check, the job and the commit.

```json
[
  {
    "name": "nuxi",
    "executable": "bunx",
    "argv": ["nuxi", "typecheck"],
    "cwd": "worktree",
    "ci": "nuxi-typecheck"
  }
]
```

The base is the ref a checkout for the run is cut from: the remote branch it works on, else
the remote's default branch, else the local one. It is read the same way for a run that has
no checkout of its own, such as `plan`, and the run it starts inherits what it read. Only a
repository with none of those refs reads its working tree. So an uncommitted edit to the
file, or a checkout behind its remote, does not reach a new run: push the edit to the branch
the run starts from, or name the checks with `--verify` or `collie run intent verification`
([ADR-draft-a-runs-checks-are-read-where-its-checkout-starts](adr/draft-a-runs-checks-are-read-where-its-checkout-starts.md)).

Collie's own `.collie/verify.json` leaves its one check, `check` (`bun run check`), to CI's
`test` job, which passes only when the jobs running that script's two halves did: its
implement Runs and Releases wait for the job rather than run the suite again.

A file that is there and does not decode is an error naming it and the ref it was read at, never an empty set, and
the start is refused as `invalid_input`, so a typo is never quietly replaced by an agent's
choice. So is `--verify` given to a plan that spans repositories: each repository is held to
its own `.collie/verify.json` at its own base, or remembered checks. No start is refused for having no
checks.

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

## Measure

```sh
collie measure --base <commit> --plan <file> --pass calibration
collie --json measure --run <run-id> --base <commit> --plan <file> --pass "cycle 2" [--cwd <path>] [--reason <why>]
```

A **Measurement** proves a speed-up, which a Check cannot: it compares two trees of this
Machine on many samples
([ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement](adr/draft-a-performance-gain-is-proved-by-the-hosts-measurement.md)).
The host makes the **base tree** as a detached worktree at `--base` with the plan's harness
commits applied, under `measurements/trees/<run>/` in its state directory, and keeps it for
the Run's later Measurements of the same base. The **candidate** is the Run's checkout, or
`--cwd` inside it. `--run` defaults as for `collie verify`. A workflow asks for the same
Measurement with [`host.measure`](sdk.md#proving-it-rather-than-saying-so); both go through
one host operation, on the Run's own Machine.

| Flag       | What it does                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `--run`    | The Run measured. Defaults to the Run whose agent this pane is.                                                     |
| `--cwd`    | The candidate tree, inside that Run's checkout; defaults to it.                                                     |
| `--base`   | The commit the base tree is made at.                                                                                |
| `--plan`   | A file holding the Run's benchmark plan as JSON.                                                                    |
| `--pass`   | Which Measurement this is: `calibration`, `cycle N` or `final`. Anything else is `invalid_input`.                   |
| `--reason` | Why the plan changed. A Run already measured under another plan refuses a new one without it, with `invalid_input`. |

The plan is frozen: a changed plan is a new comparison, measured only with `--reason`, which
its record keeps as `plan_reason`. A key left out takes its default.

```json
{
  "harness": { "commits": ["<sha>"], "paths": ["bench"] },
  "prepare": { "executable": "bun", "argv": ["install"] },
  "commands": [{ "name": "api", "executable": "bun", "argv": ["bench/api.ts"] }],
  "metrics": [
    { "name": "api.p95", "direction": "lower", "role": "primary" },
    { "name": "api.peak_kb", "direction": "lower", "role": "guardrail" }
  ],
  "warmup": 1,
  "samples": 10,
  "limit": 600,
  "threshold": 5,
  "tolerance": 2
}
```

- **`harness`**: each commit is applied to the base tree, and must touch only `paths` (a
  path or a directory under one). One that touches anything else refuses the Measurement
  with `invalid_input`, naming each such path. So does one that does not apply.
- **`prepare`**: run once in each tree, base first, before any sample. Default none.
- **`commands`**: each sample runs every one, in order, in the tree's root, with no shell
  between.
- **`metrics`**: exactly one `primary`, the rest `guardrail`. For each command, the host
  reads `<command>.wall_ms`, `<command>.cpu_ms` and `<command>.peak_kb`. Where the command's
  last stdout line is one JSON object, each other number in it is `<command>.<key>` too: a
  command cannot report the host's three readings. Of stdout, the last 64 KiB are kept, so a
  longer last line reports nothing.
  `peak_kb` is the kernel's peak resident size for the process, which on Linux has the
  host's own size at the fork as its floor.
- **`warmup`** samples per side are recorded and never judged, and **`samples`** per side
  (at least 2) are.
- **`limit`**: seconds one sample, all its commands together, or one tree's prepare may take,
  the host's time to record and start each command included. A command still running at
  the limit is ended then, even while the host is still recording it.
- **`threshold`** and **`tolerance`**: percents, as in [Outcomes](#outcomes).

The host then samples alternately, A B B A …, base first, after the warmup. With each sample
it keeps the Machine's 1, 5 and 15 minute load and its memory reading. It judges each metric
by the ratio of the candidate's median to the base's, with a 95% bootstrap interval seeded
from the Measurement's id: `gain`, `no-change`, `regression` or `inconclusive`. Each metric
is also `held`, where the interval's worse bound is within `tolerance`.

**A comparison is measured once.** A request whose base commit, candidate tree (its commit
and fingerprint, as `collie verify` reads them) and plan match a recorded Measurement of the
Run returns that record, runs nothing, and answers `"ran": false`. That holds whatever the
pass and whatever the record says, an `inconclusive` one included, so a result cannot be
re-rolled. A changed tree or a new plan is measured again, and every Measurement stays on
the record.

**One Measurement runs on a Machine at a time.** Another one waits until the Machine is
free. While it waits, its Run's card and `collie run show` say `Waiting for this Machine:
Measurement <id> of <run> is running on it.`, and `collie measure` prints that line to
stderr. While the Machine is [Short of memory](using.md#short-of-memory), the Measurement
waits as `collie verify` does, and records that it waited. A stop of the Run ends either
wait, or a Measurement already sampling, with `invalid_state`, and records nothing.

Each command runs as one of the Run's checks does, recorded under the host's state directory,
so a host that dies mid-sample leaves no benchmark running: the next host, and the next
Measurement before it samples, ends what one left. A host that stops mid-sample ends its
benchmark and records nothing of it, so the next host measures that comparison afresh. A base tree is used again only while it
holds exactly the harness commits over `--base` and no tracked file changed; otherwise it is
made again.

A Measurement ends without a verdict when:

- a sample, or prepare, outlives `limit` (`TimedOut`);
- a command, or prepare, exits non-zero (`Failed`, naming the tree and keeping its output);
- a non-warmup sample has no reading of a declared metric (`Unjudged`, naming it);
- either tree's commit or fingerprint changed after prepare or after any sample, even where a
  later sample put it back (`Unjudged`, naming the tree).

Each record goes to the Run's `measurements.jsonl` in its evidence directory. Under
`--json`, the envelope's `data` is `{ "measurement": <the record>, "ran": <bool> }`:

```json
{
  "measurement": {
    "id": "<run>-measurement-1793189238226",
    "run": "<run>",
    "pass": "calibration",
    "machine": "vm-mk",
    "plan": { "…": "the plan, with its defaults filled in" },
    "plan_digest": "949af28531ce47f8",
    "plan_reason": null,
    "base": {
      "commit": "<sha>",
      "cwd": "…",
      "head_sha": "<sha>",
      "fingerprint": "…",
      "lockfiles": { "bun.lock": "…" }
    },
    "candidate": {
      "cwd": "…",
      "head_sha": "<sha>",
      "fingerprint": "…",
      "lockfiles": { "bun.lock": "…" }
    },
    "environment": { "api": "<digest, as collie verify records it>" },
    "waited": { "memory": false, "machine": [] },
    "prepare": [{ "tree": "base", "exit": 0, "seconds": 4.2, "output": "…" }],
    "samples": [
      {
        "tree": "base",
        "warmup": true,
        "readings": {
          "api.wall_ms": 812.4,
          "api.cpu_ms": 640.1,
          "api.peak_kb": 91232,
          "api.p95": 41
        },
        "load": [3.1, 2.8, 2.5],
        "memory": { "available": 41943040000, "total": 67108864000, "pressure": 0 },
        "at": "2026-10-28T12:07:19.029Z"
      }
    ],
    "result": {
      "_tag": "Judged",
      "verdicts": [
        {
          "metric": "api.p95",
          "ratio": 0.81,
          "interval": [0.78, 0.84],
          "verdict": "gain",
          "held": true
        }
      ]
    },
    "started": "2026-10-28T12:07:18.002Z",
    "at": "2026-10-28T12:07:41.310Z"
  },
  "ran": true
}
```

`lockfiles` names each dependency lockfile at the tree's root by its digest. `waited.machine`
names each Measurement this one waited behind. An infinite ratio or bound, from a zero
median on the base side, is the string `"Infinity"`. A `result` that is not `Judged` is
`{ "_tag": "TimedOut", "tree", "stage", "command" }`, `{ "_tag": "Failed", "tree", "stage",
"command", "exit", "output" }` or `{ "_tag": "Unjudged", "reason" }`, with `stage` either
`prepare` or `sample`. Chat runs `collie measure` as you would type it.

## Hold and release

```sh
collie --json run hold <run-id> [--request-id <id>]
collie --json run hold <run-id> --before <step-id>
collie --json run release <run-id> --before <step-id>
collie --json run steer <run-id> --step <step-id> "check the race first"
collie --json run withdraw-note <run-id> <note-id>
collie --json run hold --workspace <workspace-id> [--request-id <id>]
collie --json run release <run-id> [--request-id <id>]
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

| Code                  | When                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace_required`  | The command needs a workspace and none could be determined.                                                                                                                    |
| `workspace_not_found` | The `--workspace` id is not a workspace herdr has.                                                                                                                             |
| `workflow_not_found`  | No layer defines that workflow.                                                                                                                                                |
| `persona_not_found`   | No layer defines that persona.                                                                                                                                                 |
| `run_not_found`       | No run with that id, or none by that id in the Task this command is scoped to.                                                                                                 |
| `task_not_found`      | `--task` named a Task that does not exist.                                                                                                                                     |
| `target_exists`       | A fork would overwrite a file that is already there.                                                                                                                           |
| `needs_input`         | Inputs are missing; `details.inputs` says which, with their questions.                                                                                                         |
| `timeout`             | `run wait --timeout` gave up.                                                                                                                                                  |
| `machine_unreachable` | A paired Machine did not answer within its bound; `details` name the `machine` and what was `seen`, and `waits` is `ssh_connection` where its link waits on an SSH connection. |
| `invalid_state`       | The run, or the installation, is not in a state where that makes sense — `upgrade --to` on a development checkout.                                                             |
| `invalid_input`       | A flag or argument was wrong.                                                                                                                                                  |
| `operation_failed`    | Anything else, including a caught defect.                                                                                                                                      |

## Retrying safely

Every mutation — `run start`, `run answer`, `run stop`, `run resume`, `workflow fork`,
`persona fork` — accepts `--request-id`. Collie writes a receipt under its state directory
keyed by that id, so retrying the same id returns the original result instead of repeating
the effect. Choose one per intended action — any unique string — and reuse it for every
retry of that action:

```sh
collie --json run start implement --input plan="$PWD/plan" --request-id start-plan-1 \
  || collie --json run start implement --input plan="$PWD/plan" --request-id start-plan-1
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
anything else in `config.json` are not settings and are refused. `agent_profile` takes its
JSON as one quoted argument and is refused as a whole where any part of it is
([What Collie's agents get](using.md#what-collies-agents-get)).

## Cleaning up

```sh
collie cleanup
collie cleanup --apply [--request-id <id>]
```

`cleanup` lists what the host's sweep would remove now: one line per item with its
kind, what it is, its size and why it goes, then one line per thing Collie made and keeps,
with the one condition that keeps it, then the total a sweep would free. The listing is
judged against the latest board the host has built, so it answers at once on a busy host
but can name an item that has gone since; a sweep builds its own board and judges every
item again, so the listing never causes a removal. `--apply` sweeps
now, through the host, and prints what it removed and what it freed. There is no
confirmation: the host sweeps the same way on its own every ten minutes. What each kind
keeps, and why, is [ADR-0045](adr/0045-collie-removes-what-it-made-once-nothing-needs-it.md);
[Cleanup](using.md#cleanup) says what a sweep covers. An `idle-agent` item is a finished
Run's agent, named as `<agent> of <run>`; it frees no disk, so its size is 0.

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

The `check` kind is a check's processes that no host is collecting, such as a child that left
its group, or one a starting host could not end. Its target is the check's id, and its
reason names the Run, the check, its pid and how long it has run; it frees 0 bytes. It is
proved by the check's record under `running-checks/`, or by the marker in its environment
naming this installation and the check, which is read only from `/proc`. A process proved by
neither, or marked for another state directory, is never listed. A sweep ends it with SIGTERM, then SIGKILL if that leaves
it running, because a check's result is thrown away
([ADR-draft-a-check-ends-with-the-host-that-runs-it](adr/draft-a-check-ends-with-the-host-that-runs-it.md)).
A check this host is collecting is kept, with "this host is collecting it".

The `measurement-tree` kind is a base tree [`collie measure`](#measure) made, whose target
is its directory. It is kept while its Run has not ended, and a sweep removes it with git's
record of the worktree.

## Usage

```sh
collie usage
```

How much of each Claude and ChatGPT **Subscription** this Machine's logins have used, as
its host last read it ([ADR-0049](adr/0049-work-goes-to-an-agent-with-usage-left.md)). One
line per window — session, weekly, and a model's own weekly — with its percent and its
reset, then a line saying how old the reading is and where it came from, or why there is
none:

```text
claude  team · me@example.com (Cego)  Session 31% · resets 10:49 (in 2h 3m)
claude  team · me@example.com (Cego)  Weekly 88% · resets Fri 12:59 (in 1d 4h)
claude  read 3 minutes ago from claude-status-line
chatgpt Codex is not logged in on this Machine; run `codex login`
```

Each read, from any door, is recorded under who asked in the host's `usage/operations.jsonl`,
keeping the latest 200. A window whose reset has passed counts as unused, whatever was last read. Under `--json`,
`data` is `{ "readings": [...] }`, one per Subscription:

```json
{
  "subscription": "claude",
  "account": "<organization uuid>:<account uuid>",
  "accountLabel": "me@example.com (Cego)",
  "plan": "team",
  "windows": [
    {
      "kind": "session",
      "label": "Session",
      "model": null,
      "usedPercent": 31,
      "resetsAt": "2026-10-08T10:49:59Z",
      "reached": false
    }
  ],
  "at": "2026-10-08T08:46:00Z",
  "source": "claude-status-line",
  "problem": null
}
```

`kind` is `session`, `weekly`, `weekly-model` (with `model`) or `other`. `reached` is the
source saying the window is used up whatever its percent. `account` is the account's id,
never its email. `source` is `claude-usage`, `claude-status-line` or `codex-app-server`, and
`problem` says why there is no fresh reading — an expired login, Codex not installed, an
endpoint refusing — with the last good windows kept where there were any.
[Usage](using.md#usage) says where the numbers come from and how fresh they are.

## Schedules

```sh
collie schedule add <name> <workflow> --cron <expr> [--tz <zone>] [--paused] \
  --input <k=v>… [--workspace <checkout>] [--verify <check>…] [--request-id <id>]
collie schedule list
collie schedule pause|resume|remove <name> [--request-id <id>]
collie schedule move <name> --to <machine> [--workspace <checkout there>] [--request-id <id>]
```

A **Schedule** is a start this Machine's host makes by itself whenever a cron expression
falls due ([ADR-0052](adr/0052-a-schedule-is-a-saved-start-its-host-fires.md)). `add`,
`pause`, `resume` and `remove` act on the Machine they run on, or on the paired Machine
`--machine` names, and name it: its hostname and its installation id. That Machine's host
records who asked as `cli` or `cli-tty`, with `from.machine` naming the Machine the command
ran on.

`add` saves a start as an agent's start gives one — the Workflow, every Input (an optional
one as `""`), the checkout, and `--verify` checks — with a name of lowercase letters, digits
and hyphens, at most 40 long, that no other Schedule on this Machine has. `--workspace`
names the checkout: an absolute path, a workspace's id or label, which is saved as that
workspace's checkout path, or `projects-root`; without it, the checkout the command runs
in. `--cron` is five fields — minute, hour, day of month, month, day of week — read in
`--tz`, an IANA time zone, this Machine's own by default. The start is checked as it would
be now: a missing checkout or Input is `needs_input`, naming it; an Input the Workflow will
not take, a cron expression or time zone that does not parse, and a name already used are
`invalid_input`; a Workflow nobody saved is `workflow_not_found`. `--paused` adds it paused,
so it fires only once it is resumed. With `--machine`, nothing here is read to decide it:
the start is sent as given, `--workspace` as an absolute path on that Machine or
`projects-root`, and that Machine's host checks it against the modules it has saved and the
checkouts it has, refusing it with its own reason (`invalid_input` or `needs_input`).

`pause` stops it firing; a Run it started that is still going goes on. `resume` fires it
again from its next occurrence after now, never catching up on what fell while it was
paused; resuming one that is not paused is `invalid_state`. `remove` removes it, and every
Run it started stays. There is no edit: remove it and add it again.

The host starts each occurrence as a fresh start is placed, in a Task of its own unless it
is about a Task's work — a merge request one of its Runs opened or was given, or a branch
an open Task's Runs were placed on — under the request id `schedule:<name>:<occurrence>`
and the Actor `schedule`, whose `schedule` field names the Schedule and the occurrence. It never
starts a second Run while the last one it started is going, asking, parked or stalled; the
occurrence that fell meanwhile starts as soon as that Run ends. Occurrences missed while no
host ran start once, late, for the latest of them. While herdr does not answer, the start
waits and tries again each minute; any other refusal is recorded against its occurrence,
and the next occurrence is tried as usual.

`list` lists this Machine's Schedules and every paired Machine's, each entry naming its
Machine; a paired Machine that does not answer is named in `machines` as away, with what was
seen, as `run list` names one. With `--machine` it lists only that Machine's.

`move` moves a Schedule from this Machine, or the one `--machine` names, to `--to`: a
paired Machine's name, or this Machine's own as `run list` shows it. It adds the same start
on the target, paused, in the checkout `--workspace` names there or the same path; removes
it from the source; then resumes it on the target, where it fires from its next occurrence
with no catch-up. The Runs it already started stay where they ran. Both Machines must answer
before anything changes, or it is `machine_unreachable` and neither changes. A name on
neither Machine is `invalid_input`. A target that refuses the start is `operation_failed`
with its reason and nothing moved; a move that stops after the first step is
`operation_failed`, leaves the copy paused and says so, and the same request id finishes it
without repeating a step. It answers with the target's `resume`, as `resume` does.

Under `--json`, `list`'s `data` is the Machine asked, every Schedule listed, and the
Machines that did not answer:

```json
{
  "machine": { "installation": "6f0c…", "hostname": "laptop" },
  "schedules": [
    {
      "machine": { "installation": "6f0c…", "hostname": "laptop" },
      "name": "self-improve-daily",
      "workflow": "self-improve",
      "checkout": "/home/me/collie",
      "cron": "0 7 * * *",
      "tz": "Europe/Copenhagen",
      "paused": false,
      "start": {
        "workflow": "self-improve",
        "inputs": { "improvements": "3" },
        "workspace": "/home/me/collie",
        "verify": []
      },
      "next": "2026-10-13T05:00:00.000Z",
      "last": {
        "occurrence": "2026-10-12T05:00:00.000Z",
        "outcome": { "kind": "run", "run": "run-1a2b3c4d", "status": "complete" }
      }
    }
  ],
  "machines": [{ "machine": "vm", "state": "away", "note": "vm did not answer: …" }]
}
```

`start` is the saved start, enough to add the same Schedule elsewhere. `next` is null while
it is paused, and while it waits for its last Run to end. `last.outcome` is one of `run`
(the Run and its status), `waiting-for-run` (the same, still going), `waiting-for-herdr`,
or `refused` with the `reason`. `add`, `pause`, `resume` and `remove` answer with
`{ "machine", "change", "name", "schedule" }`, where `schedule` is the entry as `list` shows
it, and null once removed. Each change and each occurrence is recorded, with who asked, in
the state directory's `schedules/<name>/operations.jsonl`.

## Upgrading

```sh
collie upgrade
```

What it does depends on where the installation is, never on its git state
([ADR-draft-an-installation-is-the-release-its-runner-carries](adr/draft-an-installation-is-the-release-its-runner-carries.md)):

- **A release** — an installation that is not a checkout — goes to the newest release, read
  from `<releases>/latest` (`COLLIE_RELEASES`, else
  `https://github.com/cego/collie/releases`). Where that is the runner's own version, the
  runner places the release it carries into the
  [Collie directory](using.md#the-collie-directory)'s `release/`, replacing it whole, so it
  also repairs a damaged one. Each file there that differs from what the last placement
  recorded is first copied into `kept/<when>/`, and the report names each one with how to
  fork it into `user/`. Placements into one Collie directory take turns under its
  `placing.lock`, so a CLI, Desktop and a peer upgrading at once never mix two releases.
  Another version's runner is downloaded with its `.sig`, verified
  against Collie's Ed25519 release key, and handed the upgrade (`upgrade --to <version>`
  against the same Collie directory); what it reports is this upgrade's report. No git is
  involved, so nothing anyone wrote can block it. A newest release that cannot be read, a
  download that fails or a runner that does not verify is `operation_failed` with the
  reason, a version with no release is `invalid_input`, and in each case `release/` is left
  exactly as it was. A runner that was not built as a release places nothing and is refused
  as `invalid_state`.
- **A development checkout** — a clone linked as the plugin from anywhere but the Collie
  directory — is pulled with `git pull --ff-only --autostash`, so uncommitted work rides
  through a pull that touches other files. A pull it cannot do, a conflict included, is
  reported in git's words rather than installed over.
- **A clone at the Collie directory**, an install from before ADR-draft-an-installation-is-the-release-its-runner-carries, becomes a release.
  `release/` and `kept/` are added to the clone's `.git/info/exclude` first, so the release
  never shows as a change in it. The target release's runner (the newest, or `--to`) is
  downloaded, verified and handed the upgrade with `HERDR_PLUGIN_ROOT` at `release/`: it
  places the release there, links it as the plugin (herdr replaces the clone's link of the
  same plugin id), points the operator skill at it, and the host the clone served is replaced
  by the release's. The runner is downloaded even at this runner's own version, because a
  clone's runner may have been built from its source. Then the clone is removed — everything
  in the Collie directory but `release/`, `user/` and `kept/` — only where nothing in it is
  yours: no changed or untracked file, no ignored file beyond `bin/`, `node_modules/` and
  `user/`, no commit that no remote branch contains, no stash, no linked worktree, and no live
  Run working in it. Where any of those is found, or the host cannot be asked about live
  Runs, the clone is kept exactly as it was and the report names what kept it; it is an
  ordinary checkout from then on. Under `--json`, `data.clone` is `"removed"` or
  `{ "kept": ["<what kept it>", …] }`.

Then it runs `prepare.sh` —
the one routine every entry point ends in, so this brings the plugin link, the runner and
shim, the operator skill and the skills up to date together rather than replacing the
runner alone. In a checkout, a
runner `install.sh` downloads replaces the one there only once its signature checks out
([Build and release](internals.md)). Otherwise an install with bun builds the runner from
source, and one without keeps the runner already there and the `runner` step fails. In a
release, the runner is the one placed, and nothing is downloaded or built.

The report names what moved: the commit range where the checkout advanced, and one line
per preparation step saying whether it was done, was already in place, or was skipped —
so "nothing to do" reads differently from "the runner updated but the skills step could
not run". A skipped step is not a failure: `upgrade` still succeeds. Under `--json` the
same steps are in `data.steps`; a release adds `data.release`, the version placed, and
`data.kept`, each file copied aside, relative to the Collie directory.

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
a checkout, or anywhere but Linux x64. On macOS, Desktop updates itself from the release as
it does on any platform; `upgrade` stages nothing for it.

```sh
collie upgrade --to 0.27.0
```

Moves a release to exactly that version, older or newer, through the same download and
hand-off, and reports the same way, with `data.version`. `--to` the runner's own version
places it again, which repairs a damaged `release/`. A development checkout is refused as
`invalid_state` and left as it was: only `git` moves it, and Desktop and paired Machines
never upgrade it. A host's `identity` names a development checkout's build as
`development: "<version>+<sha>"`. A clone at the Collie directory becomes exactly that
release, as above.

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

| Step           | What it does                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`       | Checks for `git`, `curl` and `openssl`, or the one `COLLIE_OPENSSL` names (which checks a downloaded runner's signature; any version, LibreSSL included, will do). Any missing stops here with `needs_root` and the exact command                                                                                                                                                   |
| `collie`       | Places the release this runner carries into the [Collie directory](using.md#the-collie-directory) (`COLLIE_DIR`, else `~/.collie`) as [`upgrade --to`](#upgrading) does: `done` when it placed, migrating a clone found there, and `in_place` when `release/` is already at the version. Another version's runner is downloaded, verified and handed the upgrade. Nothing is cloned |
| `herdr`        | `curl -fsSL https://herdr.dev/install.sh \| sh`, if there is no `herdr`                                                                                                                                                                                                                                                                                                             |
| `claude`       | Anthropic's user-level installer, `curl -fsSL https://claude.ai/install.sh \| bash`, if there is no `claude`                                                                                                                                                                                                                                                                        |
| `path`         | Adds `~/.local/bin` (and `COLLIE_BIN_DIR`) to PATH in the shell's profile (`~/.bashrc`, `~/.zshrc` or `~/.profile`)                                                                                                                                                                                                                                                                 |
| `plugin`       | `prepare.sh`: the plugin link, the runner and shim, the operator skill and the skills. A runner `install.sh` downloads is installed only once the release key's signature (`<asset>.p256.sig`) checks out                                                                                                                                                                           |
| `claude-login` | `claude auth login` in this terminal, if `claude auth status --json` says Claude Code is not logged in; without a terminal, `needs_human` with that command                                                                                                                                                                                                                         |
| `gitlab`       | `glab auth login --hostname <host> --stdin` with `GITLAB_TOKEN`, if glab is not already logged in there, or is logged in with another token than the one given. Without a token: `needs_human`, with the token page and its `api` and `write_repository` scopes as `url`                                                                                                            |
| `push`         | Generates `~/.ssh/id_ed25519` if there is none and registers it with `glab ssh-key add`, unless the Machine can already push (over HTTPS with glab's login, or with its own key). GitLab's host key is trusted on first use, and a key GitLab already has counts as registered                                                                                                      |
| `helle`        | Writes `HELLE_API_TOKEN`, and `HELLE_API_URL=https://helle.cego.dk` for other Helle clients, to Helle's credentials file, owner-only; with no token given and no file, `needs_human`, saying how Slack's `/helle token` makes one                                                                                                                                                   |
| `linear`       | `claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp`, then `claude mcp login linear-server` in a terminal of its own, whose URL is streamed: the one it prints, or the one with its callback port it hands `$BROWSER`, which a shim writes down                                                                                                  |
| `doctor`       | [`collie doctor`](#checking-an-installation); onboarded means it is ready                                                                                                                                                                                                                                                                                                           |

A runner from a [development checkout](using.md#running-a-checkout-of-collie) — one that is
not at the Collie directory — gets the checks only and the logins: nothing is installed and
its checkout is not moved.

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
least the `min_herdr_version` the plugin manifest declares, and a running herdr server, when
there is one, at least that too; the plugin linked from this
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
`other gitlabs` note, unchecked, and never fails the run. Where any checkout under the
Projects root is on GitHub — its `origin`, else `upstream`, is on github.com — a `gh` check
follows: `gh` on PATH, else a failure fixed by installing it from https://cli.github.com,
and `gh auth status --hostname github.com`, whose failure's fix is `gh auth login
--hostname github.com`. Its detail says how many checkouts use GitHub. A Machine with no
GitHub checkout is not asked about `gh`.

**herdr** names what upgrading does to the running panes. From a herdr before 0.9.0, the
running server must stop once, which ends every program in its panes: `herdr update`, then
`herdr server stop`, then `herdr`, when nothing is running there, or the experimental
`herdr update --handoff`. From 0.9.0 on, `herdr update` leaves the running server and its
panes alone, and a **herdr server** line fails while the server still runs an older herdr,
until it is restarted when nothing is running. Each fix also offers the package manager
that installed herdr. Collie never runs `herdr update` or `herdr server stop` itself.

**Disk** covers each filesystem holding the state directory, `~/.cache/collie`, herdr's
worktrees and the temporary directory, once each. One with less than 10% or 5 GiB free is a
`!` warning naming it, with what [`collie cleanup`](#cleaning-up) would free where a host has
served this state directory, and `collie cleanup --apply` as the fix. It never fails the run.

**Memory** gives this Machine's reading, as `8.1 of 62.0 GB available (13%)`, with
`, pressure 0.0` on Linux. While the Machine is
[Short of memory](using.md#short-of-memory) it is a `!` warning naming the agents
[`collie cleanup`](#cleaning-up) would close, or saying there are none, with
`collie cleanup --apply` as the fix. Memory that cannot be read is a `!` warning saying where
it was read from. It never fails the run.

**Checks**, where a host has served this state directory: a `!` warning while
[`collie cleanup`](#cleaning-up) lists a `check` no host is collecting, saying how many and
naming the first's Run and pid, with `collie cleanup --apply` as the fix. It never fails the run.

**Paired links**, where this Machine is paired: a failure where the listener could not
take its port. A link live over SSH passes, its detail naming why direct failed. A link
that waits on an SSH connection is a `!` warning with `collie machine connect <name>` as
the fix; it never fails the run, since a laptop just woken is in that state.

**Host herd**, where a host is running: the Herd it works for, or a `!` warning that
[it has none](#the-local-workflow-host) and its judgements will be skipped. It never fails the run.

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
collie host restart [--dir <state-dir>]
```

The process durable work runs in. Nobody is expected to type the first: a client that needs
a host and finds none starts one, detached, and leaves it running — so the work outlives the
command, the board or the chat turn that asked for it. Typing it is how you watch one in a
terminal.

`host restart` replaces the host that owns the state directory (this installation's by
default) with this install's: it asks the owner to stop, kills it if it is still there five
seconds past its stop grace, starts a host, and waits until that one answers. It prints the
old and new pid and build, `data.before` and `data.after` under `--json`; with no host
running, `before` is null and it says it started one. A stopped host never answered is named
with its pid and `build unknown`. Nothing about a Run is touched: the new host recovers
what the old one was doing, exactly as on any start, so a parked Run is still parked and a
step that was cut short runs again. A check the old host was running is ended with it and
runs again on the new one. One a host left without ending it, because it was killed or
crashed, is ended by the next host to start, named in the Run's log, and runs once more.
The herdr action "Restart the Collie host" does the
same and says what it did as a notification.

A host works for one Herd: the herdr session a judgement is charged to and its cross-run
checks are held in. It is the one `HERDR_SOCKET_PATH` names, which a client that starts a
host hands on; a host started with none asks herdr's status where its server listens, at
start and then once a minute until it is told. A Run whose Task recorded a Herd is judged in
that one. A host with no Herd says so in `host.log` and as a `!` **host herd** line in
`collie doctor` — "this host has no Herd: judgements will be skipped" — and each judgement
it cannot make is recorded as skipped; start herdr and run `collie host restart`.

A host a client started has no terminal, so its own stdout and stderr — a crash's stack
trace among them — are appended to `host.out` in the state directory, beside `host.log`.
Like the log it is kept to about 1 MiB, with what came before it kept once as `host.out.1`.

One host owns one state directory, and the pid lock beside its SQLite decides which. Start
four clients at once and they converge on one owner; the three hosts that lost the lock
exit without touching anything. A lock left by a host that crashed is broken and taken
over — by its recorded start time, so a pid that now belongs to an unrelated process is
never adopted and never signalled.

Clients talk to it over a unix socket in that same directory, with Effect's own RPC: the
same schemas at both ends. Nothing listens off the Machine until another Machine pairs with
it and dials it; then the host also listens on port 47217, over TLS, for that paired
installation alone, and declares each channel it takes on its own socket
([ADR-0057](adr/0057-a-machine-reaches-another-over-a-paired-link.md)). It answers `identity`,
`discover`, `load`, `registrations`, `status`, `run`, `runs`, `watch`, `recover`, `offers`, `grant`, `steer`, `shown` (what `run show` prints) and, for pairing, `invite`, `pair`, `forget` and `peers`, plus `refresh` for release levelling — one
registry, in front of as many clients as ask. `run` and `runs` are the read model the front
doors show; `watch` streams it, current state first and a whole state each time; `recover`
registers what current files now allow and hands over what is outstanding. One fiber in the
host asks the engine about the work it has not finished, on a schedule every client shares,
and speaks up when anything a run shows has changed, so watching costs the same whether one
client is looking or the whole board is. Closing a client cancels nothing it started;
stopping the host with `kill` leaves suspended work suspended, and the next client starts a
host that picks it up. A stopped host gives running steps five seconds to finish and then
exits regardless, letting go of its lock; a step it cut short runs again under the next.

The operations above are `HostRpcs`: internal, and a Collie client of another build stops
before sending them anything. Beside them on the same socket is `FrontDoorRpcs`, the door
any front door uses whatever its build or computer, declared with its Schemas in
`src/board-model.ts`. `board` streams the board: a `Snapshot` (the state directory's
`installation` id, `build`, `development` — `<version>+<sha>`, only where the host runs a
development checkout — `protocol`, the `herds` — every running herdr session, by Herd
`id` and herdr's `name` — and every TaskView), then an `Upsert` or a `Remove` keyed by Task
id for each change, each with a `seq` higher than the last. A client that reconnects gets a
fresh snapshot. The host builds one board, from when it starts, for every client and for
its own merge watch and News. A client that subscribes is told the latest board that
covers every change seen before it subscribed, so it reads its own writes: at once when no
build is owed, or once the build under way or owed is done. It builds again when a Run is recorded, from any door, when
a file under its state directory that the board reads is written, when herdr pushes an
event from any of its sessions (a pane opening or closing, or an agent's status changing),
and every five seconds: one build at a time, with what changes meanwhile folded into the
next. The host's own bookkeeping builds nothing: lock and temporary files, `host.log`,
`host.out` and their rotations, the database's WAL and journal, `ssh/`, and `compaction/`
except each agent's `questions.jsonl`. Nor does a file growing in a Run's `handoffs/` or in
its evidence's `verify/` logs, though one created or removed there does; a Run's open
detail follows every write under its own `handoffs/` and evidence. The other operations,
`runs` and `run` among them, read fresh. The
installation id is written once, by the first host to own the directory, and survives
restarts and upgrades.

The host also runs what nobody has to have a pane open for: the merge watch, which asks
the merge request's forge, GitLab or GitHub, about each waiting one, a fan-out's Repo
runs' included, every 5 minutes and records a merge, a Repo run's on that Repo run; each Herd's
News, which it also supersedes once an item's cause no longer holds; and the
[cleanup](#cleaning-up) sweep, every ten minutes.

The operations that change a Run are on `FrontDoorRpcs` too: `start`, `answer`, `control`
(a hold or a stop, set or cleared, and every watcher hears about it), `resume` and
`invoke` (an offer). Two reads tell a front door on another computer what those take:
`offers`, what a Run offers to do next as its module decides now, with each offer's
arguments as JSON Schema; and `workflows`, what may be started in a project and the Inputs
each asks for. A third, `definitions`, reads every Workflow and Persona in the host's
shipped and user Layers in full: each module as `workflow show` reads it, with its own file
and the Markdown beside it named `<stem>.md` or `<stem>.<anything>.md`, the modules that
would not load, each Persona as `persona show` gives it, and the Persona files that would
not load. It typechecks nothing. `start` then takes what a human typed in `text`, and the host settles it
against the workflow's own schema. `usage` reads this Machine's [Usage readings](#usage).
`schedules` reads this Machine's [Schedules](#schedules), and `changeSchedule` adds one,
paused or not, or pauses, resumes or removes one, under a request id and the asker's Actor.
`cleanup` reads what a sweep would remove and keep, and
`sweep` sweeps now, recorded with its Actor in the state directory's `cleanup/operations.jsonl`
as well as in `cleanup.jsonl`. `claimedInHelle`, which Desktop's `collie_helle` sends after
a claim, drops that project from every Run's Helle claim record, recorded in
`helle/operations.jsonl` and in each Run's own trail. `grant` and `steer` stay on `HostRpcs`. Each takes a request id, and the same id twice is one operation. A
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
collie bridge --as <board|desktop|chat> [--client <name>] [--machine <name>]
```

A front door on another computer reaches the host through this, run on the Machine — over
SSH for an unpaired Machine, or spawned locally for Local and a paired Machine.
With `--machine`, it pipes Local's relay to the paired Machine. It starts the host if none runs, handing
it the state directory and the herdr session socket (asked of `herdr status server` when a
login shell sets none), declares the channel as the front door it was started as, prints
`collie-bridge-ready` on a line of its own, and from then on copies bytes between its stdio
and the host's socket. Whatever came before that line is a login shell's and is discarded.
The declaration is the bridge's: a `declare` of another front door on the channel is
refused, and the client at the other end never starts, stops or signals a process.
`desktop` is a human, as `board` and `cli-tty` are, and its Actor carries `from`: the
`--client` name and the SSH client address the bridge saw. `schedule` is the host itself
starting a Schedule's Run: no channel may declare it, and it is not a human.

So are the ones that write anything else: `confirm` (a proposal's id and content hash) and
`decline` (its id and content hash too), recorded in its Herd's proposals journal under the Actor; `dispose`,
what became of a Run's work; `steerAbout`, which has the evaluator turn free words about a
Run into actions and carries them out; `followUp`, which starts the follow-up the Run's
Workflow declares; `propose`, which records what chat was asked for as a proposal and
carries it out; `act`, which carries out the board's own actions on a Run (`stop`, `resume`,
`release`, `hold`, `answer`, `deliver`, `followup`, `take_offer`, `start`) with no proposal, anything else
being refused as `propose`'s; `reconcile`, which settles a proposal step nobody can account
for; `settleDelivery`, which does the same for a message to an agent; `focus`, which focuses
a Run's newest live agent, or only the `agent` it names, else its workspace, on the host's
own herdr and answers with the session, workspace and tab it is in, and the focused agent's
pane id and herdr name where it found one (an older host's reply has neither, and is read
as naming no pane); `setSettings`, which writes the Flock's settings into
the Machine's `config.json`, each with its own edit's time and only where that is later than
the Machine's own last edit of the key, records when each was set in `settings-set.json`
and, when Desktop asks, that a Desktop gave them, and refuses the whole batch over any value the TUI's Settings
would refuse ([ADR-0043](adr/0043-a-shared-setting-is-its-latest-edit.md)); `settings`
reads them back, each with when it was set; `sharedDefinitions`, which reads the user
Layer's shared definitions, each with its bytes in base64 (null for a removal) and the time of its
latest edit; `setSharedDefinitions`, which writes the Flock's where each is later than the
Machine's own, gives each written file its edit's time, keeps the file a write replaces
under `replaced/`, writes nothing through a link, and refuses the whole batch over any path
that is not a file directly in `workflows/` or `personas/`, or any malformed time or base64
([ADR-0061](adr/0061-a-users-definitions-are-the-flocks.md));
and `news`, which
hands one conversation its Herd's pending News, each item with its Significance, and
records it `read`, `sent` or `uncertain` for that conversation alone. Given `keys`, it hands
over every pending item and records only those keys: what Desktop's Flock chat actually
gave the model, out of a batch it put together across Machines. Actions travel as
JSON and the host decodes them. `collie confirm`, `decline`, `steer`, `run disposition`,
`run seen`, `proposal reconcile`, `run deliveries --reconcile` and `chat news --sent`, the board and
chat's tools all go through these, so the host is the only writer of what they record
([ADR-0040](adr/0040-the-host-is-the-only-writer.md)).

`read` answers `collie_run`, `collie_receipts` or `collie_workspaces` — and no other tool —
for the asking channel exactly as the Machine's Native chat would, with no board selection
standing in for a Run nobody named. It records nothing. Desktop's Flock chat reads through
it.

`progress` answers for one Run what its status does not carry: its Ready to release, the
forge's pipeline at its merge request's head, and each operation's latest agent and whether
it has written its Output. `run show`, `run wait` and chat read it; `null` is a Run the host
does not have.

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
`review`, `diff:<path>`, `evidence:<name>`, `verification:<id>`, `plan:<file>`, `attachment:<name>` (one of the Run's attachments), `file:<path>` (read
only, from the Run's checkout) and `pipeline:<url>` (the status glab reads for a GitLab pipeline, or gh for a GitHub Actions run), text as it is and anything else as base64. Each answer is
at most 4 MiB from `offset` (or `length` bytes where asked) and says the item's whole
`size`, so a long log or a video is read in parts. A part of an item is base64 whatever it
is, so a character split across two parts is whole once they are joined. A reference is refused where it leaves
the directory it belongs to, links followed, or where it is not a regular file.

Five more answer a front door about the Machine's own files, every path absolute; the Flock
chat's file tools use them ([ADR-0011](adr/0011-the-conversation-is-a-native-harness.md#amended-2026-10-07-the-flock-chat-reaches-files)).
`readFile` hands over a part of a file, at most 4 MiB from `offset`, as base64 with its
media type and whole `size`. `glob` answers the files a pattern matches under a directory,
newest first, at most 100 and how many it `omitted`. `grep` takes Claude Code Grep's
arguments that make sense on a host (`glob`, `type`, `outputMode`, `ignoreCase`,
`lineNumbers`, `before`, `after`, `context`, `headLimit`, `multiline`), runs ripgrep where it
is on `PATH` and `grep -r` otherwise, and answers at most 100 lines. `writeFile` writes a
whole file, making its directory, and `editFile` replaces `oldString` with `newString`,
refusing one that is missing or, without `replaceAll`, not unique. Both take a request id,
the same id twice being one operation, are recorded with the Actor in
`files/operations.jsonl` under the state directory (its newest 1000), and are refused where
the file's real path is inside the state directory. The `Snapshot` carries `files: true`
from a host that has these; a client sends files to no host without it.

`upload` takes a file sent to this Machine in parts: its `name`, `size`, `sha256`, an
`offset` and one base64 part of at most 4 MiB. The host appends the parts under
`uploads/<sha256>/` in its state directory, checks the size and the digest on the last, and
answers the file's path, which a `start`, an `invoke` or a steer can then name as an
attachment; before the last part it answers `null`. A digest it already holds whole is
answered with its path at the first part, so the rest is never sent, under the name it was
asked for, and a part sent again is the same part, so a retry needs no request id. Parts are
taken one at a time. A mismatched digest or size removes what arrived and is refused, as is
a part at an offset other than what arrived (send it again from the start) and a file over
100 MB. Each upload is recorded with its Actor in `uploads/operations.jsonl`. Being asked
for a held digest renews its age, and the host's cleanup sweep removes an upload a week after it
was last asked for; Desktop trusts an upload's path for a day before it asks again. A `chat` channel's `declare` may also carry `attachments`, the names of the files
the human's message carried, which the host records beside `said`.

`protocol` is an integer, also in `identity`. An optional field, a new operation or a new
kind of message does not change it, and a client reads a kind it does not know as
`Unknown` and skips it. A removal or a change of meaning bumps it, and from then on the
host serves its current version and the one before; version 1 has none before it.
Version 2 changed two meanings: a `chat` channel's repeated `declare` replaces the words it
speaks with rather than being ignored, and `news` with `keys` settles only those. A version
1 client repeats no declaration and sends no `keys`, so it is still served as before.
Desktop's Flock chat writes through no host older than version 2, and says so.
Version 3 removes the `gate` Decision. A version 2 client is still served because it never
receives one.

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
second one. A start the engine does not take within thirty seconds is refused saying so,
and stays recorded: the next host start hands it over under the same claim. The rows behind
that are in the same SQLite file as the engine's own, and
[ADR-0017](adr/0017-one-request-is-one-run.md) is why each of them is there.

It says which build it is, and which installation it serves. A client newer than the host,
from the same installation (after `collie upgrade`), stops it and starts itself in its
place; a host still there five seconds past its stop grace is killed, and its work is
recovered by the one that replaces it. A host that does not answer is replaced the same way
when the build it recorded in `host.build` is older. Any other client of another build is told which build is running and to run
`collie host restart`, and sends nothing else. That includes a checkout under development, which is pointed
at a state directory of its own rather than replacing the installed host. Such a
checkout's host also says `development: "<version>+<sha>"`; a release's does not.
A host that cannot be started at all, or that takes a connection and does not answer within
five seconds, is `HostUnavailable`, with whether anything owns the directory. [ADR-0015](adr/0015-one-local-host-owns-a-state-directory.md) is why each of
those is the way it is.

`COLLIE_HOST` names the command a client starts a host with — one path, or a JSON array of
the executable and its arguments. Unset, it is this executable.

`COLLIE_HOST_STOP_GRACE` is how long a stopped host waits for running steps before it exits
anyway, as a duration (`5 seconds` unset). It bounds every end of a host: a stop signal, its
lock or state directory gone, or the process it watches exited. A check the host is running
is not waited for to finish: it gets SIGTERM as the host starts to stop and SIGKILL in the
grace's last fifth, records nothing, and runs again on the next host. Where that SIGKILL and
its last look for a check's processes are still under way when the grace is up, the host
waits for them, at most three seconds more, so it exits within three seconds of its grace,
well inside the five a client gives it before killing it. A check asked for once the host has
begun to stop is not started.

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

### A shell over a front door

`shell({script, stdin?, request})` runs a script in this Machine's login shell. It returns
`{code, stdout, stderr}` and is bounded at ten minutes, including waiting for another
shell call. More than 1 MiB of combined output is refused. A process that ignores termination
is killed after one second. The host records its Actor and
request in the shell audit. Stdin is hashed in the request record, so tokens passed on
stdin are not copied into it. Desktop uses this operation for a paired Machine's
commands and credentials.

Hosts share settings without Desktop. When paired releases differ, the newer host
upgrades the older one through `shell`. The `refresh` operation starts the
older Machine's own new CLI detached; that client replaces its host. Clients wait for
levelling within five seconds. Development checkouts are left alone and a mismatch names
both builds.

## An agent's commands

A CLI command in a registered Run agent's pane records `origin: "agent"`, with its Run,
agent name and Machine. A pane herdr cannot name stays `cli`. MCP uses the same origin,
from the environment Collie writes at launch. A tool argument cannot name a sender.
`run show` lists the agent names that `--operation` and `collie_do deliver` take.
See [agents talking to each other](using.md#agents-talking-to-each-other).

`run deliveries <id>` finds the Machine that holds the Run, as other Run reads do.
Its `--reconcile` write is carried out there through the same host, under its request id.
