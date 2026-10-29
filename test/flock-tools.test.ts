// Desktop's Flock chat calls the same Collie tools Native chat does, answered by each
// Machine's host over its `chat` channel, with everything named `<machine>:<id>`.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ATTACHMENT_BYTES } from "../src/attachments";
import type { HelleProject } from "../src/helle";
import { epochMs } from "../src/time";
import { type Declaration, PROTOCOL, type TaskView } from "../src/board-model";
import type { JsonObject } from "../src/schema";
import { callFileTool, type ToolContent } from "../desktop/src/bun/file-tools";
import {
  callFlockTool,
  type ChatDoor,
  type ChatMachine,
  type Reached,
} from "../desktop/src/bun/flock-tools";
import type { ChatBoard, DesktopSettings } from "../desktop/src/shared/flock";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
import type { Attempted } from "../desktop/src/bun/sent";
import { changeSettings } from "../desktop/src/bun/settings";
import { tableOffer } from "../desktop/src/bun/chat-choices";
import type { ChatChoices } from "../desktop/src/shared/chat-choices";
import { fastForward } from "./support/effect";
import { task } from "./support/task";

interface Asked {
  readonly machine: string;
  readonly op: string;
  readonly payload: unknown;
}

/** A Machine whose board Desktop follows live, and whose host writes down every operation it is asked. */
const machine = (
  name: string,
  tasks: ReadonlyArray<TaskView>,
  asked: Asked[],
  protocol = PROTOCOL,
  files = true,
): Reached => {
  const note = <P>(op: string, payload: P) => asked.push({ machine: name, op, payload });
  const door: ChatDoor & { readonly board: () => Stream.Stream<never> } = {
    // The chat reads the board Desktop follows, never one of its own.
    board: () => Stream.die("the chat subscribed to a host's board"),
    declare: (payload: Declaration) =>
      Effect.sync(() => {
        note("declare", payload);
      }),
    act: (payload) =>
      Effect.sync(() => {
        note("act", payload);
        return [{ kind: "stop", state: "applied", note: "" }];
      }),
    control: (payload) =>
      Effect.sync(() => {
        note("control", payload);
        return {
          runId: payload.runId,
          control: payload.control,
          set: payload.set,
          applied: true,
          detail: `Held ${payload.runId}`,
          left: [],
        };
      }),
    confirm: (payload) =>
      Effect.sync(() => {
        note("confirm", payload);
        return { proposal: payload.proposal, results: [] };
      }),
    decline: (payload) =>
      Effect.sync(() => {
        note("decline", payload);
        return { proposal: payload.proposal };
      }),
    dispose: (payload) =>
      Effect.sync(() => {
        note("dispose", payload);
        return { at: "", by: "chat", kind: payload.kind, ref: payload.ref, note: null };
      }),
    seen: (payload) =>
      Effect.sync(() => {
        note("seen", payload);
        return { at: "", by: "chat" };
      }),
    propose: (payload) =>
      Effect.sync(() => {
        note("propose", payload);
        return { ok: true, code: null, human: "Carried out.", data: null };
      }),
    news: (payload) =>
      Effect.sync(() => {
        note("news", payload);
        return {
          items: [
            {
              key: "k1",
              run: "r-1",
              text: "r-1 finished.",
              at: "",
              significance: "consequential" as const,
            },
          ],
          omitted: 0,
        };
      }),
    readFile: (payload) =>
      Effect.sync(() => {
        note("readFile", payload);
        const [mediaType = "text/plain", bytes = ""] = ON_DISK.get(payload.path) ?? [];
        return {
          path: payload.path,
          size: bytes.length,
          mediaType,
          content: Buffer.from(
            bytes.slice(
              payload.offset ?? 0,
              (payload.offset ?? 0) + (payload.length ?? bytes.length),
            ),
            "latin1",
          ).toString("base64"),
        };
      }),
    glob: (payload) =>
      Effect.sync(() => {
        note("glob", payload);
        return { paths: ["/src/a.ts"], omitted: 0 };
      }),
    grep: (payload) =>
      Effect.sync(() => {
        note("grep", payload);
        return { text: "/src/a.ts", omitted: 0 };
      }),
    writeFile: (payload) =>
      Effect.sync(() => {
        note("writeFile", payload);
        return { path: payload.path, bytes: payload.content.length };
      }),
    upload: (payload) =>
      Effect.sync(() => {
        note("upload", payload);
        return { path: `/state/uploads/${payload.sha256}/${payload.name}` };
      }),
    editFile: (payload) =>
      Effect.sync(() => {
        note("editFile", payload);
        return { path: payload.path, replaced: 1 };
      }),
    progress: () => Effect.succeed(null),
    read: (payload) =>
      Effect.sync(() => {
        note("read", payload);
        return `${payload.tool} answered by ${name}`;
      }),
    models: () =>
      Effect.sync(() => {
        note("models", {});
        const opus = {
          model: "opus",
          label: "Opus 5.5",
          description: null,
          efforts: ["low", "high"],
          defaultEffort: null,
          hidden: false,
          from: "harness" as const,
        };
        const qwen = { ...opus, model: "ollama/qwen3-coder:30b", label: "qwen3-coder:30b" };
        const at = "2026-10-29T09:00:00.000Z";
        return [
          { harness: "claude", at, table: null, entries: [opus] },
          ...(name === "vm-mk" ? [{ harness: "pi", at, table: null, entries: [qwen] }] : []),
        ];
      }),
    schedules: () =>
      Effect.sync(() => {
        note("schedules", {});
        const host = { installation: `i-${name}`, hostname: name };
        const vm = name === "vm-mk";
        return {
          machine: host,
          schedules: [
            {
              machine: host,
              name: vm ? "daily" : "nightly",
              workflow: "proof",
              checkout: "/src/collie",
              cron: "0 7 * * *",
              tz: "UTC",
              paused: !vm,
              start: {
                workflow: "proof",
                inputs: { note: "daily" },
                workspace: "/src/collie",
                verify: [],
              },
              next: "2026-10-14T07:00:00.000Z",
              last: {
                occurrence: "2026-10-13T07:00:00.000Z",
                outcome: { kind: "run" as const, run: "r-2", status: "complete" },
              },
            },
          ],
        };
      }),
    changeSchedule: (payload) =>
      Effect.sync(() => {
        note("changeSchedule", payload);
        return {
          machine: { installation: `i-${name}`, hostname: name },
          change: payload.change.change,
          name: payload.change.name,
          schedule: null,
        };
      }),
    claimedInHelle: (payload) =>
      Effect.sync(() => {
        note("claimedInHelle", payload);
        return [];
      }),
  };
  return {
    name,
    door,
    board: { _tag: "Live", herds: [{ id: "h1" }], tasks, protocol, files },
  };
};

/** A Machine the window shows with no live board, and no channel to reach it by. */
const unread = (name: string, board: ChatBoard): ChatMachine => ({ name, board });

/** What a fake Machine's files hold: a media type and the bytes. */
/** A PNG's header, as a string of bytes, for an image of that size. */
const png = (width: number, height: number) => {
  const header = Buffer.alloc(24);
  Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1").copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("latin1");
};

const ON_DISK = new Map([
  ["/var/log/app.log", ["text/plain", "one\ntwo\nthree\nfour\n"]],
  ["/tmp/shot.png", ["image/png", png(640, 480)]],
  ["/tmp/wide.png", ["image/png", png(2560, 1600)]],
  ["/tmp/bundle.js", ["text/javascript", "x".repeat(20 * 1024 * 1024)]],
  ["/tmp/trace.zip", ["application/zip", "PK\u0003\u0004"]],
]);
let saved: string | undefined;
const savedRule = () => saved;
let chat: DesktopSettings = { proactive: true };

