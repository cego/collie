#!/usr/bin/env bun
// The front-door acceptance gate: what the promised experience has to do, and whether
// anything actually proves it does.
//
//   bun run acceptance [--evidence <file.json>]
//
// 0.8.0 shipped with 1191 green tests and a Home whose composer was hidden behind a
// colon, whose untargeted message was dropped, and whose conversation was a property of
// the selected Run. A full suite said nothing about any of that, because no check named
// the experience. This names it.
//
// **A proof only settles a statement at its own layer.** This is the discipline the whole
// file exists for, and the one it got wrong first: `operations.steer` answering an
// untargeted question is a backend fact, and it is true in 0.8.0 — where the Home's key
// handler drops the same message before the backend ever hears it. A backend test that
// stood in for a front-door promise would reproduce precisely the false confidence this
// gate was built to end. So every check declares the layer that can settle it, every
// proof declares the layer it reaches, and a proof that falls short leaves the row
// `pending` with what it does prove written next to it.
//
// A check with no proof is `pending` with its owner named. `pending` is not `pass`, the
// table says so. Unrecorded manual checks are information, not mandatory sign-off;
// actual test failures still produce a failing exit code.
//
// This gate does not write the feature tests it points at. Rows owned by the workflow
// redesign are proved by that worker's own tests; this file only records which test id
// settles which promise, and refuses to call an unproved promise kept.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * How far a piece of evidence reaches.
 *
 * - `backend` — a service, a journal, a pure function. True of the code under it, and
 *   silent about whether any front door calls that code.
 * - `ui` — the key handler, the state machine or the rendered region a person touches.
 *   Reaches the backend too: a UI path that works has exercised what it calls.
 * - `operator` — what only a person at a terminal can see: a live process, a restart, a
 *   harness's own state. Nothing automated substitutes for it.
 */
export type Layer = "backend" | "ui" | "operator";

export type Proof =
  | {
      readonly kind: "test";
      readonly layer: "backend" | "ui";
      readonly file: string;
      readonly name: string;
    }
  | { readonly kind: "operator"; readonly how: string }
  | { readonly kind: "none" };

export interface Check {
  readonly id: string;
  /** What a user would see. Written so a reviewer can tell pass from fail by reading it. */
  readonly statement: string;
  /** Who delivers the behaviour — not who wrote this row. */
  readonly owner: string;
  /** The layer of evidence that can settle this statement. */
  readonly needs: Layer;
  readonly proof: Proof;
}

/**
 * Owners. A row is only honest if the person who can make it pass is named on it, so a
 * `pending` reads as an integration dependency rather than as a gap in this MR.
 */
const REDESIGN = "collie-workflow-redesign (mk/productive-execution)";
const SHIPPED = "shipped in 0.8.0";
const RETRO = "collie-retro-fixes (this MR)";
const NATIVE = "native-collie-control-panel (this MR)";
const OPERATOR = "operator";
const MODULES = "workflow modules (this MR)";
const LAUNCH = "launch flow places human starts (this MR)";
const RELEASE = "ready to release and checks you can see (this MR)";
const ATTACHMENTS = "files in the Flock chat and its Runs (this MR)";
const IN_APP_TERMINAL = "go to pane opens the pane in Desktop (this MR)";
const MACHINE_RULE = "the Machine rule (this MR)";
const USAGE = "usage readings on every Machine (this MR)";
const ON_A_MAC = "Collie on macOS (this MR)";
const REVIEW_COMMENTS = "review comments in Desktop (this MR)";

