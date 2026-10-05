# Every operation records who asked

**Status: accepted**, amended 2026-10-02 (D5: a chat's actions carry the human's words).

## What was true before

A human's answer, a stop, a hold, a resume, a start and an offer invoked reached the host
with nobody's name on them. The CLI guessed `cli-tty` from a terminal alone, so a `collie`
command an agent ran in its own pane read as a person.

## Decision

**D1. The operations are front-door operations.** `start`, `answer`, `control` (hold or
stop, set or cleared), `resume` and `invoke` are on `FrontDoorRpcs`
([ADR-0038](0038-the-host-builds-and-serves-the-board.md)), not the internal `HostRpcs`.
Each takes a request id: the same request twice is one operation, and the same request
asking for something else is refused.

**D2. A channel declares its front door once.** The first thing a channel sends is
`declare` with its front door (`board`, `cli`, `cli-tty`, `chat` and the rest of an
Actor's origins). The host stamps every operation on that channel with it, so nothing
that performs an operation can name its own origin. A channel that declares nothing is
`cli`, which is never a human. `declare` may also name the herdr session the front door
runs in (`session`); what it confirms, asks for or proposes is carried out in that session,
or in the host's own where it names none.

**D3. The Run's audit trail holds it.** Each operation is a line in the Run's
`operations.jsonl`: what it was, the request, the Actor (front door and request id) and
what came of it. An offer invoked is recorded on the Run that offered it. The host writes
it; nothing else does.

**D4. `cli-tty` is a terminal in a pane that is not an agent's.** A `collie` command is
`cli-tty` only with a terminal on one of its streams, run in a pane herdr does not report
as an agent's or outside herdr altogether. Where herdr cannot say, it is `cli`.

**D5. A chat's actions carry the human's words** (amended 2026-10-02). A chat's channel
also declares its conversation and the human's message from that turn, and the host records
both in the Actor beside the front door. The message is attached by the tool host, from what
the harness's own prompt hook handed it, and never by the model: `collie_do` takes no field
for it and refuses one. The words last for the turn they were said in: Claude's `Stop` hook
forgets them, so a turn nobody prompted carries none. Native chat's conversation is
`native`, the name its News receipts carry. Like the rest of this record it is honest, not secure: a model with a shell could
still write the file its tool host reads.

## Consequences

- An audit names who stopped, held, resumed, answered, started or carried on with each Run.
- A front door on another build or computer performs these through the same door it
  reads the board through.
- This keeps the record honest; it is not security. Anything that reaches the host's
  socket runs as the user.
