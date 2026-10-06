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
import { callFlockTool, FLOCK_TOOLS } from "./flock-tools";

export const claudeCode: ClaudeCode<McpServer> = {
  query,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  // Listed from the Toolkit, and every call decoded by it.
  server: (flock, run) => {
    const server = new McpServer(
      { name: "collie", version: "1" },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: FLOCK_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          // SAFETY: a JSON Schema document for an object's parameters, which is what MCP lists.
          inputSchema: tool.input() as { type: "object" },
          annotations: { readOnlyHint: tool.readOnly },
        })),
      }),
    );
    server.server.setRequestHandler(CallToolRequestSchema, (request) =>
      run(
        callFlockTool(
          flock,
          request.params.name,
          isJsonObject(request.params.arguments) ? request.params.arguments : {},
        ),
      ).then((text) => ({ content: [{ type: "text" as const, text }] })),
    );
    return server;
  },
};
