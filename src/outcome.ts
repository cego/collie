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
import { checkProof, owedLocally, owesNothingHere } from "./check-proof";
import {
  passed,
  ranOneTest,
  type CheckCommand,
  type FailedTest,
  type Snapshot,
  type Verification,
} from "./verify";
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
  /**
   * Those checks' commands as they resolve for this Run. A record of exactly one counts for
   * that check, whoever asked; without them, only Collie's own run under its name does.
   */
  readonly commands?: ReadonlyArray<CheckCommand>;
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

/**
 * Whether the latest result for this check, on the tree in front of us, passed — a pass a
 * later fail contradicts is not one — or it is left to CI.
 */
function lastPassedAtFinal(got: Collected, name: string): boolean {
  return owesNothingHere(checkProof(got, name));
}

type Journal = Pick<Collected, "verifications" | "final" | "commands"> &
  Partial<Pick<Collected, "approved">>;

/** A check's proof, where only Collie's own runs count for a check whose command is not given. */
const runsOf = (got: Journal, name: string) => checkProof(got, name, "collie");

/**
 * The tests a check's failed run named, split by whether each has since passed a rerun alone
 * on this tree; null where the run named none (ADR-0034, amended 2026-10-15).
 */
function rerunOf(got: Journal, last: Verification | undefined) {
  if (last === undefined || last.result !== "fail" || last.expect !== "pass") return null;
  if (last.failed === undefined || last.failed.length === 0) return null;
  const after = got.verifications.slice(got.verifications.indexOf(last) + 1);
  const rerun = (test: FailedTest) =>
    after.findLast(
      (v) =>
        v.pass === "rerun" &&
        v.by === "collie" &&
        v.name === last.name &&
        v.cwd === last.cwd &&
        v.test?.file === test.file &&
        v.test.name === test.name &&
        !earlierTree(v, got.final),
    );
  const alone = (test: FailedTest) => rerun(test)?.result === "pass";
  // Its runs in this check's directory where the branch leaves the default branch, which fail only where bun said that test failed.
  const bases = (test: FailedTest, among: ReadonlyArray<Verification>) =>
    among.filter(
      (v) =>
        v.pass === "baseline" &&
        v.by === "collie" &&
        v.name === last.name &&
        v.cwd === last.cwd &&
        v.test?.file === test.file &&
        v.test.name === test.name,
    );
  const base = (test: FailedTest) => bases(test, got.verifications).at(-1);
  const still = last.failed.filter((test) => !alone(test));
  return {
    flakes: last.failed.filter(alone),
    still,
    owed: last.failed.filter((test) => rerun(test) === undefined),
    atBase: still.flatMap((test) => {
      const at = base(test);
      return at?.result === "fail" ? [{ ...test, at: at.start.head_sha }] : [];
    }),
    own: still.filter((test) => base(test)?.result !== "fail"),
    unasked: still.filter((test) => bases(test, after).length === 0),
  };
}

/** Whether a check's latest run on this tree failed only on Flakes and tests that fail at the base too. */
function settledUnpassed(got: Journal, name: string): boolean {
  return rerunOf(got, runsOf(got, name).last)?.own.length === 0;
}

/** The Run's checks settled without a pass: every test each failed on was a Flake or fails at the base too. */
export function settledChecks(got: Journal & Pick<Collected, "approved">): string[] {
  return got.approved.filter((spec) => settledUnpassed(got, spec.name)).map((spec) => spec.name);
}

/**
 * Each Flake on this tree: a failed test of one of the Run's checks that passed when run again
 * alone. Never a pass, so the merge request names them.
 */
export function flakesOf(
  got: Journal & Pick<Collected, "approved">,
): Array<FailedTest & { readonly check: string }> {
  return got.approved.flatMap(
    (spec) =>
      rerunOf(got, runsOf(got, spec.name).last)?.flakes.map((test) => ({
        check: spec.name,
        ...test,
      })) ?? [],
  );
}

/** Each still-failing test that also fails where this branch leaves the default branch, at that revision. */
export function baseFailuresOf(
  got: Journal & Pick<Collected, "approved">,
): Array<FailedTest & { readonly check: string; readonly at: string }> {
  return got.approved.flatMap(
    (spec) =>
      rerunOf(got, runsOf(got, spec.name).last)?.atBase.map((test) => ({
        check: spec.name,
        ...test,
      })) ?? [],
  );
}

/** Each test of a check's latest run on this tree that failed again alone, and the base has not been asked about since. */
export function baselinesOwed(
  got: Journal & Pick<Collected, "approved">,
): Array<{ readonly check: string; readonly test: FailedTest }> {
  return got.approved.flatMap(
    (spec) =>
      rerunOf(got, runsOf(got, spec.name).last)?.unasked.map((test) => ({
        check: spec.name,
        test,
      })) ?? [],
  );
}

