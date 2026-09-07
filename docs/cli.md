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
- Set `COLLIE_CWD=<path>` — the working directory for the picker, the agents and the
  Driver, and the root of a CLI run.
- Pass `--workspace <id>`, which re-roots the run at that workspace's directory as well as
  scoping to it.

`collie run list` without `--workspace` lists runs everywhere; with one, only that
workspace's.

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

`workflow show` prints the **resolved** workflow: the inputs and steps a run actually gets,
including those inherited from an embedded workflow. `workflow check [<workflow>]` catches
unknown models, missing personas and skills, malformed choices, and placeholders no
declared input can fill, and exits non-zero when anything is wrong, so it fits a pre-commit
hook.

`workflow list` returns each workflow's `name`, `title`, `description`, `inputs`, `steps`,
`layer` and `path`, plus a top-level `errors` array for definitions that would not load:

```json
{
  "ok": true,
  "data": {
    "workflows": [
      {
        "name": "implement",
        "title": "implement — build the plan, tidy it, review it, fix until clean",
        "description": "Builds from a plan dir, a Linear issue or a description, …",
        "inputs": { "plan": "work-source" },
        "steps": ["build", "architecture", "simplify", "review", "fix", "mr"],
        "layer": "baseline",
        "path": "/home/you/.collie/workflows/implement.md",
        "extends": null
      }
    ],
    "errors": []
  }
}
```

## Start a run

```sh
collie --json run start <workflow> --input k=v [--input k=v …]
collie --json run start <workflow> --inputs-json '{"goal":"ship it"}'
```

