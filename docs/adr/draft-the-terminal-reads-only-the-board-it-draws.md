# The terminal reads only the board it draws

**Status: draft** (2026-11-12).

## What was true before

The native terminal draws the host's Task cards, as decided in
[ADR-0038](0038-the-host-builds-and-serves-the-board.md). Its reader nevertheless
rebuilt the older local and Herd-wide workspace lists on every refresh. That required
every Run's full record, the Task and agent registries, agent and workspace subprocesses,
sorting and projection, and journals for rows the native board did not draw.

[ADR-0063](0063-the-terminal-board-finishes-a-refresh-before-reading-again.md) removed
refresh cancellation and feedback loops. A fresh profile after installing that change
found a different scaling cost: this installation had 1,004 Runs but only 13 Task cards.
Warm application loads spent about 90–140 ms of client CPU before native rendering.
The larger population made the duplicate read path worth removing.

## Decision

The native application's state follows its displayed data. Task cards come from the
existing host subscription. Only opened History reads the full Run list. A selected
Run's live evidence uses the id and directory in its host-provided detail, including
when it is older than the former workspace lists. With no selected Run, the terminal
reads the Herd's pending proposals without reading invisible Run cards or marks.

The release notice is a separate header value. Application state no longer carries
the obsolete workspace boards or their marks. The text fallback continues to build
and render its own workspace view and steering evidence.

This removes reads and representations; it adds no data cache, delay, or polling
interval change. The existing focus reuse and recovery poll retain their behavior.
The host's shared protocol and desktop-specific code are unchanged.

Host publication also invalidates the terminal. Filesystem writes precede the host's
asynchronous Task build, so a fast read can finish before the new snapshot arrives.
The existing Task and selected-detail subscriptions notify a single-slot queue after
updating their latest values. The bridge merges those notifications into its bounded
background-read lane. A new frame cannot leave the board waiting for the recovery
poll, and a burst still requests only one read after the current read finishes.
Focus changes retain their immediate cancellation behavior.

## Validation

Behavioral regressions count the reader's external calls and verify fresh Task and
Usage reads, deferred and fresh History, and selected Run evidence alongside pending
Run and Herd proposals. They failed before the change. The existing older-Run
regression now supplies the selected host detail explicitly and verifies that Run's
own drift evidence. Native card, drawer, selection, stop/undo, bridge, and text-fallback
tests cover the consumers of the smaller application state.

Resource measurements use an isolated 1,004-Run, 13-Task host and bounded startup,
repeated refresh, idle, History, and drawer workloads. Both client and host CPU,
subprocess CPU, elapsed time, and sampled process-tree RSS are included. The fake
herdr is more expensive than the installed CLI, so its CPU is reported separately;
read-only probes against the existing live host check the client result with real
dependencies.

Across three isolated comparisons, median CPU per refresh fell from 61.4 to 11.3 ms
in the client and from 59.0 to 10.5 ms in the host. Median elapsed time fell from
177.2 to 10.5 ms. The fake client subprocesses added 282 ms per refresh before and
none after; those savings are not a prediction for the real CLI. Mean process-tree
RSS during the 12-second idle-board windows fell from 556 to 489 MiB.

Two alternating read-only comparisons against the unchanged live host, with 25 warm
refreshes per sample, reduced median client CPU from 96.9 to 22.0 ms and elapsed time
from 102.9 to 25.6 ms. Median client RSS was 185 versus 115 MiB. This excludes native
rendering and does not claim a live host CPU reduction from an uncontrolled workload.

## Consequences

Normal Task-board refresh cost no longer scales with the entire Run history in the
terminal. History still pays for that history when it is requested. The selected
Run's detail is also the authority for its journal directory, rather than a second
full Run lookup. Future native features must name the data they display instead of
reviving the old workspace-list dependency.
