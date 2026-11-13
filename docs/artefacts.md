# Inspecting a Run's material

Open **Artefacts** in a Run's record to find its attachments, own plan files, evidence
files, and handoffs. Nested tickets and handoffs appear separately. Plan and Evidence
keep their specialized views and existing references.

Select an item to load its retained revision. Images fit without distortion. Markdown
renders headings, lists, code, and links. Plain text remains selectable and preserves
whitespace. Text previews stop at 256 KiB; **Open** and **Save** provide the complete file.
PDFs, archives, SVG, and other unsupported binary formats have open/save actions.
Loading, empty text, decode failure, and unsupported preview have distinct messages.

Videos play inside the record with play/pause, seek, time, and mute controls. They start
paused. Changing tabs, items, revisions, or records releases playback. The baseline
container and codecs are MP4 with H.264 video and AAC audio. Linux frames are limited
to 4096 by 4096 pixels. Other combinations are unsupported until decoder evidence exists;
browser opening and saving remain fallbacks.

**Unseen** means no receipt for the current revision. **Updated** means an earlier revision
was seen. A selected, loaded native preview can mark its exact revision seen. Video needs
a presented decoded frame. Background reads, tool reads, opening, and saving never mark it.
Use **Mark seen** to acknowledge other formats, or **Mark unseen** to clear the receipt.
If a newer revision arrives during a read, acknowledging the older one leaves the newer one unseen.

Legacy creation dates display **Unknown** beside the known observation date. Source
modification time, registration, and revision detection are separate facts. **Refresh**
observes the source again. Unchanged bytes and date-only changes create no content revision.
A missing or denied source can still have an available retained copy.

## Registering a file

**Register file…** sends a file from this computer; **Register path** names a file on the
Run's own Machine. Agents use `collie_do` `artefact_register`, and the CLI
`collie run artefact register`. Each returns the artefact's address — the owning
installation id, Run, and artefact id — once the host holds a durable copy. A Machine's
label or route is not part of the address, so relabelling it keeps the address valid.

A file on the Run's Machine is **tracked**: its host checks it again about every 30
seconds, with no Desktop open, and keeps a new revision whenever its bytes change, even
when size and modification time do not. Unchanged bytes keep the revision. A file sent
from another computer is a **retained snapshot**: it is copied once, never followed.

The same source path registers one artefact, so a retry or a second request finds it.
Different paths stay different artefacts, even with equal names or bytes. Registration
refuses directories, devices, files over 100 MiB, paths with `..`, and symlinks that
leave their directory. A copy is committed only when two reads and the file's metadata
agree; a file still changing after three tries is refused, and the last retained
revision stays readable with the failure shown.

A tracked source that disappears, loses permission, or grows past the limit keeps its
last revision and shows why under **Source**. An item is **stale** once its last check
is more than 30 seconds old, and **refresh pending** while a check runs. A failing
source is checked less often, up to every five minutes.

Each changed revision is kept for the Run's lifetime, so storage grows with every edit
of a frequently changing file; identical bytes in one Run are stored once. There is no
revision history view yet.

## Retention and refresh

Each background round, every 30 seconds, checks at most eight due sources, two at a
time, continuing after the last one it checked. Explicit **Refresh** waits for its own
bounded attempt. This is a scheduling target; large collections take longer. Finished
Runs keep being tracked. Material is retained on its owning Machine, survives source
deletion, upload cleanup and host restarts, and is removed with its own Run. It is not
replicated backup: losing that Machine's disk loses it.

Native chat, Flock chat, and managed agents can use `collie_artefacts` to list or read
material. Reading never acknowledges it. `collie_do` accepts `artefact_seen` with `run`,
`id`, and the inspected `revision`, `artefact_unseen` with `run` and `id`, and
`artefact_register` with `run` and `path`. Flock chat uses Machine-qualified Run ids; a
`<machine>:<path>` on the Run's Machine is tracked, any other path is sent as a snapshot. CLI commands are in [the CLI reference](cli.md#artefacts).
The terminal board also exposes the catalogue and explicit receipt actions.

Older hosts retain their legacy record views. Catalogue operations explain that an
upgrade is needed when the host does not advertise the capability.

## Evidence by layer

Catalogue membership does not establish [Evidence](../CONTEXT.md), change an Output,
or add attachments to prompts. The implementation's promises are checked at these seams:

| Promise                                                                          | Evidence                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Approved collections, stable ids, immutable bytes, source loss                   | `test/artefacts.test.ts` through public host operations                                        |
| Exact receipts, retry conflicts, concurrent requests, restart, Actor attribution | `test/artefacts.test.ts`                                                                       |
| CLI/chat/Desktop use the selected revision without implicit seen                 | `test/artefacts.test.ts`, `test/chat-parity.test.ts`, `test/flock-tools.test.ts`               |
| Optional/null dates, unknown kinds, extension metadata, revision and error parts | `test/rune-contract.test.ts`, generated-type drift checks                                      |
| Native selection, content presentation, failure states, opening serial fences    | `desktop-rune/board/tests/record_view.rs`                                                      |
| Linux decoder frames, timestamps, AAC stream, controls, teardown and failure     | `video::linux::tests` in `desktop-rune/board/src/video/linux.rs`                               |
| macOS decoder frames, timestamps, AAC stream, controls and failure               | macOS `video::tests` in `desktop-rune/board/src/video.rs`; execution requires the macOS CI job |
| Linux plugin and library closure, scanner and notices                            | `test/rune-media.test.ts`, clean CI dependency installation                                    |
| Registration receipts, duplicate requests and paths, A→B→A tracking              | `test/artefact-registration.test.ts`, `test/artefact-tracking.test.ts`                         |
| Copy races, refused sources, pinned multi-part reads                             | `test/artefact-snapshot.test.ts`                                                               |
| Coalescing, concurrency, timeout, backoff and rotation                           | `test/artefact-refresh.test.ts`                                                                |
| Multi-part transfer to another Machine, restart, original and upload removed     | `test/artefact-peers.test.ts`                                                                  |
| Run and upload cleanup keep each other's copies                                  | `test/artefact-cleanup.test.ts`                                                                |
| CLI, tool and chat registration routes                                           | `test/artefact-frontdoors.test.ts`, `test/flock-tools.test.ts`                                 |
| Native picker, path entry, transfer failure, stale labels, unreachable owner     | `desktop-rune/board/tests/record_view.rs`                                                      |

Live visual, screen-reader, and audible playback observations on Linux and macOS remain
**PENDING** until recorded against an implementation revision. Handler and offscreen
decoder tests do not replace those operator observations. The Run's final `check` proof
is left to CI job `test`.
