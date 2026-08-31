# 04: Make local process paths shell-safe

**What to build:** Ensure Driver launch and Control Plane log opening work when
plugin, project, state, and log directories contain spaces or shell
metacharacters. Structured process APIs should receive structured arguments, and
paths intentionally sent to an interactive shell should use the repository's
existing quoting convention.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The default compiled Driver path is launched as one executable path without
      whitespace splitting.
- [ ] Development and test Driver overrides have an explicit executable-and-arguments
      contract that does not attempt general shell parsing.
- [ ] Opening a Run log quotes the complete path before sending the command to the pane.
- [ ] Existing ordinary-path behaviour and detached Driver lifetime remain unchanged.
- [ ] Headless tests run Driver startup and log opening from temporary locations
      containing spaces and shell metacharacters.
- [ ] Tests prove shell metacharacters remain path data and do not execute an
      additional command.
- [ ] `bun test` passes with no skipped or removed tests.
- [ ] `bun x tsc --noEmit` exits successfully.

