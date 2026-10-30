import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { ScheduleChange, ScheduleChanged, ScheduleEntry } from "../src/schedule-model";
import { moveSchedule, type ScheduleDoor } from "../src/schedule-move";

const entry = (machine: string, over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  machine: { installation: `i-${machine}`, hostname: machine },
  name: "daily",
  workflow: "proof",
  checkout: "/src/collie",
  cron: "0 7 * * *",
  tz: "UTC",
  paused: false,
  start: { workflow: "proof", inputs: { note: "x" }, workspace: "/src/collie", verify: [] },
  next: "2026-10-15T07:00:00.000Z",
  last: null,
  ...over,
});

/** A host's Schedules in memory, which replays a request id it has seen as a host does. */
const fakeMachine = (
  name: string,
  initial: ReadonlyArray<ScheduleEntry>,
  fails: { readonly reach?: boolean; readonly change?: ScheduleChange["change"] } = {},
) => {
  const schedules = new Map(Arr.map(initial, (one) => [one.name, one]));
  const seen = new Map<string, ScheduleChanged>();
  const applied: Array<{ change: string; request: string }> = [];
  const refused = (reason: string) => Effect.fail({ reason });
  const door: ScheduleDoor = {
    name,
    schedules: Effect.suspend(() =>
      fails.reach === true
        ? refused(`${name} did not answer`)
        : Effect.succeed({
            machine: { installation: `i-${name}`, hostname: name },
            schedules: [...schedules.values()],
          }),
    ),
    changeSchedule: ({ change, request }) =>
      Effect.suspend(() => {
        const replay = seen.get(request);
        if (replay !== undefined) return Effect.succeed(replay);
        if (fails.change === change.change) return refused(`${change.change} broke`);
        const had = schedules.get(change.name);
        let now: ScheduleEntry | null;
        if (change.change === "add") {
          if (had !== undefined) return refused("already there");
          now = entry(name, {
            name: change.name,
            cron: change.cron,
            tz: change.tz ?? "UTC",
            paused: change.paused,
            start: change.start,
            checkout: change.start.workspace,
          });
          schedules.set(change.name, now);
        } else if (had === undefined) return refused("no such Schedule");
        else if (change.change === "remove") {
          schedules.delete(change.name);
          now = null;
        } else {
          now = { ...had, paused: change.change === "pause" };
          schedules.set(change.name, now);
        }
        applied.push({ change: change.change, request });
        const done: ScheduleChanged = {
          machine: { installation: `i-${name}`, hostname: name },
          change: change.change,
          name: change.name,
          schedule: now,
        };
        seen.set(request, done);
        return Effect.succeed(done);
      }),
  };
  return { door, schedules, applied };
};

test("a moved Schedule ends on the target only, resumed, with the checkout named for it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const from = fakeMachine("laptop", [entry("laptop")]);
      const to = fakeMachine("vm", []);
      const moved = yield* moveSchedule({
        from: from.door,
        to: to.door,
        name: "daily",
        checkout: "/home/me/collie",
        request: "move-1",
      });
      expect(moved).toMatchObject({ ok: true });
      expect([...from.schedules.keys()]).toEqual([]);
      expect(to.schedules.get("daily")).toMatchObject({
        paused: false,
        cron: "0 7 * * *",
        tz: "UTC",
        start: { workflow: "proof", inputs: { note: "x" }, workspace: "/home/me/collie" },
      });
      expect(Arr.map(to.applied, (one) => one.change)).toEqual(["add", "resume"]);
      expect(Arr.map(from.applied, (one) => one.change)).toEqual(["remove"]);
    }),
  ));

test("a move is refused as machine_unreachable, with neither Machine changed, when either does not answer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const away of ["from", "to"] as const) {
        const from = fakeMachine("laptop", [entry("laptop")], { reach: away === "from" });
        const to = fakeMachine("vm", [], { reach: away === "to" });
        const moved = yield* moveSchedule({
          from: from.door,
          to: to.door,
          name: "daily",
          request: "move-1",
        });
        expect(moved).toMatchObject({ ok: false, code: "machine_unreachable" });
        expect([...from.applied, ...to.applied]).toEqual([]);
      }
    }),
  ));

test("a source that will not remove it leaves the target's copy paused, and says so", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const from = fakeMachine("laptop", [entry("laptop")], { change: "remove" });
      const to = fakeMachine("vm", []);
      const moved = yield* moveSchedule({
        from: from.door,
        to: to.door,
        name: "daily",
        request: "m",
      });
      expect(moved).toMatchObject({ ok: false, code: "move_incomplete" });
      expect(!moved.ok && moved.message).toContain("paused on vm");
      expect(to.schedules.get("daily")?.paused).toBe(true);
      expect(from.schedules.has("daily")).toBe(true);
    }),
  ));

test("a move retried under its request id adds nothing and removes nothing twice", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const from = fakeMachine("laptop", [entry("laptop")]);
      const to = fakeMachine("vm", []);
      const asked = { from: from.door, to: to.door, name: "daily", request: "move-1" };
      expect(yield* moveSchedule(asked)).toMatchObject({ ok: true });
      expect(yield* moveSchedule(asked)).toMatchObject({ ok: true });
      expect(Arr.map(to.applied, (one) => one.change)).toEqual(["add", "resume"]);
      expect(Arr.map(from.applied, (one) => one.change)).toEqual(["remove"]);
      expect(to.schedules.get("daily")?.paused).toBe(false);
    }),
  ));

test("a Schedule on neither Machine is not moved", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const from = fakeMachine("laptop", []);
      const to = fakeMachine("vm", []);
      const moved = yield* moveSchedule({
        from: from.door,
        to: to.door,
        name: "daily",
        request: "m",
      });
      expect(moved).toMatchObject({ ok: false, code: "schedule_not_found" });
    }),
  ));
