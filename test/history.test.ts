// What the old engine left behind, read once into the rows every other reader uses.
//
// Real run directories and real SQLite, because the questions are about what an
// installation actually has on disk after an upgrade: records written by versions that
// kept less than the last one did, a claim file whose process is still alive, and a
// `run.json` nobody can decode. None of those is answerable against a fixture that was
// built by the current encoder.

import { expect, test } from "bun:test";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { importHistory } from "../src/history";
import { Store, storeLayer } from "../src/store";
import { runEffect } from "./support/effect";
import { oldRun, oldRecord as record } from "./support/history";

const opens = (file: string) =>
  storeLayer.pipe(
    Layer.provideMerge(
      SqliteClient.layer({ filename: file }).pipe(Layer.provideMerge(Reactivity.layer)),
    ),
  );

/** A state directory of its own, with the store on the database beside its run dirs. */
const onState = <A, E>(
  prefix: string,
  body: (
    stateDir: string,
  ) => Effect.Effect<
    A,
    E,
    Store | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      return yield* body(dir).pipe(Effect.provide(opens(`${dir}/native.db`)));
    }).pipe(Effect.scoped),
  );

const asText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const fromText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const asRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

test("an old Run is imported once, and importing again imports nothing", () =>
  onState("collie-history-once-", (stateDir) =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* oldRun(
        stateDir,
        "implement-picker-20260901-100000",
        record("implement-picker-20260901-100000"),
      );

      const first = yield* importHistory(stateDir);
      expect(first.map((item) => item.kind)).toEqual(["imported"]);

      const again = yield* importHistory(stateDir);
      expect(again.map((item) => item.kind)).toEqual(["already"]);

      const rows = yield* store.history;
      expect(rows.length).toBe(1);
      expect(rows[0]?.run).toBe("implement-picker-20260901-100000");
    }),
  ));

test("what a Run was is read from its own record, whatever version wrote it", () =>
  onState("collie-history-facts-", (stateDir) =>
    Effect.gen(function* () {
      const store = yield* Store;
      // A record from before snapshots, Tasks, strategies or outcomes were kept.
      yield* oldRun(stateDir, "old", record("old"));
      // One with a baseline snapshot, which is provenance and not an engine to keep.
      yield* oldRun(
        stateDir,
        "snapped",
        record("snapped", {
          workflow: "review",
          task: "task-1",
          parent: "old",
          input_strategies: { plan: "work-source" },
          definition: {
            hash: "abc123",
            layer: "baseline",
            path: "/plugin/workflows/review.md",
            snapshot: "snapshot.json",
          },
          mr_url: "https://gitlab.example.com/acme/app/-/merge_requests/2",
          linear_issues: ["ENG-1"],
        }),
      );

      yield* importHistory(stateDir);
      const rows = yield* store.history;
      const byId = new Map(rows.map((row) => [row.run, row]));

      const old = byId.get("old");
      expect(old?.workflow).toBe("implement");
      expect(old?.project).toBe("/work/app");
      expect(old?.status).toBe("done");
      expect(old?.task).toBe(null);
      // Old Inputs are text, whatever a module's would be, and are kept as they were.
      expect(asRecord(fromText(old?.inputs ?? "{}"))).toEqual({
        plan: "ENG-1",
        branch: "mk/picker",
      });
      expect(asRecord(fromText(old?.provenance ?? "{}"))).toMatchObject({
        sources: { plan: "explicit", branch: "inferred" },
        definition: null,
      });

      const snapped = byId.get("snapped");
      expect(snapped?.parent).toBe("old");
      expect(snapped?.task).toBe("task-1");
      expect(asRecord(fromText(snapped?.provenance ?? "{}"))).toMatchObject({
        strategies: { plan: "work-source" },
        definition: { layer: "baseline", path: "/plugin/workflows/review.md", hash: "abc123" },
      });
      // References, not copies: the artifacts stay the files they are.
      expect(asRecord(fromText(snapped?.evidence ?? "{}"))).toMatchObject({
        mr: "https://gitlab.example.com/acme/app/-/merge_requests/2",
        linear: ["ENG-1"],
      });
    }),
  ));

test("a Run the old engine left running is imported as interrupted, not as running", () =>
  onState("collie-history-interrupted-", (stateDir) =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* oldRun(stateDir, "midway", record("midway", { status: "running", finished_at: null }));

      yield* importHistory(stateDir);
      const [row] = yield* store.history;
      expect(row?.status).toBe("interrupted");
    }),
  ));

test("a run.json nobody can decode is reported, and the file is left exactly as it was", () =>
  onState("collie-history-malformed-", (stateDir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* Store;
      const dir = yield* oldRun(stateDir, "broken", record("broken"));
      const file = path.join(dir, "run.json");
      yield* fs.writeFileString(file, '{"id": "broken", "status": ');

      const reported = yield* importHistory(stateDir);
      expect(reported.length).toBe(1);
      expect(reported[0]?.kind).toBe("malformed");
      expect(reported[0]?.run).toBe("broken");

      expect(yield* store.history).toEqual([]);
      expect(yield* fs.readFileString(file)).toBe('{"id": "broken", "status": ');
    }),
  ));

test("a Run something else still owns is skipped, and imported once its owner has gone", () =>
  onState("collie-history-owned-", (stateDir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* Store;
      const dir = yield* oldRun(stateDir, "owned", record("owned", { status: "running" }));
      const claim = path.join(dir, "runner.pid");
      // This process: alive, and so evidence that the old installation may still be
      // working. Nothing is adopted, terminated or rewritten on the strength of it.
      yield* fs.writeFileString(
        claim,
        `${asText({ pid: process.pid, start: null, at: "2026-09-01T10:00:00Z" })}\n`,
      );

      const held = yield* importHistory(stateDir);
      expect(held.length).toBe(1);
      expect(held[0]?.kind).toBe("held");
      expect(yield* store.history).toEqual([]);

      yield* fs.remove(claim);
      const after = yield* importHistory(stateDir);
      expect(after.map((item) => item.kind)).toEqual(["imported"]);
      expect((yield* store.history).length).toBe(1);
    }),
  ));

test("a claim nobody can read is held rather than guessed at", () =>
  onState("collie-history-unknown-", (stateDir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* Store;
      const dir = yield* oldRun(stateDir, "murky", record("murky", { status: "running" }));
      yield* fs.writeFileString(path.join(dir, "runner.pid"), "not a claim\n");

      const held = yield* importHistory(stateDir);
      expect(held[0]?.kind).toBe("held");
      expect(yield* store.history).toEqual([]);
    }),
  ));
