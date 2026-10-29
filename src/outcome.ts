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

import * as Str from "effect/String";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { CommandLine } from "effect/process";
import type { VerifySpec } from "./verify-spec";
import { checkProof, owedLocally, owesNothingHere } from "./check-proof";
import {
  passed,
  ranOneTest,
  sameAsked,
  TOO_LARGE,
  type CheckCommand,
  type FailedTest,
  type Snapshot,
  type Verification,
} from "./verify";
import { isString, isBoolean } from "./schema";
import { planRunOf } from "./strategies";
import { isYamlMap, type YamlValue } from "./yaml";
import { finalMeasurementLine, type Measurement } from "./measurement-model";

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
  "performance",
] as const;
export type Outcome = (typeof KINDS)[number];

/** The kinds a human may ask an `implement` Run for. `review`, `plan` and `performance` are fixed. */
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
  /** The tree each of those reviewed, where it was recorded. */
  readonly reviewedOn?: ReadonlyMap<string, Snapshot>;
  /** The Run's Measurements, oldest first. */
  readonly measurements?: ReadonlyArray<Measurement>;
  /** Where this checkout leaves the default branch a merge request targets; null where it has none. */
  readonly mergeBase?: string | null;
  /** The Git tree HEAD names. */
  readonly content?: string;
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

const TEXT_SEARCHES = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/** Whether a command only searches text, also as a `sh -c` or `bash -c` script's first word. */
function textSearch(executable: string, argv: ReadonlyArray<string>): boolean {
  const program = Str.split(executable, "/").at(-1) ?? "";
  if (TEXT_SEARCHES.has(program)) return true;
  if (program === "git") return argv[0] === "grep";
  if (program !== "sh" && program !== "bash") return false;
  const at = argv.indexOf("-c");
  const script = at < 0 ? undefined : argv[at + 1];
  if (script === undefined) return false;
  const [first = "", ...rest] = shellWords(script);
  return textSearch(first, rest);
}

/** A script's words as the shell reads them, its quotes, escapes and line continuations removed. */
function shellWords(script: string): ReadonlyArray<string> {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  for (let i = 0; i < script.length; i++) {
    const c = Option.getOrElse(Str.charAt(script, i), () => "");
    if (
      quote !== "'" &&
      c === "\\" &&
      Option.getOrElse(Str.charAt(script, i + 1), () => "") === "\n"
    ) {
      i++;
      continue;
    }
    if (quote === "" && /\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    started = true;
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
    } else if (c === "\\" && i + 1 < script.length) {
      const next = Option.getOrElse(Str.charAt(script, ++i), () => "");
      word += quote === '"' && !pipe('"\\$`', Str.includes(next)) ? c + next : next;
    } else if (c === quote) quote = "";
    else if (quote === "" && (c === "'" || c === '"')) quote = c;
    else word += c;
  }
  if (started) words.push(word);
  return words;
}

/**
 * Whether a name's latest result on this tree passed, a passing text search not counting:
 * it shows the text is there, not that anything works. A Run's Check is the project's own.
 */
function provedAtFinal(got: Collected, name: string): "passed" | "searched" | "unproved" {
  if (lastPassedAtFinal(withoutSearches(got, name), name)) return "passed";
  return lastPassedAtFinal(got, name) ? "searched" : "unproved";
}

function withoutSearches(got: Collected, name: string): Collected {
  const ownCheck = Arr.some([...got.approved, ...(got.commands ?? [])], (one) => one.name === name);
  if (ownCheck) return got;
  const searched = (v: Verification) =>
    v.name === name && passed(v) && textSearch(v.executable, v.argv);
  return { ...got, verifications: Arr.filter(got.verifications, (v) => !searched(v)) };
}

