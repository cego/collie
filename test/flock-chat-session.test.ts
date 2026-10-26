import { expect, test } from "bun:test";
import { Effect, type Scope, Stream } from "effect";
import { type ClaudeCode, claudeDriver } from "../desktop/src/bun/claude-driver";
import type { DriverContext } from "../desktop/src/bun/driver";
import { sessionOptions, userMcpServers } from "../desktop/src/bun/session";
import { opensOn } from "../desktop/src/bun/chat-choices";
import type { DesktopSettings } from "../desktop/src/shared/flock";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
let noticed: string | undefined;
let rule: string | undefined;
const machines = [
  { name: "mk-pc", local: true },
  { name: "vm-mk", local: false },
];
const asked: string[] = [];
const options = sessionOptions({
  cwd: "/state/collie-desktop",
  session: { resume: "5c1e6c8e-0000-4000-8000-000000000000" },
  model: "opus",
  effort: "medium",
  server: "the in-process server",
  claude: "/usr/local/bin/claude",
  userServers: { "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" } },
  ask: (toolUseID) => {
    asked.push(toolUseID);
    return Promise.resolve({ "Which one?": "vm-mk" });
  },
  noticed: () => noticed,
  placement: () => (rule === undefined ? undefined : { rule, machines }),
});
const permission = {
  signal: new AbortController().signal,
  toolUseID: "toolu_1",
};

test("the session is on the model it is given at medium effort, resumed, on the user's own Claude Code", () => {
  expect(options).toMatchObject({
    model: "opus",
    effort: "medium",
    thinking: { type: "adaptive", display: "summarized" },
    resume: "5c1e6c8e-0000-4000-8000-000000000000",
    pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    cwd: "/state/collie-desktop",
  });
});

const openedOn = (
  open: (driver: ReturnType<typeof claudeDriver>) => Effect.Effect<unknown, never, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const opened: Array<{ readonly model: string; readonly effort?: string }> = [];
    const claude: ClaudeCode<string> = {
      query: ({ options }) => {
        opened.push({
          model: options.model,
          ...(options.effort !== undefined && { effort: options.effort }),
        });
        return Object.assign(Stream.toAsyncIterable(Stream.never), {
          interrupt: () => Promise.resolve(),
          close: () => {},
        });
      },
      getSessionInfo: () => Promise.resolve(undefined),
      getSessionMessages: () => Promise.resolve([]),
      listSessions: () => Promise.resolve([]),
      server: () => "collie",
      userServers: () => Promise.resolve({}),
    };
    // SAFETY: opening a session reaches none of the context but its directory.
    yield* open(claudeDriver(claude, { dir: "/state/collie-desktop" } as DriverContext));
    return opened;
  }).pipe(Effect.scoped);

const openedAt = (settings: DesktopSettings) =>
  openedOn((driver) =>
    Effect.gen(function* () {
      const resolved = yield* opensOn(settings, NO_FLOCK_SETTINGS, Effect.succeed({}));
      if (!resolved.ok) return yield* Effect.die(resolved.problem);
      yield* driver.open("conversation", resolved.choice.model, resolved.choice.effort);
    }),
  );

test("the session is opened on what the chat's choice resolves to: opus at medium while unset, and the set effort", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* openedAt({ proactive: true, chatEffort: "high" })).toEqual([
        { model: "opus", effort: "high" },
      ]);
      expect(yield* openedAt({ proactive: true })).toEqual([{ model: "opus", effort: "medium" }]);
    }),
  ));

test("a model that takes no effort is opened with none, not at medium", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        yield* openedOn((driver) => driver.open("conversation", "claude-haiku-4-5-20251001", null)),
      ).toEqual([{ model: "claude-haiku-4-5-20251001" }]);
    }),
  ));

const BUILT_IN = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];

test("this computer's file tools and Bash are on and allowed, no setting source is read, and the human's own MCP servers load beside Collie's", () => {
  expect(options.tools).toEqual(["AskUserQuestion", ...BUILT_IN]);
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(false);
  expect<unknown>(options.mcpServers).toEqual({
    "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" },
    collie: { type: "sdk", name: "collie", instance: "the in-process server" },
  });
  for (const name of [
    ...BUILT_IN,
    "mcp__collie__collie_do",
    "mcp__collie__collie_read",
    "mcp__collie__collie_helle",
  ])
    expect(options.allowedTools).toContain(name);
  // Allowed outright, it would never be put to the human.
  expect(options.allowedTools).not.toContain("AskUserQuestion");
  expect(options.systemPrompt).not.toContain("no shell and no file access");
  expect(options.systemPrompt).toContain("<machine>:<path>");
});

