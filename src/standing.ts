// What became of a Run's work, from what it left behind rather than from what ran it.
//
// A card says whether work is waiting on a human, ready to build from, or landed, and
// none of that may be read off a workflow's name: a project's own workflow that opens a
// merge request leaves exactly as much to land as the shipped one, and a fork that
// renames `plan` still writes tickets. So the facts are the branch, the merge request,
// the tickets and whatever a human or the forge has since said about them.

import * as Arr from "effect/Array";
import type { Disposition } from "./board-model";
import { epochMs } from "./time";

/** Says why a Run completed with nothing to land, in the Run's directory `dir`. */
export const nothingToLandFile = (dir: string) => `${dir}/nothing-to-land`;

/** What a Run left behind, as a card reads it. */
export interface WorkFacts {
  /** Whether it is over, whichever way it ended. */
  readonly settled: boolean;
  readonly succeeded: boolean;
  readonly branch: string | null;
  readonly mr: string | null;
  /** Something it owes is not settled, or one of its Runs is still going (`settlementOf`). */
  readonly owing: boolean;
  /** How many tickets it wrote, which is what makes a plan work to build from. */
  readonly planIssues: number;
  /** Somebody said what became of this work. */
  readonly disposed: boolean;
  /** A question of its own that nobody has answered. */
  readonly asking: boolean;
}

/** Whether this Run left anything anyone has to file: work to land, or work to build from. */
export function filed(facts: Pick<WorkFacts, "branch" | "mr" | "planIssues">): boolean {
  return facts.branch !== null || facts.mr !== null || facts.planIssues > 0;
}

/** How a card stands: what there is to file, what to build from, and what is over. */
export interface Standing {
  /** Ended leaving nothing anyone could file. Fifty such cards are not fifty obligations. */
  readonly unfiled: boolean;
  /** Succeeded with tickets and nothing else outstanding: somebody can build from it. */
  readonly planReady: boolean;
  readonly landed: boolean;
}

export function standingOf(facts: WorkFacts): Standing {
  const unfiled = facts.settled && !filed(facts) && !facts.asking;
  const planReady =
    facts.succeeded &&
    facts.planIssues > 0 &&
    facts.branch === null &&
    facts.mr === null &&
    !facts.disposed;
  // A plan owes nothing to a forge: what settles it is somebody saying what became of it.
  const answered = facts.branch !== null || facts.mr !== null || facts.disposed;
  return { unfiled, planReady, landed: unfiled || (facts.settled && !facts.owing && answered) };
}

/** Something a Task owes: a merge request its Runs carry, or a branch with none. */
export interface Owed {
  /** Its MR id; null for a branch, or a merge request no id can be told for. */
  readonly id: string | null;
  /** The Task's Runs that carry it. */
  readonly runs: ReadonlyArray<string>;
  /** What its forge last read it as; null where it has not been asked. */
  readonly forge: "open" | "merged" | "closed" | null;
}

/** A Disposition line of one of the Task's Runs, as settlement reads it. */
export interface Recorded {
  readonly run: string;
  readonly line: Disposition;
  /** The MR id its ref names, where it names one. */
  readonly mr: string | null;
  /** Its ref names a Run of another Task. */
  readonly elsewhere: boolean;
}

/** Whether something owed is settled, by what, and the line that settled it. */
export interface Settlement {
  /** Null while it is still owed. */
  readonly by: Disposition["kind"] | null;
  readonly line: Disposition | null;
}

/**
 * Whether `item` is settled (ADR-draft-a-task-lands-when-what-it-owes-is-settled): merged
 * on its forge, abandoned on a Run carrying it or on the Task's `leader`, recorded merged,
 * or superseded by a Run of another Task or while its forge reads it closed. Each Run's
 * latest line about it is that Run's answer.
 */
export function settlementOf(
  item: Owed,
  recorded: ReadonlyArray<Recorded>,
  leader: string,
): Settlement {
  const carries = (run: string) => item.runs.includes(run);
  const about = (one: Recorded) =>
    item.id === null
      ? carries(one.run) || one.run === leader
      : one.mr === item.id || (one.mr === null && (carries(one.run) || one.run === leader));
  const answers = new Map<string, Recorded>();
  for (const one of recorded) if (about(one)) answers.set(one.run, one);
  const latest = (kind: Disposition["kind"], where: (one: Recorded) => boolean = () => true) =>
    Arr.map(
      Arr.filter([...answers.values()], (one) => one.line.kind === kind && where(one)),
      (one) => one.line,
    )
      .sort((a, b) => epochMs(a.at) - epochMs(b.at))
      .at(-1) ?? null;
  if (item.forge === "merged") return { by: "merged", line: latest("merged") };
  const abandoned = latest("abandoned", (one) => carries(one.run) || one.run === leader);
  if (abandoned !== null) return { by: "abandoned", line: abandoned };
  const merged = latest("merged");
  if (merged !== null) return { by: "merged", line: merged };
  const handedOn =
    item.runs.length > 0 &&
    Arr.every(item.runs, (run) => {
      const one = answers.get(run);
      return one !== undefined && one.line.kind === "superseded" && one.elsewhere;
    });
  const superseded = handedOn || item.forge === "closed" ? latest("superseded") : null;
  if (superseded !== null) return { by: "superseded", line: superseded };
  return { by: null, line: null };
}
