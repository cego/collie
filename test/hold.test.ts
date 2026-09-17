// Holding a Run until a time: what a human may write, what the operation records, and
// what the board says about it afterwards.

import { expect, test } from "bun:test";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { heldUntil, holdRun, holdWorkspace, releaseRun } from "../src/operations";
import { dropHolds, inboxFiles } from "../src/driver";
import { RunStore } from "../src/run";
import { untilFrom, atClock } from "../src/time";

const NOW = Date.parse("2026-09-16T09:30:00.000Z");
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));

/** What a wall clock in this machine's own timezone reads at that instant. */
const localClock = (iso: string) => {
  const at = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(Date.parse(iso)), DateTime.zoneMakeLocal()),
  );
  return `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
};

test("a hold's `until` takes a clock time or a full timestamp, and refuses anything else", () => {
  // A clock time is the human's own clock: "14:00" is two in the afternoon where they
  // are, not 14:00 UTC — which is 16:00 to somebody in Copenhagen.
  expect(localClock(untilFrom("14:00", NOW)!)).toBe("14:00");
  expect(localClock(untilFrom("09:00", NOW)!)).toBe("09:00");
  // Already past today is tomorrow's: a hold that expired before it was asked for is
  // not a hold. Asked at 09:30 UTC, so a local 09:00 is either today's or tomorrow's.
  expect(Date.parse(untilFrom("09:00", NOW)!)).toBeGreaterThan(NOW);
  expect(untilFrom("2026-09-18T08:15:00.000Z", NOW)).toBe("2026-09-18T08:15:00.000Z");

  for (const nonsense of ["", "soon", "25:00", "14:60", "tomorrow", "14"]) {
    expect(untilFrom(nonsense, NOW)).toBeNull();
  }
});

test("a held card says the clock time, not a timestamp to decode", () => {
  // The same clock both ways: what a human asked for is what the card says back.
  const at = untilFrom("14:00", NOW)!;
  expect(atClock(at, NOW).split(" ")[0]).toBe("14:00");
  // Past midnight it says which day, because "held until 02:00" alone is a lie by 24h.
  const soon = untilFrom("02:00", Date.parse(at))!;
  expect(atClock(soon, Date.parse(at))).toBe("02:00 tomorrow");
  // Further off it carries its date, which is the only form with one.
  const later = untilFrom("02:00", Date.parse(soon) + 4 * 86_400_000)!;
  expect(atClock(later, Date.parse(at))).toMatch(/^\d{4}-\d{2}-\d{2} 02:00$/);
});

const seed = Effect.fn("hold.seed")(function* (rig: Rig, workspace: string) {
  return yield* new RunStore(rig.stateDir).create({
    workflow: "implement",
    cwd: rig.projectDir,
    session: null,
    workspace,
    workspaceLabel: `${workspace} | a task`,
    inputs: {},
    inputSources: {},
    stepIds: ["build"],
    maxIterations: 1,
    namedAfter: "a-task",
  });
});

test("a hold reaches the Driver's inbox carrying the time it ends", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const run = yield* seed(rig, "w1");

      const held = yield* holdRun(run, "leaving for lunch", "req-1", "2026-09-16T14:00:00.000Z");

      expect(held).toMatchObject({
        ok: true,
        data: { runId: run.id, until: "2026-09-16T14:00:00.000Z" },
      });
      const fs = yield* FileSystem.FileSystem;
      const files = yield* inboxFiles(run.dir);
      expect(files).toHaveLength(1);
      expect(decodeJson(yield* fs.readFileString(files[0]!))).toMatchObject({
        type: "hold",
        reason: "leaving for lunch",
        until: "2026-09-16T14:00:00.000Z",
      });

      // A hold with no end is still a hold: the human releases that one themselves.
      yield* releaseRun(run, "back", "req-2");
      const open = yield* holdRun(run, "no reason given", "req-3", null);
      expect(open).toMatchObject({ ok: true, data: { until: null } });
      yield* rig.close();
    }),
  ));

test("holding a workspace holds every unsettled Run in it, and nothing outside it", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const one = yield* seed(rig, "w1");
      const two = yield* seed(rig, "w1");
      const elsewhere = yield* seed(rig, "w2");
      const over = yield* seed(rig, "w1");
      over.record.status = "done";
      yield* over.save();

      const held = yield* holdWorkspace(
        rig.stateDir,
        "w1",
        "leaving for lunch",
        "req-1",
        "2026-09-16T14:00:00.000Z",
      );

      // SAFETY: `ok` was just asserted, and every `ok` result of `holdWorkspace` carries
      // the runs it held.
      const runs = (held as { data: { runs: string[] } }).data.runs;
      expect(held.ok).toBe(true);
      expect(runs.sort()).toEqual([one.id, two.id].sort());
      // A Run that has finished takes no hold, and neither does another workspace's.
      for (const run of [elsewhere, over]) expect(yield* inboxFiles(run.dir)).toEqual([]);
      yield* rig.close();
    }),
  ));

test("the record says who held a Run and until when, so the drawer can", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const run = yield* seed(rig, "w1");
      expect(heldUntil(run.record)).toBeNull();

      run.record.held = {
        reason: "leaving for lunch",
        by: "mk",
        until: "2026-09-16T14:00:00.000Z",
      };
      yield* run.save();

      const reread = yield* new RunStore(rig.stateDir).load(run.id);
      expect(heldUntil(reread!.record)).toMatchObject({
        by: "mk",
        until: "2026-09-16T14:00:00.000Z",
      });
      yield* rig.close();
    }),
  ));

test("an unread hold is dropped for the Run that was answered, and no other", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const answered = yield* seed(rig, "w1");
      const beside = yield* seed(rig, "w1");
      yield* holdWorkspace(rig.stateDir, "w1", "leaving for lunch", "req-1", null);

      expect(yield* dropHolds(answered.dir)).toBe(1);

      // The workspace is still held: coming back to answer one Run is coming back to
      // that Run, not to every Run that was left.
      expect(yield* inboxFiles(answered.dir)).toEqual([]);
      expect(yield* inboxFiles(beside.dir)).toHaveLength(1);
      yield* rig.close();
    }),
  ));
