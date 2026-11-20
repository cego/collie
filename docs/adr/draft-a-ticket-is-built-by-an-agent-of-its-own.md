# A ticket is built by an agent of its own

**Status: proposed.** The default stays `run` until the matched trial of `agent_sessions`
decides it. Amends [ADR-0024](0024-a-list-of-work-is-known-by-its-names.md) D5,
[ADR-0007](0007-compact-a-reused-agent-at-a-work-boundary.md) and
[ADR-0049](0049-work-goes-to-an-agent-with-usage-left.md) D8.

## What was true before

An implement Run built every ticket, every review-fix round and the merge request on one
agent, `build` (ADR-0024 D5). Its context grew with each ticket, and compaction between
pieces of work (ADR-0007) only trimmed it. A quota Fallback was the one place another agent
took the work over, given three lines of hand-over.

## Decision

**D1. A Run's work and its agents are separate, and `agent_sessions` says which agent runs
what.** The Run keeps its checkout, branch, journal, findings, plan and Outputs; agents
are replaceable, and each name is derived from the Run and the work, never from a position.

- `run`, the default, keeps one builder, `build`, for everything.
- `ticket` builds the first ticket (and any planning before it) on `build`, and each later
  ticket's build, criteria hand-backs and review-fix rounds on `build-<ticket>`. The final
  review's fix rounds, the last fix, the gate fix, the merge request and the CI fix run on
  `deliver`. Work that never left `build`, such as one ticket, keeps it to the end.
- `round` is `ticket`, plus a fresh fixer for each review-fix round: `fix-<ticket>-<n>`, and
  `fix-final-<n>` for the final review's. `deliver` takes the gate fix onward.

**D2. A boundary ends the outgoing agent and finds it Quiet before the next one starts.**
The outgoing agent is ended through the end path a Fallback uses. A predecessor that is not
Quiet parks the Run on `predecessor-not-quiet`, which its recheck clears and no Heal takes,
and nothing starts until it is. One writer works in the checkout at a time.

**D3. The default is measured, not assumed.** `ticket` and `round` exist so the trial can
compare them against `run` on the same plans. Until it does, `run` is the default and this
ADR stays proposed.

**D4. The hand-over is one revisioned record the host builds** (ADR-0049's amendment of
2026-11-20, **Hand-over** in `CONTEXT.md`). It goes out in the new agent's first delivery,
once per new agent, at every boundary and every Fallback. One whose head or plan revision
no longer matches the checkout is rebuilt once, then parks on `hand-over-stale`.

**D5. Nothing new starts where nothing changed.** A wait, a duplicate delivery, a restart,
a crash replay, an Output reminder or repair, and an answer to a pending question go to the
agent that owns the work. A replay resumes the same step on the same agent name, and a
boundary already crossed is not crossed again.

**D6. The value is fixed on the Run when it starts.** It is recorded with the Run's other
features, so a changed setting never splits a Run, and a Run with no record keeps one
agent. The board shows each builder as a tab of its own; the ended ones stay listed, the
live one is marked, and Go to pane opens it.

## Consequences

Each ticket starts with an empty context and the hand-over instead of the transcripts of
the tickets before it. The price is a launch and a Quiet check per boundary, and what the
outgoing agent knew but did not write down. The build prompt therefore asks for its
decisions, rejected approaches and next action under `ticket` and `round`.
