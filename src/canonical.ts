import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Struct from "effect/Struct";
import { Schema, flow, Result } from "effect";
import { isArray, isRecord } from "./schema";

export const asJsonText = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

export type Given =
  | Schema.Json
  | ReadonlyArray<Given>
  | { readonly [key: string]: Given | undefined };

const isJson = Schema.is(Schema.Json);
const kept = <A>(one: A | undefined) => (one === undefined ? [] : [one]);

const plain: (value: Given) => Schema.Json | undefined = (value) => {
  if (value === undefined) {
    return undefined;
  }
  if (isArray(value)) {
    // WARNING: the check only says the members are unknown; they are what a command was given.
    return Arr.flatMap(value, (one) => kept(plain(one as Given)));
  }
  if (isRecord(value)) {
    return Rec.fromEntries(
      Arr.flatMap(Rec.toEntries(value), ([key, one]) =>
        // WARNING: the check only says the values are unknown; they are what a command was given.
        Arr.map(kept(plain(one as Given)), (kept) => [key, kept] as const),
      ),
    );
  }
  return isJson(value) ? value : String(value);
};

export const canonical = (value: Given) => asJsonText(ordered(plain(value) ?? null));

const ordered: (value: Schema.Json) => Schema.Json = (value) => {
  if (Arr.isArray<typeof value>(value)) {
    return Arr.map(value, ordered);
  }
  if (!Schema.is(Schema.Record(Schema.String, Schema.Json))(value)) {
    return value;
  }
  return Rec.fromEntries(
    Arr.map(Struct.keys(value).sort(), (key) => [key, ordered(value[key] ?? null)] as const),
  );
};
