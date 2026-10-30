# An agent's question is asked on its Run

Amended by [ADR-draft-collie-runs-its-agents-in-herdr-core](draft-collie-runs-its-agents-in-herdr-core.md): a Codex agent's question is asked on its Run, as a Claude agent's is.

renovate run-8dc1f7bf parked at 13:58:51Z on "has written nothing to batch.json yet"
(investigation run-556cba08). Its two-hour Output budget ran out while the agent was still
working: it had committed at 13:55 and was running the repository's suite. Part of those two
hours went on Claude's `AskUserQuestion`, which the batch content asks for ("Anything larger
is a consultation"). Later questions waited 16 hours and 1.3 hours in a pane nobody was
looking at, and a delivery to the agent failed with herdr's `agent_blocked`. Collection only
polled the Output file. It never read herdr's status, so it could not tell a working agent
from one waiting on a human or one that had stopped. Nothing reached chat or Desktop except
the board's "waiting in its pane".
[ADR-0021](0021-one-host-answers-for-a-run.md) has a question asked through the host so the
host knows it is open. This one never was.

## Decision

**The Output budget is the agent's idle time.** Collection reads herdr's status for the
agent as it polls for the Output. While the agent is `working` or `blocked`, or while a
question it asked is open on the Run, the budget does not run. Time it is `idle` or `done`
counts, and so does a status herdr cannot read, so an agent nobody can see is still parked
in the end. The budget is still `collectMs`, two hours by default. When it runs out, the
Run parks as it does today, and a gone agent is still revived or repaired the way it is
today. Nor does the budget run while a `collie verify` the agent asked for waits for
memory. Added by
[ADR-draft-new-work-waits-while-its-machine-is-short-of-memory](draft-new-work-waits-while-its-machine-is-short-of-memory.md)
D7.

**A managed Claude agent's `AskUserQuestion` is asked on its Run.** Among the hooks Collie
installs for a Claude agent it launches is a `PreToolUse` hook on `AskUserQuestion`. The
hook receives the call's questions, each with its options and whether it takes several. It
hands them to the host, and denies the call with a reason telling the agent that its
question is now on its Run, that it should end its turn, and that the answer will be its
next message. The host records each question as a **Decision** on the Run, through the
same `asking` a Workflow's `ask` uses, and raises `needs-you` for it. A question takes one
of its options or an answer in the human's own words, as the tool did. The card, chat
(`collie_do answer`) and `collie run answer` all answer it. Once every question from that
one call is answered, the host sends the answers to the agent through the Dispatcher as one
Delivery, each answer beside the question it answers. A human who types the answer into the
pane instead has answered the agent directly. A question still open when that step's Output
is collected is closed, so no answer is sent into later work.

The hook is instant. It never holds the call while a human decides: a command hook that
times out falls back to the harness's own prompt in the pane, where a later answer from the
card could not reach it.

**Another harness's dialog stays in its pane.** An agent herdr reports `blocked` that asked
nothing Collie could take is still **Stalled**, and the card says which pane to go to.
Collection's budget is paused meanwhile. Reading a question off a pane and pressing keys to
answer it was considered and rejected: it scrapes a terminal UI, needs a key mapping per
harness, and would have to be proven live for each one before any could be steered
([`docs/steering.md`](../steering.md)).

**Work that does not need a human does not ask one.** A step whose content once said
"consultation" for something an agent can decide takes its own recommended option and
reports what it chose. renovate's `batch` leaves a bump that needs more than a small fix out
of the batch, reports it with its recommendation, and carries on. A consultation that is the
point of a step, such as `assess` reporting a breaking migration before anything lands, still
asks, and is now asked on the Run.

## Consequences

- A Run whose agent is working is never parked for being slow, however long its suite takes
  on a loaded Machine. One that went idle without writing its Output still parks after two
  hours of idleness.
- An agent's question is something chat and Desktop can see and answer, and it outranks
  what the step was doing on the card, as a Workflow's question does.
- `plan`'s interview is asked on the card, not in the pane's question widget. A multi-select
  question, or one with previews, is shown as its prompt and its options, and the human can
  still answer it by typing in the pane.
- The rule relies on the agent ending its turn when it is denied. One that decides for itself
  instead records the decision under `assumptions`, as an agent with nobody to ask already
  does ([`docs/sdk.md`](../sdk.md#having-an-agent-do-the-work)), and the open question closes
  with the step.
- Only Claude has a hook that can take a question before it reaches the pane. Codex,
  OpenCode and Pi agents stay as they are, with the budget paused while they are blocked.

## Amended 2026-10-19: the budget parks the Run, and collection goes on

run-33c8f85a.implement's builder kept working after its park and wrote `build.json` two
hours later. Nothing read it until a human resumed the Run seven minutes after that
(cego/collie#127). Counting only idle time makes that park rarer, but a park still
suspended the Run, and after it nothing read the Output file.

- **When the budget runs out, the Run is parked and keeps waiting.** It shows that it needs
  you: the agent has written nothing, Collie is still collecting, and an agent that has
  stopped should be asked to write it. Collection goes on reading the Output with no budget,
  as a slow compaction does since [ADR-0007's 2026-10-15 amendment](0007-compact-a-reused-agent-at-a-work-boundary.md).
  An Output that arrives later clears the park and the step goes on, without a resume.
- **An agent whose subscription ran out is waited for the same way.** While no agent has
  room ([ADR-0049](0049-work-goes-to-an-agent-with-usage-left.md) D8), its budget's park no
  longer ends the wait for one that has. Its Output or an agent with room, whichever comes
  first, clears the park and the step goes on.
- **Everything a human could do still works.** A stop ends the wait, a hold takes effect
  as it does inside the budget, a steer reaches the agent, a host restart reattaches to the
  wait, and a gone agent is revived or repaired as it is today. A background `collie verify` is still reported to the agent
  ([ADR-draft-an-agent-is-told-when-its-verify-ends](draft-an-agent-is-told-when-its-verify-ends.md)),
  because Collie is still collecting from it.