const flockOf = (asked: Asked[]) => ({
  machines: () => [
    machine("mk-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked),
    machine(
      "vm-mk",
      [
        task({ id: "t-b", run: "r-2", runs: ["r-2"], name: "Fix board bugs" }),
        task({ id: "t-c", run: "r-1", runs: ["r-1"] }),
      ],
      asked,
    ),
  ],
  conversation: "flock@mk-pc",
  said: () => "stop the board bugs one",
  machineRule: () => saved,
  setMachineRule: (rule: string) => Effect.sync(() => (saved = rule)),
  chatHarness: () => ({
    harness: chat.chatHarness ?? "claude",
    model: chat.chatModel,
    effort: chat.chatEffort,
  }),
  chatChoices: Effect.sync((): ChatChoices => ({
    heldOn: "claude",
    runsOn: { harness: "claude", model: "opus", effort: "medium" },
    turning: false,
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: tableOffer("claude", chat, NO_FLOCK_SETTINGS, {}),
      },
      {
        harness: "pi",
        label: "Pi",
        installed: false,
        offered: tableOffer("pi", chat, NO_FLOCK_SETTINGS, {}),
      },
    ],
  })),
  // Saved as Desktop saves it, with Settings' checks.
  setChatHarness: ({
    harness,
    model,
    effort,
  }: {
    harness?: string;
    model?: string;
    effort?: string;
  }) =>
    Effect.sync(() => {
      const changed: Partial<Record<"chatHarness" | "chatModel" | "chatEffort", string>> = {};
      if (harness !== undefined) changed.chatHarness = harness;
      if (model !== undefined) changed.chatModel = model;
      if (effort !== undefined) changed.chatEffort = effort;
      const next = changeSettings(chat, NO_FLOCK_SETTINGS, changed);
      if ("refused" in next) return next.refused;
      chat = next;
      return null;
    }),
  inSync: (sync: string | undefined) =>
    Effect.succeed(sync === undefined ? "every Machine is in sync" : `synced ${sync}`),
  attachments: () => undefined,
  uploaded: new Map(),
});

const call = (asked: Asked[], name: string, input: JsonObject) =>
  callFlockTool(flockOf(asked), name, input).pipe(Effect.provide(BunServices.layer));

test("collie_herd is every Machine's board, each Run named by its Machine", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const said = yield* call([], "collie_herd", {});
      expect(said).toContain("run mk-pc:r-1:");
      expect(said).toContain("run vm-mk:r-2: Fix board bugs");
      expect(said).toContain("run vm-mk:r-1:");
    }),
  ));

test("a bare id only one Machine has acts there, under its own id, in the human's words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_do", { actions: [{ kind: "stop", run: "r-2" }] });
      expect(said).toBe("stop: applied");
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "vm-mk declare",
        "vm-mk act",
      ]);
      expect(asked[0]!.payload).toEqual({
        frontDoor: "chat",
        conversation: "flock@mk-pc",
        said: "stop the board bugs one",
      });
      expect(asked[1]!.payload).toMatchObject({ actions: [{ kind: "stop", run: "r-2" }] });
    }),
  ));

test("an id two Machines have is refused with both candidates, and nothing is done", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_do", { actions: [{ kind: "stop", run: "r-1" }] });
      expect(said).toContain("mk-pc:r-1");
      expect(said).toContain("vm-mk:r-1");
      expect(asked).toEqual([]);
    }),
  ));

test("a Run named with its Machine goes to that Machine", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      yield* call(asked, "collie_hold", { run: "mk-pc:r-1", reason: "lunch" });
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "mk-pc declare",
        "mk-pc control",
      ]);
      expect(asked[1]!.payload).toMatchObject({
        runId: "r-1",
        control: "hold",
        set: true,
        reason: "lunch",
      });
    }),
  ));

test("a proposal's actions go to the one Machine they name, with their own ids", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_propose", {
        interpretation: "release it",
        actions: [{ kind: "release", run: "vm-mk:r-1" }],
        request_id: "req-1",
      });
      expect(said).toBe("Request: req-1\nCarried out.");
      expect(asked.at(-1)).toEqual({
        machine: "vm-mk",
        op: "propose",
        payload: {
          herd: null,
          interpretation: "release it",
          actions: [{ kind: "release", run: "r-1" }],
          request: "req-1",
        },
      });
    }),
  ));

test("the Flock lists each Machine's Schedules and pauses a remote one by its qualified name", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const listed = yield* call(asked, "collie_schedules", {});
      expect(listed).toContain("vm-mk:daily");
      expect(listed).toContain("mk-pc:nightly");
      expect(listed).toContain("UTC\tproof\t/src/collie\tpaused");
      expect(listed).toContain("2026-10-14T07:00:00.000Z");
      expect(listed).toContain("r-2 complete");
      asked.length = 0;
      const said = yield* call(asked, "collie_propose", {
        interpretation: "pause the vm's daily run",
        actions: [{ kind: "schedule_pause", name: "vm-mk:daily" }],
      });
      expect(said).toContain("vm-mk:daily");
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "vm-mk declare",
        "vm-mk propose",
      ]);
      expect(asked.at(-1)?.payload).toMatchObject({
        actions: [{ kind: "schedule_pause", name: "daily" }],
      });
    }),
  ));

test("a Schedule add names its Machine, and an unnamed or conflicting target changes nothing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const add = {
        kind: "schedule_add",
        name: "daily",
        cron: "0 7 * * *",
        start: { workflow: "proof", inputs: { note: "daily" }, workspace: "/src/collie" },
      };
      const proposing = (action: JsonObject) =>
        call(asked, "collie_propose", {
          interpretation: "schedule a daily proof on the vm",
          actions: [action],
        });
      expect(yield* proposing(add)).toContain("Name the Machine");
      expect(asked).toEqual([]);
      expect(
        yield* call(asked, "collie_propose", {
          interpretation: "add one and pause the vm's daily Schedule",
          actions: [add, { kind: "schedule_pause", name: "vm-mk:daily" }],
        }),
      ).toContain("Name the Machine");
      expect(asked).toEqual([]);
      expect(yield* proposing({ ...add, machine: "vm-mk" })).toContain("vm-mk:daily");
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "vm-mk declare",
        "vm-mk propose",
      ]);
      expect(asked.at(-1)?.payload).toMatchObject({ actions: [add] });
      expect(asked[0]?.payload).toMatchObject({
        frontDoor: "chat",
        conversation: "flock@mk-pc",
        said: "stop the board bugs one",
      });
      asked.length = 0;
      const qualified = { ...add, start: { ...add.start, workspace: "vm-mk:/src/collie" } };
      yield* proposing(qualified);
      expect(asked.at(-1)?.payload).toMatchObject({ actions: [add] });
      expect(asked.every(({ machine }) => machine === "vm-mk")).toBe(true);
      asked.length = 0;
      expect(yield* proposing({ ...qualified, machine: "mk-pc" })).toContain("different Machines");
      expect(asked).toEqual([]);
      expect(yield* proposing({ ...add, machine: "unknown" })).toContain('No Machine "unknown"');
      expect(asked).toEqual([]);
      expect(
        yield* proposing({ ...add, machine: "vm-mk", start: { ...add.start, here: true } }),
      ).toContain("refused");
      expect(asked).toEqual([]);
    }),
  ));

