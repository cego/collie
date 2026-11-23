import { Herdr } from "../src/herdr";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  CHAT_HARNESS_KEY,
  chatArgs,
  chatDir,
  chatHarnessOf,
  chatPath,
  DEFAULT_CHAT_HARNESS,
  mcpConfig,
  piExtension,
  preferredHarness,
  readChat,
  startChat,
  writeLaunchFiles,
  whyUnavailable,
  writeChat,
  type ChatRecord,
} from "../src/chat";
import { setSetting, writeConfigValue } from "../src/config";
import { chatContextFor } from "../src/statusline";
import { selectionPath, writeSelection } from "../src/selection";
import { machineHerd } from "../src/steering";
import { Rig, type Call } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { TOOLS } from "../src/tools";
import { runEffect } from "./support/effect";

const decodeJson = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Any)),
  Result.getOrThrow,
);

const KEY = "herd-abc";
let stateDir: string;

const record: (over?: Partial<ChatRecord>) => ChatRecord = (over = {}) => ({
  harness: "claude",
  agent: "collie-chat",
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
      yield* writeConfigValue(userDir, "harness", "codex");
      yield* writeConfigValue(userDir, "scope", "local");
      expect(yield* chatHarnessOf(userDir)).toBe(DEFAULT_CHAT_HARNESS);

      yield* writeConfigValue(userDir, CHAT_HARNESS_KEY, "pi");
      expect(yield* chatHarnessOf(userDir)).toBe("pi");
      yield* writeConfigValue(userDir, CHAT_HARNESS_KEY, "nonesuch");
      expect(yield* chatHarnessOf(userDir)).toBe("claude");
      expect(preferredHarness(undefined)).toBe("claude");
    }),
  ));

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
  const claude = chatArgs("claude", "s-1", files, 400_000);
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
  const pi = chatArgs("pi", "s-2", files, 400_000);
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
  const config = decodeJson(mcpConfig(["/usr/local/bin/collie"], { COLLIE_STATE_DIR: "/s" }));
  expect(config).toMatchObject({
    mcpServers: {
      collie: {
        command: "/usr/local/bin/collie",
        args: ["mcp"],
        env: { COLLIE_STATE_DIR: "/s" },
      },
    },
  });

  const extension = piExtension(
    ["/usr/local/bin/collie"],
    Arr.map(TOOLS, (tool) => ({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.input,
    })),
    { COLLIE_STATE_DIR: "/s" },
    "/s/herd/abc",
    "news.jsonl",
  );
  for (const tool of TOOLS) expect(extension).toContain(tool.name);
  expect(extension).toContain("pi.registerTool");
  expect(extension).toContain('"tools", "call"');
  // WARNING: Both adapters read the same Collie; two answers about two Herds is the failure this prevents.
  expect(extension).toContain('"COLLIE_STATE_DIR":"/s"');
  expect(extension).toContain("...process.env, ...ENV");
  // WARNING: Watch the directory, not the file: trims replace the journal by rename.
  expect(extension).toContain('const NEWS_DIR = "/s/herd/abc"');
  expect(extension).toContain("watch(NEWS_DIR");
  // WARNING: Custom message, never sendUserMessage (it looks typed by the human) and never into a running turn.
  expect(extension).toContain("pi.sendMessage");
  expect(extension).not.toContain("pi.sendUserMessage");
  expect(extension).toContain('deliverAs: "followUp"');
  expect(extension).toContain("triggerTurn: true");
  // WARNING: No spawnSync: a blocking call stalls Pi's event loop and editor.
  expect(extension).not.toContain("spawnSync");
  // WARNING: Match the journal itself, not the tmp file a trim renames over it, or the same item is delivered twice.
  expect(extension).toContain("String(name) === NEWS_FILE");
  expect(config).toMatchObject({
    mcpServers: { collie: { env: { COLLIE_STATE_DIR: "/s" } } },
  });
});

test("a harness that is not there is said out loud, and costs nothing else", () => {
  expect(whyUnavailable("pi", "/usr/bin/pi")).toBeNull();
  const why = whyUnavailable("claude", null);
  expect(why).toContain("not installed");
  expect(why).not.toContain("pi");
  expect(why).toContain("board and existing Runs are unaffected");
});

