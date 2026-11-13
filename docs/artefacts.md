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

Hosts reconcile eight retained Runs per background round, every 30 seconds. This is a
scheduling target; large collections take longer. Material is retained on its owning
Machine, survives source deletion, and is removed with the Run. It is not replicated backup.

Native chat, Flock chat, and managed agents can use `collie_artefacts` to list or read
material. Reading never acknowledges it. `collie_do` accepts `artefact_seen` with `run`,
`id`, and the inspected `revision`, and `artefact_unseen` with `run` and `id`.
Flock chat uses Machine-qualified Run ids. CLI commands are in [the CLI reference](cli.md#artefacts).
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

Live visual, screen-reader, and audible playback observations on Linux and macOS remain
**PENDING** until recorded against an implementation revision. Handler and offscreen
decoder tests do not replace those operator observations. The Run's final `check` proof
is left to CI job `test`.
