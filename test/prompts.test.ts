// What a waiting Driver does with the Run directory. filePrompts is the Driver's only
// way to receive an answer or a stop while a Choice is pending, so each case here
// drives it directly rather than through a Run.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { BunServices } from "@effect/platform-bun";
import { runEffect } from "./support/effect";
import { CHOICE, CHOICE_ANSWER, filePrompts, readChoice } from "../src/driver";

let dir: string;

type TestError = Error | PlatformError.PlatformError | Schema.SchemaError;
type TestServices = BunServices.BunServices | Scope.Scope;

const effectTest = (
  name: string,
  body: () => Generator<Effect.Effect<unknown, TestError, TestServices>, void, unknown>,
) => test(name, () => runEffect(Effect.gen(body).pipe(Effect.scoped)), 20_000);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      dir = yield* fs.makeTempDirectory({ prefix: "collie-prompts-" });
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

const MENU = [
  { id: "one", title: "One" },
  { id: "two", title: "Two" },
];

/** The question file is written only after filePrompts has subscribed its watches. */
const pendingChoice = Effect.fn("test.pendingChoice")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const changes = yield* Stream.toQueue(fs.watch(dir), { capacity: "unbounded" });
  const already = yield* readChoice(dir);
  if (already) return already;
  const found = yield* Stream.fromQueue(changes).pipe(
    Stream.mapEffect(() => readChoice(dir)),
    Stream.filter((choice) => choice !== null),
    Stream.runHead,
    Effect.timeout("2 seconds"),
  );
  if (Option.isNone(found)) return yield* Effect.fail(new Error("no choice was written"));
  return found.value;
});

const InboxCommandJson = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    requestId: Schema.String,
    choiceId: Schema.optionalKey(Schema.String),
    answer: Schema.optionalKey(Schema.String),
  }),
);
const ChoiceAnswerJson = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, text: Schema.optionalKey(Schema.String) }),
);

const writeInboxAnswer = Effect.fn("test.writeInboxAnswer")(function* (
  choiceId: string,
  answer: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inbox = path.join(dir, "inbox");
  yield* fs.makeDirectory(inbox, { recursive: true });
  // Written the way operations.writeInbox writes: a temp file, then a rename.
  const target = path.join(inbox, "req-1.json");
  yield* fs.writeFileString(
    `${target}.tmp`,
    `${Schema.encodeSync(InboxCommandJson)({ type: "answer", requestId: "req-1", choiceId, answer })}\n`,
  );
  yield* fs.rename(`${target}.tmp`, target);
});

effectTest("an answer in the inbox arrives on a watch event, not on the next tick", function* () {
  // The tick cannot fire inside the timeout, so only FileSystem.watch can deliver
  // this. Before the watch, a 30s poll meant a 30s wait for an answer already there.
  const watching = yield* Deferred.make<void>();
  const prompts = filePrompts({
    dir,
    run: "r",
    step: () => "next",
    timeoutMs: 8_000,
    pollMs: 30_000,
    onWatching: Deferred.succeed(watching, undefined).pipe(Effect.asVoid),
  });
  const asked = yield* Effect.forkScoped(prompts.menu(MENU, { header: "Pick" }));
  const choice = yield* pendingChoice();
  yield* Deferred.await(watching);

  const started = yield* Clock.currentTimeMillis;
  yield* writeInboxAnswer(choice.id, "two");
  const picked = yield* Fiber.join(asked);
  const took = (yield* Clock.currentTimeMillis) - started;

  expect(picked).toEqual({ id: "two", title: "Two" });
  // Delivered by the watch, so promptly — not on a tick that cannot fire this side of
  // the timeout, and not by the one tick that fires at subscription.
  expect(took).toBeLessThan(2_000);
});

