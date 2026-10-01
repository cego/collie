# The host is the only writer

**Status: accepted.**

## What was true before

Confirming or declining a proposal, recording what became of a Run's work, a steer and
a follow-up were written by whichever front door asked: the TUI board, the CLI and chat's
tools each appended to the proposals journal, the Run's dispositions and the Herd's
conversation themselves. Only a Collie on the same computer could do any of them.

## Decision

**D1. They are host operations.** `confirm` and `decline` take a proposal's id and its
content hash. `dispose` records a disposition, `steerAbout` has the
evaluator turn free words about one Run into actions and carries them out, and `followUp`
starts the follow-up a finished Run's Workflow declares. All are on `FrontDoorRpcs`
([ADR-0038](0038-the-host-builds-and-serves-the-board.md)) and take a request id.

**D2. Each records its Actor.** A yes or a no is a line in its Herd's proposals journal,
by the front door the channel declared ([ADR-0039](0039-every-operation-records-who-asked.md));
the same request twice returns what it did the first time. A disposition, a steer and a
follow-up are lines in the Run's `operations.jsonl`.

**D3. The host finds the Herd.** A proposal is looked up by id across every Herd's
journal, and a steer is recorded against the Herd the Run's Task is in, or the host's
own. A front door names no Herd.

## Consequences

- A front door on another computer can do everything the TUI board can.
- The host runs a confirmed proposal's actions, so a `navigate` reaches no screen there:
  the board puts the target on screen itself once the host says it applied.
- What chat's `collie_do` and `collie_propose` carry out directly, and the CLI's own
  receipts, are still written by the front door.
