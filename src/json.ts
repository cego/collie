import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Struct from "effect/Struct";
import { Result, Schema } from "effect";

const encode = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeIndented = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

export const stringifyJson = <A>(value: A, indent?: 2) =>
  Result.getOrThrow((indent === undefined ? encode : encodeIndented)(value));

const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const ordered: (value: Schema.Json) => Schema.Json = (value) => {
  if (Arr.isArray<typeof value>(value)) {
    return Arr.map(value, ordered);
  }
  if (!isJsonRecord(value)) {
    return value;
  }
  return Rec.fromEntries(
    Arr.map(Struct.keys(value).sort(), (key) => [key, ordered(value[key] ?? null)] as const),
  );
};

export const canonicalJson = (value: Schema.Json) => stringifyJson(ordered(value));

export const parseJson = <S extends Schema.Decoder<unknown>>(schema: S, text: string) =>
  Result.getOrThrow(Schema.decodeResult(Schema.fromJsonString(schema))(text));
