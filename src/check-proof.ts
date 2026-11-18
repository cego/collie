import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  movedLine,
  passed,
  ranCommand,
  ranOneTest,
  sameCommand,
  staleAgainst,
  type CheckCommand,
  type Snapshot,
  type Verification,
} from "./verify";

export interface Journal {
  readonly verifications: ReadonlyArray<Verification>;
  readonly final: Snapshot;
  readonly commands?: ReadonlyArray<CheckCommand>;
  readonly approved?: ReadonlyArray<LeftToCi>;
}

type LeftToCi = {
  readonly name: string;
  readonly ci?: string;
  readonly argv?: ReadonlyArray<string>;
};

export interface CheckProof {
  readonly state: "passed" | "failed" | "unstable" | "earlier" | "never" | "waiting" | "proved";
  readonly runs: ReadonlyArray<Verification>;
  readonly last: Verification | undefined;
}

export type Unmatched = "anyone" | "collie";

export function checkProof(got: Journal, name: string, unmatched: Unmatched = "anyone") {
  const command = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(got.commands), (present) =>
      Option.getOrUndefined(Arr.findFirst(present, (one) => one.name === name)),
    ),
  );
  const check =
    command ??
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(got.approved), (present_) =>
        Option.getOrUndefined(Arr.findFirst(present_, (one) => one.name === name)),
      ),
    );
  if (check?.ci !== undefined) {
    const jobs = Arr.filter(
      got.verifications,
      (v) =>
        v.name === name &&
        v.pass === "ci" &&
        v.by === "collie" &&
        v.job?.name === check.ci &&
        (command === undefined
          ? check.argv === undefined || sameCommand(v, { ...v, argv: check.argv })
          : sameCommand(v, { ...command, executable: command.executable ?? v.executable })),
    );
    const proof = Option.getOrUndefined(
      Arr.findLast(
        jobs,
        (v) => v.end.head_sha === got.final.head_sha && !staleAgainst(v, got.final) && passed(v),
      ),
    );
    const returned: CheckProof = {
      state: proof === undefined ? "waiting" : "proved",
      runs: jobs,
      last: proof,
    };
    return returned;
  }
  const runs = Arr.filter(
    got.verifications,
    (v) =>
      !ranOneTest(v) &&
      (command === undefined
        ? v.name === name && (unmatched === "anyone" || v.by === "collie")
        : ranCommand(v, command)),
  );
  const last = Option.getOrUndefined(Arr.findLast(runs, (v) => !staleAgainst(v, got.final)));
  const returned: CheckProof = { state: stateOf(runs, last), runs, last };
  return returned;
}

function stateOf(runs: ReadonlyArray<Verification>, last: Verification | undefined) {
  if (last !== undefined && passed(last)) return "passed";
  const latest = last ?? runs.at(-1);
  if (latest === undefined) return "never";
  if (last === undefined && latest.expect === "fail") return "earlier";
  if (latest.result === "fail" || latest.expect === "fail") return "failed";
  if (latest.result === "unstable") return "unstable";
  return "earlier";
}

export const owesNothingHere = (proof: CheckProof) =>
  proof.state === "passed" || proof.state === "waiting" || proof.state === "proved";

export const owedLocally = <C extends LeftToCi>(checks: ReadonlyArray<C>) =>
  Arr.filter(checks, (check) => check.ci === undefined);

export function unstableWhy(runs: ReadonlyArray<Verification>) {
  const latest = Option.getOrUndefined(Arr.findLast(runs, (v) => v.result === "unstable"));
  const reason = latest?.end.unmeasured ?? latest?.start.unmeasured ?? "";
  const moved = latest === undefined ? "" : movedLine(latest);
  return Option.match(Arr.findFirst(Arr.map(Str.split(reason, "\n"), Str.trim), Str.isNonEmpty), {
    onNone: () => `ran on a tree that moved under it${moved === "" ? "" : `: ${moved}`}`,
    onSome: (line) => `ran on a tree git could not measure: ${line}`,
  });
}
