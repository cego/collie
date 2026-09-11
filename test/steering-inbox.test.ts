// The inbox is how anything outside a Run changes it, and the two things that must not
// happen are here: a command addressed to the work being thrown away with the Driver
// that happened to be running, and a command addressed to a dead Driver killing the
// next one. The stale-stop reproduction is the second of those.

import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearPreviousDriver, inboxFiles, readInboxMidStep } from "../src/driver";
import { writeInbox } from "../src/operations";
import { runEffect } from "./support/effect";

let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      dir = yield* fs.makeTempDirectory({ prefix: "hw-inbox-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ),
);

const names = Effect.fn("test.names")(function* () {
  const path = yield* Path.Path;
  return (yield* inboxFiles(dir)).map((file) => path.basename(file));
});

test("every command type round trips through the inbox", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeInbox(dir, { type: "hold", requestId: "a", reason: "wrong branch" });
      yield* writeInbox(dir, { type: "release", requestId: "b", reason: "fixed" });
      yield* writeInbox(dir, { type: "intent_changed", requestId: "c", version: 2 });
      yield* writeInbox(dir, {
        type: "deliver",
        requestId: "d",
        deliver: {
          deliveryId: "del-1",
          incarnation: "term-1",
          agent: "impl-1",
          text: "stay inside src/",
          mode: "boundary",
          cause: { kind: "correction", ref: "c1" },
          intentVersion: 2,
          attempt: 1,
        },
      });
      yield* writeInbox(dir, {
        type: "drift_report",
        requestId: "e",
        report: { id: "dr-1", constraint: "c1" },
        vector: { intentVersion: 2, cardId: null },
      });

      const { taken, unreadable } = yield* readInboxMidStep(dir);
      expect(unreadable).toEqual([]);
      expect(taken.map((c) => c.type)).toEqual([
        "hold",
        "release",
        "intent_changed",
        "deliver",
        "drift_report",
      ]);
      expect(taken[3]?.deliver?.text).toBe("stay inside src/");
      expect(taken[4]?.vector).toEqual({ intentVersion: 2, cardId: null });
      // Taken means taken: nothing is acted on twice.
      expect(yield* names()).toEqual([]);
    }),
  ));

test("a mid-step read leaves an answer for the Choice that will ask for it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeInbox(dir, {
        type: "answer",
        requestId: "a",
        choiceId: "run-1",
        answer: "Build it now",
      });
      yield* writeInbox(dir, { type: "hold", requestId: "b", reason: "hold on" });

      const { taken } = yield* readInboxMidStep(dir);
      expect(taken.map((c) => c.type)).toEqual(["hold"]);
      expect(yield* names()).toEqual(["a.json"]);
    }),
  ));

test("a command this build cannot read is left where a later one may read it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(dir, "inbox"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "inbox", "future.json"),
        `{"type":"teleport","requestId":"x"}\n`,
      );

      const { taken, unreadable } = yield* readInboxMidStep(dir);
      expect(taken).toEqual([]);
      expect(unreadable).toHaveLength(1);
      expect(yield* names()).toEqual(["future.json"]);
    }),
  ));

test("a new Driver keeps what was addressed to the work and drops what was addressed to the last one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeInbox(dir, { type: "stop", requestId: "stop-1" });
      yield* writeInbox(dir, { type: "hold", requestId: "hold-1", reason: "old hold" });
      yield* writeInbox(dir, { type: "release", requestId: "rel-1", reason: "old release" });
      yield* writeInbox(dir, { type: "answer", requestId: "ans-1", choiceId: "gone", answer: "x" });
      yield* writeInbox(dir, { type: "resume", requestId: "res-1" });
      yield* writeInbox(dir, { type: "intent_changed", requestId: "int-1", version: 3 });
      yield* writeInbox(dir, {
        type: "deliver",
        requestId: "del-1",
        deliver: {
          deliveryId: "d1",
          incarnation: "term-1",
          agent: "impl-1",
          text: "keep going",
          mode: "boundary",
          cause: { kind: "steer", ref: "s1" },
          intentVersion: 3,
          attempt: 1,
        },
      });

      // The resume that started this Driver is read back out before the clear.
      expect(yield* clearPreviousDriver(dir)).toBe("res-1");
      expect((yield* names()).sort()).toEqual(["del-1.json", "int-1.json"]);
    }),
  ));

test("a stop written mid-step does not outlive the Driver it was meant for", () =>
  runEffect(
    Effect.gen(function* () {
      // The reproduction the comment on `clearPreviousDriver` describes: a stop arrives
      // while a Driver is mid-step, that Driver dies before any Choice reads it, and the
      // next Driver's first question used to find the stop and kill itself — which made
      // any Workflow that asks a question unresumable.
      yield* writeInbox(dir, { type: "stop", requestId: "stop-1" });

      yield* clearPreviousDriver(dir);
      expect(yield* names()).toEqual([]);

      // And the new Driver's own mid-step read finds nothing to signal on.
      const { taken } = yield* readInboxMidStep(dir);
      expect(taken).toEqual([]);
    }),
  ));
