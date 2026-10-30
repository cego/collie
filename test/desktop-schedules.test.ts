import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { describe, expect, test } from "bun:test";
import { Config, Effect, Option, Schema, flow, Result } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import {
  bridgeCommand,
  changeScheduleOn,
  openBridge,
  schedulesOn,
} from "../desktop/src/bun/machine";
import { readAudit } from "../src/audit";
import { FrontDoorRpcs } from "../src/board-model";
import {
  type MachineSchedules,
  machineSchedules,
  SCHEDULES_UPGRADE_SAID,
  scheduleAsk,
} from "../desktop/src/shared/schedules";
import { DesktopRpcs } from "../desktop/src/shared/flock";
import type { ScheduleEntry } from "../src/schedule-model";
import { suiteEnv } from "./support/effect";
import { root, stopHost } from "./support/host";
import { collie, proves } from "./support/world";

type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  machine: { installation: "i-vm", hostname: "vm" },
  name: "daily",
  workflow: "self-improve",
  checkout: "/src/collie",
  cron: "0 7 * * *",
  tz: "Europe/Copenhagen",
  paused: false,
  start: { workflow: "self-improve", inputs: {}, workspace: "/src/collie", verify: [] },
  next: "2026-10-15T05:00:00.000Z",
  last: null,
  ...over,
});

const on = (over: Partial<MachineSchedules> = {}): MachineSchedules => ({
  installation: "i-vm",
  profile: "vm",
  name: "vm",
  schedules: [],
  problem: null,
  unreachable: false,
  ...over,
});

test("each last occurrence says what became of it", () => {
  const at = "2026-10-14T05:00:00.000Z";
  const said = (last: ScheduleEntry["last"]) =>
    machineSchedules(on({ schedules: [entry({ last })] })).rows[0]?.last;
  expect(said(null)).toBe("nothing yet");
  expect(said({ occurrence: at, outcome: { kind: "run", run: "run-1", status: "complete" } })).toBe(
    `${at} run-1 complete`,
  );
  expect(
    said({ occurrence: at, outcome: { kind: "waiting-for-run", run: "run-0", status: "running" } }),
  ).toBe(`${at} waiting for run-0 (running)`);
  expect(said({ occurrence: at, outcome: { kind: "waiting-for-herdr" } })).toBe(
    `${at} waiting for herdr`,
  );
  expect(said({ occurrence: at, outcome: { kind: "refused", reason: "needs_input: note" } })).toBe(
    `${at} refused: needs_input: note`,
  );
});

test("a row says when it fires in words, with its cron expression and time zone", () => {
  const row = machineSchedules(on({ schedules: [entry()] })).rows[0]!;
  expect(row).toMatchObject({
    name: "daily",
    workflow: "self-improve",
    checkout: "/src/collie",
    when: "every day at 07:00 (0 7 * * * Europe/Copenhagen)",
    next: "next 2026-10-15T05:00:00.000Z",
  });
  const weekdays = machineSchedules(on({ schedules: [entry({ cron: "30 6 * * 1-5" })] }));
  expect(weekdays.rows[0]?.when).toBe("weekdays at 06:30 (30 6 * * 1-5 Europe/Copenhagen)");
  const odd = machineSchedules(on({ schedules: [entry({ cron: "0 7 1 */2 *" })] }));
  expect(odd.rows[0]?.when).toBe("0 7 1 */2 * Europe/Copenhagen");
});

test("a paused Schedule offers resume, remove and move; an active one pause, remove and move", () => {
  const view = machineSchedules(
    on({ schedules: [entry({ name: "off", paused: true, next: null }), entry()] }),
  );
  expect(Arr.map(view.rows, ({ name, next, actions }) => [name, next, actions])).toEqual([
    ["off", "paused", ["resume", "remove", "move"]],
    ["daily", "next 2026-10-15T05:00:00.000Z", ["pause", "remove", "move"]],
  ]);
});

test("a row's pause, resume and remove ask its Machine's host for that change; move opens the dialog", () => {
  const payload = DesktopRpcs.requests.get("changeSchedule")!.payloadSchema;
  for (const change of ["pause", "resume", "remove"] as const) {
    const asked = scheduleAsk("i-vm", "daily", change);
    expect(asked).toEqual({
      kind: "change",
      payload: { installation: "i-vm", name: "daily", change },
    });
    if (asked.kind === "change")
      expect(flow(Schema.decodeResult(payload), Result.getOrThrow)(asked.payload)).toEqual(
        asked.payload,
      );
  }
  expect(scheduleAsk("i-vm", "daily", "move")).toEqual({
    kind: "move",
    from: "i-vm",
    name: "daily",
  });
});