const onlySearched = (what: string) =>
  `${what}, whose only pass on this tree is a text search, which proves nothing`;

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
    Option.getOrUndefined(
      Arr.findLast(
        after,
        (v) =>
          v.pass === "rerun" &&
          v.by === "collie" &&
          v.name === last.name &&
          v.cwd === last.cwd &&
          v.test?.file === test.file &&
          v.test.name === test.name &&
          !earlierTree(v, got.final),
      ),
    );
  const alone = (test: FailedTest) => rerun(test)?.result === "pass";
  // Its runs in this check's directory where the branch leaves the default branch, which fail only where bun said that test failed.
  const bases = (test: FailedTest, among: ReadonlyArray<Verification>) =>
    Arr.filter(
      among,
      (v) =>
        v.pass === "baseline" &&
        v.by === "collie" &&
        v.name === last.name &&
        v.cwd === last.cwd &&
        v.test?.file === test.file &&
        v.test.name === test.name,
    );
  const base = (test: FailedTest) => bases(test, got.verifications).at(-1);
  const still = Arr.filter(last.failed, (test) => !alone(test));
  return {
    flakes: Arr.filter(last.failed, alone),
    still,
    owed: Arr.filter(last.failed, (test) => rerun(test) === undefined),
    atBase: Arr.flatMap(still, (test) => {
      const at = base(test);
      return at?.result === "fail" ? [{ ...test, at: at.start.head_sha }] : [];
    }),
    own: Arr.filter(still, (test) => base(test)?.result !== "fail"),
    unasked: Arr.filter(still, (test) => bases(test, after).length === 0),
  };
}

/** Whether a check's latest run on this tree failed only on Flakes and tests that fail at the base too. */
function settledUnpassed(got: Journal, name: string): boolean {
  return rerunOf(got, runsOf(got, name).last)?.own.length === 0;
}

/** The Run's checks settled without a pass: every test each failed on was a Flake or fails at the base too. */
export function settledChecks(got: Journal & Pick<Collected, "approved">): string[] {
  return Arr.map(
    Arr.filter(got.approved, (spec) => settledUnpassed(got, spec.name)),
    (spec) => spec.name,
  );
}

/**
 * Each Flake on this tree: a failed test of one of the Run's checks that passed when run again
 * alone. Never a pass, so the merge request names them.
 */
export function flakesOf(
  got: Journal & Pick<Collected, "approved">,
): Array<FailedTest & { readonly check: string }> {
  return Arr.flatMap(
    got.approved,
    (spec) =>
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(rerunOf(got, runsOf(got, spec.name).last)), (present) =>
          Arr.map(present.flakes, (test) => ({
            check: spec.name,
            ...test,
          })),
        ),
      ) ?? [],
  );
}

/** Each still-failing test that also fails where this branch leaves the default branch, at that revision. */
export function baseFailuresOf(
  got: Journal & Pick<Collected, "approved">,
): Array<FailedTest & { readonly check: string; readonly at: string }> {
  return Arr.flatMap(
    got.approved,
    (spec) =>
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(rerunOf(got, runsOf(got, spec.name).last)), (present_) =>
          Arr.map(present_.atBase, (test) => ({
            check: spec.name,
            ...test,
          })),
        ),
      ) ?? [],
  );
}

/** Each test of a check's latest run on this tree that failed again alone, and the base has not been asked about since. */
export function baselinesOwed(
  got: Journal & Pick<Collected, "approved">,
): Array<{ readonly check: string; readonly test: FailedTest }> {
  return Arr.flatMap(
    got.approved,
    (spec) =>
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(rerunOf(got, runsOf(got, spec.name).last)), (present__) =>
          Arr.map(present__.unasked, (test) => ({
            check: spec.name,
            test,
          })),
        ),
      ) ?? [],
  );
}

/** Each failed test of a check's latest run on this tree that has not been run again alone yet. */
export function rerunsOwed(
  got: Journal & Pick<Collected, "approved">,
): Array<{ readonly check: string; readonly test: FailedTest }> {
  return Arr.flatMap(
    got.approved,
    (spec) =>
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(rerunOf(got, runsOf(got, spec.name).last)), (present___) =>
          Arr.map(present___.owed, (test) => ({
            check: spec.name,
            test,
          })),
        ),
      ) ?? [],
  );
}

/**
 * The checks only a whole run can tell about: those whose latest run on this tree failed
 * without naming its tests, or with no run of their command on it, as after a re-grant.
 */
