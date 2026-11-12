# Release repairs actionable forge blockers

**Status: proposed.**

## Context

A Release Run already has an agent cleared to repair and plain-push its source branch. Waiting for another actor to repair a confirmed target conflict strands work that agent can perform. The earlier release ADR's D5 required this wait before proof.

## Decision

### Confirmed target conflicts

Release opts into a typed conflict standing and gives it to the existing bounded fixer. The fixer merges the merge request's actual target into its source branch, preserves both branches' work, and plain-pushes the result. It does not assume the target is the default branch.

Before dispatch, Collie confirms source-branch ownership and refuses a detached checkout, another branch, uncommitted changes, or a source head that cannot be safely adopted. It never resets work or force-pushes.

An unchanged remote head or four unsuccessful conflict repairs parks the Run with the reason. Resume reads the forge again. Completed repairs remain journaled.

Collie reads the pushed head and proves its Checks before a release decision. A prior go does not authorize the repaired head. Normal approval, comment, claim, merge, tag, and deployment decisions remain in force. Hold and Stop remain effective.

This supersedes D5's requirement to wait for an external conflict repair without using a fix round, and the corresponding D3/D7 return-to-wait behavior for confirmed target conflicts. Other blocked reviews keep their existing behavior.

### Failed CI during Review wait

Release opts into a typed failed-CI standing naming the current head, failed check or pipeline, and its URL when available. A moved head is adopted and proved first; a confirmed target conflict takes the conflict repair path. Fresh review comments retain their established handling.

A terminal CI failure goes through the existing bounded proof/fix path even when local Checks pass. The finding comes from structured forge state. Approval alone, running or unknown CI, and other blocked reasons remain waits under their existing rules.

Failed-CI repair is limited to four rounds across proof and review reentry until recovery. A local success or claimed repair cannot clear a remote failure or restart that allowance. No remote progress parks early; continued failure after the bound parks with the head and failing pipeline. Resume reads the forge again without repeating completed repairs.

Collie independently reads and proves the pushed head, including Checks left to CI. A release decision requires the normal readiness conditions at that head. Existing go revalidation, claim cleanup, stage rollback, merge, tag, Hold, and Stop behavior remains in force.

This supersedes waiting for an external repair of failed source-branch CI during Review wait. It does not change approval policy, generic blocked-review handling, or recovery after merge. Workflow authors retain ordinary polling unless they opt into the failed-CI standing.

## Consequences

Repairable conflicts progress within the same Run. Unsuccessful repairs consume bounded agent work and then explain what remains blocked. Workflow authors retain the existing wait mode unless they opt into actionable conflict standings.
