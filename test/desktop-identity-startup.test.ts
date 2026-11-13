import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Cause, Clock, Effect, Exit, Fiber, FileSystem, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { openDoors } from "../desktop/src/bun/machine";
import { platformLayer } from "../src/platform";
import { until } from "./support/host";

const fixture = new URL("./fixtures/identity-bridge.ts", import.meta.url).pathname;
const EventLine = Schema.fromJsonString(
  Schema.Struct({ event: Schema.String, pid: Schema.Int, as: Schema.String }),
);

const eventsAt = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.forEach(
      Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== ""),
      (line) => Schema.decodeEffect(EventLine)(line),
    );
  });

const identityWasAsked = (path: string) =>
  until(
    () => eventsAt(path),
    (events) => Arr.some(events, (event) => event.event === "identity"),
  ).pipe(Effect.timeout("5 seconds"));

const fixturesExited = (path: string) =>
  Effect.gen(function* () {
    const pids = Arr.map(
      Arr.filter(yield* eventsAt(path), (event) => event.event === "ready"),
      (event) => event.pid,
    );
    expect(pids).toHaveLength(3);
    const alive = Effect.sync(() =>
      Arr.filter(pids, (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    );
    expect(
      yield* until(
        () => alive,
        (remaining) => remaining.length === 0,
      ).pipe(Effect.timeout("3 seconds")),
    ).toEqual([]);
  });

const opening = (mode: string, events: string) =>
  openDoors({ profile: "vm", name: "vm-mk", route: "link" }, (as) => [
    process.execPath,
    fixture,
    mode,
    events,
    as,
  ]);

test(
  "startup identity: a malformed identity fails as one unreachable route and closes its bridges",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "collie-startup-identity-" });
          const events = `${home}/events.jsonl`;
          const result = yield* opening("malformed", events).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isSuccess(result)) return;
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toMatchObject({
            state: "unreachable",
          });
          yield* fixturesExited(events);
        }),
      ).pipe(Effect.provide(platformLayer)),
    ),
  10_000,
);

test(
  "startup identity: a ready bridge whose host stays silent is bounded at five seconds and closed",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const liveClock = yield* Clock.Clock;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const home = yield* fs.makeTempDirectoryScoped({ prefix: "collie-startup-identity-" });
            const events = `${home}/events.jsonl`;
            const pending = yield* opening("silent", events).pipe(Effect.exit, Effect.forkChild);
            yield* identityWasAsked(events).pipe(Effect.provideService(Clock.Clock, liveClock));
            expect(pending.pollUnsafe()).toBeUndefined();
            yield* TestClock.adjust("5 seconds");
            const result = yield* Fiber.join(pending);
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isSuccess(result)) return;
            expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toMatchObject({
              state: "unreachable",
              reason: "the host did not identify itself within 5 seconds",
            });
            yield* fixturesExited(events).pipe(Effect.provideService(Clock.Clock, liveClock));
          }),
        ).pipe(Effect.provide(TestClock.layer()));
      }).pipe(Effect.provide(platformLayer)),
    ),
  10_000,
);