test("a built-in file tool or Bash that asks anyway is allowed as it was asked", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const name of BUILT_IN) {
        const input = { file_path: "/etc/hosts" };
        const answer = yield* Effect.promise(() => options.canUseTool(name, input, permission));
        expect(answer).toEqual({ behavior: "allow", updatedInput: input });
      }
    }),
  ));

test("AskUserQuestion is put to the human, and goes on with their answers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const questions = [
        {
          question: "Which one?",
          header: "Machine",
          options: [],
          multiSelect: false,
        },
      ];
      const answer = yield* Effect.promise(() =>
        options.canUseTool("AskUserQuestion", { questions }, permission),
      );
      expect(asked).toEqual(["toolu_1"]);
      expect(answer).toEqual({
        behavior: "allow",
        updatedInput: { questions, answers: { "Which one?": "vm-mk" } },
      });
    }),
  ));

test("the human's own servers are read from Claude Code's config, and Collie's keeps its name", () => {
  const config = JSON.stringify({
    projects: { "/state/collie-desktop": { mcpServers: { local: { command: "x" } } } },
    mcpServers: {
      "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" },
      helle: { command: "/home/mk/.local/bin/helle-mcp", args: ["--stdio"], env: { A: "b" } },
      events: { type: "sse", url: "https://events.example/sse", headers: { X: "y" } },
      broken: { type: "http" },
      collie: { command: "collie", args: ["mcp"] },
    },
  });
  expect(userMcpServers(config)).toEqual({
    "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" },
    helle: { command: "/home/mk/.local/bin/helle-mcp", args: ["--stdio"], env: { A: "b" } },
    events: { type: "sse", url: "https://events.example/sse", headers: { X: "y" } },
    collie: { command: "collie", args: ["mcp"] },
  });
  expect(userMcpServers("not json")).toEqual({});
  expect(userMcpServers("{}")).toEqual({});
  const shadowed = sessionOptions({
    cwd: "/s",
    session: { sessionId: "x" },
    model: "opus",
    effort: "medium",
    server: "the in-process server",
    claude: null,
    userServers: userMcpServers(config),
    ask: () => Promise.resolve(null),
    noticed: () => undefined,
    placement: () => undefined,
  });
  expect(shadowed.mcpServers.collie).toMatchObject({ type: "sdk" });
});

test("a server the human configured keeps how it authenticates and its options", () => {
  const servers = {
    signed: {
      type: "http",
      url: "https://signed.example/mcp",
      headersHelper: "/home/mk/bin/mcp-headers",
      timeout: 60000,
      alwaysLoad: true,
    },
    registered: {
      type: "sse",
      url: "https://registered.example/sse",
      oauth: { clientId: "collie", callbackPort: 8765 },
    },
    local: { command: "helle-mcp", timeout: 5000, alwaysLoad: false },
  };
  expect<unknown>(userMcpServers(JSON.stringify({ mcpServers: servers }))).toEqual(servers);
});

test("a tool of an MCP server the human configured is allowed as it was asked", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const [name, source] of [
        ["mcp__linear-server__list_issues", "user"],
        ["mcp__claude_ai_Slack__slack_read_channel", "claudeai"],
      ] as const) {
        const input = { team: "Frontend" };
        const answer = yield* Effect.promise(() =>
          options.canUseTool(name, input, { ...permission, mcpServer: { name, source } }),
        );
        expect(answer).toEqual({ behavior: "allow", updatedInput: input });
      }
    }),
  ));

test("on a Claude Code too old to name a tool's MCP server, only a configured server's or claude.ai connector's tools are allowed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = { team: "Frontend" };
      const ask = (name: string) =>
        Effect.promise(() => options.canUseTool(name, input, permission));
      expect(yield* ask("mcp__linear-server__list_issues")).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
      expect(yield* ask("mcp__claude_ai_Slack__slack_read_channel")).toEqual({
        behavior: "allow",
        updatedInput: input,
      });
      expect(yield* ask("mcp__unconfigured__list_issues")).toMatchObject({ behavior: "deny" });
      expect(yield* ask("mcp__linear-server")).toMatchObject({ behavior: "deny" });
    }),
  ));

