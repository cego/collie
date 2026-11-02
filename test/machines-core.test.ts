// On a Machine set to core, Collie's Machines are core's (ticket 11): a VM is added with a
// `via` that rides this computer's SSH master, so core never logs in by itself; forgetting
// one removes it from core and from Pairing; and a pairing core does not list yet is kept.
// Two real hosts, the fake `ssh`, and a fake core that dials each `via` as core does.

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
import { twoMachines, type Side } from "./support/peers";
import { collieCommand } from "./support/world";

const Logged = Schema.fromJsonString(
  Schema.Struct({ cmd: Schema.String, params: Schema.optionalKey(Schema.Json) }),
);
const Params = Schema.Record(Schema.String, Schema.Json);

/** What `side`'s core was asked, in order, with what it was given. */
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

/** The first's `collie` as Desktop runs it, with that Machine's environment. */
const desktopCollie = (side: Side) =>
  Effect.map(collieCommand, (command) => [
    "env",
    ...Arr.map(Rec.toEntries(side.env), ([key, value]) => `${key}=${value}`),
    ...command,
  ]);

/** Sets `side`'s terminal backend, as the human switches it. */
const setBackend = (side: Side, backend: "core" | "herdr") =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(`${side.world.config}/config.json`, `{ "terminal_backend": "${backend}" }`),
  ).pipe(Effect.orDie);

const SECOND = {
  id: "second",
  label: "second",
  target: "mk@second",
  session: "default",
  enabled: true,
};

test(
  "onboarding a VM opens one SSH master, core keeps it with a via that rides it, and Desktop lists core's Machines",
  () =>
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
            // Core's dial rode the master: no login of its own.
            expect(yield* sshSaid(first, "ride")).toContain("ride mk@second true");
            expect(yield* sshSaid(first, "login")).toEqual([]);

            const listed = yield* rosterOf(collie);
            expect(listed.backend).toBe("core");
            expect(Arr.map(listed.roster, ({ label, target }) => ({ label, target }))).toEqual([
              { label: "second", target: "mk@second" },
            ]);
          }),
        ["attended.workflow.ts"],
        { core: true },
      ),
    ),
  120_000,
);

test(
  "forgetting a Machine removes it from core and from Pairing, on both sides",
  () =>
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
        { core: true },
      ),
    ),
  120_000,
);

test(
  "with no master open the via fails at once and logs in nowhere, and a front door's master lets core connect",
  () =>
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
              Effect.flatMap(connect(first.core!.socketPath), (hc) =>
                hc.call("machine.connect", { machine: "second" }),
              ),
            ).pipe(Effect.orDie);
            expect(retried.state).toBe("unreachable");
            const [, failed] = yield* called(first, "dialled");
            expect(failed?.params).toMatchObject({ code: 255 });
            expect(Number(failed?.params.ms)).toBeLessThan(2_000);
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
        { core: true },
      ),
    ),
  120_000,
);

test(
  "switching a paired Machine to core forgets no pairing, lists it as not added, and connect adds it",
  () =>
    runEffect(
      twoMachines(
        "collie-core-switch-",
        (first, second) =>
          Effect.gen(function* () {
            yield* setBackend(first, "herdr");
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            yield* setBackend(first, "core");

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
        { core: true },
      ),
    ),
  120_000,
);

test(
  "a Machine set to herdr reads herdr's machine list and never asks core for its machines",
  () =>
    runEffect(
      twoMachines(
        "collie-core-herdr-",
        (first, second) =>
          Effect.gen(function* () {
            yield* setBackend(first, "herdr");
            yield* first.lists([second]);
            const collie = yield* desktopCollie(first);

            const listed = yield* rosterOf(collie);
            expect(listed.backend).toBe("herdr");
            expect(Arr.map(listed.roster, (machine) => machine.label)).toEqual(["second"]);
            expect((yield* first.cli(["machine", "list"])).envelope.ok).toBe(true);
            const herdrLog = yield* (yield* FileSystem.FileSystem).readFileString(first.herdrLog);
            expect(herdrLog).toContain("machine list");
            expect(yield* called(first, "machine.list")).toEqual([]);
          }),
        ["attended.workflow.ts"],
        { core: true },
      ),
    ),
  120_000,
);
