// Collie as a local MCP server, which is how Claude Code reaches the tools in
// `tools.ts`.
//
// A transport adapter and nothing more. Effect serves the MCP protocol over this
// process's stdin and stdout, started by the chat launch with `--mcp-config`, and it
// exposes exactly what the `CollieTools` Toolkit does. There is no port, no daemon and no second
// orchestration service: the server lives as long as the chat that started it, and every
// answer it gives is a read through the shared operations.

import type { BunServices } from "@effect/platform-bun/BunServices";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Logger,
  Ref,
  Schema,
} from "effect";
import * as McpProtocol from "effect/unstable/ai/McpProtocol";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as McpServer from "effect/unstable/ai/McpServer";
import manifest from "../herdr-plugin.toml";
import { currentEnv } from "./env";
import { replacedOnDisk } from "./flows";
import { shell } from "./mr";
import { isJsonObject, type JsonObject } from "./schema";
import { callTool, TOOLS } from "./tools";

/**
 * Serve until stdin closes. Nothing is written to stdout but the protocol — a stray log
 * line there is a framing error that reads, to the harness, as Collie having no tools.
 */
export const serveMcp = Effect.fn("Mcp.serve")(
  function* () {
    const env = yield* currentEnv;
    const services = yield* Effect.context<BunServices>();
    const server = yield* McpServer.McpServer;
    const answer = yield* answering({
      binary: process.execPath,
      direct: (name, input) => callTool(env, name, input).pipe(Effect.provideContext(services)),
      rebuilt: (name, input) =>
        rebuiltAnswer(process.execPath, env.cwd, name, input).pipe(Effect.provideContext(services)),
    });
    // Not `McpServer.toolkit`, which answers in JSON and refuses bad input as a protocol
    // error: chat is answered in sentences, a refusal included.
    for (const tool of TOOLS) {
      const descriptor = yield* Schema.decodeUnknownEffect(McpSchema.Tool)({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        // Clients use this to decide what they may run without asking. A tool that
        // settles news or carries out an instruction must not claim to be read-only.
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
  // Native stdio interrupts its owner at EOF. End this child cleanly without
  // swallowing interruption of the caller or turning normal EOF into exit 130.
  Effect.forkScoped,
  Effect.flatMap(Fiber.await),
  Effect.flatMap((exit) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.void : exit,
  ),
  Effect.scoped,
);

/**
 * How a tool call is answered: here, until `collie upgrade` renames a new binary over this
 * one, and then by that binary, so a chat keeps its server across an upgrade and is still
 * answered by the build the host runs. Tool names and schemas stay this build's until
 * the chat reconnects.
 */
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
  // An answer waits for the binary to be read, or one renamed over at once is never seen replaced.
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
const encodeInput = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));

/** One tool call made by the binary now on disk, through the `tools call` a human can run. */
const rebuiltAnswer = (binary: string, cwd: string, name: string, input: JsonObject) =>
  shell(binary, ["--json", "tools", "call", name, "--input", encodeInput(input)], cwd, "say").pipe(
    Effect.flatMap((ran) => Schema.decodeUnknownEffect(Answered)(ran.stdout)),
    Effect.map((answered) =>
      answered.ok ? answered.data.text : `Collie could not answer: ${answered.error.message}`,
    ),
    Effect.orElseSucceed(
      () => "Collie could not answer: the upgraded binary gave no answer. Reconnect with /mcp.",
    ),
  );
