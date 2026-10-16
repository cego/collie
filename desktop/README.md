Collie Desktop's source (Electrobun, Vue). What it does for a human is
[`docs/using.md`](../docs/using.md#collie-desktop). Desktop has its own `package.json`;
Effect is the root's, so the board's Schemas exist once. It reaches a Machine through
`collie bridge`, never the host client. The main process's behaviour is tested in the
root's `test/desktop-*.test.ts` and `test/flock-*.test.ts`; the view's logic in `desktop/test/`.

## The board and the record

| File                                | What it owns                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bun/machine.ts`                | A Machine reached through `collie bridge`; `act` carries out an action, `Deliver` as one `deliver`, word for word (`test/desktop-deliver.test.ts`)                                                                                    |
| `src/bun/index.ts`                  | The window, and its navigation rule                                                                                                                                                                                                   |
| `src/shared/`                       | The view's RPC and the Flock it folds                                                                                                                                                                                                 |
| `view/app/components/RunRecord.vue` | A card's record, one of the pages `usePage` lays over the board's column, with `SettingsPage.vue`, `MachinesPage.vue` and `WorkflowsPage.vue` (the Flock's Workflows and Personas, read with `definitionsIn` in `src/bun/machine.ts`) |
| `src/shared/markdown.ts`            | What agent markdown may keep (`desktop/test/markdown.test.ts`)                                                                                                                                                                        |
| `src/shared/board-clicks.ts`        | `afterGesture`: what a click, a double-click, a name, a page's back button and Escape do to the selected card and the open page (`test/desktop-view.test.ts`); where a gesture landed (`desktop/test/board-clicks.test.ts`)           |
| `src/shared/in-sync.ts`             | Whether a Machine is In sync (`test/desktop-view.test.ts`)                                                                                                                                                                            |
| `src/shared/flock-settings.ts`      | The Settings rows, shared with each host's settings ([ADR-0043](../docs/adr/0043-a-shared-setting-is-its-latest-edit.md); `test/desktop-settings.test.ts`)                                                                            |
| `src/shared/usage.ts`               | The header's Usage entries and a Machine's Usage block (`test/desktop-usage.test.ts`)                                                                                                                                                 |

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
A model change waits for the current turn and keeps the conversation. Tested in
`test/flock-chat-pi.test.ts`, `test/flock-chat-endpoint.test.ts`, `test/flock-chat-turns.test.ts`,
`test/desktop-settings.test.ts` and `test/flock-tools.test.ts`.

| File                       | What it owns                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bun/chat.ts`          | The session, its turns and the conversation                                                                                                  |
| `src/bun/driver.ts`        | The session's driver interface                                                                                                               |
| `src/bun/claude-driver.ts` | Claude through the Agent SDK                                                                                                                 |
| `src/bun/claude.ts`        | The Agent SDK it runs on, and Collie's tools served to it                                                                                    |
| `src/bun/pi-driver.ts`     | Pi over RPC                                                                                                                                  |
| `src/bun/pi-agui.ts`       | Pi events as AG-UI                                                                                                                           |
| `src/bun/pi-transcript.ts` | Pi session files read back                                                                                                                   |
| `src/bun/agui.ts`          | SDK messages as AG-UI                                                                                                                        |
| `src/bun/transcript.ts`    | A conversation read back                                                                                                                     |
| `src/bun/session.ts`       | What the session runs with                                                                                                                   |
| `src/bun/chat-endpoint.ts` | The authenticated loopback MCP endpoint                                                                                                      |
| `src/bun/tool-server.ts`   | Both servers' tools                                                                                                                          |
| `src/bun/flock-tools.ts`   | The Toolkit over each Machine's `chat` channel                                                                                               |
| `src/bun/settings.ts`      | Desktop's own switches, the proactive one and the Machine rule among them; model checks through `src/harness-choice.ts`, the same as a Run's |
| `src/shared/chat-view.ts`  | What the window says of a tool call, and the card a message is about                                                                         |

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

| File                           | What it owns                                                  |
| ------------------------------ | ------------------------------------------------------------- |
| `src/bun/sent.ts`              | The 30 s wait, 3 tries under one request, and `actions.log`   |
| `src/shared/actions.ts`        | One request per gesture, which **Try again** sends again      |
| `src/shared/pending-answer.ts` | What a card shows of an answer until the board no longer asks |

## Review comments and the Diff tab

[ADR-0051](../docs/adr/0051-a-review-comment-is-written-on-desktops-own-views.md). Desktop never
knows the delivery cap or the paste budget.

| File                               | What it owns                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/shared/review-comments.ts`    | Drafts, anchors, whether a line is in a hunk, and the composed message (`desktop/test/review-comments.test.ts`) |
| `src/shared/record-terminal.ts`    | `recipients`: who may get them                                                                                  |
| `view/app/components/DiffFile.vue` | Each file, drawn with `@pierre/diffs`' `FileDiff`                                                               |

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
