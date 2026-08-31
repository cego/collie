# 05: Accelerate the full behavioural test suite

**What to build:** Reduce full-suite runtime from the approximately 124-second
baseline to at most 60 seconds while preserving all existing and newly added
behavioural coverage. Remove avoidable fake-process and polling overhead rather
than weakening production timing or deleting integration assertions.

**Blocked by:** 01 Confine Workflow-generated paths to the Run; 02 Give each Run
one verified Driver owner; 03 Preserve Hand-offs across concurrent Run saves; 04
Make local process paths shell-safe.

**Status:** ready-for-agent

- [ ] Capture a before measurement using the full test command on the same machine
      and record the elapsed time and test count in the change description.
- [ ] Identify the dominant cost using per-test timing evidence rather than assuming
      that the largest test modules are the slowest.
- [ ] Remove avoidable subprocess startup, fixed sleeps, or production-sized polling
      from the fake Herdr boundary while retaining end-to-end Workflow assertions.
- [ ] Production polling and timeout defaults are unchanged unless independent
      runtime evidence justifies a product change.
- [ ] No existing test is deleted, skipped, weakened to a trivial assertion, or moved
      below the behavioural seam solely to meet the timing target.
- [ ] All safety and coordination tests introduced by tickets 01–04 remain enabled.
- [ ] The final `bun test` run reports zero failures and completes in at most 60
      seconds on the baseline machine; 30 seconds is a stretch target, not a gate.
- [ ] `bun x tsc --noEmit` exits successfully.

