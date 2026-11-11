// Why a Run parked, from one closed list, and what each cause lets the host do about it
// (ADR-draft-a-run-recovers-where-it-parks).

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Schema } from "effect";
import type { Metric } from "./metrics";

export const ParkCause = Schema.Literals([
  "output-absent",
  "idle-budget",
  "ci-job-absent",
  "forge-unavailable",
  "herdr-unavailable",
  "checkout-dirty-collie",
  "checkout-dirty-human",
  "login-missing",
  "branch-force-pushed",
  "release-failed",
  "gate-fix-unproved",
  "unknown",
]);
export type ParkCause = typeof ParkCause.Type;

export const ParkKind = Schema.Literals(["asks-agent", "rechecks", "needs-you"]);
export type ParkKind = typeof ParkKind.Type;

/** A park as a reader shows it. */
export const Park = Schema.Struct({
  cause: ParkCause,
  kind: ParkKind,
  id: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.String),
  history: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Park = typeof Park.Type;

type Entry =
  | { readonly kind: "asks-agent"; readonly message: string }
  | { readonly kind: "rechecks" }
  | {
      readonly kind: "needs-you";
      readonly reason: string;
      /** Only a person can act on it, so no Heal is started for it. */
      readonly neverHeals?: true;
    };

export const PARK_CAUSES: Readonly<Record<ParkCause, Entry>> = {
  "output-absent": {
    kind: "needs-you",
    reason: "its agent ended its turns without writing its Output",
  },
  "idle-budget": {
    kind: "needs-you",
    reason: "its agent went quiet for longer than its idle budget, and nothing says why",
  },
  "ci-job-absent": { kind: "rechecks" },
  "forge-unavailable": { kind: "rechecks" },
  "herdr-unavailable": { kind: "rechecks" },
  "checkout-dirty-collie": { kind: "rechecks" },
  "checkout-dirty-human": {
    kind: "needs-you",
    reason: "its checkout holds changes Collie did not make, and only you may keep or drop them",
    neverHeals: true,
  },
  "login-missing": {
    kind: "needs-you",
    reason: "a login it needs is missing, and only you can log in",
    neverHeals: true,
  },
  "branch-force-pushed": {
    kind: "needs-you",
    reason: "its branch was pushed over, and only you may say which history stands",
    neverHeals: true,
  },
  "release-failed": { kind: "needs-you", reason: "its release did not complete" },
  "gate-fix-unproved": {
    kind: "needs-you",
    reason: "its gate fixes ran out without proving the outcome",
  },
  unknown: { kind: "needs-you", reason: "nothing names why it parked" },
};

export const parkOf = (cause: ParkCause): Park => ({ cause, kind: PARK_CAUSES[cause].kind });

export const recoveryLine = (line: Metric) =>
  `${line.at}: ${line.action} ${line.outcome} — ${line.note}`;

export const parkWithRecovery = (park: Park, actions: ReadonlyArray<Metric>): Park => {
  const same = Arr.filter(actions, (line) => line.cause === park.cause);
  const tries = Arr.filter(same, (line) => line.action === "resumed" && line.outcome !== "skipped");
  const exhausted = tries.length >= 3 && Arr.every(tries, (line) => line.park !== park.id);
  const history = Arr.map(
    [...Arr.filter(same, (line) => line.action === "rechecked").slice(-20), ...tries].sort((a, b) =>
      Str.localeCompare(b.at)(a.at),
    ),
    recoveryLine,
  );
  return { ...park, kind: exhausted ? "needs-you" : park.kind, history };
};

const KIND_SAID: Readonly<Record<ParkKind, string>> = {
  "asks-agent": "Collie asks its agent",
  rechecks: "Collie rechecks",
  "needs-you": "needs you",
};

export const parkLine = (park: Park): string => `Parked: ${park.cause} · ${KIND_SAID[park.kind]}`;
