// The Flock chat's Claude Code: the Agent SDK, and Collie's tools served to it in this process.

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import type { ClaudeCode } from "./claude-driver";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { childEnv } from "./login-env";
import { userMcpServers } from "./session";
import { toolServer } from "./tool-server";
import { readClaudeModels } from "./claude-models";
import type { FlockSettings } from "../shared/flock-settings";

export const claudeModels = (flock: FlockSettings, dir: string) =>
  readClaudeModels(query, flock, dir);

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
