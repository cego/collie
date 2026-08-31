# 01: Confine Workflow-generated paths to the Run

**What to build:** Make every filesystem name derived from a Workflow definition
safe before a Run begins, and enforce containment again when Run paths are
constructed. Valid baseline definitions and provider-qualified Model names must
continue to work unchanged from the user's perspective.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Unsafe Step identifiers, Output names, Persona-derived filename components,
      and variant-derived directory components are rejected with errors naming the
      Workflow, Step, and invalid field.
- [ ] Empty components, absolute paths, path separators, `.` and `..`, and values
      that normalize outside their intended parent cannot produce Run paths.
- [ ] Safe encoding is used where an otherwise valid provider-qualified Model name
      needs representation as one directory component.
- [ ] Run path construction independently refuses to return a path outside the Run,
      even when called with an unsafe value that bypassed definition validation.
- [ ] Existing baseline Workflows still resolve and validate without changes.
- [ ] Behavioural tests cover accepted names, traversal attempts, separators,
      absolute-looking names, and provider-qualified Models.
- [ ] `bun test` passes with no skipped or removed tests.
- [ ] `bun x tsc --noEmit` exits successfully.

