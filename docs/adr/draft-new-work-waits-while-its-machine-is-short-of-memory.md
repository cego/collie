# New work waits while its Machine is short of memory

**Status: accepted, to be built.** On 2026-10-16 run-4f8e87ed left "per-Machine caps on
concurrent Runs" out of scope. This adds no cap on any count. It reads memory instead. D7
amends when [ADR-0062](0062-an-agents-question-is-asked-on-its-run.md)'s Output budget
runs, and
[ADR-draft-an-agent-is-told-when-its-verify-ends](draft-an-agent-is-told-when-its-verify-ends.md)
D4.

On 2026-10-20 vm-mk (16 cores, 62 GB, no swap) ran out of memory and was hard-reset at 07:57
(investigation run-a9f479ca). At 07:45 it had 2 GB available, `/proc/pressure/memory` read
`full avg10=90.75`, and load was 195. Three loads had stacked up:

- **A local stack.** On 2026-10-19 a finished Run's builder brought up a happytiger stack,
  about 110 pods, in a minikube with no memory limit. Nobody took it down.
- **Idle agents** of finished Runs
  ([ADR-draft-a-finished-runs-idle-agent-is-closed](draft-a-finished-runs-idle-agent-is-closed.md)).
- **New Runs.** From 06:55 to 07:36 the host started eight. Each launched agents and ran
  vitest, bun test and lint, all at once.

Nothing in Collie read memory before starting any of it. The kernel killed processes inside
minikube on memory, and the host's calls took 10 to 17 seconds before the Machine stopped
answering.

A cap on how many Runs, agents or checks run at once would not have seen any of this. The
stack and the idle agents were outside every count. A count low enough for that morning
would also queue Runs on an idle Machine. Memory is what ran out, and memory is what Collie
can read.

## Decision

**D1. A Machine is short of memory** while either of these holds:

- Its available memory is under `memory_hold` percent of its total. `memory_hold` is a
  setting, 10 by default, where 0 means never.
- On Linux, its memory pressure, `full avg10` in `/proc/pressure/memory`, is 10 or more.
  This rule is off too when `memory_hold` is 0.

How each Machine is read:

- Linux reads `MemAvailable` and `MemTotal` from `/proc/meminfo`. A kernel without pressure
  information is read by memory alone.
- macOS reads `kern.memorystatus_level`, the percentage of memory the system counts as
  available.
- Each host reads its own Machine.

**D2. Three starts wait.** Each is a point where Collie adds memory:

- an agent's launch, whether a Run's agent, a Fallback's successor or an agent started
  again;
- a **Check pass** the gate runs;
- a `collie verify` command, from any door.

While the Machine is short of memory, each one waits before it starts. It reads again every
15 seconds and starts once the Machine is no longer short. Nothing is refused, and nothing
fails, because of the wait.

**D3. Nothing else waits, and nothing is stopped.** A running agent, Check or command is
never stopped or killed for memory. These never wait:

- a Run's start, which costs a row (its first agent waits instead);
- a steer, an answer, a hold and a stop;
- the Home's chat and the Flock chat;
- Cleanup.

These are how a human frees memory, and a stop or a close is what frees it.

**D4. It binds every caller.** A human's `collie verify` and a Schedule's start wait just as
an agent's do. What the wait protects is the Machine that every Run and the human's own work
share, and a human's suite costs it as much as an agent's. There is no flag to start
anyway. A human who must run something now runs it outside Collie.

**D5. A wait is seen.**

- The card's sentence says the Run is waiting for memory, with the reading, for example
  `waiting for memory on vm-mk: 2.1 of 62 GB available`.
- The Run's log records what waited, and when each wait began and ended.
- `collie verify` says it is waiting before it runs the command.
- `collie doctor` warns while the Machine is short of memory. It gives the reading and says
  what `collie cleanup` would close.

Collie does not name what else holds the memory. A stack in a cluster is not Collie's to
see.

**D6. Each start is read fresh, and nothing is reserved.** Several starts that come
together, such as a review's seats, can all pass on one reading. The margin that
`memory_hold` leaves is what absorbs them.

**D7. A wait spends no agent's Output budget.** The wait has no bound, and the budget would
otherwise park a Run whose agent did nothing wrong.

- An agent's launch waits before its budget starts, because the budget runs only once the
  agent is launched and idle (ADR-0062).
- A `collie verify` an agent started in the background can wait after the agent has ended
  its turn on it, as ADR-draft-an-agent-is-told-when-its-verify-ends lets it. While that
  verify waits for memory, the agent's budget does not run, as while a question it asked
  is open. Once the command starts, the budget runs again: a running verify still does not
  pause it.

**D8. Disk is waited for the same way.** The same starts wait while a filesystem holding the
state directory or the Run's checkout is low by `collie doctor`'s `disk` reading: under a
tenth or under 5 GiB free, with no setting. A compaction Collie is about to ask a reused agent
for waits too, for disk alone, so a full disk cannot lose the record that it finished. This
amends D3 for that one point. The card reads `Short of disk on <machine>, waiting for
space: …`.

## Consequences

- Under memory pressure Runs slow down instead of the Machine going down. A wait shows on
  the board until one of these frees memory: a human, the idle close, or the pressure
  passing.
- A Machine kept short by something outside Collie holds Collie's new work until that is
  freed, for example a stack or another user's work. The card says so, and Collie cannot
  free it.
- CPU is not read. The suite already sizes its workers to the idle cores (#135), and CPU
  contention slows work without taking the Machine down.
- No work moves to another Machine. Placement is unchanged
  ([ADR-0033](0033-a-run-started-from-the-home-is-placed-not-asked.md)).
- Model usage is still recorded and never enforced
  ([ADR-0049](0049-work-goes-to-an-agent-with-usage-left.md)). Memory belongs to the
  Machine, not to a model.
- A wait for memory costs a step none of its agent's Output budget, however long the
  Machine stays short (D7). A Run is parked for want of an Output only for time its agent
  spent idle with nothing held for it.
