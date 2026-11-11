# desktop-rune: the Rune spike

An experiment, which no release ships. It asks whether a [Rune](https://github.com/anomalyco/rune)
shell can draw Desktop's board with today's main process as its core. The app starts
`desktop/src/bun/index.ts` as a child process. `core/electrobun-stdio.ts` stands in for
`electrobun/bun`, so Desktop's own code is unchanged. It then speaks `DesktopRpcs` to the core
as Effect RPC over NDJSON on the core's stdio, subscribes to `flock`, and draws each Machine and
its cards. Pressing a card opens its Run's record on the Terminal tab: Rune draws the pane's
terminal from the `terminal` stream, through libghostty-vt, and sends what the human does back
on `terminalSend`. The record's other tabs (Flow, Summary, Plan, Review, Diff, Evidence, Log,
Facts, the merge request) read `runDetail` and `runFile`, and its Diff tab shows the Run's diff
in rune-kit's Diff, where selected lines become review comments. The board's Chat button opens
the Flock chat, which streams turns on `say`. Each Machine's saved board is drawn as soon as
`flock` sends it, under a line naming the Machines still being reached. A card's menu has Check
output and Attach files. The toolbar shows each Subscription account's Usage, as today's header
does. An `act` that the host refused has no Try again.

| Crate or file                | What it owns                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/src/generated.rs`  | The Rust types of the RPCs spoken (`flock`, `syncNow`, `terminal`, `terminalSend`, `say`, `runDetail`, `runFile`), generated; never edited by hand |
| `protocol/src/rpc.rs`        | Effect RPC's envelope (Request, Chunk, Exit, Ack, Interrupt) and Desktop's `Hello`, written by hand                                                |
| `protocol/src/client.rs`     | The NDJSON client: requests, streams acked chunk by chunk, interrupts, the core gone                                                               |
| `protocol/src/bin/roundtrip` | Decodes and re-encodes frames through the Rust types, for `test/rune-contract.test.ts`                                                             |
| `board/`                     | The app, and the board in `board/src/board/`: `applyItem`'s whole fold, today's sections and cards, alerts, actions, offers, questions, proposals |
| `board/src/pages/settings/`  | Settings: the Flock's settings, each checked by the core, Record timing, Connections and their tokens, About                                       |
| `board/src/record/`          | An open Run's record: its tabs, the Diff tab and review comments, evidence, acting through `act`                                                   |
| `board/src/flow/`            | The Flow map's actions, next move and inspector, ported from Desktop's `flow-actions.ts` and `flow-inspector.ts`                                   |
| `protocol/src/core.rs`       | Starts Desktop's main process as the core, for the app and the recorders                                                                           |
| `chat/`                      | The Flock chat: its state, pane, AG-UI reducer, markdown policy, highlighter and file dialog                                                       |
| `terminal/`                  | Go to pane's terminal: the VT state, a renderer drawn as Ghostty draws, input as `terminal-input` maps it, settled resizes                        |
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
bun run desktop-rune/scripts/bundle.ts [out]   # the shipped bundle and update archive, in dist/
bun bench/desktop-start/run.ts --rune desktop-rune/dist/build/linux-x64/collie-desktop/collie-desktop   # board_usable_ms, idle_rss_mib

git submodule update --init desktop-rune/vendor/ghostty

cd desktop-rune
cargo test --workspace                 # client against the transcripts, the board, the terminal
cargo run --release -p collie-desktop-terminal --example throughput   # VT bytes per second
cargo run -p collie-desktop-board      # the window, with the live board of this Machine
cargo run -p collie-desktop-board -- --snap board.png --tree board.json   # headless
cargo run -p collie-desktop-board -- --script s.json --frames N --out frames/   # headless input, after the first live board
COLLIE_RUNE_SNAP_AT_START=1 cargo run -p collie-desktop-board -- --script s.json --frames N --out frames/   # the same, from the start
cargo run -p collie-desktop-chat --bin record-say -- --out x.ndjson --say 'hello'   # record a turn
cargo run -p collie-desktop-chat --bin corpus -- <dir of .md> [--png <dir>]  # the corpus table
cargo run --release -p collie-desktop-chat --example highlight-cost -- <dir of .md>
cargo run -p collie-desktop-board --example read-diff -- <installation> <run>
```

