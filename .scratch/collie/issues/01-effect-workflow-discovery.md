# 01: Run workspace-scoped Workflow discovery through Effect

**What to build:** Establish Collie's Effect v4/Bun program through one complete CLI slice: a human or agent can select a Herdr workspace, list available Workflows, and inspect a Workflow and its Input schema. This slice establishes the shared service, Schema, Layer, error, and rendering conventions that later commands extend.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `collie workflow list` and `collie workflow show <workflow>` run through the current Effect v4 unstable CLI on Bun.
- [x] `--workspace` overrides `HERDR_WORKSPACE_ID`, which overrides the workspace in `HERDR_PLUGIN_CONTEXT_JSON`; commands that need no workspace still work without one.
- [x] A selected live workspace supplies its ID, label, working directory, and worktree provenance without importing focused-pane, selected-text, or clicked-link state.
- [x] Default output is readable for humans; `--json` emits exactly one Schema-defined success or error envelope without diagnostics contaminating stdout.
- [x] Invalid input exits 2, operational failure exits 1, and success exits 0 with obvious stable error codes.
- [x] Tests exercise the CLI at its public boundary with fake Herdr and temporary definition Layers.
- [x] `bun test` and `bun run typecheck` pass.
