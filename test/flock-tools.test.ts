// Desktop's Flock chat calls the same Collie tools Native chat does, answered by each
// Machine's host over its `chat` channel, with everything named `<machine>:<id>`.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ATTACHMENT_BYTES } from "../src/attachments";
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
    read: (payload) =>
      Effect.sync(() => {
        note("read", payload);
        return `${payload.tool} answered by ${name}`;
      }),
  };
  return { name, door };
};

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
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        attachments: () => undefined,
        uploaded: new Map(),
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

test("a Machine whose host cannot answer a read is told to upgrade, and the rest still answer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const old = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...old, door: { ...old.door, read: () => Effect.never } },
        ],
        conversation: "flock@mk-pc",
        said: () => undefined,
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        attachments: () => undefined,
        uploaded: new Map(),
      };
      const reading = yield* callFlockTool(flock, "collie_workspaces", {}).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const said = yield* Fiber.join(reading);
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(said).toContain("collie_workspaces answered by mk-pc");
    }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
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
        attachments: () => undefined,
        uploaded: new Map(),
      };
      const said = yield* callFlockTool(flock, "collie_workspaces", {});
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(said).toContain("collie_workspaces answered by mk-pc");
    }).pipe(Effect.provide(BunServices.layer)),
  ));
