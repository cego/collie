# 06: Stop and resume Runs safely

**What to build:** Let humans and agents stop active work deliberately and resume unfinished work later without racing Drivers, closing unrelated panes, or repeating completed Steps.

**Blocked by:** 05: Answer Choices programmatically

**Status:** ready-for-agent

- [ ] `collie run stop <run>` stops orchestration, closes only panes owned by that Run, preserves repository changes, and records `stopped`.
- [ ] `collie run resume <run>` accepts failed, stopped, or orphaned Runs, skips completed Steps, and starts unfinished Steps with fresh agents.
- [ ] Resuming an actively owned Run returns `run_already_active` and never starts a second Driver.
- [ ] Ownership is acquired atomically and verified against process identity before takeover or signalling.
- [ ] Stop and resume use the Run inbox and are safe when repeated with the same request ID.
- [ ] The five Run states—running, waiting, succeeded, failed, and stopped—have tested legal transitions and terminal behavior.
- [ ] Tests prove unrelated processes and panes are untouched, completed Steps are not repeated, and stale ownership is recovered safely.
- [ ] `bun test` and `bun run typecheck` pass.