test("a cleanup goes to the Machine it names, and naming none of several changes nothing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      for (const kind of ["cleanup", "home_cleanup"]) {
        asked.length = 0;
        const proposing = (action: JsonObject) =>
          call(asked, "collie_propose", {
            interpretation: "clean up the vm",
            actions: [action],
          });
        expect(yield* proposing({ kind, machine: "vm-mk" })).toContain("Carried out.");
        expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
          "vm-mk declare",
          "vm-mk propose",
        ]);
        expect(asked.at(-1)?.payload).toMatchObject({ actions: [{ kind }] });
        asked.length = 0;
        yield* call(asked, "collie_do", {
          actions: [{ kind, machine: "vm-mk" }],
        });
        expect(asked.at(-1)).toMatchObject({
          machine: "vm-mk",
          op: "act",
          payload: { actions: [{ kind }] },
        });
        asked.length = 0;
        const unnamed = 'Name the Machine this is for in its "machine" field. Nothing was done.';
        expect(yield* proposing({ kind })).toBe(unnamed);
        expect(yield* call(asked, "collie_do", { actions: [{ kind }] })).toBe(
          `${kind}: failed — ${unnamed}`,
        );
        expect(yield* proposing({ kind, machine: "unknown" })).toContain('No Machine "unknown"');
        expect(asked).toEqual([]);
      }
    }),
  ));

test("which models a Machine can run is asked of that Machine alone", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const every = yield* call(asked, "collie_models", {});
      const [, pc, vm] = every.split(/^## /m);
      expect(pc).toStartWith("mk-pc");
      expect(pc).toContain("claude    opus (Opus 5.5)");
      expect(pc).not.toContain("qwen3-coder");
      expect(vm).toStartWith("vm-mk");
      expect(vm).toContain("pi        ollama/qwen3-coder:30b");

      asked.length = 0;
      const one = yield* call(asked, "collie_models", { machine: "vm-mk", harness: "pi" });
      expect(one).toContain("ollama/qwen3-coder:30b");
      expect(one).not.toContain("opus");
      expect(asked.filter(({ op }) => op === "models").map(({ machine }) => machine)).toEqual([
        "vm-mk",
      ]);
      expect(yield* call([], "collie_models", { machine: "mk-pc", harness: "pi" })).toContain(
        "pi is not installed",
      );
    }),
  ));

test("a Machine whose Schedules cannot be read is named, with no empty list claimed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const live = machine("vm-mk", [], asked);
      const flock = {
        ...flockOf(asked),
        machines: () => [
          machine("mk-pc", [], asked),
          {
            ...live,
            door: { ...live.door, schedules: () => Effect.die("host has no schedules RPC") },
          },
          unread("away", { _tag: "Lost", state: "unreachable", reason: "asleep" }),
        ],
      };
      const said = yield* callFlockTool(flock, "collie_schedules", {}).pipe(
        Effect.provide(BunServices.layer),
      );
      expect(said).toContain("mk-pc:nightly");
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(said).toContain("## away");
      expect(said).not.toContain("- (none)");
    }),
  ));

test("input a tool does not take is refused in the tool's own terms", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const said = yield* call([], "collie_do", {
        actions: [{ kind: "stop", run: "r-2", goal: "x" }],
      });
      expect(said).toContain("refused the request (InvalidInput)");
      expect(said).toContain("does not take goal");
    }),
  ));

test("News is read from every Herd on every Machine, and only what was handed over is settled", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_news", {});
      expect(said).toContain("[consequential] mk-pc:r-1");
      expect(said).toContain("[consequential] vm-mk:r-1");
      const reads = asked.filter(({ op }) => op === "news");
      expect(reads.map(({ machine, payload }) => [machine, payload])).toEqual([
        ["mk-pc", expect.objectContaining({ herd: "h1", as: "sent", keys: [] })],
        ["vm-mk", expect.objectContaining({ herd: "h1", as: "sent", keys: [] })],
        ["mk-pc", expect.objectContaining({ herd: "h1", as: "read", keys: ["k1"] })],
        ["vm-mk", expect.objectContaining({ herd: "h1", as: "read", keys: ["k1"] })],
      ]);
    }),
  ));

test("a Machine nobody has is said to be no Machine, and nothing is done", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_hold", { run: "vm-typo:r-2" });
      expect(said).toContain('No Machine "vm-typo"');
      expect(said).toContain("mk-pc, vm-mk");
      expect(asked).toEqual([]);
    }),
  ));

test("a Machine whose host is older than the Flock chat is written to by nothing, and says why", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = {
        machines: () => [machine("old-pc", [task({ id: "t-a", run: "r-1" })], asked, 1)],
        conversation: "flock@mk-pc",
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        chatHarness: () => ({
          harness: "claude",
          model: undefined,
          effort: undefined,
        }),
        chatChoices: Effect.die("not asked"),
        setChatHarness: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        attachments: () => undefined,
        uploaded: new Map(),
        said: () => "hold it",
      };
      const hold = yield* callFlockTool(flock, "collie_hold", {
        run: "old-pc:r-1",
      });
      const news = yield* callFlockTool(flock, "collie_news", {});
      expect(asked).toEqual([]);
      expect(hold).toContain("upgrade Collie on old-pc");
      expect(news).toContain("upgrade Collie on old-pc");
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a Machine that stops answering costs a look for News its time, and the others still speak", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const wedged = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...wedged, door: { ...wedged.door, news: () => Effect.never } },
        ],
        conversation: "flock@mk-pc",
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        chatHarness: () => ({
          harness: "claude",
          model: undefined,
          effort: undefined,
        }),
        chatChoices: Effect.die("not asked"),
        setChatHarness: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        attachments: () => undefined,
        uploaded: new Map(),
        said: () => undefined,
      };
      const looking = yield* callFlockTool(flock, "collie_news", {}).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const said = yield* Fiber.join(looking);
      expect(said).toContain("[consequential] mk-pc:r-1");
      expect(said).toContain("vm-mk's News could not be read");
    }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
  ));

const withUnread = (asked: Asked[], board: ChatBoard) => ({
  machines: () => [
    machine("mk-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked),
    unread("vm-mk", board),
  ],
  conversation: "flock@mk-pc",
  machineRule: () => undefined,
  setMachineRule: () => Effect.void,
  chatHarness: () => ({ harness: "claude", model: undefined, effort: undefined }),
  chatChoices: Effect.die("not asked"),
  setChatHarness: () => Effect.succeed(null),
  inSync: () => Effect.succeed(""),
  attachments: () => undefined,
  uploaded: new Map(),
  said: () => "hold it",
});

const UNREAD: ReadonlyArray<readonly [ChatBoard, string]> = [
  [
    { _tag: "Connecting", since: 0 },
    "vm-mk is still connecting; Desktop has waited 1 min 30 s for its first board",
  ],
  [
    {
      _tag: "Lost",
      state: "unreachable",
      reason: "ssh: connect to host vm-mk: Connection refused",
    },
    "vm-mk is out of reach: ssh: connect to host vm-mk: Connection refused",
  ],
  [
    { _tag: "Saved", at: epochMs("2026-10-07T12:00:00Z") },
    "vm-mk is only a board Desktop saved at 2026-10-07T12:00:00.000Z, with no live host since",
  ],
];

for (const [board, why] of UNREAD)
  test(`a Machine with no live board (${board._tag}) is said with why in herd and News, and a write to it is refused with it`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.adjust("90 seconds");
        const asked: Asked[] = [];
        const flock = withUnread(asked, board);
        const herd = yield* callFlockTool(flock, "collie_herd", {});
        expect(herd).toContain("run mk-pc:r-1:");
        expect(herd).toContain(`- (${why})`);
        const news = yield* callFlockTool(flock, "collie_news", {});
        expect(news).toContain(`- (vm-mk's News could not be read: ${why})`);
        const named = yield* callFlockTool(flock, "collie_hold", { run: "vm-mk:r-1" });
        expect(named).toBe(`hold: failed — ${why}. Nothing was done on vm-mk.`);
        const bare = yield* callFlockTool(flock, "collie_hold", { run: "r-1" });
        expect(bare).toContain(why);
        expect(bare).toContain("name it as mk-pc:r-1");
        const workspaces = yield* callFlockTool(flock, "collie_workspaces", {});
        expect(workspaces).toContain(`## vm-mk\n\n${why}`);
        expect(
          asked.filter(({ op }) => op !== "news" && op !== "declare" && op !== "read"),
        ).toEqual([]);
        expect(asked.filter(({ machine }) => machine === "vm-mk")).toEqual([]);
      }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
    ));

