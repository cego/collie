// Fake herdr-core: core's plain JSON-RPC on a scratch socket, recording each call into the
// rig's log. Every reply it sends is checked against the pinned `hc.openrpc.json` first,
// so a reply the real core could not send fails the call that caused it. Its terminals act
// as a harness does: idle once started, and a sent prompt answered from the rig's Output
// queue between a `working` and an `idle` reported as OSC 7501 status events. One started
// with `--prompt`, as OpenCode is, reports nothing until it has worked on that prompt; an
// `opencode` one also serves its session and a prompt posted to it on its `--port`. After
// `hello {framed: true}` a connection is framed, and `terminal.attach` streams a terminal's
// first paint and what it prints, never more than core's window ahead of the viewer's CREDIT.
// A machine added with `via` is dialled as core dials one: its command, given a shell line
// last, run with the rig's `PATH`, each dial logged as `dialled`. An added machine's
// terminals are this core's own, under `<machine>/`.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import * as Socket from "effect/socket/Socket";
import { Clock, Effect, FileSystem, Option, Path, Schema, Scope } from "effect";
import { isString } from "../../src/schema";
import { Kind } from "../../src/hc";
import { answerPrompt } from "./fake-herdr-core";
import { jsonText, replyViolation } from "./hc-schema";

const Request = Schema.Struct({
  id: Schema.Finite,
  method: Schema.String,
  params: Schema.optionalKey(Schema.JsonObject),
});
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

export interface FakeHc {
  readonly socketPath: string;
  /** Answers every later `method` call with `reply`, whatever was asked. */
  readonly answer: (method: string, reply: Schema.Json) => void;
  /** The terminal named `name` reports `state`, as its program's OSC 7501 would. */
  readonly report: (name: string, state: string) => Effect.Effect<void>;
  /** The next send is typed but never starts a turn, until an Enter is pressed. */
  readonly stallNextSend: () => void;
  /** The next terminal's program reports itself blocked once started, as one in a dialog does. */
  readonly startBlocked: () => void;
  /** The terminal named `name` prints `text` to each viewer attached to it. */
  readonly print: (name: string, text: string) => Effect.Effect<void>;
  /** The program in the terminal named `name` exits with `code`. */
  readonly exit: (name: string, code: number) => Effect.Effect<void>;
  /** Every live terminal ends at once, as losing core's holder ends them. */
  readonly lose: Effect.Effect<void>;
  /**
   * Whether core can start `program`: one it cannot, as one missing from core's own PATH,
   * is `spawn_failed`, and core says the terminal it had made for it was `removed`.
   */
  readonly startable: (program: string, can: boolean) => void;
  /**
   * Core's own PATH is a bare system one, as for a core another Machine's SSH dial started:
   * it finds a program only on the PATH the launch passes in its `env`.
   */
  readonly barePath: () => void;
}

interface Added {
  readonly name: string;
  readonly target: string;
  readonly via: boolean;
  state: string;
  why: string | null;
}

/** How far core streams ahead of a viewer's CREDIT, as hc 0.1.14 does. */
export const CORE_WINDOW = 256 * 1024;
/** The size of each DATA frame a print is sent in. */
const CHUNK = 16 * 1024;

const frameOf = (channel: number, kind: number, payload: Uint8Array) => {
  const out = new Uint8Array(9 + payload.length);
  const head = new DataView(out.buffer);
  head.setUint32(0, channel, true);
  head.setUint8(4, kind);
  head.setUint32(5, payload.length, true);
  out.set(payload, 9);
  return out;
};
const utf8 = (text: string) => new TextEncoder().encode(text);

interface Viewer {
  readonly channel: number;
  readonly terminal: Terminal;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly backlog: Array<Uint8Array>;
  uncredited: number;
}

/** One client's connection: framed once it said so, with the streams it attached. */
interface Link {
  framed: boolean;
  next: number;
  readonly viewers: Map<number, Viewer>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void>;
}

type Answer =
  | { readonly result: Schema.Json }
  | {
      readonly failure: { readonly code: number; readonly message: string; readonly kind: string };
    };

const json = (value: Schema.Json) => value;

