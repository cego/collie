import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Option } from "effect";
import * as Arr from "effect/Array";
import { TestClock } from "effect/testing";
import { Artefacts } from "../src/artefacts";
import { madeRun } from "./support/records";
import { runEffect } from "./support/effect";

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
