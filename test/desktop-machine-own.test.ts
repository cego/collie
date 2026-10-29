import { expect, test } from "bun:test";
import { Effect, FileSystem, Stream } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { applyItem, EMPTY_FLOCK, machineRows } from "../desktop/src/shared/flock";
import { machineOwnRows } from "../desktop/src/shared/machine-own";
import { type Door, flockStream, machineOwnOn } from "../desktop/src/bun/machine";
import { BoardMessage, FrontDoorRpcs, HostRefused } from "../src/board-model";
import { savedOwn, saveOwn } from "../desktop/src/bun/saved";
import { runEffect } from "./support/effect";
import { epochMs } from "../src/time";

const machine = { profile: "vm", name: "vm", target: "mk@vm", route: "link" as const };
const at = epochMs("2026-10-29T11:30:00Z");
const values = {
  projectsRoot: "/work",
  chatHarness: "pi",
  harnesses: ["codex"],
  remembered: [{ key: "linear.team", value: "TOOLS" }],
};
const routed = () => applyItem(EMPTY_FLOCK, { _tag: "Routed", machine });
const rowsOf = (flock: ReturnType<typeof routed>) =>
  machineOwnRows(machineRows(flock), flock.own, at + 60_000, "UTC");

test("a Machine out of reach retains its values and the time they were read", () => {
  let flock = applyItem(routed(), {
    _tag: "OwnRead",
    machine,
    reading: { values, at, problem: null, unsupported: false },
  });
  flock = applyItem(flock, {
    _tag: "Lost",
    machine,
    state: "unreachable",
    reason: "connection closed",
    at: at + 1,
  });
  const row = rowsOf(flock)[0]!;
  expect(row).toMatchObject({
    name: "vm",
    where: "mk@vm",
    projectsRoot: "/work",
    chatHarness: "pi",
    harnesses: ["codex"],
    remembered: [{ key: "linear.team", value: "TOOLS" }],
    at,
  });
  expect(row.detail).toContain("Last read");
  expect(row.sync).toEqual({ said: "Out of reach", tone: "warn" });
  flock = applyItem(flock, {
    _tag: "OwnRead",
    machine,
    reading: { values: null, at: at + 50_000, problem: "socket closed", unsupported: false },
  });
  expect(rowsOf(flock)[0]).toMatchObject({ projectsRoot: "/work", at });
});

test("an older host is not known and names its release instead of showing empty config", () => {
  const flock = applyItem(routed(), {
    _tag: "OwnRead",
    machine,
    reading: { values: null, at, problem: null, unsupported: true },
  });
  const rows = machineRows(flock).map((row) => ({
    ...row,
    state: "live" as const,
    build: "0.105.0",
  }));
  expect(machineOwnRows(rows, flock.own, at)[0]).toMatchObject({
    projectsRoot: null,
    chatHarness: null,
    detail: "Not known: vm runs Collie 0.105.0",
  });
});

test("a live Machine's table row reports sync and keeps unset separate from an unread config", () => {
  let flock = applyItem(routed(), {
    _tag: "OwnRead",
    machine,
    reading: { values: { harnesses: [], remembered: [] }, at, problem: null, unsupported: false },
  });
  flock = applyItem(flock, {
    _tag: "Synced",
    machine,
    part: "settings",
    failed: "permission denied",
  });
  const rows = machineRows(flock).map((row) => ({ ...row, state: "live" as const }));
  expect(machineOwnRows(rows, flock.own, at)[0]).toMatchObject({
    projectsRoot: "Not set",
    chatHarness: "Not set",
    sync: { said: "Behind", tone: "warn" },
  });
});

test("a failed read does not turn into an empty successful reading", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* machineOwnOn(machine, { machineOwn: () => Effect.die("socket closed") });
      expect(read.reading).toMatchObject({ values: null, unsupported: false });
      expect(read.reading.problem).toContain("socket closed");
    }),
  ));

test("a host's refused read keeps the reason the operator can fix", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* machineOwnOn(machine, {
        // SAFETY: the reader asks for a reply, never discard mode.
        machineOwn: (() =>
          Effect.fail(
            new HostRefused({ reason: "config.json is not readable" }),
          )) as Door["machineOwn"],
      });
      expect(read.reading.problem).toBe("config.json is not readable");
    }),
  ));

test("a saved reading survives reopening Desktop with that Machine out of reach", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* saveOwn(dir, {
        _tag: "OwnRead",
        machine,
        reading: { values, at, problem: null, unsupported: false },
      });
      const saved = yield* savedOwn(dir);
      const flock = saved.reduce(applyItem, routed());
      expect(rowsOf(flock)[0]).toMatchObject({
        projectsRoot: "/work",
        at,
        detail: "Last read 11:30",
      });
    }),
  ));

test("a paired base host still draws its board after refusing the additive RPC", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const Older = RpcGroup.make(Rpc.make("board", { success: BoardMessage, stream: true }));
        type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;
        let toClient: (message: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () =>
          Effect.void;
        const server = yield* RpcServer.makeNoSerialization(Older, {
          // SAFETY: the older server's responses use the same RPC envelopes.
          onFromServer: (message) => toClient(message),
        }).pipe(
          Effect.provide(
            Older.toLayer({
              board: () =>
                Stream.make({
                  _tag: "Snapshot",
                  build: "0.105.0",
                  protocol: 4,
                  installation: "i-vm",
                  herds: [],
                  tasks: [],
                  seq: 0,
                }).pipe(Stream.concat(Stream.never)),
            }),
          ),
        );
        const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
          supportsAck: true,
          // SAFETY: a newer client can send a tag the older server does not know.
          onFromClient: ({ message }) => server.write(0, message as never),
        });
        toClient = client.write;
        const read = yield* machineOwnOn(machine, client.client);
        const board = yield* flockStream(
          [
            {
              machine,
              open: () => Effect.succeed({ board: () => client.client.board() }),
              collie: () => Effect.die("the paired base host must not need a new protocol"),
            },
          ],
          new Map(),
          "0.105.0",
        ).pipe(Stream.take(1), Stream.runCollect);
        const flock = [...board, read].reduce(applyItem, routed());
        expect(flock.machines.get("i-vm")).toMatchObject({
          asOf: null,
          build: "0.105.0",
          protocol: 4,
          machine: { route: "link" },
        });
        expect(flock.lost.size).toBe(0);
        expect(rowsOf(flock)[0]?.detail).toBe("Not known: vm runs Collie 0.105.0");
      }),
    ),
  ));
