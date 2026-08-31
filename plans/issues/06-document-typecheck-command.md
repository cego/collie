# 06: Make typechecking a documented repository command

**What to build:** Give contributors one named typecheck command and use it in
both local documentation and CI, so the documented development loop exercises the
same TypeScript gate as the pipeline.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The package exposes a `typecheck` script that runs TypeScript in no-emit mode.
- [ ] CI invokes the package's typecheck script instead of spelling a separate command.
- [ ] Contributor documentation lists dependency installation, tests, typechecking,
      and binary building in a clear order.
- [ ] The documented warning that building replaces the linked runner binary remains
      accurate and visible.
- [ ] No formatter, linter, pre-commit framework, or unrelated dependency is added.
- [ ] `bun test` passes.
- [ ] `bun run typecheck` exits successfully with no emitted files.

