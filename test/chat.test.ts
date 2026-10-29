// The Home's native conversation: which harness opens, which session it is, and the two
// things that must never happen — a running chat replaced because a setting changed, and
// a Home reopening into whatever conversation the harness wrote last in this directory.

import { Effect, FileSystem, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  CHAT_HARNESS_KEY,
  chatArgs,
  chatHarnessOf,
  chatPath,
  decideChat,
  DEFAULT_CHAT_HARNESS,
  ensureChatFor,
  mcpConfig,
  piExtension,
  preferredHarness,
  readChat,
  writeLaunchFiles,
  whyUnavailable,
  writeChat,
  type ChatRecord,
} from "../src/chat";
import { writeConfigValue } from "../src/config";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { FakeBin } from "./support/bin";
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
  agentSession: null,
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
      const userDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-chat-config-" });
      // An existing installation: workers on another harness, and a `scope` from before
      // any of this existed. Neither says anything about which chat opens.
      yield* writeConfigValue(userDir, "harness", "codex");
      yield* writeConfigValue(userDir, "scope", "local");
      expect(yield* chatHarnessOf(userDir)).toBe(DEFAULT_CHAT_HARNESS);

      yield* writeConfigValue(userDir, CHAT_HARNESS_KEY, "pi");
      expect(yield* chatHarnessOf(userDir)).toBe("pi");
      // A value nobody meant still has to open something.
      yield* writeConfigValue(userDir, CHAT_HARNESS_KEY, "nonesuch");
      expect(yield* chatHarnessOf(userDir)).toBe("claude");
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

test("a chat that has to be launched starts a new conversation, whatever was recorded", () => {
  // Resumed, it would carry its whole history into every turn, and the model it began on.
  expect(decideChat(record(), "1-2", [pane()], [], "claude")).toEqual({
    kind: "launch",
    harness: "claude",
    why: `herdr no longer has ${record().agent}`,
  });
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
  const claude = chatArgs("claude", "s-1", files, 400000);
  expect(claude).toEqual([
    "--session-id",
    "s-1",
    "--append-system-prompt-file",
    "/p/collie-chat.md",
    "--mcp-config",
    "/d/mcp.json",
    "--settings",
    "/d/settings.json",
    "--model",
    "opus",
    "--effort",
    "medium",
    "--autocompact",
    "400000",
  ]);
  expect(chatArgs("claude", "s-1", files, "auto").slice(-2)).toEqual(["--autocompact", "auto"]);
  expect(chatArgs("claude", "s-1", files, null)).not.toContain("--autocompact");
  const pi = chatArgs("pi", "s-2", files, 400000);
  expect(pi).toEqual([
    "--session-id",
    "s-2",
    "--append-system-prompt",
    "/p/collie-chat.md",
    "-e",
    "/d/c.ts",
    "--no-context-files",
  ]);
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

test("both adapters are told about the same Collie, in one place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-chat-launch-" });
      const serverEnv = {
        HERDR_PLUGIN_STATE_DIR: "/state",
        COLLIE_USER_DIR: "/config",
        HERDR_SOCKET_PATH: "/herdr.sock",
        COLLIE_CWD: "/state/herd/abc",
      };
      const files = yield* writeLaunchFiles({
        dir,
        pluginRoot: "/plugin",
        userDir: dir,
        home: dir,
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
        hooks: {
          UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
          Stop: Array<{ hooks: Array<{ command: string }> }>;
        };
      };
      const command = hook.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
      expect(command).toEndWith("/bin/collie chat context");
      // And every prompt is handed to the tool host until the turn ends, so a chat's
      // actions carry the words of the turn they were taken in.
      const heard = hook.hooks.UserPromptSubmit[0]!.hooks[1]!.command;
      expect(heard).toEndWith("/bin/collie chat heard");
      expect(hook.hooks.Stop[0]!.hooks[0]!.command).toBe(heard);
      for (const [key, value] of Object.entries(serverEnv))
        expect(heard).toContain(`${key}=${value}`);
      for (const [key, value] of Object.entries(serverEnv))
        expect(command).toContain(`${key}=${value}`);
      for (const [key, value] of Object.entries(serverEnv)) {
        expect(extension).toContain(`"${key}":"${value}"`);
        expect(config).toMatchObject({ mcpServers: { collie: { env: { [key]: value } } } });
      }
    }),
  ));

