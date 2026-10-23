// The Flock chat's Claude Code: the Agent SDK, and Collie's tools served to it in this process.

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { Effect } from "effect";
import type { ClaudeCode } from "./claude-driver";
import { readClaudeModels } from "./claude-models";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { childEnv, which } from "./login-env";
import { userMcpServers } from "./session";
import { toolServer } from "./tool-server";

export const claudeCode: ClaudeCode<McpServer> = {
  query,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  server: toolServer,
  userServers: () =>
    Bun.file(`${childEnv().CLAUDE_CONFIG_DIR ?? homedir()}/.claude.json`)
      .text()
      .then(userMcpServers),
};

/** Claude Code's own list of models, on the executable the driver runs. */
export const claudeModels = Effect.suspend(() => readClaudeModels(query, which("claude")));