interface Terminal {
  readonly address: string;
  readonly name: string | null;
  readonly labels: Schema.Json;
  readonly argv: Schema.Json;
  readonly cwd: string;
  readonly pid: number;
  state: "live" | "finished";
  status: string | null;
  turn: number;
  /** The tail of what it printed, which a first paint shows. */
  screen: string;
}

/** A terminal as core's API shows it. */
const view = (terminal: Terminal): Schema.JsonObject => ({
  address: terminal.address,
  name: terminal.name,
  labels: terminal.labels,
  argv: terminal.argv,
  cwd: terminal.cwd,
  state: terminal.state,
  created_ms: 0,
  screen: "exact",
  cols: 80,
  rows: 24,
  identity: "",
  pid: terminal.state === "live" ? terminal.pid : null,
  status: terminal.status === null ? null : { state: terminal.status },
  turn: terminal.turn,
});

/** What Collie posts to OpenCode's `prompt_async`. */
const Prompted = Schema.Struct({ parts: Schema.Array(Schema.Struct({ text: Schema.String })) });

/** How long a fake harness works on a prompt before its Output is written. */
const TURN = "200 millis";
const text = (value: Schema.Json | undefined) => (isString(value) ? value : undefined);
/** The PATH a launch's `env` passes, if it passes one. */
const pathIn = (env: Schema.Json | undefined) =>
  Option.getOrUndefined(
    Option.map(
      Schema.decodeUnknownOption(Schema.Struct({ PATH: Schema.String }))(env),
      (passed) => passed.PATH,
    ),
  );

