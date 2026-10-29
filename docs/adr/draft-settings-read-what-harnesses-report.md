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

## Consequences

- A new model shows up without a Collie release, at most 30 minutes after the Harness on
  that Machine lists it.
- Pi's list says only whether a model thinks. A thinking Pi model is offered the efforts in
  Collie's table, which is coarser than Desktop's own Pi reader.
- A Harness's list follows its login. A Machine logged in to another account can offer
  other models, and each Machine's catalogue says what that Machine itself can run.
- Checking a Run's model and effort against its Machine's catalogue before the agent starts
  builds on this catalogue, and so does showing on how many Machines a model is offered.
  Neither is decided here.
