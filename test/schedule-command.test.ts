import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { Effect, FileSystem } from "effect";
import { changedLine } from "../src/schedule-model";
import { collie, proves, type World } from "./support/world";

const MODULES = ["hello.workflow.ts", "typed.workflow.ts"];

const add = (world: World, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  collie(world, ["schedule", "add", ...args], env);

test(
  "add refuses a start that could never be made, as a start would",
  () =>
    proves(
      "collie-schedule-refusals-",
      (world) =>
        Effect.gen(function* () {
          const daily = ["--cron", "0 7 * * *"];
          // Not in a checkout and naming none.
          const nowhere = yield* add(world, ["a", "hello", ...daily, "--input", "name=x"], {
            COLLIE_CWD: world.home,
          });
          expect(nowhere.envelope).toMatchObject({
            ok: false,
            error: { code: "needs_input", details: { inputs: [{ name: "workspace" }] } },
          });
          const unnamed = yield* add(world, ["a", "hello", ...daily]);
          expect(unnamed.envelope).toMatchObject({
            ok: false,
            error: { code: "needs_input", details: { inputs: [{ name: "name" }] } },
          });
          const typed = yield* add(world, [
            "a",
            "typed",
            ...daily,
            ...Arr.flatMap(
              [
                "note=n",
                "count=1",
                "draft=true",
                "labels=[]",
                "ticket=",
                "mode=slow",
                "ref=r",
                "spec=",
              ],
              (one) => ["--input", one],
            ),
          ]);
          expect(typed.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
          expect(typed.envelope.error?.message).toContain("mode");
          for (const [cron, tz] of [
            ["61 * * * *", "UTC"],
            ["*/5 * * * * *", "UTC"],
            ["0 7 * * *", "Mars/Olympus"],
          ] as const) {
            const refused = yield* add(world, [
              "a",
              "hello",
              "--cron",
              cron,
              "--tz",
              tz,
              "--input",
              "name=x",
            ]);
            expect(refused.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
          }
          const unknown = yield* add(world, ["a", "nothing-here", ...daily]);
          expect(unknown.envelope).toMatchObject({
            ok: false,
            error: { code: "workflow_not_found" },
          });
          const first = yield* add(world, [
            "a",
            "hello",
            ...daily,
            "--paused",
            "--input",
            "name=x",
          ]);
          expect(first.envelope).toMatchObject({ ok: true });
          const again = yield* add(world, ["a", "hello", ...daily, "--input", "name=y"]);
          expect(again.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
          expect(again.envelope.error?.message).toContain("already");
          const named = yield* add(world, ["Not_A_Name", "hello", ...daily, "--input", "name=x"]);
          expect(named.envelope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        }),
      MODULES,
    ),
  120_000,
);

test(
  "every command names this Machine, carries the saved start, and replays its request id",
  () =>
    proves(
      "collie-schedule-envelopes-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const twice = (args: ReadonlyArray<string>) =>
            Effect.gen(function* () {
              const once = yield* collie(world, ["schedule", ...args]);
              const replayed = yield* collie(world, ["schedule", ...args]);
              expect(replayed.envelope).toEqual(once.envelope);
              return once.envelope;
            });
          const start = {
            workflow: "hello",
            inputs: { name: "x" },
            workspace: world.project,
            verify: [],
          };
          const added = yield* twice([
            "add",
            "daily",
            "hello",
            "--cron",
            "0 7 * * *",
            "--tz",
            "Europe/Copenhagen",
            "--input",
            "name=x",
            "--request-id",
            "add-1",
          ]);
          const installation = Str.trim(yield* fs.readFileString(`${world.state}/installation`));
          const machine = { installation, hostname: hostname() };
          expect(added).toMatchObject({
            ok: true,
            data: {
              machine,
              change: "add",
              name: "daily",
              requestId: "add-1",
              schedule: {
                machine,
                name: "daily",
                cron: "0 7 * * *",
                tz: "Europe/Copenhagen",
                paused: false,
                checkout: world.project,
                start,
                last: null,
              },
            },
          });
          expect(added.data).toHaveProperty("schedule.next", expect.stringMatching(/T0[56]:00:00/));

          const listed = yield* collie(world, ["schedule", "list"]);
          expect(listed.envelope).toMatchObject({
            ok: true,
            data: { machine, schedules: [{ machine, name: "daily", start }] },
          });

          expect(yield* twice(["pause", "daily", "--request-id", "pause-1"])).toMatchObject({
            ok: true,
            data: { machine, change: "pause", schedule: { paused: true, next: null } },
          });
          expect(yield* twice(["resume", "daily", "--request-id", "resume-1"])).toMatchObject({
            ok: true,
            data: { machine, change: "resume", schedule: { paused: false } },
          });
          const resumedAgain = yield* collie(world, ["schedule", "resume", "daily"]);
          expect(resumedAgain.envelope).toMatchObject({
            ok: false,
            error: { code: "invalid_state" },
          });
          expect(yield* twice(["remove", "daily", "--request-id", "remove-1"])).toMatchObject({
            ok: true,
            data: { machine, change: "remove", schedule: null },
          });
          expect((yield* collie(world, ["schedule", "list"])).envelope).toMatchObject({
            ok: true,
            data: { machine, schedules: [] },
          });
          // What changed and who asked stays beside the Schedule after it is gone.
          const trail = yield* fs.readFileString(`${world.state}/schedules/daily/operations.jsonl`);
          expect(Arr.filter(Str.split(trail, "\n"), (line) => line !== "")).toHaveLength(4);
        }),
      MODULES,
    ),
  120_000,
);

test("a command's text names the Machine it acted on", () => {
  const machine = { installation: "inst-1", hostname: "vm" };
  for (const change of ["add", "pause", "resume", "remove"] as const)
    expect(changedLine({ machine, change, name: "daily", schedule: null })).toContain(
      "vm (inst-1)",
    );
});
