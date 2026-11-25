import * as Str from "effect/String";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { CommandLine } from "effect/process";
import type { VerifySpec } from "./verify-spec";
import { checkProof, owedLocally, owesNothingHere, unstableWhy } from "./check-proof";
import { passed, ranOneTest, sameAsked, sameTree } from "./verify";
import type { CheckCommand, FailedTest, Snapshot, Verification } from "./verify";
import { isString, isBoolean } from "./schema";
import { planRunOf } from "./strategies";
import { isYamlMap } from "./yaml";
import type { YamlValue } from "./yaml";
import { finalMeasurementLine } from "./measurement-model";
import type { Measurement } from "./measurement-model";

// WARNING: unspecified is not feature: an unclassified Run must not be held to a feature's evidence.
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

export const REQUESTABLE: ReadonlyArray<string> = [
  "feature",
  "bug",
  "refactor",
  "investigation",
  "docs",
  "migration",
];

export function isOutcome(value: string): value is Outcome {
  // WARNING: widening a readonly tuple of string literals to its element type, so that a plain string can be tested against it.
  const known: ReadonlyArray<string> = KINDS;
  return known.includes(value);
}

export interface Collected {
  readonly verifications: ReadonlyArray<Verification>;
  readonly final: Snapshot;
  readonly approved: ReadonlyArray<VerifySpec>;
  readonly commands?: ReadonlyArray<CheckCommand>;
  readonly outputs: ReadonlyMap<string, YamlValue>;
  readonly reviewed: ReadonlySet<string>;
  readonly reviewedOn?: ReadonlyMap<string, Snapshot>;
  readonly measurements?: ReadonlyArray<Measurement>;
  readonly mergeBase?: string | null;
  readonly content?: string;
  readonly insideRun: (ref: string) => boolean;
  readonly tickets: ReadonlyArray<{
    readonly file: string;
    readonly checks: ReadonlyArray<string>;
  }>;
}

// WARNING: a pass that a later fail on the same tree contradicts does not count.
function lastPassedAtFinal(got: Collected, name: string) {
  return owesNothingHere(checkProof(got, name));
}

const TEXT_SEARCHES = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

function textSearch(executable: string, argv: ReadonlyArray<string>) {
  const program = Str.split(executable, "/").at(-1) ?? "";
  if (TEXT_SEARCHES.has(program)) {
    return true;
  }
  if (program === "git") {
    return argv[0] === "grep";
  }
  if (program !== "sh" && program !== "bash") {
    return false;
  }
  const at = argv.indexOf("-c");
  const script = at < 0 ? undefined : argv[at + 1];
  if (script === undefined) {
    return false;
  }
  const [first = "", ...rest] = shellWords(script);
  return textSearch(first, rest);
}

function shellWords(script: string) {
  const words: Array<string> = [];
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
      if (started) {
        words.push(word);
      }
      word = "";
      started = false;
      continue;
    }
    started = true;
    if (quote === "'") {
      if (c === "'") {
        quote = "";
      } else {
        word += c;
      }
    } else if (c === "\\" && i + 1 < script.length) {
      const next = Option.getOrElse(Str.charAt(script, ++i), () => "");
      word += quote === '"' && !pipe('"\\$`', Str.includes(next)) ? c + next : next;
    } else if (c === quote) {
      quote = "";
    } else if (quote === "" && (c === "'" || c === '"')) {
      quote = c;
    } else {
      word += c;
    }
  }
  if (started) {
    words.push(word);
  }
  return words;
}

// WARNING: a passing text search does not prove the check; it shows only that the text is there.
function provedAtFinal(got: Collected, name: string) {
  if (lastPassedAtFinal(withoutSearches(got, name), name)) {
    return "passed";
  }
  return lastPassedAtFinal(got, name) ? "searched" : "unproved";
}

function withoutSearches(got: Collected, name: string) {
  const ownCheck = Arr.some([...got.approved, ...(got.commands ?? [])], (one) => one.name === name);
  if (ownCheck) {
    return got;
  }
  const searched = (v: Verification) =>
    v.name === name && passed(v) && textSearch(v.executable, v.argv);
  return { ...got, verifications: Arr.filter(got.verifications, (v) => !searched(v)) };
}

const onlySearched = (what: string) =>
  `${what}, whose only pass on this tree is a text search, which proves nothing`;

function passedOnlyBefore(got: Collected, name: string) {
  const proof = checkProof(withoutSearches(got, name), name);
  return proof.state === "earlier"
    ? Option.getOrUndefined(Arr.findLast(proof.runs, passed))
    : undefined;
}

