# A finished delivery names the way back to work

**Status: draft.** Decided by the human in run-e15f4a62 on November 11, 2026:
keep steering plus explicit recovery. This clarifies
[ADR-0041](0041-a-finished-run-still-takes-steering.md) and amends the terminal-delivery
requirement in [#338](https://github.com/cego/collie/issues/338).

## Context

Four failed implement Runs accepted deliveries after their workflow ended. Their agents
finished work on the branches, but Checks and Merge request never ran. The sender saw
`acknowledged` and waited for steps that could no longer advance.

Refusing every terminal delivery would remove the live-agent steering ADR-0041 preserves.
Re-entering the finished workflow would replay its journaled failure. Automatically
starting a successor would turn a message to an agent into a new workflow execution.

## Decision

**D1. Keep terminal steering and state its limit at delivery.** The sender's result and
the agent's delivered message name the terminal status and say that no Step consumes
the turn's Output. A receipt records delivery, never workflow progress. The human
explicitly chose this alternative to #338's original refuse-or-ingest requirement.

**D2. Show branch movement without rewriting execution history.** Compare the current
pushed branch head with the head recorded when the Run finished. Show forward commits
and the current head on the card and coordinator reads. A divergent history, missing
branch, or unavailable comparison is named rather than treated as forward progress.
This is a Git fact, not an Intent drift judgement on a finished Run.

**D3. Recovery is an explicit follow-up over the existing work.** A follow-up enters at
Checks only where review evidence settles its requirements at the current pushed head,
with no blocking findings. A green pipeline alone cannot establish that. Where the branch
carries the implementation without a qualifying review, start at review and use the
ordinary bounded fix-and-review rally. Where no implementation is established, retain
Build. Re-read the facts when invoking the offer. Missing associations in older records
never justify skipping review, and Checks still require evidence at the current revision.

**D4. The finished engine stays finished.** Nothing consumes a new Output into its old
Activities, rewrites its terminal status, or starts a successor merely because an agent
was sent a message. The follow-up keeps the Task and branch and reuses its existing merge
request. The existing offer admission owns duplicate-successor prevention.

## Consequences

Delivery can be useful without advancing the old workflow, and its sender can now tell
which happened. Recovering a reviewed head avoids redundant Build and review turns while
keeping the current revision's gate. Older records that lack trustworthy review
associations can require a new review; they cannot silently inherit proof.
