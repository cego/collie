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
Collie Home is a state directory, not a project: choose the project workspace or checkout.
An older Run rooted in Home needs a fresh start against the project, not a resume.

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

Wait until there is something to do, rather than polling on a timer:

```sh
collie --json run wait <run-id> --until attention --timeout "2 hours"
```

It returns the moment the Run has a question or reaches a terminal state — immediately if
that is already true — so you never sit through a question you should be relaying. Read
`data.attention`:

- `category: "question"` — go to [Answer a question](#answer-a-question). `attention.choice`
  has the id, the question text and every option, so you can relay it without a `run show`.
- `category: "completed"` — it finished.
- `category: "interrupted"` — work stopped with something left to do. `attention.reason`
  says what (`review_exhausted`, `step_blocked`, `stopped`, `driver_lost`, or `failed`
  where nothing recorded says why), `attention.explanation` says it in a sentence you
  can relay, `attention.preserved` names the Steps a resume keeps, and `attention.actions`
  names what is safe. Offer the user exactly those: `resume` appears only where no Driver
  owns the Run **and** `attention.agentsAlive` is `absent` — an agent herdr still has
  working, or one it could not be asked about, is something a resume would restart a Step
  underneath. Never resume to "see if it works" — `run resume` re-checks both and refuses
  with `run_already_active` where either is there or cannot be ruled out. `unverified` is
  a retry once herdr is reachable, not a Run that can never be recovered.

`attention.actions` names the `run` subcommands that make sense next. A `timeout` error
code means neither happened in the time you gave it; wait again.

A plain `collie run wait <run-id>` — or `--until terminal` — is the older behavior: it waits
straight through questions to a terminal state. Use it only when the Run cannot ask
anything. `--follow` streams `{"type":"snapshot"…}`, `{"type":"progress"…}` and
`{"type":"terminal"…}` lines rather than one envelope, which is useful for narrating
progress; under `--until attention` it also emits `{"type":"attention"…}`.

Done when the wait reports a terminal status, or a question to relay.

## Answer a question

A pending question is in `data.attention.choice`: `id`, `header`, and `items`. A Run's
`awaiting` field can instead name an agent or step being waited on; it is not the question.

1. Use the answer already given in the user's request. Ask only when a decision is missing;
   when presenting options, preserve their titles so the answer matches.
2. Send the answer by its title, naming the question you are answering:

   ```sh
   collie --json run answer <run-id> "<title>" \
     --expect-choice "<attention.choice.id>" --request-id "$(uuidgen)"
   ```

   `--expect-choice` is what stops a late answer from landing on the next question: if the
   Run has moved on, it comes back as `choice_mismatch` and changes nothing.

3. Confirm with `collie --json run show <run-id>`.

Done when `run show` no longer reports that id in `data.attention.choice`.

## Resume or stop

```sh
collie --json run list
collie --json run resume <run-id> --request-id "$(uuidgen)"
collie --json run stop <run-id>   --request-id "$(uuidgen)"
```

`run list` finds the Run when the user names it by repo, workflow or "the one from this
morning" rather than by id. `resume` skips finished steps and keeps their Outputs; it
refuses with `run_already_active` while a Driver still owns the Run — or while whether one
does could not be determined — so `stop` first. `run show`'s `attention` says which case
you are in before you try.

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

An interrupted request with no recorded result returns `outcome: unknown` without running
again. Inspect the Run and its recorded effects before using a new request id. Native chat
returns its id as `Request: <id>`; reuse it as `request_id` for retries.