/** What the front door owes a person, and cannot be settled below the front door. */
const FRONT_DOOR: readonly Check[] = [
  {
    id: "front-door/a-file-too-large-for-a-message-is-refused",
    statement:
      "The Flock chat's composer refuses a file over 20 MB, or one that takes a message's files over 30 MB, naming the file or the total and the cap.",
    owner: ATTACHMENTS,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/desktop-attachments.test.ts",
      name: "a file over 20 MB, or a message over 30 MB, is refused naming the file or the total and the cap",
    },
  },
  {
    id: "front-door/a-pasted-image-is-attached-and-pasted-text-stays-text",
    statement:
      "Of what is pasted into the Flock chat's composer, an image file becomes an attachment and text stays text.",
    owner: ATTACHMENTS,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/desktop-attachments.test.ts",
      name: "a pasted image file becomes an attachment, and pasted text stays text",
    },
  },
  {
    id: "front-door/a-large-image-is-scaled-for-the-model",
    statement:
      "An image attached in the Flock chat is scaled to 2000 px on its long edge for the model, and never up.",
    owner: ATTACHMENTS,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/desktop-attachments.test.ts",
      name: "an image is scaled to 2000 px on its long edge, and never up",
    },
  },
  {
    id: "front-door/the-tui-summary-lists-what-a-run-was-given",
    statement:
      "The TUI's Summary of a card lists the files the Run was given, each with its path and size.",
    owner: ATTACHMENTS,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/ui/board.test.tsx",
      name: "Summary lists what the Run was given with its path, and nothing for a Run given none",
    },
  },
  {
    id: "front-door/desktop-shows-each-subscriptions-windows-per-machine",
    statement:
      "Desktop shows each Subscription's windows per Machine, each with its percent and reset, and the reading's age and source or its problem.",
    owner: USAGE,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/desktop-usage.test.ts",
      name: "each Subscription's plan and account, each window's meter and reset, and its age and source",
    },
  },
  {
    id: "front-door/desktop-header-warns-at-90-percent",
    statement:
      "Desktop's header names each Subscription's busiest window, amber at 90% and red once it is Exhausted.",
    owner: USAGE,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/desktop-usage.test.ts",
      name: "amber at 90%, red and out when Exhausted, and a model's own window does not count",
    },
  },
  {
    id: "front-door/desktop-shows-what-a-run-was-given",
    statement:
      "Desktop's record of a Run shows each PNG, JPEG, GIF or WebP image it was given as a thumbnail and any other file by name.",
    owner: ATTACHMENTS,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "desktop/test/evidence.test.ts",
      name: "a Run's attached images the view can show are thumbnails, and every other file is by name",
    },
  },
  {
    id: "front-door/a-running-check-says-its-pass-reason-and-timing",
    statement:
      "While Collie runs one of a Run's checks, its card names the check and its pass in words — on the branch, where the branch left the default branch and why, again for a flake, after gate fix N — how long it has run against how long it usually takes, and how many other checks are running, never an agent operation's round.",
    owner: RELEASE,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/board.test.ts",
      name: "a running check never borrows the round of the agent operation before it",
    },
  },
  {
    id: "front-door/a-ready-card-says-it-is-ready",
    statement:
      "A succeeded Run whose merge request is open and whose checks passed at its branch's head leads Waiting on you, and its card says it is ready to release, where, the revision its checks passed at and the next move, naming its live agent.",
    owner: RELEASE,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/board.test.ts",
      name: "a succeeded Run's open merge request is ready only on checks at its branch's head",
    },
  },
  {
    id: "front-door/no-checkout-is-asked-for-from-the-home",
    statement:
      "Starting a Run from the Home asks which Workflow and what you want, and never which checkout: a goal starts at the Projects root with nothing typed about where.",
    owner: LAUNCH,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/launch.test.ts",
      name: "no checkout is asked for from the Home: a goal starts at the Projects root",
    },
  },
  {
    id: "front-door/a-start-from-the-home-is-placed-never-asked-where",
    statement:
      "A start from the Home for a workflow that needs a checkout lands in the checkout under the Projects root your words are about — confirmed with Enter — or offers a plan instead, and never asks which checkout.",
    owner: LAUNCH,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/launch.test.ts",
      name: "a start from the Home is placed, never asked where: one routing call over every checkout, confirmed with Enter",
    },
  },
  {
    id: "front-door/what-was-inferred-is-shown-before-the-start",
    statement:
      "Where anything was inferred, one row says where the Run starts and each Input as given or inferred from what, before anything starts; Enter starts it and Esc starts nothing.",
    owner: LAUNCH,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/launch.test.ts",
      name: "what was inferred is shown before the start, and Esc starts nothing",
    },
  },
  {
    id: "front-door/native-chat-takes-what-is-typed",
    statement:
      "The Home opens as one tab of two panes — the board and a native harness — with chat focused, and what a person types into it is answered. No mode, no composer of Collie's, and a process that started is not an editor that took a keystroke.",
    owner: NATIVE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "`bun run tools/chat-live.ts --harness claude` and `--harness pi`, which make a disposable Herd of their own, type a question into the real pane and wait for the answer to appear on it. Record the rows, both harness versions and the revision. ADR-0011 carries the pass they were accepted on.",
    },
  },
  {
    id: "front-door/chat-carries-out-requested-actions",
    statement:
      "Asked in native chat to do something, Collie carries it out without a second confirmation, records who asked, and reports the actual result. Repeating an already executed request does not execute it again.",
    owner: NATIVE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "`bun run tools/chat-live.ts --harness claude` and `--harness pi`, whose control rows type a request into the real pane, inspect the changed Intent and chat attribution, check that no confirmation is pending, and reject a replay. Record the rows, both harness versions and the revision.",
    },
  },
  {
    id: "front-door/board-keys-keep-working",
    statement:
      "The board has no field of its own to lose its keys to: `:` is not a mode, and every board key means what the footer says it means.",
    owner: NATIVE,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/ui/app.test.tsx",
      name: "there is no composer to find: typing goes to the board, and `:` is not a mode",
    },
  },
  {
    id: "front-door/selection-does-not-narrow-oversight",
    statement:
      "Selecting a Run adds its turns to the detail; it does not replace the global conversation, and a board filter narrows the view, not what Collie oversees.",
    owner: REDESIGN,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/board.test.ts",
      name: "a filter narrows the rows that are drawn and never what is supervised",
    },
  },
  {
    id: "front-door/continuity",
    statement:
      "A follow-up question is answered with the earlier turns of the same conversation in context.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Ask a question about the flock in the Home, then a follow-up that only resolves against the first. Record both turns and the revision. test/steer.test.ts proves the earlier turns reach the pack; only a real answer proves they were used.",
    },
  },
  {
    id: "front-door/proactive-turn-on-a-meaningful-event",
    statement:
      "A Run halting reaches the conversation without anyone asking — pushed into Pi's own queue between turns, or waiting for Claude's next turn where there is no channel to push through — and re-rendering the board does not repeat it or send it again.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Make a Run halt, leave the Home open and touch nothing. Record what reached the conversation, the Run it names, that it arrived once, and — on Claude — that `collie chat status` says delivery waits for the next turn and the board says how many are waiting. test/news.test.ts proves the batching, deduplication and receipts; only a running Home proves one arrives.",
    },
  },
  {
    id: "backend/an-unchanged-herd-costs-nothing",
    statement:
      "A board redrawing over unchanged state produces no events, writes nothing and calls no model — there is no model on that path at all. A burst becomes one bounded batch that says what it left out, and `sent` never settles an item: only the conversation having read it does, and a send nobody can account for stays visibly uncertain.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/news.test.ts",
      name: "submitted is not read, and only reading settles anything",
    },
  },
  {
    id: "front-door/the-board-says-what-is-waiting",
    statement:
      "News Collie has noticed and the conversation has not been told is visible on the board, with sends nobody can account for named separately — so a harness that cannot be pushed to leaves work visibly waiting rather than silently.",
    owner: NATIVE,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/ui/live.test.tsx",
      name: "the board says what Collie noticed and has not told the conversation",
    },
  },
  {
    id: "front-door/proactive-proposal-uses-the-existing-authority-path",
    statement:
      "An unsolicited suggestion uses the same validation as a requested action, but remains pending until requested. Declining leaves the Run untouched. Automatic correction already granted to the Driver continues independently.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Grant a Run an authority, make it halt, and read the unsolicited proposal: it remains a suggestion rather than acting on its own. Record that declining leaves the Run untouched, and that the Driver went on correcting inside the grant while the proposal sat there.",
    },
  },
  {
    id: "front-door/honest-when-there-is-no-harness",
    statement:
      "With the chosen harness missing, the Home still opens on its board, every Run keeps working, and Collie never quietly opens the other harness instead \u2014 and it says which harness is missing and why when it is asked, through `collie chat status` and `collie_installation`.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Take the chosen harness off PATH and open the Home. Record that the board is drawn and its Runs are still there and still driven, that nothing started the other harness, and what `collie chat status` says. The board draws no line of its own about it \u2014 the reason goes to the terminal that started the Home, and to whoever asks \u2014 so record that as what happened rather than as a fail. test/chat.test.ts proves the sentence and the refusal; only an opened Home proves the rest.",
    },
  },
  {
    id: "front-door/conversation-survives-home-restart",
    statement:
      "Killing the Home and starting it again shows the same conversation on screen. The journal round-tripping on disk is necessary and is not this: only a restarted process shows what a restarted process draws.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Open the Home, hold a conversation, kill the Home process, start it again, and read the conversation region. Record what was on screen before and after, and the revision.",
    },
  },
  {
    id: "front-door/disposition-visible-where-the-stale-row-is",
    statement:
      "A Run whose work was delivered by hand stops reading as a plain failure on the board: the row a person actually looks at carries both facts, `failed \u00b7 merged <ref> by <who>`, and the execution status is not edited to tidy it.",
    owner: REDESIGN,
    needs: "ui",
    proof: {
      kind: "test",
      layer: "ui",
      file: "test/board.test.ts",
      name: "a Run whose work shipped by hand says so, without its status being edited",
    },
  },
];

