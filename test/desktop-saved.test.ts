import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";
import { dropBoardsOf, savedBoards, saving } from "../desktop/src/bun/saved";
import type { MachineMessage } from "../desktop/src/shared/flock";
import { runEffect } from "./support/effect";
import { task } from "./support/task";

const machine = { installation: "inst-1", profile: "local", name: "mk-pc" };
const UPSERTS = 50;

test("a busy board saves its Machine once a second, as it last stood", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-saved-" });
      const told: ReadonlyArray<MachineMessage> = [
        {
          machine,
          message: {
            _tag: "Snapshot",
            installation: machine.installation,
            build: "0.31.0",
            protocol: 1,
            herds: [],
            tasks: [],
            seq: 1,
          },
        },
        ...Arr.map(Arr.range(1, UPSERTS), (n) => ({
          machine,
          message: { _tag: "Upsert" as const, seq: n + 1, task: task({ id: "t1", age: `${n}m` }) },
        })),
      ];
      let saves = 0;
      let passed = 0;
      const all = yield* Deferred.make<void>();
      const saved = yield* Deferred.make<void>();
      yield* saving(dir)(Stream.fromIterable(told).pipe(Stream.concat(Stream.never))).pipe(
        Stream.tap(() =>
          ++passed === told.length ? Deferred.succeed(all, undefined) : Effect.void,
        ),
        Stream.runDrain,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.andThen(Effect.sync(() => saves++)),
                Effect.andThen(Deferred.succeed(saved, undefined)),
              ),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(all);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(saved);

      const [board] = yield* savedBoards(dir);
      expect(saves).toBe(1);
      expect(Arr.map(board?.tasks ?? [], ({ age }) => age)).toEqual([`${UPSERTS}m`]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("a Machine removed while its board is being saved is not saved again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-saved-" });
      const snapshot: MachineMessage = {
        machine,
        message: {
          _tag: "Snapshot",
          installation: machine.installation,
          build: "0.31.0",
          protocol: 1,
          herds: [],
          tasks: [],
          seq: 1,
        },
      };
      const renaming = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const renamed = yield* Deferred.make<void>();
      const told = yield* Deferred.make<void>();
      yield* saving(dir)(Stream.make(snapshot).pipe(Stream.concat(Stream.never))).pipe(
        Stream.tap(() => Deferred.succeed(told, undefined)),
        Stream.runDrain,
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            Deferred.succeed(renaming, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.andThen(fs.rename(from, to)),
              Effect.ensuring(Deferred.succeed(renamed, undefined)),
            ),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(told);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(renaming);

      // Started at once, so it waits for the save's permit before the rename is let go.
      const removing = yield* dropBoardsOf(dir, machine.profile).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(resume, undefined);
      yield* Deferred.await(renamed);
      yield* Fiber.join(removing);

      expect(yield* savedBoards(dir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));
