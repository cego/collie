// The Flock chat runs on the user's own Claude Code with nothing of theirs loaded: no
// built-in tools, no settings, hooks, skills or CLAUDE.md, and Collie's tools as its only
// tools.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { sessionOptions } from "../desktop/src/bun/session";

const options = sessionOptions({
  cwd: "/state/collie-desktop",
  session: { resume: "5c1e6c8e-0000-4000-8000-000000000000" },
  server: "the in-process server",
  claude: "/usr/local/bin/claude",
});

test("the session is opus at medium effort, resumed, on the user's own Claude Code", () => {
  expect(options).toMatchObject({
    model: "opus",
    effort: "medium",
    resume: "5c1e6c8e-0000-4000-8000-000000000000",
    pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    cwd: "/state/collie-desktop",
  });
});

test("built-in tools are off, no setting source is read, and Collie's server is the only one", () => {
  expect(options.tools).toEqual([]);
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(Object.keys(options.mcpServers)).toEqual(["collie"]);
  expect(options.mcpServers.collie).toEqual({
    type: "sdk",
    name: "collie",
    instance: "the in-process server",
  });
  expect(options.allowedTools.every((name) => name.startsWith("mcp__collie__collie_"))).toBe(true);
  expect(options.allowedTools).toContain("mcp__collie__collie_do");
});

test("anything else that asks permission is refused", () =>
  Effect.runPromise(
    Effect.promise(() => options.canUseTool("Bash")).pipe(
      Effect.map((answer) => expect(answer).toMatchObject({ behavior: "deny" })),
    ),
  ));
