# 08: Cut over locally from herdr-plugin to Collie

**What to build:** Complete the local big-bang cutover so the product, executable, package, plugin identity, installation, documentation, and release metadata consistently describe Collie, with no legacy runtime surface left behind.

**Blocked by:** 07: Route Herdr controls through the same Effect program

**Status:** ready-for-agent

- [ ] The executable, package, release assets, UI labels, and project-owned environment variables use `collie`, Collie, or `COLLIE_*` consistently.
- [ ] The Herdr plugin ID is `cego.collie`; Herdr-owned contracts such as `herdr-plugin.toml`, `HERDR_PLUGIN_ROOT`, and `HERDR_PLUGIN_STATE_DIR` retain their required names.
- [ ] Setup unlinks `cego.workflows`, preserves and reports its old state directory, links `cego.collie` with clean state, and creates `~/.local/bin/collie` as a symlink without modifying PATH.
- [ ] No executable alias, old plugin-ID alias, old project-owned environment variable, persisted-state migration, SQLite layer, daemon, generated SDK, or API-version negotiation remains.
- [ ] Clone URLs, release metadata, and documentation are ready for the later `mk/collie` GitLab rename without performing remote operations.
- [ ] `bun test`, `bun run typecheck`, and `bun run build` pass.
- [ ] The compiled binary passes `./bin/collie --help`, one successful JSON command, and one typed JSON failure.
- [ ] All acceptance checks in the Collie specification pass, and the final diff contains no unintended source or state artifacts.
