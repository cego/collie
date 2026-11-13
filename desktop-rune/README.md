# Collie: the native desktop app

Collie uses a [Rune](https://github.com/anomalyco/rune) shell and the TypeScript
core in `desktop/src/bun/index.ts`, compiled into the release as `collie-core`.
`core/platform.ts` carries Effect RPC over stdio and supplies the core's shell port.
The old Nuxt view and Electrobun UI runtime have been removed. The shell speaks `DesktopRpcs`,
subscribes to `flock`, and draws each Machine and
its cards. Pressing a card opens its Run's record on the Terminal tab, and its Flow strip on the
Flow tab at the Run's active Step. The Terminal tab and a working Step's Terminal part draw the pane
from the `terminal` stream through libghostty-vt, and send what the human does back
on `terminalSend`. The record's other tabs (Flow, Summary, Plan, Review, Diff, Evidence, Log,
Facts, the merge request) read `runDetail` and `runFile`, and its Diff tab shows the Run's diff
in rune-kit's Diff, where selected lines become review comments. The board's Chat button opens
the Flock chat, which streams turns on `say`; toasts stand at the bottom right of the page's pane,
clear of the chat. Each Machine's saved board is drawn as soon as
`flock` sends it, under a line naming the Machines still being reached. A card's menu has Check
output and Attach files. The toolbar shows each Subscription account's Usage, as today's header
does. An `act` that the host refused has no Try again.

| Crate or file                | What it owns                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol/src/generated.rs`  | The Rust types of the RPCs spoken (`flock`, `syncNow`, `terminal`, `terminalSend`, `say`, `runDetail`, `runFile`), generated; never edited by hand                                                                                           |
| `protocol/src/rpc.rs`        | Effect RPC's envelope (Request, Chunk, Exit, Ack, Interrupt) and Desktop's `Hello`, written by hand                                                                                                                                          |
| `protocol/src/client.rs`     | The NDJSON client: requests, streams acked chunk by chunk, interrupts, the core gone                                                                                                                                                         |
| `protocol/src/bin/roundtrip` | Decodes and re-encodes frames through the Rust types, for `test/rune-contract.test.ts`                                                                                                                                                       |
| `board/`                     | The app, and the board in `board/src/board/`: `applyItem`'s whole fold, today's sections and cards, alerts, actions, offers, questions, proposals                                                                                            |
| `board/src/pages/settings/`  | Settings: the Flock's settings, each checked by the core, Record timing, Connections and their tokens, About                                                                                                                                 |
| `board/src/record/`          | An open Run's record: its tabs, the Diff tab and review comments, evidence, acting through `act`                                                                                                                                             |
| `board/src/flow/`            | The Flow map's actions, next move and inspector, ported from Desktop's `flow-actions.ts` and `flow-inspector.ts`                                                                                                                             |
| `protocol/src/core.rs`       | Starts Desktop's main process as the core, for the app and the recorders                                                                                                                                                                     |
| `theme/`                     | Collie's palette over OpenCode's kit for the board and chat: paper and ink surfaces, an iris accent that lightens under the pointer, a hue per state, the official embedded Collie tile, dialogs on the raised surface, an AA and a hue test |
| `chat/`                      | The Flock chat: its state, pane, AG-UI reducer, markdown policy, highlighter and file dialog                                                                                                                                                 |
| `terminal/`                  | Go to pane's terminal: the VT state, a renderer drawn as Ghostty draws, input as `terminal-input` maps it, settled resizes                                                                                                                   |
| `ghostty-sys/`               | Builds libghostty-vt from `vendor/ghostty` with Zig and binds its C API with bindgen                                                                                                                                                         |
| `vendor/ghostty`             | Ghostty, a submodule at one pinned commit                                                                                                                                                                                                    |
| `core/`                      | The native stdio platform adapter imported by the TypeScript core                                                                                                                                                                            |
| `fixtures/`                  | The test Flock and NDJSON transcripts of Effect's own client and server, written by `tools/rune-fixtures.ts`                                                                                                                                 |
| `fixtures/terminal/`         | `terminal` streams recorded by `core/record-terminal.ts`                                                                                                                                                                                     |
| `fixtures/chat/`             | `say` streams recorded by `chat/src/bin/record-say.rs`                                                                                                                                                                                       |

## Commands

The toolchain is pinned in `rust-toolchain.toml`, and Rune at one rev in `Cargo.toml`.

```sh
bun run tools/rune-types.ts --write    # regenerate protocol/src/generated.rs from today's Schemas
bun run tools/rune-types.ts --check    # fail where it differs (test/rune-types.test.ts does this)
bun run tools/rune-fixtures.ts         # rewrite fixtures/ from test/support/rune-fixtures.ts
bun run desktop-rune/scripts/bundle.ts [out]   # the shipped bundle and update archive, in dist/
bun bench/desktop-start/run.ts --rune desktop-rune/dist/build/linux-x64/collie-desktop/bin/launcher   # board_usable_ms, idle_rss_mib

