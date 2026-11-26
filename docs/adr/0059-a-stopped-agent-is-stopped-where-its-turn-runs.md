# A stopped agent is stopped where its turn runs

**Status: accepted, to be built.** Amends [ADR-0007](0007-compact-a-reused-agent-at-a-work-boundary.md)'s
Codex row (the release it is verified at, and what becomes of the App Server it starts) and
[ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md) D6's "a compactor
endpoint stops once herdr no longer lists its agent". Applies
[ADR-0021](0021-one-host-answers-for-a-run.md)'s rule that a control says what it reached,
rather than confirming what it could not, to a stop.

A Codex agent's work does not run in its pane. Collie starts one `codex app-server` per
agent, detached, and the TUI in the pane is a `--remote` client of it. Closing the pane
closes a client. The turn goes on in the server.

## What happened

On 2026-10-13 `vm-mk:run-9e6e269c.implement` had two writers in one checkout for twenty
minutes, and every record said it had one. Read from its `agents.log`, its operations
journal, the Codex rollouts and the processes themselves:

- 09:58Z: `run-9e6e269c-implement-build-r1` started as Codex in `wE9:p4`, with its App
  Server on `127.0.0.1:35843`, a child of the host.
- 11:09:29Z: turn `01a134f4-044f-7053-93f6-1db57d18653a` started on thread
  `01a134f2-e3e2-7242-9620-c2121348e1b8`, building ticket 02.
- 11:10:41Z and 11:14:09Z: the Run was stopped. The stop closed `wE9:p4` and wrote
  `stopped run-9e6e269c-implement-build-r1`. Nothing reached the server.