/** Each failed test of a check's latest run on this tree that has not been run again alone yet. */
export function rerunsOwed(
  got: Journal & Pick<Collected, "approved">,
): Array<{ readonly check: string; readonly test: FailedTest }> {
  return got.approved.flatMap(
    (spec) =>
      rerunOf(got, runsOf(got, spec.name).last)?.owed.map((test) => ({
        check: spec.name,
        test,
      })) ?? [],
  );
}

/**
 * The checks only a whole run can tell about: those whose latest run on this tree failed
 * without naming its tests, or with no run of their command on it, as after a re-grant.
 */
export function wholeRunsOwed(got: Journal & Pick<Collected, "approved">): string[] {
  return got.approved
    .filter((spec) => {
      const { last } = runsOf(got, spec.name);
      return last === undefined || (!passed(last) && rerunOf(got, last) === null);
    })
    .map((spec) => spec.name);
}

/** Whether this kind of result is proved by Collie's own run of the Run's checks. */
export function needsChecks(kind: Outcome): boolean {
  return kind !== "investigation" && kind !== "plan" && kind !== "review";
}

/** The gap a Run with no checks has, and how its implementer closes it. */
export const noCheckNamed =
  "no check is named for Collie to run, so nothing proves this Run: name the commands that prove work in this repository, each with `collie run intent verification <run> --name <name> [--cwd <dir>] -- <command>`";

/**
 * Every check, passing, on this exact tree. An empty set is a gap rather than a pass: it
 * would make this gate say yes to anything.
 */
