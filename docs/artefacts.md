# Inspecting a Run's material

Open **Artefacts** in a Run's record to find its attachments, own plan files, evidence
files, and handoffs. Nested tickets and handoffs appear separately. Plan and Evidence
keep their specialized views and existing references.

Select an item to load its retained revision. Images fit without distortion. Markdown
renders headings, lists, code, and links. Plain text remains selectable and preserves
whitespace. Text previews stop at 256 KiB; **Open** and **Save** provide the complete file.
Registered reports use the complete retained Markdown in the same reader.
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

## Finding material across Runs and Machines

Open **Artefacts** in Desktop's navigation to search retained material, including a Task's
earlier Runs and Runs without current cards. Search titles, descriptions, URLs, and source
paths. File contents are not searched. Filter by Run, kind, role, or **Unseen only**, and
use **Load more** for the next page. Enter in a search field submits the filters.

Each result names its Machine, Run, revision, and last observation. **Open** selects the
exact artefact in its owning Run's record, using the same previews, player, and browser
actions. **Back** returns to the collection. The record's **Refresh** asks that owning
host to observe the source again. Seen receipts live there too; Desktop keeps no private
acknowledgements. A changed revision remains unseen even if an earlier revision was inspected.

Coverage names unreachable Machines, hosts needing an upgrade, and historical Runs still
being indexed. An empty partial result does not establish that no material exists.
**Search** asks again with the current filters. If a Machine becomes unreachable, results
kept from the same earlier search show as saved and stale, with their last observation.
Their seen controls are disabled until the host answers again.

The CLI offers `collie artefacts`; native chat, Flock chat, herdr routes, and managed agents
use `collie_artefacts` with search filters. Results include installation ids, a next-page
cursor, and per-Machine coverage. Use `<installation>:<run>` to keep an address stable
through Machine renaming. `<machine>:<run>` also works. A bare Run id present on multiple
installations is refused with candidates; multiple routes to one installation count once.
These routes inspect and refresh historical results without requiring a current Task card.
The terminal board has no separate collection page.

## Reading an agent's report

Cards keep a narrative within 360 Unicode characters and two sentences, with the current
state, blocker, and next action separate. **Open report** opens the registered Markdown
in the record reader. It supports headings, code, links, text selection, and scrolling.
**Back** returns to the Task. A helper's report opens on its originating Machine, Run,
and Step; the parent keeps a reference rather than another copy.

The healer and investigator can return a registered `report` address alongside `summary`,
`blocker`, and `next_action`. Accepted older Outputs also become reports through the
host's cards journal. Recovery reports preserve every recorded event in an episode,
including earlier attempts. The host still judges recovery from the Run's facts.

Historical preparation reaches retained Runs outside the current board. It reads known
card and recovery journals, leaving original Outputs and evidence unchanged. Source
keys retain report identity across restart; a changed report uses the existing revision
and unseen rules. Unknown original dates remain unknown beside the host observation.

Preparation failures keep **Read recovery detail** available and show the failure with
**Retry report preparation**. A missing or offline owner shows its actual read failure.
**Retry report** retries a failed read; **Retry report owner** reloads its catalogue.
Listing, prefetch, and failed loads never mark a report seen. Only the selected revision
successfully displayed by the native reader records the existing receipt.

CLI, herdr, chat, and agents read reports through the same artefact addresses and operations
as other files. A report uses role `report`, so collection filters can find it.

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
Its original source dates remain unknown unless supplied as caller-reported observations.
The temporary upload's filesystem dates describe the transfer, not the original file.

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

## Registering a link, Claude artefact, or Site

**Register link** in the record, `collie run artefact register <run> --url <url>`, and
`collie_do` `artefact_register` with `url` all register an http or https destination
without fetching it, so registration and opening need no provider login on any Machine.
A Claude artefact uses `--kind claude-artefact --provider claude`, and a Site
`--kind codex-site --provider codex-sites`, each with the `--namespace` (account or
workspace), `--resource` (artefact id or Site project id), and `--version` its tool
returned. A Site known only by its manifest's project id registers without a URL; Collie
never invents a deployed URL or version for it.

