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

/** What the front door owes a person, and cannot be settled below the front door. */
const FRONT_DOOR: readonly Check[] = [
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
      file: "test/workspace-tab.test.ts",
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
      file: "test/workspace-tab.test.ts",
      name: "a Run whose work shipped by hand says so, without its status being edited",
    },
  },
];

/** Facts about the code beneath the front door. True, useful, and not front-door proof. */
const BACKEND: readonly Check[] = [
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
      file: "test/baseline.test.ts",
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
