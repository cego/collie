# A rally ends in a person's Choice, never a Heal

**Status: proposed.** Amends ADR-0023 (how a rally ends) and
ADR-draft-a-fixable-failure-parks-its-step D1 (a ticket's unresolved blocking findings
and a halted final rally no longer park).

## Context

A halted rally parked `step-failed`, and every such park started a Heal. A Heal cannot
decide whether a disputed finding is right: it repeated the rally or gave up (#426,
#428, #479). A fix the reviewer rejected was never told to the fixer (#478).

## Decision

**D1.** A rally hands a rejected fix or a repeated blocker back to its fixer once
before it judges no progress.
**D2.** A blocker the fixer disputed and the reviewers kept is a Choice: Waive it
(recommended), Send it back, Stop. A waiver keeps the finding `disputed` with a note
naming the actor, and the merge request lists it as waived and unverified. A waiver is
not proof: the outcome gate is not told about it.
**D3.** A rally that still halts with no progress, or with a fix it cannot verify, asks
a Choice instead of parking. No ParkCause is added for a dispute.

## Consequences

A rally never starts a Heal. A waived finding that stands for an acceptance criterion
the Run cannot prove still stops the Run at the gate. A person who decides to ship
without that criterion drops it from the Intent. Milestone 4's Finding status (#354) may later record a
waiver as a `dismissed` row.
