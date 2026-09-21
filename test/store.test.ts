// The rows Collie owns beside the executions Effect owns.
//
// Real SQLite in a real file, because the questions are about durability and atomicity:
// does a request claimed twice make one run, does a database that is closed and opened
// again still hold what was admitted, and does a subscriber hear about a committed change.
// None of those is answerable in a map.

import { expect, test } from "bun:test";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { Store, storeLayer } from "../src/store";
import { runEffect } from "./support/effect";

/** One store on one file. Opening it again is what a restart does. */
const opens = (file: string) =>
  storeLayer.pipe(
    Layer.provideMerge(
      SqliteClient.layer({ filename: file }).pipe(Layer.provideMerge(Reactivity.layer)),
    ),
  );

const admission = (
  request: string,
  run: string,
  input: Record<string, string>,
  belongs?: { readonly task?: string; readonly parent?: string },
) => ({
  request,
  run,
  workflow: "proof",
  project: "/work/thing",
  input,
  provenance: Object.fromEntries(Object.keys(input).map((name) => [name, "typed"])),
  options: {},
  generation: "proof@1",
  execution: `execution-${run}`,
  task: belongs?.task ?? null,
  parent: belongs?.parent ?? null,
});

/** A database of its own, and the store on it, for the length of one question. */
const onStore = <A, E>(prefix: string, body: Effect.Effect<A, E, Store>) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      return yield* body.pipe(Effect.provide(opens(`${dir}/native.db`)));
    }).pipe(Effect.scoped),
  );

test("a request claims one run, and claiming it again is that same run", () =>
  onStore(
    "collie-store-claim-",
    Effect.gen(function* () {
      const store = yield* Store;
      const first = yield* store.admit(admission("req-1", "run-a", { note: "once" }));
      expect(first.fresh).toBe(true);
      expect(first.row.run).toBe("run-a");

      // The same request again, with the run id a retrying caller minted for itself.
      const again = yield* store.admit(admission("req-1", "run-b", { note: "once" }));
      expect(again.fresh).toBe(false);
      expect(again.row.run).toBe("run-a");
      expect(again.row.execution).toBe("execution-run-a");
      expect((yield* store.runs).map((row) => row.run)).toEqual(["run-a"]);
    }),
  ));

test("claims of one request that arrive together settle on one run", () =>
  onStore(
    "collie-store-concurrent-",
    Effect.gen(function* () {
      const store = yield* Store;
      const claimed = yield* Effect.all(
        ["a", "b", "c", "d"].map((suffix) =>
          store.admit(admission("req-1", `run-${suffix}`, { note: "once" })),
        ),
        { concurrency: "unbounded" },
      );
      expect(new Set(claimed.map((one) => one.row.run)).size).toBe(1);
      expect(claimed.filter((one) => one.fresh)).toHaveLength(1);
      expect(yield* store.runs).toHaveLength(1);
    }),
  ));

test("a request reused with other arguments is refused, and what it claimed is untouched", () =>
  onStore(
    "collie-store-conflict-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "first" }));
      const refused = yield* store
        .admit(admission("req-1", "run-b", { note: "second" }))
        .pipe(Effect.flip);
      expect(refused._tag).toBe("RequestConflict");
      expect(refused.request).toBe("req-1");

      const held = yield* store.runs;
      expect(held).toHaveLength(1);
      expect(held[0]?.run).toBe("run-a");
      expect(held[0]?.input).toContain("first");
    }),
  ));

test("two requests with the same input are two runs", () =>
  onStore(
    "collie-store-separate-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "same" }));
      yield* store.admit(admission("req-2", "run-b", { note: "same" }));
      expect((yield* store.runs).map((row) => row.run).sort()).toEqual(["run-a", "run-b"]);
    }),
  ));

test("what a host admitted is there when the database is opened again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-store-reopen-" });
      const file = `${dir}/native.db`;

      yield* Effect.gen(function* () {
        const store = yield* Store;
        yield* store.remember({ name: "proof@1", workflow: "proof", entry: "/saved/proof.ts" });
        yield* store.admit(admission("req-1", "run-a", { note: "durable" }));
      }).pipe(Effect.provide(opens(file)), Effect.scoped);

      // A second host, on the same file, with nothing carried over in memory.
      yield* Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.generations).toEqual([
          { name: "proof@1", workflow: "proof", entry: "/saved/proof.ts" },
        ]);
        const found = yield* store.run("run-a");
        expect(found?.request).toBe("req-1");
        expect(found?.execution).toBe("execution-run-a");
        // Admitted and never accepted: work for the new host to pick up.
        expect((yield* store.pending).map((row) => row.run)).toEqual(["run-a"]);
      }).pipe(Effect.provide(opens(file)), Effect.scoped);
    }).pipe(Effect.scoped),
  ));

test("a run belongs to the task and the run it was started from", () =>
  onStore(
    "collie-store-belongs-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(
        admission("req-1", "run-a", { note: "child" }, { task: "task-7", parent: "run-parent" }),
      );
      const found = yield* store.run("run-a");
      expect(found?.task).toBe("task-7");
      expect(found?.parent).toBe("run-parent");
      // What was started on its own belongs to nothing, which is not the same as "task-7".
      yield* store.admit(admission("req-2", "run-b", { note: "alone" }));
      expect((yield* store.run("run-b"))?.task).toBeNull();
    }),
  ));

test("a run the engine has taken is no longer work to recover", () =>
  onStore(
    "collie-store-accepted-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "accepted" }));
      expect(yield* store.pending).toHaveLength(1);
      yield* store.accepted("run-a");
      expect(yield* store.pending).toHaveLength(0);
    }),
  ));

test("a subscriber is told once the change is committed", () =>
  onStore(
    "collie-store-changes-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "before" }));

      // The first is what is there; the second is what the admission below committed.
      const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(store.changes, 2)));
      yield* Effect.yieldNow;
      yield* store.admit(admission("req-2", "run-b", { note: "after" }));

      const updates = yield* Fiber.join(seen);
      expect(updates.map((rows) => rows.map((row) => row.run))).toEqual([
        ["run-a"],
        ["run-a", "run-b"],
      ]);
    }),
  ));
