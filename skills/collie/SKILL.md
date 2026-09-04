---
name: collie
description: Operate Collie runs through its CLI. Use when the user wants to start a workflow (plan, implement, review, architecture), check or watch a run, answer a run's question, resume or stop a run, or fork a workflow or persona.
---

# Operating Collie

`collie` runs codified agent workflows. You drive it; the Run itself is executed by a
detached Driver that owns its own state.

Every command takes `--json` and prints exactly one envelope: `{"ok":true,"data":{…}}` or
`{"ok":false,"error":{"code":…,"message":…,"details":{…}}}`. Read the `data`, not the human
line. The exception is `run wait --follow`, which streams newline-delimited events instead.
Full flags, envelope shapes and error codes are in `docs/cli.md` in the Collie repository
(`~/.collie/docs/cli.md` for a standard install) — go there for anything past the happy
path. Vocabulary — Run, Driver, Choice, Hand-off — is in `CONTEXT.md` beside it.

**Coordinate with a Run through these commands.** The run directory belongs to its Driver:
`run show`, `run wait` and `run answer` are how you read and change a Run.

## Discover what is available

The environment is the source of truth: a user or project layer may have overridden any
workflow, so never assume a workflow's name, inputs or steps.

```sh
collie --json workflow list
collie --json workflow show <workflow>
```

`workflow show` prints the resolved workflow — the inputs and steps a Run actually gets.

Done when you can name the workflow and every input it declares.

## Start a Run

First settle where the Run roots, because it decides which repository the work happens in:
the current directory by default, `COLLIE_CWD=<path>` for another one, or
`--workspace <id>` to scope to a herdr workspace and root the Run at its directory.

```sh
collie --json --workspace <id> run start <workflow> \
  --input <name>=<value> --request-id "$(uuidgen)"
```

Inputs Collie can infer it will infer. What it cannot comes back as `needs_input`, with
`details.inputs` naming each missing input and its question — ask the user those questions,
then retry with the same `--request-id`.

`branch` is an input of every mutating workflow that no workflow declares: it names the
branch the Run works on, is derived from the target or the plan directory when you leave it
out, and comes back as `needs_input` when nothing names one.

Add `--decide <step>=<title>` for a Choice step you already know the answer to, so the Run
does not stop there. `workflow show` lists each Choice step's titles.

Done when you have reported the Run id to the user and said how you will watch it.

## Watch a Run

A Run that stops to ask a question is not in a terminal state, so a plain
`collie run wait <run-id>` waits straight through it and you would never relay the
question. Bound the wait and check between rounds:

```sh
collie --json run wait <run-id> --timeout "2 minutes"   # `timeout` code = not done yet
collie --json run show <run-id>                        # status, and `awaiting` if asking
```

`run show`'s `status` is `running`, `waiting`, `succeeded`, `failed` or `stopped`. On
`waiting`, go to [Answer a question](#answer-a-question). On `timeout`, relay the step and
iteration from `run show` and wait again.

`run wait --follow` is the other option: it streams `{"type":"snapshot"…}`,
`{"type":"progress"…}` and `{"type":"terminal"…}` lines rather than one envelope, which is
useful for narrating progress — but it too ends only on a terminal state, so pair it with a
timeout if the Run can ask something.

Done when `run show` reports a terminal status, or `awaiting` with a question to relay.

## Answer a question

A Run at a question reports `status: "waiting"`, with the question in `awaiting` and the
options in `choices`.

1. Relay the question and every option to the user verbatim. The titles are the answer, so
   changing their wording costs the user the ability to choose.
2. Send their choice by its title:

   ```sh
   collie --json run answer <run-id> "<title>" --request-id "$(uuidgen)"
   ```

3. Confirm with `collie --json run show <run-id>`.

Done when `run show` no longer reports that question in `awaiting`.

## Resume or stop

```sh
collie --json run list
collie --json run resume <run-id> --request-id "$(uuidgen)"
collie --json run stop <run-id>   --request-id "$(uuidgen)"
```

`run list` finds the Run when the user names it by repo, workflow or "the one from this
morning" rather than by id. `resume` skips finished steps; it refuses with
`run_already_active` while a Driver still owns the Run, so `stop` first.

Done when `run show` reports the state the user asked for.

## Fork a workflow or persona

```sh
collie --json workflow fork <name> --layer user --mode extends --step <step-id> \
  --request-id "$(uuidgen)"
collie --json persona fork <name> --layer user --request-id "$(uuidgen)"
```

`--layer user` is the user's own config directory; `--layer project` is this project's
`.herdr/`. `--mode extends` keeps following the baseline and changes only what the fork
names; `--mode copy` takes the whole definition and stops following. The result envelope
carries the path — tell the user where the file landed, then `collie --json workflow check
<name>` before they rely on it.

Done when the file exists and `workflow check` passes.

## Retrying

Every mutation — `run start`, `run answer`, `run stop`, `run resume`, both forks — takes
`--request-id`. Generate one per intended action and reuse it for every retry of that
action: Collie returns the first result instead of repeating the effect. Without one, a
retried `run start` is a second Run. A failure carries the id back in
`error.details.requestId`, so there is always something to retry with. Exit statuses and
which failures are worth retrying: `docs/cli.md`.
