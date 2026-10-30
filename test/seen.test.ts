// A finished Run's report is seen once for the Flock, by whoever opens or acknowledges it,
// and never by someone reading it (ADR-draft-a-finished-run-is-seen-once-for-the-flock).

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { connect, frontDoor, socketOf } from "../src/host";
import { runDir } from "../src/engine";
import { readSeen } from "../src/seen";
import { epochMs } from "../src/time";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Board = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      run: Schema.String,
      state: Schema.String,
      unseen: Schema.optional(Schema.Boolean),
    }),
  ),
});

const taskOf = (world: World, runId: string) =>
  collie(world, ["board"]).pipe(
    Effect.map(
      (printed) =>
        Option.getOrUndefined(
          Arr.findFirst(
            flow(Schema.decodeUnknownResult(Board), Result.getOrThrow)(printed.envelope.data).tasks,
            (task) => task.run === runId,
          ),
        ) ?? null,
    ),
  );

test(
  "seen is recorded once, as whoever asked, however often and under however many requests",
  () =>
    proves(
      "collie-seen-",
      (world) =>
        Effect.gen(function* () {
          const host = yield* connect(world.state);
          const { runId } = yield* host.start({
            project: world.project,
            id: "plain",
            request: "start-1",
            input: { note: "hi" },
          });
          const door = yield* frontDoor(socketOf(world.state));
          yield* door.declare({ frontDoor: "cli-tty" });

          const first = yield* door.seen({ runId, request: "seen-1" });
          expect(first.by).toBe("human:seen-1");
          expect(yield* door.seen({ runId, request: "seen-1" })).toEqual(first);
          expect(yield* door.seen({ runId, request: "seen-2" })).toEqual(first);
          expect(yield* readSeen(runDir(world.state, runId))).toEqual([first]);
          expect(
            (yield* door.seen({ runId: "r-nobody", request: "seen-3" }).pipe(Effect.flip)).reason,
          ).toBe("no Run r-nobody");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test("the moment seen began is written by a host's first start and kept by the next", () =>
  proves(
    "collie-seen-since-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const since = `${world.state}/seen-since`;
        yield* connect(world.state);
        const first = yield* fs.readFileString(since);
        expect(Number.isFinite(epochMs(first))).toBe(true);
        yield* stopHost(world.state);
        yield* connect(world.state);
        expect(yield* fs.readFileString(since)).toBe(first);
        yield* stopHost(world.state);
      }).pipe(Effect.orDie),
    ["plain.workflow.ts"],
  ));

test(
  "a finished Run read by `run show` and `collie_run` is still unseen, and `run seen` sees it",
  () =>
    proves(
      "collie-seen-read-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          const finished = yield* until(
            () => taskOf(world, runId),
            (task) => task?.state === "done",
          );
          expect(finished?.unseen).toBe(true);

          expect((yield* collie(world, ["run", "show", runId])).envelope.ok).toBe(true);
          expect(
            (yield* collie(world, [
              "tools",
              "call",
              "collie_run",
              "--input",
              asJson({ run: runId }),
            ])).envelope.ok,
          ).toBe(true);
          expect((yield* taskOf(world, runId))?.unseen).toBe(true);
          expect(yield* readSeen(runDir(world.state, runId))).toEqual([]);

          const seen = yield* collie(world, ["run", "seen", runId, "--request-id", "seen-cli"]);
          expect(seen.envelope.ok).toBe(true);
          expect(
            (yield* until(
              () => taskOf(world, runId),
              (task) => task?.unseen !== true,
            ))?.unseen,
          ).toBe(false);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["plain.workflow.ts"],
    ),
  120_000,
);