- 11:14:11Z: the stop was lifted and the Run went on. Herdr no longer listed r1, so the gone-agent restart
  (#102) started r1 again, as Claude, in `wE9:p5`, in the same checkout. Installing its
  controls sent the old server SIGTERM and deleted its control record and its log.
- A 0.162.0 App Server on a websocket takes a first SIGTERM as a drain. It closes
  admission, and it waits for the running turn (upstream `rust-v0.162.0`:
  `websocket_transport_sigterm_waits_for_running_turn_before_exit`). So the turn went on.
  It failed to apply patches over Claude's edits at 11:17Z and 11:19Z. It spawned sub-agent
  threads `01a13504-4237-…` and `01a13504-75c6-…` at 11:27Z.
- 11:34:29Z: the turn was interrupted by hand (`turn_aborted`, `interrupted`). By
  11:37:45Z the server and its `codex-code-mode-host` were gone. The drain ended once
  nothing was running.

#102 and #108 are not this. #102 made Codex readiness, thread binding and the gone-agent
restart work. #108 gave Desktop's host its shell environment. Neither stops a turn. #102's
restart is what started the replacement; it is gated below, not redone.

## Decision

**D1. A stop ends the work, not the pane.** Codex is the harness whose work Collie runs
outside its pane. Its incarnation is stopped through the App Server Collie started for
it. Every way Collie ends an incarnation goes through the same stop:

- a Run's stop, and the stop that reaches its children;
- a Fallback mid-work;
- a gone agent started again;
- a new start under a name whose record still names a server;
- the Cleanup sweep.

The pane is closed after the stop is verified, never instead of it. Where it cannot be
verified, the pane is left open, so the human still has the agent in front of them.

**D2. The stop, in order, on one connection opened before the signal.**

1. Prove the server is this agent's (D4).
2. List its loaded threads and their in-progress turns.
3. Send the server one SIGTERM. Admission closes, and no queued or goal continuation
   starts.
4. Send `turn/interrupt` for every in-progress turn on every loaded thread, a sub-agent's
   included. Upstream tests show an interrupt is accepted during the drain.
5. Wait, for a bounded time, for the server to exit.
6. Look at the processes of its session. Any left that are proven its own get one
   SIGTERM, and are looked at again.

Nothing gets a second SIGTERM or a SIGKILL. A forced end of a turn mid-write is not a
stop Collie can vouch for.

**D3. Three facts, three words.** `submitted`: the interrupt was written. `acknowledged`:
the server answered it, which accepts cancellation and promises nothing. `quiet`: every
turn read back has ended, the server's process is gone, and nothing of its session is
still running. Only `quiet` is stopped. The agent's log line, the stop's receipt and the
agent's record say which one it reached. They give the full thread and turn ids, the
endpoint, the pid and where the transcript is.

**D4. Fail closed, visibly.** A stop is not `quiet` when any of these happens:

- the server does not answer;
- the connection is lost mid-stop;
- the pid, its start time or its command does not match the record;
- the endpoint holds a thread of another directory;
- a turn has not ended within the budget.

When that happens:

- the record keeps the endpoint, the pid, its start time and the state reached;
- the stop names the agent in `left`, which every door reports as a failed operation with
  the reason;
- the pane stays open.

Collie never signals a process it cannot prove is this agent's server or of its session.
An App Server Collie did not start, such as the human's own daemon, is never Collie's to
stop.

**D5. No replacement before quiet.** A new incarnation that takes over an agent's work is
not started until the one before it is `quiet`. That is the same name started again, or a
Fallback's successor. Until then the work parks with the thread, the turn and the server
named, and a resume tries the stop again. A checkout whose agent record still names a
server is in use, both for a takeover and for **Settled**.

**D6. The record outlives the signal.** A control record is removed only once its server
is `quiet`. The Cleanup sweep runs the stop for every agent herdr no longer lists. So a
host restart, a pane closed by hand and an earlier stop that failed are all taken up again
at the next sweep. A record an older build wrote has no start time. It is proven by its
command, and by its endpoint answering with this agent's directory.

**D7. No archive.** `thread/archive` moves the rollouts of the thread and its descendants
to `archived_sessions` and shuts down loaded descendants. Upstream does not test it on a
running turn. Once the server has exited, nothing is loaded for it to shut down. The
transcript stays where Codex wrote it, and the receipt says where that is.

**D8. Codex is verified at 0.162.0.** It is the first release whose drain is tested to
take `turn/interrupt` and to start no automatic turn. An older Codex is started without
Collie's controls, as it is when compaction is off.

**D9. Hold is not stop.** A hold starts no new work at the Run's next boundary and never
touches a running turn. Stop is the control that ends running work.

**D10. The gate is unchanged.** Evidence is bound to the tree at both ends of a check, so
a second writer can make a check's result unstable but never a false pass. Under D5, a
replacement's evidence is never collected beside a predecessor that might still write.

## Consequences

- A stop of a Codex agent can now fail and say so, where it used to report success over
  a running turn. It takes a few seconds longer.
- A Fallback or a restart onto a Codex agent that will not go quiet parks rather than
  putting a second writer in the checkout.
- Collie cannot find a server whose record an older build already deleted. The release's
  operator check looks for one by hand.
- Claude, Pi and OpenCode run their work in the pane. A harness that later moves its work
  out of its pane gets a stop under D1–D4 in the same change.

**Amended: an in-pane harness is found Quiet too.** Closing a Claude, Pi or OpenCode pane
is no longer taken as its stop. An agent's start records the process at its terminal's
root: core's terminal pid, with its start time. Before the close, the end notes that root's
session (D2 step 6's listing) and, where core names a different root now, that one's too; a root whose pid is now another process names nothing.
After the close, every noted process and every process still in those sessions gets a short
grace, then one SIGTERM, and the stop's wait. None left is Quiet. One left makes the end
`NotQuiet`; a Fallback then parks with the cause `predecessor-not-quiet`, which records what
was left and rechecks it, with the agent's control record's `keptFor`, and never heals.
Where no root can be named, the end says Quiet was not confirmed and the close stands as
the stop, as before.