effectTest("an answer written straight to the Run dir arrives the same way", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const watching = yield* Deferred.make<void>();
  // choice-answer.json is a child of the Run dir, not the inbox, and the Control Plane
  // writes it. Both directories are watched because the watch is not recursive.
  const prompts = filePrompts({
    dir,
    run: "r",
    step: () => "next",
    timeoutMs: 8_000,
    pollMs: 30_000,
    onWatching: Deferred.succeed(watching, undefined).pipe(Effect.asVoid),
  });
  const asked = yield* Effect.forkScoped(prompts.ask("What?"));
  const choice = yield* pendingChoice();
  yield* Deferred.await(watching);

  yield* fs.writeFileString(
    path.join(dir, CHOICE_ANSWER),
    `${Schema.encodeSync(ChoiceAnswerJson)({ id: choice.id, text: "typed" })}\n`,
  );
  expect(yield* Fiber.join(asked)).toBe("typed");
});

effectTest(
  "a stop in the inbox is consumed and raised as this process's own SIGTERM",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The Driver signals itself so one path records what a stop does to the Run. This
    // test stands in for that Driver, so it has to catch the signal it asked for.
    const signalled = yield* Deferred.make<void>();
    const onSigterm = () => {
      Effect.runFork(Deferred.succeed(signalled, undefined));
    };
    process.once("SIGTERM", onSigterm);

    try {
      const prompts = filePrompts({
        dir,
        run: "r",
        step: () => "next",
        timeoutMs: 3_000,
        pollMs: 50,
      });
      const asked = yield* Effect.forkScoped(prompts.menu(MENU, { header: "Pick" }));
      yield* pendingChoice();

      const inbox = path.join(dir, "inbox");
      yield* fs.makeDirectory(inbox, { recursive: true });
      yield* fs.writeFileString(
        path.join(inbox, "stop-1.json"),
        `${Schema.encodeSync(InboxCommandJson)({ type: "stop", requestId: "stop-1" })}\n`,
      );

      yield* Deferred.await(signalled).pipe(Effect.timeout("2 seconds"));
      // Consumed, so a later Driver cannot find it and stop itself over again.
      expect(yield* fs.readDirectory(inbox)).toEqual([]);
      yield* Fiber.interrupt(asked);
    } finally {
      process.off("SIGTERM", onSigterm);
    }
  },
);

effectTest("a question nobody answers times out, and takes its choice file with it", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prompts = filePrompts({ dir, run: "r", step: () => "next", timeoutMs: 300, pollMs: 50 });

  const started = yield* Clock.currentTimeMillis;
  expect(yield* prompts.menu(MENU, { header: "Pick" })).toBeNull();
  const took = (yield* Clock.currentTimeMillis) - started;

  // Bounded by timeoutMs, not by the poll interval, and not left pending for ever.
  expect(took).toBeGreaterThanOrEqual(250);
  expect(took).toBeLessThan(5_000);
  expect(yield* fs.exists(path.join(dir, CHOICE))).toBe(false);
});

effectTest("the wait survives its watched directories being replaced underneath it", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const watching = yield* Deferred.make<void>();
  const prompts = filePrompts({
    dir,
    run: "r",
    step: () => "next",
    timeoutMs: 8_000,
    pollMs: 60,
    onWatching: Deferred.succeed(watching, undefined).pipe(Effect.asVoid),
  });
  const asked = yield* Effect.forkScoped(prompts.menu(MENU, { header: "Pick" }));
  const choice = yield* pendingChoice();
  yield* Deferred.await(watching);

  // The inbox is removed and remade while the wait is running, which is what a resume
  // rebuilding a Run directory looks like from here.
  //
  // This does not prove the tick: Bun re-establishes the watch across a replacement,
  // so this case passes with the tick removed too. Nothing here fails without it. The
  // tick stays because the spec treats watch events as invalidation hints rather than
  // guarantees, and a hint the platform drops should cost latency and not the answer —
  // but that is a belief about platforms, not something this suite demonstrates.
  const inbox = path.join(dir, "inbox");
  yield* fs.remove(inbox, { recursive: true, force: true });
  yield* fs.makeDirectory(inbox, { recursive: true });
  yield* writeInboxAnswer(choice.id, "one");

  expect(yield* Fiber.join(asked)).toEqual({ id: "one", title: "One" });
});
