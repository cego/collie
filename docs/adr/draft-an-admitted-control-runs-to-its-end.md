# An admitted control runs to its end

**Status: accepted.** Extends [ADR-0021](0021-one-host-answers-for-a-run.md) D4 (the same
claim twice is the same answer) from a finished control to one still running.

On 2026-10-29, every resume asked from Desktop failed (#262). The host's resume took 45-48 s.
Desktop gives an attempt 30 s, then sends the same request again. Each cut attempt
interrupted the host's handler, and the resume died with it, before its operation was
recorded. The Runs stayed parked until an agent resumed them from the CLI, which waits
longer.

## Decision

**D1. A control the host has taken runs in the host, not in the call.** A stop, hold or
resume taken under a request id runs in the host's own scope. The caller only waits for it.
A caller that times out, is interrupted or loses its connection stops waiting, and the work
goes on to its end and is recorded. The work still ends with the host.

**D2. A repeat while it runs is the same control.** A control is recorded only when it ends,
so a repeat under its request id while it runs would otherwise find nothing and start it
again. The host keeps each running control by its Run and request, and a repeat waits for
that one and gets its result. Once it ends, a repeat reads the record, as before.

## Consequences

A client's retry is safe at any moment, so a front door may give up waiting early and ask
again. A slow control is still slow. How long a resume takes is decided by what it
recovers, not by this.
