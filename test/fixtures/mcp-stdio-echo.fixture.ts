import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { childEnv } from "../../desktop/src/bun/login-env";

const server = new McpServer({ name: "stdio-echo", version: "1" });
server.registerTool(
  "read_token",
  { title: "Read the token", description: "Answer with the token this process was given." },
  () => Promise.resolve({ content: [{ type: "text", text: childEnv().API_TOKEN ?? "" }] }),
);
await server.connect(new StdioServerTransport());