/** Facts about the code beneath the front door. True, useful, and not front-door proof. */
const BACKEND: readonly Check[] = [
  {
    id: "backend/an-agent-that-runs-out-is-replaced-mid-work",
    statement:
      "An agent that runs out mid-work is closed and replaced by one on the next entry, given the same work and a hand-over.",
    owner: USAGE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/agents.test.ts",
      name: "an agent that runs out mid-work is closed and replaced by one on the next entry, given the same work and a hand-over",
    },
  },
  {
    id: "backend/exhausted-work-starts-on-the-first-fallback-with-room",
    statement:
      "A step whose Subscription is Exhausted starts on the first chain entry with room, and its record says why.",
    owner: USAGE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/agents.test.ts",
      name: "work whose Subscription is Exhausted starts on the first chain entry with room, and its record says why",
    },
  },
  {
    id: "backend/an-agent-start-names-everything-or-is-refused",
    statement:
      "An agent starting a Run through chat's start action is refused unless it names the checkout (or projects-root) and every Input, an optional one as an explicit empty string; the refusal names each field it left out, and nothing is inferred for it.",
    owner: LAUNCH,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/proposals.test.ts",
      name: "chat's start names projects-root and every Input, or is told each one it left out",
    },
  },
  {
    id: "backend/every-operation-has-a-conversational-route",
    statement:
      "Every operation a human has through the CLI or the board either has a conversational route that is called in the test, or is named as the human's with the reason — no capability is quietly missing, and none is reduced to advice or to an action this build cannot carry out.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/chat-parity.test.ts",
      name: "every operation a human has, native chat has a route to — or a reason it does not",
    },
  },
  {
    id: "backend/the-parity-inventory-is-the-command-tree",
    statement:
      "The operations parity is measured against are the CLI's own command tree, walked, rather than a list somebody kept up to date — so a command added upstream with no conversational route fails the gate instead of passing unnoticed.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/chat-parity.test.ts",
      name: "the operations are the command tree's, not a list somebody kept up to date",
    },
  },
  {
    id: "backend/chat-executes-requests-with-attribution",
    statement:
      "A requested action executes immediately and is attributed to chat, not mislabeled as a human confirmation. Its recorded execution cannot be replayed.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/tools.test.ts",
      name: "chat carries out a request immediately and records who asked",
    },
  },
  {
    id: "backend/a-read-covers-the-whole-herd",
    statement:
      "What chat may read is the whole Herd, and it says how much it left out. A board filter and a selected row are what a person is looking at, and have never been an input to it.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/tools.test.ts",
      name: "a read covers the whole Herd, whatever a board is filtered to",
    },
  },
  {
    id: "backend/a-steer-names-its-run-or-is-refused",
    statement:
      "Nothing becomes a target by being on screen: a steer names its Run or is refused before anything is spent.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steer.test.ts",
      name: "a steer with no target is refused before anything is spent",
    },
  },
  {
    id: "backend/a-harness-preference-is-not-a-switch",
    statement:
      "Choosing the other harness leaves a running conversation and every worker alone; the next launch uses it, with its own native history and no handoff.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/chat.test.ts",
      name: "a changed preference is the next launch, never a swap",
    },
  },
  {
    id: "backend/a-conversation-is-this-herds-own-session",
    statement:
      "A reopened chat resumes the session Collie recorded for this Herd and harness, never whichever session the harness happened to write last in that directory — and where there is none it says the conversation is new.",
    owner: NATIVE,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/chat.test.ts",
      name: "a conversation is this Herd's session, not whatever ran here last",
    },
  },
  {
    id: "backend/no-target-is-not-guessed",
    statement: "The backend does not guess a target for a message that named none.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steer.test.ts",
      name: "a Run nobody named is not one Collie will guess at",
    },
  },
  {
    id: "backend/conversation-journal-round-trips",
    statement: "The herd conversation journal is what the board reads back after it is closed.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/conversation.test.ts",
      name: "the journal is what the board reads back after it is closed",
    },
  },

  // ── The command lifecycle: what a message has actually done ────────────────────────
  {
    id: "lifecycle/submitted-is-not-acknowledged",
    statement:
      "A message herdr accepted and no turn came of is recorded as submitted with that as its note — not as work done.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/dispatcher.test.ts",
      name: "a submission herdr saw no turn come of is submitted, with that as its note",
    },
  },
  {
    id: "lifecycle/unsettled-is-not-a-guess",
    statement:
      "A reservation nobody settled becomes unknown rather than a guess in either direction.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steering-ledger.test.ts",
      name: "a reservation nobody settled becomes unknown, not a guess in either direction",
    },
  },
  {
    id: "lifecycle/explicit-reconciliation-settles-unknown",
    statement:
      "An explicit reconciliation can settle an unknown delivery from automation, with attribution. A timeout alone cannot settle it.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steering-ledger.test.ts",
      name: "an explicit reconciliation works from automation and stops an unknown blocking",
    },
  },
  {
    id: "lifecycle/no-retry-over-an-unsettled-send",
    statement: "The same work is not sent twice while the first attempt is unsettled.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/dispatcher.test.ts",
      name: "the same work is not sent twice while the first attempt is unsettled",
    },
  },
  {
    id: "lifecycle/collection-settles-only-what-was-sent",
    statement:
      "Collecting a step's work settles only what was known to be sent, never what is in doubt.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/dispatcher.test.ts",
      name: "collecting a step's work settles only what was known sent, never what is in doubt",
    },
  },

  // ── Authority and usage: settled decisions that must not drift back ────────────────
  {
    id: "authority/usage-is-data-not-a-quota",
    statement: "Every model call is counted and costed, and none is refused over the count.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steer.test.ts",
      name: "every call is counted and costed, and none is refused over the count",
    },
  },
  {
    id: "authority/a-dry-run-records-nothing",
    statement: "A dry run prints what Collie would propose and records nothing.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steer.test.ts",
      name: "a dry run prints what it would propose and records nothing",
    },
  },

  // ── Disposition: a Run's execution and what became of its work are separate facts ──
  {
    id: "backend/disposition-never-touches-the-run-record",
    statement:
      "Recording what became of a Run's work through the CLI leaves how the Run ended as it was, replays a repeated request id without recording twice, and reads without writing.",
    owner: RETRO,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/disposition.test.ts",
      name: "the CLI records a disposition and leaves the Run's status as it was",
    },
  },

  {
    id: "desktop/go-to-pane-rides-the-machines-master",
    statement:
      "Go to pane in Desktop starts herdr's terminal controller as one more channel on the SSH master Desktop already holds for the Machine, never a login of its own, and gives the pane back when the terminal closes: going to the pane twice opens no second master.",
    owner: IN_APP_TERMINAL,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/desktop-terminal.test.ts",
      name: "Go to pane on a Machine runs its controller as one more channel on the master Desktop holds, and gives the pane back",
    },
  },

  // ── Attachments: files a Run is given, in its own directory and every prompt ──
  {
    id: "backend/an-upload-reaches-a-machine-once",
    statement:
      "A file sent to a Machine's host arrives once: its parts are checked against its size and sha256, a digest the host holds is answered at the first part, a bad hash leaves nothing, and a start can name the path it answered.",
    owner: ATTACHMENTS,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/host-files.test.ts",
      name: "a file reaches a Machine once through its host's upload, and a start can name the path it answered",
    },
  },
  {
    id: "backend/a-started-runs-attachments-are-there-before-its-first-prompt",
    statement:
      "A Run started with `--attach` has a copy of each file in its own directory before its first agent starts, and that agent's prompt lists each with its absolute path.",
    owner: ATTACHMENTS,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/attachments.test.ts",
      name: "a start's attachments are in the Run's directory and its first prompt before it runs, and on its audit line",
    },
  },
  {
    id: "backend/a-follow-up-inherits-its-runs-attachments",
    statement:
      "A follow-up of a Run that was given files starts with copies of them in its own directory, beside any it was given itself, and its first prompt lists them.",
    owner: ATTACHMENTS,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/attachments.test.ts",
      name: "an offer invoked from a Run with attachments gives the new Run copies of them beside its own",
    },
  },
  {
    id: "backend/a-message-over-the-delivery-cap-arrives-whole",
    statement:
      "A message over the delivery cap arrives whole, as a file in the Run, whichever door sent it.",
    owner: REVIEW_COMMENTS,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/attachments.test.ts",
      name: "a message over the delivery cap is kept whole in the Run, and the agent is told where",
    },
  },
];