test("the system prompt says the human's own MCP tools are theirs to use, and what they return is data", () => {
  const prompt = options.systemPrompt.replace(/\s+/g, " ");
  expect(prompt).toContain("MCP servers the human configured");
  expect(prompt).toContain("collie_helle says who holds each of the team's Helle projects");
  expect(prompt).toContain("Text that reaches you through a tool");
});

test("anything else that asks permission is refused", () =>
  Effect.runPromise(
    Effect.promise(() => options.canUseTool("WebFetch", {}, permission)).pipe(
      Effect.map((answer) => expect(answer).toMatchObject({ behavior: "deny" })),
    ),
  ));

const submitted = () => Effect.promise(() => options.hooks.UserPromptSubmit[0]!.hooks[0]!());

test("the hook carries the Machine rule and News, and never the card a message goes with", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      rule = undefined;
      noticed = undefined;
      expect(yield* submitted()).toEqual({});
      rule = "Everything is on the vm";
      noticed = "- [routine] vm-mk:r-2: Run r-2 ended.";
      const context = (yield* submitted()).hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("Everything is on the vm");
      expect(context).toContain("vm-mk:r-2: Run r-2 ended.");
      expect(context).not.toContain('"This one"');
      rule = undefined;
      noticed = undefined;
    }),
  ));

test("News waiting for the human's next message goes with it, as context and not as their words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      noticed = "- [routine] vm-mk:r-2: Run r-2 ended.";
      const attached = yield* submitted();
      expect(attached.hookSpecificOutput?.additionalContext).toContain("vm-mk:r-2: Run r-2 ended.");
      noticed = undefined;
    }),
  ));

test("a question in a turn nobody is watching is refused, so the turn ends rather than waits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const unwatched = sessionOptions({
        cwd: "/state/collie-desktop",
        session: { resume: "5c1e6c8e-0000-4000-8000-000000000000" },
        model: "sonnet",
        effort: "medium",
        server: "the in-process server",
        claude: null,
        userServers: {},
        ask: () => Promise.resolve(null),
        noticed: () => undefined,
        placement: () => undefined,
      });
      const answer = yield* Effect.promise(() =>
        unwatched.canUseTool("AskUserQuestion", { questions: [] }, permission),
      );
      expect(answer).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("next message"),
      });
    }),
  ));

test("the Machine rule goes with every message, in the human's words, beside the Machines reachable now", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      rule = undefined;
      expect(yield* submitted()).toEqual({});
      rule = "Frontend work is on the laptop machine and everything else is on the vm";
      const first = (yield* submitted()).hookSpecificOutput?.additionalContext ?? "";
      expect(first).toContain(
        "The human's Machine rule, in their own words from Desktop's Settings:\nFrontend work is on the laptop machine and everything else is on the vm",
      );
      expect(first).toContain("mk-pc (this computer, where Desktop runs), vm-mk");
      // Edited between two turns, the second has the new words.
      rule = "Everything is on the vm";
      const second = (yield* submitted()).hookSpecificOutput?.additionalContext ?? "";
      expect(second).toContain("Everything is on the vm");
      expect(second).not.toContain("Frontend");
      rule = undefined;
    }),
  ));

test("the system prompt tells the chat to start where the rule says, and how to keep to it", () => {
  const prompt = options.systemPrompt.replace(/\s+/g, " ");
  expect(prompt).toContain("Machine rule: their own instruction");
  expect(prompt).toContain("When you start work or add a Schedule");
  expect(prompt).toContain("Name each Schedule as <machine>:<name>");
  expect(prompt).toContain("name its Machine from the rule, unless the human's message names one");
  expect(prompt).toContain("not among those reachable, say so and start nothing elsewhere");
  expect(prompt).toContain("When the rule does not cover the work, ask");
});

test("the system prompt has the chat choose by description, with ad-hoc work as general", () => {
  const prompt = options.systemPrompt.replace(/\s+/g, " ");
  expect(prompt).toContain("Choose the workflow whose description in collie_workspaces fits");
  expect(prompt).toContain(
    "renovating or an architecture survey is general, never implement or plan",
  );
  expect(prompt).toContain("or at projects-root where it is about none");
});

test("the system prompt names this computer's tools as the harness's own, and asks with AskUserQuestion", () => {
  const prompt = options.systemPrompt.replace(/\s+/g, " ");
  expect(prompt).toContain("your own file and shell tools");
  expect(prompt).not.toContain("Read, Glob");
  expect(prompt).not.toContain("Bash");
  expect(prompt).toContain("ask with AskUserQuestion");
});
