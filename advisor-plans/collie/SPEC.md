# Spec — Collie

Status: accepted  
Written against: `9c8aa13`

## Problem

The current Herdr plugin exposes workflow operations primarily through picker panes and the
Control Plane. An agent cannot reliably discover, start, observe, answer, stop, resume, or
fork workflow state without driving the UI. The implementation also has separate imperative
paths that would make a second CLI duplicate behavior.

Collie must let a same-user local process do everything a human can do through the plugin,
while preserving the interactive Herdr experience.

## Product and cutover

- The product, repository, package, executable, release assets, UI labels, and documentation
  are named **Collie** / `collie`.
- Rename the GitLab project from `mk/herdr-plugin` to `mk/collie` and update release and clone
  URLs. Rename the local checkout after active work completes.
- The Herdr plugin ID becomes `cego.collie`; its fully qualified actions are
  `cego.collie.pick`, `cego.collie.resume`, and `cego.collie.fork`.
- Keep `herdr-plugin.toml`, `HERDR_PLUGIN_ROOT`, and other Herdr-owned names because they are
  host contracts. Rename project-owned `HERDR_WORKFLOWS_*` variables to `COLLIE_*`.
- There is no old executable, plugin-ID, environment-variable, or persisted-state
  compatibility layer. Setup unlinks `cego.workflows`, preserves its state directory, prints
  that location, and links `cego.collie` with clean state.

## Architecture

Rewrite the application as one Effect v4 program. Use the current Effect v4 release-candidate
APIs, including `effect/unstable/cli`, and accept unstable APIs. Run it with `BunRuntime` and
the Bun platform layer.

The minimum application boundaries are:

- **Definitions**: load, resolve, inspect, and fork Workflows and Personas.
- **Runs**: start, observe, command, resume, and persist Runs.
- **Herdr**: resolve workspace state and perform pane, agent, notification, and plugin effects.

Pure parsing and transformation functions remain ordinary TypeScript. Filesystem, process,
configuration, timing, concurrency, orchestration, and external commands use Effect. Public
service operations use named effects; boundary data and expected errors use Effect Schema.
The CLI, manifest actions, picker pane, and Control Plane call the same services rather than
calling one another.

Use Bun and Effect native features before custom code. Use a small Bun-specific implementation
only if Effect cannot faithfully spawn an unrefed process that survives its caller.

## Command surface

`collie` is installed on PATH. Global options precede the command:

```text
collie [--workspace <workspace-id>] [--json] <command>
```

Commands are:

```text
collie workflow list
collie workflow show <workflow>
collie workflow fork <workflow> \
  --layer <user|project> --mode <extends|copy> --name <name> [--step <step>]

collie persona list
collie persona show <persona>
collie persona fork <persona> --layer <user|project> --name <name>

collie run start <workflow> [inputs]
collie run list
collie run show <run-id>
collie run wait <run-id> [--follow] [--timeout <duration>]
collie run stop <run-id>
collie run resume <run-id>
collie run answer <run-id> <answer>
collie run logs <run-id>
collie run output <run-id>
```

State-changing commands accept `--request-id <id>`. Input values support repeated
`--input key=value`, `--inputs-json <json>`, and `--inputs-json -` for stdin. Explicit values
override inference. Omitted values are inferred from the selected workspace and existing local
state. An ambiguous value returns `needs_input` with its candidates and schema and creates no
Run.

Interactive parity is composition, not a one-to-one command for UI navigation:

| Herdr capability | Programmatic capability |
| --- | --- |
| Pick and run a Workflow | `workflow list`, `workflow show`, `run start` |
| Resume unfinished work | `run list`, `run show`, `run resume` |
| Answer a Choice | `run show`, `run answer` |
| Inspect progress and results | `run show`, `run logs`, `run output`, `run wait` |
| Stop work and close its panes | `run stop` |
| Fork a Workflow or Persona | `workflow fork`, `persona fork` |

UI-only focus, navigation, selection, and popup operations are not CLI capabilities.

## Workspace

Resolve workspace scope in this order:

1. `--workspace <workspace-id>`
2. `HERDR_WORKSPACE_ID`
3. `HERDR_PLUGIN_CONTEXT_JSON.workspace_id`
4. no scope

Only workspace IDs are accepted. Resolve a live workspace through Herdr and capture its ID,
label, working directory, and worktree provenance. Do not import transient focus, selected
text, or clicked links. Explicit command inputs carry anything else the operation needs.

- Starting a scoped Run requires a live workspace and records its stable workspace details.
- Input inference uses that context instead of guessing from the CLI process directory.
- `run list` filters to the resolved workspace, or lists all Runs without a scope.
- Run commands reject a Run recorded for a different resolved workspace.
- Starting a Run resolves the workspace live. Existing Run commands compare the selected ID
  directly with the Run's recorded ID, so they still work after that workspace closes.
  Closing a workspace does not itself stop a Run.
- Workflow and Persona discovery is global; project-layer resolution and inference use the
  selected workspace where applicable.
- Herdr actions pass their injected workspace through the same resolution path.

Return `workspace_required` when an operation genuinely needs context and none exists, and
`workspace_not_found` when an explicitly scoped live workspace cannot be resolved. Commands
that do not need a workspace continue without one.