export function wholeRunsOwed(got: Journal & Pick<Collected, "approved">): string[] {
  return Arr.map(
    Arr.filter(got.approved, (spec) => {
      const { last } = runsOf(got, spec.name);
      return last === undefined || (!passed(last) && rerunOf(got, last) === null);
    }),
    (spec) => spec.name,
  );
}

/**
 * The checks the proof runs whole once more: those a whole run is owed by that have had no
 * `recheck` of their command on this tree (ADR-0034, amended 2026-10-19).
 */
export function recheckOwed(got: Journal & Pick<Collected, "approved">): string[] {
  return Arr.filter(
    wholeRunsOwed(got),
    (name) =>
      !Arr.some(runsOf(got, name).runs, (v) => v.pass === "recheck" && !earlierTree(v, got.final)),
  );
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
        `${spec.name} failed: ${Arr.join(
          Arr.map(reran.own, (test) => `${test.name} (${test.file})`),
          ", ",
        )}`,
      );
    } else if (state === "never") gaps.push(`${spec.name} was never run`);
    else if (Arr.some(runs, (v) => v.result === "fail" || v.expect === "fail"))
      gaps.push(`${spec.name} failed`);
    else if (Arr.some(runs, (v) => v.result === "unstable"))
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

/** A command whole, so two that differ never read the same. */
const shown = (v: Verification) => {
  const executable = CommandLine.display([v.executable]);
  const program =
    v.asked === undefined || v.asked === v.executable
      ? executable
      : `${CommandLine.display([v.asked])} (${executable})`;
  return `"${Arr.join(
    Arr.filter([program, CommandLine.display(v.argv)], (part) => part !== ""),
    " ",
  )}" in ${v.cwd}`;
};

function names(value: YamlValue | undefined): string[] {
  return Arr.isArray(value) ? Arr.filter(value, isString) : [];
}

/**
 * The directories a reference a Run's Outputs give may point inside: its own, its
 * checkout, and, where it builds another Run's plan, that Run's.
 */
export function evidenceRoots(own: string, cwd: string, workSource: string): string[] {
  const planned =
    planRunOf(workSource) === null ? [] : [pipe(workSource, Str.replace(/\/plan\/?$/, ""))];
  return [own, cwd, ...planned];
}

/**
 * Whether a reference an Output gives points inside the work this Run owns. A relative
 * one does by construction; an absolute one has to be under a root the Run holds, and a
 * `..` in either is a path nobody can answer for.
 */
export function refInside(roots: ReadonlyArray<string>, ref: string): boolean {
  const value = Str.trim(ref);
  if (value === "" || pipe(value, Str.includes(".."))) return false;
  if (!pipe(value, Str.startsWith("/"))) return true;
  return Arr.some(
    roots,
    (root) => root !== "" && (value === root || pipe(value, Str.startsWith(`${root}/`))),
  );
}

/**
 * What is missing before this Run can claim its outcome. Empty means the evidence is
 * there; every entry is one sentence a human can act on.
 */
export function evidenceGaps(kind: Outcome, got: Collected): string[] {
  return Arr.map(gapsOf(kind, got), (gap) => gap.text);
}

/**
 * The gaps a verification on this tree could close: what a fix may be handed. The rest
 * are a reviewer's judgement or an Output's claim, and no command moves them.
 */
export function checkGaps(kind: Outcome, got: Collected): string[] {
  return Arr.map(
    Arr.filter(gapsOf(kind, got), (gap) => gap.by === "check"),
    (gap) => gap.text,
  );
}

/** The gaps a fresh review could close: a reviewer's judgement the Outputs do not report. */
export function reviewGaps(kind: Outcome, got: Collected): string[] {
  return Arr.map(
    Arr.filter(gapsOf(kind, got), (gap) => gap.by === "review"),
    (gap) => gap.text,
  );
}

/** Who can close a gap: a verification, a reviewer, a new Measurement, or nobody short of new work. */
type GapCloser = "check" | "review" | "measure" | "claim";

