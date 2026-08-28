# 20: the runner is headless — one Control Plane pane per workspace, nothing else

**What to build:** A run no longer opens a runner pane. The run driver is spawned as a detached background process (from the picker or the Control Plane; it survives the picker closing) that writes its progress, step transitions and any error to the run dir (`progress.jsonl` + `runner.log`). The Control Plane renders progress from those files (current step, iteration, per-variant state) and is the ONLY plugin pane in a workspace; Choice menus already render there. Agent panes are the only other panes a run creates. The first step therefore splits from nothing: the run's first tab is created directly with its agent pane(s). Failures that previously printed in the runner pane surface as a ⚠ line on the run in the Control Plane plus a toast; `runner.log` holds the detail and the Control Plane offers `l` to open it in a temporary pane. `resume` finds detached runners via a pid file and never starts a second driver for a run that is still alive.

**Choices with a headless driver:** a Choice step writes `choice.json` (title, options, default) into the run dir and blocks polling for `choice-answer.json`. The Control Plane renders any pending choice inline under that run's row, toasts "<run> needs you" and focuses its tab; the selection is written to `choice-answer.json` and the driver continues. A pending choice survives the Control Plane pane being closed/reopened and a resume (it is re-rendered from the file). Embedded steps still never ask. Agent-level questions stay in the agent's pane: the run row shows ⚠ needs you with its 1-9 key.

**Blocked by:** 16 fix (Control Plane rendering), 19

**Status:** done

- [x] transcript for review: no runner pane; tab count = 1 run tab with variant panes; Control Plane shows step/iteration from progress.jsonl
- [x] driver survives the spawning pane closing (test with a fake herdr: kill the parent, run completes)
- [x] failure path: ⚠ on the run row + toast; `l` opens runner.log (transcript)
- [x] choice round-trip via choice.json / choice-answer.json with toast + focus (transcript); pending choice re-rendered after the Control Plane is reopened
- [x] resume refuses to double-start a live run (pid file) (tested)
- [x] README/design doc: Control Plane is the single plugin pane; bun test + tsc green
- [x] live smoke: review on this repo → exactly one Control Plane pane in the workspace, progress visible there

## Decisions where the design was silent

**`detached`, not `nohup`.** The first attempt wrapped the driver in `nohup` and the run
still lost its herdr: closing the picker pane sent SIGHUP to the whole process group, and
`nohup` protects only the process it wraps — the driver survived, but every `herdr` command
it spawned died with `exit 129`, so the run never got a Control Plane tab. The driver is now
started with `node:child_process` `spawn(..., { detached: true, stdio: "ignore" })`, which
puts it in a session of its own, out of the terminal's reach. Verified live both ways.

**The driver is a subcommand, not a pane.** `herdr-workflows drive` with
`HERDR_WORKFLOWS_RUN` set, and `HERDR_WORKFLOWS_DRIVER` overrides the command so tests can
run the driver from source. The `runner` pane entrypoint is gone from the manifest; `picker`
(a popup) and `workspace` (the Control Plane) are what is left, and only the second is
persistent.

**Two files, not one.** `progress.jsonl` is one JSON line per thing the driver said, which
is what the board reads; `runner.log` is the same lines as plain text plus the stack of
anything that went wrong, which is what `l` opens. The board shows the last progress line
on a run's row, because that is what the runner pane used to show.

**The board's keys belong to a pending question while there is one.** A question is
rendered indented under the run asking it, and `↑↓`/Enter/Esc — or typed characters, for an
`ask` — go to it rather than to the board. The key line says `answering <run>` so it is
obvious why `p` no longer runs a workflow. Only the first asking run is answered at a time.

**An answer carries the question's id**, so an answer written for an earlier question cannot
settle a later one, and both files are removed as soon as the driver has read the answer.

**An unanswered question is not a wedged run.** The wait is bounded by the same
`handoff_timeout_ms` as every other wait for a human; on timeout the step is left
unfinished, which is exactly what Esc already did, and the run stays resumable.

**`k` stops a run.** Not in the ticket, but closing a run's pane used to be how you stopped
one and there is no pane now — leaving no way at all would be a regression. `k` sends
SIGTERM to the newest run's driver and clears its pid file. Its agents are left where they
are: their panes are the transcript of what happened.

**Abandonment now asks the pid file first.** A run with a live driver is never abandoned,
however long it has been quiet; one with no driver, no live agent and a minute of silence
is.