/** What a workflow module is promised, whoever wrote it and whatever it is called. */
const WORKFLOWS: readonly Check[] = [
  {
    id: "workflows/no-shipped-workflow-is-privileged",
    statement:
      "Each shipped workflow, saved as a user's entry under an id that shares nothing with it, asks the same questions, starts the same agents in the same tabs, is held to the same evidence and offers the same next steps as it does under its own id — and a fork under another id keeps everything it did not change.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/baseline-unrelated.test.ts",
      name: "under an unrelated id",
    },
  },
  {
    id: "workflows/generic-code-decides-nothing-by-a-workflow-name",
    statement:
      "Nothing in the runtime or the board chooses a checkout, a card, a tab or an offer because a Run's workflow is called plan, implement, review, architecture or renovate. Workflows compose by id; Collie does not dispatch on one.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/workflow-names.test.ts",
      name: "the generic runtime and the board decide nothing by a shipped workflow's name",
    },
  },
  {
    id: "workflows/a-reintroduced-name-classification-fails-the-suite",
    statement:
      "The name-based plan and renovate classification Collie used to have, put back into the file it lived in, fails the suite.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/workflow-names.test.ts",
      name: "the guard catches the name-based plan and renovate classification Collie used to have",
    },
  },
  {
    id: "workflows/a-card-is-its-facts",
    statement:
      'A finished Run that wrote plan tickets reads "Plan ready to implement." whatever its workflow is called, and one called plan that wrote none owes nothing.',
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/board.test.ts",
      name: "landed is a disposition, a merge the forge reports, or work with nothing to land",
    },
  },
  {
    id: "workflows/an-agent-saves-checks-finds-and-runs-a-workflow",
    statement:
      "On an installation with no workflows of its own, a module is written, typechecked with the toolchain Collie provisions, found where it was saved and run — with no system Bun or Node and nothing registered by hand.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/authoring.test.ts",
      name: "an installation with no workflows writes one, checks it, finds it and runs it",
    },
  },
  {
    id: "workflows/two-projects-run-their-own-implementation-of-one-id",
    statement:
      "One host runs two projects' own implementations of the same workflow id at the same time, and neither sees the other's.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/autoload.test.ts",
      name: "two projects run their own implementation of one id at the same time",
    },
  },
  {
    id: "workflows/an-edit-reaches-the-next-run",
    statement:
      "An edited entry, helper or prompt reaches the next Run without a rebuild or a restart, and the Run already going keeps the code it started with.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/autoload.test.ts",
      name: "an edited entry, helper and prompt reach the next run while the one going keeps its own",
    },
  },
  {
    id: "workflows/one-request-is-one-run-through-a-crash",
    statement:
      "A host that dies after it recorded a Run, or after the engine accepted it but before the receipt, starts that Run exactly once when it comes back.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/admission.test.ts",
      name: "a host that dies",
    },
  },
  {
    id: "workflows/unchanged-work-recovers-after-a-restart",
    statement:
      "A module saved outside the checkout runs on the installed binary, and after a restart its completed work is reused rather than done again.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/engine.test.ts",
      name: "a module outside the checkout runs on the binary and a restart reuses its completed work",
    },
  },
  {
    id: "workflows/stop-and-resume-keep-the-work",
    statement:
      "A Run stopped and resumed twice keeps the work it had done, launches nothing again and still completes.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/engine.test.ts",
      name: "two stop and resume cycles keep the run's work and it still completes",
    },
  },
  {
    id: "workflows/the-sdk-and-the-host-share-one-effect",
    statement:
      "The Effect an author's module is typechecked against is the one the host runs it on.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/engine.test.ts",
      name: "the Effect an author's declarations come from is the one the host runs",
    },
  },
  {
    id: "workflows/mcp-over-stdio",
    statement:
      "Collie's MCP server over stdio lists its tools, answers them with their own text, reports errors and exits cleanly at end of input.",
    owner: MODULES,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/mcp.test.ts",
      name: "stdio MCP preserves discovery, tool responses, errors, and shutdown",
    },
  },
];

