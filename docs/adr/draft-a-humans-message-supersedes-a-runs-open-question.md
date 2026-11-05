# A human's message supersedes a Run's open question

**Status: draft.** Decided by the grill step of run-5f690f19, on the evidence of
run-28de56a3 (FRO-672). D8 was added by run-5f690f19.architecture. Amends [ADR-0062](0062-an-agents-question-is-asked-on-its-run.md):
an agent's question is closed when a human messages that agent directly, not only when its
step's Output is collected.

## What was true before

As of `cego/collie@4be825d2` (0.115.0):

- **A question stays open until it is answered.** `ask` (`src/sdk.ts`) records a row in
  `collie_decisions` and waits on a `DurableDeferred` named after it. The row's only
  settled state is `answer` (`src/store.ts`, `settle`). The agent question's `close` writes
  a sentinel string into `answer` (`closed: … finished before it was answered`,
  `src/agents.ts`). A workflow question has no close at all.
- **A pending question outranks everything on the board.** `stateOf` in `src/board.ts`
  returns `blocked` whenever a question is open. It does this before it looks at herdr's
  `working` status for the Run's agents, which the same function already reads.
- **A human message is a steer.** Desktop review comments, `collie run steer/deliver`, and
  chat's `collie_do deliver` all reach `registry.steer` with the Actor of the request
  (`src/host.ts`, `deliver`). The Dispatcher sends a `steer` cause even while a question is
  open: only `step` and `repair` wait behind one (`src/dispatcher.ts`). A finished Run
  whose agent was steered is **Reopened**, which is derived from the ledger and herdr. A
  running Run that is waiting on a question has no such reading.
- **Only Claude says who typed a turn.** Its `UserPromptSubmit` hook records each submit
  as `collie` (it carries a delivery token), `external` (typed in the pane) or `harness` (a
  task notification or an agent's message) (`src/compactors.ts`).

In run-28de56a3, `next-1` ("What next?") was asked at 12:17:20Z. At 12:28:02Z a Desktop
review comment on the plan was delivered `now` to the planner (`submitted`, turn started).
The planner rewrote `SPEC.md` and the tickets until about 12:32. The card, `run show` and
the Flow still said `needs-you` on "What next?", and the menu node showed no agent.

## Decision

**D1. A human's message supersedes the Run's open questions.** A question is superseded
when a Delivery that carries a human's words is `submitted` to one of the Run's live agents
while the question is open. Counted as a human's: the `board`, `desktop` and `cli-tty`
doors, and chat's `collie_do` when it carries the human's message from that turn. On
Claude, a submit the hook records as `external` also counts. Not counted: an agent's
Delivery, Collie's own causes (`step`, `repair`, `nudge`, `handoff`, `compaction`,
`correction`), a `harness` submit, `cli` without a terminal, `host` and `schedule`. A
harness that cannot say who typed a turn never supersedes anything. Its agent is still
shown working.

**D2. Superseding is a state of its own, never an answer.** The row records when it was
superseded, by which Delivery or submit, and by whose Actor. `answer` stays null. The
write is one UPDATE over a row that is still unanswered and not superseded. An answer uses
the same guard, so the database orders a supersede and an answer that race. Whichever
lands first stands. The other is refused, and the refusal says what happened. The Run's
audit trail gets a `supersede` line. Nothing is deleted.

**D3. A workflow's question is asked again when the work ends, if it still holds the Run.
The workflow's code does not change.** The workflow keeps waiting on the same deferred. When every agent the human
messaged has finished that work, the host opens a **revision** of the question under a new
name, with the same prompt and options. "Finished" means the agent's turn started and
ended, or the agent is gone, or no turn started within a short grace period. The answer to
the revision completes the original deferred. A further human message supersedes the
revision in the same way. A superseded question does not use up one of the workflow's
rounds. An answer naming the superseded question is refused, and the refusal names the open
revision. The one exception is D8. This applies to every Workflow's `ask`, not only `plan`'s menu. A revision opens only if
the question still holds the Run: nobody answered it under D8, the Run has not stopped, ended, failed or been
cancelled, and its Workflow is still suspended on that question. Collie never decides
from what the human wrote that the question is answered or moot, because that would
invent consent (D6). While the Workflow waits on the question, only an answer or a
stop moves the Run on.

**D4. An agent's own question is closed, not asked again.** A human message to an agent
supersedes that agent's open questions only. No revision is opened. If the agent still
needs to know, it asks again. Its later answer is never delivered. A superseded question
no longer holds Collie's next prompt to that agent.

**D5. While the work runs, the card says Working.** A question that is superseded and has
no open revision is not a Decision. The TaskView reads the agent's herdr status and the
human's message, in the way Reopened does. A revision is a new Decision, with a new
`needs-you` Notification and a new News item. The superseded question's News item is
superseded. Desktop, the board, `run show`, the Flow, chat and `run wait --until attention`
read the one store row, so all of them agree.

**D6. Superseding grants nothing.** It never chooses an option. It never confirms a
Proposal, and Proposals are not superseded. It never lifts a Hold, undoes a stop, or passes
an approval or release gate. No text in the message, its attachments or a file the agent
reads is taken as an answer. A stopped Run opens no revision. A held Run may: asking is not
work, and the work the answer starts still waits for the Hold to lift.

**D7. It survives a restart.** The rows are the state. A host that starts up finds
superseded questions that have no revision, checks whether their work has ended, and opens
revisions where it has. It never reads the answer from memory. A Delivery of a human's
words records whose they are in its ledger, so a host that dies after herdr took the message
but before it set the question aside still sets it aside.

**D8. The agent the human messaged may still answer.** While a Workflow's question is
superseded and no revision of it is open, an `answer` is accepted only from an agent the human messaged
to supersede it. That Actor is `agent`, and its `from.run` is this Run. The answer settles
the superseded row through D2's guarded write, completes the Workflow's deferred, and
leaves nothing to ask again. Every other door is refused, as D3 says. That covers the
board, Desktop, chat, the CLI and another Run's agent. Once a revision is open, the root
name refuses everyone, and the revision is answered like any question. This keeps
`plan`'s attended rule working: the human says "go" in a message, and the planner runs
`collie run answer … "Implement now"`. D8 grants nothing an agent cannot do today. The
agent's answer goes through the same option validation, the Hold still holds the work the
answer starts, and the audit trail records the agent's Actor. Collie itself still reads
no answer from the message's text (D6). An agent's own superseded question refuses every
answer (D4).

## Consequences

- A human can redirect a Run, or answer it in their own words, without first answering a
  question the work has already moved past.
- An answer from a stale card, made while the agent reworks the plan, is refused rather
  than starting `implement` on a half-written plan.
- `next-1` is asked again as `next-1` revision 2 after the planner finishes, so the human
  chooses after seeing the revised plan.
- Typing in a Codex, pi or OpenCode pane does not supersede anything until those harnesses
  can say who submitted a turn.

When this lands, CONTEXT.md's **Decision**, **Choice** and **Working** entries say that a
human's message supersedes a question, and a new **Superseded question** entry gives the
rule in D1–D3.
