# 02: Discover and safely fork Workflows and Personas

**What to build:** Complete Collie's human-friendly Workflow and Persona commands so callers can inspect either kind of Definition and fork it into their user or project Layer without using a picker or risking an overwrite.

**Blocked by:** 01: Run workspace-scoped Workflow discovery through Effect

**Status:** ready-for-agent

- [ ] `collie persona list` and `collie persona show <persona>` provide readable and JSON output consistent with Workflow discovery.
- [ ] `collie workflow fork` supports user/project Layers, extension/full-copy modes, a requested target name, and optional Step selection for an extension.
- [ ] `collie persona fork` copies a Persona into the requested Layer and name.
- [ ] Forking an occupied target returns `target_exists` and never overwrites it; there is no force option.
- [ ] Supplying the same request ID returns the original result without creating or changing another fork.
- [ ] Tests cover both Definition kinds, both Layers, both Workflow fork modes, collision handling, and retry safety through public commands.
- [ ] `bun test` and `bun run typecheck` pass.
