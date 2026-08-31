# 02: Give each Run one verified Driver owner

**What to build:** Replace the Run's check-then-write PID convention with an
atomic ownership contract. Exactly one Driver may execute a Run, stale ownership
must be recoverable, and the Control Plane must never signal a process whose
identity does not match the owning Driver.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Driver ownership is acquired atomically; two concurrent attempts yield one
      owner and one clean refusal before any Workflow Step executes.
- [ ] The ownership record contains enough process identity to distinguish the
      original Driver from an unrelated process that later has the same PID.
- [ ] A missing, dead, stale, malformed, or identity-mismatched owner is never
      reported as a live Driver.
- [ ] Stop signals are sent only after ownership identity is verified; a live
      unrelated process remains alive when presented through a stale record.
- [ ] A Driver releases only the ownership claim it acquired, including on normal
      completion and handled failure.
- [ ] A losing or superseded process cannot remove another Driver's ownership.
- [ ] A Run whose Driver died without cleanup can be resumed safely.
- [ ] Headless behavioural tests exercise concurrent acquisition, safe stopping,
      stale recovery, normal cleanup, and failed cleanup ownership.
- [ ] `bun test` passes with no skipped or removed tests.
- [ ] `bun x tsc --noEmit` exits successfully.

