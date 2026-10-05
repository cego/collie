# A finished Run still takes steering

**Status: accepted.** Replaces the sentence "a finished Run is immutable; there is no mode
that reopens one" in [`CONTEXT.md`](../../CONTEXT.md) (Follow-up Run),
[`docs/steering.md`](../steering.md) and [`docs/cli.md`](../cli.md). Nothing else in
[ADR-0010](0010-a-run-proves-its-outcome.md), [ADR-0018](0018-a-native-run-is-a-run.md)
or [ADR-0021](0021-one-host-answers-for-a-run.md) changes.

A Run's status says how its Workflow's steps ended. It does not say that the Run is
closed. Its agents keep taking the human's steering for as long as one of them is alive,
through the same Dispatcher, ledger and receipts as a Run that is still going.

## What was true before

On 2026-10-01 the shepherd asked chat to have run-a7131d62's builder agent merge, tag and
release PR #30. `collie_do deliver` came back `skipped — the run is succeeded`, although
the agent's pane was alive and idle. Chat then typed into the pane with herdr. That send
had no ledger line, no receipt and no provenance, so the agent stopped and asked the human
to confirm what they had already ordered.

The refusal was policy, not a limit. The admission check refuses every Run-scoped action
on a `succeeded`, `failed` or `stopped` Run except `followup`, `resume`, `navigate` and
`remember_verification`, and refuses a `deliver` whenever the Run has settled. Below it,
the host's steer reads the Run's launch journal and sends through the Dispatcher, and it
never looks at the status. It would have delivered.

## Decision

**D1. Status is history, and nothing rewrites it.** A Run's status is how its Workflow's
execution ended. The Effect-native engine is not re-entered for a finished Run, and no
Activity is added to it. A succeeded Run still reads `succeeded` in `run show`, in
`collie_run` and in the engine. Its disposition stays a separate fact beside the status.

**D2. A finished Run's steering is admitted on facts, never on its status.** Each action
kind is refused only for a reason that is true now:

| Action                                                    | On a finished Run                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `deliver`                                                 | Sent to the agent's live incarnation. Refused only when no incarnation of it is alive.                    |
| `answer`                                                  | Refused only when the Run asks no Choice, which a finished Run never does.                                |
| `update_intent`                                           | Amended and versioned, as for a running Run. A `deliver` is what tells the agent.                         |
| `clear_override`                                          | Cleared, as for a running Run.                                                                            |
| `stop`                                                    | Closes the panes of its live agents. The status is not rewritten.                                         |
| `hold`, `release`                                         | Refused: a finished Run has no step left to hold. `stop` is what closes its agents.                       |
| `set_verification`                                        | Refused: its checks were collected when it finished. `remember_verification` keeps them for the next Run. |
| `followup`, `resume`, `navigate`, `remember_verification` | Unchanged.                                                                                                |

Both front doors reach this one admission. The host serves a steer or a stop for any Run
it has a row for, whether or not that Run's Workflow module is still registered: a
finished Run's agents need its launch journal, not its code.

**D3. An alive pane is told, through the Dispatcher.** A message to a finished Run's agent
goes out exactly as it would for a running Run: the incarnation is checked, the ledger
lock is held across compaction, composition and send, the text carries Collie's delivery
token, and every state is recorded. A `deliver` result is `applied` only when the
Dispatcher reports the text sent. Anything else is `failed` with the Dispatcher's reason,
so a receipt never reads as delivered when it was not.

**D4. A gone pane is not revived.** When no incarnation of the named agent is alive, the
`deliver` fails and says so. It names the route that carries the request on: the Run's
own follow-up offer with the message as its input, or a new Run on its branch where the
Run offers none. Collie does not relaunch an agent for a finished Run. An agent is
launched once per operation ([ADR-0020](0020-an-agent-is-launched-once-and-its-output-is-decoded.md)),
and new work with new steps is a Run of its own.

**D5. Reopened is derived, not stored.** A finished Run is **Reopened** once one of its
agents has been sent a steer Delivery after the Run finished. Nothing new is recorded: the
ledger says what was sent and when, and herdr says whether the agent is working. The board
draws a Reopened Run by what its agent is doing:

- **Working** while herdr reports that agent `working`. The sentence says what it was
  told, from the first line the Run's log recorded.
- **Needs you** while herdr reports that agent `blocked`, as for any stalled Run.
- Otherwise by its own facts again: Waiting on you, Ready to release or Landed.

`collie_herd` reads the same TaskView. `collie_news` gets one item when a Reopened agent
that took a Delivery is idle again, keyed by that Delivery, so each request is reported
once.

**D6. Follow-up stays the way to start new steps.** Steering is the same Run, the same
agent and the same Intent. A **Follow-up Run** is a new Run of a Workflow, with its own
steps, Intent and evidence, reusing the worktree under the existing guards. Chat chooses
by what is alive and what is asked: tell a live agent, or follow up when the work needs a
Workflow or the agent is gone.

## Consequences

- The board's Working section can hold a succeeded Run. Its step glyphs still show every
  step done, because they are the Workflow's steps.
- Finishing is unchanged. The alignment verdict and the evidence collected at the end are
  about the Run's steps. Work done after a steer is not re-judged by Collie, and drift is
  not evaluated on a finished Run. What the steered agent changed is evidence for the next
  Run, or for the forge's checks on the merge request.
- A not-delivered `deliver` used to come back `applied` with "Nothing was delivered" in
  its note. It is now `failed`, which is what it was.
- No drift correction goes to a finished Run's agents. Corrections are sent at a running
  Run's work boundaries ([ADR-0037](0037-collie-corrects-by-default.md)), and a finished
  Run has none left.
- Typing into a Collie agent's pane by hand is never the route. Chat's prompt says so,
  and the pane gets a Manual override if it happens anyway.
- Closing a finished Task's workspace or its idle agents ends what can be steered. That is
  the pane-gone path, not an error.
