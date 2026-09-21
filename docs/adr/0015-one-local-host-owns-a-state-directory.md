# One local host owns a state directory

**Status: accepted, and proven rather than argued.** The proof is `test/host.test.ts`, the
mechanism is `src/host.ts`, and `collie host --dir <dir>` is the process it starts.
[ADR-0014](0014-native-workflows-run-on-effects-own-engine.md) decided that Effect's engine
runs native workflows and left "the host Collie ships" open; this is that host. Nothing
here is in the path of a Run yet — connecting the Run operations to it is later work.

Work outlives the thing that asked for it. The CLI exits when it has said what it came to
say, a board is closed with a keystroke, a chat turn ends — and a workflow takes hours. So
the engine cannot live in the client, and something has to decide which process it does
live in.

## Decision

**D1. One host per state directory, started by whoever needs it first.** There is no
service manager, no daemon to install and nothing to start before using Collie. A client
that finds no host starts one and connects to it; every client after that gets the same
one. The host is detached and its stdio is closed: it belongs to the directory, not to the
terminal that happened to need it.

**D2. The pid lock decides the owner, not the starter.** Simultaneous clients all start a
host, and the lock in `src/lock.ts` — the one the run persistence lock and the Driver
takeover use — settles which of those keeps running. The losers exit without touching
anything. A claim whose process is gone is broken and taken over; a claim whose pid now
belongs to an unrelated process is stale by its start time, so recovery never adopts or
signals somebody else's process. Nothing here ever sends a signal: liveness is `kill(pid,
0)` inside the lock, and a host is stopped by a human or by the machine going down.

**D3. Effect's RPC over a unix socket in that directory.** Both ends read the same schemas,
so a request is a value with a schema at each hop rather than a shape one side remembers.
`host.sock` is a file beside `native.db`, which means the same permissions as the state it
guards and nothing listening off this machine. The socket is removed and rebound by the
host that holds the lock, so a crashed host leaves nothing to clear by hand.

**D4. A client's connection is a scope under the host's.** Registrations and the registry
are built in the host's own scope; each connection is a scope of its own beneath it, and an
execution is started with `discard` so it belongs to the engine rather than to the request
that admitted it. Hanging up therefore cancels nothing: not the accepted work, not a
registration, not another client.

**D5. The host advertises its build, and a client that is not it stops.** `collie upgrade`
replaces the binary; it does not replace a host that is already running, and the two need
not agree. A mismatched client says which build is running, which one it is, and the pid to
stop — and sends nothing else. It does not kill the host, take the directory, or drain and
hand over: an upgrade that interrupts running work to install itself is worse than waiting.

**D6. Unavailability is a typed answer, not a hang.** A host that will not start is
`HostUnavailable` with what can be seen from here — nothing owns the directory, or a pid
owns it and is not answering — after a bounded wait.

## What this does not decide

Which state directory a client uses, and what a Run does with a host: the production Run
operations reach this host in later work, and with them the request id a start is claimed
under and the recovery of a row admitted while nobody was listening for the answer. A run
is recorded before it is executed, which is what makes that recovery possible; doing it is
not this. `collie native` stays as the fixture host the recovery proof drives, and the
operator controls it measured — hold, release, stop, resume — are not on this protocol yet.

## Consequences

- A host is a process nobody started on purpose, so it has to be findable: the lock names
  its pid, and `identity` says what it is. Stopping one is `kill`, and the next client
  starts another.
- Two connections are opened per client: one to ask who the host is, one to keep. The first
  is what makes "started for me" and "already running" the same code path.
- `bun test test/host.test.ts` carries real subprocesses and one deliberate ten-second
  wait, for the host that never starts.
