// What Desktop draws of each Machine's Usage readings: the header's entry per Subscription
// and account, and the Usage page.

import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import { Config, Effect, Option, Schema, flow, Result } from "effect";
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
  type MachineUsage,
  UPGRADE_SAID,
  usageDue,
  usageAccounts,
  usageEntries,
  usagePage,
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

const chatgpt = (over: Partial<UsageReading>) =>
  reading({ subscription: "chatgpt", account: "workspace", source: "codex-app-server", ...over });

const LIVE = ["p-mk-pc", "p-vm-mk"];

describe("the header", () => {
  test("two Machines on one account are one entry, showing the newer reading and its Machine", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [reading({ windows: [window({ usedPercent: 40 })] })]),
        machine("vm-mk", [
          reading({ windows: [window({ usedPercent: 72 })], at: "2026-10-08T07:59:00Z" }),
        ]),
      ],
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text, level }) => [text, level])).toEqual([["Claude 72%", "ok"]]);
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
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text }) => text)).toEqual([
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
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text }) => text)).toEqual([
      "Claude me@example.com 31%",
      "Claude me@example.com (Cego) 31%",
    ]);
  });

  test("amber at 90%, red and out when Exhausted, naming a model whose own window is the busiest", () => {
    const at = (windows: ReadonlyArray<UsageWindow>) =>
      Arr.map(
        usageEntries([machine("mk-pc", [reading({ windows })])], LIVE, NOW),
        ({ text, level }) => [text, level],
      );
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
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text }) => text)).toEqual(["Claude 31%"]);
  });

  test("two ChatGPT seats of one workspace are two entries, each named by its email", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [chatgpt({ accountLabel: "me@example.com" })]),
        machine("vm-mk", [chatgpt({ accountLabel: "ops@example.com" })]),
      ],
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text }) => text)).toEqual([
      "ChatGPT me@example.com 31%",
      "ChatGPT ops@example.com 31%",
    ]);
  });

  test("one ChatGPT seat on two Machines is one entry, showing the newer reading and its Machine", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [
          chatgpt({ windows: [window({ usedPercent: 72 })], at: "2026-10-08T07:59:00Z" }),
        ]),
        machine("vm-mk", [chatgpt({ windows: [window({ usedPercent: 40 })] })]),
      ],
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text }) => text)).toEqual(["ChatGPT 72%"]);
    expect(entries[0]?.title).toContain("mk-pc");
  });

  test("a reading with no account and windows is its own Machine's entry", () => {
    const entries = usageEntries(
      [
        machine("mk-pc", [reading({ account: null, accountLabel: null })]),
        machine("vm-mk", [
          reading({ account: null, accountLabel: null, windows: [window({ usedPercent: 50 })] }),
        ]),
      ],
      LIVE,
      NOW,
    );
    expect(Arr.map(entries, ({ text }) => text)).toEqual(["Claude 31%", "Claude 50%"]);
    expect(entries[1]?.title).toContain("vm-mk");
  });
});

describe("a Subscription account across Machines", () => {
  test("a Machine that is not live adds nothing and takes nothing from another's reading", () => {
    const machines = [
      machine("mk-pc", [reading({})]),
      machine("gone", [
        reading({ windows: [window({ usedPercent: 90 })], at: "2026-10-08T07:59:00Z" }),
        chatgpt({}),
      ]),
    ];
    const accounts = usageAccounts(machines, ["p-mk-pc"]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.newest?.machine).toBe("mk-pc");
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(accounts[0]), (present) =>
          Arr.map(present.machines, ({ machine }) => machine),
        ),
      ),
    ).toEqual(["mk-pc"]);
    expect(Arr.map(usageEntries(machines, ["p-mk-pc"], NOW), ({ text }) => text)).toEqual([
      "Claude 31%",
    ]);
  });

  test("lists every live Machine on the account with its own reading, in the Flock's order", () => {
    const expired = reading({ windows: [], problem: "Claude Code's login expired" });
    const accounts = usageAccounts(
      [machine("mk-pc", [reading({})]), machine("vm-mk", [expired])],
      ["p-vm-mk", "p-mk-pc"],
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.newest?.machine).toBe("mk-pc");
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(accounts[0]), (present_) =>
          Arr.map(present_.machines, ({ machine, reading }) => [machine, reading.problem]),
        ),
      ),
    ).toEqual([
      ["vm-mk", "Claude Code's login expired"],
      ["mk-pc", null],
    ]);
  });

  test("an account read only with problems is a group with no newest reading", () => {
    const accounts = usageAccounts(
      [machine("mk-pc", [reading({ windows: [], problem: "Claude Code's login expired" })])],
      ["p-mk-pc"],
    );
    expect(Arr.map(accounts, ({ newest, machines }) => [newest, machines.length])).toEqual([
      [null, 1],
    ]);
  });

  test("ordered by Subscription, then by account label with none last", () => {
    const accounts = usageAccounts(
      [
        machine("mk-pc", [
          chatgpt({ accountLabel: "me@example.com" }),
          reading({ account: null, accountLabel: null }),
          reading({ account: "org:z", accountLabel: "z@example.com" }),
          reading({ account: "org:a", accountLabel: "a@example.com" }),
        ]),
      ],
      ["p-mk-pc"],
    );
    expect(Arr.map(accounts, ({ subscription, label }) => [subscription, label])).toEqual([
      ["claude", "a@example.com"],
      ["claude", "z@example.com"],
      ["claude", null],
      ["chatgpt", "me@example.com"],
    ]);
  });
});

