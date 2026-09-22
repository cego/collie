Runner source (Bun/TypeScript). Compiled to `bin/collie` per platform; see ADR-0001.

| File               | What it owns                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `main.ts`          | Entry: the `collie` CLI, or the actions and pane entrypoints under `herdr`               |
| `collie.ts`        | CLI assembly, help behavior, and process exit handling                                   |
| `commands/`        | Workflow, Persona, and Run command handlers plus their shared resolution context         |
| `envelope.ts`      | CLI envelopes, stdout, exit statuses, request receipts, and mutation locks               |
| `operations.ts`    | Workspace resolution and Run mutations shared by both front doors                        |
| `doctor.ts`        | Every prerequisite an installation needs, checked in one pass, each with its fix         |
| `flows.ts`         | What each action and pane entrypoint does                                                |
| `env.ts`           | The plugin environment herdr provides                                                    |
| `herdr.ts`         | The only channel to herdr: CLI at `HERDR_BIN_PATH`, socket for the rest, and its config  |
| `definitions.ts`   | Layers, `extends:` overrides, `use:` embedding, validation                               |
| `yaml.ts`          | Frontmatter split and write-back over Effect's YAML parser                               |
| `schema.ts`        | Shared Schema predicates used across boundary decoders                                   |
| `journal.ts`       | Append-only JSONL: the read that survives a torn line, and the append that makes its dir |
| `harness.ts`       | Per-harness start, model flag, effort flag and persona injection                         |
| `inputs.ts`        | Input inference from branch, cwd, earlier runs and glab                                  |
| `strategies.ts`    | Which Input carries which strategy, and how a settled Run is read through one            |
| `engine.ts`        | Tabs, agents, prompts, waits, gates, choices and the fix loop                            |
| `workspace.ts`     | The Control Plane: what the Session's board shows, and the text fallback that draws it   |
| `ui/`              | The Collie tab: the card board and its drawer, plain state and commands, and the bridge  |
| `views.ts`         | History, Workflows, Settings and a Run's detail, as state the app renders                |
| `board.ts`         | The board's model: one TaskView per Task, its pipeline, sections, and a card's sentence  |
| `driver.ts`        | The run dir as the channel to a detached driver: progress, pid and questions             |
| `attention.ts`     | Why a run wants a human, what a resume would keep, and which actions are safe            |
| `registry.ts`      | Which long-lived agents this Session still has, per workspace + repo                     |
| `handoff.ts`       | Giving one Run's result to another Run's live agent                                      |
| `output.ts`        | The Output and Synthesis schemas, `review.md`, and which findings the loop still owns    |
| `run.ts`           | The run directory: audit trail and resume state                                          |
| `snapshot.ts`      | The resolved workflow a Run is running, frozen in its run directory at creation          |
| `intent.ts`        | What a Run is for, what bounds it, and what Collie may do about it without asking        |
| `steering.ts`      | The delivery ledger per live agent, and the Herd's model-call budget                     |
| `dispatcher.ts`    | The only sender: one transaction per agent, reserved before the send, ordered            |
| `steering-caps.ts` | What each harness has been shown to do about a delivery, and the gate that fails closed  |
| `evaluator.ts`     | The one place a model is asked anything, tool-less and capped, and the closed schemas    |
| `proposals.ts`     | Hash-bound proposals, and the Confirmation rule that a yes names its exact payload       |
| `executors.ts`     | Which action kinds this build can carry out; an unregistered one is refused, never faked |
| `drift.ts`         | Where the work and the Intent disagree: rules, judgement, and the correction loop        |
| `verify.ts`        | A command's result bound to the tree it ran on, so a card can say verified not claimed   |
| `verify-spec.ts`   | Which commands Collie may run itself for a Run, and where that permission came from      |
| `outcome.ts`       | What a Run must prove to close, per kind, and what is still missing                      |
| `metrics.ts`       | What a Run produced and when: evidence, slices, rework, context — never pane activity    |
| `cards.ts`         | One slice of work as a human wants it handed over, with its readiness and significance   |
| `disposition.ts`   | What became of a Run's work, recorded beside its status and never over it                |
| `conversation.ts`  | What the human and Collie have said about this Herd, redacted and reference-checked      |
| `chat.ts`          | The Home's native conversation: which harness, which session, and how it is launched     |
| `tools.ts`         | The bounded Herd-wide reads native chat may make, and nothing else                       |
| `mcp.ts`           | Those same reads over MCP on stdio, which is how Claude Code reaches them                |
| `native.ts`        | Effect's workflow engine, the SDK the binary serves a module, and where generations live |
| `host.ts`          | The one local host per state directory: who owns it, how a client reaches it             |
| `discovery.ts`     | Where a workflow module is looked for, which layer wins, and what counts as an edit      |
| `store.ts`         | Rows beside Effect's: request claims, run identity, generations, open questions          |
| `lifecycle.ts`     | A native Run from both front doors: start it, watch it, and pick it up again             |
| `sdk.ts`           | `collie/native`: what a workflow module exports, declares, and is refused for            |
| `agents.ts`        | What a native workflow does with an agent: one launch, one collection, one repair        |
| `proactive.ts`     | What is worth Collie starting a turn about, and what it has already said                 |
| `news.ts`          | What it noticed and nobody has read: deduped, batched, and sent is never read            |
| `home.ts`          | Which workspace is this Herd's Home, decided by proof and never by a label               |
| `live.ts`          | The board's Live region and every row's marks, from one pass. Read-only                  |
| `lines.ts`         | A card, a report, a delivery, a row's marks and an action, as the same words everywhere  |
| `plan.ts`          | A plan directory as repositories and waves, and the refusals that stop a fan-out         |
| `lock.ts`          | The pid-lock discipline shared by the run persistence lock and the Driver takeover lock  |
| `task.ts`          | A Task: the work, its herdr workspace, and which Runs belong to it                       |
| `tasknames.ts`     | What a task workspace is called, from the work and the session's own live labels         |
| `naming.ts`        | herdr-legal agent names vs readable tab and pane labels                                  |
| `keys.ts`          | Raw keypresses, for the text board a pane falls back to when the renderer will not start |
| `fork.ts`          | Take a definition into a later layer: an `extends:` stub, or a full copy                 |
| `trust.ts`         | Whether a harness will work in a directory, or stop and ask first                        |
| `worktree.ts`      | The checkout a mutating Run owns, keyed by its branch, and pruning the settled ones      |
| `helle.ts`         | Helle as a client, and the gate a Step blocks on until it holds the project              |
| `mr.ts`            | Whether GitLab is reachable, who to assign, and which Linear tickets a branch answers    |
| `template.ts`      | `{{a.b}}` prompt substitution                                                            |
| `config.ts`        | User defaults and remembered values in `config.json`                                     |
| `compaction.ts`    | One threshold, one work-boundary policy, and each agent's controls for its lifetime      |
| `compactors.ts`    | Each harness's official compaction interface, generated per agent and bundled in Collie  |
| `codex.ts`         | Codex's App Server as a client: thread identity, its context, and its compactions        |
