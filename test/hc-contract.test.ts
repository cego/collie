// Collie decodes core's replies with the schemas in `src/hc.ts`. This holds them to the
// `hc.openrpc.json` the pin names: every reply that schema allows has to decode, so a
// renamed, retyped or newly optional field turns a test red instead of a Run.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { describe, expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import { replies } from "../src/hc";
import { hasMethod, jsonText, pin, replySamples, schemaVersion } from "./support/hc-schema";

/** Each reply the schema allows that `decoder` refuses, named with why. */
const refused = (method: string, decoder: Schema.Decoder<unknown>) =>
  Arr.flatMap(replySamples(method), (reply) => {
    const exit = Schema.decodeExit(decoder)(reply);
    return Exit.isSuccess(exit)
      ? []
      : [`${method} refused ${jsonText(reply)}: ${String(exit.cause)}`];
  });

test("the schema is the release the pin names", () => {
  expect(schemaVersion).toBe(pin.version);
});

describe("every reply the pinned schema allows decodes", () => {
  for (const [method, decoder] of Rec.toEntries(replies)) {
    test(method, () => {
      expect(hasMethod(method)).toBe(true);
      expect(refused(method, decoder)).toEqual([]);
    });
  }
});

// hc 0.1.14 leaves `machines` out although the schema requires it; the probe is what
// catches that. Here, a decoder stricter than the schema is refused by name.
test("a decoder requiring a field the schema leaves optional is refused, naming the reply", () => {
  const strict = Schema.Struct({
    ...replies["terminal.read"].fields,
    why: Schema.NullOr(Schema.String),
  });
  expect(refused("terminal.read", strict)).toEqual([
    expect.stringMatching(
      /^terminal\.read refused \{"complete":false,"how":"s","text":"s"\}: .*why/s,
    ),
  ]);
});
