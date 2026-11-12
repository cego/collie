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

## Consequences

Repairable conflicts progress within the same Run. Unsuccessful repairs consume bounded agent work and then explain what remains blocked. Workflow authors retain the existing wait mode unless they opt into actionable conflict standings.