test.each([
  { user: true, rule: "The user's rule." },
  { user: false, rule: "The installation's rule." },
])(
  "the chat's system prompt is collie-chat.md then the every-agent text (user Layer: $user)",
  ({ user, rule }) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "hw-chat-prompt-" });
        const write = (file: string, text: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
            yield* fs.writeFileString(file, text);
          });
        yield* write(`${root}/plugin/prompts/collie-chat.md`, "You are Collie's chat.\n");
        yield* write(`${root}/plugin/personas/every-agent.md`, "The installation's rule.\n");
        if (user) yield* write(`${root}/user/personas/every-agent.md`, "The user's rule.\n");
        const files = yield* writeLaunchFiles({
          dir: `${root}/chat`,
          pluginRoot: `${root}/plugin`,
          userDir: `${root}/user`,
          home: `${root}/home`,
          self: ["/bin/collie"],
          serverEnv: {},
          news: `${root}/news.jsonl`,
          tools: [],
          mcpConfig: "{}",
        });

        expect(yield* fs.readFileString(files.systemPrompt)).toBe(
          `You are Collie's chat.\n\n${rule}\n`,
        );
      }).pipe(Effect.scoped),
    ),
);

test("the system prompt chat writes takes a reported review as a report, asks before moving a Run's scope, and reads what Runs replied", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hw-chat-scope-" });
      const files = yield* writeLaunchFiles({
        dir: `${root}/chat`,
        pluginRoot: `${import.meta.dir}/..`,
        userDir: `${root}/user`,
        home: `${root}/home`,
        self: ["/bin/collie"],
        serverEnv: {},
        news: `${root}/news.jsonl`,
        tools: [],
        mcpConfig: "{}",
      });
      const prompt = (yield* fs.readFileString(files.systemPrompt)).replace(/\s+/g, " ");
      expect(prompt).toContain(
        `A human reporting a review, such as "I got review on the MR", is telling you what happened, not asking you to change what a Run does.`,
      );
      expect(prompt).toContain(
        "Before you start or change work that moves a Run's scope, to another repository, a shared package or something its spec puts out of scope, ask the human.",
      );
      expect(prompt).toContain(
        `When you read a merge request's review, read the replies on it too, and tell the human what a Collie Run replied there in their name: its reply ends "Posted by Collie's Run <run> on <machine>."`,
      );
    }).pipe(Effect.scoped),
  ));

test("the shipped prompt has chat choose by description, with ad-hoc work as general", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const prompt = (yield* fs.readFileString(
        `${import.meta.dir}/../prompts/collie-chat.md`,
      )).replace(/\s+/g, " ");
      expect(prompt).toContain("Choose the workflow whose description fits the request");
      expect(prompt).toContain(
        "renovating or an architecture survey is `general`, never `implement` or `plan`",
      );
      expect(prompt).toContain("or at `projects-root` where it is about none");
    }),
  ));

/** A Home's chat launched on Claude Code, against a fake herdr and a stand-in `claude`. */
const launchedChat = (opts: { readonly config?: string; readonly help?: string }) =>
  Effect.gen(function* () {
    const rig = yield* Rig.scoped();
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* Effect.addFinalizer(() => bin.restore());
    yield* bin.add("claude", "exit 0");
    const fs = yield* FileSystem.FileSystem;
    if (opts.config !== undefined)
      yield* fs.writeFileString(`${rig.pluginEnv().userDir}/config.json`, opts.config);
    const lines: string[] = [];
    const ensured = yield* ensureChatFor(
      new FakeHerdr(rig.pluginEnv()),
      rig.pluginEnv(),
      KEY,
      { chatPaneId: "1-2" },
      "claude",
      (line) => Effect.sync(() => lines.push(line)),
      ["/bin/collie"],
      () => Effect.succeed(opts.help ?? "  --autocompact <auto|tokens>"),
    );
    const started = (yield* rig.calls()).find((call: Call) => call.cmd === "agent start");
    const argv = started?.argv ?? [];
    return {
      ensured,
      lines,
      started: started !== undefined,
      args: argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [],
    };
  }).pipe(Effect.scoped);

test("the Home's chat on Claude Code starts with a 400000 auto-compact window when none is set", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* launchedChat({});
      expect(chat.ensured.kind).toBe("launched");
      expect(chat.args.slice(-2)).toEqual(["--autocompact", "400000"]);
    }),
  ));

test("the Home's chat takes the window written to the config at its launch", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* launchedChat({ config: `{ "claude_auto_compact_window": 500000 }` });
      expect(chat.args.slice(-2)).toEqual(["--autocompact", "500000"]);
    }),
  ));

test("a claude whose help does not list --autocompact opens the chat without it, and says why", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* launchedChat({ help: "  --model <model>" });
      expect(chat.ensured.kind).toBe("launched");
      expect(chat.args).not.toContain("--autocompact");
      expect(chat.lines).toContainEqual(
        "chat: started without an auto-compact window: claude --help does not list --autocompact",
      );
    }),
  ));

test("a window Claude Code would not take leaves the chat unavailable, naming it, and starts nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* launchedChat({ config: `{ "claude_auto_compact_window": 50000 }` });
      expect(chat.ensured.kind).toBe("unavailable");
      const why = chat.ensured.kind === "unavailable" ? chat.ensured.why : "";
      expect(why).toContain("claude_auto_compact_window");
      expect(why).toContain("50000");
      expect(chat.started).toBe(false);
    }),
  ));