test("a live Machine whose chat channel is not open yet is still a Machine, and says so", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const { door: _, ...doorless } = machine("vm-mk", [], asked);
      const said = yield* callFlockTool(
        { ...withUnread(asked, doorless.board), machines: () => [doorless] },
        "collie_hold",
        { run: "vm-mk:r-1" },
      );
      expect(said).toBe(
        "hold: failed — vm-mk's chat channel is not open yet. Nothing was done on vm-mk.",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a live Machine's board is read before its chat channel opens", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const { door: _, ...doorless } = machine(
        "vm-mk",
        [task({ id: "t-b", run: "r-2", runs: ["r-2"], name: "Fix board bugs" })],
        asked,
      );
      const herd = yield* callFlockTool(
        { ...withUnread(asked, doorless.board), machines: () => [doorless] },
        "collie_herd",
        {},
      );
      expect(herd).toContain("run vm-mk:r-2: Fix board bugs");
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a Repo run is reached on its Machine by its bare id", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const fan = task({
        id: "t-fan",
        run: "r-fan",
        runs: ["r-fan"],
        state: "blocked",
        children: [{ repo: "api", run: "r-api", state: "blocked", mr: null }],
      });
      const flock = {
        ...flockOf(asked),
        machines: () => [machine("mk-pc", [], asked), machine("vm-mk", [fan], asked)],
      };
      const bare = yield* callFlockTool(flock, "collie_hold", { run: "r-api" });
      expect(bare).toBe("Held r-api");
      expect(asked.at(-1)).toMatchObject({ machine: "vm-mk", op: "control" });
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a live Machine is read from the board Desktop follows, with no board of its host's", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const herd = yield* call(asked, "collie_herd", {});
      expect(herd).toContain("run vm-mk:r-2: Fix board bugs");
      const workspaces = yield* call(asked, "collie_workspaces", {});
      expect(workspaces).toContain("collie_workspaces answered by vm-mk");
      const news = yield* call(asked, "collie_news", {});
      expect(news).toContain("[consequential] vm-mk:r-1");
    }),
  ));

/** What a file tool said in words, its images left out. */
const textOf = (content: ReadonlyArray<ToolContent>) =>
  content.map((one) => (one.type === "text" ? one.text : "")).join("\n");

const callFile = (asked: Asked[], name: string, input: JsonObject, files = true) =>
  callFileTool(
    {
      ...flockOf(asked),
      machines: () => [machine("vm-mk", [], asked, PROTOCOL, files)],
    },
    name,
    input,
  ).pipe(Effect.provide(BunServices.layer));

test("collie_read reaches the named Machine's host with the bare path, and answers numbered lines", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const read = yield* callFile(asked, "collie_read", {
        file_path: "vm-mk:/var/log/app.log",
        offset: 2,
        limit: 2,
      });
      expect(read).toEqual([{ type: "text", text: "     2\ttwo\n     3\tthree" }]);
      expect(asked.find(({ op }) => op === "readFile")?.payload).toMatchObject({
        path: "/var/log/app.log",
      });
    }),
  ));

test("collie_read of an image is the image, and of another binary its name, size and type", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* callFile([], "collie_read", { file_path: "vm-mk:/tmp/shot.png" })).toEqual([
        {
          type: "image",
          data: Buffer.from(png(640, 480), "latin1").toString("base64"),
          mimeType: "image/png",
        },
      ]);
      const wide = yield* callFile([], "collie_read", { file_path: "vm-mk:/tmp/wide.png" });
      expect(textOf(wide)).toContain("2560×1600: not shown");
      const zip = yield* callFile([], "collie_read", { file_path: "vm-mk:/tmp/trace.zip" });
      expect(zip[0]).toMatchObject({ type: "text" });
      expect(textOf(zip)).toContain("vm-mk:/tmp/trace.zip is application/zip, 4 bytes");
    }),
  ));

test("collie_read takes 8 MB of a text file with no newlines, and shows 2000 characters of its line", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const read = yield* callFile(asked, "collie_read", { file_path: "vm-mk:/tmp/bundle.js" });
      expect(textOf(read).length).toBeLessThan(2100);
      // One part to say what it is, then 8 MB of its 20.
      expect(asked.filter(({ op }) => op === "readFile")).toHaveLength(3);
    }),
  ));

test("a file tool on a Machine without them is told to upgrade, and a bare path to name one", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const old = yield* callFile(
        asked,
        "collie_glob",
        { pattern: "*.ts", path: "vm-mk:/src" },
        false,
      );
      expect(textOf(old)).toContain("upgrade Collie on vm-mk");
      const bare = yield* callFile(asked, "collie_read", { file_path: "/var/log/app.log" });
      expect(textOf(bare)).toContain("<machine>:<path>");
      expect(asked.filter(({ op }) => op !== "declare")).toEqual([]);
    }),
  ));

test("collie_write and collie_edit go to the Machine's host in the human's words, under a request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      yield* callFile(asked, "collie_edit", {
        file_path: "vm-mk:/etc/app.ini",
        old_string: "a=1",
        new_string: "a=2",
        replace_all: true,
      });
      expect(asked.map(({ op }) => op)).toEqual(["declare", "editFile"]);
      expect(asked[0]!.payload).toMatchObject({ said: "stop the board bugs one" });
      expect(asked[1]!.payload).toMatchObject({
        path: "/etc/app.ini",
        oldString: "a=1",
        newString: "a=2",
        replaceAll: true,
      });
      const grep = yield* callFile(asked, "collie_grep", {
        pattern: "TODO",
        path: "vm-mk:/src",
        "-i": true,
        output_mode: "content",
      });
      expect(grep).toEqual([{ type: "text", text: "vm-mk:/src/a.ts" }]);
      expect(asked.at(-1)?.payload).toMatchObject({
        pattern: "TODO",
        path: "/src",
        ignoreCase: true,
        outputMode: "content",
      });
    }),
  ));

const reads = (asked: Asked[]) =>
  asked.filter(({ op }) => op === "read").map(({ machine, payload }) => ({ machine, payload }));

test("a Run named on a Machine is read by that Machine's host, under its own id, and headed with its name", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_run", { run: "vm-mk:r-2" });
      expect(reads(asked)).toEqual([
        { machine: "vm-mk", payload: { tool: "collie_run", input: { run: "r-2" } } },
      ]);
      expect(said).toBe("## vm-mk\n\ncollie_run answered by vm-mk");
    }),
  ));

test("a bare id only one Machine has is read there", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_receipts", { run: "r-2" });
      expect(reads(asked)).toEqual([
        { machine: "vm-mk", payload: { tool: "collie_receipts", input: { run: "r-2" } } },
      ]);
      expect(said).toStartWith("## vm-mk");
      // Ambiguous still refuses, asking nothing.
      const both: Asked[] = [];
      expect(yield* call(both, "collie_run", { run: "r-1" })).toContain(
        "is on more than one Machine",
      );
      expect(reads(both)).toEqual([]);
    }),
  ));

test("where work can start is every Machine's own answer, a section each, and a naming rule with no example path", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_workspaces", {});
      expect(
        reads(asked)
          .map(({ machine }) => machine)
          .sort(),
      ).toEqual(["mk-pc", "vm-mk"]);
      expect(said).toContain("## mk-pc\n\ncollie_workspaces answered by mk-pc");
      expect(said).toContain("## vm-mk\n\ncollie_workspaces answered by vm-mk");
      expect(said).toContain("as <machine>: followed by a workspace id");
      expect(said).not.toContain("/home/");
    }),
  ));