test("both adapters are told about the same Collie, in one place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-chat-launch-" });
      const serverEnv = {
        COLLIE_STATE_DIR: "/state",
        COLLIE_USER_DIR: "/config",
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
        tools: Arr.map(TOOLS, (tool) => ({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.input,
        })),
        mcpConfig: mcpConfig(["/bin/collie"], serverEnv),
      });

      // WARNING: Same environment reaches both adapters; once Pi's extension read a different Collie.
      const extension = yield* fs.readFileString(files.extension);
      const config = decodeJson(yield* fs.readFileString(files.mcpConfig));
      // WARNING: the file was written by `claudeSettings` two lines above, whose one shape this names.
      // WARNING: the hook was written by claudeSettings above, whose one shape this names.
      const hook = decodeJson(yield* fs.readFileString(files.settings)) as {
        hooks: {
          UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
          Stop: Array<{ hooks: Array<{ command: string }> }>;
        };
      };
      const command = hook.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
      expect(command).toEndWith("/bin/collie chat context");
      const heard = hook.hooks.UserPromptSubmit[0]!.hooks[1]!.command;
      expect(heard).toEndWith("/bin/collie chat heard");
      expect(hook.hooks.Stop[0]!.hooks[0]!.command).toBe(heard);
      for (const [key, value] of Rec.toEntries(serverEnv))
        expect(heard).toContain(`${key}=${value}`);
      for (const [key, value] of Rec.toEntries(serverEnv))
        expect(command).toContain(`${key}=${value}`);
      for (const [key, value] of Rec.toEntries(serverEnv)) {
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
            yield* fs.makeDirectory(
              pipe_(
                file,
                Str.slice(
                  0,
                  Option.getOrElse(pipe_(file, Str.lastIndexOf("/")), () => -1),
                ),
              ),
              { recursive: true },
            );
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
      const prompt = pipe_(
        yield* fs.readFileString(files.systemPrompt),
        Str.replaceAll(/\s+/g, " "),
      );
      expect(prompt).toContain(
        `A human reporting a review, such as "I got review on the MR", is telling you what happened, not asking you to change what a Run does.`,
      );
      expect(prompt).toContain(
        "Before you start or change work that moves a Run's scope, to another repository, a shared package or something its spec puts out of scope, ask the human.",
      );
      expect(prompt).toContain(
        "When you read a merge request's review, read the replies on it too, and tell the human what a Collie Run replied there in their name: its reply's raw text ends with the hidden marker `<!-- collie:<run> -->`, which the forge's page does not show.",
      );
    }).pipe(Effect.scoped),
  ));

