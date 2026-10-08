// What Desktop draws of each Machine's Usage readings: the header's entry per Subscription
// and account, and a Machine's Usage block.

import { describe, expect, test } from "bun:test";
import { Config, Effect, Option, Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { bridgeCommand, openBridge, usageOn } from "../desktop/src/bun/machine";
import { FrontDoorRpcs } from "../src/board-model";
import { epochMs } from "../src/time";
import type { UsageReading, UsageWindow } from "../src/usage-model";
import {
  machineUsage,
  type MachineUsage,
  UPGRADE_SAID,
  usageDue,
  usageEntries,
} from "../desktop/src/shared/usage";
import { suiteEnv } from "./support/effect";
import { root, stopHost } from "./support/host";
import { proves } from "./support/world";

const NOW = epochMs("2026-10-08T08:00:00Z");

const window = (over: Partial<UsageWindow>): UsageWindow => ({
  kind: "session",
  label: "Session",
  model: null,
  usedPercent: 0,
  resetsAt: "2026-10-08T10:10:00Z",
  reached: false,
  ...over,
});

const reading = (over: Partial<UsageReading>): UsageReading => ({
  subscription: "claude",
  account: "org:acct",
  accountLabel: "me@example.com",
  plan: "max",
  windows: [window({ usedPercent: 31 })],
  at: "2026-10-08T07:57:00Z",
  source: "claude-usage",
  problem: null,
  ...over,
});

const machine = (name: string, readings: ReadonlyArray<UsageReading>): MachineUsage => ({
  profile: `p-${name}`,
  name,
  readings,
  problem: null,
});

describe("the header", () => {
  test("two Machines on one account are one entry, showing the newer reading and its Machine", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [reading({ windows: [window({ usedPercent: 40 })] })]),
        machine("vm-mk", [
          reading({ windows: [window({ usedPercent: 72 })], at: "2026-10-08T07:59:00Z" }),
        ]),
      ],
      NOW,
    );
    expect(entries.map(({ text, level }) => [text, level])).toEqual([["Claude 72%", "ok"]]);
    expect(entries[0]?.title).toContain("vm-mk");
    expect(entries[0]?.title).toContain("me@example.com");
    expect(entries[0]?.title).toMatch(/Session resets \S+ \(in 2h 10m\)/);
  });

  test("two accounts are two entries, each named by its label", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [reading({})]),
        machine("vm-mk", [
          reading({ account: "org:other", accountLabel: "ops@example.com" }),
          reading({ subscription: "chatgpt", account: "c-1", accountLabel: "me@example.com" }),
        ]),
      ],
      NOW,
    );
    expect(entries.map(({ text }) => text)).toEqual([
      "Claude me@example.com 31%",
      "Claude ops@example.com 31%",
      "ChatGPT 31%",
    ]);
  });

  test("one email in two organizations is two entries", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [reading({ account: "org-personal:acct" })]),
        machine("vm-mk", [
          reading({ account: "org-team:acct", accountLabel: "me@example.com (Cego)" }),
        ]),
      ],
      NOW,
    );
    expect(entries.map(({ text }) => text)).toEqual([
      "Claude me@example.com 31%",
      "Claude me@example.com (Cego) 31%",
    ]);
  });

  test("amber at 90%, red and out when Exhausted, naming a model whose own window is the busiest", () => {
    const at = (windows: ReadonlyArray<UsageWindow>) =>
      usageEntries([machine("mk-pc", [reading({ windows })])], NOW).map(({ text, level }) => [
        text,
        level,
      ]);
    expect(at([window({ usedPercent: 90 })])).toEqual([["Claude 90%", "warn"]]);
    expect(at([window({ usedPercent: 40, reached: true })])).toEqual([["Claude out", "out"]]);
    expect(
      at([
        window({ usedPercent: 10 }),
        window({ kind: "weekly-model", label: "Weekly Opus", model: "Opus", usedPercent: 100 }),
      ]),
    ).toEqual([["Claude Opus out", "out"]]);
  });

  test("a reading with only a problem makes no entry, and takes none from another Machine", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [reading({})]),
        machine("vm-mk", [
          reading({
            windows: [],
            problem: "Claude Code's login expired",
            at: "2026-10-08T08:00:00Z",
          }),
        ]),
      ],
      NOW,
    );
    expect(entries.map(({ text }) => text)).toEqual(["Claude 31%"]);
  });
});