/** What only a person at a terminal can settle. */
const OPERATOR_CHECKS: readonly Check[] = [
  {
    id: "flock-chat/a-machine-on-an-older-collie-is-told-to-upgrade",
    statement:
      "A Machine whose Collie predates files is told to upgrade when the Flock chat reads a file there or starts work carrying one, and nothing starts there.",
    owner: ATTACHMENTS,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "In Desktop with a Machine on a Collie release before this one, ask the chat to read a file there and to start a plan there with a pasted screenshot; record both answers naming the upgrade, and that no Run started, with the revision.",
    },
  },
  {
    id: "flock-chat/start-a-plan-for-this-carries-the-screenshot",
    statement:
      '"Start a plan for this" with a pasted screenshot starts a Run on vm-mk whose grill prompt names its `attachments/` copy, the agent opens it, and the card\'s drawer shows the thumbnail.',
    owner: ATTACHMENTS,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "In Desktop with vm-mk reached, paste a screenshot and send \"start a plan for this\" naming vm-mk; record the Run's id, the line of its grill prompt that names `runs/<id>/attachments/<name>`, that the agent opened it, and the thumbnail in the card's drawer, with the revision.",
    },
  },
  {
    id: "flock-chat/a-file-copied-in-gnome-files-pastes-as-a-chip",
    statement: "A file copied in GNOME Files and pasted into the Flock chat becomes a chip.",
    owner: ATTACHMENTS,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "In Desktop on GNOME, copy a PDF and a text file in Files, press Ctrl+V in the chat's input, and record the two chips and what the model says of each once sent, with the revision.",
    },
  },
  {
    id: "flock-chat/a-pasted-screenshot-is-seen-and-kept",
    statement:
      "A screenshot pasted with Ctrl+V in the popped-out Flock chat is described correctly by the model, and after a restart the message still shows its thumbnail.",
    owner: ATTACHMENTS,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "In Desktop, pop the chat out, paste a screenshot of something distinctive with Ctrl+V, send it with no words, and record the model's description; quit and start Desktop, reopen the conversation, and record that the message shows the thumbnail, with the revision.",
    },
  },
  {
    id: "desktop/a-flock-chat-start-goes-where-the-machine-rule-says",
    statement:
      'A Flock chat start goes where the Machine rule says: with the rule "frontend work is on the laptop, everything else is on the vm", a review of a frontend merge request lands on Local and a plan for Collie on vm-mk; with vm-mk unreachable, the plan is declined in words and nothing starts on the laptop; and Go to pane on each opens in Desktop with no new SSO approval.',
    owner: MACHINE_RULE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: 'In Desktop with Local and vm-mk connected, save the rule "frontend work is on the laptop, everything else is on the vm" in Settings. Ask the Flock chat to start a review of a frontend merge request and a plan for Collie, and record the Machine each Run landed on. Disconnect vm-mk, ask for the plan again, and record the chat\'s words and that nothing started on Local. Go to pane on each Run, and record that sso.cego.dk asked nothing new. Record the revision.',
    },
  },
  {
    id: "desktop/go-to-pane-shows-the-pane-in-desktop-without-a-new-login",
    statement:
      "Go to pane shows the pane in Desktop without a new login: after the one SSO approval Desktop's connection to a Machine needed, going to a working Run's pane, typing to its agent, closing the drawer and going to the pane again asks sso.cego.dk nothing more, and an open herdr window shows the pane at its own size again once the drawer is closed.",
    owner: IN_APP_TERMINAL,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Against vm-mk: connect Desktop (one SSO approval), Go to pane on a working Run, type to the agent, press Esc (the agent gets it and the drawer stays open) and paste two lines (they arrive as one paste), close the drawer, Go to pane again. Record that sso.cego.dk asked nothing after the first approval, that an open herdr window showed the pane at its own size again once the drawer closed, and the revision.",
    },
  },
  {
    id: "flock-chat/reads-greps-and-edits-a-file-on-a-machine",
    statement:
      "The Flock chat reads, greps and edits a file on vm-mk with no prompt, and its edit is in vm-mk's host log with the chat's voice.",
    owner: ATTACHMENTS,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "In Desktop with vm-mk reached, ask the chat to read a scratch file on vm-mk, grep its directory for a word in it, and change that word; record the three tool rows, the file's new content on vm-mk, and the edit's line in vm-mk's `files/operations.jsonl` with its Actor, with the revision.",
    },
  },
  {
    id: "checks/a-running-checks-output-opens-live-from-the-board",
    statement:
      "While Collie runs a check for a Run, the drawer shows its last lines, and Open check output opens a pane in the Task's workspace that prints the output as it is written and says how the check ended.",
    owner: RELEASE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "With HERDR_PLUGIN_STATE_DIR pointed at a scratch directory and herdr on a disposable Herd, never the live one: start one Run whose one approved check prints for a few seconds, open its card's drawer while the check runs, choose Open check output, and record the pane's workspace, the lines it printed as they came, its closing line, and the revision.",
    },
  },
  {
    id: "steering/a-finished-runs-live-agent-takes-a-delivery",
    statement:
      "A succeeded Run's idle agent, told through chat's `collie_do deliver` to do something more, receives the text with Collie's delivery token and acts on it without asking the human to confirm; the result is `applied`, the ledger has the Delivery, and `run show` still says `succeeded`.",
    owner: RELEASE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "With HERDR_PLUGIN_STATE_DIR pointed at a scratch directory and herdr on a disposable Herd, never the live one: start one Run whose one agent succeeds, deliver one message to that agent through `collie_do`, and record the result, the `collie run deliveries` line, what the agent's pane shows it did, and `run show`'s status, with the revision.",
    },
  },
  {
    id: "lifecycle/goal-activation-observed",
    statement:
      "A `/goal` submitted to an agent is only reported as started once the goal is in force in that agent — its own goal or Stop-hook state names it. Submission, queueing, a suggestion sitting in a composer, and a `working` badge are none of them activation: an agent already working shows `working` for the turn it was already in.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Submit the goal, then read the agent's own state for it — the goal/Stop-hook record naming this goal, not the pane's status. `herdr agent prompt --wait` does not track turns and must not be used as the evidence. Record the pane, the agent-side state that names the goal, and the revision.",
    },
  },
  {
    id: "tasks/a-fresh-start-opens-and-focuses-its-own-workspace",
    statement:
      "Starting a Run from the CLI and starting one from the herdr action each open a workspace of their own in the live sidebar and focus it, rather than leaving the Run in the workspace it was launched from; continuing either Task from the picker lands back in that same workspace and opens no second one.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "In disposable herdr workspaces, start one Task through each front door and record, for each: the workspace id the sidebar shows, that it took focus, and that `collie task list` names it. Then continue each Task and record that no workspace was added.",
    },
  },
  {
    id: "tasks/a-name-is-inferred-from-the-live-sidebar",
    statement:
      "A new task workspace is named `<Project or theme> | <short task title>` without anybody being asked, reusing the project prefix the person already has on their own live workspaces — and does the same for a second project's vocabulary, with no name hard-coded for either.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "With live workspaces carrying one project's prefix, start a Task and record the label it was given. Repeat in a second repository whose live labels carry a different project's prefix, and record that label too.",
    },
  },
  {
    id: "tasks/a-renamed-workspace-tab-or-pane-is-left-alone",
    statement:
      "A workspace, tab or pane a person has renamed is never written again by a Run that goes on working in it.",
    owner: OPERATOR,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Rename the task workspace and one of its tabs by hand while a Run is working, let the Run reach its next step, and record that both names are still the ones typed.",
    },
  },
  {
    id: "usage/a-run-whose-claude-runs-out-finishes-on-codex",
    statement:
      "With `fallbacks` set to `codex`, a Run whose Claude runs out finishes on Codex, and its record says so.",
    owner: USAGE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "Set Fall back to `codex`, start an `implement` with Claude near its limit, and when Claude stops mid-slice record that its pane closed, a Codex agent opened in the Task's workspace with the hand-over at the head of its prompt, the Run's log has the Fallback line, `collie run show` lists both agents, and the Run finishes on Codex.",
    },
  },
  {
    id: "usage/collie-usage-agrees-with-the-harnesses",
    statement:
      "`collie usage` agrees with Claude Code's `/usage` and Codex's `/status`: each window's percent within a few points, and the same reset times.",
    owner: USAGE,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "On a Machine logged in to both, run `collie usage`, then Claude Code's `/usage` and Codex's `/status`, and record each window's percent and reset from all three. Run `collie usage --json` and record each reading's `at` and `source`. test/usage-model.test.ts proves the parsing of recorded answers; only the live endpoints prove they are read the same way.",
    },
  },
  {
    id: "install/tui-installs-on-a-stock-mac",
    statement:
      "On an arm64 Mac with no Homebrew OpenSSL, `git clone … ~/.collie && ~/.collie/setup.sh` installs a runner that starts and passes `codesign --verify`, and `collie onboard` reaches the Linear login.",
    owner: ON_A_MAC,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "On a Mac without Homebrew's OpenSSL, run `git clone https://github.com/cego/collie.git ~/.collie && ~/.collie/setup.sh` from a release carrying this work. Record that `~/.collie/bin/collie --version` runs and is not killed, that `codesign --verify ~/.collie/bin/collie` passes, and that `collie onboard --skip helle` reaches the Linear login and prints its URL. Record the revision.",
    },
  },
  {
    id: "install/desktop-on-a-mac-finds-herdr-from-the-dock",
    statement:
      "Collie Desktop opened from the Dock finds `herdr`, `collie`, `claude`, `git` and `ssh` as the user's terminal does, so Local and a VM added as a herdr machine are on its board.",
    owner: ON_A_MAC,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "On a Mac whose shell adds `~/.local/bin` and Homebrew to PATH in `.zshrc` or `.zprofile`, open Collie Desktop from the Dock, not from a terminal. Record that Local is on the board, and with a VM added by `herdr machine add`, that the VM is too. Record the revision.",
    },
  },
  {
    id: "install/desktop-installs-and-opens-on-a-mac",
    statement:
      "On an arm64 Mac, `curl -fsSL …/install-desktop.sh | sh` puts Collie Desktop in `~/Applications`, and it opens from Spotlight with no Gatekeeper prompt and Local on its board.",
    owner: ON_A_MAC,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "On an arm64 Mac, run `curl -fsSL https://github.com/cego/collie/releases/latest/download/install-desktop.sh | sh` from a release carrying this work. Record that `~/Applications/collie-desktop.app` is there, that it opens from Spotlight with no Gatekeeper prompt, that Local is on the board, and with a VM added by `herdr machine add`, that the VM is listed as a second Machine. Record the revision.",
    },
  },
  {
    id: "install/desktop-on-a-mac-updates-itself",
    statement:
      "Collie Desktop on a Mac finds the next release, says it is ready once its tar verifies, and Restart Desktop comes back on the new version.",
    owner: ON_A_MAC,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "With Desktop installed on a Mac by `install-desktop.sh`, wait for the next release. Record that Settings → About says the update is ready, that **Restart Desktop** comes back, and that Settings then shows the new version. Record both revisions.",
    },
  },
  {
    id: "install/old-herdr-is-explained-and-left-running",
    statement:
      "With a herdr older than Collie's minimum, `setup.sh` finishes everything it can, `collie doctor` says what upgrading will do to the running panes and when, and the herdr server and its panes are left running.",
    owner: ON_A_MAC,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "On a Mac still on herdr 0.7.1, with something running in a pane, run `~/.collie/setup.sh` and record that it finished, doctor's herdr line with the before-0.9.0 advice, and that the pane is still running. Run `herdr update` on its own and record whether 0.7.1's updater stopped the server by itself; if it did, doctor's wording is corrected. When nothing is running, run `herdr server stop`, then `herdr`, then `collie doctor`, and record that the herdr lines pass. Record the revision.",
    },
  },
  {
    id: "workflows/a-bodil-run-brings-its-instance-up-and-down",
    statement:
      "A bodil Run brings its instance up, has implement work in bodil's own worktree on bodil's branch and open its merge request from there, and takes the instance down once implement has settled, leaving the worktree.",
    owner: ON_A_MAC,
    needs: "operator",
    proof: {
      kind: "operator",
      how: "On a Mac with bodil installed and BODIL_REMOTE_VM set, save the module from docs/sdk.md as `~/.collie/user/workflows/bodil.workflow.ts` and record that `collie workflow show bodil` lists plan, brands and name. Run `collie run start bodil --input plan=<a small plan> --input brands=happytiger --input name=collie-try`; record that `bodil ls` shows collie-try, that the implementer's pane works in `~/work/gitte/worktrees/collie-try/monorepo` on `dabo/collie-try`, and the merge request's source branch. When the Run finishes, record that `bodil ls` no longer lists collie-try and the worktree is still there. Record the revision.",
    },
  },
];

