import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { mrLabel } from "./board-model";
import type { Prerequisite } from "./plan";

/** A wait returns every one but `Waiting`; `Held` is a Hold or a Stop that ended it. */
export const PrerequisiteStandingSchema = Schema.Union([
  Schema.TaggedStruct("Landed", {}),
  Schema.TaggedStruct("Waiting", { on: Schema.String, who: Schema.String }),
  Schema.TaggedStruct("Never", { why: Schema.String }),
  Schema.TaggedStruct("Held", {}),
]);
export type PrerequisiteStanding = typeof PrerequisiteStandingSchema.Type;

/** What a Run near a Prerequisite was given and has done; a `change` of null is the default Change. */
export interface RunDetail {
  readonly repo: string;
  readonly change: string | null;
  readonly ended: boolean;
  readonly mr: string | null;
}

/** A recorded merge request as the forge and the fetched default branch say it is. */
export type MrLanding =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Merged"; readonly onDefault: boolean }
  | { readonly _tag: "Unreadable" };

export interface RunLine {
  readonly run: string;
  readonly parent: string | null;
}

function withDescendants(rows: ReadonlyArray<RunLine>, run: string): ReadonlyArray<string> {
  const family = [run];
  for (let at = 0; at < family.length; at++)
    for (const row of rows) if (row.parent === family[at]) family.push(row.run);
  return family;
}

/** The first Run of the named one's family in this repository and Change that recorded a merge request. */
export function mergeRequestFor(
  prerequisite: Prerequisite,
  repo: string,
  rows: ReadonlyArray<RunLine>,
  details: ReadonlyMap<string, RunDetail>,
): string | null {
  for (const run of withDescendants(rows, prerequisite.run)) {
    const detail = details.get(run);
    if (detail?.mr != null && detail.repo === repo && detail.change === prerequisite.change)
      return detail.mr;
  }
  return null;
}

const named = (prerequisite: Prerequisite) =>
  `${prerequisite.run}'s ${prerequisite.change ?? "Change"}`;

const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2
    ? Arr.join(parts, "")
    : `${Arr.join(parts.slice(0, -1), ", ")} and ${parts.at(-1)}`;

type One =
  | { readonly _tag: "Landed" }
  | { readonly _tag: "Waiting"; readonly prerequisite: Prerequisite; readonly mr: string | null }
  | { readonly _tag: "Never"; readonly why: string };

function oneOf(
  prerequisite: Prerequisite,
  asking: { readonly run: string; readonly repo: string },
  rows: ReadonlyArray<RunLine>,
  details: ReadonlyMap<string, RunDetail>,
  landings: ReadonlyMap<string, MrLanding>,
): One {
  const change = prerequisite.change ?? "Change";
  if (!Arr.some(rows, (row) => row.run === prerequisite.run))
    return {
      _tag: "Never",
      why: `${prerequisite.run} is not a Run on this host, so its ${change} cannot be waited on`,
    };
  const parentOf = new Map(Arr.map(rows, (row) => [row.run, row.parent] as const));
  for (let at: string | null | undefined = asking.run; at != null; at = parentOf.get(at))
    if (at === prerequisite.run)
      return {
        _tag: "Never",
        why: `${prerequisite.run} is this Run or one it came out of, so its ${change} cannot be waited on: name a ticket of this plan on **Blocked by:** instead`,
      };
  const mr = mergeRequestFor(prerequisite, asking.repo, rows, details);
  if (mr === null)
    return details.get(prerequisite.run)?.ended === true
      ? {
          _tag: "Never",
          why: `${prerequisite.run} ended with no merge request for its ${change}, so it can never land`,
        }
      : { _tag: "Waiting", prerequisite, mr: null };
  const landing = landings.get(mr);
  if (landing?._tag === "Closed")
    return {
      _tag: "Never",
      why: `${mrLabel(mr)}, ${named(prerequisite)}, was closed without merging, so it can never land`,
    };
  if (landing?._tag === "Merged" && landing.onDefault) return { _tag: "Landed" };
  return { _tag: "Waiting", prerequisite, mr };
}

/** The first that can never land, else every one still waiting, else Landed. */
export function judgePrerequisites(facts: {
  readonly asking: { readonly run: string; readonly repo: string };
  readonly prerequisites: ReadonlyArray<Prerequisite>;
  readonly rows: ReadonlyArray<RunLine>;
  readonly details: ReadonlyMap<string, RunDetail>;
  readonly landings: ReadonlyMap<string, MrLanding>;
}): Exclude<PrerequisiteStanding, { readonly _tag: "Held" }> {
  const ones = Arr.map(facts.prerequisites, (prerequisite) =>
    oneOf(prerequisite, facts.asking, facts.rows, facts.details, facts.landings),
  );
  const never = Arr.findFirst(ones, (one) => one._tag === "Never");
  if (Option.isSome(never)) return never.value;
  const waiting = Arr.filter(ones, (one) => one._tag === "Waiting");
  if (waiting.length === 0) return { _tag: "Landed" };
  const first = Option.getOrElse(
    Arr.findFirst(waiting, (one) => one.mr !== null),
    () => waiting[0]!,
  );
  return {
    _tag: "Waiting",
    on: `${listed(Arr.map(waiting, (one) => named(one.prerequisite)))} to merge`,
    who: first.mr === null ? first.prerequisite.run : mrLabel(first.mr),
  };
}
