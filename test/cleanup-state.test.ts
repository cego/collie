// What cleanup removes from the state directory, the compaction controls and the runner
// cache: only what no Run, agent or running build needs (ADR-0045).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, DateTime, Effect, FileSystem, Schema } from "effect";
import { CleanupReport } from "../src/board-model";
import { compactionSweeper, runnersSweeper, sweep } from "../src/cleanup";
import { Herdr } from "../src/herdr";
import { runEffect } from "./support/effect";
import { hosted, settledRun } from "./support/hosted";
import { Rig } from "./support/recorder";
import { collie } from "./support/world";

const DAY_MS = 24 * 60 * 60_000;
const Listed = Schema.decodeUnknownSync(CleanupReport);

/** `path`, and everything directly in it, last changed `days` ago. */
const aged = (path: string, days: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = DateTime.toDateUtc(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - days * DAY_MS),
    );
    if ((yield* fs.stat(path)).type === "Directory")
      for (const name of yield* fs.readDirectory(path)) yield* fs.utimes(`${path}/${name}`, at, at);
    yield* fs.utimes(path, at, at);
  });

/** A file at `path` with `text`, last changed `days` ago. */
const written = (path: string, text: string, days: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(path, text);
    yield* aged(path, days);
  });

test(
  "cleanup removes state no Run's row owns once it is a day quiet, and keeps what it does not know",
  () =>
    hosted("collie-cleanup-state-", ({ world }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const state = world.state;
        const real = yield* settledRun(world, "hello");
        yield* written(`${state}/runs/old-x/run.json`, "{}", 2);
        yield* aged(`${state}/runs/old-x`, 2);
        yield* written(`${state}/runs/new-x/run.json`, "{}", 0);
        yield* written(`${state}/events.run-x.log`, "", 2);
        yield* written(`${state}/plans/p/plan.md`, "", 2);
        yield* aged(`${state}/plans`, 2);
        yield* written(`${state}/runs/.seq`, "7", 2);
        yield* written(`${state}/notes.txt`, "mine", 2);
        yield* written(`${state}/stop.run-deadbeef`, "", 2);
        yield* written(`${state}/stop.${real.id}`, "", 2);
        yield* written(`${state}/agents/abc123/deliveries.jsonl`, '{"run":"run-deadbeef"}\n', 2);
        yield* aged(`${state}/agents/abc123`, 2);
        yield* written(
          `${state}/agents/def456/deliveries.jsonl`,
          `{"run":"run-deadbeef"}\n{"run":"${real.id}"}\n`,
          2,
        );
        yield* aged(`${state}/agents/def456`, 2);
        yield* written(`${state}/requests/run-start/old.json`, "{}", 31);
        yield* written(`${state}/requests/run-start/new.json`, "{}", 1);

        const listed = Listed((yield* collie(world, ["cleanup"])).envelope.data);
        const removable = listed.remove
          .filter((item) => item.kind === "state")
          .map((item) => item.target.slice(state.length + 1))
          .sort();
        expect(removable).toEqual([
          "agents/abc123",
          "events.run-x.log",
          "plans",
          "requests/run-start/old.json",
          "runs/.seq",
          "runs/old-x",
          "stop.run-deadbeef",
        ]);
        expect(listed.keep).toContainEqual({
          kind: "state",
          target: `${state}/runs/new-x`,
          reason: "changed in the last day",
        });
        expect(listed.keep).toContainEqual({
          kind: "state",
          target: `${state}/notes.txt`,
          reason: "not a kind Collie knows",
        });

        const swept = yield* collie(world, ["cleanup", "--apply"]);
        expect(swept.envelope).toMatchObject({ ok: true });
        for (const gone of removable)
          expect([gone, yield* fs.exists(`${state}/${gone}`)]).toEqual([gone, false]);
        for (const kept of [
          "notes.txt",
          "runs/new-x",
          `stop.${real.id}`,
          "agents/def456",
          "requests/run-start/new.json",
          `runs/${real.id}`,
          "host.db",
        ])
          expect([kept, yield* fs.exists(`${state}/${kept}`)]).toEqual([kept, true]);
        // The Run whose row is kept still reads as it did.
        const shown = yield* collie(world, ["run", "show", real.id]);
        expect(shown.envelope).toMatchObject({ ok: true });
      }),
    ),
  60_000,
);

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

