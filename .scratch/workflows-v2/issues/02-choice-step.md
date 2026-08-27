# 02: Choice step

**What to build:** A step with `choices:` renders a menu in the runner pane using the picker TUI. A choice with `prompt:` sends text to a named agent and re-offers the menu once that agent's next Output exists; the selection is recorded in the run and the step is done only when a choice without re-offer is taken.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] choices validated: each has title and exactly one of run/prompt
- [ ] prompt choice → agent prompted → menu shown again (fake herdr test)
- [ ] selection recorded in run dir
