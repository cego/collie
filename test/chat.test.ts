// The Home's native conversation: which harness opens, which session it is, and the two
// things that must never happen — a running chat replaced because a setting changed, and
// a Home reopening into whatever conversation the harness wrote last in this directory.

import { Effect, FileSystem, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  BOARD_RATIO,
  CHAT_HARNESS_KEY,
  chatArgs,
  chatHarnessOf,
  chatPath,
  decideChat,
  DEFAULT_CHAT_HARNESS,
  mcpConfig,
  piExtension,
  preferredHarness,
  readChat,
  started,
  writeLaunchFiles,
  whyUnavailable,
  writeChat,
  type ChatRecord,
} from "../src/chat";
import { writeConfigValue } from "../src/config";
import type { AgentInfo, PaneInfo } from "../src/herdr";
import { TOOLS } from "../src/tools";
import { runEffect } from "./support/effect";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));

const KEY = "herd-abc";
let stateDir: string;

const pane = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  paneId: "1-2",
  tabId: "1",
  label: null,
  agent: "collie-chat-abcd1234",
  workspaceId: "w1",
  cwd: "/ns",
  foregroundCwd: null,
  tokens: {},
  terminalId: "term-2",
  ...over,
});

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  name: "collie-chat-abcd1234",
  paneId: "1-2",
  workspaceId: "w1",
  status: "idle",
  title: null,
  terminalId: "term-2",
  agentSession: null,
  ...over,
});

const record = (over: Partial<ChatRecord> = {}): ChatRecord => ({
  harness: "claude",
  agent: "collie-chat-abcd1234",
  paneId: "1-2",
  terminalId: "term-2",
  sessions: { claude: "abcd1234-0000-4000-8000-000000000000" },
  startedAt: "2026-09-14T10:00:00Z",
  ...over,
});

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-chat-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

test("Claude Code is what opens, whatever the workers are on", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectory({ prefix: "hw-chat-config-" });
      // An existing installation: workers on another harness, and a `scope` from before
      // any of this existed. Neither says anything about which chat opens.
      yield* writeConfigValue(configDir, "harness", "codex");
      yield* writeConfigValue(configDir, "scope", "local");
      expect(yield* chatHarnessOf(configDir)).toBe(DEFAULT_CHAT_HARNESS);
      expect(DEFAULT_CHAT_HARNESS).toBe("claude");

      yield* writeConfigValue(configDir, CHAT_HARNESS_KEY, "pi");
      expect(yield* chatHarnessOf(configDir)).toBe("pi");
      // A value nobody meant still has to open something.
      yield* writeConfigValue(configDir, CHAT_HARNESS_KEY, "nonesuch");
      expect(yield* chatHarnessOf(configDir)).toBe("claude");
      expect(preferredHarness(undefined)).toBe("claude");
    }),
  ));

test("a changed preference is the next launch, never a swap", () => {
  // Claude is running and the human has chosen Pi. The conversation in front of them is
  // not interrupted, replaced or summarised: `next` is a fact about the launch after it.
  expect(decideChat(record(), "1-2", [pane()], [agent()], "pi")).toEqual({
    kind: "adopt",
    record: record(),
    next: "pi",
  });
  // And with the preference unchanged there is nothing pending to say.
  expect(decideChat(record(), "1-2", [pane()], [agent()], "claude")).toMatchObject({
    kind: "adopt",
    next: null,
  });
});

test("a conversation is this Herd's session, not whatever ran here last", () => {
  // Nothing yet: a new conversation, and it says so rather than resuming something.
  expect(decideChat(null, "1-2", [], [], "claude")).toMatchObject({
    kind: "launch",
    harness: "claude",
    resume: null,
  });
  // The process is gone but this Herd's session id is recorded: that one is resumed.
  expect(decideChat(record(), "1-2", [pane()], [], "claude")).toMatchObject({
    kind: "launch",
    resume: "abcd1234-0000-4000-8000-000000000000",
  });
  // Choosing the other harness carries nothing across — no handoff and no summary — and
  // Pi has no session of its own here yet, so it honestly starts a new one.
  expect(decideChat(record(), "1-2", [pane()], [], "pi")).toMatchObject({
    kind: "launch",
    harness: "pi",
    resume: null,
  });
  // Each harness keeps its own history, and coming back finds it.
  const both = record({ sessions: { claude: "c-1", pi: "p-1" } });
  expect(decideChat(both, "1-2", [pane()], [], "pi")).toMatchObject({ resume: "p-1" });
  expect(decideChat(both, "1-2", [pane()], [], "claude")).toMatchObject({ resume: "c-1" });
});