git submodule update --init desktop-rune/vendor/ghostty

cd desktop-rune
cargo test --workspace                 # client against the transcripts, the board, the terminal
cargo run --release -p collie-desktop-terminal --example throughput   # VT bytes per second
cargo run -p collie-desktop-board      # the window, with the live board of this Machine
cargo run -p collie-desktop-board -- --snap board.png --tree board.json   # headless
cargo run -p collie-desktop-board -- --script s.json --frames N --out frames/   # headless input, after the first live board
COLLIE_RUNE_SNAP_AT_START=1 cargo run -p collie-desktop-board -- --script s.json --frames N --out frames/   # the same, from the start
cargo run -p collie-desktop-board --example scenes -- --scene record --snap record.png --theme light   # the test Flock and a record, on a fake core
cargo run -p collie-desktop-chat --bin record-say -- --out x.ndjson --say 'hello'   # record a turn
cargo run -p collie-desktop-chat --bin corpus -- <dir of .md> [--png <dir>]  # the corpus table
cargo run --release -p collie-desktop-chat --example highlight-cost -- <dir of .md>
cargo run -p collie-desktop-board --example read-diff -- <installation> <run>
```

Run `bun install` at the root first. A checkout runs the core under Bun
(`COLLIE_RUNE_BUN` names another); a bundle runs its own compiled core. Collie reuses
stable Desktop's `$XDG_STATE_HOME/collie-desktop` (or `~/.local/state/collie-desktop`)
and its existing `dk.cego.collie.desktop` channel data. Tests must supply an isolated
HOME and state directory. With no GPU,
point Vulkan at lavapipe: `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`. On
Linux, building needs `libxkbcommon-dev` and `libwayland-dev`, and lavapipe is in
`mesa-vulkan-drivers`. Terminal fallback tests also need `fontconfig` and `fonts-noto-cjk`;
the bundled monospace font does not contain CJK glyphs. libghostty-vt needs Zig 0.16.0 (`zig` on `PATH`, or `ZIG` naming it)
and bindgen needs libclang; its first build takes about four minutes. CI's `desktop-rune` job runs `cargo fmt --check`, `cargo clippy -D
warnings`, `cargo test`, and the contract, drift and shell tests.

## Implementation and historical spike notes

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

Selecting a Flow Step gives its detail and work the remaining record height. The map,
details and action forms scroll independently. On a narrow record the details sit above
the work. Resizing the window or Flock chat refits the terminal without reconnecting its pane.

The terminal keeps today's transport: the `terminal` stream brings frames, and `terminalSend`
carries input, resizes, scrolls and mouse presses. Leaving the Terminal tab interrupts the
stream, which has the core send `terminal.release`.

**Go to pane** (`board/src/shell/panes.rs`, `open_terminal` in `record.rs`) asks for the agent at
work under its own Run, as `askedFor` does: an agent of a Run under the card's is found only
there. The pane stays on the agent it opened on while agents start and stop work; picking an
agent or Reconnect opens it again. Until the core says `Opened`, what is typed waits and no
size is sent, since `terminalSend` would reach the terminal shown before. The tab says how far
the pane got: Connecting, Connected, No pane, Not
connected or Disconnected with the core's reason and Reconnect; a stream that ends without a
word says so. Only a live pane draws a cursor. The pane lands at once, with no fade or glide.
While nothing has focus, the window's `on_key` (`shell::on_key`) types into the shown pane, as
stable Desktop's pane takes the keys once Go to pane opens it; Tab still moves focus into the
app, and nothing is typed into a pane under a dialog. `examples/terminal-tab.rs` draws the tab
from a recording in each state (`STATE=connecting|ended|failed|nopane`, snapped with `--at 0.6`
so the recording has arrived), and `TAB=flow` draws it in a Flow Step instead.

**A Step's terminal on Flow** (`step_work`, `step_pane` and `sync_pane` in `record.rs`,
`step_terminal` in `record/view.rs`): a working Step's Terminal part draws its agent's pane
right there, under the same bar as the Terminal tab, at a steady 420 points tall, with Open in
Terminal tab, which keeps the same pane. The part is offered as stable's `StepWork.vue` offers
it: the Machine reached and the card listing the Step's agent. A Step that has finished says
so calmly instead of drawing an empty grid. One pane is held at a time, exactly while one is
shown, on the Terminal tab or in a Step's part: choosing another part, Step, tab or record gives
it back. Choosing another Step opens it on its own part, as stable does. The inline pane takes
keys once it is focused (a click on it); unfocused, Flow's keys stay Flow's. Files pasted or
dropped while it is shown are given to it as on the Terminal tab.

**Files given to the pane** (`board/src/shell/files.rs`): a paste carrying files or an image
(Ctrl+Shift+V, or Ctrl+V while the clipboard holds them), or files dropped on the window
while the pane is shown, are staged as the chat stages its attachments, placed on the pane's
Machine by the core's `placeFiles` through its host's `upload`, and typed as one paste of
their shell-quoted paths there, without Enter. A file that fails is said in the tab's status
and the log, and nothing is typed. Drops on the chat beside it, and pastes into its focused
composer, still go to the chat. See
[ADR-0065](../docs/adr/0065-a-file-given-to-a-pane-is-placed-on-its-machine.md).

**Drawn as Ghostty draws.** The view paints each row into pixels on the CPU and shows it with
`El::pixels`; the cursor is its own image laid over the row. It follows the human's Ghostty
config (`config.rs`: `font-family`, `font-size`, colours, `palette`, `cursor-style`,
`cursor-style-blink`, `faint-opacity`) over Ghostty's own defaults, so with no config it is
JetBrains Mono Nerd Font at 12 pt (embedded, as Ghostty embeds it). Its default foreground
and background are the app's text and surface, which the view sets (`Tab::set_surface`).

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
save through `setSettings`, earlier conversations reopen, the setup offer is answered inline, a
message copies, and the board's card rides on the next message as a chip. Whatever the core
refuses there (a choice, a reopen, the bell, an answer, a setup step, a link) is said in one
dismissible notice over the message box, and Send hands the composer its focus back. The chat
is narrowed to leave the board 480 points (`fit_chat` in `board/src/shell.rs`), and the width
the human chose comes back as the window widens. A card pressed in the chat's own window is
opened by the board's.
`chat/src/log.rs` draws the transcript (a run of finished tool calls folds into one "Used N
tools" line, a reply under way says "Working…" until its words or a waiting call show, and a
log scrolled up offers Jump to latest) and `chat/src/composer.rs` the message box, its choices
as menus in one row with Attach and Send. Each subscription is taken again on its own, as
`retrying` in `desktop/src/shared/retrying.ts` does: one the core ends is taken again at once and
quietly, one that fails is said once, with a countdown, until it answers. A reply whose `say`
stream ends without RUN_FINISHED or RUN_ERROR is over all the same. The header's Pop out moves the chat to its own window
(`chat/src/window.rs`, opened through `App::window`, not while a reply streams), and closing that
window puts it back beside the board. `cargo run -p collie-desktop-chat --example states --
--scene <name> --snap x.png` draws its empty, loading, tools, working, question, error,
reconnecting, popped, queued and long states on no core.

### The app's log

The app keeps its own log in `$XDG_STATE_HOME/collie-desktop/desktop.log` (else
`~/.local/state/collie-desktop/desktop.log`; `COLLIE_RUNE_LOG_DIR` moves it), kept once as
`desktop.log.1` past 1 MiB, as the core keeps `actions.log`. Each line is JSON: `at`, `area`,
`what`, a `reason` and ids, never a message's words, an answer or a file. `board/src/calls.rs`
logs every request and stream that fails, by its RPC, and every stream that ends; the chat logs
a failed turn, a refused choice and each subscription's failure, schedule, retaking and return.
Other areas call `collie_desktop_protocol::log::event(area, what, reason, ids)`.

### An open Run's record

Pressing a card, or `App::go_to_pane`, opens the Run's record and streams `runDetail` until Back;
a later record that leaves a part out keeps the last one, as Desktop's does. Large items (a
plan file, a report, a shot, each file's patch) are read from `runFile`, paged as Desktop's view
does. `board/src/flow/` ports `flow-actions.ts` and `flow-inspector.ts`: the next move, lane and
step actions, notes, questions and proposals are sent through `act` under a request id, and a
refused one says why and offers Try again with the same request. A gesture on a Machine out of
reach is still sent, marked `unsent`, so the host says so. Evidence draws images in place; a
report is confined by Desktop's CSP and opened in the browser from a file through `openLink`,
never drawn (D2 in ADR-0066); a video opens the same way. A
check's output, a kept log or a handoff note opens under its row on a press, Enter or Space,
read from `runFile` the first time, as `EvidenceText.vue` does. A record attaches its Run's pane
only while Terminal is the tab shown, and leaves it as the tab is left.

The Flow tab draws each lane as a map of Step cards that wraps to the record's width, with
`FlowGlyph.vue`'s state marks drawn on a canvas (`board/src/flow/glyph.rs`) and the Step's
inspector beside it once there is room. A Step's open questions are answered one at a time,
"Question k of n", each its own `Answer`. A question the board also has is answered through the
board's questionnaire, as `FlowDecision.vue` does: Hold the Run among its options, words for the
agent instead, a status line, and the next question once the host takes the answer. Its Start asks the Run what it `offers` now and sends
`Invoke` with the inputs typed, as the board's offers dialog does.

The Diff tab reads each file's patch (`diff:<path>`) and parses it with rune-kit's
`diff::parse`: only an open file's, four at a time, so a big file is read once it is opened; a
file the Run has not changed again keeps its patch when the diff is read again, and coming back
to the tab brings back the file read last. A tree beside it folds by folder, filters and goes to a
file; a file ticked Viewed collapses and stays ticked while its patch is unchanged. It shows unified or split. A press on a line
number selects it, a drag or Shift-press extends it, and a comment box opens under the lines,
focused. A press on a line's code dragged over other lines chooses them too, highlighted as it
goes, on the side it began on (as the file is now, unless the line was removed): the Diff tab
finds the line under the pointer by the key rune-kit gives its row (`review::lines_at`). A drag
on the code is about lines, so its text is selected by a double or triple click. A span selected
in the plan opens a box too. Enter or Comment saves a draft, shown under
its lines, where it is edited or removed; Escape, Cancel, leaving the tab or file, or a press
elsewhere with nothing typed closes the box. The drafts are sent as one Delivery, in the text
`review-comments.ts` composes (ADR-0051), and cleared once the host takes it.
`board/tests/record.rs`, `record_view.rs`, `comments.rs`, `evidence.rs` and `questions.rs` drive
this against the fake core;
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
URIs; a pasted image goes to `stage` in parts, with a copy scaled to 2000 points, under a key
from `attachments::transfer_key`, since the core refuses any key but `[\w-]+`. An empty paste
asks `clipboardFiles`, though Rune skips a paste the platform read nothing from, and the
stand-in's `Utils` reads no clipboard, so under Rune it finds none. Attach opens `chat/src/dialog.rs`, which picks several files (the XDG
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
`in_sync.rs`, `cleanup.rs`, `onboard.rs`, Add Machine; its header says how many Machines it
reaches before whether they are In sync), the Workflows page (a Tree of what this computer's
host read, a definition read under a ruled header, its metadata folded), Schedules (each
Machine's in its own section, next and last on this computer's clock, each row's own actions,
Move to…; read again whenever the live Machines change, through an `on_layout` marker keyed by
them), and Usage (one section per Subscription account, ADR-0049; a thread asks again every
minute while the app holds the page, as `useUsage` does). Settings draws each Machine's own as
a table from `flock`'s `OwnRead`s, its controls in one 260 pt column, and Help me write it on
the Standing direction. An onboarding, or Linear's setup job, shows over whichever page is open:
`standing::view` draws its dialog. `clock.rs` reads ISO times and the local zone without a date
crate. `board/src/standing.rs` is the Standing setup's offer, consent dialog and choice.
`board/tests/{machines,schedules,usage,workflows,settings,standing}.rs` drive them through the
fake core. Zoom is not offered: Rune draws at the monitor's own scale and has no app-wide zoom
for the setting to change.

### Scrolling

A scroll runs no view: `chat/src/glide.rs`'s `smooth` makes a notched mouse wheel's steps glide
(`on_wheel` and `scroll_to_with`, `live_only`) while a touchpad still scrolls 1:1, and
`board/src/quiet.rs` holds the core's changes while such a viewport moves and stops building a
closed chat once its close has played. Handlers that hear every scroll frame commit only on a
real change. `board/tests/scroll.rs` and `chat/tests/glide.rs` hold it. rune-kit's Diff keeps
its own viewport, so its rows scroll unsmoothed and a commit can land on them.

### Desktop's marks

The shell takes the marks Desktop's view takes (`desktopTiming`, ticket 01), ported in
`board/src/timing.rs`, and hands each to the core's `recordMark`, which writes it to
`record-timing.log` while Record timing is on. `App::on_frame_drawn` reads the board after
each presented frame: `board-usable` at the first frame with cards; `terminal-key` when a key
was sent to the pane and `terminal-drawn` at the frame after its output; `chat-chunk` when a
live turn's event arrives and `chat-drawn` at the frame that draws it; `frame` for each frame
while the Diff tab's rows move. rune-kit's Diff reports no scrolling, so a move of its rows
stands for one. The log is under the core's own state,
`$XDG_STATE_HOME/collie-desktop/`, and
`bench/desktop-start/run.ts --rune` reads it there; the summariser reads it as it reads
Desktop's.

### Bundle and direct cutover

`bun run desktop-rune/scripts/bundle.ts` builds the only released desktop app.
CI and the release pipeline share `rune-bundle.yml`; required CI includes the
native build, Rust tests and protocol checks.

Linux carries `collie-desktop/bin/{launcher,collie-core}` and `Resources/version.json`.
The installer places it at the existing stable channel's `app/` and keeps the
`collie-desktop.desktop` launcher. macOS carries `collie-desktop.app`, whose displayed
name is Collie, with `Contents/MacOS/{launcher,collie-core}`. Both retain
`dk.cego.collie.desktop`. The legacy filenames preserve automatic update compatibility.

`stable-<os>-<arch>-update.json` and the signed update archive replace the old app
through its existing updater. A native install/uninstall helper from signed release
0.132.2 is retained because the old updater validates it before swapping bundles.
No webview, CEF or Electrobun UI runtime travels with it. Linux Setup and macOS DMG
assets keep the names read by `install-desktop.sh`.

The core checks and verifies updates, stages the tar, signature and requested identity,
then asks the shell to restart. The shell stops its core, re-executes, verifies the
archive again, checks metadata and runnable files, and atomically exchanges bundles.
An installation lock serializes launches; one waiting through an update re-executes
the installed shell too. A refused update leaves the current app in place and is not
retried at each launch.
Mac signing uses the existing Apple release secrets, notarizing and stapling when
credentials are available; `tools/verify-mac-app.sh` verifies built and archived apps.

The cutover decision and verification scope are in
[the ADR](../docs/adr/0067-collie-replaces-the-webview-desktop-in-place.md).

Historical spike Sizes on vm-mk (Linux x64):

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
