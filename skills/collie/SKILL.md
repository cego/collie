---
name: collie
description: Operate Collie runs through its CLI. Use when the user wants to start a workflow (plan, implement, review, architecture), check or watch a run, answer a run's question, resume or stop a run, or write, check or fork a workflow or persona.
---

# Operating Collie

`collie` runs codified agent workflows. You drive it; the Run itself is executed by the one
Collie host in the background, which the CLI, the board and chat all reach, and which keeps
the Run going when you disconnect.

Every command takes `--json` and prints exactly one envelope: `{"ok":true,"data":{…}}` or
`{"ok":false,"error":{"code":…,"message":…,"details":{…}}}`. Read the `data`, not the human
line. The exception is `run wait --follow`, which streams newline-delimited lines instead.
Full flags, envelope shapes and error codes are in `docs/cli.md` in the Collie repository
(`~/.collie/docs/cli.md` for a standard install) — go there for anything past the happy
path. Vocabulary — Run, host, Choice, Hand-off — is in `CONTEXT.md` beside it.

**Coordinate with a Run through these commands.** The host holds the Run: `run show`,
`run wait` and `run answer` are how you read and change it, never its files.

## Discover what is available

The environment is the source of truth: a user or project layer may have overridden any
workflow, so never assume a workflow's name, inputs or steps.

```sh
collie --json workflow list
collie --json workflow show <workflow>
```

A workflow is a TypeScript module, and `workflow show` prints what a Run actually gets: its
`layer` and `path`, each entry of `inputs` with its `strategy` and its JSON `schema`, the
`options` the host settles beside your input, and the `success` and `error` schemas. A
`limits` list is a place the drawn schema says less than the real one — not a fault. The
same reading answers `collie_definitions` and fills a `needs_input` refusal, so ask it once.

Done when you can name the workflow and every input it declares.

## Start a Run

First settle where the Run roots, because it decides which repository the work happens in:
the current directory by default, `COLLIE_CWD=<path>` for another one, or
`--workspace <id>` to scope to a herdr workspace and root the Run at its directory.
Collie Home is a state directory, not a project: choose the project workspace or checkout.
An older Run rooted in Home needs a fresh start against the project, not a resume.

```sh
collie --json --workspace <id> run start <workflow> \
  --input <name>=<value> --request-id "$(uuidgen)"
```

Inputs Collie can infer it will infer. What it cannot comes back as `needs_input`, with
`details.inputs` naming each missing input and its question — ask the user those questions,
then retry with the same `--request-id`.

`branch` is one of the names the host settles rather than one a workflow declares —
`workflow show` lists them under `options`, with what each means. It names the branch the
Run works on, is derived from the target or the plan directory when you leave it out, and
comes back as `needs_input` when nothing names one.

A Run asks its questions when it reaches them. `--decide`, `--goal` and `--constraint`
are refused rather than recorded: answer the question when the wait returns it.

Done when you have reported the Run id to the user and said how you will watch it.

## Watch a Run

Wait until there is something to do, rather than polling on a timer:

```sh
collie --json run wait <run-id> --until attention --timeout "2 hours"
```

It returns the moment the Run is suspended — at a question, held, stopped or parked — or
has ended, immediately if that is already true, so you never sit through a question you
should be relaying. Read `data.run`:

- `status.status` is `pending` (working), `suspended`, `complete` (with its `value`) or
  `failed` (with its `reason`).