test("a pane that outlived its process is not the conversation that was recorded", () => {
  // herdr still has an agent of that name, but the pane holds a different process: a
  // shell the human started where the chat used to be is not the chat.
  expect(
    decideChat(record(), "1-2", [pane({ terminalId: "term-9" })], [agent()], "claude"),
  ).toMatchObject({ kind: "launch" });
  // A different pane entirely — the Home recovered one — is a launch, not an adoption.
  expect(decideChat(record(), "1-9", [pane({ paneId: "1-9" })], [agent()], "claude")).toMatchObject(
    {
      kind: "launch",
    },
  );
  // And with no chat pane at all there is nothing to launch into. The board is untouched.
  expect(decideChat(record(), null, [], [], "claude")).toEqual({ kind: "no_pane" });
});

test("a launch keeps every harness's session and names the one it started", () => {
  const next = started(record({ sessions: { claude: "c-1" } }), {
    harness: "pi",
    agent: "collie-chat-p",
    paneId: "1-2",
    terminalId: "term-3",
    sessionId: "p-1",
    at: "2026-09-14T11:00:00Z",
  });
  expect(next).toMatchObject({ harness: "pi", sessions: { claude: "c-1", pi: "p-1" } });
});

test("the record survives a round trip through disk", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* chatPath(stateDir, KEY);
      expect(yield* readChat(file)).toBeNull();
      yield* writeChat(file, record());
      expect(yield* readChat(file)).toEqual(record());
    }),
  ));

test("chat keeps native tools and adds Collie's tools", () => {
  const files = {
    systemPrompt: "/p/collie-chat.md",
    mcpConfig: "/d/mcp.json",
    extension: "/d/c.ts",
    settings: "/d/settings.json",
  };
  const claude = chatArgs("claude", "s-1", files, false);
  expect(claude).toEqual([
    "--session-id",
    "s-1",
    "--append-system-prompt-file",
    "/p/collie-chat.md",
    "--mcp-config",
    "/d/mcp.json",
    "--settings",
    "/d/settings.json",
  ]);
  // Reopening one is a different flag: Claude's `--session-id` refuses an id that has
  // been used before, however long ago, and only `--resume` reopens it.
  expect(chatArgs("claude", "s-1", files, true).slice(0, 2)).toEqual(["--resume", "s-1"]);
  // pi's one flag does both, so it is the same either way.
  const pi = chatArgs("pi", "s-2", files, false);
  expect(chatArgs("pi", "s-2", files, true)).toEqual(pi);
  expect(pi).toEqual([
    "--session-id",
    "s-2",
    "--append-system-prompt",
    "/p/collie-chat.md",
    "-e",
    "/d/c.ts",
    "--no-context-files",
  ]);
  // Neither pins a model, an effort level or a spend: native selection stays the
  // human's, and neither rewrites the harness's own configuration.
  for (const args of [claude, pi]) {
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--thinking");
    // And never "the most recent conversation here", which is somebody else's.
    expect(args).not.toContain("--continue");
  }
});

