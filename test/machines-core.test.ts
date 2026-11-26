import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { forgetMachine, remoteRoute, rosterOf } from "../desktop/src/bun/machine";
import { addToCore, shOn } from "../desktop/src/bun/onboarding";
import { connect } from "../src/hc";
import { peersOf } from "../src/peers";
import { runEffect } from "./support/effect";
import { twoMachines } from "./support/peers";
import type { Side } from "./support/peers";
import { collieCommand } from "./support/world";

const Logged = Schema.fromJsonString(
  Schema.Struct({ cmd: Schema.String, params: Schema.optionalKey(Schema.Json) }),
);
const Params = Schema.Record(Schema.String, Schema.Json);

const coreCalls = (side: Side) =>
  Effect.gen(function* () {
    const text = yield* (yield* FileSystem.FileSystem).readFileString(side.coreLog);
    return Arr.map(
      Arr.filterMap(Str.split(text, "\n"), (line) => Schema.decodeResult(Logged)(line)),
      (call) => ({
        cmd: call.cmd,
        params: Schema.is(Params)(call.params) ? call.params : {},
      }),
    );
  }).pipe(Effect.orDie);

const called = (side: Side, cmd: string) =>
  Effect.map(coreCalls(side), (calls) => Arr.filter(calls, (call) => call.cmd === cmd));

const sshSaid = (side: Side, mode: string) =>
  Effect.map(side.ssh.calls, (calls) =>
    Arr.filter(calls, (line) => pipe_(line, Str.startsWith(`${mode} `))),
  );

const desktopCollie = (side: Side) =>
  Effect.map(collieCommand, (command) => [
    "env",
    ...Arr.map(Rec.toEntries(side.env), ([key, value]) => `${key}=${value}`),
    ...command,
  ]);

const SECOND = {
  id: "second",
  label: "second",
  target: "mk@second",
  session: "default",
  enabled: true,
};

test("onboarding a VM opens one SSH master, core keeps it with a via that rides it, and Desktop lists core's Machines", () =>
  runEffect(
    twoMachines(
      "collie-core-add-",
      (first) =>
        Effect.gen(function* () {
          const collie = yield* desktopCollie(first);
          expect((yield* rosterOf(collie)).roster).toEqual([]);

          const ssh = `${Str.split(first.env.PATH!, ":")[0]}/ssh`;
          const route = yield* remoteRoute(ssh, collie, SECOND, "desktop-test", true);
          expect((yield* shOn(route, "uname -sm")).code).toBe(0);
          yield* addToCore(collie, "second", "mk@second");

          expect(yield* sshSaid(first, "master")).toHaveLength(1);
          const adds = yield* called(first, "machine.add");
          expect(adds).toHaveLength(1);
          const { name, via: given, ...rest } = adds[0]!.params;
          const via = yield* Schema.decodeUnknownEffect(Schema.String)(given).pipe(Effect.orDie);
          expect(name).toBe("second");
          expect(Rec.keys(rest)).not.toContain("install");
          const [master] = Str.split(
            yield* (yield* FileSystem.FileSystem).readFileString(
              `${first.world.home}/../ssh/masters`,
            ),
            "\n",
          );
          expect(via).toContain(`-S ${master} `);
          expect(via).toContain("ProxyCommand=false");
          expect(via).toEndWith(" mk@second");
          // WARNING: core's dial rides the SSH master, so core does no login of its own.
          expect(yield* sshSaid(first, "ride")).toContain("ride mk@second true");
          expect(yield* sshSaid(first, "login")).toEqual([]);

          const listed = yield* rosterOf(collie);
          expect(listed.backend).toBe("core");
          expect(Arr.map(listed.roster, ({ label, target }) => ({ label, target }))).toEqual([
            { label: "second", target: "mk@second" },
          ]);
        }),
      ["attended.workflow.ts"],
    ),
  ));

