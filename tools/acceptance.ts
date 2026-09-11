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
// table says so, and the exit code says so, so "all complete" cannot be claimed over a
// row nobody ran.
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
const OPERATOR = "operator";

/** What the front door owes a person, and cannot be settled below the front door. */
const FRONT_DOOR: readonly Check[] = [
  {
    id: "front-door/composer-visible",
    statement:
      "Opening the Home with nothing selected shows the conversation and a composer, and the empty state says what Collie can be asked.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/board-keys-keep-working",
    statement:
      "With the composer visible but unfocused, board keys still drive the board; one key focuses the composer and Esc gives the board back.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/untargeted-message-is-sent",
    statement:
      "A message typed on the Home with no row selected reaches Collie. In 0.8.0 the Steering key handler returns null for it, so it is silently not sent — the backend never hears the question it is known to answer well.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/selection-is-never-the-implicit-target",
    statement:
      "A global message typed while an old Run happens to be selected is still global: no delivery appears in that Run's ledger.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/selection-does-not-narrow-oversight",
    statement:
      "Selecting a Run adds its turns to the detail; it does not replace the global conversation, and a board filter narrows the view, not what Collie oversees.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/continuity",
    statement:
      "A follow-up question is answered with the earlier turns of the same conversation in context.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/proactive-turn-on-a-meaningful-event",
    statement:
      "A Run halting produces one turn in the conversation naming the Run and the reason, without anyone asking, and re-rendering does not repeat it.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/proactive-proposal-uses-the-existing-authority-path",
    statement:
      "A proposal Collie raises unprompted is admitted by the same `validate` path as a typed one: what the human already granted this Run — automatic correction included — stays granted and may be carried out, and what was never granted still waits for a human. A proactive turn is not blanket confirmation-only, and it grants nothing new.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
  {
    id: "front-door/honest-when-there-is-no-herdr",
    statement:
      "With no herdr or no model, the conversation region says so and the board still works.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
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
      "A Run whose work was delivered by hand stops reading as a plain failure on the board. `run disposition` records the fact and `run show` says it; the board and Live region do not yet, so the stale row a person actually looks at is not fixed.",
    owner: REDESIGN,
    needs: "ui",
    proof: { kind: "none" },
  },
];

/** Facts about the code beneath the front door. True, useful, and not front-door proof. */
const BACKEND: readonly Check[] = [
  {
    id: "backend/untargeted-question-is-answered-and-read-only",
    statement:
      "`operations.steer` with no target answers about the whole flock and cannot become a proposal.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steer.test.ts",
      name: "a question with no target is answered, and cannot be a proposal",
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
    id: "lifecycle/only-a-human-settles-unknown",
    statement: "Only a human reconciles an unknown delivery, and doing so stops it blocking.",
    owner: SHIPPED,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/steering-ledger.test.ts",
      name: "only a human reconciles an unknown, and doing so stops it blocking",
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
      "Recording what became of a Run's work through the CLI leaves `run.json` byte-identical, replays a repeated request id without recording twice, and reads without writing.",
    owner: RETRO,
    needs: "backend",
    proof: {
      kind: "test",
      layer: "backend",
      file: "test/disposition.test.ts",
      name: "the CLI records a disposition and leaves run.json byte-identical",
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
];

export const CHECKS: readonly Check[] = [...FRONT_DOOR, ...BACKEND, ...OPERATOR_CHECKS];

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
  return counts.fail + counts.pending === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