export const CHECKS: readonly Check[] = [
  ...FRONT_DOOR,
  ...BACKEND,
  ...WORKFLOWS,
  ...OPERATOR_CHECKS,
];

export type State = "pass" | "fail" | "pending";

/**
 * What `bun test` said. An exit code alone cannot tell a failing assertion from a test
 * that does not exist yet, and those are opposite facts: one is a broken promise, the
 * other is a promise nobody has written down. So the output decides.
 */
export function classify(exitCode: number, output: string): State {
  if (/matched 0 tests|note: Tests need|had no matches/.test(output)) return "pending";
  if (exitCode !== 0) return "fail";
  return /\b[1-9]\d* pass\b/.test(output) ? "pass" : "pending";
}

/** Whether a proof reaches as far as the statement it is offered for. */
export function reaches(needs: Layer, proof: Proof): boolean {
  if (proof.kind === "none") return false;
  if (proof.kind === "operator") return needs === "operator";
  if (needs === "operator") return false;
  return proof.layer === "ui" || needs === "backend";
}

export interface Recorded {
  readonly result: string;
  readonly revision: string;
  readonly by?: string;
  readonly note?: string;
}

/** The tree the gate is judging, as git describes it. */
export interface Tree {
  /** `null` when git could not be asked, or answered with something that is not a sha. */
  readonly revision: string | null;
  /** `null` when git could not be asked; otherwise whether anything is uncommitted. */
  readonly dirty: boolean | null;
}