test("forgetting a Machine removes it from core and from Pairing, on both sides", () =>
  runEffect(
    twoMachines(
      "collie-core-forget-",
      (first, second) =>
        Effect.gen(function* () {
          const collie = yield* desktopCollie(first);
          expect(
            (yield* first.cli(["machine", "add", "second", "--target", "mk@second"])).envelope.ok,
          ).toBe(true);
          expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          expect(Arr.map(yield* peersOf(first.world.state), (peer) => peer.name)).toEqual([
            "second",
          ]);

          yield* forgetMachine(collie, "second");

          expect(Arr.map(yield* called(first, "machine.rm"), (call) => call.params)).toEqual([
            { machine: "second" },
          ]);
          expect(yield* peersOf(first.world.state)).toEqual([]);
          expect(yield* peersOf(second.world.state)).toEqual([]);
          expect((yield* rosterOf(collie)).roster).toEqual([]);
        }),
      ["attended.workflow.ts"],
    ),
  ));

test("with no master open the via fails at once and logs in nowhere, and a front door's master lets core connect", () =>
  runEffect(
    twoMachines(
      "collie-core-via-",
      (first) =>
        Effect.gen(function* () {
          expect(
            (yield* first.cli(["machine", "add", "second", "--target", "mk@second"])).envelope.ok,
          ).toBe(true);
          yield* first.ssh.drop;

          const retried = yield* Effect.scoped(
            Effect.flatMap(connect(first.core.socketPath), (hc) =>
              hc.call("machine.connect", { machine: "second" }),
            ),
          ).pipe(Effect.orDie);
          expect(retried.state).toBe("unreachable");
          const [, failed] = yield* called(first, "dialled");
          expect(failed?.params).toMatchObject({ code: 255 });
          expect(Number(failed?.params.ms)).toBeLessThan(2000);
          expect(yield* sshSaid(first, "login")).toEqual([]);

          const opened = yield* first.cli(["machine", "connect", "second"]);
          expect(opened.envelope.ok).toBe(true);
          expect(yield* sshSaid(first, "master")).toHaveLength(2);
          expect(yield* sshSaid(first, "login")).toEqual([]);
          const connects = yield* called(first, "machine.connect");
          expect(connects).toHaveLength(2);
          const [, , again] = yield* called(first, "dialled");
          expect(again?.params).toMatchObject({ machine: "second", code: 0 });
        }),
      ["attended.workflow.ts"],
    ),
  ));

test("a Machine whose core list cannot be read is reported as unread, not as none", () =>
  runEffect(
    twoMachines(
      "collie-core-unread-",
      (first, second) =>
        Effect.gen(function* () {
          yield* first.lists([second]);
          expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);

          const unread = yield* first.cli(["machine", "list"], {
            HC_SOCKET: `${first.world.state}/no-such-core.sock`,
          });
          expect(unread.envelope.ok).toBe(true);
          expect(unread.envelope.data).toMatchObject({
            backend: "core",
            roster: null,
            machines: [{ name: "second", added: null }],
          });
          const { rosterFailure } = unread.envelope.data as { rosterFailure: string | null };
          expect(rosterFailure).toContain("core");
          expect(rosterFailure).toContain("no-such-core.sock");

          const read = yield* first.cli(["machine", "list"]);
          expect(read.envelope.data).toMatchObject({
            roster: [{ label: "second" }],
            machines: [{ name: "second", added: true }],
          });
        }),
      ["attended.workflow.ts"],
    ),
  ));

test("a paired Machine core does not have is listed as not added, keeps its pairing, and connect adds it", () =>
  runEffect(
    twoMachines(
      "collie-core-switch-",
      (first, second) =>
        Effect.gen(function* () {
          yield* first.lists([second]);
          expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          yield* first.lists([]);

          const listed = yield* first.cli(["machine", "list"]);
          expect(listed.envelope.data).toMatchObject({
            backend: "core",
            machines: [{ name: "second", added: false }],
          });
          expect(Arr.map(yield* peersOf(first.world.state), (peer) => peer.name)).toEqual([
            "second",
          ]);

          expect((yield* first.cli(["machine", "connect", "second"])).envelope.ok).toBe(true);
          const adds = yield* called(first, "machine.add");
          expect(Arr.map(adds, (call) => call.params.name)).toEqual(["second"]);
          expect(Arr.map(yield* peersOf(first.world.state), (peer) => peer.name)).toEqual([
            "second",
          ]);
        }),
      ["attended.workflow.ts"],
    ),
  ));
