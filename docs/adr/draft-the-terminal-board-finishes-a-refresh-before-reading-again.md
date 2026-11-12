# The terminal board finishes a refresh before reading again

**Status: proposed** (2026-11-12).

## What was true before

The terminal board treated every filesystem notification as a new focus. Each write
cancelled the current application read and started it again. On an isolated host with
120 completed Runs, 100 host-log writes spaced 20 ms apart caused 101–104 reloads;
none finished during the writes. Two measurements used 3.52 and 3.72 CPU-seconds across
the host and client in a 2.07-second window.

## Decision

User focus and background invalidation have different ownership. A new focus still
interrupts the previous read immediately. A background change lets that read finish
and leaves one pending refresh, which reads the current state. More changes while a
read runs replace that pending signal rather than start more reads. No state is cached
by this mechanism. The existing recovery poll keeps its interval.

The recursive watcher lives for the bridge's scope, including the gaps between focus
subscriptions. Closing the bridge closes the watcher and its refresh fibers.

## Evidence

The scheduling change alone reduced the same burst to 17 reloads and 1.53 CPU-seconds;
16 of those reads finished during the burst. The regression test holds a read open,
delivers 20 writes, and proves that read finishes with one following read. Existing
tests still prove that selection interrupts stale work and stop/undo stays responsive.

## Consequences

A background change may wait for the current read to finish, followed immediately by
a fresh read. Under continuous writes the board makes progress, with bounded pending
work. Keyboard focus continues to supersede work instead of waiting behind it.

Host diagnostics (`host.log`, `host.out`, and their rotations) are excluded before they
can invalidate the terminal board. The host and terminal board use the same predicate.
Run output, questions, check output, database changes, and drawer files retain their
existing notifications. This removes a false dependency on diagnostics rather than
delaying real changes. Filtering as well as scheduling reduced the initial burst
measurement to 0.60 CPU-seconds and two completed refreshes. Follow-up measurements
also account for the fake external services' subprocess CPU and sampled peak RSS.
