// A Run's own records, kept in the host's database
// (ADR-draft-a-runs-own-records-are-rows-in-the-hosts-database).
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { epochMs } from "../src/time";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Schema } from "effect";
import * as Rec from "effect/Record";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import {
  parentOf,
  RUN_RECORDS_MIGRATION_ID,
  RunRecords,
  runRecordsLayer,
} from "../src/run-records";
import { StoreWrites } from "../src/store-writes";
import { runEffect } from "./support/effect";
import { recordsAt } from "./support/records";
import { rollbackAt } from "../src/records-import";

let stateDir: string;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({
        prefix: "hw-run-records-",
      });
    }),
  ),
);
afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

/** A Run's legacy files, as an older build left them. */
const legacy = Effect.fn("test.legacy")(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  for (const [name, text] of Rec.toEntries(files)) {
    const file = `${stateDir}/${name}`;
    yield* fs.makeDirectory(parentOf(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  }
});

const records = <A, E>(effect: Effect.Effect<A, E, RunRecords>) =>
  Effect.provide(effect, recordsAt(stateDir));

test("migrate up: the first host imports every legacy record once, as written, and leaves the files", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* legacy({
        "runs/run-a/steps.jsonl": '{"kind":"enter","n":1}\n{"kind":"leave","n":2}\n{"kind":"le',
        "runs/run-a/steering/cards.jsonl": '{"n":1}\nnot json\n{"n":3}\n',
        "runs/run-a/steering/carded": "first\nsecond\nthi",
        "runs/run-a/intent.json": '{"version":2}\n',
        "runs/run-a/merge-request": "https://example.com/o/r/-/merge_requests/7",
        "runs/run-a/steering/progress/01-a.json": '{"ticket":"01"}',
        "runs/run-a/steering/externals.run-a-implementer": "2",
        "runs/run-b/steps.jsonl": '{"kind":"enter","n":9}\n',
        "evidence/run-a/metrics.jsonl": '{"m":1}\n',
        "evidence/run-a/steering/verifications.jsonl": '{"v":1}\n',
        "evidence/run-a/approved.json": "[]",
      });

      const read = records(
        Effect.gen(function* () {
          const one = yield* RunRecords;
          return {
            steps: yield* one.lines("run-a", "steps.jsonl"),
            cards: yield* one.lines("run-a", "steering/cards.jsonl"),
            carded: yield* one.lines("run-a", "steering/carded"),
            other: yield* one.lines("run-b", "steps.jsonl"),
            metrics: yield* one.lines("run-a", "evidence/metrics.jsonl"),
            verifications: yield* one.lines("run-a", "evidence/steering/verifications.jsonl"),
            intent: yield* one.fact("run-a", "intent.json"),
            mr: yield* one.fact("run-a", "merge-request"),
            approved: yield* one.fact("run-a", "evidence/approved.json"),
            steering: yield* one.factsUnder("run-a", "steering/"),
            missing: yield* one.fact("run-a", "landing.json"),
          };
        }),
      );
      const first = yield* read;
      expect(first).toEqual({
        steps: ['{"kind":"enter","n":1}', '{"kind":"leave","n":2}'],
        cards: ['{"n":1}', "not json", '{"n":3}'],
        carded: ["first", "second"],
        other: ['{"kind":"enter","n":9}'],
        metrics: ['{"m":1}'],
        verifications: ['{"v":1}'],
        intent: '{"version":2}\n',
        mr: "https://example.com/o/r/-/merge_requests/7",
        approved: "[]",
        steering: [
          { name: "steering/externals.run-a-implementer", data: "2" },
          { name: "steering/progress/01-a.json", data: '{"ticket":"01"}' },
        ],
        missing: null,
      });
      // A file written after the import is not a record, and a second host imports nothing again.
      yield* fs.writeFileString(`${stateDir}/runs/run-a/steps.jsonl`, '{"kind":"late"}\n');
      expect(yield* read).toEqual(first);
      expect(yield* fs.readFileString(`${stateDir}/runs/run-a/intent.json`)).toBe(
        '{"version":2}\n',
      );
    }),
  ));