The same resource in the same namespace is one artefact: registering it again updates
it, and a new version or destination is a new, unseen revision. The same id in another
namespace is a different artefact. A plain URL is its own identity; `--id` retargets an
existing artefact and keeps its id. A title or description change is no new revision.

The record shows a link's title, its kind and provider, and the destination, with
**Open in browser**. A link has no retained copy, so it is never read as a file. Opening
it in the browser, downloading it, finding it in prose, or reading it with a tool does
not mark it seen; **Mark seen** records the listed revision, and a revision that arrived
meanwhile stays unseen.

`--path` beside `--url` also retains an export of the resource, which Desktop presents
like any file, including inline video. The export is followed separately: editing it
creates a revision of the retained copy but leaves the provider's version and its
observation time alone, so a local edit never claims the hosted resource changed. An
export's preview does not mark the hosted resource seen.

Source dates on a link are **Unknown** unless reported. `--created` and `--updated` take
ISO timestamps with a time zone and are shown as `caller-reported`. A provider version
given at registration is `caller-reported` too. **External updates not tracked** means
nothing has checked the resource since: Collie ships no provider reader. A verified
reader, added later behind `ProviderReaders` in `src/artefacts.ts`, labels what it reads
`provider-verified`, and its dates are never replaced by a caller's report. Its refusals
show as `unsupported`, `auth-expired`, `denied`, `missing`, or `timeout`, and none of them
removes the artefact or its retained export. Automatic discovery or refresh of provider
resources is not part of this release; no Claude publish hook, provider cookie, or
undocumented endpoint is used.

Any other kind works too: a kind of up to 128 letters, digits, and `. _ : / -`, such as
`acme.dev/diagram`, registers with a file or URL and uses the same presentation.
`--metadata` keeps up to 16 KiB of JSON, shown as plain text and never run or rendered as
markup. A description is at most 4 KiB, a title 512 characters, and a URL or path 8 KiB.
An unsafe scheme such as `javascript:` or `file:`, oversized metadata, an unknown kind
spelling, or a malformed date is refused before anything is recorded.

Every managed agent's prompt says how to register a result it should hand a human, for
any Workflow. Registering is recorded as that agent, attaches nothing to later prompts,
and changes neither its Output nor what proves it.

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
`artefact_register` with `run` and a `path` or `url`, plus `artefactKind`, `provider`,
`metadata`, `created`, and `updated` as the CLI takes them. Flock chat uses Machine-qualified Run ids; a
`<machine>:<path>` on the Run's Machine is tracked, any other path is sent as a snapshot. CLI commands are in [the CLI reference](cli.md#artefacts).
The terminal board also exposes the catalogue and explicit receipt actions.

Older hosts retain their legacy record views. Catalogue operations explain that an
upgrade is needed when the host does not advertise the capability.

## Evidence by layer

Catalogue membership does not establish [Evidence](../CONTEXT.md), change an Output,
or add attachments to prompts. The implementation's promises are checked at these seams:

