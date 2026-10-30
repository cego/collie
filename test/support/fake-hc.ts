// Fake herdr-core: core's plain JSON-RPC on a scratch socket, recording each call into the
// rig's log. Every reply it sends is checked against the pinned `hc.openrpc.json` first,
// so a reply the real core could not send fails the call that caused it. Its terminals act
// as a harness does: idle once started, and a sent prompt answered from the rig's Output
// queue between a `working` and an `idle` reported as OSC 7501 status events.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import * as Socket from "effect/socket/Socket";
import { Effect, FileSystem, Option, Path, Schema, Scope } from "effect";
import { isString } from "../../src/schema";
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

/** How long a fake harness works on a prompt before its Output is written. */
const TURN = "200 millis";
const text = (value: Schema.Json | undefined) => (isString(value) ? value : undefined);

/** Serves a fake core at `socketPath` until `scope` closes, logging calls to `logPath`. */
export const serveFakeHc = Effect.fn("FakeHc.serve")(function* (
  socketPath: string,
  logPath: string,
  scope: Scope.Scope,
  /** Where a sent prompt's Output is taken from, as the fake herdr's agents take theirs. */
  queuePath = "",
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
  const typed = new Map<string, string>();

  const find = (params: Schema.JsonObject) => {
    const asked = text(params.terminal);
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
  const setStatus = (terminal: Terminal, state: string) =>
    Effect.suspend(() => {
      terminal.status = state;
      return emit(terminal.address, "status", { status: { state }, records: {}, reported: true });
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

  const answer = (method: string, params: Schema.JsonObject): Effect.Effect<Answer> =>
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
              framed: false,
              methods: [],
              features: [],
            },
          };
        case "terminal.run": {
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
          };
          terminals.set(terminal.address, terminal);
          yield* emit(terminal.address, "created", view(terminal));
          // A harness at its prompt says so once it has drawn it.
          yield* setStatus(terminal, blocked ? "blocked" : "idle");
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
        default:
          return { failure: { code: -32601, message: `no method ${method}`, kind: "not_found" } };
      }
    });

  const reply = (
    id: number,
    method: string,
    params: Schema.JsonObject,
  ): Effect.Effect<Schema.Json> =>
    Effect.gen(function* () {
      const answered = yield* answer(method, params);
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

  const connection = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      const write = (line: string) => writer.write(line).pipe(Effect.ignore);
      yield* Effect.addFinalizer(() => Effect.sync(() => subscribers.delete(write)));
      let buffered = "";
      for (;;) {
        buffered += Arr.join(yield* pull, "");
        const lines = pipe(buffered, Str.split("\n"));
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const request = decodeRequest(line);
          if (Option.isNone(request)) continue;
          const { id, method, params = {} } = request.value;
          const entry = yield* encodeJson({ transport: "core", cmd: method, method, params });
          yield* fs.writeFileString(logPath, `${entry}\n`, { flag: "a" });
          const answered = yield* encodeJson(yield* reply(id, method, params));
          yield* writer.write(`${answered}\n`);
          if (method === "events.subscribe") subscribers.add(write);
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
  } satisfies FakeHc;
});
