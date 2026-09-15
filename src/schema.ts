import { Schema } from "effect";

export const isString = Schema.is(Schema.String);
export const isNumber = Schema.is(Schema.Number);

export const isArray = Schema.is(Schema.Array(Schema.Unknown));
export const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
export const isBoolean = Schema.is(Schema.Boolean);

/** A JSON object, as a tool's arguments and a JSON Schema document both are. */
export type JsonObject = { readonly [key: string]: Schema.Json };
export const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