| Promise                                                                                          | Evidence                                                                                                        |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Approved collections, stable ids, immutable bytes, source loss                                   | `test/artefacts.test.ts` through public host operations                                                         |
| Exact receipts, retry conflicts, concurrent requests, restart, Actor attribution                 | `test/artefacts.test.ts`                                                                                        |
| CLI/chat/Desktop use the selected revision without implicit seen                                 | `test/artefacts.test.ts`, `test/chat-parity.test.ts`, `test/flock-tools.test.ts`                                |
| Optional/null dates, unknown kinds, extension metadata, revision and error parts                 | `test/rune-contract.test.ts`, generated-type drift checks                                                       |
| Native selection, content presentation, failure states, opening serial fences                    | `desktop-rune/board/tests/record_view.rs`                                                                       |
| Linux decoder frames, timestamps, AAC stream, controls, teardown and failure                     | `video::linux::tests` in `desktop-rune/board/src/video/linux.rs`                                                |
| macOS decoder frames, timestamps, AAC stream, controls and failure                               | macOS `video::tests` in `desktop-rune/board/src/video.rs`; execution requires the macOS CI job                  |
| Linux plugin and library closure, scanner and notices                                            | `test/rune-media.test.ts`, clean CI dependency installation                                                     |
| Registration receipts, duplicate requests and paths, A→B→A tracking                              | `test/artefact-registration.test.ts`, `test/artefact-tracking.test.ts`                                          |
| Copy races, refused sources, pinned multi-part reads                                             | `test/artefact-snapshot.test.ts`                                                                                |
| Coalescing, concurrency, timeout, backoff and rotation                                           | `test/artefact-refresh.test.ts`                                                                                 |
| Multi-part transfer to another Machine, restart, original and upload removed                     | `test/artefact-peers.test.ts`                                                                                   |
| Run and upload cleanup keep each other's copies                                                  | `test/artefact-cleanup.test.ts`                                                                                 |
| CLI, tool and chat registration routes                                                           | `test/artefact-frontdoors.test.ts`, `test/flock-tools.test.ts`                                                  |
| Native picker, path entry, transfer failure, stale labels, unreachable owner                     | `desktop-rune/board/tests/record_view.rs`                                                                       |
| Links, Claude artefacts, Sites, namespaces, versions, exports, refused input                     | `test/artefact-links.test.ts`                                                                                   |
| Provider reader mapping, null dates, failure states, timeout                                     | `test/artefact-observation.test.ts`, with fake readers; no live provider is claimed                             |
| Native link, Open in browser, export presentation, URL entry, plain metadata                     | `desktop-rune/board/tests/record_view.rs`                                                                       |
| Agent guidance on every step, agent Actor, terminal link lines, Flock chat                       | `test/agents.test.ts`, `test/artefact-links.test.ts`, `test/artefact-lines.test.ts`, `test/flock-tools.test.ts` |
| Historical Runs, restart checkpoints, filters, stable pages, bounded indexing and metadata reads | `test/artefact-search.test.ts`                                                                                  |
| Qualified owner reads, remote refresh, durable receipts across reconnect, omitted Machines       | `test/artefact-peers.test.ts`, `test/flock-tools.test.ts`                                                       |
| Native collection handlers, keyboard and AccessKit controls, stale results, late replies         | `desktop-rune/board/tests/artefacts_page.rs`                                                                    |
| Search cursors, coverage, unknown kinds, stale and null states across Rust                       | `test/rune-contract.test.ts`, `test/rune-types.test.ts`                                                         |

Report evidence also covers these boundaries:

| Behavior                                                                                                                               | Evidence                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted healer Output, parent reference, actual host bytes, concise card, and Markdown reader                                         | `test/heal.test.ts` supplies its public-host fixture to `accepted_producer_fixture` when `COLLIE_REPORT_READER` names the compiled native unit-test binary. |
| Older card narratives, more than 20 recovery episodes, retained Runs, interruption, dates, failed references, and bounded fair retries | `test/narrative-reports.test.ts`                                                                                                                            |
| Investigator reports linked to a parent on another Machine without copying their content                                               | `test/reports.test.ts`                                                                                                                                      |
| Named card controls, full Markdown, back navigation, failure states, and retry                                                         | `desktop-rune/board/tests/narrative_reports.rs`                                                                                                             |
| Exact revision receipts, hidden previews, reopened records, and late callbacks                                                         | `desktop-rune/board/tests/record_view.rs`                                                                                                                   |
| Additive summaries, addresses, helper ownership, and unavailable states                                                                | `test/rune-contract.test.ts`, `test/rune-types.test.ts`                                                                                                     |

Live report readability, keyboard/screen-reader use, and remote-owner opening on Linux
and macOS remain **PENDING** until recorded against the implementation revision.
Live visual, screen-reader, and audible playback observations on Linux and macOS remain
**PENDING** until recorded against an implementation revision. Handler and offscreen
decoder tests do not replace those operator observations. The Run's final `check` proof
is left to CI job `test`.
Live collection opening and refresh between two computers also remain **PENDING**;
the two-host tests establish routing and receipt behavior with controlled hosts.
