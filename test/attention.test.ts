import { expect, test } from "bun:test";
import { Effect } from "effect";
import { attentionFor } from "../src/attention";
import { runEffect } from "./support/effect";
import { runFacts } from "./support/records";

const awaiting = {
  on: "CI and a teammate's approval on group/app!345",
  who: "a teammate",
  since: "2026-10-21T10:00:00.000Z",
};

test("a release Run awaiting CI and approval needs nobody, and says who acts", () =>
  runEffect(
    Effect.gen(function* () {
      const attention = yield* attentionFor(
        runFacts({ id: "r1", workflow: "release", dir: "/nowhere/r1", awaiting }),
      );
      expect(attention.category).toBe("none");
      expect(attention.reason).toBe("awaiting");
      expect(attention.explanation).toBe(
        "r1 is waiting for CI and a teammate's approval on group/app!345, which a teammate acts on.",
      );
    }),
  ));

test("a release Run parked on a red pipeline is still interrupted", () =>
  runEffect(
    Effect.gen(function* () {
      const red = "group/app!345 cannot be released: the pipeline at 1d538252 failed (lint).";
      const attention = yield* attentionFor(
        runFacts({
          id: "r1",
          dir: "/nowhere/r1",
          state: "waiting",
          parked: red,
          note: red,
          awaiting,
        }),
      );
      expect(attention.reason).toBe("parked");
    }),
  ));
