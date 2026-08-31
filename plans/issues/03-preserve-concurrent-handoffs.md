# 03: Preserve Hand-offs across concurrent Run saves

**What to build:** Make the receiving side of a Hand-off durable while its Driver
continues saving Run state. Both Runs must retain one correlated record of the
exchange without replacing unrelated state or duplicating a retried Hand-off.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Each Hand-off has a stable identity shared by the sending and receiving
      records and suitable for deduplication.
- [ ] Recording a received Hand-off uses a merge-safe persistence operation rather
      than relying on one stale whole-Run snapshot.
- [ ] After a Hand-off is recorded, saving an independently loaded older Run
      representation preserves the received Hand-off exactly once.
- [ ] Retrying the same Hand-off does not create duplicate audit entries.
- [ ] Existing Step status, Output, choice, summary, and finding state is preserved
      when external Hand-offs are merged.
- [ ] Failure to update the receiver leaves the sender's record intact and does not
      corrupt either Run.
- [ ] Tests model an active receiving Driver with a stale in-memory Run, not merely
      two sequential loads.
- [ ] Existing review-to-implementer and plan-change Hand-off behaviour remains green.
- [ ] `bun test` passes with no skipped or removed tests.
- [ ] `bun x tsc --noEmit` exits successfully.

