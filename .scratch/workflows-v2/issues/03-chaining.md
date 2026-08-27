# 03: Chaining with run:

**What to build:** A choice with `run: <workflow>` and `inputs:` starts a child Run in the same workspace with the forwarded inputs; the parent run records the child id and finishes. Resume lists parent and child independently.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] child run created with forwarded inputs, parent marked done with child link (tested)
- [ ] validation fails fast when the chained workflow or its inputs are unknown
- [ ] live: plan → Implement now opens implement tabs