Run `bun install` at the root first, since the core is Desktop's source run by `bun`
(`COLLIE_RUNE_BUN` names another). The core keeps its state under
`$XDG_STATE_HOME/collie-desktop-rune-spike/`, apart from a Desktop running beside it, through
`COLLIE_DESKTOP_STATE_HOME`: what the core starts keeps your `XDG_STATE_HOME`, since herdr reads
its paired Machines from there. With no GPU,
point Vulkan at lavapipe: `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`. On
Linux, building needs `libxkbcommon-dev` and `libwayland-dev`, and lavapipe is in
`mesa-vulkan-drivers`. libghostty-vt needs Zig 0.16.0 (`zig` on `PATH`, or `ZIG` naming it)
and bindgen needs libclang; its first build takes about four minutes. CI's `desktop-rune` job runs `cargo fmt --check`, `cargo clippy -D
warnings`, `cargo test`, and the contract, drift and shell tests.

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
  past the card. The board draws its own card, with the name as body text that wraps
  (`card` in `board/src/board/view.rs`), and the card's accessible label set by hand. Upstream
  issue: not filed, by the human's decision. The draft, with a repro and a suggested fix, is
  in the Run's `handoffs/rune-card-title-issue.md`.

### Go to pane's terminal

The terminal keeps today's transport: the `terminal` stream brings frames, and `terminalSend`
carries input, resizes, scrolls and mouse presses. Leaving the terminal interrupts the stream,
which has the core send `terminal.release`.

**Drawn as Ghostty draws.** The view paints each row into pixels on the CPU and shows it with
`El::pixels`; the cursor is its own image laid over the row. It follows the human's Ghostty
config (`config.rs`: `font-family`, `font-size`, colours, `palette`, `cursor-style`,
`cursor-style-blink`, `faint-opacity`) over Ghostty's own defaults, so with no config it is
JetBrains Mono Nerd Font at 12 pt (embedded, as Ghostty embeds it) on `#282c34`.

- `font.rs`: the cell from the face's metrics as Ghostty's `Metrics.calc` derives it (10 by
  21 px for the default at scale 1, as Ghostty 1.3.1 measures), shaping with ligatures that
  stay in their cells, synthetic bold and italic where a family lacks them, and fallback
  faces from fontconfig sized as Ghostty sizes them (`ic_width`, then ex, cap, line height).
- `sprite.rs`: box drawing, blocks, braille and powerline drawn to the cell, as Ghostty's
  sprite font does, so lines meet across cells.
- `paint.rs`: Ghostty's linear-corrected alpha blending, faint at `faint-opacity`, single,
  double, curly, dotted and dashed underlines in SGR 58's colour, strikethrough, overline,
  inverse, invisible, selection as the cell's colours swapped, colour emoji fitted to their
  cells; block, bar, underline and the hollow block of an unfocused terminal.
