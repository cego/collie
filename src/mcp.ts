import type { PlatformServices } from "./platform";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  Ref,
  Schema,
  flow,
  Result,
} from "effect";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import manifest from "../package.json";
import { currentEnv } from "./env";
import { replacedOnDisk } from "./flows";
import { shell } from "./mr";
import { isJsonObject, type JsonObject } from "./schema";
import { callTool, TOOLS } from "./tools";

export const serveMcp = Effect.fn("Mcp.serve")(
  function* () {
    const env = yield* currentEnv;
    const services = yield* Effect.context<PlatformServices>();
    const server = yield* McpServer.McpServer;
    const answer = yield* answering({
      binary: process.execPath,
      direct: (name, input) => callTool(env, name, input).pipe(Effect.provideContext(services)),
      rebuilt: (name, input) =>
        rebuiltAnswer(process.execPath, env.cwd, name, input).pipe(Effect.provideContext(services)),
    });
    for (const tool of TOOLS) {
      const descriptor = yield* Schema.decodeUnknownEffect(McpSchema.Tool)({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.readOnly },
      });
      yield* server.addTool({
        tool: descriptor,
        annotations: Context.empty(),
        handle: (input) =>
          answer(tool.name, isJsonObject(input) ? input : {}).pipe(
            Effect.map(
              (text) => new McpSchema.CallToolResult({ content: [{ type: "text", text }] }),
            ),
          ),
      });
    }
    return yield* Effect.never;
  },
  Effect.provide(
    McpServer.layerStdio({
      name: "collie",
      version: manifest.version,
      protocols: [McpProtocol.v2025_11_25],
    }),
  ),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.forkScoped,
  Effect.flatMap(Fiber.await),
  Effect.flatMap((exit) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : exit,
  ),
  Effect.scoped,
);

export const answering = Effect.fn("Mcp.answering")(function* <R>(opts: {
  readonly binary: string;
  readonly every?: Duration.Input;
  readonly direct: (name: string, input: JsonObject) => Effect.Effect<string, never, R>;
  readonly rebuilt: (name: string, input: JsonObject) => Effect.Effect<string, never, R>;
}) {
  const replaced = yield* Ref.make(false);
  const watching = yield* Deferred.make<void>();
  yield* Effect.forkScoped(
    replacedOnDisk(opts.binary, opts.every).pipe(
      Effect.tap(() => Deferred.succeed(watching, undefined)),
      Effect.flatten,
      Effect.andThen(Ref.set(replaced, true)),
    ),
  );
  return (name: string, input: JsonObject) =>
    Deferred.await(watching).pipe(
      Effect.andThen(Ref.get(replaced)),
      Effect.flatMap((now) => (now ? opts.rebuilt(name, input) : opts.direct(name, input))),
    );
});

const Answered = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data: Schema.Struct({ text: Schema.String }) }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.Struct({ message: Schema.String }),
    }),
  ]),
);
const encodeInput = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.JsonObject)),
  Result.getOrThrow,
);

export const rebuiltAnswer = (binary: string, cwd: string, name: string, input: JsonObject) =>
  shell(binary, ["--json", "tools", "call", name, "--input", encodeInput(input)], cwd).pipe(
    Effect.flatMap((ran) => Schema.decodeEffect(Answered)(ran.stdout)),
    Effect.map((answered) =>
      answered.ok ? answered.data.text : `Collie could not answer: ${answered.error.message}`,
    ),
    Effect.orElseSucceed(
      () => "Collie could not answer: the upgraded binary gave no answer. Reconnect with /mcp.",
    ),
  );
