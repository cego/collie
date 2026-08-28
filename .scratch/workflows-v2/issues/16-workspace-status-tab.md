# 16: one `workflows` tab per workspace as the session's control surface, replacing per-run status strips

**What to build:** On the first run in a workspace the runner creates (or reuses) a tab labelled `workflows` holding one plugin pane: a small file-watching TUI over the run dirs and the live-agent registry for this workspace + repo. It shows: live agents by role with state and a key to focus their pane; active runs with current step and iteration; this session's finished runs with outcome; and quick actions — pick, resume, send last review to implementer, fork. Every Choice menu renders here instead of in a per-run strip; when a choice is waiting the runner toasts and focuses this tab so a menu is never left unseen. The per-run status strip is removed; run tabs contain only agent panes. Deleting the tab is harmless: the next run recreates it. The runner process per run keeps driving its run; the tab is a view, updated by watching files, with no engine state of its own.

**Keep it simple:** plain list rendering, no boxes-in-boxes; one screen, no scrolling for a normal session.

**Blocked by:** 14 (engine files)

**Status:** ready-for-agent

- [ ] transcript: first run creates `workflows` tab + pane, second run reuses it; strip no longer created
- [ ] choice waiting ⇒ toast + tab focus (transcript); selection recorded as before
- [ ] TUI renders agents/runs from fixture run dirs and registry (unit test on the render function)
- [ ] README "Using it" + docs/WORKFLOWS-DESIGN.md updated; bun test + tsc green
- [ ] live smoke: run review on this repo → `workflows` tab shows the run and its variants; menu appears there
