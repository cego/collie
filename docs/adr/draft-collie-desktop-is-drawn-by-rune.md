# Collie Desktop is drawn by Rune

**Status: draft, gate held for evidence.** Decided by the human on run-d9db315d.implement
(ticket 07), 2026-11-10. Go or no-go waits for the after-merge evidence below. The product
decisions recorded here stand whichever way the gate goes.

## What was true before

Desktop is a Bun main process, pure TypeScript decision logic, and a Nuxt/Vue view in
WKWebView on macOS and a bundled CEF on Linux, packaged and updated by Electrobun. The plan of
run-d9db315d asked whether the view and its native shell could move to
[Rune](https://github.com/anomalyco/rune), a Rust GPU UI toolkit, with the main process kept
as the Desktop core. Tickets 01–06 measured today's Desktop and spiked the move on this branch:

- 01: launch, memory, terminal, chat and frame marks, and the launch harness
  `bench/desktop-start`;
- 02: a Rune board fed by the unchanged main process over Effect RPC on stdio
  (`desktop-rune/`);
- 03: Go to pane's terminal on libghostty-vt;
- 04: the Flock chat, agent markdown and the Diff tab;
- 05: notifications, files in, scale and accessibility;
- 06: the bundle, macOS signing and notarising, and signed updates applied at launch.

Each ticket's findings are in the Run's report, `plan/INVESTIGATION.md` of
run-d9db315d.implement, and in [`desktop-rune/README.md`](../../desktop-rune/README.md),
"Spike notes".

## Decision

**D1. The gate is held until the after-merge evidence is on the Run.** All of it was taken
on vm-mk, which has no display and no GPU, so none of tickets 01–06's "After merge" checks has
run. Asked whether to decide without it, the human chose to hold. The merge request for this
branch runs the `desktop-rune` and `rune-bundle` jobs. The human then attaches to the Run:

- ticket 01's baseline Measurement on mk-laptop and a macOS arm64 Mac;
- the same Measurement of the Rune bundle (`bench/desktop-start`: `board_usable_ms`,
  `idle_rss_mib`), and `terminal.echo_ms` in a live pane;
- a live Rune window on mk-laptop: board, Go to pane, a chat turn, the Diff tab;
- a notification click, a file paste, a dialog through the XDG portal, two monitors at
  different scales, and Orca and VoiceOver walk-throughs;
- the notarised `.app` opened past Gatekeeper, and a staged update applied across a
  relaunch on mk-laptop and the Mac.

Then the gate asks for go or no-go.

**D2. Product decisions the spikes left open:**

- An evidence HTML report opens in the existing Chromium `--app` window (`browser.ts`).
  Rune has no webview.
- On Wayland, files come in by Attach or paste only, until winit reports drops there.
- Code blocks use rune-kit's built-in highlighter where it knows the language, and syntect
  with two-face for the languages it misses, off the draw thread.
- Zoom is accepted as missing until Rune has an app-level UI scale.
- Not accepted, so required before a cutover: terminal selection and copy, with every mouse
  button reaching the pane; raw HTML in agent markdown keeping its text (`<details>` keeps
  its summary); a file dialog that picks several files.

**D3. Rust is accepted** as a second language in this repository, with its reviewers, CI
time, a Rust and Zig toolchain on every build Machine, and `collie verify` running cargo
checks.

**D4. mk owns the Rune pin, and Collie never forks Rune.** The pin is `rune`, `rune-kit`
and `rune-mac` at rev `781e2b6d87cd5f32d6f4365956fad4baaf24ee50` (`desktop-rune/Cargo.toml`),
the revision every spike and this gate assessed. It moves only by ticket.
Upstream defects are worked around in Collie's own code. A defect that blocks a ticket and
has no work-around stops that ticket until upstream fixes it.

## Prerequisites

The spec's go/no-go prerequisites, each with what settles it:

| #   | Prerequisite                                              | State                          | Evidence                                                                                                                             |
| --- | --------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The team accepts Rust                                     | met                            | D3; the human's answer on run-d9db315d.implement                                                                                     |
| 2   | A named owner for the Rune pin, and a fork policy         | met                            | D4; the human's answer on run-d9db315d.implement                                                                                     |
| 3   | Spikes 03–06 pass, or each failure has a product decision | met in tests; live checks open | the Run's `plan/INVESTIGATION.md`, tickets 03–06; D2; `handoffs/rune-board-headless.png`, `evidence/corpus-png-public`               |
| 4   | No regression on startup, idle RSS and terminal echo      | open                           | no baseline taken yet (D1)                                                                                                           |
| 5   | Packaging works end to end                                | open                           | `desktop-rune/scripts/bundle.ts` and `rune-bundle.yml` built and argument-tested on Linux; CI, Gatekeeper and a live update are D1's |

## Figures

No figure here is a gain or a regression: no Measurement has judged one.

| Metric                      | Today's Desktop                                                   | Rune spike                                                                    |
| --------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `start.board_usable_ms`     | not taken; one Xvfb start on vm-mk drew in 11.4 s, not a baseline | not taken; headless lavapipe debug build: GPU init 560 ms, first frame 387 ms |
| `idle.rss_mib`              | not taken; the same Xvfb start: 1,478 MiB                         | not taken                                                                     |
| `terminal.echo_ms`          | not taken                                                         | not taken                                                                     |
| `terminal.throughput_mibps` | not taken                                                         | 83 and 106 MiB/s over recorded frames (VT only, no drawing)                   |
| update archive, Linux x64   | 193,154,969 B                                                     | 67,880,526 B                                                                  |
| bundle, Linux x64, unpacked | not compared                                                      | 163,026,969 B (core 113 MB)                                                   |

## Considered

- **Deciding on vm-mk's evidence.** Prerequisites 4 and 5 would be recorded unmet, and the
  spec says go only when they hold. The human chose to hold instead.
- **Forking Rune on a blocker.** Rejected by the human (D4). A blocking upstream defect
  without a work-around waits for upstream.

## Consequences

- Nothing here ships. `desktop-rune/` and its CI jobs stay experimental until the gate
  decides. On no-go they are removed and ticket 01's marks and harness stay; on go the
  post-gate plan (`plan/post-gate.md` of run-d9db315d) is revised against the evidence, and
  `AGENTS.md` names this ADR and the Rust workspace.
- The effort estimate stands at the spec's 20–28 engineer-weeks after the gate, low
  confidence. The spikes each held to their slice, which supports the shape of the plan, but
  no figure narrows it. D2's three required items add work to tickets 11 and 12. Under D4,
  a rune-kit limit such as the one-file dialog or dropped HTML is closed in Collie's code
  (its own dialog call, the markdown policy rewriting HTML before rune-kit sees it).
- Under D4, an upstream defect with no work-around stops its ticket. Rune is untagged,
  single-author and takes no PRs, so such a stop has no date.
