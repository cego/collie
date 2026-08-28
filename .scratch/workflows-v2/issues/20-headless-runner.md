# 20: the runner is headless — one Control Plane pane per workspace, nothing else

**What to build:** A run no longer opens a runner pane. The run driver is spawned as a detached background process (from the picker or the Control Plane; it survives the picker closing) that writes its progress, step transitions and any error to the run dir (`progress.jsonl` + `runner.log`). The Control Plane renders progress from those files (current step, iteration, per-variant state) and is the ONLY plugin pane in a workspace; Choice menus already render there. Agent panes are the only other panes a run creates. The first step therefore splits from nothing: the run's first tab is created directly with its agent pane(s). Failures that previously printed in the runner pane surface as a ⚠ line on the run in the Control Plane plus a toast; `runner.log` holds the detail and the Control Plane offers `l` to open it in a temporary pane. `resume` finds detached runners via a pid file and never starts a second driver for a run that is still alive.

**Blocked by:** 16 fix (Control Plane rendering), 19

**Status:** ready-for-agent

- [ ] transcript for review: no runner pane; tab count = 1 run tab with variant panes; Control Plane shows step/iteration from progress.jsonl
- [ ] driver survives the spawning pane closing (test with a fake herdr: kill the parent, run completes)
- [ ] failure path: ⚠ on the run row + toast; `l` opens runner.log (transcript)
- [ ] resume refuses to double-start a live run (pid file) (tested)
- [ ] README/design doc: Control Plane is the single plugin pane; bun test + tsc green
- [ ] live smoke: review on this repo → exactly one Control Plane pane in the workspace, progress visible there
