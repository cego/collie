// What a Run has to prove before it may say it is done, and what counts as proof.
//
// One table, one pure function. The point is that "done" means something different for a
// feature and for an investigation, and that neither is decided by an agent writing
// `"verdict": "clean"`. Evidence here is a collected Verification (`verify.ts`) bound to
// the tree it ran on; an Output field is a claim, and is only ever asked for where a claim
// is the honest answer — a conclusion, a list of what was built, a reviewer's judgement.
//
// Nothing in here reads a file or runs a command. The caller collects the evidence and
// this says what is missing.

import type { VerifySpec } from "./verify-spec";
import type { Snapshot, Verification } from "./verify";
import { isString, isBoolean } from "./schema";
import { isYamlMap, type YamlValue } from "./yaml";

/**
 * The kinds of result a Run can be for. `unspecified` is the default and is deliberately
 * not `feature`: a Run nobody classified must not be made to produce a feature's evidence,
 * because documentation, an investigation and a bug fix are not features and the tickets
 * they would be judged against do not exist. It proves the approved set and no more.
 */
export const KINDS = [
  "unspecified",
  "feature",
  "bug",
  "refactor",
  "investigation",
  "docs",
  "migration",
  "review",
  "plan",
] as const;
export type Outcome = (typeof KINDS)[number];

/** The kinds a human may ask an `implement` Run for. `review` and `plan` are fixed. */
export const REQUESTABLE: ReadonlyArray<string> = [
  "feature",
  "bug",
  "refactor",
  "investigation",
  "docs",
  "migration",
];

export function isOutcome(value: string): value is Outcome {
  // SAFETY: widening a readonly tuple of string literals to its element type, so that a
  // plain string can be tested against it. Nothing is narrowed by the assertion itself.
  const known: ReadonlyArray<string> = KINDS;
  return known.includes(value);
}

/** What the caller has collected, for the table below to judge. */
export interface Collected {
  /** Every verification this Run recorded, oldest first. */
  readonly verifications: ReadonlyArray<Verification>;
  /** The tree as it is now. A result bound to any other tree is history. */
  readonly final: Snapshot;
  /** What Collie was allowed to run itself for this Run. */
  readonly approved: ReadonlyArray<VerifySpec>;
  /** Step Outputs, by step id, as they were parsed. */
  readonly outputs: ReadonlyMap<string, YamlValue>;
  /**
   * The step ids whose Output is a reviewer's judgement rather than the implementer's
   * claim: the synthesis, or the one reviewer that stood alone. A field only a reviewer
   * can honestly give is read from these and nowhere else — read from any Output, the
   * agent that wrote the change could vouch for it, which is the thing being prevented.
   */
  readonly reviewed: ReadonlySet<string>;
  /** Whether a reference points inside this Run's own directory or checkout. */
  readonly insideRun: (ref: string) => boolean;
  /** The plan's tickets and the verification names each promised, for a feature. */
  readonly tickets: ReadonlyArray<{
    readonly file: string;
    readonly checks: ReadonlyArray<string>;
  }>;
}

/** A verification that passed on the tree in front of us, not on one that has moved. */
function passedAtFinal(got: Collected, name: string): boolean {
  return got.verifications.some(
    (v) =>
      v.name === name &&
      v.result === "pass" &&
      v.by === "collie" &&
      v.end.head_sha === got.final.head_sha &&
      v.end.fingerprint === got.final.fingerprint,
  );
}

/** The same, for a verification an agent was allowed to collect (docs commands, checks). */
function anyPassAtFinal(got: Collected, name: string): boolean {
  return got.verifications.some(
    (v) =>
      v.name === name &&
      v.result === "pass" &&
      v.end.head_sha === got.final.head_sha &&
      v.end.fingerprint === got.final.fingerprint,
  );
}

/**
 * Every approved command, passing, on this exact tree. A Run with nothing approved is
 * reported rather than passed: an empty set would make this gate say yes to anything, and
 * "nobody wrote down what proves this" is the useful thing to tell a human.
 */
function approvedSetGaps(got: Collected): string[] {
  if (got.approved.length === 0) {
    return [
      "nothing is approved for Collie to run, so no command can prove this Run: add .herdr/verify.json",
    ];
  }
  const gaps: string[] = [];
  for (const spec of got.approved) {
    if (passedAtFinal(got, spec.name)) continue;
    const any = got.verifications.filter((v) => v.name === spec.name);
    if (any.length === 0) gaps.push(`${spec.name} was never run`);
    else if (any.some((v) => v.result === "fail")) gaps.push(`${spec.name} failed`);
    else if (any.some((v) => v.result === "unstable"))
      gaps.push(`${spec.name} ran on a tree that moved under it`);
    else gaps.push(`${spec.name} last passed on a different tree`);
  }
  return gaps;
}

/** The first Output that has this key at all, so a caller need not know which step wrote it. */
function anyField(got: Collected, key: string): YamlValue | undefined {
  for (const output of got.outputs.values()) {
    if (isYamlMap(output) && key in output) return output[key];
  }
  return undefined;
}

/** The same, restricted to the Outputs a reviewer wrote. */
function reviewerField(got: Collected, key: string): YamlValue | undefined {
  for (const [id, output] of got.outputs) {
    if (!got.reviewed.has(id)) continue;
    if (isYamlMap(output) && key in output) return output[key];
  }
  return undefined;
}

function reviewerSays(got: Collected, key: string): boolean {
  const value = reviewerField(got, key);
  return isBoolean(value) && value;
}

