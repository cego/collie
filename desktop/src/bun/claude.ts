// The Flock chat's Claude Code: the Agent SDK, and Collie's tools served to it in this process.

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeCode } from "./claude-driver";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolServer } from "./tool-server";

export const claudeCode: ClaudeCode<McpServer> = {
  query,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  server: toolServer,
};
