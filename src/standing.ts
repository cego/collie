import * as Arr from "effect/Array";
import type { Disposition } from "./board-model";
import { epochMs } from "./time";

export const NOTHING_TO_LAND = "nothing-to-land";

export interface WorkFacts {
  readonly settled: boolean;
  readonly succeeded: boolean;
  readonly branch: string | null;
  readonly mr: string | null;
  readonly owing: boolean;
  readonly planIssues: number;
  readonly disposed: boolean;
  readonly asking: boolean;
}

export function filed(facts: Pick<WorkFacts, "branch" | "mr" | "planIssues">) {
  return facts.branch !== null || facts.mr !== null || facts.planIssues > 0;
}

export interface Standing {
  readonly unfiled: boolean;
  readonly planReady: boolean;
  readonly landed: boolean;
}

export function standingOf(facts: WorkFacts) {
  const unfiled = facts.settled && !filed(facts) && !facts.asking;
  const planReady =
    facts.succeeded &&
    facts.planIssues > 0 &&
    facts.branch === null &&
    facts.mr === null &&
    !facts.disposed;
  const answered = facts.branch !== null || facts.mr !== null || facts.disposed;
  return { unfiled, planReady, landed: unfiled || (facts.settled && !facts.owing && answered) };
}

export interface Owed {
  readonly id: string | null;
  readonly runs: ReadonlyArray<string>;
  readonly forge: "open" | "merged" | "closed" | null;
  readonly read: number | null;
}

export interface Recorded {
  readonly run: string;
  readonly line: Disposition;
  readonly mr: string | null;
  readonly elsewhere: boolean;
}

export interface Settlement {
  readonly by: Disposition["kind"] | null;
  readonly line: Disposition | null;
}

export function settlementOf(item: Owed, recorded: ReadonlyArray<Recorded>, leader: string) {
  const carries = (run: string) => item.runs.includes(run);
  const about = (one: Recorded) =>
    item.id === null
      ? carries(one.run) || (one.run === leader && one.line.kind === "abandoned")
      : one.mr === item.id ||
        (one.mr === null &&
          (carries(one.run) || (one.run === leader && one.line.kind === "abandoned")));
  const answers = new Map<string, Recorded>();
  for (const one of recorded) if (about(one)) answers.set(one.run, one);
  const latest = (kind: Disposition["kind"], where: (one: Recorded) => boolean = () => true) =>
    Arr.map(
      Arr.filter([...answers.values()], (one) => one.line.kind === kind && where(one)),
      (one) => one.line,
    )
      .sort((a, b) => epochMs(a.at) - epochMs(b.at))
      .at(-1) ?? null;
  if (item.forge === "merged") {
    const returned: Settlement = { by: "merged", line: latest("merged") };
    return returned;
  }
  const abandoned = latest("abandoned", (one) => carries(one.run) || one.run === leader);
  if (abandoned !== null) {
    const returned: Settlement = { by: "abandoned", line: abandoned };
    return returned;
  }
  const merged = latest("merged");
  const reopened =
    merged !== null && item.forge === "open" && (item.read ?? -Infinity) > epochMs(merged.at);
  if (merged !== null && !reopened) {
    const returned: Settlement = { by: "merged", line: merged };
    return returned;
  }
  const handedOn =
    item.runs.length > 0 &&
    Arr.every(item.runs, (run) => {
      const one = answers.get(run);
      return one !== undefined && one.line.kind === "superseded" && one.elsewhere;
    });
  const superseded = handedOn || item.forge === "closed" ? latest("superseded") : null;
  if (superseded !== null) {
    const returned: Settlement = { by: "superseded", line: superseded };
    return returned;
  }
  const returned: Settlement = { by: null, line: null };
  return returned;
}
