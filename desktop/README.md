Collie Desktop's source (Electrobun, Vue). What it does for a human is
[`docs/using.md`](../docs/using.md#collie-desktop). Desktop has its own `package.json`;
Effect is the root's, so the board's Schemas exist once. It reaches a Machine through
`collie bridge`, never the host client. The main process's behaviour is tested in the
root's `test/desktop-*.test.ts` and `test/flock-*.test.ts`; the view's logic in `desktop/test/`.

## The board and the record

`src/shared/flow-strip.ts`'s `cardFlow` gives BoardCard its glyph groups, fold, label
and accessible name. `FlowGlyph.vue` draws the eight states with Nuxt UI tokens.
`src/shared/flow.ts` owns `selectNode`, `selectEntry`, `inspectorOf`, `openIn`,
`flowKey`, `nodeName` and `flowAnnouncements`. `FlowMap`, `FlowInspector` and
`FlowTab` render those decisions. `recordTabs` puts Flow first where the host sends
one; RunRecord can keep that map while subscribing to an earlier Run of its Task.
`src/shared/flow-actions.ts` maps the host's node and lane capabilities to labels,
icons and existing Desktop routes; `nextMove` and `retryCaption` supply their context.
`useFlowActions` dispatches those routes, and `FlowActions` and `FlowDecision` render
the inspector's controls without deriving capabilities themselves.
`src/shared/step-steering.ts` describes pause marks, unread badges and note lists;
`src/shared/step-timing.ts` supplies elapsed and usual text to the inspector and hover.

`src/shared/step-inspector.ts` scopes log lines and Verifications and chooses the
initial part and available parts. `StepWork` reuses TerminalTab, LogTab and EvidenceTab;
only the visible terminal holds its pane, keyed by Run and agent so a Step of another
agent opens that agent's pane. `src/shared/flow-layout.ts` sizes `FlowWorkspace`'s rail
and context column, stacks them on a narrow record and reads the Focus keys;
`useFlowLayout` keeps the chosen sizes across records. `src/shared/terminal-size.ts`
sends a terminal's size once a resize settles.

| File                                    | What it owns                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/bun/machine.ts`                    | A Machine reached through `collie bridge`; `act` carries out an action, `Deliver` as one `deliver`, word for word (`test/desktop-deliver.test.ts`)                                                                                                     |
| `src/bun/index.ts`                      | The window, and its navigation rule                                                                                                                                                                                                                    |
| `src/shared/`                           | The view's RPC and the Flock it folds                                                                                                                                                                                                                  |
| `view/app/components/RunRecord.vue`     | A card's record, one of the pages `usePage` lays over the board's column, with `SettingsPage.vue`, `MachinesPage.vue`, `UsagePage.vue` and `WorkflowsPage.vue` (the Flock's Workflows and Personas, read with `definitionsIn` in `src/bun/machine.ts`) |
| `src/shared/markdown.ts`                | What agent markdown may keep (`desktop/test/markdown.test.ts`)                                                                                                                                                                                         |
| `src/shared/board-clicks.ts`            | `afterGesture`: what a click, a double-click, a name, a page's back button and Escape do to the selected card and the open page (`test/desktop-view.test.ts`); where a gesture landed (`desktop/test/board-clicks.test.ts`)                            |
| `src/shared/in-sync.ts`                 | Whether a Machine is In sync (`test/desktop-view.test.ts`)                                                                                                                                                                                             |
| `src/shared/flock-settings.ts`          | The Settings rows, shared with each host's settings ([ADR-0043](../docs/adr/0043-a-shared-setting-is-its-latest-edit.md); `test/desktop-settings.test.ts`)                                                                                             |
| `src/shared/usage.ts`                   | The header's Usage entries and the Usage page, one per Subscription account across the live Machines (`test/desktop-usage.test.ts`)                                                                                                                    |
| `src/shared/machine-cleanup.ts`         | The Cleanup dialog's rows: what a sweep would remove on each Machine, or why it can't be cleaned, which are chosen, and each chosen one's sweep and toast (`test/desktop-machine-cleanup.test.ts`, with `cleanupOn` in `src/bun/machine.ts`)           |
| `src/bun/machine.ts`'s `sweepOn`        | Sweeps one chosen Machine: resent under its request only over a renewed connection, 10 minutes in all, and kept in `actions.log` (`test/desktop-machine-sweep.test.ts`)                                                                                |
| `view/app/components/CleanupDialog.vue` | The Cleanup dialog the Machines page's **Clean up…** opens, drawn from it; `useCleanup.ts` reads each Machine's listing on its own whenever it opens with no sweep running, and keeps the sweeps past the dialog                                       |

## Go to pane

[ADR-0044](../docs/adr/0044-go-to-pane-opens-the-pane-in-desktop.md). Desktop draws the pane and
decides nothing from it.

| File                                  | What it owns                                              |
| ------------------------------------- | --------------------------------------------------------- |
| `src/bun/terminal.ts`                 | herdr's terminal controller, run over the Machine's route |
| `view/app/components/TerminalTab.vue` | The pane, drawn                                           |
| `src/shared/terminal-input.ts`        | What the human does, as herdr is told it                  |

## The Flock chat

[ADR-0011](../docs/adr/0011-the-conversation-is-a-native-harness.md#amended-2026-10-05-a-herds-chat-per-home-and-one-flock-chat-per-desktop)
and its [harness amendment](../docs/adr/0011-the-conversation-is-a-native-harness.md#amended-2026-10-09-the-flock-chat-runs-on-the-harness-settings-names).
The message box uses `UChatPrompt`, with the harness, model and effort selects in its wrapping footer. Its header holds the About chip, attachments and file refusals. A model change waits for the next message and keeps the conversation; a harness change waits too, with a notice and Stay to restore the window's last choice. During a reply, another notice names what is answering and what answers next. Stop recovers the queue before closing the human's reply reader. Every window follows the `chatChoices` stream: the account of the harness the conversation is held on, what its session runs on, whether a turn is under way, and what each harness offers. Tested in
`test/flock-chat-pi.test.ts`, `test/flock-chat-endpoint.test.ts`, `test/flock-chat-turns.test.ts`,
`test/desktop-settings.test.ts`, `test/desktop-chat-choices.test.ts`, `test/flock-chat-window.test.ts`,
`test/desktop-claude-models.test.ts`, `test/desktop-pi-models.test.ts`,
`test/desktop-harness-lists.test.ts` and `test/flock-tools.test.ts`.

| File                                | What it owns                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bun/chat.ts`                   | The session, its turns and the conversation                                                                                                                                                                                      |
| `src/bun/driver.ts`                 | The session's driver interface                                                                                                                                                                                                   |
| `src/bun/claude-driver.ts`          | Claude through the Agent SDK                                                                                                                                                                                                     |
| `src/bun/claude.ts`                 | The Agent SDK it runs on, and Collie's tools served to it                                                                                                                                                                        |
| `src/bun/claude-models.ts`          | Claude Code's own model names, descriptions and effort levels, read through an SDK query that sends no message and closes after the read                                                                                         |
| `src/bun/harness-lists.ts`          | The lists kept in memory until Desktop quits; lazy reads shared by every window, their reading and failure states, retries after failure, the first open's 20-second wait, and a list from this computer's host                  |
| `src/bun/pi-driver.ts`              | Pi over RPC                                                                                                                                                                                                                      |
| `src/bun/pi-models.ts`              | Pi's models and per-model thinking levels, read serially by RPC without setup, a session or a package check                                                                                                                      |
| `src/bun/pi-agui.ts`                | Pi events as AG-UI                                                                                                                                                                                                               |
| `src/bun/pi-transcript.ts`          | Pi session files read back                                                                                                                                                                                                       |
| `src/bun/agui.ts`                   | SDK messages as AG-UI                                                                                                                                                                                                            |
| `src/bun/transcript.ts`             | A conversation read back                                                                                                                                                                                                         |
| `src/bun/session.ts`                | What the session runs with                                                                                                                                                                                                       |
| `src/bun/chat-endpoint.ts`          | The authenticated loopback MCP endpoint                                                                                                                                                                                          |
| `src/bun/tool-server.ts`            | Both servers' tools                                                                                                                                                                                                              |
| `src/bun/flock-tools.ts`            | The Toolkit over each Machine's `chat` channel                                                                                                                                                                                   |
| `src/bun/settings.ts`               | Desktop's own switches, the proactive one and the Machine rule among them; the Flock chat's harness, model and effort, checked through `src/harness-choice.ts` as a Run's are, and an effort against the efforts its model lists |
| `src/bun/chat-choices.ts`           | The harness's own list or Collie's table after a failed read, Pi's own configuration read, what the session opens on, and when the `chatChoices` account is told again                                                           |
| `src/shared/chat-choices.ts`        | The resolver of what an unset model and effort run as, the `chatChoices` account's shape, the selects, notices, what Stay restores, what Stop recovers and the live announcements                                                |
| `src/shared/chat-stream.ts`         | The reply reader's lifetime, bound to the chat client's abort signal                                                                                                                                                             |
| `view/app/components/FlockChat.vue` | The message rows and message box, rendering the shared module's choices and notices; keyboard, paste, drop and Stop actions                                                                                                      |
| `src/shared/chat-view.ts`           | What the window says of a tool call, and the card a message is about                                                                                                                                                             |
| `src/shared/chat-width.ts`          | The chat's width beside the board: its least and greatest, a drag, the ← and → nudges and the start width (`test/desktop-chat-width.test.ts`); `useChatWidth.ts` keeps the chosen one as `chatWidth` in Desktop's settings       |

The Toolkit both chats share is the root's `src/toolkit.ts`.

## Attachments

[ADR-0046](../docs/adr/0046-an-attachment-is-uploaded-once-and-belongs-to-the-run.md), tested in
`test/flock-*.test.ts`.

| File                        | What it owns                     |
| --------------------------- | -------------------------------- |
| `src/bun/attachments.ts`    | Desktop's copies                 |
| `src/bun/carried.ts`        | Files carried to a Run's Machine |
| `src/bun/file-tools.ts`     | The chat's file tools            |
| `src/shared/attachments.ts` | What the view shows of them      |

## Writes to a host

Done only on the host's reply, and kept in `actions.log`. Tested in
`test/desktop-confirm.test.ts` and `test/desktop-pending-answer.test.ts`.

| File                           | What it owns                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bun/sent.ts`              | The 30 s wait, 3 tries under one request, and `actions.log`; a Cleanup sweep alone is resent only over a renewed connection, within 10 minutes (`sweepOn`) |
| `src/shared/actions.ts`        | One request per gesture, which **Try again** sends again                                                                                                   |
| `src/shared/pending-answer.ts` | What a card shows of an answer until the board no longer asks                                                                                              |

## Review comments and the Diff tab

[ADR-0051](../docs/adr/0051-a-review-comment-is-written-on-desktops-own-views.md). Desktop never
knows the delivery cap or the paste budget.

| File                                     | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/review-comments.ts`          | Drafts, anchors, whether a line is in a hunk, and the composed message (`desktop/test/review-comments.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/shared/record-terminal.ts`          | `recipients`: who may get them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/shared/diff-view.ts`                | The Diff tab's tree in drawn order with its single-folder chains merged into one row, filtered by a path, the folder rows whose open state is kept, each row's hover text, the row geometry the view draws from, the pane's width clamped to the tab and stepped by ← and →, and the room it leaves a row's name and whether its counts show, each file row's facts, its viewed ticks and their count, whether a file is open and Expand or Collapse all, the file beside the active one, the folders on a path, the file being read, and the height a file holds while it is read (`test/desktop-diff-view.test.ts`) |
| `view/app/composables/useViewedFiles.ts` | Each Run's viewed ticks on its Diff, held in memory per Machine and Run while Desktop runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `view/app/composables/useTreeWidth.ts`   | The Diff tree's chosen width, held in memory and shared by every record while Desktop runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/shared/evidence.ts`                 | The Evidence tab's files sorted (`desktop/test/evidence.test.ts`), and whether it has anything to show (`test/desktop-evidence.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/shared/record.ts`                   | A record's tabs, the one shown, each tab's scroll memory and the Log's place, where a jump lands, its keys, and what its Summary says (`test/desktop-record.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/shared/plan-view.ts`                | The Plan tab's "N of M tickets done" and the spec's headings for its contents (`test/desktop-plan-view.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `view/app/components/DiffFile.vue`       | Each file, drawn with `@pierre/diffs`' `FileDiff`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Scale and Zoom

[ADR-0047](../docs/adr/0047-desktop-draws-at-its-monitors-own-scale.md). Page zoom, never CSS
`zoom`. Tested in `test/desktop-scale.test.ts`.

| File                  | What it owns                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `src/shared/scale.ts` | A window's monitor from `hyprctl -j`, the zoom, and the "Drawn at" line |
| `src/bun/scale.ts`    | Reading the scales and setting each window's page zoom as it moves      |

## macOS

[ADR-0048](../docs/adr/0048-collie-is-released-for-macos-on-apple-silicon.md).

| File                     | What it owns                                   |
| ------------------------ | ---------------------------------------------- |
| `src/bun/login-path.ts`  | Desktop's PATH, from the login shell           |
| `scripts/mac-signing.ts` | Desktop's macOS build: Developer ID, or ad hoc |

Checked by the root's `tools/verify-mac-app.sh`, `test/desktop-mac-signing.test.ts` and
`test/desktop-build-hook.test.ts`; the installer by `test/install-desktop.test.ts`.
