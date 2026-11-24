import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
export interface Candidate {
  readonly agent: string;
  readonly operation: string;
  readonly role: string;
  readonly done: boolean;
}

const BUILDER_ROLES: ReadonlyArray<string> = ["implementer"];

export const ROLES = {
  builder: BUILDER_ROLES,
  reviewer: ["reviewer"],
  planner: ["planner"],
} satisfies Record<string, ReadonlyArray<string>>;

const rolesFor = (to: string) =>
  Option.getOrUndefined(Arr.findFirst(Rec.toEntries(ROLES), ([name]) => name === to))?.[1];

export interface Asked {
  readonly to?: string | undefined;
  readonly operation?: string | undefined;
  readonly agent?: string | undefined;
}

export function steerTarget<C extends Candidate>(
  launches: ReadonlyArray<C>,
  asked: Asked,
  launchedAs: (one: C, name: string) => boolean = () => false,
  live: (one: C) => boolean = () => true,
) {
  const { agent, operation, to } = asked;
  const named = (one: C, name: string) =>
    one.operation === name || one.agent === name || launchedAs(one, name);
  if (agent !== undefined) {
    return Option.getOrUndefined(
      Arr.findLast(launches, (one) => one.agent === agent || launchedAs(one, agent)),
    );
  }
  if (operation !== undefined) {
    return Option.getOrUndefined(Arr.findLast(launches, (one) => named(one, operation)));
  }
  const roles =
    to === undefined
      ? undefined
      : (rolesFor(to) ?? (Arr.some(launches, (one) => one.role === to) ? [to] : undefined));
  if (to !== undefined && roles === undefined) {
    return Option.getOrUndefined(Arr.findLast(launches, (one) => named(one, to)));
  }
  const newest = Arr.filter(
    launches,
    (one, at) => !Arr.some(launches.slice(at + 1), (later) => later.agent === one.agent),
  );
  const among =
    roles === undefined ? newest : Arr.filter(newest, (one) => roles.includes(one.role));
  // WARNING: a role goes to an agent herdr still lists, since an exited one recorded later is not a target at all.
  const stillThere = Arr.filter(among, live);
  const pool = stillThere.length === 0 ? among : stillThere;
  const active = Option.getOrUndefined(Arr.findLast(pool, (one) => !one.done));
  if (active !== undefined || roles !== undefined) {
    return active ?? pool.at(-1);
  }
  return (
    Option.getOrUndefined(Arr.findLast(among, (one) => BUILDER_ROLES.includes(one.role))) ??
    launches.at(-1)
  );
}