/**
 * An operator result is evidence about one exact tree, and the only tree anyone can name
 * exactly is a clean one at a resolved revision. A dirty tree has no identity: the sha
 * says one thing and the files say another, and yesterday's observation cannot be known
 * to hold over an edit made since. An unresolved HEAD has no identity at all. Both make
 * every operator row pending, because the alternative is a recorded pass being honoured
 * against source nobody can identify.
 */
export function fromEvidence(
  recorded: Recorded | undefined,
  tree: Tree,
): { readonly state: State; readonly note: string } {
  if (tree.revision === null || tree.dirty === null) {
    return { state: "pending", note: "revision unresolved; operator evidence cannot be placed" };
  }
  if (tree.dirty) {
    return { state: "pending", note: "working tree dirty; operator evidence cannot be placed" };
  }
  if (recorded === undefined) return { state: "pending", note: "not run" };
  if (recorded.revision !== tree.revision) {
    return { state: "pending", note: `recorded at ${recorded.revision.slice(0, 8)}, stale here` };
  }
  const state = recorded.result === "pass" ? "pass" : "fail";
  return { state, note: recorded.by === undefined ? "recorded" : `recorded by ${recorded.by}` };
}

/**
 * Evidence a person wrote by hand, checked before any of it is believed. A file that does
 * not say what it means is not weaker evidence, it is a mistake in the thing that decides
 * whether a release may claim it was checked — so it stops the gate and says which key is
 * wrong, rather than being quietly skipped into `pending`.
 */