/** Whether a verification ran on a tree other than the one in front of us. */
function earlierTree(v: Verification, final: Snapshot): boolean {
  return v.end.head_sha !== final.head_sha || v.end.fingerprint !== final.fingerprint;
}

function names(value: YamlValue | undefined): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

/**
 * What is missing before this Run can claim its outcome. Empty means the evidence is
 * there; every entry is one sentence a human can act on.
 */
export function evidenceGaps(kind: Outcome, got: Collected): string[] {
  const gaps: string[] = [];
  const needsApproved = kind !== "investigation" && kind !== "plan" && kind !== "review";
  if (needsApproved) gaps.push(...approvedSetGaps(got));

  switch (kind) {
    case "unspecified":
      break;
    case "feature": {
      const done = names(anyField(got, "tickets_done"));
      if (done.length === 0) gaps.push("no ticket is reported built (tickets_done is empty)");
      if (!reviewerSays(got, "scope_met"))
        gaps.push("the review did not report scope_met: true for the agreed scope");
      // What each ticket said would prove it, before it was built. An agent may have
      // collected these itself; what matters is a pass on the tree in front of us.
      for (const ticket of got.tickets) {
        for (const name of ticket.checks) {
          if (!anyPassAtFinal(got, name))
            gaps.push(
              `${ticket.file} promised check "${name}", which has no passing verification on this tree`,
            );
        }
      }
      break;
    }
    case "bug": {
      // Fail then pass, on two different trees: a reproduction that never failed proves
      // nothing was reproduced, and one that never passed proves nothing was fixed.
      const regression = got.verifications.filter((v) => v.name === "regression");
      const reproduced = regression.filter((v) => v.expect === "fail" && v.result === "pass");
      if (reproduced.length === 0)
        gaps.push(
          "no regression verification recorded with --expect fail, so the bug was never reproduced",
        );
      else if (!reproduced.some((v) => earlierTree(v, got.final)))
        gaps.push(
          "the bug was only reproduced on the tree the fix is already on, so nothing shows it failing before the fix",
        );
      if (!anyPassAtFinal(got, "regression"))
        gaps.push("regression does not pass on the current tree, so the fix is not proven");
      const named = anyField(got, "reproduced");
      if (!isString(named) || named.trim() === "")
        gaps.push("the Output does not name the verification that reproduced the bug");
      break;
    }
    case "refactor":
      if (!reviewerSays(got, "behavior_preserved"))
        gaps.push("the review did not report behavior_preserved: true");
      break;
    case "investigation": {
      const conclusion = anyField(got, "conclusion");
      if (!isString(conclusion) || conclusion.trim() === "")
        gaps.push("the investigation reports no conclusion");
      const refs = names(anyField(got, "evidence"));
      if (refs.length === 0) gaps.push("the conclusion is supported by no evidence references");
      for (const ref of refs) {
        if (!got.insideRun(ref)) gaps.push(`evidence reference "${ref}" is outside this Run`);
      }
      if (!isBoolean(anyField(got, "patch")))
        gaps.push("the investigation does not say whether it produced a patch");
      if (!reviewerSays(got, "supported"))
        gaps.push("the review did not report supported: true for the conclusion");
      break;
    }
    case "docs": {
      const documented = names(anyField(got, "documented_commands"));
      if (documented.length === 0)
        gaps.push("no documented command is named, so the instructions were never run");
      for (const name of documented) {
        if (!anyPassAtFinal(got, name))
          gaps.push(`documented command "${name}" has no passing verification on this tree`);
      }
      if (!reviewerSays(got, "accurate"))
        gaps.push("the review did not report accurate: true for the instructions");
      break;
    }
    case "migration": {
      for (const name of ["migrate-up", "migrate-down"]) {
        if (anyPassAtFinal(got, name)) continue;
        // `rollback` is the same thing under another name, and a project that calls it
        // that has still proved it can go back.
        if (name === "migrate-down" && anyPassAtFinal(got, "rollback")) continue;
        gaps.push(`${name} has no passing verification on this tree`);
      }
      if (!reviewerSays(got, "compatible")) gaps.push("the review did not report compatible: true");
      break;
    }
    case "plan": {
      const issues = anyField(got, "issues_dir");
      if (!isString(issues) || issues.trim() === "") gaps.push("the plan wrote no tickets");
      break;
    }
    case "review": {
      const summary = anyField(got, "summary");
      if (!isString(summary) || summary.trim() === "")
        gaps.push("the review has no summary a human can read");
      break;
    }
  }
  return gaps;
}

/**
 * Whether an investigation is finished without a patch, which is a real outcome and not a
 * failure: it has a conclusion, references that hold it up, and nothing left to merge.
 */
export function endsWithoutPatch(kind: Outcome, got: Collected): boolean {
  if (kind !== "investigation") return false;
  return anyField(got, "patch") === false;
}

/** What the `mr` prompt says was actually proved, and by whom. */
export function renderEvidence(got: Pick<Collected, "verifications" | "final">): string {
  const latest = new Map<string, Verification>();
  for (const v of got.verifications) latest.set(`${v.name}:${v.by}`, v);
  if (latest.size === 0) return "(nothing was verified)";
  return [...latest.values()]
    .map((v) => {
      const stale =
        v.end.head_sha === got.final.head_sha && v.end.fingerprint === got.final.fingerprint
          ? ""
          : " (on an earlier tree)";
      const expected = v.expect === "fail" ? ", expected to fail" : "";
      return `- ${v.name}: ${v.result} (by ${v.by}${expected})${stale}`;
    })
    .join("\n");
}