function gapsOf(kind: Outcome, got: Collected): Array<{ text: string; by: GapCloser }> {
  const gaps: Array<{ text: string; by: GapCloser }> = [];
  const check = (text: string) => gaps.push({ text, by: "check" });
  const claim = (text: string) => gaps.push({ text, by: "claim" });
  const judged = (key: string, text: string) => {
    if (!reviewerSays(got, key)) gaps.push({ text, by: "review" });
  };
  if (needsChecks(kind)) for (const gap of approvedSetGaps(got)) check(gap);

  switch (kind) {
    case "unspecified":
      break;
    case "feature": {
      const done = names(anyField(got, "tickets_done"));
      if (done.length === 0) claim("no ticket is reported built (tickets_done is empty)");
      judged("scope_met", "the review did not report scope_met: true for the agreed scope");
      // What each ticket said would prove it, before it was built. An agent may have
      // collected these itself; what matters is a pass on the tree in front of us.
      for (const ticket of got.tickets) {
        for (const name of ticket.checks) {
          const proof = provedAtFinal(got, name);
          if (proof === "passed" || settledUnpassed(got, name)) continue;
          check(
            proof === "searched"
              ? onlySearched(`${ticket.file} promised check "${name}"`)
              : `${ticket.file} promised check "${name}", which has no passing verification on this tree`,
          );
        }
      }
      break;
    }
    case "bug": {
      // Fail then pass, on two different trees: a reproduction that never failed proves
      // nothing was reproduced, and one that never passed proves nothing was fixed.
      const regression = Arr.filter(got.verifications, (v) => v.name === "regression");
      const reproduced = Arr.filter(regression, (v) => v.expect === "fail" && v.result === "pass");
      const before = Arr.filter(reproduced, (v) => earlierTree(v, got.final));
      if (reproduced.length === 0)
        check(
          "no regression verification recorded with --expect fail, so the bug was never reproduced",
        );
      else if (before.length === 0)
        check(
          "the bug was only reproduced on the tree the fix is already on, so nothing shows it failing before the fix",
        );
      const fix = checkProof(withoutSearches(got, "regression"), "regression");
      const fixedBy = fix.state === "passed" ? fix.last : undefined;
      if (fixedBy === undefined)
        check(
          lastPassedAtFinal(got, "regression")
            ? onlySearched("regression")
            : "regression does not pass on the current tree, so the fix is not proven",
        );
      else if (before.length > 0 && !Arr.some(before, (v) => sameAsked(v, fixedBy)))
        check(
          `the bug was reproduced by ${shown(before.at(-1)!)} but the fix is proven by ${shown(fixedBy)}: one command has to fail before the fix and pass after it`,
        );
      const named = anyField(got, "reproduced");
      if (!isString(named) || Str.trim(named) === "")
        claim("the Output does not name the verification that reproduced the bug");
      break;
    }
    case "refactor":
      judged("behavior_preserved", "the review did not report behavior_preserved: true");
      break;
    case "investigation": {
      const conclusion = anyField(got, "conclusion");
      if (!isString(conclusion) || Str.trim(conclusion) === "")
        claim("the investigation reports no conclusion");
      const refs = names(anyField(got, "evidence"));
      if (refs.length === 0) claim("the conclusion is supported by no evidence references");
      for (const ref of refs) {
        if (!got.insideRun(ref)) claim(`evidence reference "${ref}" is outside this Run`);
      }
      if (!isBoolean(anyField(got, "patch")))
        claim("the investigation does not say whether it produced a patch");
      judged("supported", "the review did not report supported: true for the conclusion");
      break;
    }
    case "docs": {
      const documented = names(anyField(got, "documented_commands"));
      if (documented.length === 0)
        claim("no documented command is named, so the instructions were never run");
      for (const name of documented) {
        const proof = provedAtFinal(got, name);
        if (proof === "searched") check(onlySearched(`documented command "${name}"`));
        else if (proof === "unproved")
          check(`documented command "${name}" has no passing verification on this tree`);
      }
      judged("accurate", "the review did not report accurate: true for the instructions");
      break;
    }
    case "migration": {
      for (const name of ["migrate-up", "migrate-down"]) {
        // `rollback` is the same thing under another name, and a project that calls it
        // that has still proved it can go back.
        const proofs = Arr.map(name === "migrate-down" ? [name, "rollback"] : [name], (one) => ({
          one,
          proof: provedAtFinal(got, one),
        }));
        if (Arr.some(proofs, ({ proof }) => proof === "passed")) continue;
        const searched = Option.getOrUndefined(
          Arr.findFirst(proofs, ({ proof }) => proof === "searched"),
        );
        check(
          searched === undefined
            ? `${name} has no passing verification on this tree`
            : onlySearched(searched.one),
        );
      }
      judged("compatible", "the review did not report compatible: true");
      break;
    }
    case "plan": {
      const issues = anyField(got, "issues_dir");
      if (!isString(issues) || Str.trim(issues) === "") claim("the plan wrote no tickets");
      break;
    }
    case "review": {
      const summary = anyField(got, "summary");
      if (!isString(summary) || Str.trim(summary) === "")
        claim("the review has no summary a human can read");
      break;
    }
    case "performance": {
      for (const text of finalMeasurementGaps(got)) gaps.push({ text, by: "measure" });
      for (const key of ["behavior_preserved", "measurement_valid"]) {
        if (reviewerSaysOfThisTree(got, key)) continue;
        gaps.push({
          text: reviewerSays(got, key)
            ? `${key}: true was reported by a review that was not of this tree`
            : `the review did not report ${key}: true`,
          by: "review",
        });
      }
      break;
    }
  }
  return gaps;
}