function approvedSetGaps(got: Collected): string[] {
  if (got.approved.length === 0) return [noCheckNamed];
  const gaps: string[] = [];
  for (const spec of owedLocally(got.approved)) {
    const { state, runs, last } = runsOf(got, spec.name);
    if (state === "passed") continue;
    const reran = rerunOf(got, last);
    if (reran !== null) {
      // Not a gap, and not a pass either: every test it failed on passed alone or fails at the base too.
      if (reran.own.length === 0) continue;
      gaps.push(
        `${spec.name} failed: ${reran.own.map((test) => `${test.name} (${test.file})`).join(", ")}`,
      );
    } else if (state === "never") gaps.push(`${spec.name} was never run`);
    else if (runs.some((v) => v.result === "fail" || v.expect === "fail"))
      gaps.push(`${spec.name} failed`);
    else if (runs.some((v) => v.result === "unstable"))
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
 * Whether a reference an Output gives points inside the work this Run owns. A relative
 * one does by construction; an absolute one has to be under a root the Run holds, and a
 * `..` in either is a path nobody can answer for.
 */
export function refInside(roots: ReadonlyArray<string>, ref: string): boolean {
  const value = ref.trim();
  if (value === "" || value.includes("..")) return false;
  if (!value.startsWith("/")) return true;
  return roots.some((root) => root !== "" && (value === root || value.startsWith(`${root}/`)));
}

/**
 * What is missing before this Run can claim its outcome. Empty means the evidence is
 * there; every entry is one sentence a human can act on.
 */
export function evidenceGaps(kind: Outcome, got: Collected): string[] {
  return gapsOf(kind, got).map((gap) => gap.text);
}

/**
 * The gaps a verification on this tree could close: what a fix may be handed. The rest
 * are a reviewer's judgement or an Output's claim, and no command moves them.
 */
export function checkGaps(kind: Outcome, got: Collected): string[] {
  return gapsOf(kind, got)
    .filter((gap) => gap.check)
    .map((gap) => gap.text);
}

function gapsOf(kind: Outcome, got: Collected): Array<{ text: string; check: boolean }> {
  const gaps: Array<{ text: string; check: boolean }> = [];
  const check = (text: string) => gaps.push({ text, check: true });
  const claim = (text: string) => gaps.push({ text, check: false });
  if (needsChecks(kind)) for (const gap of approvedSetGaps(got)) check(gap);

  switch (kind) {
    case "unspecified":
      break;
    case "feature": {
      const done = names(anyField(got, "tickets_done"));
      if (done.length === 0) claim("no ticket is reported built (tickets_done is empty)");
      if (!reviewerSays(got, "scope_met"))
        claim("the review did not report scope_met: true for the agreed scope");
      // What each ticket said would prove it, before it was built. An agent may have
      // collected these itself; what matters is a pass on the tree in front of us.
      for (const ticket of got.tickets) {
        for (const name of ticket.checks) {
          if (lastPassedAtFinal(got, name) || settledUnpassed(got, name)) continue;
          check(
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
        check(
          "no regression verification recorded with --expect fail, so the bug was never reproduced",
        );
      else if (!reproduced.some((v) => earlierTree(v, got.final)))
        check(
          "the bug was only reproduced on the tree the fix is already on, so nothing shows it failing before the fix",
        );
      if (!lastPassedAtFinal(got, "regression"))
        check("regression does not pass on the current tree, so the fix is not proven");
      const named = anyField(got, "reproduced");
      if (!isString(named) || named.trim() === "")
        claim("the Output does not name the verification that reproduced the bug");
      break;
    }
    case "refactor":
      if (!reviewerSays(got, "behavior_preserved"))
        claim("the review did not report behavior_preserved: true");
      break;
    case "investigation": {
      const conclusion = anyField(got, "conclusion");
      if (!isString(conclusion) || conclusion.trim() === "")
        claim("the investigation reports no conclusion");
      const refs = names(anyField(got, "evidence"));
      if (refs.length === 0) claim("the conclusion is supported by no evidence references");
      for (const ref of refs) {
        if (!got.insideRun(ref)) claim(`evidence reference "${ref}" is outside this Run`);
      }
      if (!isBoolean(anyField(got, "patch")))
        claim("the investigation does not say whether it produced a patch");
      if (!reviewerSays(got, "supported"))
        claim("the review did not report supported: true for the conclusion");
      break;
    }
    case "docs": {
      const documented = names(anyField(got, "documented_commands"));
      if (documented.length === 0)
        claim("no documented command is named, so the instructions were never run");
      for (const name of documented) {
        if (!lastPassedAtFinal(got, name))
          check(`documented command "${name}" has no passing verification on this tree`);
      }
      if (!reviewerSays(got, "accurate"))
        claim("the review did not report accurate: true for the instructions");
      break;
    }
    case "migration": {
      for (const name of ["migrate-up", "migrate-down"]) {
        if (lastPassedAtFinal(got, name)) continue;
        // `rollback` is the same thing under another name, and a project that calls it
        // that has still proved it can go back.
        if (name === "migrate-down" && lastPassedAtFinal(got, "rollback")) continue;
        check(`${name} has no passing verification on this tree`);
      }
      if (!reviewerSays(got, "compatible")) claim("the review did not report compatible: true");
      break;
    }
    case "plan": {
      const issues = anyField(got, "issues_dir");
      if (!isString(issues) || issues.trim() === "") claim("the plan wrote no tickets");
      break;
    }
    case "review": {
      const summary = anyField(got, "summary");
      if (!isString(summary) || summary.trim() === "")
        claim("the review has no summary a human can read");
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
  for (const v of got.verifications) if (!ranOneTest(v)) latest.set(`${v.name}:${v.by}`, v);
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

/** A check left to CI as a reviewer is told of it, with its job's state where the Run has a merge request. */
export interface LeftToCiState {
  readonly name: string;
  readonly job: string;
  readonly state: string | null;
}

/**
 * Every check this Run's journal holds, latest of each, for a reviewer to read rather than run
 * again: who ran it, whether on the tree in front of it, when, and the baseline where there is
 * one. Then each check left to CI, which no reviewer runs.
 */
export function renderRecordedChecks(
  got: Pick<Collected, "verifications" | "final">,
  leftToCi: ReadonlyArray<LeftToCiState> = [],
): string {
  const latest = new Map<string, Verification>();
  const baseline = new Map<string, Verification>();
  for (const v of got.verifications.filter((one) => !ranOneTest(one)))
    if (v.pass === "baseline") baseline.set(v.name, v);
    else latest.set(`${v.name}:${v.by}`, v);
  if (latest.size + baseline.size + leftToCi.length === 0)
    return "(nothing is recorded for this Run)";
  const onTree = (v: Verification) =>
    v.end.head_sha === got.final.head_sha && v.end.fingerprint === got.final.fingerprint
      ? "on this tree"
      : "on an earlier tree";
  return [
    ...[...latest.values()].map(
      (v) => `- ${v.name}: ${v.result} (by ${v.by}), ${onTree(v)}, at ${v.at}`,
    ),
    ...[...baseline.values()].map(
      (v) =>
        `- ${v.name} (baseline, where this branch leaves the default branch, ${v.start.head_sha.slice(0, 12)}): ${v.result}, at ${v.at}`,
    ),
    ...leftToCi.map(
      (one) =>
        `- ${one.name}: left to CI (job ${one.job}), do not run it. left to CI: proved by ${one.job} on the merge request's head${one.state === null ? "" : `; its job is ${one.state} now`}`,
    ),
  ].join("\n");
}
