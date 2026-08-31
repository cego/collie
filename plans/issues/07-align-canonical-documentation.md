# 07: Align canonical documentation with shipped behaviour

**What to build:** Reconcile the domain glossary and Harness reference with the
accepted Run-local planning decision and the adapters actually shipped. This is a
documentation correction only; runtime behaviour must not change.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The Input glossary no longer names repository `tasks/` as a current inference source.
- [ ] The plan Workflow is described as writing its specification and tickets into
      its Run's plan directory, consistent with the accepted ADR.
- [ ] The baseline Workflow summary includes architecture alongside plan, implement,
      and review.
- [ ] The Harness reference includes Pi's Model flag, Persona injection mechanism,
      and complete supported effort vocabulary.
- [ ] Existing terminology consistently uses Workflow, Step, Run, Driver, Session,
      Hand-off, Harness, Model, Input, Output, and Control Plane as defined by the glossary.
- [ ] Superseded historical documentation remains clearly marked as historical rather
      than being rewritten as current design.
- [ ] No runtime source or generated binary is modified.
- [ ] `bun test` passes to prove the documentation-only change did not disturb
      baseline definition fixtures.

