# 01: Runner skeleton + herdr boundary test seam

**What to build:** A bun runner (`pick`, `resume`, `picker` subcommands stubbed) that reads the plugin env, talks to herdr through HERDR_BIN_PATH, and has a fake-herdr test harness recording every command. `herdr plugin link` registers the actions and `pick` prints the environment it received.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] bun test runs against a fake herdr recorder
- [x] herdr plugin link + herdr plugin action invoke pick works in a live session
- [x] bun build --compile produces bin/herdr-workflows for linux-x64

**Notes:** Filled-in decisions: the runner uses the herdr CLI (`HERDR_BIN_PATH`) for
everything the 0.7.5 CLI exposes and the socket (`HERDR_SOCKET_PATH`) only for
`agent.view.set`, `agent.view.clear`, `popup.close`, which have no CLI form. Both
transports record into one ordered log in tests. Plugin actions have no tty, so every
interactive part lives in a pane entrypoint: `picker` (popup) and `runner` (tab,
the Run's status pane). Actions `pick`/`resume`/`fork` open `picker` with a mode.
