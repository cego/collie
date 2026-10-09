import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Crypto, Effect, Queue, Schema, Scope } from "effect";
import { Answers, Questions } from "../shared/chat-view";
import type { DriverContext } from "./driver";
import type { JsonObject } from "../../../src/schema";
import { NO_HUMAN } from "./session";
import { toolServer } from "./tool-server";

/** One authenticated endpoint, started lazily and held for Desktop's lifetime. */
export const loopbackTools = Effect.fn("FlockTools.loopback")(function* (context: DriverContext) {
  const scope = yield* Effect.scope;
  const token = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const calls = new Map<string, Queue.Queue<string>>();
  // The foreign MCP handler needs an AbortSignal for the human's pending click.
  // oxlint-disable-next-line effecttsgo/abort-controller-in-effect
  let turn = new AbortController();
  const matching = (input: JsonObject) =>
    Effect.gen(function* () {
      const questions = yield* Schema.decodeUnknownEffect(Questions)(input);
      const key = Schema.encodeSync(Schema.fromJsonString(Questions))(questions);
      let queue = calls.get(key);
      if (queue === undefined) {
        queue = yield* Queue.unbounded<string>();
        calls.set(key, queue);
      }
      return queue;
    });
  const finish = Effect.gen(function* () {
    turn.abort();
    yield* Effect.forEach(calls.values(), Queue.shutdown, { discard: true });
    calls.clear();
  });
  const ask = (input: JsonObject) => {
    if (context.flock.said() === undefined) return Promise.resolve(NO_HUMAN);
    const signal = turn.signal;
    return context.run(
      Effect.gen(function* () {
        const queue = yield* matching(input);
        const id = yield* Queue.take(queue);
        const answers = yield* Effect.tryPromise(() => context.ask(id, signal));
        return answers === null
          ? NO_HUMAN
          : Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ answers: Answers })))({
              answers,
            });
      }).pipe(Effect.catchCause(() => Effect.succeed("The question ended with its turn."))),
    );
  };
  const start = yield* Effect.cached(
    Effect.gen(function* () {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        fetch: (request) => {
          if (request.headers.get("Authorization") !== `Bearer ${token}`)
            return new Response("Unauthorized", { status: 401 });
          if (new URL(request.url).pathname !== "/mcp")
            return new Response("Not found", { status: 404 });
          const mcp = toolServer(context.flock, context.run, ask);
          const transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
          });
          return mcp
            .connect(transport)
            .then(() => transport.handleRequest(request))
            .finally(() => mcp.close());
        },
      });
      yield* Effect.addFinalizer(() =>
        finish.pipe(Effect.andThen(Effect.promise(() => server.stop(true)))),
      );
      return { url: `http://127.0.0.1:${server.port}/mcp`, token };
    }).pipe(Scope.provide(scope)),
  );
  return {
    start,
    begin: finish.pipe(
      Effect.andThen(
        Effect.sync(() => {
          // oxlint-disable-next-line effecttsgo/abort-controller-in-effect
          turn = new AbortController();
        }),
      ),
    ),
    finish,
    question: (id: string, input: JsonObject) =>
      matching(input).pipe(
        Effect.flatMap((queue) => Queue.offer(queue, id)),
        Effect.asVoid,
        Effect.ignore,
      ),
  };
}, Effect.orDie);
export type ChatEndpoint = Effect.Success<ReturnType<typeof loopbackTools>>;
