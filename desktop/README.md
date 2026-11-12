# Collie desktop core

The desktop app is Collie, drawn by Rune. This directory holds its TypeScript core,
shared RPC schemas and decision logic. The Rust shell, terminal, chat, packaging and
update installer are in [`desktop-rune/`](../desktop-rune/README.md). There is no
Nuxt/Vue view or Electrobun UI runtime.

The core reaches Machines through `collie bridge`, keeps the Flock chat and settings,
and serves `DesktopRpcs` over stdin/stdout through `desktop-rune/core/platform.ts`.
A release compiles it to `collie-core`; users need no separate Bun installation.
Effect and the host schemas come from the repository root.

Run the scripts in `package.json` for core typechecking and the native bundle build.
Core behavior is covered by `test/desktop-*.test.ts` and `test/flock-*.test.ts` at the
root. `desktop/test/` retains tests of shared logic; native interaction tests live
under the Rust crates. The previous Vue-only tests and browser benchmark driver
were removed with the view. Benchmark fixture and analysis utilities remain reusable.

## Installation and updates

The existing `dk.cego.collie.desktop` stable identity, launcher paths and data roots
are retained. Signed `stable-<os>-<arch>` archives replace the old app in place;
settings, connection credentials and chat state remain where the core reads them.
The user-facing name is Collie on both platforms. See
[the cutover decision](../docs/adr/0067-collie-replaces-the-webview-desktop-in-place.md)
for the legacy updater contract and remaining platform verification.

## Measuring Desktop's start

`bench/desktop-start/run.ts --rune <bundle>/bin/launcher` measures an isolated
native bundle's board-ready time and process-tree RSS. On macOS, pass the bundle's
`Contents/MacOS/launcher`. Measurements from the earlier webview and Rune spike
remain historical observations, not results for the cutover build.
