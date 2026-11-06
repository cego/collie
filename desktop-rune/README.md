# desktop-rune: the Rune spike

An experiment, which no release ships. It asks whether a [Rune](https://github.com/anomalyco/rune)
shell can draw Desktop's board with today's main process as its core. The app starts
`desktop/src/bun/index.ts` as a child process. `core/electrobun-stdio.ts` stands in for
`electrobun/bun`, so Desktop's own code is unchanged. It then speaks `DesktopRpcs` to the core
as Effect RPC over NDJSON on the core's stdio, subscribes to `flock`, and draws each Machine and
its cards, read-only.

| Crate or file                | What it owns                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `protocol/src/generated.rs`  | The Rust types of the RPCs spoken (`flock`, `syncNow`), generated; never edited by hand                      |
| `protocol/src/rpc.rs`        | Effect RPC's envelope (Request, Chunk, Exit, Ack, Interrupt) and Desktop's `Hello`, written by hand          |
| `protocol/src/client.rs`     | The NDJSON client: requests, streams acked chunk by chunk, interrupts, the core gone                         |
| `protocol/src/bin/roundtrip` | Decodes and re-encodes frames through the Rust types, for `test/rune-contract.test.ts`                       |
| `board/`                     | The board view and its fold of `flock` items (a narrow copy of `applyItem`), and the app                     |
| `core/`                      | The stdio stand-in for `electrobun/bun`, and the tsconfig that points Desktop's imports at it                |
| `fixtures/`                  | The test Flock and NDJSON transcripts of Effect's own client and server, written by `tools/rune-fixtures.ts` |

## Commands

The toolchain is pinned in `rust-toolchain.toml`, and Rune at one rev in `Cargo.toml`.

```sh
bun run tools/rune-types.ts --write    # regenerate protocol/src/generated.rs from today's Schemas
bun run tools/rune-types.ts --check    # fail where it differs (test/rune-types.test.ts does this)
bun run tools/rune-fixtures.ts         # rewrite fixtures/ from test/support/rune-fixtures.ts

cd desktop-rune
cargo test --workspace                 # client against the transcripts, and the board view
cargo run -p collie-desktop-board      # the window, with the live board of this Machine
cargo run -p collie-desktop-board -- --snap board.png --tree board.json   # headless
```

Run `bun install` at the root first, since the core is Desktop's source run by `bun`
(`COLLIE_RUNE_BUN` names another). The core keeps its state under
`$XDG_STATE_HOME/collie-desktop-rune-spike/`, apart from a Desktop running beside it. With no GPU,
point Vulkan at lavapipe: `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`. On
Linux, building needs `libxkbcommon-dev` and `libwayland-dev`, and lavapipe is in
`mesa-vulkan-drivers`. CI's `desktop-rune` job runs `cargo fmt --check`, `cargo clippy -D
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
  issue: not filed yet. Filing was refused by this Run's permissions, so the draft waits for
  a human. It is in the Run's `handoffs/rune-card-title-issue.md`.
