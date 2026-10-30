// Which of a Run's agents a steer or a correction reaches. Pure, so the host and its tests
// decide the same way.

/** One launch, and whether the work it was given has its Output yet. */
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

/** The names `--to` takes for a role, and the launch roles each covers. */
export const ROLES = {
  builder: BUILDER_ROLES,
  reviewer: ["reviewer"],
  planner: ["planner"],
} satisfies Record<string, ReadonlyArray<string>>;

const rolesFor = (to: string): ReadonlyArray<string> | undefined =>
  Option.getOrUndefined(Arr.findFirst(Rec.toEntries(ROLES), ([name]) => name === to))?.[1];

export interface Asked {
  readonly to?: string | undefined;
  readonly operation?: string | undefined;
  readonly agent?: string | undefined;
}

/**
 * The launch a message reaches. Named, it is that agent, operation or role. Otherwise it is
 * the agent whose step is active, then the builder, then whoever was launched last.
 */
export function steerTarget<C extends Candidate>(
  launches: ReadonlyArray<C>,
  asked: Asked,
  launchedAs: (one: C, name: string) => boolean = () => false,
): C | undefined {
  const { agent, operation, to } = asked;
  const named = (one: C, name: string) =>
    one.operation === name || one.agent === name || launchedAs(one, name);
  if (agent !== undefined)
    return Option.getOrUndefined(
      Arr.findLast(launches, (one) => one.agent === agent || launchedAs(one, agent)),
    );
  if (operation !== undefined)
    return Option.getOrUndefined(Arr.findLast(launches, (one) => named(one, operation)));
  const roles = to === undefined ? undefined : rolesFor(to);
  if (to !== undefined && roles === undefined)
    return Option.getOrUndefined(Arr.findLast(launches, (one) => named(one, to)));
  const newest = Arr.filter(
    launches,
    (one, at) => !Arr.some(launches.slice(at + 1), (later) => later.agent === one.agent),
  );
  const among =
    roles === undefined ? newest : Arr.filter(newest, (one) => roles.includes(one.role));
  const active = Option.getOrUndefined(Arr.findLast(among, (one) => !one.done));
  if (active !== undefined || roles !== undefined) return active ?? among.at(-1);
  return (
    Option.getOrUndefined(Arr.findLast(among, (one) => BUILDER_ROLES.includes(one.role))) ??
    launches.at(-1)
  );
}
