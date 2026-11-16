import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Order } from "effect";
import * as Arr from "effect/Array";
import { Artefacts } from "../src/artefacts";
import { sha256Hex } from "../src/attachments";
import { retentionSweeper, sweep, uploadsSweeper } from "../src/cleanup";
import { Store } from "../src/store";
import { writeTask, type TaskRecord } from "../src/task";
import { receive } from "../src/uploads";
import { memoryRecords, runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun } from "./support/records";
import { task as view } from "./support/task";

const DAY_MS = 24 * 60 * 60_000;

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

test("Run cleanup removes only its own catalogue and copies, and upload cleanup removes none", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const store = yield* Store;
      const catalogue = yield* Artefacts;
      const actor = { origin: "cli", requestId: "r" } as const;
      const gone = yield* madeRun(rig.stateDir, {
        id: "r-gone",
        task: "task-gone",
        state: "succeeded",
      });
      const kept = yield* madeRun(rig.stateDir, {
        id: "r-kept",
        task: "task-kept",
        state: "succeeded",
      });
      for (const run of [gone, kept]) {
        yield* store.admit({
          request: run.id,
          run: run.id,
          workflow: "plain",
          project: rig.stateDir,
          input: {},
          provenance: {},
          options: {},
          generation: "g",
          execution: "e",
          task: run.task,
          parent: null,
        });
        yield* store.accepted(run.id);
      }
      const shared = `${rig.stateDir}/shared.txt`;
      yield* fs.writeFileString(shared, "same bytes in both Runs");
      const ofGone = yield* catalogue.register(gone, "inst", { path: shared }, "a", actor);
      const ofKept = yield* catalogue.register(kept, "inst", { path: shared }, "b", actor);
      const sent = new TextEncoder().encode("uploaded once");
      const upload = yield* receive(rig.stateDir, {
        name: "sent.txt",
        size: sent.length,
        sha256: sha256Hex(sent),
        offset: 0,
        content: Buffer.from(sent).toString("base64"),
      });
      const snapshot = yield* catalogue.register(
        kept,
        "inst",
        { path: upload.path!, snapshot: true },
        "c",
        actor,
      );

      const weekAgo = (yield* Clock.currentTimeMillis) / 1000 - 8 * 24 * 60 * 60;
      for (const name of yield* fs.readDirectory(`${rig.stateDir}/uploads`))
        yield* fs.utimes(`${rig.stateDir}/uploads/${name}`, weekAgo, weekAgo);
      const uploads = yield* sweep([uploadsSweeper(rig.stateDir)], rig.stateDir, "host");
      expect(Arr.map(uploads.remove, (one) => one.kind)).toEqual(["upload"]);
      expect(yield* fs.exists(upload.path!)).toBe(false);

      const record = (id: string): TaskRecord => ({
        id,
        workspace: null,
        label: id,
        cwd: "/project",
        created_at: "2026-09-01T00:00:00.000Z",
      });
      yield* writeTask(record("task-gone"));
      const ended = (yield* Clock.currentTimeMillis) - 31 * DAY_MS;
      const retention = retentionSweeper({
        stateDir: rig.stateDir,
        sessions: [],
        facts: Effect.succeed({
          tasks: [record("task-gone")],
          views: [view({ id: "task-gone", state: "done", landed: true, ended })],
          runs: [gone, kept],
        }),
        retire: (ids) => store.retire(ids, () => Effect.void),
      });
      expect(
        Arr.map((yield* sweep([retention], rig.stateDir, "host")).remove, (one) => one.target),
      ).toEqual(["task-gone"]);

      expect(yield* catalogue.list(gone.id)).toEqual([]);
      expect(yield* catalogue.read(gone, ofGone.item.id, 1, 0).pipe(Effect.flip)).toMatchObject({
        _tag: "HostRefused",
      });
      expect(yield* fs.exists(gone.dir)).toBe(false);
      const text = (part: { readonly content: string }) =>
        Buffer.from(part.content, "base64").toString();
      expect(text(yield* catalogue.read(kept, ofKept.item.id, 1, 0))).toBe(
        "same bytes in both Runs",
      );
      expect(text(yield* catalogue.read(kept, snapshot.item.id, 1, 0))).toBe("uploaded once");
      expect(
        Arr.sort(
          Arr.map(yield* catalogue.list(kept.id), (one) => one.id),
          Order.String,
        ),
      ).toEqual(Arr.sort([ofKept.item.id, snapshot.item.id], Order.String));
    }).pipe(Effect.provide(memoryRecords)),
  ));