test("a Machine whose host cannot answer a read is told to upgrade, one that is slow that it timed out, and the rest still answer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const old = machine("vm-mk", [], asked);
      const slow = machine("vm-slow", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...old, door: { ...old.door, read: () => Effect.die("no read") } },
          { ...slow, door: { ...slow.door, read: () => Effect.never } },
        ],
        conversation: "flock@mk-pc",
        said: () => undefined,
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        chatHarness: () => ({
          harness: "claude",
          model: undefined,
          effort: undefined,
        }),
        chatChoices: Effect.die("not asked"),
        setChatHarness: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        attachments: () => undefined,
        uploaded: new Map(),
      };
      const reading = yield* callFlockTool(flock, "collie_workspaces", {}).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const said = yield* Fiber.join(reading);
      expect(said).toContain(
        "## vm-mk\n\nvm-mk did not answer; its Collie may be older than Desktop's; upgrade Collie on vm-mk.",
      );
      expect(said).toContain("## vm-slow\n\nvm-slow did not answer within 10 s.");
      expect(said).not.toContain("upgrade Collie on vm-slow");
      expect(said).toContain("collie_workspaces answered by mk-pc");
    }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
  ));

test("the chat reads whether each Machine is in sync, and syncs the one it names", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* call([], "collie_in_sync", {})).toBe("every Machine is in sync");
      expect(yield* call([], "collie_in_sync", { sync: "vm-mk" })).toBe("synced vm-mk");
    }),
  ));

test("the Machine rule is read back as saved, and replaced with what the human asked for", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      saved = undefined;
      expect(yield* call([], "collie_machine_rule", {})).toBe(
        "There is no Machine rule: the human has not said which Machine work goes to.",
      );
      expect(
        yield* call([], "collie_machine_rule", { rule: " Frontend work is on the laptop\n" }),
      ).toBe('The Machine rule is now: "Frontend work is on the laptop"');
      expect(savedRule()).toBe("Frontend work is on the laptop");
      expect(yield* call([], "collie_machine_rule", {})).toBe(
        'The Machine rule is: "Frontend work is on the laptop"',
      );
      expect(yield* call([], "collie_machine_rule", { rule: "" })).toBe(
        "The Machine rule is cleared.",
      );
      expect(savedRule()).toBe("");
    }),
  ));

const HELD =
  "The conversation is held on claude. Its session runs on claude/opus at medium effort now.";

test("the chat's model listing explains reads in progress and the table fallback reason", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = (offered: ChatChoices["harnesses"][number]["offered"]) =>
        callFlockTool(
          {
            ...flockOf([]),
            chatChoices: Effect.succeed({
              heldOn: "claude",
              runsOn: null,
              turning: false,
              harnesses: [{ harness: "claude", label: "Claude Code", installed: true, offered }],
            }),
          },
          "collie_chat_harness",
          {},
        ).pipe(Effect.provide(BunServices.layer));
      expect(yield* read({ from: "reading" })).toContain("claude's models are still being read.");
      const failed = yield* read({
        from: "table",
        why: "Claude Code exited before answering",
        unset: { harness: "claude", model: "opus", effort: "medium" },
        models: [
          { id: "opus", label: "opus", efforts: ["low", "medium", "high"], unsetEffort: "medium" },
        ],
      });
      expect(failed).toContain(
        "Claude Code's list could not be read: Claude Code exited before answering. Showing Collie's table.",
      );
      expect(failed).toContain("claude offers opus (low, medium, high).");
    }),
  ));

test("the chat reads what it runs on, and changes its model with Settings' checks, from the next message", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      chat = { proactive: true };
      const read = yield* call([], "collie_chat_harness", {});
      expect(read.split("\n").slice(0, 2)).toEqual([
        "The Flock chat is set to claude, with no model set, so it runs as opus, with no effort set, so it runs at medium.",
        HELD,
      ]);
      expect(read).toContain(
        "claude offers fable (low, medium, high, xhigh, max), opus (low, medium, high, xhigh, max),",
      );
      expect(yield* call([], "collie_chat_harness", { model: "sonnet" })).toBe(
        "The Flock chat is now set to claude, model sonnet, with no effort set, so it runs at medium. It applies with the next message.",
      );
      expect(chat.chatModel).toBe("sonnet");
      const refused = yield* call([], "collie_chat_harness", { model: "gpt-6.1-sol" });
      expect(refused).toContain('"gpt-6.1-sol" is not a model claude takes');
      expect(refused).toContain("Nothing was changed.");
      expect(yield* call([], "collie_chat_harness", { harness: "opencode" })).toContain(
        "Nothing was changed.",
      );
      expect(chat).toEqual({ proactive: true, chatModel: "sonnet" });
      expect(yield* call([], "collie_chat_harness", { model: "" })).toBe(
        "The Flock chat is now set to claude, with no model set, so it runs as opus, with no effort set, so it runs at medium. It applies with the next message.",
      );
      expect(chat).toEqual({ proactive: true });
    }),
  ));

test("the chat sets, refuses, unsets and reads back its effort", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      chat = { proactive: true, chatModel: "sonnet" };
      const firstLine = (said: string) => said.split("\n")[0];
      expect(firstLine(yield* call([], "collie_chat_harness", {}))).toBe(
        "The Flock chat is set to claude, model sonnet, with no effort set, so it runs at medium.",
      );
      expect(yield* call([], "collie_chat_harness", { effort: "high" })).toBe(
        "The Flock chat is now set to claude, model sonnet, at high effort. It applies with the next message.",
      );
      expect(chat).toEqual({ proactive: true, chatModel: "sonnet", chatEffort: "high" });
      expect(firstLine(yield* call([], "collie_chat_harness", {}))).toBe(
        "The Flock chat is set to claude, model sonnet, at high effort.",
      );
      expect(yield* call([], "collie_chat_harness", { effort: "off" })).toBe(
        '"off" is not an effort claude takes (low, medium, high, xhigh, max). Nothing was changed.',
      );
      expect(chat).toEqual({ proactive: true, chatModel: "sonnet", chatEffort: "high" });
      expect(yield* call([], "collie_chat_harness", { effort: "" })).toBe(
        "The Flock chat is now set to claude, model sonnet, with no effort set, so it runs at medium. It applies with the next message.",
      );
      expect(chat).toEqual({ proactive: true, chatModel: "sonnet" });
    }),
  ));

test("the chat's read names where the conversation is held, that no session is warm, and each installed harness's models with their efforts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      chat = { proactive: true, chatHarness: "pi" };
      const account: ChatChoices = {
        heldOn: "claude",
        runsOn: null,
        turning: false,
        harnesses: [
          {
            harness: "claude",
            label: "Claude Code",
            installed: true,
            offered: {
              from: "table",
              unset: { harness: "claude", model: "opus", effort: "medium" },
              models: [
                {
                  id: "opus",
                  label: "Opus 5.5",
                  efforts: ["low", "medium", "high"],
                  unsetEffort: "medium",
                },
                {
                  id: "claude-haiku-4-5-20251001",
                  label: "Haiku 4.5",
                  efforts: [],
                  unsetEffort: null,
                },
              ],
            },
          },
          {
            harness: "pi",
            label: "Pi",
            installed: true,
            offered: {
              from: "table",
              unset: { harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "high" },
              models: [
                {
                  id: "openai-codex/gpt-5.5",
                  label: "openai-codex/gpt-5.5",
                  efforts: ["low", "high"],
                  unsetEffort: "low",
                },
              ],
            },
          },
          {
            harness: "codex",
            label: "Codex",
            installed: false,
            offered: {
              from: "table",
              unset: { harness: "codex", model: "default", effort: null },
              models: [{ id: "gpt-5-codex", label: "gpt-5-codex", efforts: [], unsetEffort: null }],
            },
          },
        ],
      };
      expect(
        yield* callFlockTool(
          { ...flockOf([]), chatChoices: Effect.succeed(account) },
          "collie_chat_harness",
          {},
        ).pipe(Effect.provide(BunServices.layer)),
      ).toBe(
        [
          "The Flock chat is set to pi, with no model set, so it runs as openai-codex/gpt-6.1-sol, with no effort set, so it runs at high.",
          "The conversation is held on claude; the next message starts a new one on pi. No session is warm.",
          "Claude Code's models are from Collie's table.",
          "claude offers opus (low, medium, high), claude-haiku-4-5-20251001 (no effort).",
          "Pi's models are from Collie's table.",
          "pi offers openai-codex/gpt-5.5 (low, high).",
        ].join("\n"),
      );
    }),
  ));

