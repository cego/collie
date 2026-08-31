# 04: Follow Run progress and retrieve results

**What to build:** Give humans and agents a reliable way to wait for a Run, follow its progress, and retrieve its logs and Outputs from the CLI without polling the UI.

**Blocked by:** 03: Start and inspect workspace-scoped Runs

**Status:** ready-for-agent

- [ ] `collie run wait <run>` waits for `succeeded`, `failed`, or `stopped` and returns the terminal Run.
- [ ] `--follow` first reports current state and existing progress, then subsequent progress, and ends with exactly one terminal event.
- [ ] Human follow output is readable; `--json --follow` emits one typed JSON event per line without mixed diagnostics.
- [ ] `--timeout` bounds waiting, while Ctrl-C interrupts only the waiter and never stops the Run.
- [ ] `collie run logs` and `collie run output` expose the same recorded data available to the Control Plane.
- [ ] Effect `FileSystem.watch` is used as an invalidation stream; each event causes authoritative state to be reread and Schema-decoded.
- [ ] Tests synchronize with Effect primitives rather than sleeps and cover existing events, new events, terminal completion, timeout, and interruption.
- [ ] `bun test` and `bun run typecheck` pass.