const isFinal = (tree: Snapshot, final: Snapshot) =>
  tree.fingerprint !== TOO_LARGE &&
  tree.head_sha === final.head_sha &&
  tree.fingerprint === final.fingerprint;

function reviewerSaysOfThisTree(got: Collected, key: string): boolean {
  for (const [id, output] of got.outputs) {
    const tree = got.reviewedOn?.get(id);
    if (!got.reviewed.has(id) || tree === undefined || !isFinal(tree, got.final)) continue;
    if (isYamlMap(output) && key in output) return output[key] === true;
  }
  return false;
}

function finalMeasurementGaps(got: Collected): string[] {
  const finals = Arr.filter(got.measurements ?? [], (one) => one.pass === "final");
  const here = Arr.filter(finals, (one) => isFinal(one.candidate, got.final));
  const proving = Option.getOrUndefined(
    Arr.findLast(here, (one) => one.base.commit === got.mergeBase),
  );
  if (finals.length === 0) return ["no `final` Measurement was taken, so no gain is proved"];
  if (here.length === 0)
    return [`the latest \`final\` Measurement, ${finals.at(-1)!.id}, was taken on an earlier tree`];
  if (proving === undefined) {
    const last = here.at(-1)!;
    return [
      got.mergeBase === null || got.mergeBase === undefined
        ? `the \`final\` Measurement ${last.id} cannot be held to a merge base: this checkout has none with the default branch`
        : `the \`final\` Measurement ${last.id} was taken against ${last.base.commit}, not the merge base ${got.mergeBase}`,
    ];
  }
  const result = proving.result;
  if (result._tag !== "Judged")
    return [`the \`final\` Measurement ${proving.id} has no verdict: it ended ${result._tag}`];
  const verdictOf = (metric: string) =>
    Option.getOrUndefined(Arr.findFirst(result.verdicts, (one) => one.metric === metric));
  const gaps: string[] = [];
  for (const metric of proving.plan.metrics) {
    const judged = verdictOf(metric.name);
    const verdict = judged?.verdict ?? "no verdict";
    if (metric.role === "primary") {
      if (verdict !== "gain")
        gaps.push(
          `the \`final\` Measurement ${proving.id} shows ${metric.name} ${verdict}, not a gain`,
        );
    } else if (judged === undefined || !judged.held || verdict === "inconclusive")
      gaps.push(
        `guardrail ${metric.name} is not held in the \`final\` Measurement ${proving.id} (${verdict})`,
      );
  }
  return gaps;
}

