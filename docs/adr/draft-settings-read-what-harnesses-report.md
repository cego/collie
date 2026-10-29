# Settings read what harnesses report

**Status: accepted, being built.** Builds on
[ADR-0049](0049-work-goes-to-an-agent-with-usage-left.md), whose Usage readings it copies
in shape, and on [ADR-0038](0038-the-host-builds-and-serves-the-board.md) for how a host
serves it. [ADR-0030](0030-a-workflow-is-one-definition-and-its-agent-is-decided-in-scope.md)
still decides which agent a piece of work gets.

## What was true before

The models and efforts a Harness accepts were a table in Collie's source, `HARNESS_MODELS`,
plus whatever a human typed into `models.<harness>`. Each Harness release made that table
stale. A new model failed every check until a Collie release named it, or until someone
typed its name. Desktop read Claude Code's and Pi's real lists, but only for the Flock chat
and only on the computer Desktop ran on. Nothing could say which models another Machine's
harnesses offer.

## Decision

**D1. Each Machine's host reads its Harness catalogue from its harnesses.** Every Harness
that Collie launches already reports what it offers:

- Claude Code answers the Agent SDK's `supportedModels()`. The host sends the same
  stream-json `initialize` that the SDK sends, without taking the SDK on as a dependency.
- Codex answers `model/list` on its app server.
- Pi answers `pi --list-models`.
- OpenCode answers `opencode models`.

Each source gets one adapter on the host and one fake in the tests, as `src/forge/` does. A
decoder per source turns its answer into catalogue entries: the model's id, name,
description, efforts, default effort, and whether it is hidden. Each decoder is tested
against output recorded from the real Harness.

**D2. It is read and served as Usage is.** The reading is kept on the host and read at most
once every 30 minutes, with 20 seconds allowed per read. A Harness is read only when
something asks for its catalogue. The `models` operation serves it on the board protocol.
The operation is additive, so `PROTOCOL` stays 4. `collie models`, a `collie_models` chat
tool and Desktop all read that one operation, which keeps the front doors in agreement
(invariants 1 and 2).

**D3. A Harness that cannot be read falls back to Collie's table, and says so.** A failed
read, an answer Collie cannot decode, or no answer within 20 seconds leaves that Harness on
`HARNESS_MODELS`, with the reason: "from Collie's table: <why>". The next read waits a
minute, and the wait doubles with each failure after that, up to the 30-minute interval. A
missing Harness costs nothing, and a broken one is not asked again on every read. A Harness
that is not installed is absent from the catalogue rather than on the table. Nothing could
run on it anyway.

**D4. `models.<harness>` adds to the catalogue instead of being its source.** It names a
model a Harness hides or does not list. Each such model is added after the Harness's own
and marked as added.

**D5. Desktop's chat reads its own Machine's catalogue.** Where this computer has a
Machine, the Flock chat's Claude and Pi lists come from that Machine's host. Where it has
none, or its host is older than the operation, Desktop's own readers stay.

**D6. A choice is checked against the Machine that will run it.** Admission checks a
Run's explicit choice, and each new agent choice is checked before a pane opens. A
successful reading supplies the models and each model's efforts; the table's patterns do
not extend it. `models.<harness>` remains an explicit addition. A refusal names the
Machine, the requested model or effort, and what that Machine reports. Where the reading
failed, the existing table check and configured additions apply, and the refusal gives
the fallback reason. An absent Harness is refused as not installed.

The same check applies to each fallback candidate. The Flock chat checks this computer's
catalogue before opening its session, including a saved choice made before the reading
arrived. A pinned default is checked as its pinned model. A native default stays with the
Harness; an explicit effort requires a named model whose catalogue lists that effort.
Codex receives an accepted effort as
[`model_reasoning_effort`](https://learn.chatgpt.com/docs/config-file/config-reference)
in both its App Server and TUI configuration.

## Consequences

- A new model shows up without a Collie release, at most 30 minutes after the Harness on
  that Machine lists it.
- Pi's list says only whether a model thinks. A thinking Pi model is offered the efforts in
  Collie's table, which is coarser than Desktop's own Pi reader.
- A Harness's list follows its login. A Machine logged in to another account can offer
  other models, and each Machine's catalogue says what that Machine itself can run.
- A model that only the table knows stops being accepted after a successful reading omits
  it. Add it to `models.<harness>` if the Harness can run it despite leaving it out.
- Showing on how many Machines a model is offered builds on this catalogue and is not
  decided here.