describe("the Usage page", () => {
  const LAPTOP = ["p-mk-laptop", "p-vm-mk"];
  const EXPIRED = "Claude Code's login expired; it refreshes when Claude Code next runs";

  test("one Claude seat and one ChatGPT account on two Machines are two sections, each listing both", () => {
    const team = reading({ account: "org-cego:acct", accountLabel: "mk@cego.dk" });
    const seat = chatgpt({ accountLabel: "mk@cego.dk", plan: "team" });
    const page = usagePage(
      [
        machine("mk-laptop", [
          team,
          { ...seat, windows: [window({ usedPercent: 2 })], at: "2026-10-08T07:59:00Z" },
        ]),
        machine("vm-mk", [
          { ...team, windows: [window({ usedPercent: 72 })], at: "2026-10-08T07:59:00Z" },
          seat,
        ]),
      ],
      LAPTOP,
      NOW,
    );
    expect(page.notRead).toEqual([]);
    expect(
      Arr.map(page.sections, ({ title, windows, said, machines }) => [
        title,
        Arr.map(windows, ({ percent }) => percent),
        said,
        machines,
      ]),
    ).toEqual([
      [
        "Claude · max · mk@cego.dk",
        [72],
        "as of 1 minute ago · read on vm-mk · Claude's usage endpoint",
        [
          { name: "mk-laptop", problem: null },
          { name: "vm-mk", problem: null },
        ],
      ],
      [
        "ChatGPT · team · mk@cego.dk",
        [2],
        "as of 1 minute ago · read on mk-laptop · Codex's app server",
        [
          { name: "mk-laptop", problem: null },
          { name: "vm-mk", problem: null },
        ],
      ],
    ]);
  });

  test("an expired login on one Machine is said beside it while the other's windows are shown", () => {
    const page = usagePage(
      [
        machine("mk-laptop", [
          reading({ windows: [], problem: EXPIRED, at: "2026-10-08T07:59:00Z" }),
        ]),
        machine("vm-mk", [reading({})]),
      ],
      LAPTOP,
      NOW,
    );
    expect(page.sections).toHaveLength(1);
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(page.sections[0]), (present__) =>
          Arr.map(present__.windows, ({ percent }) => percent),
        ),
      ),
    ).toEqual([31]);
    expect(page.sections[0]?.said).toContain("read on vm-mk");
    expect(page.sections[0]?.machines).toEqual([
      { name: "mk-laptop", problem: EXPIRED },
      { name: "vm-mk", problem: null },
    ]);
  });

  test("an account read only with problems is a section with its title and no windows", () => {
    const page = usagePage(
      [
        machine("mk-laptop", [reading({ windows: [], problem: EXPIRED })]),
        machine("vm-mk", [reading({ windows: [], problem: "Claude's usage endpoint refused" })]),
      ],
      LAPTOP,
      NOW,
    );
    expect(page.sections).toEqual([
      {
        key: "claude:org:acct",
        title: "Claude · max · me@example.com",
        windows: [],
        said: null,
        machines: [
          { name: "mk-laptop", problem: EXPIRED },
          { name: "vm-mk", problem: "Claude's usage endpoint refused" },
        ],
      },
    ]);
  });

  test("a reading with no account and no numbers, and a Machine whose host gave none, are Not read", () => {
    const page = usagePage(
      [
        { ...machine("mk-laptop", []), problem: UPGRADE_SAID },
        machine("vm-mk", [
          chatgpt({
            account: null,
            accountLabel: null,
            windows: [],
            problem: "Codex is not logged in on this Machine; run `codex login`",
          }),
        ]),
      ],
      LAPTOP,
      NOW,
    );
    expect(page.sections).toEqual([]);
    expect(Arr.map(page.notRead, ({ said }) => said)).toEqual([
      "mk-laptop: can't say; upgrade this Machine",
      "vm-mk · ChatGPT: Codex is not logged in on this Machine; run `codex login`",
    ]);
  });

  test("a window past its reset is unused, and a full one is out", () => {
    const page = usagePage(
      [
        machine("mk-laptop", [
          reading({
            windows: [
              window({ usedPercent: 100, reached: true, resetsAt: "2026-10-08T07:00:00Z" }),
              window({ kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: null }),
              window({ kind: "weekly", label: "Weekly", usedPercent: 95, resetsAt: null }),
            ],
          }),
        ]),
      ],
      LAPTOP,
      NOW,
    );
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(page.sections[0]), (present___) =>
          Arr.map(present___.windows, ({ percent, level }) => [percent, level]),
        ),
      ),
    ).toEqual([
      [0, "ok"],
      [100, "out"],
      [95, "warn"],
    ]);
  });

  test("a Machine that is not live is nowhere on the page", () => {
    const page = usagePage(
      [
        machine("mk-laptop", [reading({})]),
        { ...machine("gone", [reading({ windows: [], problem: EXPIRED })]), problem: null },
        { ...machine("old", []), problem: UPGRADE_SAID },
        machine("off", [chatgpt({ account: null, windows: [], problem: "not logged in" })]),
      ],
      ["p-mk-laptop"],
      NOW,
    );
    expect(Arr.map(page.sections, ({ machines }) => machines)).toEqual([
      [{ name: "mk-laptop", problem: null }],
    ]);
    expect(page.notRead).toEqual([]);
  });
});

test("Desktop asks first at once, then each minute while it is shown", () => {
  expect(usageDue(null, NOW, true)).toBe(true);
  expect(usageDue(NOW - 59_000, NOW, true)).toBe(false);
  expect(usageDue(NOW - 60_000, NOW, true)).toBe(true);
  expect(usageDue(NOW - 600_000, NOW, false)).toBe(false);
});

const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);
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
            expect(Arr.map(read.readings, ({ subscription }) => subscription)).toEqual([
              "claude",
              "chatgpt",
            ]);
            expect(Arr.every(read.readings, ({ problem }) => problem !== null)).toBe(true);
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
