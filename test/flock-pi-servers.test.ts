import { expect, test } from "bun:test";
import { piConnections, piServers } from "../desktop/src/bun/pi-servers";
import { userMcpServers } from "../desktop/src/bun/session";

const claudeJson = JSON.stringify({
  mcpServers: {
    "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" },
    docs: {
      type: "http",
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
      oauth: { clientId: "registered", callbackPort: 8765, scopes: "ignored" },
      alwaysLoad: true,
    },
    files: { command: "npx", args: ["-y", "files-mcp"], env: { ROOT: "/srv" } },
    collie: { command: "collie", args: ["mcp"] },
    "old.sse": { type: "sse", url: "https://legacy.example/sse" },
    legacy: { type: "sse", url: "https://legacy.example/sse" },
    helped: { type: "http", url: "https://helped.example/mcp", headersHelper: "/bin/token" },
    "my-tools": { command: "first" },
    my_tools: { command: "second" },
  },
});

test("Pi is given each of the human's servers it can run, with deferred tools, in Pi's own shape", () => {
  const { given } = piServers(userMcpServers(claudeJson));
  expect(given).toEqual({
    "linear-server": {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      exposure: "deferred",
    },
    docs: {
      type: "http",
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
      oauth: { clientId: "registered", callbackPort: 8765 },
      exposure: "deferred",
    },
    files: {
      command: "npx",
      args: ["-y", "files-mcp"],
      env: { ROOT: "/srv" },
      exposure: "deferred",
    },
    "my-tools": { command: "first", exposure: "deferred" },
  });
});

test("a server Pi cannot take is left out with why, and none silently", () => {
  const { left } = piServers(userMcpServers(claudeJson));
  expect(left).toEqual([
    { name: "collie", why: "the name of Collie's own server" },
    { name: "old.sse", why: "Pi takes only letters, digits, _ and - in a server's name" },
    { name: "legacy", why: "Pi does not speak SSE" },
    { name: "helped", why: "its headersHelper runs only in Claude Code" },
    { name: "my_tools", why: "Pi reads it as the same server as my-tools" },
  ]);
});

test("the chat is told what Pi was given, what was left out and how a server is signed in to", () => {
  const told = piConnections(piServers(userMcpServers(claudeJson)));
  expect(told).toContain("linear-server, docs, files, my-tools");
  expect(told).toContain("tool_search");
  expect(told).toContain("/mcp login <server>");
  expect(told).toContain("When tool_search finds none of a server's tools");
  expect(told).toContain("legacy (Pi does not speak SSE)");
  expect(told).toContain("claude.ai");
  expect(told).not.toContain("DOCS_TOKEN");
  expect(told).not.toContain("/srv");
});

test("with nothing configured the chat is told so rather than promised tools", () => {
  const told = piConnections(piServers({}));
  expect(told).toContain("this chat has none, beside");
  expect(told).not.toContain("Left out");
});