test("a start that names no Machine while several are reachable is still refused, rule or no rule", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      saved = "Everything is on the vm";
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_do", {
        actions: [{ kind: "start", workflow: "plan", inputs: {} }],
      });
      expect(said).toBe("start: failed — name the Machine it is for, as <machine>:<workspace>");
      expect(asked).toEqual([]);
      saved = undefined;
    }),
  ));

/** A Flock whose human message this turn carried `shot.png`, a file on this computer. */
const carrying = (asked: Asked[], dir: string, files: { readonly vm?: boolean } = {}) => ({
  ...flockOf(asked),
  machines: () => [
    machine("mk-pc", [], asked),
    machine(
      "vm-mk",
      [task({ id: "t-b", run: "r-2", runs: ["r-2"] })],
      asked,
      PROTOCOL,
      files.vm ?? true,
    ),
  ],
  attachments: () => [
    {
      id: `${"c".repeat(64)}/shot.png`,
      name: "shot.png",
      size: 4,
      mediaType: "image/png",
      path: `${dir}/shot.png`,
    },
  ],
  uploaded: new Map(),
});

const withShot = <A>(body: (dir: string) => Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "flock-carry-" });
      yield* fs.writeFileString(`${dir}/shot.png`, "PNG!");
      return yield* body(dir);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

const start = (extra: JsonObject = {}) => ({
  actions: [
    { kind: "start", workflow: "plan", workspace: "vm-mk:/src/collie", inputs: {}, ...extra },
  ],
});

const shotSha = new Bun.CryptoHasher("sha256").update("PNG!").digest("hex");

test("a start carries the turn's files, uploaded to its Machine once and handed over as paths there", () =>
  withShot((dir) =>
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = carrying(asked, dir);
      const said = yield* callFlockTool(flock, "collie_do", start()).pipe(
        Effect.provide(BunServices.layer),
      );
      expect(said).toBe("start: applied");
      const uploads = asked.filter(({ op }) => op === "upload");
      expect(uploads).toEqual([
        {
          machine: "vm-mk",
          op: "upload",
          payload: { name: "shot.png", size: 4, sha256: shotSha, offset: 0, content: "UE5HIQ==" },
        },
      ]);
      expect(asked.find(({ op }) => op === "act")?.payload).toMatchObject({
        actions: [{ attachments: [`/state/uploads/${shotSha}/shot.png`] }],
      });
      expect(asked.find(({ op }) => op === "declare")?.payload).toMatchObject({
        said: "stop the board bugs one",
        attachments: ["shot.png"],
      });

      yield* callFlockTool(flock, "collie_do", start()).pipe(Effect.provide(BunServices.layer));
      expect(asked.filter(({ op }) => op === "upload")).toHaveLength(1);

      // A day on, the host may have pruned it, so it is uploaded again.
      const held = flock.uploaded.get("vm-mk")!.get(shotSha)!;
      flock.uploaded.get("vm-mk")!.set(shotSha, { ...held, at: held.at - 2 * 24 * 60 * 60 * 1000 });
      yield* callFlockTool(flock, "collie_do", start()).pipe(Effect.provide(BunServices.layer));
      expect(asked.filter(({ op }) => op === "upload")).toHaveLength(2);
    }),
  ));

test("an offer taken on a Run named with its Machine goes to that Machine's host with the bare id and the turn's files", () =>
  withShot((dir) =>
    Effect.gen(function* () {
      const asked: Asked[] = [];
      yield* callFlockTool(carrying(asked, dir), "collie_do", {
        actions: [{ kind: "take_offer", run: "vm-mk:r-2", offer: "release" }],
      }).pipe(Effect.provide(BunServices.layer));
      expect(asked.find(({ op }) => op === "act")).toEqual({
        machine: "vm-mk",
        op: "act",
        payload: {
          actions: [
            {
              kind: "take_offer",
              run: "r-2",
              offer: "release",
              attachments: [`/state/uploads/${shotSha}/shot.png`],
            },
          ],
          request: expect.any(String),
        },
      });
    }),
  ));

