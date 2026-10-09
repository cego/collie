import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DriverContext } from "./driver";
import { isJsonObject, type JsonObject } from "../../../src/schema";
import { jsonSchemaOf } from "../../../src/toolkit";
import { Questions } from "../shared/chat-view";
import { callFileTool, FILE_TOOLS, isFileTool } from "./file-tools";
import { callFlockTool, FLOCK_TOOLS } from "./flock-tools";

export const toolServer = (
  flock: DriverContext["flock"],
  run: DriverContext["run"],
  ask?: (input: JsonObject) => Promise<string>,
) => {
  const server = new McpServer(
    { name: "collie", version: "1" },
    { capabilities: { tools: { listChanged: false } } },
  );
  const tools = [...FLOCK_TOOLS, ...FILE_TOOLS];
  if (ask !== undefined)
    tools.push({
      name: "AskUserQuestion",
      title: "Ask the human",
      description: "Ask the human to choose; wait for their click.",
      input: () => jsonSchemaOf(Questions),
      readOnly: true,
    });
  server.server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        // SAFETY: each tool's parameters are an object JSON Schema.
        inputSchema: tool.input() as { type: "object" },
        annotations: { readOnlyHint: tool.readOnly },
      })),
    }),
  );
  server.server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name } = request.params;
    const input = isJsonObject(request.params.arguments) ? request.params.arguments : {};
    if (name === "AskUserQuestion" && ask !== undefined)
      return ask(input).then((text) => ({ content: [{ type: "text" as const, text }] }));
    return isFileTool(name)
      ? run(callFileTool(flock, name, input)).then((content) => ({ content: [...content] }))
      : run(callFlockTool(flock, name, input)).then((text) => ({
          content: [{ type: "text" as const, text }],
        }));
  });
  return server;
};