- `waiting` lists every question it has been asked, oldest first: `name`, `prompt`,
  `options`, and `answer`, which is `null` while it is open. An open one: go to
  [Answer a question](#answer-a-question).
- `controls` names a `hold` or a `stop` someone set over it.
- `parked` is why the Run parked its own work and what picks it up again — a pane that
  would not take a prompt, nothing approved to prove it, a workspace that closed with its
  checkout gone. Relay it as written; it names the repair.
- `diagnostic` is why the engine could not be asked, such as a module that is missing,
  with the file named.

A `timeout` error code means none of that happened in the time you gave it; wait again.

A plain `collie run wait <run-id>` — or `--until terminal` — waits until the Run has ended,
straight through questions, holds and stops. Use it only when the Run cannot ask anything.
`--follow` prints one `{"type":"status","run":…}` line each time the status changes rather
than one envelope, which is useful for narrating progress.

Done when the wait reports an ended Run, or something to relay.

## Answer a question

An open question is an entry in `data.run.waiting` with `answer: null`.

1. Use the answer already given in the user's request. Ask only when a decision is missing;
   when presenting options, preserve them so the answer matches.
2. Send the answer, naming the question you are answering:

   ```sh
   collie --json run answer <run-id> "<option>" \
     --decision "<name>" --request-id "$(uuidgen)"
   ```

   `--decision` is what stops a late answer from landing on another question: one already
   answered is refused with what the Run already has, and an option the question does not
   take is refused with the ones it does.

3. Confirm with `collie --json run show <run-id>`.

Done when `run show` reports that question with its answer.

## Resume or stop

```sh
collie --json run list
collie --json run resume <run-id>  --request-id "$(uuidgen)"
collie --json run stop <run-id>    --request-id "$(uuidgen)"
collie --json run release <run-id> --request-id "$(uuidgen)"
```

`run list` finds the Run when the user names it by repo, workflow or "the one from this
morning" rather than by id. `resume` asks the host to pick a suspended Run up again: it
re-enters the workflow's current code and reuses everything already done, so finished work
is kept, an agent already launched is reattached to, and a parked Run is handed the same
prompt. `stop` parks the Run where it is and leaves its agents alone; a held Run carries on
with `release`. A Run an older Collie recorded is read-only: begin its work again with
`run start`.

Done when `run show` reports the state the user asked for.

## Write, check or fork a workflow

A workflow is a TypeScript module saved where a Run looks for one:
`~/.collie/user/workflows/<id>.workflow.ts` for the user's own, `.herdr/workflows/` for a
project's. Saving the file is the whole of it — there is no registry to edit, nothing to
rebuild and no host to restart. Never write workflow YAML: it is not what runs.

```sh
collie --json workflow create <id> --request-id "$(uuidgen)"
collie --json workflow fork <id> --layer user --name <yours> --request-id "$(uuidgen)"
collie --json workflow check <id>
```

`create` writes a runnable module and the setup to typecheck it beside it — an existing
`package.json` or `tsconfig.json` is left alone, and nothing is written over a file that is
already there. `fork` writes one that imports the original and hands `make` on, so
everything it does not name is still the original's; there is no step to merge, so `--mode`
and `--step` are refused on a module. Both return `data.path` — tell the user where the
file landed. `data.toolchain` is not null when nothing could be installed to typecheck
with: the module still runs, and say so rather than implying it was checked.

Then edit the file with your editor and run `workflow check <id>` — it loads, constructs and
typechecks the module without starting a Run. `problem(s)` is what stops it running,
`drawn without:` is a projection limit and not a fault, and `ok, not typechecked` means
nothing compiled it. Read `~/.collie/docs/sdk.md` before writing the body.

`collie --json persona fork <name> --layer user --request-id "$(uuidgen)"` forks a persona,
which is Markdown and is copied whole.

Done when the file exists and `workflow check` passes.

## Retrying

Every mutation — `run start`, `run answer`, `run stop`, `run resume`, `workflow create` and
both forks — takes `--request-id`. Generate one per intended action and reuse it for every
retry of that
action: Collie returns the first result instead of repeating the effect. Without one, a
retried `run start` is a second Run. A failure carries the id back in
`error.details.requestId`, so there is always something to retry with. Exit statuses and
which failures are worth retrying: `docs/cli.md`.

An interrupted request with no recorded result returns `outcome: unknown` without running
again. Inspect the Run and its recorded effects before using a new request id. Native chat
returns its id as `Request: <id>`; reuse it as `request_id` for retries.