test("a file over 100 MB, here or on another Machine, is refused before it is read whole", () =>
  withShot((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dir}/huge.bin`, "");
      yield* fs.truncate(`${dir}/huge.bin`, ATTACHMENT_BYTES + 1);
      const asked: Asked[] = [];
      const flock = carrying(asked, dir);
      const here = yield* callFlockTool(
        flock,
        "collie_do",
        start({ attachments: [`${dir}/huge.bin`] }),
      ).pipe(Effect.provide(BunServices.layer));
      expect(here).toContain(`${dir}/huge.bin is larger than 100 MB`);

      const [pc, vm] = flock.machines();
      const big = {
        ...pc!,
        door: {
          ...pc!.door,
          readFile: () =>
            Effect.succeed({
              path: "/big.log",
              size: ATTACHMENT_BYTES + 1,
              mediaType: "text/plain",
              content: "",
            }),
        },
      };
      const there = yield* callFlockTool(
        { ...flock, machines: () => [big, vm!] },
        "collie_do",
        start({ attachments: ["mk-pc:/big.log"] }),
      ).pipe(Effect.provide(BunServices.layer));
      expect(there).toContain("mk-pc:/big.log is larger than 100 MB");
      expect(asked.filter(({ op }) => op === "upload" || op === "act")).toEqual([]);
    }),
  ));

test("[] carries no files, and a file already on the start's Machine goes as its own path", () =>
  withShot((dir) =>
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = carrying(asked, dir);
      yield* callFlockTool(flock, "collie_do", start({ attachments: [] })).pipe(
        Effect.provide(BunServices.layer),
      );
      yield* callFlockTool(
        flock,
        "collie_do",
        start({ attachments: ["vm-mk:/var/log/app.log"] }),
      ).pipe(Effect.provide(BunServices.layer));
      expect(asked.filter(({ op }) => op === "upload")).toEqual([]);
      expect(asked.filter(({ op }) => op === "act").map(({ payload }) => payload)).toMatchObject([
        { actions: [{ attachments: [] }] },
        { actions: [{ attachments: ["/var/log/app.log"] }] },
      ]);
    }),
  ));

test("a turn of Desktop's own carries no files", () =>
  withShot((dir) =>
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = {
        ...carrying(asked, dir),
        said: () => undefined,
        attachments: () => undefined,
      };
      yield* callFlockTool(flock, "collie_do", start()).pipe(Effect.provide(BunServices.layer));
      expect(asked.filter(({ op }) => op === "upload")).toEqual([]);
      expect(asked.find(({ op }) => op === "act")?.payload).not.toMatchObject({
        actions: [{ attachments: expect.anything() }],
      });
    }),
  ));

test("a start carrying files to a Machine whose Collie predates them is refused, and nothing starts", () =>
  withShot((dir) =>
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* callFlockTool(
        carrying(asked, dir, { vm: false }),
        "collie_do",
        start(),
      ).pipe(Effect.provide(BunServices.layer));
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(asked.filter(({ op }) => op === "act" || op === "upload")).toEqual([]);
    }),
  ));

test("a Machine whose Collie has no such operation is told to upgrade, and the rest still answer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const old = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...old, door: { ...old.door, read: () => Effect.die("Unknown request tag: read") } },
        ],
        conversation: "flock@mk-pc",
        said: () => undefined,
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        chatHarness: () => ({
          harness: "claude",
          model: undefined,
          effort: undefined,
        }),
        chatChoices: Effect.die("not asked"),
        setChatHarness: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        attachments: () => undefined,
        uploaded: new Map(),
      };
      const said = yield* callFlockTool(flock, "collie_workspaces", {});
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(said).toContain("collie_workspaces answered by mk-pc");
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("the Flock chat moves a Schedule between two Machines through the shared sequence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_move_schedule", {
        schedule: "vm-mk:daily",
        to: "mk-pc",
        checkout: "/home/mk/collie",
      });
      expect(said).toContain('Moved "daily" from vm-mk to mk-pc');
      const changes = asked
        .filter(({ op }) => op === "changeSchedule")
        .map(({ machine, payload }) => [machine, payload]);
      expect(changes).toMatchObject([
        [
          "mk-pc",
          {
            change: { change: "add", paused: true, start: { workspace: "/home/mk/collie" } },
          },
        ],
        ["vm-mk", { change: { change: "remove", name: "daily" } }],
        ["mk-pc", { change: { change: "resume", name: "daily" } }],
      ]);
      // Each Machine records the human's words with what it was asked.
      for (const on of ["mk-pc", "vm-mk"])
        expect(asked.some(({ machine, op }) => machine === on && op === "declare")).toBe(true);
    }),
  ));

test("a Flock chat move to a Machine it cannot reach is refused, and nothing is changed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* callFlockTool(
        {
          ...flockOf(asked),
          machines: () => [
            machine("vm-mk", [], asked),
            unread("mk-pc", { _tag: "Lost", state: "unreachable", reason: "ssh timed out" }),
          ],
        },
        "collie_move_schedule",
        { schedule: "vm-mk:daily", to: "mk-pc" },
      ).pipe(Effect.provide(BunServices.layer));
      expect(said).toContain("machine_unreachable");
      expect(asked.filter(({ op }) => op === "changeSchedule")).toEqual([]);
    }),
  ));

test("a deliver to a Machine whose board speaks an older protocol is refused before anything is sent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = {
        ...flockOf(asked),
        machines: () => [
          machine("old-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked, PROTOCOL - 1),
          machine("vm-mk", [task({ id: "t-b", run: "r-2", runs: ["r-2"] })], asked),
        ],
      };
      const deliver = (run: string) => ({
        actions: [{ kind: "deliver", run, text: "look again" }],
      });
      expect(yield* callFlockTool(flock, "collie_do", deliver("r-1"))).toBe(
        "deliver: failed — its Collie is older than Desktop's chat; upgrade Collie on old-pc. Nothing was done there.",
      );
      expect(asked).toEqual([]);
      expect(yield* callFlockTool(flock, "collie_do", deliver("r-2"))).toBe("deliver: applied");
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "vm-mk declare",
        "vm-mk act",
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  ));

/** A Machine whose host has `runs` though its board lists none of them, or whose `progress` is `answer`. */
const holding = (
  name: string,
  asked: Asked[],
  runs: ReadonlyArray<string>,
  answer?: ChatDoor["progress"],
): Reached => {
  const reached = machine(name, [], asked);
  const progress: ChatDoor["progress"] =
    answer ??
    (({ runId }) =>
      Effect.succeed(
        runs.includes(runId) ? { ready: { ready: false, missing: [] }, ci: null, steps: [] } : null,
      ));
  return { ...reached, door: { ...reached.door, progress } };
};

const flockOn = (asked: Asked[], machines: ReadonlyArray<ChatMachine>) => ({
  ...flockOf(asked),
  machines: () => machines,
});

test("a bare id no board lists yet is read on the one Machine whose host has it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = flockOn(asked, [
        holding("mk-pc", asked, []),
        holding("vm-mk", asked, ["r-new"]),
      ]);
      expect(yield* callFlockTool(flock, "collie_run", { run: "r-new" })).toBe(
        "## vm-mk\n\ncollie_run answered by vm-mk",
      );
      expect(reads(asked)).toEqual([
        { machine: "vm-mk", payload: { tool: "collie_run", input: { run: "r-new" } } },
      ]);
      const nowhere: Asked[] = [];
      const none = flockOn(nowhere, [holding("mk-pc", nowhere, []), holding("vm-mk", nowhere, [])]);
      expect(yield* callFlockTool(none, "collie_run", { run: "r-new" })).toBe(
        'No Run "r-new" on any Machine. Nothing was done; collie_herd lists them as <machine>:<id>.',
      );
      expect(nowhere).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  ));

for (const [why, answer, said] of [
  ["fails", () => Effect.die("no progress"), "upgrade Collie on mk-pc"],
  ["does not answer", () => Effect.never, "mk-pc did not answer within 10 s"],
] as const)
  test(`a Machine whose host ${why} when asked about a bare id is unread, and nothing is done`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const asked: Asked[] = [];
        const flock = flockOn(asked, [
          holding("mk-pc", asked, [], answer),
          holding("vm-mk", asked, ["r-new"]),
        ]);
        const reading = yield* callFlockTool(flock, "collie_run", { run: "r-new" }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 minute");
        const refused = yield* Fiber.join(reading);
        expect(refused).toStartWith(
          'Run "r-new" is on vm-mk, and mk-pc could not be checked for one too (',
        );
        expect(refused).toContain(said);
        expect(refused).toContain("name it as vm-mk:r-new");
        expect(asked).toEqual([]);
      }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
    ));

test("a hold and a run-scoped action on a bare id no board lists go to the Machine whose host has it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = flockOn(asked, [
        holding("mk-pc", asked, []),
        holding("vm-mk", asked, ["r-new"]),
      ]);
      expect(yield* callFlockTool(flock, "collie_hold", { run: "r-new" })).toBe("Held r-new");
      expect(
        yield* callFlockTool(flock, "collie_do", { actions: [{ kind: "stop", run: "r-new" }] }),
      ).toBe("stop: applied");
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "vm-mk declare",
        "vm-mk control",
        "vm-mk declare",
        "vm-mk act",
      ]);
      expect(asked[3]!.payload).toMatchObject({ actions: [{ kind: "stop", run: "r-new" }] });
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("an answer its Machine never confirms is said as not confirmed, and nothing after it is sent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const silent = machine("vm-mk", [task({ id: "t-b", run: "r-2", runs: ["r-2"] })], asked);
      const flock = flockOn(asked, [
        {
          ...silent,
          door: {
            ...silent.door,
            act: (payload) =>
              Effect.sync(() => asked.push({ machine: "vm-mk", op: "act", payload })).pipe(
                Effect.andThen(Effect.never),
              ),
          },
        },
      ]);
      const said = yield* fastForward(
        callFlockTool(flock, "collie_do", {
          actions: [
            { kind: "answer", run: "r-2", choiceId: "next-1", answer: "yes" },
            { kind: "stop", run: "r-2" },
          ],
        }),
        1_000,
      );
      expect(said).toBe(
        "answer: not confirmed — vm-mk did not confirm the answer to r-2 within 30 s, 3 times. It may still land; Try again sends the same request, which vm-mk takes at most once.",
      );
      const acts = asked.filter(({ op }) => op === "act");
      expect(acts).toHaveLength(3);
      expect(new Set(acts.map(({ payload }) => JSON.stringify(payload))).size).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  ));

const keeping = () => {
  const lines: Attempted[] = [];
  return { lines, log: (line: Attempted) => Effect.sync(() => void lines.push(line)) };
};

test("a host that never takes the chat's declaration ends the write as not confirmed, logged each try", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const { lines, log } = keeping();
      const mute = machine("vm-mk", [task({ id: "t-b", run: "r-2", runs: ["r-2"] })], asked);
      const flock = {
        ...flockOn(asked, [{ ...mute, door: { ...mute.door, declare: () => Effect.never } }]),
        actionsLog: log,
      };
      const stop = yield* fastForward(
        callFlockTool(flock, "collie_do", { actions: [{ kind: "stop", run: "r-2" }] }),
        1_000,
      );
      expect(stop).toStartWith("stop: not confirmed — vm-mk did not confirm the stop to r-2");
      const held = yield* fastForward(callFlockTool(flock, "collie_hold", { run: "r-2" }), 1_000);
      expect(held).toStartWith("hold: not confirmed — vm-mk did not confirm the hold to r-2");
      expect(lines.map(({ kind, ended }) => `${kind} ${ended}`)).toEqual([
        "stop timed-out",
        "stop timed-out",
        "stop timed-out",
        "hold timed-out",
        "hold timed-out",
        "hold timed-out",
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a chat write refused before it is sent is logged as not sent, with Desktop's reason", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const { lines, log } = keeping();
      const flock = {
        ...flockOn(asked, [
          machine("old-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked, PROTOCOL - 1),
        ]),
        actionsLog: log,
      };
      yield* callFlockTool(flock, "collie_do", { actions: [{ kind: "stop", run: "r-1" }] });
      yield* callFlockTool(flock, "collie_hold", { run: "r-1" });
      expect(asked).toEqual([]);
      expect(lines).toMatchObject([
        {
          door: "chat",
          machine: "old-pc",
          kind: "stop",
          about: "r-1",
          attempt: 0,
          ended: "not-sent",
        },
        {
          door: "chat",
          machine: "old-pc",
          kind: "hold",
          about: "r-1",
          attempt: 0,
          ended: "not-sent",
        },
      ]);
      expect(lines[0]!.reason).toContain("its Collie is older than Desktop's chat");
      expect(lines[0]!.request).toBeString();
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a refusal that quotes what the chat sent is logged without it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const { lines, log } = keeping();
      const quoting = machine("vm-mk", [task({ id: "t-b", run: "r-2", runs: ["r-2"] })], asked);
      const flock = {
        ...flockOn(asked, [
          {
            ...quoting,
            door: {
              ...quoting.door,
              act: () =>
                Effect.succeed([
                  {
                    kind: "answer",
                    state: "failed",
                    note: '"PRIVATE_ANSWER_123" is not one of A, B',
                  },
                ]),
            },
          },
        ]),
        actionsLog: log,
      };
      const said = yield* callFlockTool(flock, "collie_do", {
        actions: [{ kind: "answer", run: "r-2", choiceId: "next-1", answer: "PRIVATE_ANSWER_123" }],
      });
      expect(said).toContain("PRIVATE_ANSWER_123");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.ended).toBe("refused");
      expect(lines[0]!.reason).toContain("is not one of A, B");
      expect(lines[0]!.reason).not.toContain("PRIVATE_ANSWER_123");
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a confirmation whose proposed action fails is logged with its kinds and states only", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const { lines, log } = keeping();
      const proposing = machine(
        "vm-mk",
        [
          task({
            id: "t-b",
            run: "r-2",
            runs: ["r-2"],
            decision: { kind: "proposal", id: "p-1", hash: "h", text: "Answer it", actions: [] },
          }),
        ],
        asked,
      );
      const flock = {
        ...flockOn(asked, [
          {
            ...proposing,
            door: {
              ...proposing.door,
              confirm: ({ proposal }) =>
                Effect.succeed({
                  proposal,
                  results: [
                    {
                      index: 0,
                      kind: "answer",
                      state: "failed",
                      note: '"PRIVATE_CONFIRM_ANSWER_123" is not one of A, B',
                      run: "r-2",
                    },
                  ],
                }),
            },
          },
        ]),
        actionsLog: log,
      };
      const said = yield* callFlockTool(flock, "collie_do", {
        actions: [{ kind: "confirm", proposal: "p-1", hash: "h" }],
      });
      expect(said).toContain("PRIVATE_CONFIRM_ANSWER_123");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        kind: "confirm",
        ended: "refused",
        reason: "answer failed",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  ));

const standInHelle = (projects: ReadonlyArray<HelleProject>, calls: string[]) =>
  Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      calls.push(`${request.method} ${pathname}`);
      if (request.headers.get("authorization") !== "Bearer token-abc")
        return Response.json({ detail: "unauthorized" }, { status: 401 });
      if (pathname === "/api/v1/me") return Response.json({ user_id: "u-mk", display_name: "mk" });
      if (pathname === "/api/v1/projects") return Response.json(projects);
      if (pathname === "/api/v1/projects/frontend/claim")
        return Response.json({ position: 2, already_queued: false });
      if (pathname.endsWith("/release")) return Response.json({ released: true });
      return Response.json({ detail: "not found" }, { status: 404 });
    },
  });

const askHelle = (token: string | null, input: JsonObject) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        standInHelle(
          [
            {
              slug: "frontend",
              group: "Players",
              holder: { user_id: "u-ann", display_name: "ann" },
              queue: [{ user_id: "u-bo", display_name: "bo" }],
            },
            { slug: "backend", group: null, holder: { user_id: "u-mk", display_name: "mk" } },
            { slug: "docs" },
          ],
          calls,
        ),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );
    const flock = {
      ...flockOf([]),
      helle: Effect.succeed(
        token === null ? null : { url: `http://127.0.0.1:${server.port}`, token },
      ),
    };
    const said = yield* callFlockTool(flock, "collie_helle", input);
    return { said, calls };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