/** A compaction control record for `agent`, naming its endpoint's pid and command. */
const control = (agent: string, pid: number | null, command: string | null) =>
  written(
    `${rig.stateDir}/compaction/${agent}/control.json`,
    JSON.stringify({
      agent,
      harness: "codex",
      cwd: rig.projectDir,
      dir: `${rig.stateDir}/compaction/${agent}`,
      endpoint: null,
      pid,
      command,
      attempt: null,
    }),
    0,
  );

test("a gone agent's compaction controls go and its endpoint is stopped; a listed one's stay", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.addAgent("alive", "p1");
      const endpoint = Bun.spawn(["sleep", "987"]);
      yield* Effect.addFinalizer(() => Effect.sync(() => endpoint.kill("SIGKILL")));
      yield* control("gone", endpoint.pid, "sleep 987");
      yield* control("alive", null, null);

      const report = yield* sweep(
        [compactionSweeper(rig.stateDir, [new Herdr(rig.pluginEnv())])],
        rig.stateDir,
        "host",
      );
      expect(report.remove.map((item) => item.target)).toEqual([`${rig.stateDir}/compaction/gone`]);
      expect(yield* fs.exists(`${rig.stateDir}/compaction/gone`)).toBe(false);
      expect(yield* fs.exists(`${rig.stateDir}/compaction/alive`)).toBe(true);
      yield* Effect.promise(() => endpoint.exited);
      expect(endpoint.signalCode).toBe("SIGTERM");
    }),
  ));

test("a gone agent's recorded pid now running something else is not signalled", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const other = Bun.spawn(["sleep", "988"]);
      yield* Effect.addFinalizer(() => Effect.sync(() => other.kill("SIGKILL")));
      yield* control("gone", other.pid, "sleep 987");

      yield* sweep(
        [compactionSweeper(rig.stateDir, [new Herdr(rig.pluginEnv())])],
        rig.stateDir,
        "host",
      );
      expect(yield* fs.exists(`${rig.stateDir}/compaction/gone`)).toBe(false);
      // Still up for this test to put down: a SIGTERM from the sweep would have come first.
      other.kill("SIGKILL");
      yield* Effect.promise(() => other.exited);
      expect(other.signalCode).toBe("SIGKILL");
    }),
  ));

test("cleanup keeps every compaction control when herdr will not list its agents", () =>
  runEffect(
    Effect.gen(function* () {
      yield* written(`${rig.stateDir}/compaction/gone/control.json`, "{}", 0);
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"agent list":"herdr is gone"}' }));

      const judged = yield* compactionSweeper(rig.stateDir, [herdr]).judge;
      expect(judged.remove).toEqual([]);
      expect(judged.keep).toEqual([
        {
          kind: "compaction",
          target: `${rig.stateDir}/compaction/gone`,
          reason: "could not ask herdr what is live",
        },
      ]);
    }),
  ));

test("of three runner copies, only the one neither running nor newest goes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${rig.root}/runners`;
      for (const version of ["0.9.0", "0.10.0", "0.11.1"])
        yield* written(`${dir}/collie-${version}`, "bin", 0);

      const report = yield* sweep([runnersSweeper(dir, "0.10.0")], rig.stateDir, "host");
      expect(report.remove.map((item) => item.target)).toEqual([`${dir}/collie-0.9.0`]);
      expect((yield* fs.readDirectory(dir)).sort()).toEqual(["collie-0.10.0", "collie-0.11.1"]);
    }),
  ));
