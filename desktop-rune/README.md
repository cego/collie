# desktop-rune: the Rune spike

An experiment, which no release ships. It asks whether a [Rune](https://github.com/anomalyco/rune)
shell can draw Desktop's board with today's main process as its core. The app starts
`desktop/src/bun/index.ts` as a child process. `core/electrobun-stdio.ts` stands in for
`electrobun/bun`, so Desktop's own code is unchanged. It then speaks `DesktopRpcs` to the core
as Effect RPC over NDJSON on the core's stdio, subscribes to `flock`, and draws each Machine and
its cards. Pressing a card goes to its Run's pane: Rune draws the pane's terminal from the
`terminal` stream, through libghostty-vt, and sends what the human does back on `terminalSend`.
The pane's Diff button opens its Run's diff in rune-kit's Diff, where selected lines become
review comments. The board's Chat button opens the Flock chat, which streams turns on `say`.

| Crate or file                | What it owns                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/src/generated.rs`  | The Rust types of the RPCs spoken (`flock`, `syncNow`, `terminal`, `terminalSend`, `say`, `runDetail`, `runFile`), generated; never edited by hand |
| `protocol/src/rpc.rs`        | Effect RPC's envelope (Request, Chunk, Exit, Ack, Interrupt) and Desktop's `Hello`, written by hand                                                |
| `protocol/src/client.rs`     | The NDJSON client: requests, streams acked chunk by chunk, interrupts, the core gone                                                               |
| `protocol/src/bin/roundtrip` | Decodes and re-encodes frames through the Rust types, for `test/rune-contract.test.ts`                                                             |
| `board/`                     | The board view and its fold of `flock` items (a narrow copy of `applyItem`), and the app                                                           |
| `protocol/src/core.rs`       | Starts Desktop's main process as the core, for the app and the recorders                                                                           |
| `chat/`                      | The Flock chat (AG-UI reducer, markdown policy, syntect highlighter) and the Diff tab's review comments                                            |
| `terminal/`                  | Go to pane's terminal: the VT state, its Rune view, input as `terminal-input` maps it, settled resizes                                             |
| `ghostty-sys/`               | Builds libghostty-vt from `vendor/ghostty` with Zig and binds its C API with bindgen                                                               |
| `vendor/ghostty`             | Ghostty, a submodule at one pinned commit                                                                                                          |
| `core/`                      | The stdio stand-in for `electrobun/bun`, and the tsconfig that points Desktop's imports at it                                                      |
| `fixtures/`                  | The test Flock and NDJSON transcripts of Effect's own client and server, written by `tools/rune-fixtures.ts`                                       |
| `fixtures/terminal/`         | `terminal` streams recorded by `core/record-terminal.ts`                                                                                           |
| `fixtures/chat/`             | `say` streams recorded by `chat/src/bin/record-say.rs`                                                                                             |

## Commands

The toolchain is pinned in `rust-toolchain.toml`, and Rune at one rev in `Cargo.toml`.

```sh
bun run tools/rune-types.ts --write    # regenerate protocol/src/generated.rs from today's Schemas
bun run tools/rune-types.ts --check    # fail where it differs (test/rune-types.test.ts does this)
bun run tools/rune-fixtures.ts         # rewrite fixtures/ from test/support/rune-fixtures.ts

git submodule update --init desktop-rune/vendor/ghostty

cd desktop-rune
cargo test --workspace                 # client against the transcripts, the board, the terminal
cargo run --release -p collie-desktop-terminal --example throughput   # VT bytes per second
cargo run -p collie-desktop-board      # the window, with the live board of this Machine
cargo run -p collie-desktop-board -- --snap board.png --tree board.json   # headless
cargo run -p collie-desktop-chat --bin record-say -- --out x.ndjson --say 'hello'   # record a turn
cargo run -p collie-desktop-chat --bin corpus -- <dir of .md> [--png <dir>]  # the corpus table
cargo run --release -p collie-desktop-chat --example highlight-cost -- <dir of .md>
cargo run -p collie-desktop-board --example read-diff -- <installation> <run>
```

Run `bun install` at the root first, since the core is Desktop's source run by `bun`
(`COLLIE_RUNE_BUN` names another). The core keeps its state under
`$XDG_STATE_HOME/collie-desktop-rune-spike/`, apart from a Desktop running beside it. With no GPU,
point Vulkan at lavapipe: `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`. On
Linux, building needs `libxkbcommon-dev` and `libwayland-dev`, and lavapipe is in
`mesa-vulkan-drivers`. libghostty-vt needs Zig 0.16.0 (`zig` on `PATH`, or `ZIG` naming it)
and bindgen needs libclang; its first build takes about four minutes. CI's `desktop-rune` job runs `cargo fmt --check`, `cargo clippy -D
warnings`, `cargo test` and the contract test.

## Spike notes

### What the generator could not map faithfully

The generator maps `Schema.toJsonSchemaDocument` for each spoken part. It keeps `$ref`,
`anyOf`, string `enum`s, objects, arrays and records. Each of the following does not map
faithfully:

- **`UnknownMessage`.** A Machine message whose `_tag` is none of the known ones decodes to
  `Message::UnknownMessage`. The `_tag` filter that excludes the known tags has no JSON
  Schema form, so the variant is untagged and comes last. serde tries the variants in order,
  so a known tag never reaches it.
- **Unknown fields.** The documents allow additional properties, but the Rust structs drop
  them on decode. The contract test re-encodes through Rust and compares, so a field that
  the Schemas set but the Rust types drop turns it red.
- **Numbers.** JSON Schema `integer` becomes `i64`, and the Schema's bounds are dropped.
  `Finite` becomes `f64`, which still admits NaN and infinity in Rust, though JSON can't carry them.
- **Optional and nullable fields.** These become `Option<Option<T>>`, through
  `crate::double_option`. Absent is `None`, and `null` is `Some(None)`.
- **The envelope.** Effect's `RpcMessage` is not a `DesktopRpcs` Schema, so `rpc.rs` is written by
  hand. Desktop's `Hello` frame has no Schema either; it is an interface in
  `desktop/src/shared/channel.ts`. The transcripts and the contract test check both.
- **Names.** JSON Schema has no names for inline objects, so the generator picks them:
  - a union member takes its `_tag`, else its first one-value field;
  - a struct with no such field takes a name from a fixed table (`MachineMessage`);
  - a nested struct takes the field it sits in, prefixed by its parent where that name
    is taken.

  One schema is one type, so `KnownMachine` appears once, as `LostMachine`. The name comes
  from the first place it is used.

- **Errors.** `ActionFailed` arrives as a `$ref` to `ActionFailedEncoded`. The suffix is
  dropped.
- **`void` and `never` parts** (`flock`'s payload and error) get no type. Their wire values
  are `null` and none.

### Build times and size

vm-mk: 24 cores, rustc 1.99.1, dependencies already fetched, a target directory of its own.

| Build                                        | Time    |
| -------------------------------------------- | ------- |
| clean, dev                                   | 107.2 s |
| clean, release                               | 212.5 s |
| incremental, dev (`board/src/lib.rs` edited) | 3.7 s   |
| incremental, release (the same edit)         | 36.7 s  |

The first clean dev build, which also fetched dependencies, took 112.4 s.

The release `collie-desktop-board` binary is 37,028,016 bytes; stripped, it is 27,812,136
bytes (27.8 MB).

On vm-mk, a headless debug run against the live board took 560 ms for GPU initialisation
on lavapipe. Its first frame took 387 ms. The live board was one Snapshot of 21 cards, and
12 live frames went through the Rust types and came back unchanged.

### Rune workarounds

- **Card titles.** rune-kit's `Card` title neither wraps nor truncates, and a long task name runs
  past the card. The board leaves the title unset and draws the name as body text that wraps
  (`card` in `board/src/lib.rs`), with the card's accessible label set by hand. Upstream
  issue: not filed, by the human's decision. The draft, with a repro and a suggested fix, is
  in the Run's `handoffs/rune-card-title-issue.md`.

### Go to pane's terminal

The terminal keeps today's transport: the `terminal` stream brings frames, and `terminalSend`
carries input, resizes, scrolls and mouse presses. Leaving the terminal interrupts the stream,
which has the core send `terminal.release`. The view draws one monospaced line a row, a span
for each run of one style, the cursor's cell inverted.

**Pins.** Ghostty is the submodule `vendor/ghostty` at `291fd050b9e9c293c8adb6a140742649b7e42d3a`,
built with Zig 0.16.0, its `minimum_zig_version`. `THIRD-PARTY-NOTICES` names Ghostty (MIT)
and the herdr-app code adapted (Apache-2.0): `ghostty-sys` and `terminal/src/vt.rs`.

**Recordings.** `core/record-terminal.ts` opens the core's `openTerminal` on a pane, at 100 by
30, types into it, and writes each event as NDJSON. It opens the pane directly rather than
through a Run's lookup, so a scratch pane served. The fixtures are a herdr pane running
`ls --color`, `vim` in a herdr pane, and a core attach's first paint. `vim` stands in for
`htop`, whose screen never stops changing, so its recording never settles.

```sh
bun desktop-rune/core/record-terminal.ts --pane <herdr pane> --out desktop-rune/fixtures/terminal/x.ndjson --type 'ls --color\r'
bun desktop-rune/core/record-terminal.ts --core <core terminal> --out desktop-rune/fixtures/terminal/core-attach.ndjson
```

**Throughput.** On vm-mk (Xeon Gold 6150, 24 cores), the VT state took a 50 MiB stream, the
three recordings' frames played in turn, in 64 KiB writes, at 83 to 106 MiB/s over two runs:

```sh
cargo run --release -p collie-desktop-terminal --example throughput
# 52428800 bytes (9957 recorded, repeated) in 0.472 s: 105.9 MiB/s
```

This is evidence for the gate, not a claim of speed: the recordings are small and repeat.

**Translated tests.** Every case in `desktop/test/terminal-input.test.ts` and
`test/desktop-terminal-size.test.ts` has a cargo test against the Rust mapping
(`terminal/tests/input.rs`, `size.rs`, `pane.rs`). Where a case cannot mean the same in Rune:

- **xterm.js's own mouse reports.** `isMouseReport` is ported and tested, but Rune never
  types a mouse report, so the view has no use for it.
- **Copy with a selection.** The spike has no selection, so Ctrl+C always goes to the pane;
  the mapping's selection case is tested on its own.
- **Middle and right buttons.** Rune's `on_drag` reports no button, so a press is the left
  button. `mouse_of` maps all three, and its tests cover them.
- **Cell metrics.** The view takes a cell as 0.6 em by 20 pt rather than measuring the face,
  so the columns a width gives are an estimate.

The `terminal-ended` alert, the `terminal-where` label and the grid's cursor label stand in
for the screen-reader text xterm.js gives.

### Flock chat, agent markdown and the Diff tab

The chat keeps today's transport: `say` streams AG-UI events, and Stop interrupts the stream.
`chat/src/agui.rs` folds them as TanStack AI's client does: one assistant message a turn, its
parts (text, reasoning, tool calls with their arguments and output) in the order said, and a
`RUN_ERROR` shown under the transcript. Text is drawn by rune-kit's Markdown, streaming while
the turn runs, after `policy::confined` has applied Desktop's markdown policy to its source.
The composer sends a turn and becomes Stop while it runs. A switch picks the code highlighter:
rune-kit's built-in scanners or `chat/src/highlight.rs`, syntect with two-face's grammars.

The Diff tab reads `runDetail` until a record carries the diff, then each file's patch from
`runFile` (`diff:<path>`, paged as Desktop's view does), and parses it with rune-kit's
`diff::parse`. It shows unified or split. Selected lines plus a comment become a draft, and
Compose shows the Delivery text `review-comments.ts` composes (ADR-0051).

**Recordings.** `record-say` asks the spike core's `say` and writes each event as NDJSON. The
fixtures are a plain reply with a table and code, a tool call, a run error (an attachment the
core no longer has), a turn cancelled after five deltas, and two turns. They came from vm-mk
with mk's Claude login.

```sh
cargo run -p collie-desktop-chat --bin record-say -- --out fixtures/chat/say-cancel.ndjson --cancel-after 5 --say 'Use no tools. Write about 400 words on the history of herding dogs.'
cargo run -p collie-desktop-chat --bin record-say -- --out x.ndjson --attach missing-attachment --say 'Read it'
```

**What rune-kit's Markdown cannot hold.** Every case in `desktop/test/markdown.test.ts`,
`review-comments.test.ts` and the AG-UI reducer has a cargo test in `chat/tests/`. Where a
case cannot mean the same:

- **Raw HTML.** rune-kit drops HTML events, so no element can keep a style, a popover or a
  command; the four element cases hold for that reason, not by a filter. An HTML block is
  dropped with its text: `<details><summary>` loses its summary and shows its body open.
- **Components.** comark's `::name{…}` components are literal text, so the "no attribute keeps
  a script URL" case is shown on such text.
- **A diff range with no side.** rune-kit's `LineRef` always has a side, so that case is
  "nothing selected is no anchor".
- **Code over 32 KiB.** rune-kit's `Highlighter` cuts every block to 32 KiB and 8,192 tokens,
  whichever function is plugged in. `syntect` colours a 64 KiB block to its end when called
  directly (`chat/tests/highlight.rs`); in Markdown the rest is plain.
- **Images** draw their alt text.

**Corpus.** 37 agent-written messages from Run artefacts on vm-mk (plans, handoffs, reviews,
MR descriptions), secrets scrubbed, rendered under both highlighters to PNG at 960 by 2400.
They describe internal repositories, so they stay in the Run's evidence, not in this public
repository. What draws otherwise than today (`corpus`):

| Construct         | rune-kit highlighter           | syntect + two-face | Occurrences | Messages |
| ----------------- | ------------------------------ | ------------------ | ----------- | -------- |
| raw HTML          | dropped, block content with it | same               | 13          | 4        |
| image             | its alt text only              | same               | 8           | 2        |
| code `markdown`   | plain                          | coloured           | 2           | 1        |
| code `powershell` | plain                          | plain              | 2           | 2        |
| code `vue`        | plain                          | coloured           | 1           | 1        |

Tables, task lists, the four Mermaid diagrams and the TypeScript, shell and JSON blocks drew.
No message had footnotes, math, GFM alerts or a block over 32 KiB; the largest was 1,332 bytes.

**Highlighter cost.** On vm-mk, release build, best of five, the whole block:

| Highlighter        | Largest corpus block (`ts`, 1,332 B) | 10,000 lines (`ts`, 735,560 B) | Its first 32 KiB |
| ------------------ | ------------------------------------ | ------------------------------ | ---------------- |
| rune-kit built-in  | 0.02 ms                              | 0.60 ms (stops at 32 KiB)      | 0.67 ms          |
| syntect + two-face | 67 ms                                | 25.0 s                         | 1.2 s            |

syntect runs on fancy-regex here (no C dependency); its TypeScript grammar is the slow part.
rune-kit caches each block's colours, but the first draw of a 32 KiB block would hold the view's
thread for about a second. This is evidence for the gate, not a claim of speed.