test("a legacy record the first host cannot read fails the migration, and the next host imports it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* legacy({ "runs/run-a/intent.json": '{"version":1}' });
      yield* fs.chmod(`${stateDir}/runs/run-a/intent.json`, 0o000);
      const read = records(RunRecords.use((one) => one.fact("run-a", "intent.json")));
      expect((yield* Effect.exit(read))._tag).toBe("Failure");
      yield* fs.chmod(`${stateDir}/runs/run-a/intent.json`, 0o644);
      expect(yield* read).toBe('{"version":1}');
    }),
  ));

test("a journal's lines are read back in the order they were appended, apart from other Runs' and journals'", () =>
  runEffect(
    Effect.gen(function* () {
      const one = yield* RunRecords;
      yield* one.append("run-a", "steps.jsonl", ["1", "2"]);
      yield* one.append("run-b", "steps.jsonl", ["b"]);
      yield* one.append("run-a", "steering/cards.jsonl", ["card"]);
      yield* one.append("run-a", "steps.jsonl", ["3"]);
      expect(yield* one.lines("run-a", "steps.jsonl")).toEqual(["1", "2", "3"]);
      expect(yield* one.linesOf(["run-a", "run-b", "run-c"], "steps.jsonl")).toEqual(
        new Map([
          ["run-a", ["1", "2", "3"]],
          ["run-b", ["b"]],
        ]),
      );
    }),
  ));

test("an update reads and writes a fact with no other write between, and null removes it", () =>
  runEffect(
    Effect.gen(function* () {
      const one = yield* RunRecords;
      const bump = one.update("run-a", "count", (was) =>
        Effect.succeed(String(Number(was ?? "0") + 1)),
      );
      yield* Effect.all([bump, bump, bump, bump], { concurrency: "unbounded" });
      expect(yield* one.fact("run-a", "count")).toBe("4");
      yield* one.update("run-a", "count", () => Effect.succeed(null));
      expect(yield* one.fact("run-a", "count")).toBeNull();
      const refused = yield* Effect.exit(
        one.update("run-a", "other", () =>
          one.put("run-a", "other", "half").pipe(Effect.andThen(Effect.fail("no"))),
        ),
      );
      expect(refused._tag).toBe("Failure");
      expect(yield* one.fact("run-a", "other")).toBeNull();
    }),
  ));

test("work moves a Run's activity and bookkeeping does not", () =>
  runEffect(
    Effect.gen(function* () {
      const one = yield* RunRecords;
      yield* one.append("run-a", "steering/seen.jsonl", ["seen"]);
      yield* one.append("run-a", "steering/disposition.jsonl", ["merged"]);
      yield* one.append("run-a", "operations.jsonl", ["asked"]);
      expect(yield* one.activity(["run-a"])).toEqual(new Map());
      yield* one.put("run-b", "intent.json", "{}");
      yield* one.append("run-c", "steps.jsonl", ["entered"]);
      expect([...(yield* one.activity(["run-a", "run-b", "run-c"])).keys()]).toEqual([
        "run-b",
        "run-c",
      ]);
    }),
  ));

test("the first host imports the usual Step times an older build kept past its retired Runs", () =>
  runEffect(
    Effect.gen(function* () {
      const sample = (run: string, step: string, at: string, ms: number) => ({
        workflow: "implement",
        step,
        run,
        key: step,
        at,
        ms,
      });
      yield* legacy({
        "step-durations.json": yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
          sample("gone-1", "build", "2026-10-01T10:00:00.000Z", 60_000),
          sample("gone-2", "build", "2026-10-02T10:00:00.000Z", 120_000),
          sample("gone-3", "review", "2026-10-03T10:00:00.000Z", 180_000),
        ]),
      });
      const samples = yield* records(RunRecords.use((one) => one.stepSamples));
      expect(Arr.sortWith(samples, (one) => one.ms, Order.Number)).toEqual([
        { workflow: "implement", step: "build", ms: 60_000 },
        { workflow: "implement", step: "build", ms: 120_000 },
        { workflow: "implement", step: "review", ms: 180_000 },
      ]);
    }),
  ));

