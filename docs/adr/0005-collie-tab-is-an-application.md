# 0005 — The Collie tab is an OpenTUI/Solid application

**Status:** accepted, 2026-09-01. What the tab _draws_ — views behind a nav rail, a row
per Run, a detail panel — is superseded by
[ADR-0013](0013-the-board-is-cards-of-tasks.md); the decision below is unchanged.

## Context

The Control Plane was a poll loop that rendered one string and repainted on change. It
could not express hover, scrolling, regions or a detail panel, and every action targeted
the newest run rather than one the human chose. herdr — the host — is mouse-driven, so its
own plugin's tab read as a script bolted on rather than part of the product.

Three properties were in tension: zero runtime dependencies (only `effect`, one
`bun build --compile` artefact per platform, fetched by `install.sh` — ADR-0001); a real
mouse-first UI with views, a detail panel and live updates; and one program, where the CLI,
the panes and the Driver are the same Effect program (ADR-0003) and headless operation does
not depend on a renderer.

## Decision

Build the Collie tab, and the popups, as an **OpenTUI + Solid** application with **Effect
owning all state and behaviour and Solid owning only rendering**: services produce plain
`AppState`, one bridge pushes it into signals, and components render props and dispatch
plain commands back to handlers that call `src/operations.ts`. Components never import
`effect`; handlers never render.

## Alternatives

- Keep hand-rolling: an alternate-screen, line-diffing renderer would carry hover and
  scrolling with no dependency, but it stops at "a nicer board" and every widget after
  that — lists, forms, overlays, wrapping — is rebuilt here.
- React/Ink: pulls a Node-shaped runtime into a Bun binary.
- A separate UI binary: two artefacts, two release paths, and state ownership split across
  a process boundary for no gain.

OpenTUI settled it on the test story: it is Bun-native, has a Solid binding, and ships a
headless renderer with mouse and keyboard mocking, so a UI this repo cannot test cannot
rot here.

## Consequences

The zero-dependency property is spent: `@opentui/core`, `@opentui/solid`, `solid-js`, and a
per-platform native renderer embedded in each binary — `linux-x64` grew from 80 MiB to
91 MiB. The build moves from `bun build --compile` to `tools/build.ts`, because Solid needs
a JSX transform and `--compile` runs no plugins; cross-compiling the release targets needs
every target's native package installed (`bun install --os='*' --cpu='*'`), and each
artefact is checked for its own renderer before it ships. The CLI must not import OpenTUI:
the pane entrypoints load the UI through a dynamic import, and a pane with no TTY prints
the one-screen text view — kept alive and tested, because it is also the escape hatch if
OpenTUI becomes a problem on a supported platform. `EnginePrompts` and the Driver's
`filePrompts` do not move: a headless Run answers through files in the Run directory, and
that must never depend on a renderer being available.