/** Serves a fake core at `socketPath` until `scope` closes, logging calls to `logPath`. */
export const serveFakeHc = Effect.fn("FakeHc.serve")(function* (
  socketPath: string,
  logPath: string,
  scope: Scope.Scope,
  /** Where a sent prompt's Output is taken from, as the fake herdr's agents take theirs. */
  queuePath = "",
  /** The environment a `via` command is run with. */
  dialEnv: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const terminals = new Map<string, Terminal>();
  const answers = new Map<string, Schema.Json>();
  const subscribers = new Set<(line: string) => Effect.Effect<void>>();
  let made = 0;
  let seq = 0;
  let stall = false;
  let blocked = false;
  const unstartable = new Set<string>();
  let bare = false;
  const typed = new Map<string, string>();
  const viewing = new Set<Viewer>();
  const opencodes = new Map<string, Bun.Server<undefined>>();
  const machines = new Map<string, Added>();
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      for (const served of opencodes.values()) void served.stop(true);
    }),
  );
  const ended = (terminal: Terminal) => {
    terminal.state = "finished";
    void opencodes.get(terminal.address)?.stop(true);
    opencodes.delete(terminal.address);
  };

  const find = (params: Schema.JsonObject) => {
    const named = text(params.terminal) ?? "";
    const [on, there] = Str.split(named, "/");
    const asked = there !== undefined && machines.has(on ?? "") ? there : named;
    return Option.getOrUndefined(
      Arr.findFirst(
        [...terminals.values()],
        (t) => t.state === "live" && (t.address === asked || t.name === asked),
      ),
    );
  };
  const live = () =>
    Arr.map(
      Arr.filter([...terminals.values()], (t) => t.state === "live"),
      view,
    );
  const notFound = (params: Schema.JsonObject): Answer => ({
    failure: {
      code: -32000,
      message: `no terminal ${text(params.terminal) ?? ""}`,
      kind: "not_found",
    },
  });

  const emit = (at: string, type: string, data: Schema.Json) =>
    Effect.gen(function* () {
      seq += 1;
      const line = yield* encodeJson({
        jsonrpc: "2.0",
        method: "event",
        params: { seq, type, terminal: at, data },
      }).pipe(Effect.orDie);
      for (const write of subscribers) yield* write(`${line}\n`);
    });
  const logged = (cmd: string, params: Schema.Json) =>
    encodeJson({ transport: "core", cmd, params }).pipe(
      Effect.flatMap((entry) => fs.writeFileString(logPath, `${entry}\n`, { flag: "a" })),
      Effect.orDie,
    );
  /** Sends what the viewer's credit allows of its backlog, filling the window exactly. */
  const pump = (viewer: Viewer) =>
    Effect.gen(function* () {
      for (;;) {
        const next = viewer.backlog[0];
        const room = CORE_WINDOW - viewer.uncredited;
        if (next === undefined || room <= 0) return;
        const sent = next.subarray(0, room);
        if (sent.length === next.length) viewer.backlog.shift();
        else viewer.backlog[0] = next.subarray(room);
        viewer.uncredited += sent.length;
        yield* viewer.write(frameOf(viewer.channel, Kind.DATA, sent));
      }
    });
  const chunks = (text: string) => {
    const bytes = utf8(text);
    return Arr.map(Arr.range(0, Math.ceil(bytes.length / CHUNK) - 1), (at) =>
      bytes.subarray(at * CHUNK, (at + 1) * CHUNK),
    );
  };
  const viewersOf = (terminal: Terminal) =>
    Arr.filter([...viewing], (viewer) => viewer.terminal === terminal);

  /** Logged beside the calls as `reported`, so a test can order a call against it. */
  const setStatus = (terminal: Terminal, state: string) =>
    Effect.gen(function* () {
      terminal.status = state;
      const entry = yield* encodeJson({
        transport: "core",
        cmd: "reported",
        params: { terminal: terminal.name, state },
      }).pipe(Effect.orDie);
      yield* fs.writeFileString(logPath, `${entry}\n`, { flag: "a" }).pipe(Effect.orDie);
      yield* emit(terminal.address, "status", { status: { state }, records: {}, reported: true });
    });
  /** The turn a prompt starts: working at once, then its Output written and idle again. */
  const take = (terminal: Terminal, prompt: string) =>
    Effect.gen(function* () {
      terminal.turn += 1;
      yield* emit(terminal.address, "turn", { turn: terminal.turn, state: "working" });
      yield* setStatus(terminal, "working");
      yield* Effect.forkIn(
        Effect.sleep(TURN).pipe(
          Effect.andThen(answerPrompt(prompt, logPath, queuePath)),
          Effect.provideContext(services),
          Effect.orDie,
          Effect.andThen(setStatus(terminal, "idle")),
        ),
        scope,
      );
      return terminal.turn;
    });

  /** OpenCode's TUI is its own server: the session it continues, and a prompt posted to it. */
  const opencodeServer = (terminal: Terminal, argv: ReadonlyArray<string>) => {
    const session = argv[argv.indexOf("--session") + 1];
    const served = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: Number(argv[argv.indexOf("--port") + 1]),
      fetch: (request) =>
        Effect.runPromiseWith(services)(
          Effect.gen(function* () {
            const path = new URL(request.url).pathname;
            if (request.method === "GET" && path === `/session/${session}`)
              return Response.json({ id: session, directory: terminal.cwd });
            if (request.method !== "POST" || path !== `/session/${session}/prompt_async`)
              return new Response("not found", { status: 404 });
            const body = yield* Effect.promise(() => request.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Prompted)),
              Effect.orDie,
            );
            const prompt = body.parts[0]?.text ?? "";
            yield* logged("prompt_async", { terminal: terminal.name, text: prompt });
            yield* take(terminal, prompt);
            return new Response(null, { status: 204 });
          }),
        ),
    });
    opencodes.set(terminal.address, served);
  };

  const profile = (machine: Added): Schema.JsonObject => ({
    name: machine.name,
    target: machine.target,
    via: machine.via,
    id: `id-${machine.name}`,
    host: machine.name,
    version: "0.1.14",
  });
  const machineView = (machine: Added): Schema.JsonObject => ({
    ...profile(machine),
    state: machine.state,
    why: machine.why,
  });
  /** Runs a machine's `via` with a line that answers at once, as core checks hc there. */
  const dial = (machine: Added) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const child = Bun.spawn(["/bin/sh", "-c", `${machine.target} true`], {
        env: { ...process.env, ...dialEnv },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, said] = yield* Effect.promise(() =>
        Promise.all([child.exited, new Response(child.stderr).text()]),
      );
      machine.state = code === 0 ? "connected" : "unreachable";
      machine.why = code === 0 ? null : Str.trim(said);
      const ms = (yield* Clock.currentTimeMillis) - started;
      yield* logged("dialled", { machine: machine.name, code, ms });
    });
  const unknownMachine = (params: Schema.JsonObject): Answer => ({
    failure: {
      code: -32000,
      message: `no machine ${text(params.machine) ?? ""}`,
      kind: "machine_unknown",
    },
  });

  const answer = (method: string, params: Schema.JsonObject, link: Link): Effect.Effect<Answer> =>
    Effect.gen(function* () {
      const canned = answers.get(method);
      if (canned !== undefined) return { result: canned };
      switch (method) {
        case "hello":
          return {
            result: {
              generation: 1,
              version: "0.1.14",
              core: { id: "fake", name: "fake" },
              framed: params.framed === true,
              methods: [],
              features: [],
            },
          };
        case "terminal.run": {
          const cwd = text(params.cwd);
          if (cwd !== undefined && !(yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false))))
            return {
              failure: { code: -32000, message: "spawn_failed", kind: "spawn_failed" },
            };
          const program = Arr.filter(Arr.isArray(params.argv) ? params.argv : [], isString)[0];
          const notFound =
            bare &&
            program !== undefined &&
            Bun.which(program, { PATH: pathIn(params.env) ?? "/usr/bin:/bin" }) === null;
          if (program !== undefined && (unstartable.has(program) || notFound)) {
            made += 1;
            yield* emit(`t${made}`, "removed", {});
            return {
              failure: { code: -32000, message: "spawn_failed", kind: "spawn_failed" },
            };
          }
          made += 1;
          const terminal: Terminal = {
            address: `t${made}`,
            name: text(params.name) ?? null,
            labels: params.labels ?? {},
            argv: params.argv ?? [],
            cwd: text(params.cwd) ?? "/",
            pid: 1000 + made,
            state: "live",
            status: null,
            turn: 0,
            screen: "",
          };
          terminals.set(terminal.address, terminal);
          yield* emit(terminal.address, "created", view(terminal));
          const argv = Arr.filter(Arr.isArray(params.argv) ? params.argv : [], isString);
          if (argv[0] === "opencode" && argv.includes("--port")) opencodeServer(terminal, argv);
          const prompt = argv[argv.indexOf("--prompt") + 1];
          if (argv.includes("--prompt") && prompt !== undefined) yield* take(terminal, prompt);
          // A harness at its prompt says so once it has drawn it.
          else yield* setStatus(terminal, blocked ? "blocked" : "idle");
          blocked = false;
          return { result: view(terminal) };
        }
        case "terminal.list":
          return {
            result: {
              terminals: live(),
              hidden_finished: 0,
              machines: [],
            },
          };
        case "terminal.get": {
          const found = find(params);
          return found ? { result: view(found) } : notFound(params);
        }
        case "terminal.send": {
          const found = find(params);
          if (!found) return notFound(params);
          const status = found.status;
          if (status === "blocked")
            return {
              failure: { code: -32000, message: "blocked", kind: "blocked" },
            };
          if (stall) {
            stall = false;
            typed.set(found.address, text(params.text) ?? "");
            return { result: { turn: found.turn, started: false, status } };
          }
          const turn = yield* take(found, text(params.text) ?? "");
          return { result: { turn, started: true, status } };
        }
        case "terminal.keys": {
          const found = find(params);
          if (!found) return notFound(params);
          const pending = typed.get(found.address);
          const keys = Arr.isArray(params.keys) ? params.keys : [];
          if (pending !== undefined && keys.includes("enter")) {
            typed.delete(found.address);
            return { result: { turn: yield* take(found, pending), status: "idle" } };
          }
          return { result: { turn: found.turn, status: null } };
        }
        case "terminal.kill": {
          const found = find(params);
          if (!found) return notFound(params);
          found.state = "finished";
          yield* emit(found.address, "finished", { reason: "killed" });
          return { result: view(found) };
        }
        case "terminal.attach": {
          if (!link.framed)
            return { failure: { code: -32000, message: "needs_framed", kind: "needs_framed" } };
          const found = find(params);
          if (!found) return notFound(params);
          const viewer: Viewer = {
            channel: link.next++,
            terminal: found,
            write: link.write,
            backlog: [utf8(`\u001b[!p\u001b[H\u001b[2J${found.screen}`)],
            uncredited: 0,
          };
          link.viewers.set(viewer.channel, viewer);
          viewing.add(viewer);
          // Both off: Collie sends keys as DATA and tracks size itself.
          return {
            result: {
              channel: viewer.channel,
              terminal: view(found),
              resize_notifications: false,
              automatic_input: false,
            },
          };
        }
        case "terminal.read": {
          const found = find(params);
          return found ? { result: { text: "", complete: true, how: "screen" } } : notFound(params);
        }
        case "events.subscribe":
          return {
            result: {
              seq,
              terminals: live(),
            },
          };
        case "machine.list":
          return { result: { machines: Arr.map([...machines.values()], machineView) } };
        case "machine.add": {
          const name = text(params.name) ?? text(params.target) ?? "";
          if (machines.has(name))
            return { failure: { code: -32000, message: "already_added", kind: "already_added" } };
          const via = text(params.via);
          const added: Added = {
            name,
            target: via ?? text(params.target) ?? "",
            via: via !== undefined,
            state: "connecting",
            why: null,
          };
          if (added.via) {
            yield* dial(added);
            if (added.state !== "connected")
              return {
                failure: { code: -32000, message: added.why ?? "", kind: "unreachable" },
              };
          }
          machines.set(name, added);
          return { result: profile(added) };
        }
        case "machine.connect": {
          const found = machines.get(text(params.machine) ?? "");
          if (found === undefined) return unknownMachine(params);
          if (found.via) yield* dial(found);
          return { result: machineView(found) };
        }
        case "machine.rm": {
          const name = text(params.machine) ?? "";
          if (!machines.delete(name)) return unknownMachine(params);
          return { result: { removed: name } };
        }
        default:
          return { failure: { code: -32601, message: `no method ${method}`, kind: "not_found" } };
      }
    });

  const reply = (
    id: number,
    method: string,
    params: Schema.JsonObject,
    link: Link,
  ): Effect.Effect<Schema.Json> =>
    Effect.gen(function* () {
      const answered = yield* answer(method, params, link);
      if ("failure" in answered) {
        const { code, message, kind } = answered.failure;
        return json({ jsonrpc: "2.0", id, error: { code, message, data: { kind } } });
      }
      const violation = replyViolation(method, answered.result);
      if (violation === undefined) return json({ jsonrpc: "2.0", id, result: answered.result });
      return json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `the fake core's reply is one hc.openrpc.json forbids: ${method} ${jsonText(answered.result)}: ${violation}`,
          data: { kind: "fake_core_contract" },
        },
      });
    });

  /** What a viewer sent on its stream: keys, a resize, credit, or that it let go. */
  const streamed = (link: Link, channel: number, kind: number, payload: Uint8Array) =>
    Effect.gen(function* () {
      const viewer = link.viewers.get(channel);
      if (viewer === undefined) return;
      const terminal = viewer.terminal.name;
      const bytes = new DataView(payload.buffer, payload.byteOffset, payload.length);
      switch (kind) {
        case Kind.DATA:
          return yield* logged("attach.data", {
            terminal,
            text: new TextDecoder().decode(payload),
          });
        case Kind.RESIZE:
          return yield* logged("attach.resize", {
            terminal,
            cols: bytes.getUint16(0, true),
            rows: bytes.getUint16(2, true),
          });
        case Kind.CREDIT: {
          const credited = bytes.getUint32(0, true);
          viewer.uncredited -= credited;
          yield* logged("attach.credit", { terminal, bytes: credited });
          return yield* pump(viewer);
        }
        case Kind.CLOSE:
          link.viewers.delete(channel);
          viewing.delete(viewer);
          return yield* logged("attach.close", { terminal });
      }
    });

  const connection = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const pull = yield* Socket.readerBytes(socket);
      const writer = yield* socket.writer;
      const link: Link = {
        framed: false,
        next: 1,
        viewers: new Map(),
        write: (bytes) => writer.write(bytes).pipe(Effect.ignore),
      };
      const write = (line: string) => writer.write(line).pipe(Effect.ignore);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          subscribers.delete(write);
          for (const viewer of link.viewers.values()) viewing.delete(viewer);
        }),
      );
      const request = (line: string) =>
        Effect.gen(function* () {
          const asked = decodeRequest(line);
          if (Option.isNone(asked)) return;
          const { id, method, params = {} } = asked.value;
          const entry = yield* encodeJson({ transport: "core", cmd: method, method, params });
          yield* fs.writeFileString(logPath, `${entry}\n`, { flag: "a" });
          const answered = yield* encodeJson(yield* reply(id, method, params, link));
          yield* link.framed
            ? link.write(frameOf(0, Kind.DATA, utf8(answered)))
            : writer.write(`${answered}\n`);
          if (method === "hello" && params.framed === true) link.framed = true;
          if (method === "events.subscribe") subscribers.add(write);
          for (const viewer of link.viewers.values()) yield* pump(viewer);
        });
      let buffered = new Uint8Array(0);
      for (;;) {
        for (const chunk of yield* pull) {
          const joined = new Uint8Array(buffered.length + chunk.length);
          joined.set(buffered);
          joined.set(chunk, buffered.length);
          buffered = joined;
        }
        for (;;) {
          if (!link.framed) {
            const end = buffered.indexOf(10);
            if (end < 0) break;
            const line = new TextDecoder().decode(buffered.subarray(0, end));
            buffered = buffered.subarray(end + 1);
            yield* request(line);
            continue;
          }
          if (buffered.length < 9) break;
          const head = new DataView(buffered.buffer, buffered.byteOffset);
          const length = head.getUint32(5, true);
          if (buffered.length < 9 + length) break;
          const channel = head.getUint32(0, true);
          const kind = head.getUint8(4);
          const payload = buffered.slice(9, 9 + length);
          buffered = buffered.subarray(9 + length);
          yield* channel === 0
            ? request(new TextDecoder().decode(payload))
            : streamed(link, channel, kind, payload);
        }
      }
    }).pipe(Effect.scoped, Effect.ignore);

  const server = yield* BunSocketServer.make({ path: socketPath }).pipe(Scope.provide(scope));
  yield* Effect.forkIn(server.run(connection), scope);
  return {
    socketPath,
    answer: (method, value) => {
      answers.set(method, value);
    },
    report: (name, state) =>
      Effect.suspend(() => {
        const found = find({ terminal: name });
        return found === undefined ? Effect.void : setStatus(found, state);
      }),
    stallNextSend: () => {
      stall = true;
    },
    startBlocked: () => {
      blocked = true;
    },
    print: (name, text) =>
      Effect.suspend(() => {
        const found = find({ terminal: name });
        if (found === undefined) return Effect.void;
        found.screen = pipe(found.screen + text, Str.slice(-200));
        return Effect.forEach(viewersOf(found), (viewer) => {
          viewer.backlog.push(...chunks(text));
          return pump(viewer);
        });
      }),
    exit: (name, code) =>
      Effect.suspend(() => {
        const found = find({ terminal: name });
        if (found === undefined) return Effect.void;
        ended(found);
        return Effect.gen(function* () {
          yield* emit(found.address, "finished", { reason: "exited", exit_code: code });
          const closed = yield* encodeJson({
            exit_code: code,
            finished_ms: 0,
            reason: "exited",
            signal: null,
          }).pipe(Effect.orDie);
          for (const viewer of viewersOf(found)) {
            viewing.delete(viewer);
            yield* viewer.write(frameOf(viewer.channel, Kind.CLOSE, utf8(closed)));
          }
        });
      }),
    lose: Effect.suspend(() =>
      Effect.forEach(
        Arr.filter([...terminals.values()], (t) => t.state === "live"),
        (lost) => {
          ended(lost);
          return emit(lost.address, "finished", { reason: "holder_lost" });
        },
        { discard: true },
      ),
    ),
    startable: (program, can) => {
      if (can) unstartable.delete(program);
      else unstartable.add(program);
    },
    barePath: () => {
      bare = true;
    },
  } satisfies FakeHc;
});
