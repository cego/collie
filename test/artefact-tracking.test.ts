import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, FileSystem, Option } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type { Artefact } from "../src/artefact-model";
import { TestClock } from "effect/testing";
import { Artefacts } from "../src/artefacts";
import { madeRun } from "./support/records";
import { runEffect } from "./support/effect";
import { collie, proves } from "./support/world";
import { frontDoor, socketOf } from "../src/host";
import { Schema } from "effect";

test("explicit refresh bounds discovery and rotates registered sources", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir);
      const catalogue = yield* Artefacts;
      for (let n = 0; n < 24; n++)
        yield* fs.writeFileString(
          `${run.evidence}/${Str.padStart(2, "0")(String(n))}.txt`,
          `evidence ${n}`,
        );
      expect((yield* catalogue.reconcile(run)).items).toHaveLength(8);
      expect((yield* catalogue.reconcile(run)).items).toHaveLength(16);
      expect((yield* catalogue.reconcile(run)).items).toHaveLength(24);
      const tracked: Artefact[] = [];
      for (let n = 0; n < 24; n++) {
        const path = `${dir}/tracked-${n}.txt`;
        yield* fs.writeFileString(path, "first");
        tracked.push(
          (yield* catalogue.register(run, "inst", { path }, `track-${n}`, {
            origin: "cli",
            requestId: `track-${n}`,
          })).item,
        );
        yield* fs.writeFileString(path, "second");
      }
      const changed = () =>
        catalogue
          .list(run.id)
          .pipe(
            Effect.map(
              (items) =>
                Arr.filter(
                  items,
                  (item) => Arr.some(tracked, (one) => one.id === item.id) && item.revision === 2,
                ).length,
            ),
          );
      yield* catalogue.reconcile(run);
      expect(yield* changed()).toBe(8);
      yield* catalogue.reconcile(run);
      expect(yield* changed()).toBe(16);
      yield* catalogue.reconcile(run);
      expect(yield* changed()).toBe(24);
    }),
  ));

test("a stalled explicit refresh times out and releases catalogue writes while cached reads stay immediate", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir);
      const catalogue = yield* Artefacts;
      const path = `${dir}/tracked.txt`;
      yield* fs.writeFileString(path, "retained");
      const { item } = yield* catalogue.register(run, "inst", { path }, "tracked", {
        origin: "cli",
        requestId: "tracked",
      });
      const blocked = `${run.evidence}/blocked.md`;
      yield* fs.writeFileString(blocked, "# Stalled discovery");
      const entered = yield* Deferred.make<void>();
      const clock = yield* TestClock.make();
      yield* Effect.gen(function* () {
        const work = yield* catalogue.reconcile(run).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFile: (file) =>
              file === blocked
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : fs.readFile(file),
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        expect((yield* catalogue.cached(run)).items[0]?.digest).toBe(item.digest);
        const write = yield* catalogue
          .seen(run.id, item.id, 1, "read", { origin: "cli", requestId: "read" })
          .pipe(Effect.forkScoped);
        yield* clock.adjust(5001);
        expect(work.pollUnsafe()).toBeDefined();
        expect((yield* Fiber.join(work)).items[0]?.digest).toBe(item.digest);
        expect((yield* Fiber.join(write)).item.seen?.revision).toBe(1);
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }),
  ));

test(
  "the host returns a cold cached catalogue before discovery and bounds explicit refresh",
  () =>
    proves(
      "collie-cold-catalogue-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=cold"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data);
          yield* collie(world, ["run", "wait", runId]);
          const dir = `${world.state}/runs/${runId}/handoffs`;
          yield* fs.makeDirectory(dir, { recursive: true });
          for (let n = 0; n < 24; n++)
            yield* fs.writeFileString(`${dir}/${n}.md`, `# Finding ${n}\n`);
          const door = yield* frontDoor(socketOf(world.state));
          expect((yield* door.artefacts({ runId })).items.length).toBeLessThanOrEqual(8);
          expect(
            (yield* door.artefacts({ runId, refresh: true })).items.length,
          ).toBeLessThanOrEqual(16);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test("background passes track finished Runs and label overdue cached observations", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir, { state: "succeeded", finished: "2026-01-01T00:00:00Z" });
      const catalogue = yield* Artefacts;
      const clock = yield* TestClock.make();
      yield* clock.setTime(100_000);
      yield* Effect.gen(function* () {
        const path = `${dir}/tracked.txt`;
        yield* fs.writeFileString(path, "AAA");
        const { item } = yield* catalogue.register(run, "installation-one", { path }, "register", {
          origin: "cli",
          requestId: "register",
        });
        for (const [bytes, revision] of [
          ["BBB", 2],
          ["AAA", 3],
          ["AAA", 3],
        ] as const) {
          yield* fs.writeFileString(path, bytes);
          yield* clock.adjust(30_001);
          expect(
            Option.getOrThrow(
              Arr.findFirst((yield* catalogue.cached(run)).items, (one) => one.id === item.id),
            ).stale,
          ).toBe(true);
          yield* catalogue.pass([run]);
          expect(
            Option.getOrThrow(
              Arr.findFirst((yield* catalogue.cached(run)).items, (one) => one.id === item.id),
            ),
          ).toMatchObject({ revision, stale: false });
          expect(
            Buffer.from(
              (yield* catalogue.read(run, item.id, revision, 0)).content,
              "base64",
            ).toString(),
          ).toBe(bytes);
        }
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }),
  ));

test("bounded discovery rotates through every collection of a large finished Run", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(dir, { state: "succeeded" });
      const catalogue = yield* Artefacts;
      const clock = yield* TestClock.make();
      yield* clock.setTime(100_000);
      for (const root of [
        `${run.dir}/attachments`,
        `${run.dir}/plan`,
        run.evidence,
        `${run.dir}/handoffs`,
      ]) {
        yield* fs.makeDirectory(root, { recursive: true });
        for (let i = 0; i < 9; i++) yield* fs.writeFileString(`${root}/${i}.txt`, `${root}:${i}`);
      }
      yield* Effect.gen(function* () {
        for (let pass = 0; pass < 8; pass++) {
          yield* catalogue.pass([run]);
          yield* clock.adjust(30_001);
        }
        const items = yield* catalogue.list(run.id);
        expect(items).toHaveLength(36);
        expect(Arr.filter(items, (one) => one.role === "evidence")).toHaveLength(9);
        expect(Arr.filter(items, (one) => one.role === "handoff")).toHaveLength(9);
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }),
  ));