/**
 * Whether the Run is finished without a patch, which is a real outcome and not a failure.
 * An investigation says so beside a conclusion and references that hold it up; a
 * performance Run is so when its tree is its latest base tree again, whatever it says.
 */
export function endsWithoutPatch(kind: Outcome, got: Collected): boolean {
  if (kind === "investigation") return anyField(got, "patch") === false;
  if (kind !== "performance") return false;
  const base = got.measurements?.at(-1)?.base;
  return (
    base !== undefined &&
    base.fingerprint !== TOO_LARGE &&
    base.content !== "" &&
    base.content === got.content &&
    base.fingerprint === got.final.fingerprint
  );
}

/** What the `mr` prompt says was actually proved, and by whom. */
export function renderEvidence(
  got: Pick<Collected, "verifications" | "final" | "measurements">,
): string {
  const latest = new Map<string, Verification>();
  for (const v of got.verifications) if (!ranOneTest(v)) latest.set(`${v.name}:${v.by}`, v);
  const measured = finalMeasurementLine(got.measurements ?? []);
  const lines = Arr.map([...latest.values()], (v) => {
    const stale =
      v.end.head_sha === got.final.head_sha && v.end.fingerprint === got.final.fingerprint
        ? ""
        : " (on an earlier tree)";
    const expected = v.expect === "fail" ? ", expected to fail" : "";
    return `- ${v.name}: ${v.result} (by ${v.by}${expected})${stale}`;
  });
  if (measured !== null) lines.push(`- ${measured}`);
  return lines.length === 0 ? "(nothing was verified)" : Arr.join(lines, "\n");
}

/** A check left to CI as a reviewer is told of it, with its job's state where the Run has a merge request. */
export interface LeftToCiState {
  readonly name: string;
  readonly job: string;
  readonly state: string | null;
}

/**
 * Every check this Run's journal holds, latest of each, for a reviewer to read rather than run
 * again: who ran it, whether on the tree in front of it, when, whether the same command was seen
 * failing on an earlier tree, and the baseline where there is one. Then each check left to CI, which no reviewer runs.
 */
export function renderRecordedChecks(
  got: Pick<Collected, "verifications" | "final">,
  leftToCi: ReadonlyArray<LeftToCiState> = [],
): string {
  const latest = new Map<string, Verification>();
  const baseline = new Map<string, Verification>();
  for (const v of Arr.filter(got.verifications, (one) => !ranOneTest(one)))
    if (v.pass === "baseline") baseline.set(v.name, v);
    else latest.set(`${v.name}:${v.by}`, v);
  if (latest.size + baseline.size + leftToCi.length === 0)
    return "(nothing is recorded for this Run)";
  const onTree = (v: Verification) =>
    v.end.head_sha === got.final.head_sha && v.end.fingerprint === got.final.fingerprint
      ? "on this tree"
      : "on an earlier tree";
  const seenFailing = (v: Verification) =>
    Arr.some(
      got.verifications,
      (one) => one.exit !== 0 && onTree(one) === "on an earlier tree" && sameAsked(one, v),
    )
      ? "seen failing on an earlier tree"
      : "never seen failing on an earlier tree";
  return Arr.join(
    [
      ...Arr.map(
        [...latest.values()],
        (v) => `- ${v.name}: ${v.result} (by ${v.by}), ${onTree(v)}, at ${v.at}; ${seenFailing(v)}`,
      ),
      ...Arr.map(
        [...baseline.values()],
        (v) =>
          `- ${v.name} (baseline, where this branch leaves the default branch, ${pipe(v.start.head_sha, Str.slice(0, 12))}): ${v.result}, at ${v.at}`,
      ),
      ...Arr.map(
        leftToCi,
        (one) =>
          `- ${one.name}: left to CI (job ${one.job}), do not run it. left to CI: proved by ${one.job} on the merge request's head${one.state === null ? "" : `; its job is ${one.state} now`}`,
      ),
    ],
    "\n",
  );
}
