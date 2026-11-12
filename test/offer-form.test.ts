// An offer's form, read from the JSON Schema its arguments are drawn as: which control each
// field takes, and what a human's entries send, or why they cannot be sent.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { jsonSchemaFor } from "../src/sdk";
import { asksBeforeTaking, offerChoices, offerFields, offerInput } from "../src/board-model";

const drawn: Schema.Json = {
  type: "object",
  properties: {
    notify: { type: "boolean", description: "Tell the channel" },
    confirmed: { type: "boolean" },
    then: { type: "string", enum: ["", "finish", "release"], description: "What follows" },
    count: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
    ratio: {
      anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
    },
    reviewers: { type: "array", items: { type: "string" } },
    note: { type: "string", default: "as it is" },
    extra: { type: "object" },
  },
  required: ["confirmed", "note"],
};

test("each field takes the control its schema draws, with its label, help, default and whether it is needed", () => {
  expect(
    Arr.map(offerFields(drawn), (field) => [
      field.name,
      field.label,
      field.control.kind,
      field.required,
      field.help,
      field.initial,
    ]),
  ).toEqual([
    ["notify", "Notify", "boolean", false, "Tell the channel", undefined],
    ["confirmed", "Confirmed", "boolean", true, null, "false"],
    ["then", "Then", "enum", false, "What follows", undefined],
    ["count", "Count", "integer", false, null, undefined],
    ["ratio", "Ratio", "number", false, null, undefined],
    ["reviewers", "Reviewers", "list", false, null, undefined],
    ["note", "Note", "text", true, null, "as it is"],
    ["extra", "Extra", "json", false, null, undefined],
  ]);
  const then = offerFields(drawn)[2]!.control;
  expect(then).toEqual({ kind: "enum", options: ["", "finish", "release"] });
  expect(offerFields({ properties: { merge_only: {} } })[0]!.label).toBe("Merge only");
});

test("entries are sent as their fields take them: false is false, an unset option is left out, and an empty choice is a choice", () => {
  expect(
    offerInput(drawn, {
      notify: "false",
      confirmed: "true",
      then: "",
      count: " 3 ",
      ratio: "0.5",
      reviewers: "alice\n\n bob \n",
      note: "kept",
      extra: '{"a":1}',
    }),
  ).toEqual({
    _tag: "Valid",
    input: {
      notify: false,
      confirmed: true,
      then: "",
      count: 3,
      ratio: 0.5,
      reviewers: ["alice", "bob"],
      note: "kept",
      extra: { a: 1 },
    },
  });
  expect(offerInput(drawn, { confirmed: "false", note: "x" })).toEqual({
    _tag: "Valid",
    input: { confirmed: false, note: "x" },
  });
});

test("an entry its field cannot take is refused with why, and nothing malformed is sent as text", () => {
  expect(
    offerInput(drawn, {
      notify: "maybe",
      then: "later",
      count: "2.5",
      ratio: "lots",
      note: "",
      extra: "{a:1",
    }),
  ).toEqual({
    _tag: "Invalid",
    errors: {
      notify: "Notify must be yes or no",
      confirmed: "Confirmed needs a value",
      then: "Then must be one of: (empty), finish, release",
      count: "Count must be a whole number",
      ratio: "Ratio must be a number",
      note: "Note needs a value",
      extra: "Extra is not valid JSON",
    },
  });
  expect(offerInput(drawn, { confirmed: "true", note: "x", extra: "[1]" })).toEqual({
    _tag: "Invalid",
    errors: { extra: "Extra must be a JSON object" },
  });
});

test("an offer with a confirmation is asked about before it is taken, even with nothing to fill", () => {
  const offer = { arguments: null };
  expect(asksBeforeTaking(offer)).toBe(false);
  expect(asksBeforeTaking({ ...offer, confirm: "Merges it and stops." })).toBe(true);
  expect(asksBeforeTaking({ arguments: { properties: { note: { type: "string" } } } })).toBe(true);
});

test("an optional choice can be left unset, a required one cannot, and an empty option is shown as one", () => {
  const [notify, confirmed, then] = offerFields(drawn);
  expect(Arr.map(offerChoices(notify!), (one) => [one.label, one.entry])).toEqual([
    ["Not set", undefined],
    ["Yes", "true"],
    ["No", "false"],
  ]);
  expect(Arr.map(offerChoices(confirmed!), (one) => one.entry)).toEqual(["true", "false"]);
  expect(Arr.map(offerChoices(then!), (one) => [one.label, one.entry])).toEqual([
    ["Not set", undefined],
    ["(empty)", ""],
    ["finish", "finish"],
    ["release", "release"],
  ]);
  expect(new Set(Arr.map(offerChoices(then!), (one) => one.key)).size).toBe(4);
});

test("an enum of numbers, booleans or null is a choice of exactly those values, sent as themselves", () => {
  const priorities: Schema.Json = {
    type: "object",
    properties: {
      priority: { type: "number", enum: [1, 2], default: 2 },
      mode: { enum: ["fast", true, null] },
    },
  };
  const [priority, mode] = offerFields(priorities);
  expect(priority!.control).toEqual({ kind: "enum", options: [1, 2] });
  expect(priority!.initial).toBe("2");
  expect(Arr.map(offerChoices(mode!), (one) => [one.label, one.entry])).toEqual([
    ["Not set", undefined],
    ["fast", "fast"],
    ["true", "true"],
    ["null", "null"],
  ]);
  expect(offerInput(priorities, { priority: "1", mode: "true" })).toEqual({
    _tag: "Valid",
    input: { priority: 1, mode: true },
  });
  expect(offerInput(priorities, { priority: "3", mode: "slow" })).toEqual({
    _tag: "Invalid",
    errors: {
      priority: "Priority must be one of: 1, 2",
      mode: "Mode must be one of: fast, true, null",
    },
  });
  const mixed = jsonSchemaFor(Schema.Struct({ level: Schema.Literals(["low", 1, true]) })).document;
  expect(offerFields(mixed)[0]!.control).toEqual({ kind: "enum", options: ["low", 1, true] });
  expect(offerInput(mixed, { level: "1" })).toEqual({ _tag: "Valid", input: { level: 1 } });
  expect(offerInput(mixed, { level: "2" })).toEqual({
    _tag: "Invalid",
    errors: { level: "Level must be one of: low, 1, true" },
  });
});

test("an enum holding a string and a value that writes the same is still a choice between the two", () => {
  const sdk = jsonSchemaFor(
    Schema.Struct({ pick: Schema.Literals(["1", 1, "true", true]) }),
  ).document;
  const drawn: Schema.Json = {
    type: "object",
    properties: { pick: { enum: ["null", null, "{}", {}] } },
  };
  const picked = (schema: Schema.Json) => {
    const [pick] = offerFields(schema);
    const entries = Arr.flatMap(offerChoices(pick!), (one) =>
      one.entry === undefined ? [] : [one.entry],
    );
    const labels = Arr.map(offerChoices(pick!), (one) => one.label);
    return {
      distinct: new Set(entries).size === entries.length && new Set(labels).size === labels.length,
      sent: Arr.map(entries, (entry) => {
        const read = offerInput(schema, { pick: entry });
        return read._tag === "Valid" ? read.input.pick : read;
      }),
    };
  };
  expect(picked(sdk)).toEqual({ distinct: true, sent: ["1", 1, "true", true] });
  expect(picked(drawn)).toEqual({ distinct: true, sent: ["null", null, "{}", {}] });
});