const runAgain = (last: Verification, tree: string) =>
  `passed on ${pipe(last.end.head_sha, Str.slice(0, 12))} but has not run on ${tree}: run ${shown(last)} again here`;

type Journal = Pick<Collected, "verifications" | "final" | "commands"> &
  Partial<Pick<Collected, "approved">>;

const runsOf = (got: Journal, name: string) => checkProof(got, name, "collie");

function rerunOf(got: Journal, last: Verification | undefined) {
  if (last === undefined || last.result !== "fail" || last.expect !== "pass") {
    return null;
  }
  if (last.failed === undefined || last.failed.length === 0) {
    return null;
  }
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
  const passedAlone = (test: FailedTest) => rerun(test)?.result === "pass";
  // WARNING: a branch's own test that passed alone is still the Run's to fix; the base never had it fail.
  const ownPassedAlone = (test: FailedTest) => passedAlone(test) && rerun(test)?.own === true;
  const alone = (test: FailedTest) => passedAlone(test) && !ownPassedAlone(test);
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
  const still = Arr.filter(last.failed, (test) => !passedAlone(test));
  return {
    flakes: Arr.filter(last.failed, alone),
    still,
    owed: Arr.filter(last.failed, (test) => rerun(test) === undefined),
    atBase: Arr.flatMap(still, (test) => {
      const at = base(test);
      return at?.result === "fail" ? [{ ...test, at: at.start.head_sha }] : [];
    }),
    own: Arr.map(
      Arr.filter(
        last.failed,
        (test) => ownPassedAlone(test) || (!passedAlone(test) && base(test)?.result !== "fail"),
      ),
      (test) => ({ ...test, passedAlone: ownPassedAlone(test) }),
    ),
    unasked: Arr.filter(still, (test) => bases(test, after).length === 0),
  };
}

function settledUnpassed(got: Journal, name: string) {
  return rerunOf(got, runsOf(got, name).last)?.own.length === 0;
}

export function settledChecks(got: Journal & Pick<Collected, "approved">) {
  return Arr.map(
    Arr.filter(got.approved, (spec) => settledUnpassed(got, spec.name)),
    (spec) => spec.name,
  );
}

