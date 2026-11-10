// Launch records, kept in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database).

import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Result, Schema, Stream } from "effect";
import {
  Launched,
  launchesOf,
  launchesOfAgents,
  orderLaunch,
  readLaunches,
  recordLaunch,
  recordSession,
  wasOrdered,
} from "../src/launches";
import { StoreWrites } from "../src/store-writes";
import { boardTableWrites } from "../src/host";
import { runEffect } from "./support/effect";
import { recordsAt } from "./support/records";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({
        prefix: "hw-launches-",
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

const launch = (over: Partial<Launched> = {}): Launched => ({
  agent: "run-a-implementer",
  output: "/state/agents/run-a/implement.json",
  reused: false,
  runId: "run-a",
  operation: "implement",
  role: "implementer",
  workflow: "implement",
  harness: "claude",
  terminalId: "term-1",
  ...over,
});

const asJson = (one: Launched) =>
  Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Launched))(one));

const stems = (launches: ReadonlyArray<Launched>) =>
  Arr.map(launches, (one) =>
    one.sequence === undefined ? one.operation : `${one.operation}.r${one.sequence}`,
  );

test("an agent's launches are read in one read across every Run it launched in", () =>
  runEffect(
    Effect.gen(function* () {
      const reviewer = (runId: string) =>
        launch({ runId, operation: "review", agent: "reviewer", output: `/state/${runId}.json` });
      yield* recordLaunch(reviewer("run-a"));
      yield* recordLaunch(launch());
      yield* recordLaunch(reviewer("run-b"));
      yield* recordLaunch(launch({ runId: "run-c", agent: "other" }));

      expect(
        Arr.map(yield* launchesOfAgents(["reviewer", "run-a-implementer"]), (one) => [
          one.runId,
          one.agent,
        ]),
      ).toEqual([
        ["run-a", "run-a-implementer"],
        ["run-a", "reviewer"],
        ["run-b", "reviewer"],
      ]);
      expect(yield* launchesOfAgents([])).toEqual([]);
    }),
  ));

test("launches are read back in the order they were launched, an unordered one first, with no file written", () =>
  runEffect(
    Effect.gen(function* () {
      const review = launch({ operation: "review", agent: "run-a-reviewer" });
      const again = launch({ sequence: 2 });
      yield* recordLaunch(launch());
      yield* recordLaunch(review);
      yield* orderLaunch(review);
      yield* orderLaunch(launch());
      yield* recordLaunch(again);
      expect(yield* wasOrdered(launch())).toBe(true);
      expect(yield* wasOrdered(again)).toBe(false);
      expect(stems(yield* readLaunches("run-a"))).toEqual(["implement.r2", "review", "implement"]);

      yield* orderLaunch(again);
      yield* orderLaunch(review);
      yield* recordLaunch({ ...review, reused: true });
      expect(stems(yield* readLaunches("run-a"))).toEqual(["implement", "implement.r2", "review"]);
      expect((yield* readLaunches("run-a")).at(-1)?.reused).toBe(true);
      expect(yield* readLaunches("run-b")).toEqual([]);
      expect(yield* (yield* FileSystem.FileSystem).exists(`${stateDir}/agents`)).toBe(false);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("several Runs' launches are one read, each Run's in its own order", () =>
  runEffect(
    Effect.gen(function* () {
      const other = launch({ runId: "run-b", agent: "run-b-implementer" });
      yield* recordLaunch(launch());
      yield* recordLaunch(launch({ operation: "review" }));
      yield* orderLaunch(launch({ operation: "review" }));
      yield* recordLaunch(other);
      const read = yield* launchesOf(["run-a", "run-b", "run-c"]);
      expect(stems(read.get("run-a") ?? [])).toEqual(["implement", "review"]);
      expect(read.get("run-b")).toEqual([other]);
      expect(read.get("run-c")).toBeUndefined();
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a session is recorded on a launch only while it is still on the terminal it was seen on", () =>
  runEffect(
    Effect.gen(function* () {
      const session = { kind: "claude", value: "s-1" };
      yield* recordLaunch(launch());
      yield* recordSession(launch({ terminalId: "term-0" }), session);
      expect((yield* readLaunches("run-a"))[0]?.agentSession).toBeUndefined();
      yield* recordSession(launch(), session);
      expect((yield* readLaunches("run-a"))[0]?.agentSession).toEqual(session);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("the first host imports each launch file once, in its launch order, and leaves the files in place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${stateDir}/agents/run-a`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${dir}/implement.launch.json`, asJson(launch()));
      yield* fs.writeFileString(`${dir}/implement.r2.launch.json`, asJson(launch({ sequence: 2 })));
      yield* fs.writeFileString(
        `${dir}/review.launch.json`,
        asJson(launch({ operation: "review" })),
      );
      yield* fs.writeFileString(`${dir}/early.launch.json`, asJson(launch({ operation: "early" })));
      yield* fs.writeFileString(`${dir}/torn.launch.json`, "{");
      yield* fs.writeFileString(`${dir}/launches`, "implement\nreview\nimplement.r2\nreview\n");
      yield* fs.makeDirectory(`${stateDir}/agents/0a1b2c`);
      yield* fs.writeFileString(`${stateDir}/agents/0a1b2c/deliveries.jsonl`, "");

      const imported = yield* Effect.provide(readLaunches("run-a"), recordsAt(stateDir));
      expect(stems(imported)).toEqual(["early", "implement", "implement.r2", "review"]);
      yield* fs.writeFileString(`${dir}/late.launch.json`, asJson(launch({ operation: "late" })));
      expect(
        stems(yield* Effect.provide(readLaunches("run-a"), recordsAt(stateDir))),
      ).not.toContain("late");
      expect(yield* fs.exists(`${dir}/implement.launch.json`)).toBe(true);
    }),
  ));

test("a launch file the first host cannot read fails its import, and the next host imports it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${stateDir}/agents/run-a`;
      const file = `${dir}/implement.launch.json`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(file, asJson(launch()));
      yield* fs.chmod(file, 0o000);

      const refused = yield* Effect.exit(
        Effect.provide(readLaunches("run-a"), recordsAt(stateDir)),
      );
      expect(refused._tag).toBe("Failure");
      yield* fs.chmod(file, 0o644);
      expect(yield* Effect.provide(readLaunches("run-a"), recordsAt(stateDir))).toEqual([launch()]);
    }),
  ));

test("a launch written tells the Run model which Run moved", () =>
  runEffect(
    Effect.gen(function* () {
      const moved: string[] = [];
      yield* Effect.gen(function* () {
        yield* recordLaunch(launch());
        yield* orderLaunch(launch());
        yield* recordSession(launch(), { kind: "claude", value: "s-1" });
      }).pipe(
        Effect.provide(recordsAt(stateDir)),
        Effect.provideService(StoreWrites, (runs) => moved.push(...runs)),
      );
      expect(moved).toEqual(["run-a", "run-a", "run-a"]);
    }),
  ));

test("a launch written moves the board", () =>
  runEffect(
    Effect.gen(function* () {
      const following = yield* Deferred.make<void>();
      const reads = yield* boardTableWrites.pipe(
        Stream.tap(() => Deferred.succeed(following, undefined)),
        Stream.take(2),
        Stream.runCount,
        Effect.forkScoped,
      );
      yield* Deferred.await(following);
      yield* recordLaunch(launch());
      expect(yield* Fiber.join(reads).pipe(Effect.timeout("2 seconds"))).toBe(2);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));