- `view.rs`: a row is found by what it shows, so output that scrolls repaints only its new
  rows. The mouse goes to a program that tracks it, every button (left, middle, right,
  back, forward) as its own report, or to herdr's `terminal.mouse`; Shift selects past
  tracking. A drag selects by cell, a double click by word, a triple click by line
  (libghostty's selection), and Ctrl+Shift+C or the platform's copy copies it. Pastes are
  bracketed when asked, focus is reported under mode 1004, a notch scrolls three lines of
  history, a trackpad its travel, and a full-screen program gets arrows (mode 1007). Links,
  OSC 8 or written out, are underlined under the pointer and a click opens them through the
  core's `openLink`.
- The view needs the display scale: call `terminal_at(tab, lens, cx.env().scale)`.
  `examples/replay.rs` draws a fixture headlessly (`FONT=<family>` for another face), and
  `fixtures/terminal/styles.ndjson` holds every attribute and glyph class for comparing with
  Ghostty on the same bytes.

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
The same example times painting: in a debug build, on a shared machine, a whole 200 by 60
screen at scale 2 with every row changed took 15 to 49 ms at p50 over three runs, and the
view as one line scrolls in 11 ms, since only the new row is painted.

**Translated tests.** Every case in `desktop/test/terminal-input.test.ts` and
`test/desktop-terminal-size.test.ts` has a cargo test against the Rust mapping
(`terminal/tests/input.rs`, `size.rs`, `pane.rs`). Where a case cannot mean the same in Rune:

- **xterm.js's own mouse reports.** `isMouseReport` is ported and tested, but Rune never
  types a mouse report, so the view has no use for it.
- **Right button.** Rune reports the secondary button as a press alone, so the pane gets its
  press and release together and a right-button drag is not reported
  (`terminal/tests/mouse.rs`).

The `terminal-ended` alert, the `terminal-where` label and the grid's cursor label stand in
for the screen-reader text xterm.js gives.

### Flock chat and agent markdown

The chat keeps today's transport: `say` streams AG-UI events, and Stop interrupts the stream.
`chat/src/agui.rs` folds them as TanStack AI's client does: one assistant message a turn, its
parts (text, reasoning, tool calls with their arguments and output) in the order said, and a
`RUN_ERROR` shown under the transcript. Text is drawn by rune-kit's Markdown, streaming while
the turn runs, after `policy::confined` has applied Desktop's markdown policy to its source.
Code is coloured by rune-kit's built-in scanners where they know the language, else by
`chat/src/highlight.rs`, syntect with two-face's grammars. Raw HTML keeps its words and a
`<details>` its summary; in the chat a `file:line` is code, as in today's chat.

The chat (`chat/src/chat.rs`, drawn by `chat/src/pane.rs`) reaches the core through the `Host`
trait the app implements, so `board/tests/chat.rs` drives it on the fake core. It reads
`transcript` as it opens and again on `conversationChanges` or the end of Desktop's own turn
once no reply streams; Enter queues while a reply streams and Ctrl+Enter sends now; Stop brings
the queued words back to the composer. Tool rows open to their input and ANSI-coloured output,
the chat's questions are answered in place (`answer`), harness, model (a typed id too) and effort
save through `setSettings` and a refusal is said, earlier conversations reopen, the setup offer
is answered inline, a message copies, and the board's card rides on the next message as a chip.

### An open Run's record

Pressing a card, or `App::go_to_pane`, opens the Run's record and streams `runDetail` until Back;
a later record that leaves a part out keeps the last one, as Desktop's does. Large items (a
plan file, a report, a shot, each file's patch) are read from `runFile`, paged as Desktop's view
does. `board/src/flow/` ports `flow-actions.ts` and `flow-inspector.ts`: the next move, lane and
step actions, notes, questions and proposals are sent through `act` under a request id, and a
refused one says why and offers Try again with the same request. A gesture on a Machine out of
reach is still sent, marked `unsent`, so the host says so. Evidence draws images in place; a
report is confined by Desktop's CSP and opened in the browser from a file through `openLink`,
never drawn (D2 in ADR-draft-collie-desktop-is-drawn-by-rune); a video opens the same way.

The Diff tab reads each file's patch (`diff:<path>`) and parses it with rune-kit's
`diff::parse`. A tree beside it filters and goes to a file; a file ticked Viewed collapses and
stays ticked while its patch is unchanged. It shows unified or split. Selected lines, in the
diff or the plan, plus a comment become a draft; the drafts are sent as one Delivery, in the text
`review-comments.ts` composes (ADR-0051), and cleared once the host takes it.
`board/tests/record.rs` and `board/tests/record_view.rs` drive this against the fake core;
nothing there acts on a live core.

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

**Corpus.** Two corpora of real Run agent messages, each rendered under both highlighters to
PNG at 960 by 2400 (the Run's evidence).

The checked-in one, `fixtures/corpus/`, is 40 pull request descriptions that Collie Runs
wrote for this repository, the same words as each Run's `mr-description.md` or
`pr-description.md`. They are public already, so checking them in discloses nothing new;
`sources.json` names each pull request. `chat/tests/corpus.rs` checks there are at least 30
and that this table is what `corpus` counts over them:

40 messages; largest code block 615 bytes.

| Construct   | rune-kit highlighter           | syntect + two-face | Occurrences | Messages |
| ----------- | ------------------------------ | ------------------ | ----------- | -------- |
| code `text` | plain                          | plain              | 1           | 1        |
| raw HTML    | dropped, block content with it | same               | 41          | 11       |

Most of that HTML is placeholders written outside backticks, such as
`'dial-back to <peer> failed'`: CommonMark reads `<peer>` as an element, and rune-kit draws
"dial-back to failed". Two messages fold their assumptions in `<details>`, which loses its
summary and shows its body open.

The other, 37 messages from Run artefacts on vm-mk (plans, handoffs, reviews, MR descriptions),
secrets scrubbed, describes internal repositories, so it stays in the Run's evidence on the
human's answer. Its count:

| Construct         | rune-kit highlighter           | syntect + two-face | Occurrences | Messages |
| ----------------- | ------------------------------ | ------------------ | ----------- | -------- |
| raw HTML          | dropped, block content with it | same               | 13          | 4        |
| image             | its alt text only              | same               | 8           | 2        |
| code `markdown`   | plain                          | coloured           | 2           | 1        |
| code `powershell` | plain                          | plain              | 2           | 2        |
| code `vue`        | plain                          | coloured           | 1           | 1        |

Across both, tables, task lists, the four Mermaid diagrams and the TypeScript, shell and JSON
blocks drew. No message had footnotes, math, GFM alerts or a block over 32 KiB; the largest was
1,332 bytes.

**Highlighter cost.** On vm-mk, release build, best of five, the whole block:

| Highlighter        | Largest corpus block (`ts`, 1,332 B) | 10,000 lines (`ts`, 735,560 B) | Its first 32 KiB |
| ------------------ | ------------------------------------ | ------------------------------ | ---------------- |
| rune-kit built-in  | 0.02 ms                              | 0.60 ms (stops at 32 KiB)      | 0.67 ms          |
| syntect + two-face | 67 ms                                | 25.0 s                         | 1.2 s            |

syntect runs on fancy-regex here (no C dependency); its TypeScript grammar is the slow part.
rune-kit caches each block's colours, but the first draw of a 32 KiB block would hold the view's
thread for about a second. This is evidence for the gate, not a claim of speed.

### Notifications, files in, scale and accessibility

**Notifications.** The main process still decides when to notify. The stdio stand-in's
`Utils.showNotification` writes a `Notify` line beside Effect's frames, and the client hands
each one to `Client::notices()`. `board/src/notify.rs` posts it: on Linux through
`org.freedesktop.Notifications` on the session bus (zbus), on macOS through rune-mac's
Notification Center, which posts only from a bundled, signed app. A click brings the window
forward, with the activation token the notification server sent where there is one, which
a Wayland compositor asks for before it lets a window take focus. `test/rune-shell.test.ts` checks a notification reaches the Rust
side once; `board/tests/notify.rs` checks it is posted and a click raises the window.

**Files in.** The chat's Attach button, a paste into the composer and a drop on the chat each
call `stagePaths` with the same paths, held to `attachments.ts`'s caps, and what it copies in
rides on the next turn. A paste takes the clipboard's file list, or text that is only `file://`
URIs; a pasted image goes to `stage` in parts, with a copy scaled to 2000 points; an empty paste
asks `clipboardFiles`. Attach opens `chat/src/dialog.rs`, which picks several files (the XDG
portal on Linux, rfd on macOS); the core's own dialog answers nothing under Rune. winit 0.30
reports no file drops on Wayland, so there Attach's help says to attach or paste instead.

**Scale.** Rune draws at `winit::Window::scale_factor()`, read when the window opens and at
every resize or scale change. On a Wayland session the spike is a native Wayland client, and
winit 0.30.13 implements `wp_fractional_scale_v1`, so that is each monitor's own scale,
fractions included. `desktop/src/shared/scale.ts` and ADR-0047's hyprctl correction exist
because Electrobun's CEF is an XWayland client that Hyprland leaves unscaled. Neither applies
here, so the rule is not ported. Each case of `test/desktop-scale.test.ts`:

| Case                                                                           | In the spike                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| on one monitor, Desktop's window is on it                                      | the compositor gives the surface its monitor's scale                              |
| two monitors at different scales                                               | the preferred scale changes as the window moves, and Rune lays out again          |
| an XWayland client Desktop does not know, found by pid                         | no XWayland client to find                                                        |
| no client, or not Hyprland: the scale is unknown and says why                  | any compositor with `wp_fractional_scale_v1` gives it; without it, a whole number |
| zoom = Zoom × monitor scale ÷ rendered scale, 25 % to 400 %                    | the second factor is always 1; Zoom has no Rune API (below)                       |
| Settings says how Desktop is drawn, or why the scale is unknown, or a mismatch | nothing to correct, so nothing to explain; Settings is not ported                 |

Zoom has no counterpart: Rune has no app-level UI scale, and `El::scale` draws larger without
laying out larger. The draft upstream issue is in the Run's handoffs (`rune-platform-issues.md`).

**Accessibility.** `board/tests/a11y.rs` builds the board, the Flow map from
`fixtures/flows.json` (Desktop's Flow test case) and the chat headless, and reads Rune's
AccessKit tree. A card is a button named for its task. A Flow node is a button named as
`nodeName` names it ("Build, running, Slice 4 of 6"), in a group named for its row, in a group
named "Flow". The chat's messages are a log named "Flock chat". The Flow map is one Tab stop,
on the current Step; arrows, Home and End move as `flowKey` does, Enter chooses. The changes
`flowAnnouncements` names are said through a polite live region. `board/src/flow.rs` ports
`flowRows`, `nodeName`, `flowAnnouncements` and `flowKey` for this. In the app, pressing a card reads its Run's
record (`runDetail`) and the Flow map follows that record's Flow, above the pane and on the board
after Back, until another card is pressed. Rune has no
`aria-current`, so the current Step is only drawn differently.

### Machines, Workflows, Schedules, Usage and the Standing setup

`board/src/pages/` ports Desktop's Machines page (`flock.rs` folds `flock` as `applyItem` does,
`in_sync.rs`, `cleanup.rs`, `onboard.rs`, Add Machine and each Machine's own settings), the
Workflows page (a Tree of what this computer's host read), Schedules (one Table, its actions
on the chosen row, Move to…), and Usage (one section per Subscription account, ADR-0049).
`clock.rs` reads ISO times and the local zone without a date crate. `board/src/standing.rs`
is the Standing setup's offer, consent dialog and choice. `board/tests/{machines,schedules,
usage,workflows,standing}.rs` drive them through the fake core.

### Desktop's marks

The shell takes the marks Desktop's view takes (`desktopTiming`, ticket 01), ported in
`board/src/timing.rs`, and hands each to the core's `recordMark`, which writes it to
`record-timing.log` while Record timing is on. `App::on_frame_drawn` reads the board after
each presented frame: `board-usable` at the first frame with cards; `terminal-key` when a key
was sent to the pane and `terminal-drawn` at the frame after its output; `chat-chunk` when a
live turn's event arrives and `chat-drawn` at the frame that draws it; `frame` for each frame
while the Diff tab's rows move. rune-kit's Diff reports no scrolling, so a move of its rows
stands for one. The log is under the core's own state,
`$XDG_STATE_HOME/collie-desktop-rune-spike/state/collie-desktop/`, and
`bench/desktop-start/run.ts --rune` reads it there; the summariser reads it as it reads
Desktop's.

### Packaging, signing and updates

`scripts/bundle.ts` builds what a release would carry, for the platform it runs on: the shell
(`cargo build --release`), Desktop's main process compiled by `bun build --compile` against
the stdio stand-in, an icon and a desktop entry. It writes `dist/build/<os>-<arch>/` and
`dist/artifacts/`, laid out as Desktop's release lays out Electrobun's, so
`tools/verify-mac-app.sh` checks it with only its wording changed. The workflow `rune-bundle.yml` runs it on
Linux and macOS and keeps the artefacts. No release publishes them.

| Platform | Bundle                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| Linux    | `collie-desktop/{collie-desktop, collie-core, collie.png, collie-desktop.desktop, version.json}` |
| macOS    | `Collie.app/Contents/{Info.plist, MacOS/collie-desktop, MacOS/collie-core, Resources/…}`         |

On Linux the window's Wayland `app_id` (X11 `WM_CLASS`) is `dk.cego.collie.desktop.rune`, which the
entry's `StartupWMClass` names, so a desktop shows the window as its own launcher's.

The update archive is `rune-stable-<os>-<arch>-collie-desktop[.app].tar.zst`, beside
`rune-stable-<os>-<arch>-update.json`. The `rune-` prefix and the identifier
`dk.cego.collie.desktop.rune` keep them apart from Electrobun's files in the same release.

**macOS signing.** Inside out, `collie-core`, then the shell, then the app, each with the
hardened runtime and `MAC_ENTITLEMENTS` (now exported by `desktop/scripts/mac-signing.ts`, which
Electrobun's config also reads). With `ELECTROBUN_DEVELOPER_ID` set, it signs with that identity
and a timestamp, and with the Apple ID or API key `macSigning` reads, it notarises with
`notarytool` and staples. Without one it signs ad hoc.

**Updates.** Desktop's `updates.ts` checks, downloads and verifies against `release.pub`
unchanged; the stand-in's `Updater` answers it. Restart to update stages the verified tar
and its `.tar.sig` at `<install>/.update/<bundle>.tar`, where the shell looks at its next
launch. `update/` verifies the signature again (Ed25519, as `src/signing.ts`), unpacks beside
the installed bundle, and swaps the two in one rename (`renameat2` with `RENAME_EXCHANGE` on
Linux, `renamex_np` with `RENAME_SWAP` on macOS), so the bundle's path never stands empty. It then
re-execs itself. A bad or missing signature is refused and the installed bundle keeps running.
The shell does
not relaunch itself after Restart to update; the update lands when Collie next opens.

Sizes on vm-mk (Linux x64):

| What                                   | Bytes       |
| -------------------------------------- | ----------- |
| bundle directory                       | 163,026,969 |
| `collie-core` (`bun build --compile`)  | 113,416,368 |
| shell, as built                        | 49,574,576  |
| shell, stripped                        | 37,810,512  |
| update archive (`.tar.zst`)            | 67,880,526  |
| Electrobun's update archive, for scale | 193,154,969 |
| Electrobun's `Setup.tar.gz`            | 194,472,586 |

On an X11 session the shell loads `libxkbcommon-x11.so` at start (winit through
`xkbcommon-dl`), and panics where it is missing, as on vm-mk under Xvfb. `install-desktop.sh` would
need to check for it.
