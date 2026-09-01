Runner source (Bun/TypeScript). Compiled to `bin/collie` per platform; see ADR-0001.

| File             | What it owns                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- |
| `main.ts`        | Entry: the `collie` CLI, or the actions and pane entrypoints under `herdr`              |
| `collie.ts`      | CLI assembly, help behavior, and process exit handling                                  |
| `commands/`      | Workflow, Persona, and Run command handlers plus their shared resolution context        |
| `envelope.ts`    | CLI envelopes, stdout, exit statuses, request receipts, and mutation locks              |
| `operations.ts`  | Workspace resolution and Run mutations shared by both front doors                       |
| `flows.ts`       | What each action and pane entrypoint does                                               |
| `env.ts`         | The plugin environment herdr provides                                                   |
| `herdr.ts`       | The only channel to herdr: CLI at `HERDR_BIN_PATH`, socket for the rest                 |
| `definitions.ts` | Layers, `extends:` overrides, `use:` embedding, validation                              |
| `yaml.ts`        | The frontmatter subset, so the binary needs no dependency                               |
| `schema.ts`      | Shared Schema predicates used across boundary decoders                                  |
| `harness.ts`     | Per-harness start, model flag, effort flag and persona injection                        |
| `inputs.ts`      | Input inference from branch, cwd, earlier runs and glab                                 |
| `engine.ts`      | Tabs, agents, prompts, waits, gates, choices and the fix loop                           |
| `workspace.ts`   | The Control Plane: what the Session's board shows, and how it reads                     |
| `driver.ts`      | The run dir as the channel to a detached driver: progress, pid and questions            |
| `registry.ts`    | Which long-lived agents this Session still has, per workspace + repo                    |
| `handoff.ts`     | Giving one Run's result to another Run's live agent                                     |
| `output.ts`      | The Output and Synthesis schemas, `review.md`, and which findings the loop still owns   |
| `run.ts`         | The run directory: audit trail and resume state                                         |
| `lock.ts`        | The pid-lock discipline shared by the run persistence lock and the Driver takeover lock |
| `naming.ts`      | herdr-legal agent names vs readable tab and pane labels                                 |
| `picker.ts`      | The minimal TUI                                                                         |
| `fork.ts`        | Take a definition into a later layer: an `extends:` stub, or a full copy                |
| `trust.ts`       | Whether a harness will work in a directory, or stop and ask first                       |
| `mr.ts`          | Whether GitLab is reachable, who to assign, and which Linear tickets a branch answers   |
| `template.ts`    | `{{a.b}}` prompt substitution                                                           |
| `config.ts`      | User defaults and remembered values in `config.json`                                    |
