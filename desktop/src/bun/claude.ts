// The Flock chat's Claude Code: the Agent SDK, and Collie's tools served to it in this process.

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isJsonObject } from "../../../src/schema";
import type { ClaudeCode } from "./chat";
import { callFileTool, FILE_TOOLS, isFileTool } from "./file-tools";
import { callFlockTool, FLOCK_TOOLS } from "./flock-tools";

export const claudeCode: ClaudeCode<McpServer> = {
  query,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  // The Toolkit's tools and Desktop's file tools, every call decoded by its own.
  server: (flock, run) => {
    const server = new McpServer(
      { name: "collie", version: "1" },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [...FLOCK_TOOLS, ...FILE_TOOLS].map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          // SAFETY: a JSON Schema document for an object's parameters, which is what MCP lists.
          inputSchema: tool.input() as { type: "object" },
          annotations: { readOnlyHint: tool.readOnly },
        })),
      }),
    );
    server.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const { name } = request.params;
      const input = isJsonObject(request.params.arguments) ? request.params.arguments : {};
      return isFileTool(name)
        ? run(callFileTool(flock, name, input)).then((content) => ({ content: [...content] }))
        : run(callFlockTool(flock, name, input)).then((text) => ({
            content: [{ type: "text" as const, text }],
          }));
    });
    return server;
  },
};
