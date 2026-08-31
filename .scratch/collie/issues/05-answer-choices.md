# 05: Answer Choices programmatically

**What to build:** Allow a human or agent to inspect a waiting Run and answer its current Choice from the CLI, with the same effects as answering through the Control Plane and without duplicating effects on retry.

**Blocked by:** 03: Start and inspect workspace-scoped Runs

**Status:** ready-for-agent

- [ ] A Driver records `waiting` when a Run reaches a Choice and exposes its valid answers through `run show`.
- [ ] `collie run answer <run> <answer>` accepts only an answer declared by the current Choice and only for a matching selected workspace.
- [ ] The CLI atomically writes a Schema-validated command to the Run inbox; only the owning Driver advances authoritative Run state.
- [ ] Choice effects—chaining a Workflow, prompting an agent, posting a review, or ending the Step—match the interactive behavior.
- [ ] Reusing an answer request ID returns the original result without applying the Choice twice.
- [ ] Missing, stale, duplicate, and invalid answers return readable messages and stable JSON errors.
- [ ] Tests cover every Choice effect, cross-workspace rejection, invalid Run state, and retry safety at the public command boundary.
- [ ] `bun test` and `bun run typecheck` pass.