## CLI output

Commands print readable text or tables by default. `--json` switches to the stable machine
contract. A non-streaming JSON command writes exactly one value to stdout:

```json
{"ok":true,"data":{}}
```

Expected failures use:

```json
{"ok":false,"error":{"code":"workspace_not_found","message":"...","details":{}}}
```

Diagnostics go to stderr and never corrupt JSON stdout. Exit statuses are:

- `0`: success
- `1`: operational failure
- `2`: invalid or insufficient input

JSON consumers distinguish failures by obvious, Schema-defined codes such as
`workspace_not_found`, `run_not_found`, `run_already_active`, `workflow_not_found`,
`target_exists`, and `needs_input`, rather than by adding process exit statuses. Human output
uses the corresponding plain-language message.

`run wait --follow` prints readable progress. With `--json`, it writes one typed JSON event per
line. It emits the current snapshot, existing progress, subsequent events, and exactly one
terminal Run event. `run wait` waits for `succeeded`, `failed`, or `stopped`. An optional
`--timeout` bounds the wait. Interrupting the command stops only the waiter; `run stop` is the
explicit Run cancellation operation.

## Run lifecycle

A Run has one of five states:

- `running`: a Driver is advancing it.
- `waiting`: the Driver is waiting for a Choice.
- `succeeded`: all required Steps completed.
- `failed`: execution ended unsuccessfully with unfinished work.
- `stopped`: an explicit stop ended execution.

`run start` validates and resolves the Workflow and Inputs, creates the Run, launches its
detached Driver, and returns the Run ID. `run stop` tells the Driver to stop orchestration and
close only panes owned by that Run; repository changes remain. `run resume` starts a new
Driver for a failed, stopped, or orphaned Run, skips completed Steps, and restarts unfinished
Steps with fresh agents. Resuming an actively owned Run returns `run_already_active`.

## Filesystem state and coordination

Keep state under `HERDR_PLUGIN_STATE_DIR` as decided in ADR-0004. Decode every persisted
boundary through Effect Schema.

Each Run directory contains its authoritative snapshot, append-only progress, runner log,
verified ownership claim, and command inbox. One Driver owns and writes the Run snapshot at a
time. Other processes atomically create Schema-validated inbox commands. The Driver consumes
them and records their result.

Use Effect `FileSystem.watch` with the Bun filesystem layer for inbox and Run updates. Watch
events are invalidation signals only: reread and decode authoritative files after each event.
Use atomic create/rename and verified Driver ownership for coordination.

Every state-changing command accepts an optional request ID. Collie generates and returns one
when omitted. Reusing a request ID returns its recorded result and must not duplicate Run
creation, Choice effects, stops, resumes, or forks.

## Forking

Workflow and Persona forks support the user and project Layers. Workflow forks support the
existing `extends` and full-copy modes and may select a Step for an extension. Persona forks
copy the Persona under the requested name. Forking never overwrites: an occupied target
returns `target_exists`; there is no `--force`.

## Installation and release

Build native release assets as `collie-<os>-<arch>`. The Herdr manifest invokes its private
`bin/collie`. Setup creates a symlink at `~/.local/bin/collie`, does not mutate PATH, and
reports when that directory is not currently on PATH. Do not introduce Bun global package
installation.

## Acceptance checks

Tests must prove the following without opening UI:

1. Resolve an explicitly passed workspace and capture only its stable details.
2. Discover Workflows, Personas, and input schemas through their public CLI commands.
3. Start a Run and return its ID.
4. Observe current and streamed progress.
5. Answer a Choice.
6. Wait for a successful terminal event.
7. Stop and resume a Run without repeating completed Steps.
8. Fork a Workflow and a Persona without overwrite.
9. Retry every mutation with the same request ID without duplicate effects.
10. Reject cross-workspace Run access.
11. Verify that each Herdr action and its CLI equivalent produce the same observable Herdr
    effects.

Use temporary filesystems/directories and fake Herdr layers. Synchronize concurrent tests with
Effect primitives rather than sleeps. Release gates are:

```sh
bun test
bun run typecheck
bun run build
./bin/collie --help
```

The compiled-binary smoke test must also execute one successful JSON command and one typed
failure.

## Out of scope

- Network API, HTTP server, authentication, multi-user access, or remote daemon.
- SQLite or another database.
- Runtime capability negotiation or a separate consent model; explicit commands and Choices
  are the authority boundary for this same-user local tool.
- Legacy aliases, state migration, generated SDKs, shell completion, or API-version
  negotiation.
- CLI equivalents for UI-only focus and navigation.
- Publishing releases, changing the GitLab project, or renaming the local checkout during
  implementation; those are explicit cutover operations after verification.

## Sources

- [Herdr plugin commands and environment](https://herdr.dev/docs/plugins/#commands-and-environment)
- [Herdr socket and plugin API](https://herdr.dev/docs/socket-api/)
- [Effect v4 FileSystem](https://www.effect.website/docs/v4/api/effect/FileSystem)
- [Effect v4 BunFileSystem](https://www.effect.website/docs/v4/api/platform-bun/BunFileSystem)
