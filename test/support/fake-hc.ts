// Fake herdr-core: core's plain JSON-RPC on a scratch socket, recording each call into the
// rig's log. Every reply it sends is checked against the pinned `hc.openrpc.json` first,
// so a reply the real core could not send fails the call that caused it.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import * as Socket from "effect/socket/Socket";
import { Effect, FileSystem, Option, Schema, Scope } from "effect";
import { isString } from "../../src/schema";
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
}

type Answer =
  | { readonly result: Schema.Json }
  | {
      readonly failure: { readonly code: number; readonly message: string; readonly kind: string };
    };

const text = (value: Schema.Json | undefined) => (isString(value) ? value : undefined);

/** Serves a fake core at `socketPath` until `scope` closes, logging calls to `logPath`. */
export const serveFakeHc = Effect.fn("FakeHc.serve")(function* (
  socketPath: string,
  logPath: string,
  scope: Scope.Scope,
) {
  const fs = yield* FileSystem.FileSystem;
  const terminals = new Map<string, Schema.JsonObject>();
  const answers = new Map<string, Schema.Json>();
  let made = 0;

  const find = (params: Schema.JsonObject) => {
    const asked = text(params.terminal);
    return Option.getOrUndefined(
      Arr.findFirst([...terminals.values()], (t) => t.address === asked || t.name === asked),
    );
  };
  const notFound = (params: Schema.JsonObject): Answer => ({
    failure: {
      code: -32000,
      message: `no terminal ${text(params.terminal) ?? ""}`,
      kind: "not_found",
    },
  });
  const found = (params: Schema.JsonObject, result: Schema.Json): Answer =>
    find(params) ? { result } : notFound(params);

  const answer = (method: string, params: Schema.JsonObject): Answer => {
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
        const address = `t${++made}`;
        const terminal: Schema.JsonObject = {
          address,
          name: text(params.name) ?? null,
          labels: params.labels ?? {},
          argv: params.argv ?? [],
          cwd: text(params.cwd) ?? "/",
          state: "live",
          created_ms: 0,
          screen: "exact",
          cols: 80,
          rows: 24,
          identity: "",
          pid: 1000 + made,
          status: null,
          turn: 0,
        };
        terminals.set(address, terminal);
        return { result: terminal };
      }
      case "terminal.list":
        return { result: { terminals: [...terminals.values()], hidden_finished: 0, machines: [] } };
      case "terminal.get":
        return found(params, find(params) ?? null);
      case "terminal.send":
      case "terminal.keys":
        return found(params, { turn: 0, status: null });
      case "terminal.read":
        return found(params, { text: "", complete: true, how: "screen" });
      case "events.subscribe":
        return { result: { seq: 0, terminals: [...terminals.values()] } };
      default:
        return { failure: { code: -32601, message: `no method ${method}`, kind: "not_found" } };
    }
  };

  const reply = (id: number, method: string, params: Schema.JsonObject): Schema.Json => {
    const answered = answer(method, params);
    if ("failure" in answered) {
      const { code, message, kind } = answered.failure;
      return { jsonrpc: "2.0", id, error: { code, message, data: { kind } } };
    }
    const violation = replyViolation(method, answered.result);
    if (violation === undefined) return { jsonrpc: "2.0", id, result: answered.result };
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: `the fake core's reply is one hc.openrpc.json forbids: ${method} ${jsonText(answered.result)}: ${violation}`,
        data: { kind: "fake_core_contract" },
      },
    };
  };

  const connection = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
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
          yield* writer.write(`${yield* encodeJson(reply(id, method, params))}\n`);
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
  } satisfies FakeHc;
});
