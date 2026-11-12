// The Rune spike's Rust types are generated from today's Schemas; a Schema changed without
// regenerating them turns this red.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { GENERATED, REGENERATE, rustTypes } from "../tools/rune-types";
import { runEffect } from "./support/effect";

test(`the checked-in Rust types are what \`${REGENERATE}\` makes of today's Schemas`, () =>
  runEffect(
    Effect.gen(function* () {
      const checkedIn = yield* Effect.promise(() => Bun.file(GENERATED).text());
      expect(checkedIn).toBe(yield* rustTypes);
    }),
  ));
