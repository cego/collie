// Collie as a local MCP server, which is how Claude Code reaches the tools in
// `tools.ts`.
//
// A transport adapter and nothing more. It speaks the official SDK's protocol over this
// process's stdin and stdout, started by the chat launch with `--mcp-config` and
// `--strict-mcp-config`, and it exposes exactly what `TOOLS` exposes. There is no port,
// no daemon and no second orchestration service: the server lives as long as the chat
// that started it, and every answer it gives is a read through the shared operations.

import { BunServices } from "@effect/platform-bun";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import manifest from "../herdr-plugin.toml";
import { currentEnv } from "./env";
import { isJsonObject } from "./schema";
import { TOOLS, toolNamed } from "./tools";

/**
 * Serve until stdin closes. Nothing is written to stdout but the protocol — a stray log
 * line there is a framing error that reads, to the harness, as Collie having no tools.
 */
export const serveMcp = Effect.fn("Mcp.serve")(function* () {
  const env = yield* currentEnv;
  const server = new Server(
    { name: "collie", version: manifest.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      // Per tool, from the tool itself. A client uses this to decide what it may run
      // without asking, so the two that write — reading the news settles it, proposing
      // appends to the journal — must not claim otherwise.
      annotations: { readOnlyHint: tool.readOnly },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = toolNamed(request.params.name);
    if (tool === null)
      return {
        content: [{ type: "text" as const, text: `No tool "${request.params.name}".` }],
        isError: true,
      };
    // The SDK validated the arguments against the tool's own JSON Schema before this,
    // and every tool re-decodes what it reads; anything it does not name is ignored.
    const given = request.params.arguments;
    return Effect.runPromise(
      tool.call(env, isJsonObject(given) ? given : {}).pipe(Effect.provide(BunServices.layer)),
    ).then((text) => ({ content: [{ type: "text" as const, text }] }));
  });

  yield* Effect.promise(() => server.connect(new StdioServerTransport()));
  return yield* Effect.never;
});
