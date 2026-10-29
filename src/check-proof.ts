import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
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
  /** The Run's Checks' commands as they resolve here; a record of exactly one counts for it, whoever asked. */
  readonly commands?: ReadonlyArray<CheckCommand>;
  /** The Run's Checks, which say which are left to CI where `commands` is not given. */
  readonly approved?: ReadonlyArray<LeftToCi>;
}

type LeftToCi = {
  readonly name: string;
  readonly ci?: string;
  readonly argv?: ReadonlyArray<string>;
};

export interface CheckProof {
  /** A check left to CI is only ever `waiting` on its job or `proved` by it. */
  readonly state: "passed" | "failed" | "unstable" | "earlier" | "never" | "waiting" | "proved";
  /** Every run of the Check's own command, oldest first. */
  readonly runs: ReadonlyArray<Verification>;
  /** The latest of them on this tree. */
  readonly last: Verification | undefined;
}

/**
 * Whose records count, by name, for a Check whose command is not given: anyone's, or only
 * the runs Collie made itself.
 */
export type Unmatched = "anyone" | "collie";

export function checkProof(
  got: Journal,
  name: string,
  unmatched: Unmatched = "anyone",
): CheckProof {
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
      Arr.findLast(jobs, (v) => !staleAgainst(v, got.final) && passed(v)),
    );
    return { state: proof === undefined ? "waiting" : "proved", runs: jobs, last: proof };
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
  return { state: stateOf(runs, last), runs, last };
}

function stateOf(runs: ReadonlyArray<Verification>, last: Verification | undefined) {
  if (last !== undefined && passed(last)) return "passed";
  const latest = last ?? runs.at(-1);
  if (latest === undefined) return "never";
  if (latest.result === "fail" || latest.expect === "fail") return "failed";
  if (latest.result === "unstable") return "unstable";
  return "earlier";
}

/** Whether a proof leaves a local run nothing to close: a pass here, or a check left to CI. */
export const owesNothingHere = (proof: CheckProof) =>
  proof.state === "passed" || proof.state === "waiting" || proof.state === "proved";

/** The Checks a Run runs itself: all but those left to CI. */
export const owedLocally = <C extends LeftToCi>(checks: ReadonlyArray<C>): ReadonlyArray<C> =>
  Arr.filter(checks, (check) => check.ci === undefined);
