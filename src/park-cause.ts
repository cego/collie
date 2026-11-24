import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Schema, pipe } from "effect";
import type { Metric } from "./metrics";

export const ParkCause = Schema.Literals([
  "output-absent",
  "idle-budget",
  "usage-wait",
  "ci-job-absent",
  "ci-failed",
  "target-red",
  "forge-unavailable",
  "herdr-unavailable",
  "delivery-unsettled",
  "checkout-dirty-collie",
  "checkout-dirty-human",
  "login-missing",
  "branch-force-pushed",
  "release-failed",
  "review-blocked",
  "gate-fix-unproved",
  "step-failed",
  "predecessor-not-quiet",
  "predecessor-locked",
  "predecessor-unproven",
  "hand-over-stale",
  "unknown",
]);
export type ParkCause = typeof ParkCause.Type;

export const ParkKind = Schema.Literals(["asks-agent", "rechecks", "needs-you"]);
export type ParkKind = typeof ParkKind.Type;

export const Park = Schema.Struct({
  cause: ParkCause,
  kind: ParkKind,
  id: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.String),
  history: Schema.optionalKey(Schema.Array(Schema.String)),
  healing: Schema.optionalKey(Schema.String),
});
export type Park = typeof Park.Type;

type Entry =
  | { readonly kind: "asks-agent"; readonly message: string }
  | { readonly kind: "rechecks"; readonly neverHeals?: true }
  | { readonly kind: "needs-you"; readonly reason: string; readonly neverHeals?: true };

export const PARK_CAUSES: Readonly<Record<ParkCause, Entry>> = {
  "output-absent": {
    kind: "needs-you",
    reason: "its agent ended its turns without writing its Output",
  },
  "idle-budget": {
    kind: "needs-you",
    reason: "its agent went quiet for longer than its idle budget, and nothing says why",
  },
  "usage-wait": { kind: "rechecks", neverHeals: true },
  "ci-job-absent": { kind: "rechecks" },
  "ci-failed": { kind: "rechecks", neverHeals: true },
  "target-red": { kind: "rechecks" },
  "forge-unavailable": { kind: "rechecks" },
  "herdr-unavailable": { kind: "rechecks", neverHeals: true },
  "delivery-unsettled": { kind: "rechecks", neverHeals: true },
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
  "review-blocked": {
    kind: "needs-you",
    reason:
      "its merge request is held back by a reviewer or the forge, and its Review wait goes on by itself once that is repaired",
    neverHeals: true,
  },
  "gate-fix-unproved": {
    kind: "needs-you",
    reason: "its gate fixes ran out without proving the outcome",
  },
  "step-failed": {
    kind: "needs-you",
    reason: "a Step failed on something to correct, and a resume enters it again",
  },
  "predecessor-not-quiet": { kind: "rechecks", neverHeals: true },
  "predecessor-locked": { kind: "rechecks", neverHeals: true },
  "predecessor-unproven": {
    kind: "needs-you",
    reason: "an agent that had to stop could not be proven stopped, and was left running",
    neverHeals: true,
  },
  "hand-over-stale": { kind: "rechecks", neverHeals: true },
  unknown: { kind: "needs-you", reason: "nothing names why it parked" },
};

export const parkOf = (cause: ParkCause) => ({ cause, kind: PARK_CAUSES[cause].kind });

export const parkText = (text: string) =>
  pipe(
    text,
    Str.replaceAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>"),
    Str.replaceAll(/\b(?=[0-9a-f-]*\d)[0-9a-f]{7,}(?:-[0-9a-f]+)*\b/gi, "<id>"),
    Str.replaceAll(/\d+/g, "<n>"),
  );

export const parkIdentity = (run: string, cause: ParkCause, evidence: ReadonlyArray<string>) =>
  `${cause}-${Bun.hash(Arr.join([run, cause, ...evidence], "\u0000")).toString(16)}`;

const healLines = (ids: ReadonlyArray<string>, recoveries: ReadonlyArray<Metric>) =>
  Arr.filter(
    recoveries,
    (line) => line.action === "healed" && line.park !== undefined && ids.includes(line.park),
  );

export const healNth = (park: string, recoveries: ReadonlyArray<Metric>) =>
  new Set(Arr.map(healLines([park], recoveries), (line) => line.recoveryId ?? line.at)).size + 1;

// WARNING: ids also carries a park's identities from before they were derived.
export const healOwed = (ids: ReadonlyArray<string>, recoveries: ReadonlyArray<Metric>) => {
  const lines = healLines(ids, recoveries);
  const skipped = new Set(
    Arr.map(
      Arr.filter(lines, (line) => line.outcome === "skipped"),
      (line) => line.recoveryId,
    ),
  );
  const heals = Arr.filter(
    lines,
    (line) =>
      line.outcome !== "skipped" &&
      (line.recoveryId === undefined || !skipped.has(line.recoveryId)),
  );
  return heals.length === 0 || heals.at(-1)?.diagnosisComplete === false;
};

export const recoveryLine = (line: Metric) =>
  `${line.at}: ${line.action} ${line.outcome} — ${line.note}`;

export const healInFlight = (line: Metric) =>
  line.action === "healed" && (line.outcome === "claimed" || line.outcome === "started");

export const parkWithRecovery = (park: Park, actions: ReadonlyArray<Metric>) => {
  const same = Arr.filter(actions, (line) => line.cause === park.cause);
  const tries = Arr.filter(same, (line) => line.action === "resumed" && line.outcome !== "skipped");
  // WARNING: tries before this park began still count when the same park is entered again.
  const exhausted =
    tries.length >= 3 &&
    Arr.every(
      tries,
      (line) =>
        line.park !== park.id || (park.since !== undefined && (line.since ?? line.at) < park.since),
    );
  const heals = Arr.filter(
    actions,
    (line) => line.action === "healed" && line.park === park.id && line.outcome !== "skipped",
  );
  const history = Arr.map(
    [
      ...Arr.filter(same, (line) => line.action === "rechecked").slice(-20),
      ...tries,
      ...Arr.filter(heals, (line) => !healInFlight(line)),
    ].sort((a, b) => Str.localeCompare(b.at)(a.at)),
    recoveryLine,
  );
  const healing = Arr.findFirst(actions, (line) => healInFlight(line) && line.heal !== undefined);
  return {
    ...park,
    kind: exhausted ? "needs-you" : park.kind,
    history,
    ...(healing._tag === "Some" && { healing: healing.value.heal }),
  };
};

const KIND_SAID: Readonly<Record<ParkKind, string>> = {
  "asks-agent": "Collie asks its agent",
  rechecks: "Collie rechecks",
  "needs-you": "needs you",
};

export const parkLine = (park: Park) =>
  park.healing === undefined
    ? `Parked: ${park.cause} · ${KIND_SAID[park.kind]}`
    : `Parked: ${park.cause} · being healed by ${park.healing}`;