test("the first host imports when each Run last did work, less what was written about it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* legacy({
        "runs/run-a/log.txt": "work\n",
        "agents/run-a/implement.json": "{}",
        "runs/run-a/steering/seen.jsonl": "{}\n",
        "runs/run-a/operations.jsonl": "{}\n",
      });
      const at = (name: string, ms: number) =>
        fs.utimes(`${stateDir}/${name}`, ms / 1000, ms / 1000);
      yield* at("runs/run-a/log.txt", 1_000_000);
      yield* at("agents/run-a/implement.json", 2_000_000);
      yield* at("runs/run-a/steering/seen.jsonl", 9_000_000);
      yield* at("runs/run-a/operations.jsonl", 9_000_000);
      expect(yield* records(RunRecords.use((one) => one.activity(["run-a"])))).toEqual(
        new Map([["run-a", 2_000_000]]),
      );
    }),
  ));

test("a write names its Run to the Run model once it is committed", () =>
  runEffect(
    Effect.gen(function* () {
      const moved: string[] = [];
      yield* Effect.gen(function* () {
        const one = yield* RunRecords;
        yield* one.append("run-a", "steps.jsonl", ["1"]);
        yield* one.put("run-b", "intent.json", "{}");
        yield* one.update("run-c", "landing.json", () => Effect.succeed("{}"));
      }).pipe(
        Effect.provide(recordsAt(stateDir)),
        Effect.provideService(StoreWrites, (runs) => moved.push(...runs)),
      );
      expect(moved).toEqual(["run-a", "run-b", "run-c"]);
    }),
  ));

test("a read-only connection reads what the host committed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* records(RunRecords.use((one) => one.append("run-a", "steps.jsonl", ["1"])));
      const lines = yield* RunRecords.use((one) => one.lines("run-a", "steps.jsonl")).pipe(
        Effect.provide(
          runRecordsLayer.pipe(
            Layer.provide(
              Layer.orDie(SqliteClient.layer({ filename: `${stateDir}/host.db`, readonly: true })),
            ),
            Layer.provide(Reactivity.layer),
          ),
        ),
      );
      expect(lines).toEqual(["1"]);
    }),
  ));

test("migrate down: a rollback writes every record back where an older build reads it, and a re-upgrade imports them again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* legacy({
        "runs/run-a/steps.jsonl": '{"kind":"enter"}\n{"kind":"le',
        "runs/run-a/steering/cards.jsonl": '{"n":1}\nnot json\n{"n":3}\n',
        "runs/run-a/landing.json": '{"state":"attempt"}',
        "runs/run-a/steering/progress/01-a.json": '{"ticket":"01"}',
        "evidence/run-a/metrics.jsonl": '{"m":1}\n',
      });
      const write = Effect.gen(function* () {
        const one = yield* RunRecords;
        yield* one.append("run-a", "steps.jsonl", ['{"kind":"leave"}']);
        yield* one.append("run-b", "steering/carded", ["key"]);
        yield* one.put("run-a", "landing.json", null);
        yield* one.put("run-a", "steering/progress/01-a.json", null);
        yield* one.put("run-b", "intent.json", '{"version":1}\n');
        yield* one.append("run-a", "evidence/metrics.jsonl", ['{"m":2}']);
      });
      yield* records(write);

      expect(yield* rollbackAt(stateDir)).toBe("rolled-back");
      const read = (name: string) =>
        fs.readFileString(`${stateDir}/${name}`).pipe(Effect.orElseSucceed(() => null));
      expect({
        steps: yield* read("runs/run-a/steps.jsonl"),
        cards: yield* read("runs/run-a/steering/cards.jsonl"),
        carded: yield* read("runs/run-b/steering/carded"),
        landing: yield* read("runs/run-a/landing.json"),
        progress: yield* read("runs/run-a/steering/progress/01-a.json"),
        intent: yield* read("runs/run-b/intent.json"),
        metrics: yield* read("evidence/run-a/metrics.jsonl"),
      }).toEqual({
        steps: '{"kind":"enter"}\n{"kind":"leave"}\n',
        cards: '{"n":1}\nnot json\n{"n":3}\n',
        carded: "key\n",
        landing: null,
        progress: null,
        intent: '{"version":1}\n',
        metrics: '{"m":1}\n{"m":2}\n',
      });
      expect(yield* rollbackAt(stateDir)).toBe("not-migrated");

      const again = yield* records(
        Effect.gen(function* () {
          const one = yield* RunRecords;
          return [
            yield* one.lines("run-a", "steps.jsonl"),
            yield* one.lines("run-b", "steering/carded"),
            yield* one.fact("run-a", "landing.json"),
            yield* one.fact("run-b", "intent.json"),
          ];
        }),
      );
      expect(again).toEqual([
        ['{"kind":"enter"}', '{"kind":"leave"}'],
        ["key"],
        null,
        '{"version":1}\n',
      ]);
    }),
  ));

