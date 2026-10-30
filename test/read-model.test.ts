import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { makeReadModel } from "../src/read-model";
import { runEffect } from "./support/effect";

test("unchanged Run files are reused, and a host write invalidates only that Run", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      for (const id of ["a", "b"]) {
        yield* fs.makeDirectory(`${dir}/runs/${id}`, { recursive: true });
        yield* fs.writeFileString(`${dir}/runs/${id}/report.json`, id);
      }
      let reads = 0;
      const model = yield* makeReadModel(dir).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) =>
            Effect.sync(() => reads++).pipe(Effect.andThen(fs.readFileString(path, encoding))),
        }),
      );
      const a = `${dir}/runs/a/report.json`;
      const b = `${dir}/runs/b/report.json`;
      expect(yield* model.reading.readFileString(a)).toBe("a");
      expect(yield* model.reading.readFileString(b)).toBe("b");
      expect(yield* model.reading.readFileString(a)).toBe("a");
      expect(reads).toBe(2);
      yield* model.writing.writeFileString(a, "changed");
      expect(yield* model.reading.readFileString(a)).toBe("changed");
      expect(yield* model.reading.readFileString(b)).toBe("b");
      expect(reads).toBe(3);
    }),
  ));

test("a read overtaken by a write retries instead of publishing its old value", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const path = `${dir}/runs/a/report.json`;
      yield* fs.makeDirectory(`${dir}/runs/a`, { recursive: true });
      yield* fs.writeFileString(path, "before");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const model = yield* makeReadModel(dir).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file) =>
            Effect.gen(function* () {
              const text = yield* fs.readFileString(file);
              if (++reads === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return text;
            }),
        }),
      );
      const reader = yield* model.reading.readFileString(path).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* model.writing.writeFileString(path, "after");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(reader)).toBe("after");
      expect(yield* model.reading.readFileString(path)).toBe("after");
    }),
  ));

test("external creation, rename and deletion invalidate negative reads and directory inputs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const run = `${dir}/runs/a`;
      yield* fs.makeDirectory(run, { recursive: true });
      const model = yield* makeReadModel(dir);
      expect(yield* model.reading.exists(`${run}/hold`)).toBe(false);
      expect(yield* model.reading.readDirectory(run)).toEqual([]);
      yield* fs.writeFileString(`${run}/hold`, "");
      yield* model.invalidate(`${run}/hold`);
      expect(yield* model.reading.exists(`${run}/hold`)).toBe(true);
      expect(yield* model.reading.readDirectory(run)).toEqual(["hold"]);
      yield* model.writing.rename(`${run}/hold`, `${run}/stop`);
      expect(yield* model.reading.exists(`${run}/hold`)).toBe(false);
      expect(yield* model.reading.exists(`${run}/stop`)).toBe(true);
      yield* model.writing.remove(run, { recursive: true });
      expect(yield* model.reading.exists(`${run}/stop`)).toBe(false);
      yield* model.disable;
      yield* fs.makeDirectory(run, { recursive: true });
      yield* fs.writeFileString(`${run}/stop`, "restored");
      expect(yield* model.reading.readFileString(`${run}/stop`)).toBe("restored");
    }),
  ));