| Flag            | What it does                                                                            |
| --------------- | --------------------------------------------------------------------------------------- |
| `--input k=v`   | Repeatable. The names come from `workflow show`, plus `branch` (below).                 |
| `--inputs-json` | Every input at once, as one JSON object.                                                |
| `--decide s=t`  | Repeatable. Answers Choice step `s` with title `t` now, so the run does not stop there. |
| `--request-id`  | Idempotency key — see [Retrying safely](#retrying-safely).                              |

`--input branch=<name>` is the one input no workflow declares, and `workflow show` lists it
for every mutating workflow. It names the branch the run works on, and so which worktree it
gets. A branch nobody named is resolved in this order:

1. `--input branch=<name>`, which wins over everything below.
2. The branch the reviewed work is already on, for a run fixing a review.
3. The `<name>` of a `branch:<base>...<name>` target **you gave** (`--input target=` takes a
   bare ref too, and turns it into one) — so the checkout and the review target agree. A
   target Collie inferred does not count: it names the branch you are standing on, and
   building that would hand the run your own checkout.
4. The plan directory's own name, for a run given a plan directory.
5. Otherwise a slug of the work itself — the description, or the issue id.

A name that would not survive being slugged is refused rather than fudged — one too long
for the cap, and one with nothing in it to slug at all, which is what `architecture` has.
Two plans under one directory would clip to the same branch, and two runs with no name of
their own would share a stand-in; the branch is what keys the worktree, so either way that
is one checkout for two pieces of work. The refusal is a `needs_input` naming `branch`, so
the same request id retries with `--input branch=`.

The resolved branch also names the run itself — its `slug`, and so its agents, its tab and
its row on the board — so what `run show` calls the run and what the checkout is on always
say the same thing.

It is ignored by a workflow that changes nothing.

`--input workspace=new` is a declared input of every mutating workflow, so it reaches the
same place from any front door and a `plan` that chains into `implement` hands its answer
on. It asks herdr for the checkout, so the run gets a workspace of its own instead of
staying in the workspace it was started from
([what a run does to your repository](using.md#what-a-run-does-to-your-repository)).
`--workspace <id>` is a different thing: it roots the run at that workspace, which is the
workspace its tabs open in.

Examples:

```sh
collie run start review --input target=https://gitlab.example.com/acme/app/-/merge_requests/2
collie run start review --input target=worktree --decide post="Fix findings"
collie run start implement --input plan=ENG-123
```

An unknown `--decide` step or title is refused before the run is created; the decision is
taken only if that choice is still available when the step is reached, and otherwise the
run asks and says why. `collie workflow show <name>` lists each Choice step's titles.

An input the workflow needs and inference cannot supply comes back as `needs_input` with
everything you need to fill the gaps and retry:

```json
{
  "ok": false,
  "error": {
    "code": "needs_input",
    "message": "plan needs input.",
    "details": {
      "inputs": [{ "name": "goal", "candidates": [], "question": "What is the goal?" }],
      "schema": { "goal": "goal", "ticket": "ticket" },
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
collie --json run show <run-id>
collie --json run list
collie --json run logs <run-id>
collie --json run output <run-id>
```

Without `--follow`, `run wait` prints one envelope when the run reaches a terminal state
— `succeeded`, `failed` or `stopped`. `--timeout` takes a spelled-out duration — `30 seconds`, `10 minutes`, `2 hours` — and
comes back as the `timeout` error code. Abbreviations like `30s` are refused as
`invalid_input`.

<!-- prettier-ignore -->
> [!IMPORTANT]
> A run that stops to ask a question is **not** terminal, so `run wait` keeps waiting
> through it. To catch questions, give the wait a `--timeout` and check `run show` for
> `awaiting` each time it expires, or poll `run show` on your own schedule.

A plan run that [fanned out over several repositories](workflows.md#plans-that-span-repositories)
stays `running` until the last of its repository runs ends, so `run wait` on it returns
when the whole plan is built or blocked rather than when the first run started. `run show`
on it lists the repository runs under its own line, so an agent can follow the fan-out
from the parent alone.

`--follow` streams instead of returning one envelope. It prints newline-delimited JSON
events, not the `ok`/`data` shape the rest of this page describes:

| Event                                           | When                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `{"type":"snapshot","run":…}`                   | Once, first thing, carrying the same `run` object as `run show`. |
| `{"type":"progress","runId":…,"at":…,"text":…}` | Each line the Driver has recorded since the last event.          |
| `{"type":"terminal","run":…}`                   | Once the run is `succeeded`, `failed` or `stopped`.              |

Failures still arrive as a normal envelope — a timeout, a run deleted mid-wait, or a
defect — so a consumer reads each line as JSON and branches on whether `type` is present.

`run show` is the snapshot. Its `run` object carries, among other fields:

| Field                                 | What it tells you                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `slug`, `workflow`, `cwd`       | Which run this is and where it works.                                                                                                                                         |
| `status`                              | `running`, `waiting`, `succeeded`, `failed` or `stopped`. `waiting` means the run is at a question — `awaiting` and `choices` say which.                                      |
| `iteration`, `max_iterations`         | Where a fix loop is.                                                                                                                                                          |
| `inputs`, `input_sources`             | What it was given, and where each value came from.                                                                                                                            |
| `steps[]`                             | Per step: `id`, `status`, `iteration`, `note`, and one `variants[]` entry per parallel agent with its `harness`, `model`, `effort`, `agent`, `paneId`, `status` and `output`. |
| `awaiting`                            | The question the run is waiting on, or `null`.                                                                                                                                |
| `choices`                             | The options that question offers.                                                                                                                                             |
| `parent`, `children`                  | Chained runs. `run show`'s human output lists each child as `<id>  <repo>  <status>`.                                                                                         |
| `fanout`                              | For a plan that spans repositories: the `waves`, the run each repository got, the merge requests they opened, the wave in flight, and the repository that stopped it.         |
| `disputed`, `deferred`, `outstanding` | Findings the loop is no longer driving, and why.                                                                                                                              |
| `mr_url`, `linear_issues`, `summary`  | What the run produced.                                                                                                                                                        |
| `progress[]`                          | The Driver's own log of what it did, with timestamps.                                                                                                                         |

## Answer a question

A run that reaches a Choice step reports `status: "waiting"` and fills `awaiting` and
`choices`. Relay the question and its options as written, then send the answer by its
title:

```sh
collie --json run show <run-id>                            # read awaiting + choices
collie --json run answer <run-id> "Implement now" --request-id "$(uuidgen)"
collie --json run show <run-id>                            # confirm it took
```

The answer is the choice's title, exactly as `run show` gives it. An empty answer dismisses
the menu and leaves the run open for `resume`. A title that is not on offer comes back as
`invalid_answer` with the valid ones in `details.answers`; a question already answered comes
back as `choice_already_answered`; a run that is not at a question comes back as
`run_not_waiting`.

## Stop and resume

```sh
collie --json run stop <run-id> --request-id "$(uuidgen)"
collie --json run resume <run-id> --request-id "$(uuidgen)"
```

`stop` closes only the panes that run owns. `resume` starts a fresh Driver and skips
finished steps; it refuses with `run_already_active` when a Driver still owns the run.

## Fork a definition

```sh
collie --json workflow fork review --layer user --mode extends --step review
collie --json persona fork reviewer --layer project --name strict-reviewer
```

| Flag           | What it does                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `--layer`      | `user` (your config dir) or `project` (this project's `.herdr/`).                              |
| `--mode`       | `extends` changes only what the fork names; `copy` takes the whole definition. Workflows only. |
| `--step`       | Fork only this step, leaving the rest following the parent. Workflows only.                    |
| `--name`       | The name the fork takes; it wins over the one it forked from.                                  |
| `--request-id` | Idempotency key.                                                                               |

An existing file at the target path comes back as `target_exists` rather than being
overwritten. See [Authoring](authoring.md) for what the resulting file means.

## Envelopes

With `--json`, every command prints exactly one line: a success or a failure envelope. That
holds for a crash too — a defect is caught and reported as `operation_failed` rather than
leaving you an empty stream and an exit status. The one exception is
[`run wait --follow`](#watch-a-run), which streams events and ends without an envelope when
the run finishes. The examples on this page are indented for reading; Collie writes each on
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

| Code                      | When                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `workspace_required`      | The command needs a workspace and none could be determined.                                           |
| `workspace_not_found`     | The `--workspace` id is not a workspace herdr has.                                                    |
| `workflow_not_found`      | No layer defines that workflow.                                                                       |
| `persona_not_found`       | No layer defines that persona.                                                                        |
| `run_not_found`           | No run with that id.                                                                                  |
| `run_already_active`      | A Driver still owns that run; stop it before resuming.                                                |
| `run_not_waiting`         | The run is not at a question.                                                                         |
| `invalid_answer`          | That title is not one of the choices on offer.                                                        |
| `choice_already_answered` | The question was already answered.                                                                    |
| `target_exists`           | A fork would overwrite a file that is already there.                                                  |
| `needs_input`             | Inputs are missing; `details.inputs` says which, with their questions.                                |
| `timeout`                 | `run wait --timeout` gave up.                                                                         |
| `invalid_state`           | The run is not in a state where that makes sense — resuming one that already succeeded, for instance. |
| `invalid_input`           | A flag or argument was wrong.                                                                         |
| `operation_failed`        | Anything else, including a caught defect.                                                             |

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

A failure carries the request id back in `error.details.requestId`, including when the id
was generated for you — so a failed send always leaves you something to retry with rather
than forcing a fresh id, which would be a second run rather than a retry. A `needs_input`
or `invalid_input` rejection writes no receipt, so the same id is free to reuse once you
have fixed the command.

`run start` and `run answer` are the two worth being careful with: without a request id, a
retried `run start` is a second run.

## Upgrading

```sh
collie upgrade
```

Pulls first where the installation is a checkout (`--ff-only`), then runs `prepare.sh` —
the one routine every entry point ends in, so this brings the plugin link, the runner and
shim, the operator skill and the skills up to date together rather than replacing the
runner alone. A pull it cannot do is reported rather than installed over.

The report names what moved: the commit range where the checkout advanced, and one line
per preparation step saying whether it was done, was already in place, or was skipped —
so "nothing to do" reads differently from "the runner updated but the skills step could
not run". A skipped step is not a failure: `upgrade` still succeeds. Under `--json` the
same steps are in `data.steps`.

## Checking an installation

```sh
collie doctor
collie doctor --json
```

Every prerequisite in one pass, each with the command that fixes it: herdr present and at
least the `min_herdr_version` the plugin manifest declares; the plugin linked from this
installation; the runner built and the `collie` shim on PATH (installed-but-not-on-PATH is
its own reported state); a Node runtime for the skills CLI; every skill and every harness
the loaded workflows and personas name; whether the checkout is behind its remote; and
`glab` present and logged in.

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