test("a Run's controls are imported once from the state directory's files and written back by a rollback", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* legacy({
        "stop.run-a": "",
        "hold.run-a": "Paused before Build",
        "parked.run-a": "no usage left",
        "parked.run-a.new": "torn",
        "notified.run-a": "done:x\nfailed:y\n",
        "awaited.run-a/run-a.1": "",
        "relaunch/run-a/build.json": '{"agent":"build"}',
        "running-checks/c1.json": '{"id":"c1","run":"run-a"}',
      });
      const imported = yield* records(
        Effect.gen(function* () {
          const one = yield* RunRecords;
          const read = {
            stop: yield* one.control("stop", "run-a"),
            hold: yield* one.control("hold", "run-a"),
            parked: yield* one.control("parked", "run-a"),
            notified: yield* one.controlsOf("notified", "run-a"),
            awaited: yield* one.controlsOf("awaited", "run-a"),
            relaunch: yield* one.control("relaunch", "run-a", "build"),
            checks: yield* one.everyControl("running-check"),
          };
          yield* one.setControl("hold", "run-a", null);
          yield* one.setControl("usage", "run-b", '{"until":"later"}');
          return read;
        }),
      );
      expect(imported).toEqual({
        stop: "",
        hold: "Paused before Build",
        parked: "no usage left",
        notified: [
          { key: "done:x", data: "" },
          { key: "failed:y", data: "" },
        ],
        awaited: [{ key: "run-a.1", data: "" }],
        relaunch: '{"agent":"build"}',
        checks: [{ run: "", key: "c1", data: '{"id":"c1","run":"run-a"}' }],
      });

      expect(yield* rollbackAt(stateDir)).toBe("rolled-back");
      const read = (name: string) =>
        fs.readFileString(`${stateDir}/${name}`).pipe(Effect.orElseSucceed(() => null));
      expect({
        stop: yield* read("stop.run-a"),
        hold: yield* read("hold.run-a"),
        parked: yield* read("parked.run-a"),
        usage: yield* read("usage.run-b"),
        notified: yield* read("notified.run-a"),
        awaited: yield* read("awaited.run-a/run-a.1"),
        relaunch: yield* read("relaunch/run-a/build.json"),
        check: yield* read("running-checks/c1.json"),
      }).toEqual({
        stop: "",
        hold: null,
        parked: "no usage left",
        usage: '{"until":"later"}',
        notified: "done:x\nfailed:y\n",
        awaited: "",
        relaunch: '{"agent":"build"}',
        check: '{"id":"c1","run":"run-a"}',
      });
    }),
  ));

test("a rollback dates each Run's files by when it last did work, not by the rollback", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* legacy({ "runs/run-c/steps.jsonl": '{"kind":"enter"}\n' });
      const worked = epochMs("2020-01-02T00:00:00Z") / 1000;
      yield* fs.utimes(`${stateDir}/runs/run-c/steps.jsonl`, worked, worked);
      const activity = yield* records(RunRecords.use((one) => one.activity(["run-c"])));
      expect(activity.get("run-c")).toBe(worked * 1000);

      expect(yield* rollbackAt(stateDir)).toBe("rolled-back");
      const info = yield* fs.stat(`${stateDir}/runs/run-c/steps.jsonl`);
      expect(info.mtime._tag === "Some" ? info.mtime.value.getTime() : null).toBe(worked * 1000);
    }),
  ));

test("a rollback is refused while a later build's migration is recorded, and changes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* records(RunRecords.use((one) => one.append("run-a", "steps.jsonl", ["{}"])));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO collie_migrations (migration_id, name) VALUES (${RUN_RECORDS_MIGRATION_ID + 1}, 'later')`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: `${stateDir}/host.db` })));

      expect(yield* rollbackAt(stateDir)).toEqual({
        later: `${RUN_RECORDS_MIGRATION_ID + 1}_later`,
      });
      expect(yield* fs.exists(`${stateDir}/runs/run-a/steps.jsonl`)).toBe(false);
      expect(yield* records(RunRecords.use((one) => one.lines("run-a", "steps.jsonl")))).toEqual([
        "{}",
      ]);
    }),
  ));