// WARNING: a flake is never a pass, so the merge request names it.
export function flakesOf(got: Journal & Pick<Collected, "approved">) {
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

export function baseFailuresOf(got: Journal & Pick<Collected, "approved">) {
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

export function baselinesOwed(got: Journal & Pick<Collected, "approved">) {
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

export function rerunsOwed(got: Journal & Pick<Collected, "approved">) {
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

export function wholeRunsOwed(got: Journal & Pick<Collected, "approved">) {
  return Arr.map(
    Arr.filter(got.approved, (spec) => {
      const { last } = runsOf(got, spec.name);
      return last === undefined || (!passed(last) && rerunOf(got, last) === null);
    }),
    (spec) => spec.name,
  );
}

export function recheckOwed(got: Journal & Pick<Collected, "approved">) {
  return Arr.filter(
    wholeRunsOwed(got),
    (name) =>
      !Arr.some(runsOf(got, name).runs, (v) => v.pass === "recheck" && !earlierTree(v, got.final)),
  );
}

export function needsChecks(kind: Outcome) {
  return kind !== "investigation" && kind !== "plan" && kind !== "review";
}

export const noCheckNamed =
  "no check is named for Collie to run, so nothing proves this Run: name the commands that prove work in this repository, each with `collie run intent verification <run> --name <name> [--cwd <dir>] -- <command>`";

// WARNING: an empty set is a gap, not a pass, or this gate would say yes to anything.
function approvedSetGaps(got: Collected) {
  if (got.approved.length === 0) {
    return [noCheckNamed];
  }
  const gaps: Array<string> = [];
  for (const spec of owedLocally(got.approved)) {
    const { state, runs, last } = runsOf(got, spec.name);
    if (state === "passed") {
      continue;
    }
    const reran = rerunOf(got, last);
    if (reran !== null) {
      if (reran.own.length === 0) {
        continue;
      }
      gaps.push(
        `${spec.name} failed: ${Arr.join(
          Arr.map(
            reran.own,
            (test) =>
              `${test.name} (${test.file})${test.passedAlone ? ", which then passed alone but is this branch's own test" : ""}`,
          ),
          ", ",
        )}`,
      );
    } else if (state === "never") {
      gaps.push(`${spec.name} was never run`);
    } else if (Arr.some(runs, (v) => v.result === "fail" || v.expect === "fail")) {
      gaps.push(`${spec.name} failed`);
    } else if (Arr.some(runs, (v) => v.result === "unstable")) {
      gaps.push(`${spec.name} ${unstableWhy(runs)}`);
    } else {
      gaps.push(`${spec.name} last passed on a different tree`);
    }
  }
  return gaps;
}

function anyField(got: Collected, key: string) {
  for (const output of [...got.outputs.values()].reverse()) {
    if (isYamlMap(output) && key in output) {
      return output[key];
    }
  }
  return undefined;
}

function reproducedName(got: Collected) {
  for (const output of [...got.outputs.values()].reverse()) {
    const named = isYamlMap(output) ? output["reproduced"] : undefined;
    if (isString(named) && Str.trim(named) !== "") {
      return named;
    }
  }
  return undefined;
}

function reviewerField(got: Collected, key: string) {
  for (const [id, output] of got.outputs) {
    if (!got.reviewed.has(id)) {
      continue;
    }
    if (isYamlMap(output) && key in output) {
      return output[key];
    }
  }
  return undefined;
}

function reviewerSays(got: Collected, key: string) {
  const value = reviewerField(got, key);
  return isBoolean(value) && value;
}

function earlierTree(v: Verification, final: Snapshot) {
  return !sameTree(v.end, final);
}

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

function names(value: YamlValue | undefined) {
  return Arr.isArray(value) ? Arr.filter(value, isString) : [];
}

export function evidenceRoots(own: string, cwd: string, workSource: string) {
  const planned =
    planRunOf(workSource) === null ? [] : [pipe(workSource, Str.replace(/\/plan\/?$/, ""))];
  return [own, cwd, ...planned];
}

// WARNING: a `..` in a reference is refused, as no one can answer for where it lands.
export function refInside(roots: ReadonlyArray<string>, ref: string) {
  const value = Str.trim(ref);
  if (value === "" || pipe(value, Str.includes(".."))) {
    return false;
  }
  if (!pipe(value, Str.startsWith("/"))) {
    return true;
  }
  return Arr.some(
    roots,
    (root) => root !== "" && (value === root || pipe(value, Str.startsWith(`${root}/`))),
  );
}

export function evidenceGaps(kind: Outcome, got: Collected) {
  return Arr.map(gapsOf(kind, got), (gap) => gap.text);
}

export function checkGaps(kind: Outcome, got: Collected) {
  return Arr.map(
    Arr.filter(gapsOf(kind, got), (gap) => gap.by === "check"),
    (gap) => gap.text,
  );
}

export function reviewGaps(kind: Outcome, got: Collected) {
  return Arr.map(
    Arr.filter(gapsOf(kind, got), (gap) => gap.by === "review"),
    (gap) => gap.text,
  );
}

type GapCloser = "check" | "review" | "measure" | "claim";

function gapsOf(kind: Outcome, got: Collected) {
  const gaps: Array<{ text: string; by: GapCloser }> = [];
  const check = (text: string) => gaps.push({ text, by: "check" });
  const claim = (text: string) => gaps.push({ text, by: "claim" });
  const judged = (key: string, text: string) => {
    if (!reviewerSays(got, key)) {
      gaps.push({ text, by: "review" });
    }
  };
  if (needsChecks(kind)) {
    for (const gap of approvedSetGaps(got)) {
      check(gap);
    }
  }

  switch (kind) {
    case "unspecified":
      break;
    case "feature": {
      const done = names(anyField(got, "tickets_done"));
      if (done.length === 0) {
        claim("no ticket is reported built (tickets_done is empty)");
      }
      judged("scope_met", "the review did not report scope_met: true for the agreed scope");
      // WARNING: a ticket's proof counts only as a pass on the tree in front of us, whoever collected it.
      for (const ticket of got.tickets) {
        for (const name of ticket.checks) {
          const proof = provedAtFinal(got, name);
          if (proof === "passed" || settledUnpassed(got, name)) {
            continue;
          }
          const earlier = passedOnlyBefore(got, name);
          check(
            proof === "searched"
              ? onlySearched(`${ticket.file} promised check "${name}"`)
              : `${ticket.file} promised check "${name}", which ${earlier === undefined ? "has no passing verification on this tree" : runAgain(earlier, "this tree")}`,
          );
        }
      }
      break;
    }
    case "bug": {
      // WARNING: a regression needs a fail then a pass on different trees: a reproduction that never failed proves nothing.
      const regression = Arr.filter(got.verifications, (v) => v.name === "regression");
      const reproduced = Arr.filter(regression, (v) => v.expect === "fail" && v.result === "pass");
      const before = Arr.filter(reproduced, (v) => earlierTree(v, got.final));
      if (reproduced.length === 0) {
        check(
          "no regression verification recorded with --expect fail, so the bug was never reproduced",
        );
      } else if (before.length === 0) {
        check(
          "the bug was only reproduced on the tree the fix is already on, so nothing shows it failing before the fix",
        );
      }
      const fix = checkProof(withoutSearches(got, "regression"), "regression");
      const fixedBy = fix.state === "passed" ? fix.last : undefined;
      const earlier = passedOnlyBefore(got, "regression");
      if (fixedBy === undefined) {
        check(
          lastPassedAtFinal(got, "regression")
            ? onlySearched("regression")
            : earlier === undefined
              ? "regression does not pass on the current tree, so the fix is not proven"
              : `regression ${runAgain(earlier, "the current tree, so the fix is not proven")}`,
        );
      } else if (before.length > 0 && !Arr.some(before, (v) => sameAsked(v, fixedBy))) {
        check(
          `the bug was reproduced by ${shown(before.at(-1)!)} but the fix is proven by ${shown(fixedBy)}: one command has to fail before the fix and pass after it`,
        );
      }
      const named = reproducedName(got);
      const greens = Arr.filter(
        withoutSearches(got, "regression").verifications,
        (one) => one.name === "regression" && passed(one) && one.expect !== "fail",
      );
      const green = fixedBy ?? Option.getOrUndefined(Arr.last(greens));
      const pair =
        green === undefined
          ? undefined
          : Option.getOrUndefined(Arr.findLast(before, (one) => sameAsked(one, green)));
      if (named === undefined) {
        if (pair === undefined) {
          claim("the Output does not name the verification that reproduced the bug");
        } else {
          check(
            `no Output names the reproduction, though "${pair.name}" failed before the fix and passed after it`,
          );
        }
      } else if (pair !== undefined && named !== pair.name) {
        check(
          `the Output names "${named}" as the reproduction, but "${pair.name}" is the one that failed before the fix and passed after it`,
        );
      }
      break;
    }
    case "refactor":
      judged("behavior_preserved", "the review did not report behavior_preserved: true");
      break;
    case "investigation": {
      const conclusion = anyField(got, "conclusion");
      if (!isString(conclusion) || Str.trim(conclusion) === "") {
        claim("the investigation reports no conclusion");
      }
      const refs = names(anyField(got, "evidence"));
      if (refs.length === 0) {
        claim("the conclusion is supported by no evidence references");
      }
      for (const ref of refs) {
        if (!got.insideRun(ref)) {
          claim(`evidence reference "${ref}" is outside this Run`);
        }
      }
      if (!isBoolean(anyField(got, "patch"))) {
        claim("the investigation does not say whether it produced a patch");
      }
      judged("supported", "the review did not report supported: true for the conclusion");
      break;
    }
    case "docs": {
      const documented = names(anyField(got, "documented_commands"));
      if (documented.length === 0) {
        claim("no documented command is named, so the instructions were never run");
      }
      for (const name of documented) {
        const proof = provedAtFinal(got, name);
        if (proof === "searched") {
          check(onlySearched(`documented command "${name}"`));
        } else if (proof === "unproved") {
          check(`documented command "${name}" has no passing verification on this tree`);
        }
      }
      judged("accurate", "the review did not report accurate: true for the instructions");
      break;
    }
    case "migration": {
      for (const name of ["migrate-up", "migrate-down"]) {
        // WARNING: rollback counts as migrate-down's proof, so a project that names it that way still proves it can go back.
        const proofs = Arr.map(name === "migrate-down" ? [name, "rollback"] : [name], (one) => ({
          one,
          proof: provedAtFinal(got, one),
        }));
        if (Arr.some(proofs, ({ proof }) => proof === "passed")) {
          continue;
        }
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
      if (!isString(issues) || Str.trim(issues) === "") {
        claim("the plan wrote no tickets");
      }
      break;
    }
    case "review": {
      const summary = anyField(got, "summary");
      if (!isString(summary) || Str.trim(summary) === "") {
        claim("the review has no summary a human can read");
      }
      break;
    }
    case "performance": {
      for (const text of finalMeasurementGaps(got)) {
        gaps.push({ text, by: "measure" });
      }
      for (const key of ["behavior_preserved", "measurement_valid"]) {
        if (reviewerSaysOfThisTree(got, key)) {
          continue;
        }
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

const isFinal = (tree: Snapshot, final: Snapshot) => sameTree(tree, final);

function reviewerSaysOfThisTree(got: Collected, key: string) {
  for (const [id, output] of got.outputs) {
    const tree = got.reviewedOn?.get(id);
    if (!got.reviewed.has(id) || tree === undefined || !isFinal(tree, got.final)) {
      continue;
    }
    if (isYamlMap(output) && key in output) {
      return output[key] === true;
    }
  }
  return false;
}

function finalMeasurementGaps(got: Collected) {
  const finals = Arr.filter(got.measurements ?? [], (one) => one.pass === "final");
  const here = Arr.filter(finals, (one) => isFinal(one.candidate, got.final));
  const proving = Option.getOrUndefined(
    Arr.findLast(here, (one) => one.base.commit === got.mergeBase),
  );
  if (finals.length === 0) {
    return ["no `final` Measurement was taken, so no gain is proved"];
  }
  if (here.length === 0) {
    return [`the latest \`final\` Measurement, ${finals.at(-1)!.id}, was taken on an earlier tree`];
  }
  if (proving === undefined) {
    const last = here.at(-1)!;
    return [
      got.mergeBase === null || got.mergeBase === undefined
        ? `the \`final\` Measurement ${last.id} cannot be held to a merge base: this checkout has none with the default branch`
        : `the \`final\` Measurement ${last.id} was taken against ${last.base.commit}, not the merge base ${got.mergeBase}`,
    ];
  }
  const result = proving.result;
  if (result._tag !== "Judged") {
    return [`the \`final\` Measurement ${proving.id} has no verdict: it ended ${result._tag}`];
  }
  const verdictOf = (metric: string) =>
    Option.getOrUndefined(Arr.findFirst(result.verdicts, (one) => one.metric === metric));
  const gaps: Array<string> = [];
  for (const metric of proving.plan.metrics) {
    const judged = verdictOf(metric.name);
    const verdict = judged?.verdict ?? "no verdict";
    if (metric.role === "primary") {
      if (verdict !== "gain") {
        gaps.push(
          `the \`final\` Measurement ${proving.id} shows ${metric.name} ${verdict}, not a gain`,
        );
      }
    } else if (judged === undefined || !judged.held || verdict === "inconclusive") {
      gaps.push(
        `guardrail ${metric.name} is not held in the \`final\` Measurement ${proving.id} (${verdict})`,
      );
    }
  }
  return gaps;
}

// WARNING: finishing without a patch is a real outcome for investigations and performance, not a failure.
export function endsWithoutPatch(kind: Outcome, got: Collected) {
  if (kind === "investigation") {
    return anyField(got, "patch") === false;
  }
  if (kind !== "performance") {
    return false;
  }
  const base = got.measurements?.at(-1)?.base;
  return (
    base !== undefined &&
    sameTree(base, got.final) &&
    base.content !== "" &&
    base.content === got.content
  );
}

export function renderEvidence(
  got: Pick<Collected, "verifications" | "final" | "measurements">,
  audience: "internal" | "public" = "internal",
) {
  const latest = new Map<string, Verification>();
  const command = (v: Verification) => CommandLine.display([v.asked ?? v.executable, ...v.argv]);
  for (const v of got.verifications) {
    if (!ranOneTest(v)) {
      latest.set(`${v.name}:${v.by}`, v);
    }
  }
  const measured = audience === "public" ? null : finalMeasurementLine(got.measurements ?? []);
  const lines = Arr.map([...latest.values()], (v) => {
    const stale = sameTree(v.end, got.final) ? "" : " (on an earlier tree)";
    const expected = v.expect === "fail" ? ", expected to fail" : "";
    if (audience === "public") {
      return `- \`${command(v)}\`: ${v.result} (exit ${v.exit}${expected})${stale}`;
    }
    return `- ${v.name}: ${v.result} (by ${v.by}${expected})${stale}`;
  });
  if (measured !== null) {
    lines.push(`- ${measured}`);
  }
  return lines.length === 0 ? "(nothing was verified)" : Arr.join(lines, "\n");
}

export interface LeftToCiState {
  readonly name: string;
  readonly job: string;
  readonly state: string | null;
}

export function renderRecordedChecks(
  got: Pick<Collected, "verifications" | "final">,
  leftToCi: ReadonlyArray<LeftToCiState> = [],
) {
  const latest = new Map<string, Verification>();
  const baseline = new Map<string, Verification>();
  for (const v of Arr.filter(got.verifications, (one) => !ranOneTest(one))) {
    if (v.pass === "baseline") {
      baseline.set(v.name, v);
    } else {
      latest.set(`${v.name}:${v.by}`, v);
    }
  }
  if (latest.size + baseline.size + leftToCi.length === 0) {
    return "(nothing is recorded for this Run)";
  }
  const onTree = (v: Verification) =>
    sameTree(v.end, got.final) ? "on this tree" : "on an earlier tree";
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
