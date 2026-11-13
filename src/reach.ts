// How far a Run goes before it asks: the Input a workflow hints as `reach`, and the choice
// a launch remembers for it per workflow and project, as a shared setting (ADR-0043).

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Schema } from "effect";
import type { Declared } from "./definitions-model";

export const REACH = "reach";

/** Every key of the setting family, `launch_reach.<workflow>.<project>`. */
export const REACH_SETTING = "launch_reach";

/** The front doors a human launches from, whose choice is remembered for the next launch. */
export const LAUNCH_DOORS: ReadonlyArray<string> = ["board", "desktop", "chat"];

export interface ReachChoice {
  readonly value: string;
  readonly title: string;
}

export interface Reach {
  readonly name: string;
  readonly choices: ReadonlyArray<ReachChoice>;
}

const Labelled = Schema.Struct({
  enum: Schema.Tuple([Schema.String]),
  title: Schema.optionalKey(Schema.String),
});
const Drawn = Schema.Struct({
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
});

const titled = (value: string, title: string | undefined): ReachChoice => ({
  value,
  title: title ?? (value === "" ? "Ask" : value),
});

/** The choices a drawn schema offers: titled literals, or a plain closed set. */
function choicesOf(schema: Declared["schema"]): ReadonlyArray<ReachChoice> {
  const drawn = Schema.decodeUnknownOption(Drawn)(schema);
  if (Option.isNone(drawn)) return [];
  if (drawn.value.enum !== undefined)
    return Arr.map(drawn.value.enum, (value) => titled(value, undefined));
  return Arr.flatMap(drawn.value.anyOf ?? [], (entry) =>
    Option.match(Schema.decodeUnknownOption(Labelled)(entry), {
      onNone: () => [],
      onSome: (one) => [titled(one.enum[0], one.title)],
    }),
  );
}

export function reachOf(inputs: ReadonlyArray<Declared>): Reach | null {
  const field = Option.getOrUndefined(Arr.findFirst(inputs, (one) => one.strategy === REACH));
  if (field === undefined) return null;
  const choices = choicesOf(field.schema);
  return choices.length === 0 ? null : { name: field.name, choices };
}

/** One dotted segment of a setting key, which a remote's own dots and slashes would split. */
const segment = (project: string) => pipe(encodeURIComponent(project), Str.replaceAll(".", "%2E"));

export const reachKey = (workflow: string, project: string) =>
  `${REACH_SETTING}.${workflow}.${segment(project)}`;

export const isReachKey = (key: string) => /^launch_reach\.[a-z][a-z0-9-]*\.[^.]+$/.test(key);

/** The choices with the saved one first, so Enter takes it; the rest keep the module's order. */
export function savedFirst(reach: Reach, saved: string | null): ReadonlyArray<ReachChoice> {
  const first = Arr.filter(reach.choices, (one) => one.value === saved);
  return [...first, ...Arr.filter(reach.choices, (one) => one.value !== saved)];
}
