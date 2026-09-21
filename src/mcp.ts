// Collie as a local MCP server, which is how Claude Code reaches the tools in
// `tools.ts`.
//
// A transport adapter and nothing more. Effect serves the MCP protocol over this
// process's stdin and stdout, started by the chat launch with `--mcp-config`, and it
// exposes exactly what `TOOLS` exposes. There is no port, no daemon and no second
// orchestration service: the server lives as long as the chat that started it, and every
// answer it gives is a read through the shared operations.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Cause, Context, Effect, Exit, Fiber, Logger, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import manifest from "../herdr-plugin.toml";
import { currentEnv } from "./env";
import { isJsonObject } from "./schema";
import { TOOLS } from "./tools";

/**
 * Serve until stdin closes. Nothing is written to stdout but the protocol — a stray log
 * line there is a framing error that reads, to the harness, as Collie having no tools.
 */
export const serveMcp = Effect.fn("Mcp.serve")(
  function* () {
    const env = yield* currentEnv;
    const services = yield* Effect.context<BunServices>();
    const server = yield* McpServer.McpServer;
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
          tool.call(env, isJsonObject(input) ? input : {}).pipe(
            Effect.provideContext(services),
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
