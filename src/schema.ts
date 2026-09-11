import { Schema } from "effect";

export const isString = Schema.is(Schema.String);
export const isNumber = Schema.is(Schema.Number);

export const isArray = Schema.is(Schema.Array(Schema.Unknown));
export const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
export const isBoolean = Schema.is(Schema.Boolean);
