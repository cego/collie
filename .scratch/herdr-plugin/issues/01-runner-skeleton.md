# 01: Runner skeleton + herdr boundary test seam

**What to build:** A bun runner (`pick`, `resume`, `picker` subcommands stubbed) that reads the plugin env, talks to herdr through HERDR_BIN_PATH, and has a fake-herdr test harness recording every command. `herdr plugin link` registers the actions and `pick` prints the environment it received.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] bun test runs against a fake herdr recorder
- [ ] herdr plugin link + herdr plugin action invoke pick works in a live session
- [ ] bun build --compile produces bin/herdr-workflows for linux-x64