test("both harnesses are wired to the same Collie reads", () => {
  const config = decodeJson(mcpConfig(["/usr/local/bin/collie"], { HERDR_PLUGIN_STATE_DIR: "/s" }));
  expect(config).toMatchObject({
    mcpServers: {
      collie: {
        command: "/usr/local/bin/collie",
        args: ["mcp"],
        env: { HERDR_PLUGIN_STATE_DIR: "/s" },
      },
    },
  });

  const extension = piExtension(
    ["/usr/local/bin/collie"],
    TOOLS.map((tool) => ({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.input,
    })),
    { HERDR_PLUGIN_STATE_DIR: "/s" },
    "/s/herd/abc",
    "news.jsonl",
  );
  // The same tools, reached the way Pi documents: a registered tool, not a shell.
  for (const tool of TOOLS) expect(extension).toContain(tool.name);
  expect(extension).toContain("pi.registerTool");
  expect(extension).toContain('"tools", "call"');
  // Both adapters are told which Collie to read, rather than inheriting whatever the
  // pane happened to have: two answers about two Herds is the failure this prevents.
  expect(extension).toContain('"HERDR_PLUGIN_STATE_DIR":"/s"');
  expect(extension).toContain("...process.env, ...ENV");
  // The directory, not the file: there is nothing to watch before the first event, and
  // trimming the journal replaces the file by rename.
  expect(extension).toContain('const NEWS_DIR = "/s/herd/abc"');
  expect(extension).toContain("watch(NEWS_DIR");
  // A custom message, never `sendUserMessage` — the one that appears as if the human
  // typed it — and never delivered into a turn that is running.
  expect(extension).toContain("pi.sendMessage");
  expect(extension).not.toContain("pi.sendUserMessage");
  expect(extension).toContain('deliverAs: "followUp"');
  // Waits for a running turn, wakes an idle one: that is speaking first without
  // interrupting anything.
  expect(extension).toContain("triggerTurn: true");
  // Nothing synchronous: a `collie` process start on Pi's event loop is Pi's editor
  // stopping for as long as the Herd takes to read.
  expect(extension).not.toContain("spawnSync");
  // The journal itself, not the `news.jsonl.<pid>.tmp` a trim renames over it — which
  // would deliver the same item twice.
  expect(extension).toContain("String(name) === NEWS_FILE");
  expect(config).toMatchObject({
    mcpServers: { collie: { env: { HERDR_PLUGIN_STATE_DIR: "/s" } } },
  });
});

test("a harness that is not there is said out loud, and costs nothing else", () => {
  expect(whyUnavailable("pi", "/usr/bin/pi")).toBeNull();
  const why = whyUnavailable("claude", null);
  expect(why).toContain("not installed");
  // Never a reason to open the other one instead: the human chose this harness.
  expect(why).not.toContain("pi");
  // And never a reason to have no control plane.
  expect(why).toContain("board and existing Runs are unaffected");
});

test("the board keeps four sevenths of the tab", () => {
  expect(BOARD_RATIO).toBeCloseTo(4 / 7, 10);
});

test("both adapters are told about the same Collie, in one place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "hw-chat-launch-" });
      const serverEnv = {
        HERDR_PLUGIN_STATE_DIR: "/state",
        HERDR_PLUGIN_CONFIG_DIR: "/config",
        HERDR_SOCKET_PATH: "/herdr.sock",
        COLLIE_CWD: "/state/herd/abc",
      };
      const files = yield* writeLaunchFiles({
        dir,
        pluginRoot: "/plugin",
        self: ["/bin/collie"],
        serverEnv,
        news: "/state/herd/abc/news.jsonl",
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.input,
        })),
        mcpConfig: mcpConfig(["/bin/collie"], serverEnv),
      });

      // The same environment reaches both. They diverged once — Pi's extension was given
      // only a working directory, so it read whichever Collie the pane happened to have
      // and answered about the human's real Herd inside a disposable one.
      const extension = yield* fs.readFileString(files.extension);
      const config = decodeJson(yield* fs.readFileString(files.mcpConfig));
      // The prompt hook shells back into the same Collie, so the same environment is
      // spelled out on its command line rather than inherited from the pane.
      // SAFETY: the file was written by `claudeSettings` two lines above, whose one shape this names.
      const hook = decodeJson(yield* fs.readFileString(files.settings)) as {
        hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = hook.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
      expect(command).toEndWith("'/bin/collie' chat context");
      for (const [key, value] of Object.entries(serverEnv))
        expect(command).toContain(`${key}='${value}'`);
      for (const [key, value] of Object.entries(serverEnv)) {
        expect(extension).toContain(`"${key}":"${value}"`);
        expect(config).toMatchObject({ mcpServers: { collie: { env: { [key]: value } } } });
      }
      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ));
