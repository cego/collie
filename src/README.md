Runner source (Bun/TypeScript). Compiled to `bin/herdr-workflows` per platform; see ADR-0001.

| File | What it owns |
| --- | --- |
| `main.ts` | Subcommand dispatch: the three actions and the two pane entrypoints |
| `flows.ts` | What each action and pane entrypoint does |
| `env.ts` | The plugin environment herdr provides |
| `herdr.ts` | The only channel to herdr: CLI at `HERDR_BIN_PATH`, socket for the rest |
| `definitions.ts` | Layers, `use:` embedding, validation |
| `yaml.ts` | The frontmatter subset, so the binary needs no dependency |
| `harness.ts` | Per-harness start, model flag, effort flag and persona injection |
| `inputs.ts` | Input inference from branch, cwd, earlier runs and glab |
| `engine.ts` | Tabs, agents, prompts, waits, gates, choices and the fix loop |
| `output.ts` | The Output schema, fan-in, and which findings the loop still owns |
| `run.ts` | The run directory: audit trail and resume state |
| `naming.ts` | herdr-legal agent names vs readable tab labels |
| `picker.ts` | The minimal TUI |
| `fork.ts` | Copy a definition into a later layer |
| `template.ts` | `{{a.b}}` prompt substitution |
| `config.ts` | User defaults and remembered values in `config.json` |
