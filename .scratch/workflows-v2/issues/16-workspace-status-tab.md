# 16: one `Control Plane` tab per workspace as the session's control surface, replacing per-run status strips

**What to build:** On the first run in a workspace the runner creates (or reuses) a tab labelled `Control Plane` holding one plugin pane: a small file-watching TUI over the run dirs and the live-agent registry for this workspace + repo. It shows: live agents by role with state and a key to focus their pane; active runs with current step and iteration; this session's finished runs with outcome; and quick actions — pick, resume, send last review to implementer, fork. Every Choice menu renders here instead of in a per-run strip; when a choice is waiting the runner toasts and focuses this tab so a menu is never left unseen. The per-run status strip is removed; run tabs contain only agent panes. The Control Plane tab is always the FIRST tab of the workspace: after creating or finding it, the runner moves it to position 1 (`tab move`) and re-asserts that on every run start, so `prefix+1` always lands on it. Deleting the tab is harmless: the next run recreates it in first position. The runner process per run keeps driving its run; the tab is a view, updated by watching files, with no engine state of its own.

**Scope:** the tab's context is exactly the workspace it lives in, within the current herdr session. It lists only runs started from that workspace and only agents registered there; other workspaces' runs and agents never appear, even for the same repo. Runs and the registry are keyed by (session name, workspace id) plus cwd, and because workspace ids compact when workspaces close, the key is re-validated against the live workspace (label + cwd) before anything is shown; entries whose workspace is gone are hidden, not deleted. The quick actions (pick, resume, send to implementer) operate on that workspace only.

**Keep it simple:** plain list rendering, no boxes-in-boxes; one screen, no scrolling for a normal session.

**Blocked by:** 14 (engine files)

**Status:** done

- [x] transcript: first run creates `workflows` tab + pane and moves it to position 1; second run reuses it and re-asserts position 1; strip no longer created
- [x] choice waiting ⇒ toast + tab focus (transcript); selection recorded as before
- [x] TUI renders agents/runs from fixture run dirs and registry (unit test on the render function)
- [x] README "Using it" + docs/WORKFLOWS-DESIGN.md updated; bun test + tsc green
- [x] live smoke: run review on this repo → `workflows` tab shows the run and its variants; menu appears there

## Decisions where the design was silent

**Where the runner's own pane goes.** Removing the strip leaves a question the ticket does
not answer: a Run still needs a terminal to render its menus in. Its pane moves into the
`workflows` tab (`pane move --tab … --target-pane <view> --split down --ratio 0.4`) and is
renamed after the Run. That is what makes "every Choice menu renders here" literally true —
the pane that draws menus is in that tab — and it is why the Run's own pane is the one thing
in the tab that carries a Run's name.

**`tab move` is socket-only.** herdr 0.8.2's CLI has no `tab move`; the socket API has
`tab.move {tab_id, insert_index}`. It joins `agent.view.*` as a method this plugin reaches
over the socket rather than the CLI. The tab is moved to index 0 unconditionally on every
Run start, because "already first" is not worth a second round trip to find out.

**Watching means polling.** The board re-reads the run dirs and asks herdr what is alive
every 1.5s and redraws only when the rendering actually changed; keys are polled every
120ms. A recursive `fs.watch` would be the literal reading of "file-watching", but it cannot
tell you an agent has died, so herdr has to be asked on a timer anyway — and one loop that
cannot miss an event is simpler than a watcher plus a timer.

**Registration ships here, hand-offs in 15.** The board cannot list live agents without a
register to read, so `registry.ts` and the engine's side of it are in this ticket: the head
of an `agent:` group — the step that later steps continue — is registered under its
Persona's name (`planner`, `implementer`) with its pane. Ticket 15 adds what reads it.

**"This session's finished runs"** is the finished Runs of this workspace and this repo cwd,
newest first, capped at five, so a normal session is one screen with no scrolling.

**Five new `run.json` fields**, so the board reads facts instead of guessing them:
`workspace` (a Session is workspace + cwd), `target_label` (what the tab calls the run —
`implement` inherits `target` from the review it embeds, so the board would otherwise
mislabel it), `awaiting` (the step the human is holding up), `synthesis` (where `review.md`
came from, which a hand-off needs) and `handoffs`.

**A `workflows` tab whose view pane was closed** gets a view split back into it rather than
a second tab: the tab is found by label, and only the pane is replaced.

**No workspace, no tab.** A Run with no `HERDR_WORKSPACE_ID` keeps its own pane and its own
tabs, exactly as before. Nothing about the board is load-bearing.

**Quick actions are the plugin's own actions.** `p`, `u` and `f` run `plugin action invoke`
on `pick`, `resume` and `fork`, so there is one implementation of each and the board cannot
drift from the keybindings. `s` is the review hand-off, `1`–`9` focus an agent, `q` closes
the tab.
