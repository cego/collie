// Desktop's Flock chat calls the same Collie tools Native chat does, answered by each
// Machine's host over its `chat` channel, with everything named `<machine>:<id>`.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type BoardMessage, type Declaration, PROTOCOL, type TaskView } from "../src/board-model";
import type { JsonObject } from "../src/schema";
import { callFileTool, type ToolContent } from "../desktop/src/bun/file-tools";
import { callFlockTool, type ChatDoor, type ChatMachine } from "../desktop/src/bun/flock-tools";
import { task } from "./support/task";

interface Asked {
  readonly machine: string;
  readonly op: string;
  readonly payload: unknown;
}

const snapshot = (
  tasks: ReadonlyArray<TaskView>,
  protocol: number,
  files: boolean,
): BoardMessage => ({
  _tag: "Snapshot",
  installation: "i",
  build: "0.32.0",
  protocol,
  files,
  herds: [{ id: "h1" }],
  tasks,
  seq: 0,
});

/** A host that answers from its board and writes down every operation it is asked. */
const machine = (
  name: string,
  tasks: ReadonlyArray<TaskView>,
  asked: Asked[],
  protocol = PROTOCOL,
  files = true,
): ChatMachine => {
  const note = <P>(op: string, payload: P) => asked.push({ machine: name, op, payload });
  const door: ChatDoor = {
    board: () => Stream.make(snapshot(tasks, protocol, files)).pipe(Stream.concat(Stream.never)),
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
    runDetail: () => Stream.make(null),
    workflows: () => Effect.succeed([]),
    readFile: (payload) =>
      Effect.sync(() => {
        note("readFile", payload);
        const [mediaType = "text/plain", bytes = ""] = ON_DISK.get(payload.path) ?? [];
        return {
          path: payload.path,
          size: bytes.length,
          mediaType,
          content: Buffer.from(bytes).toString("base64"),
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
    editFile: (payload) =>
      Effect.sync(() => {
        note("editFile", payload);
        return { path: payload.path, replaced: 1 };
      }),
  };
  return { name, door };
};

/** What a fake Machine's files hold: a media type and the bytes. */
const ON_DISK = new Map([
  ["/var/log/app.log", ["text/plain", "one\ntwo\nthree\nfour\n"]],
  ["/tmp/shot.png", ["image/png", "PNG!"]],
  ["/tmp/trace.zip", ["application/zip", "PK\u0003\u0004"]],
]);

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
        said: () => undefined,
      };
      const looking = yield* callFlockTool(flock, "collie_news", {}).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const said = yield* Fiber.join(looking);
      expect(said).toContain("[consequential] mk-pc:r-1");
      expect(said).toContain("vm-mk's News could not be read");
    }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
  ));

test("a Machine whose board could not be read is written to by nothing, and a bare id it may have is not taken as unique", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const unreadable = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked),
          { ...unreadable, door: { ...unreadable.door, board: () => Stream.empty } },
        ],
        conversation: "flock@mk-pc",
        said: () => "hold it",
      };
      const bare = yield* callFlockTool(flock, "collie_hold", { run: "r-1" });
      const named = yield* callFlockTool(flock, "collie_hold", { run: "vm-mk:r-1" });
      expect(bare).toContain("vm-mk could not be read");
      expect(bare).toContain("mk-pc:r-1");
      expect(named).toContain("its board could not be read");
      expect(asked).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
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
        { type: "image", data: Buffer.from("PNG!").toString("base64"), mimeType: "image/png" },
      ]);
      const zip = yield* callFile([], "collie_read", { file_path: "vm-mk:/tmp/trace.zip" });
      expect(zip[0]).toMatchObject({ type: "text" });
      expect(textOf(zip)).toContain("vm-mk:/tmp/trace.zip is application/zip, 4 bytes");
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