describe("a Machine's Usage block", () => {
  test("each Subscription's plan and account, each window's meter and reset, and its age and source", () => {
    const shown = machineUsage(
      machine("mk-pc", [
        reading({
          windows: [
            window({ usedPercent: 31 }),
            window({ kind: "weekly", label: "Weekly", usedPercent: 95, resetsAt: null }),
          ],
        }),
      ]),
      NOW,
    );
    expect(shown.said).toBeNull();
    expect(shown.subscriptions).toHaveLength(1);
    const [claude] = shown.subscriptions;
    expect(claude?.title).toBe("Claude · max · me@example.com");
    expect(claude?.said).toBe("as of 3 minutes ago · Claude's usage endpoint");
    expect(claude?.windows.map(({ label, percent, level }) => [label, percent, level])).toEqual([
      ["Session", 31, "ok"],
      ["Weekly", 95, "warn"],
    ]);
    expect(claude?.windows[0]?.reset).toMatch(/^resets \S+ \(in 2h 10m\)$/);
    expect(claude?.windows[1]?.reset).toBeNull();
  });

  test("a window past its reset is shown as unused", () => {
    const shown = machineUsage(
      machine("mk-pc", [
        reading({
          windows: [window({ usedPercent: 100, reached: true, resetsAt: "2026-10-08T07:00:00Z" })],
        }),
      ]),
      NOW,
    );
    expect(shown.subscriptions[0]?.windows.map(({ percent, level }) => [percent, level])).toEqual([
      [0, "ok"],
    ]);
  });

  test("a reading with only a problem says it in its own words; one with windows too adds its age", () => {
    const shown = machineUsage(
      machine("mk-pc", [
        reading({ windows: [], problem: "Claude Code's login expired" }),
        reading({
          subscription: "chatgpt",
          source: "codex-app-server",
          problem: "Codex took too long to answer",
        }),
      ]),
      NOW,
    );
    expect(shown.subscriptions.map(({ said }) => said)).toEqual([
      "Claude Code's login expired",
      "Codex took too long to answer · as of 3 minutes ago · Codex's app server",
    ]);
  });

  test("a Machine whose host cannot say asks for an upgrade", () => {
    const shown = machineUsage({ ...machine("old", []), problem: UPGRADE_SAID }, NOW);
    expect(shown).toEqual({ said: "can't say; upgrade this Machine", subscriptions: [] });
  });
});

test("Desktop asks first at once, then each minute while it is shown", () => {
  expect(usageDue(null, NOW, true)).toBe(true);
  expect(usageDue(NOW - 59_000, NOW, true)).toBe(false);
  expect(usageDue(NOW - 60_000, NOW, true)).toBe(true);
  expect(usageDue(NOW - 600_000, NOW, false)).toBe(false);
});

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const mkPc = { profile: "local", name: "mk-pc" };
type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

describe("the main process asks each Machine's host", () => {
  test(
    "a host that answers gives its readings, each saying why it has no numbers",
    () =>
      proves(
        "collie-desktop-usage-",
        (world) =>
          Effect.gen(function* () {
            const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
            const collie = Option.isSome(binary)
              ? [binary.value]
              : [process.execPath, `${root}src/main.ts`];
            // No Claude login under this HOME and no Codex on this PATH: nothing reaches an endpoint.
            const door = yield* openBridge(bridgeCommand(collie, "mk-pc"), {
              PATH: "/usr/bin:/bin",
              HOME: world.home,
              HERDR_PLUGIN_ROOT: world.install,
              HERDR_PLUGIN_STATE_DIR: world.state,
              COLLIE_USER_DIR: world.config,
              COLLIE_HOST: asCommand(collie),
              ...(yield* suiteEnv),
              HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH ?? "",
              FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG ?? "",
            });
            const read = yield* usageOn(mkPc, door);
            expect(read).toMatchObject({ profile: "local", name: "mk-pc", problem: null });
            expect(read.readings.map(({ subscription }) => subscription)).toEqual([
              "claude",
              "chatgpt",
            ]);
            expect(read.readings.every(({ problem }) => problem !== null)).toBe(true);
            yield* stopHost(world.state);
          }).pipe(Effect.orDie),
        [],
      ),
    120_000,
  );

  test("a host without the call asks for an upgrade rather than showing nothing", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // An older host: it serves operations, but not `usage`.
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
          expect(yield* usageOn(mkPc, client.client)).toEqual({
            profile: "local",
            name: "mk-pc",
            readings: [],
            problem: "can't say; upgrade this Machine",
          });
        }),
      ),
    ));
});