test("collie_helle lists every Helle project with its holder and queue, the human's own marked", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { said, calls } = yield* askHelle("token-abc", {});
      expect(said).toContain("Players/frontend: held by ann; queued: bo");
      expect(said).toContain("backend: held by you (mk)");
      expect(said).toContain("docs: free");
      expect(calls).toEqual(["GET /api/v1/me", "GET /api/v1/projects"]);
    }),
  ));

test("collie_helle claims a project, saying where the human stands, and releases one", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const claimed = yield* askHelle("token-abc", { claim: "frontend" });
      expect(claimed.said).toBe("Claimed frontend in Helle: queued at position 2.");
      expect(claimed.calls).toEqual(["POST /api/v1/projects/frontend/claim"]);
      const released = yield* askHelle("token-abc", { release: "frontend" });
      expect(released.said).toBe("Released frontend in Helle.");
      expect(released.calls).toEqual(["POST /api/v1/projects/frontend/release"]);
    }),
  ));

test("collie_helle asked to claim one project and release another does both, the release first", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { said, calls } = yield* askHelle("token-abc", {
        claim: "frontend",
        release: "backend",
      });
      expect(calls).toEqual([
        "POST /api/v1/projects/backend/release",
        "POST /api/v1/projects/frontend/claim",
      ]);
      expect(said).toBe(
        "Released backend in Helle.\nClaimed frontend in Helle: queued at position 2.",
      );
    }),
  ));

test("collie_helle still says what it released when the claim after it fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { said, calls } = yield* askHelle("token-abc", { claim: "nope", release: "backend" });
      expect(calls).toEqual([
        "POST /api/v1/projects/backend/release",
        "POST /api/v1/projects/nope/claim",
      ]);
      expect(said).toStartWith("Released backend in Helle.\n");
      expect(said).toContain("answered 404");
    }),
  ));

test("collie_helle says what Helle answered when it refuses, and how to give Desktop a token it lacks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect((yield* askHelle("token-old", {})).said).toContain("answered 401");
      const missing = yield* askHelle(null, {});
      expect(missing.said).toContain("Desktop holds no Helle token");
      expect(missing.said).toContain("/helle token");
      expect(missing.calls).toEqual([]);
      expect((yield* askHelle("token-abc", { claim: "nope" })).said).toContain("answered 404");
    }),
  ));