test("the system prompt points chat at the setup procedure Desktop's Flock chat follows, by a path that reads", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hw-chat-setup-" });
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
      const named = /`([^`\s]+standing-direction-setup\.md)`/.exec(
        yield* fs.readFileString(files.systemPrompt),
      )?.[1];
      expect(named).toBeDefined();
      expect(yield* fs.readFileString(named!)).toContain(
        "When work is ready, which next steps should Collie offer you without being asked",
      );
    }).pipe(Effect.scoped),
  ));

test("the shipped prompt has chat choose by description, with ad-hoc work as general", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const prompt = pipe_(
        yield* fs.readFileString(`${import.meta.dir}/../prompts/collie-chat.md`),
        Str.replaceAll(/\s+/g, " "),
      );
      expect(prompt).toContain("Choose the workflow whose description fits the request");
      expect(prompt).toContain(
        "renovating or an architecture survey is `general`, never `implement` or `plan`",
      );
      expect(prompt).toContain("or at `projects-root` where it is about none");
    }),
  ));

const launchedChat = (opts: {
  readonly config?: string;
  readonly settingsSet?: string;
  readonly harness?: "claude" | "pi";
  readonly help?: string;
  readonly recorded?: ChatRecord;
}) =>
  Effect.gen(function* () {
    const rig = yield* Rig.scoped();
    yield* rig.startCore();
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* Effect.addFinalizer(() => bin.restore());
    yield* bin.add(opts.harness ?? "claude", "exit 0");
    const fs = yield* FileSystem.FileSystem;
    const env = rig.pluginEnv();
    if (opts.config !== undefined)
      yield* fs.writeFileString(`${env.userDir}/config.json`, opts.config);
    if (opts.settingsSet !== undefined)
      yield* fs.writeFileString(`${env.userDir}/settings-set.json`, opts.settingsSet);
    if (opts.recorded !== undefined)
      yield* writeChat(yield* chatPath(env.stateDir, KEY), opts.recorded);
    const lines: Array<string> = [];
    const ensured = yield* startChat(
      new Herdr(env),
      env,
      KEY,
      (line) => Effect.sync(() => lines.push(line)),
      ["/bin/collie"],
      () => Effect.succeed(opts.help ?? "  --autocompact <auto|tokens>"),
    );
    const started = Option.getOrUndefined(
      Arr.findFirst(yield* rig.calls(), (call: Call) => call.cmd === "terminal.run"),
    );
    const argv = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
      started?.params?.argv ?? [],
    );
    return {
      ensured,
      lines,
      started: started !== undefined,
      name: started?.params?.name,
      args: argv.slice(1),
      recorded: yield* readChat(yield* chatPath(env.stateDir, KEY)),
      systemPrompt: yield* fs
        .readFileString(`${yield* chatDir(env.stateDir, KEY)}/system-prompt.md`)
        .pipe(Effect.orElseSucceed(() => "")),
      mcpConfig: yield* fs
        .readFileString(`${yield* chatDir(env.stateDir, KEY)}/mcp.json`)
        .pipe(Effect.orElseSucceed(() => "")),
    };
  }).pipe(Effect.scoped);

test.each(["all", "role"])(
  "the Home chat is offered every Collie tool under role_tools: %s",
  (value) =>
    runEffect(
      Effect.gen(function* () {
        const chat = yield* launchedChat({
          config: `{ "role_tools": "${value}" }`,
        });
        expect(chat.ensured.kind).toBe("launched");
        const config = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              mcpServers: Schema.Struct({
                collie: Schema.Struct({
                  env: Schema.Record(Schema.String, Schema.String),
                }),
              }),
            }),
          ),
        )(chat.mcpConfig);
        expect(config.mcpServers.collie.env.COLLIE_CWD).toBeDefined();
        expect(config.mcpServers.collie.env.COLLIE_TOOLS_ROLE).toBeUndefined();
      }),
    ),
);

test("chat on Claude Code starts as collie-chat with a 400000 auto-compact window when none is set", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* launchedChat({});
      expect(chat.ensured.kind).toBe("launched");
      expect(chat.name).toBe("collie-chat");
      expect(chat.args.slice(-2)).toEqual(["--autocompact", "400000"]);
    }),
  ));

test("a chat started again starts a new conversation, whatever was recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* launchedChat({ recorded: record() });
      const session = chat.args[chat.args.indexOf("--session-id") + 1];
      expect(session).toBeDefined();
      expect(session).not.toBe(record().sessions.claude);
      expect(chat.args).not.toContain("--resume");
      expect(chat.recorded?.sessions.claude).toBe(session);
    }),
  ));

test("chat takes the window written to the config at its launch", () =>
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

test("a Native chat's prompt context gives the Standing direction, dated, before the board's selection", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const env = rig.pluginEnv();
      yield* writeSelection(yield* selectionPath(env.stateDir, yield* machineHerd(env)), {
        task: "t1",
        run: "r1",
        name: "Strapi prod seeder",
      });
      const selected =
        'Board: "Strapi prod seeder" is open (run r1). "It", "this one" and the like mean this card; a Herd-wide question is still Herd-wide.';
      expect(yield* chatContextFor(env)).toBe(selected);

      yield* setSetting(
        env.userDir,
        "standing_direction",
        "Stage only; production waits for my go.",
        "2026-10-02T09:30:00.000Z",
      );
      const context = yield* chatContextFor(env);
      expect(context).toContain("Stage only; production waits for my go.");
      expect(context).toContain("2026-10-02");
      expect(context).toEndWith(`\n\n${selected}`);

      yield* setSetting(
        env.userDir,
        "standing_direction",
        "Ask before renovating.",
        "2026-10-03T08:00:00.000Z",
      );
      const edited = yield* chatContextFor(env);
      expect(edited).toContain("Ask before renovating.");
      expect(edited).toContain("2026-10-03");
      expect(edited).not.toContain("Stage only");

      yield* setSetting(env.userDir, "standing_direction", "", "2026-10-04T08:00:00.000Z");
      expect(yield* chatContextFor(env)).toBe(selected);
    }).pipe(Effect.scoped),
  ));

test("a Pi Native chat's launch prompt carries the Standing direction as it stands at launch, and Claude's does not", () =>
  runEffect(
    Effect.gen(function* () {
      const promptOf = (harness: "claude" | "pi", config: string) =>
        Effect.map(
          launchedChat({ harness, config, settingsSet: STAMPED }),
          ({ ensured, systemPrompt }) => {
            expect(ensured.kind).toBe("launched");
            return systemPrompt;
          },
        );
      const STAMPED = `{ "set": { "standing_direction": "2026-10-02T09:30:00.000Z" } }`;
      const set = (harness: string) =>
        `{ "chat_harness": "${harness}", "standing_direction": "Stage only; production waits for my go." }`;
      const pi = yield* promptOf("pi", set("pi"));
      expect(pi).toContain("Stage only; production waits for my go.");
      expect(pi).toContain("2026-10-02");
      expect(yield* promptOf("claude", set("claude"))).not.toContain("Stage only");
      expect(yield* promptOf("pi", `{ "chat_harness": "pi" }`)).not.toContain("standing direction");
    }),
  ));