test("a host too old to list Schedules asks for an upgrade", () => {
  const view = machineSchedules(on({ problem: SCHEDULES_UPGRADE_SAID }));
  expect(view).toEqual({ state: "upgrade", said: SCHEDULES_UPGRADE_SAID, rows: [] });
});

test("an unreachable Machine says its Schedules still fire there, and offers nothing", () => {
  const view = machineSchedules(
    on({ unreachable: true, problem: "its host did not answer in time", schedules: [entry()] }),
  );
  expect(view.state).toBe("unreachable");
  expect(view.said).toBe(
    "vm is unreachable (its host did not answer in time); its Schedules still fire there while its host runs.",
  );
  expect(view.rows).toEqual([]);
});

test("a Machine with none says so, and that the Flock chat adds them", () => {
  expect(machineSchedules(on())).toEqual({
    state: "empty",
    said: "No Schedules on vm. Ask the Flock chat to add one.",
    rows: [],
  });
});

const mkPc = { installation: "i-mk-pc", profile: "local", name: "mk-pc" };
const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);

describe("the main process reaches each Machine's host", () => {
  test(
    "it lists a Machine's Schedules, and its pause, resume and removal are recorded as Desktop's",
    () =>
      proves(
        "collie-desktop-schedules-",
        (world) =>
          Effect.gen(function* () {
            const added = yield* collie(world, [
              "schedule",
              "add",
              "daily",
              "hello",
              "--cron",
              "0 7 * * *",
              "--input",
              "name=world",
              "--workspace",
              world.project,
            ]);
            expect(added.envelope).toMatchObject({ ok: true });
            const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
            const command = Option.isSome(binary)
              ? [binary.value]
              : [process.execPath, `${root}src/main.ts`];
            const desktop = yield* openBridge(bridgeCommand(command, "mk-pc"), {
              PATH: "/usr/bin:/bin",
              HOME: world.home,
              HERDR_PLUGIN_ROOT: world.install,
              HERDR_PLUGIN_STATE_DIR: world.state,
              COLLIE_USER_DIR: world.config,
              COLLIE_HOST: asCommand(command),
              ...(yield* suiteEnv),
              HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH ?? "",
              FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG ?? "",
            });
            const listed = yield* schedulesOn(mkPc, desktop);
            expect(listed).toMatchObject({
              profile: "local",
              name: "mk-pc",
              problem: null,
              unreachable: false,
              schedules: [{ name: "daily", workflow: "hello", paused: false }],
            });
            const door = { machine: mkPc, desktop };
            for (const change of ["pause", "resume", "remove"] as const)
              yield* changeScheduleOn(door, { change, name: "daily" }, `desktop-${change}`);
            expect((yield* schedulesOn(mkPc, desktop)).schedules).toEqual([]);
            const trail = yield* readAudit(`${world.state}/schedules/daily`);
            expect(
              Arr.map(
                Arr.filter(trail, (line) => pipe_(line.request, Str.startsWith("desktop-"))),
                (line) => [line.operation, line.actor.origin],
              ),
            ).toEqual([
              ["pause", "desktop"],
              ["resume", "desktop"],
              ["remove", "desktop"],
            ]);
            yield* stopHost(world.state);
          }).pipe(Effect.orDie),
        ["hello.workflow.ts", "proof.workflow.ts", "helper.ts", "notes.md"],
      ),
    120_000,
  );

  test("a host without the call asks for an upgrade rather than listing none", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const Older = RpcGroup.make(Rpc.make("ping"));
          let toClient: (response: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () =>
            Effect.void;
          const server = yield* RpcServer.makeNoSerialization(Older, {
            // SAFETY: what a host answers is the same envelope whichever group it serves.
            onFromServer: (response) => toClient(response as RpcMessage.FromServer<Rpcs>),
          }).pipe(Effect.provide(Older.toLayer({ ping: () => Effect.void })));
          const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
            supportsAck: true,
            // SAFETY: the older host is handed a request it has no schema for, as over the wire.
            onFromClient: ({ message }) =>
              server.write(0, message as RpcMessage.FromClient<RpcGroup.Rpcs<typeof Older>>),
          });
          toClient = client.write;
          const read = yield* schedulesOn(mkPc, client.client);
          expect(read).toMatchObject({ problem: SCHEDULES_UPGRADE_SAID, unreachable: false });
          expect(machineSchedules(read).state).toBe("upgrade");
        }),
      ),
    ));

  test("a door that breaks reports the Machine unreachable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* schedulesOn(mkPc, { schedules: () => Effect.die("socket closed") });
        expect(read).toMatchObject({ unreachable: true, schedules: [] });
        expect(machineSchedules(read).state).toBe("unreachable");
      }),
    ));
});
