# 07: Route Herdr controls through the same Effect program

**What to build:** Keep Collie's interactive Herdr experience while removing separate business behavior from its actions and panes. Pick, Resume, Fork, and the Control Plane must become thin adapters over the same Effect operations exposed by the CLI.

**Blocked by:** 02: Discover and safely fork Workflows and Personas; 04: Follow Run progress and retrieve results; 05: Answer Choices programmatically; 06: Stop and resume Runs safely

**Status:** done

- [x] Pick discovers Workflows, resolves Inputs, and starts Runs through the same behavior as the corresponding CLI commands.
- [x] Resume and Fork use the same Run and Definition behavior as their CLI equivalents.
- [x] The Control Plane reads Run state, follows progress, answers Choices, stops Runs, and resumes Runs through the shared program.
- [x] Herdr-injected workspace context follows the same precedence and scoping rules as explicit CLI context.
- [x] UI-only focus, navigation, selection, and popup behavior stays in the Herdr adapters rather than leaking into the CLI.
- [x] Tests invoke both adapters against the same fakes and assert equivalent observable Herdr and filesystem effects, not internal call structure.
- [x] Existing interactive behavior remains covered, including workspace isolation and one Control Plane per Session.
- [x] `bun test` and `bun run typecheck` pass.
