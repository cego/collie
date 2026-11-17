# A finished Run's idle agent is closed

**Status: accepted, to be built.** Amended by
[ADR-draft-collie-runs-its-agents-in-herdr-core](draft-collie-runs-its-agents-in-herdr-core.md)
D12: while core cannot say a terminal is unattended, every agent is kept. Amends
[ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md) D1 (how a pane is
proved) and D6 (which processes go with what owns them). Builds on
[ADR-0041](0041-a-finished-run-still-takes-steering.md) D4 and
[ADR-0059](0059-a-stopped-agent-is-stopped-where-its-turn-runs.md). It brings back, for
finished Runs only, the idle close that run-4f8e87ed planned and dropped on 2026-10-16.

On 2026-10-20 vm-mk (62 GB, no swap) ran out of memory and was hard-reset at 07:57
(investigation run-a9f479ca). Agents of Runs that had ended days before held part of that
memory:

- the reviewers of run-65de59f1.implement, which failed on 2026-10-16, and of
  run-4f8e87ed.architecture.implement;
- run-20058fd6's grill, its second opinion and its implement builder;
- run-a38e5972's builder;
- about 30 `collie mcp` servers, each a Claude agent's child, up to 4 days 23 hours old.

Nothing in Collie ended them:

- A Run that finishes or fails halts none of its agents, on purpose (ADR-0041).
- The Task workspace sweep ends them an hour after the Task is **Finished**
  (ADR-0045 D3). A Task whose merge request is open is never Finished.

After the reboot herdr restored the panes it had saved. It relaunched 34 `pi` agents in
their sessions, holding 11.2 GB before any work. Each runs on a new terminal, so no launch
record proves it is Collie's, and nothing would ever end it. The workspace sweep also keeps
a workspace that holds such a pane, because a pane Collie did not open keeps it open.

run-4f8e87ed dropped this close because CPU was no longer the problem: 26 idle agents held
about 8 GB "but little CPU". It said to bring the close back if memory ran short. Memory
ran short.

## Decision

**D1. A finished Run's idle agent is closed** once all of these hold:

- A launch record of the Run names it. That leaves out the Home's and Desktop's chats and
  a human's own agents.
- Its Run has finished: `succeeded`, `failed` or `stopped`.
- herdr has reported it `idle` or `done`, without a break, for `idle_close_ms` since its
  Run finished. `idle_close_ms` is a setting in the Agents group, shown in minutes, 60 by
  default, where 0 means never. `blocked` is not idle.
- No Delivery to it is queued on the Dispatcher's ledger.
- No question it asked is open on its Run.
- Its pane is not focused.
- No Manual override has been recorded on it since it went idle.

The host keeps when each agent last went idle, from herdr's statuses. Its idle time counts
from then or from its Run's finish, whichever is later, so the time a builder sat idle
while its Run's review and gate ran does not count. An agent already idle when the host
starts counts from then, so a restart only delays a close.

The default is an hour for two reasons:

- A finished Run's builder stays steerable through the first hour after the Run finishes,
  however long it was idle before. run-20058fd6's builder was steered 37 minutes after its
  Run finished, and would still be reached.
- Past an hour a harness's prompt cache is cold. Its next turn re-reads its whole context
  anyway, so a Follow-up Run's new agent costs little more.

**D2. Closing is an end like any other.** It goes through the one end ADR-0059 describes:

- the agent is stopped where its work runs;
- it must be Quiet;
- its pane is closed;
- the Task's workspace is kept with a shell where it was the last pane.

The Run's log says `<agent> ended: idle for <N> min; its transcript is at <path>`, naming
the path where the harness reported one. The agent's `collie mcp` exits with it, on the
end of input it already exits on (ADR-0045 D6).

**D3. A closed agent stays closed.** ADR-0041 D4 is unchanged:

- A steer to a closed agent is refused, as for any gone pane, and names the Run's Follow-up.
- Collie does not relaunch an agent for a finished Run.

**D4. A pane herdr restored is the agent it restores.** herdr saves its sessions. After a
restart it relaunches each pane's agent in its harness session, on a new terminal and
sometimes without its name ([`docs/internals.md`](../internals.md), the Home).

- Such a pane is a Run's agent when the harness session herdr reports for it is the one
  Collie recorded for that agent.
- The idle close then judges and ends it as that agent.
- The Task workspace sweep counts it as Collie's pane rather than a human's.
- A restored pane that reports no harness session, or another one, proves nothing and is
  left alone.

**D5. One sweep does it.** The host's ten-minute **Cleanup** sweep gains the kind
`idle-agent`.

- `collie cleanup` lists each agent it would close and each it keeps, with why.
- `collie cleanup --apply` closes them now. Chat reaches the same sweep through its action
  set.
- Each close is recorded in `cleanup.jsonl` with its Actor.

**D6. Agents of live Runs are untouched.** This close leaves alone an agent of a `pending`
or `suspended` Run, such as:

- a planner while its implement child runs;
- an agent waiting on a question.

Such an agent ends with its Run, as it does today. run-4f8e87ed's dropped ticket 09 would
close one, with a successor and a hand-over. It stays dropped until a live Run's agents are
seen holding memory.

## Consequences

- A finished Run's agents live about an hour after the Run finishes or they go idle,
  whichever is later, plus up to one ten-minute sweep. A Task Waiting on you with an open
  merge request no longer keeps its agents for days.
- A finished Run can be **Reopened** only until its agents have been idle for an hour since
  it finished. After that, chat follows up instead (ADR-0041 D6).
- After a herdr restart, restored agents of finished Runs close within the hour, and they no
  longer keep a Finished Task's workspace open.
- An agent's `collie mcp` ends with the agent. No watch on its parent is added, because the
  servers seen on 2026-10-20 lived exactly as long as their agents. A `collie mcp` found
  with pid 1 as its parent would be the reason to add one.
