import { Result, Schema } from "effect";

const encode = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeIndented = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

export const stringifyJson = <A>(value: A, indent?: 2) =>
  Result.getOrThrow((indent === undefined ? encode : encodeIndented)(value));

export const parseJson = <S extends Schema.Decoder<unknown>>(schema: S, text: string) =>
  Result.getOrThrow(Schema.decodeResult(Schema.fromJsonString(schema))(text));