export function validateEvidence(parsed: unknown): string[] {
  const problems: string[] = [];
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return ["the evidence file must be a JSON object keyed by check id"];
  }
  const ids = new Set(CHECKS.map((check) => check.id));
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ids.has(id)) problems.push(`${id}: not a check in this registry`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${id}: must be an object`);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record["result"] !== "pass" && record["result"] !== "fail") {
      problems.push(`${id}: "result" must be "pass" or "fail"`);
    }
    if (typeof record["revision"] !== "string" || !/^[0-9a-f]{40}$/.test(record["revision"])) {
      problems.push(`${id}: "revision" must be a full 40-character commit sha`);
    }
    for (const key of ["by", "note"]) {
      if (record[key] !== undefined && typeof record[key] !== "string") {
        problems.push(`${id}: "${key}" must be a string when present`);
      }
    }
  }
  return problems;
}

function describe(proof: Proof): string {
  if (proof.kind === "none") return "no proof registered";
  if (proof.kind === "operator") return "operator observation";
  return `${proof.layer} test ${proof.file}`;
}

function run(check: Check, evidence: Record<string, Recorded>, tree: Tree) {
  if (!reaches(check.needs, check.proof)) {
    return {
      state: "pending" as State,
      note:
        check.proof.kind === "none"
          ? `no ${check.needs} proof registered`
          : `${describe(check.proof)} only; the ${check.needs} path is unproved`,
    };
  }
  if (check.proof.kind === "operator") return fromEvidence(evidence[check.id], tree);
  if (check.proof.kind === "none") return { state: "pending" as State, note: "no proof" };
  const { file, name, layer } = check.proof;
  const result = spawnSync("bun", ["test", `./${file}`, "-t", name], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const state = classify(result.status ?? 1, output);
  return {
    state,
    note: state === "pending" ? `no test "${name}" in ${file}` : `${layer}: ${file}`,
  };
}

const MARK: Record<State, string> = { pass: "PASS", fail: "FAIL", pending: "PENDING" };

export const acceptanceExitCode = (counts: Record<State, number>): number =>
  counts.fail > 0 ? 1 : 0;

/** What git says about the tree, and `null` for anything it would not answer plainly. */
export function readTree(): Tree {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const revision = (head.stdout ?? "").trim();
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return {
    revision: head.status === 0 && /^[0-9a-f]{40}$/.test(revision) ? revision : null,
    dirty: status.status === 0 ? (status.stdout ?? "").trim() !== "" : null,
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const at = args.indexOf("--evidence");
  let evidence: Record<string, Recorded> = {};
  if (at !== -1) {
    const path = args[at + 1];
    if (path === undefined) {
      console.error("--evidence needs a file");
      return 2;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (problem) {
      console.error(`${path} could not be read as JSON: ${String(problem)}`);
      return 2;
    }
    const problems = validateEvidence(parsed);
    if (problems.length > 0) {
      console.error(`${path} is not valid evidence:\n${problems.map((p) => `  ${p}`).join("\n")}`);
      return 2;
    }
    evidence = parsed as Record<string, Recorded>;
  }

  const tree = readTree();
  const rows: string[] = [];
  const counts: Record<State, number> = { pass: 0, fail: 0, pending: 0 };
  for (const check of CHECKS) {
    const { state, note } = run(check, evidence, tree);
    counts[state] += 1;
    rows.push(`| ${check.id} | ${MARK[state]} | ${check.needs} | ${check.owner} | ${note} |`);
  }

  const at_ =
    tree.revision === null
      ? "an unresolved revision"
      : `${tree.revision.slice(0, 8)}${tree.dirty === false ? "" : " (working tree dirty or unreadable)"}`;

  console.log(
    [
      "",
      `# Front-door acceptance at ${at_}`,
      "",
      "| check | state | needs | owner | evidence |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      `${counts.pass} pass, ${counts.fail} fail, ${counts.pending} pending of ${CHECKS.length}.`,
      counts.fail + counts.pending === 0
        ? "Every promise on this list is proved at this revision."
        : "Not every promise on this list is proved. A pending row is not a passing row.",
      "",
    ].join("\n"),
  );
  return acceptanceExitCode(counts);
}

if (import.meta.main) process.exitCode = main();
