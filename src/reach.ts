import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Schema } from "effect";
import type { Declared } from "./definitions-model";

export const REACH = "reach";

export const REACH_SETTING = "launch_reach";

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

const titled = (value: string, title: string | undefined) => ({
  value,
  title: title ?? (value === "" ? "Ask" : value),
});

function choicesOf(schema: Declared["schema"]) {
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

export function reachOf(inputs: ReadonlyArray<Declared>) {
  const field = Option.getOrUndefined(Arr.findFirst(inputs, (one) => one.strategy === REACH));
  if (field === undefined) return null;
  const choices = choicesOf(field.schema);
  return choices.length === 0 ? null : { name: field.name, choices };
}

const segment = (project: string) => pipe(encodeURIComponent(project), Str.replaceAll(".", "%2E"));

export const reachKey = (workflow: string, project: string) =>
  `${REACH_SETTING}.${workflow}.${segment(project)}`;

export const isReachKey = (key: string) => /^launch_reach\.[a-z][a-z0-9-]*\.[^.]+$/.test(key);

export function savedFirst(reach: Reach, saved: string | null) {
  const first = Arr.filter(reach.choices, (one) => one.value === saved);
  return [...first, ...Arr.filter(reach.choices, (one) => one.value !== saved)];
}
