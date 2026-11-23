import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Path, Result, Schema, flow } from "effect";
import { CommandLine } from "effect/process";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { everyAgentText } from "./agents";
import { autoCompactWindowAsWritten, readConfig, standingDirectionOn } from "./config";
import { standingDirectionContext } from "./standing-direction";
import { redact } from "./redact";
import { NATIVE, newsPath } from "./news";
import { selfCommand } from "./env";
import type { PluginEnv } from "./env";
import { autoCompactWindowFor, HARNESSES, installedHelp } from "./harness";
import type { Herdr } from "./herdr";
import { reason } from "./naming";
import { isString } from "./schema";
import type { JsonObject } from "./schema";
import type { AutoCompactWindow } from "./settings";
import type { YamlMap } from "./yaml";
import { herdDir, machineHerd } from "./steering";
import { nowIso } from "./time";
import { TOOLS } from "./tools";
import { stringifyJson } from "./json";

// WARNING: shorter than HARNESSES: chat needs a native editor, a resumable session id, and a way to add Collie's tools.
export const CHAT_HARNESSES = ["claude", "pi"] as const;
export type ChatHarness = (typeof CHAT_HARNESSES)[number];

export const DEFAULT_CHAT_HARNESS: ChatHarness = "claude";

export const CHAT_HARNESS_KEY = "chat_harness";

export function isChatHarness(value: string | undefined): value is ChatHarness {
  return Arr.some(CHAT_HARNESSES, (harness) => harness === value);
}

export const CHAT_TERMINAL = "collie-chat";

const RecordSchema = Schema.Struct({
  harness: Schema.Literals(CHAT_HARNESSES),
  agent: Schema.String,
  sessions: Schema.Record(Schema.String, Schema.String),
  startedAt: Schema.String,
});
export type ChatRecord = Schema.Schema.Type<typeof RecordSchema>;
const RecordJson = Schema.fromJsonString(RecordSchema);
const encodeRecord = flow(Schema.encodeResult(RecordJson), Result.getOrThrow);

export const chatPath = Effect.fn("Chat.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "chat.json");
});

export const readChat = Effect.fn("Chat.read")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (Str.trim(raw) === "") {
    return null;
  }
  const decoded = Schema.decodeOption(RecordJson)(raw);
  return decoded._tag === "Some" ? decoded.value : null;
});

export const writeChat = Effect.fn("Chat.write")(function* (file: string, record: ChatRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${encodeRecord(record)}\n`);
  yield* fs.rename(tmp, file);
});

export const chatDir = Effect.fn("Chat.dir")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "chat");
});

export interface LaunchFiles {
  readonly systemPrompt: string;
  readonly mcpConfig: string;
  readonly extension: string;
  readonly settings: string;
}

// WARNING: every flag is this launch only; nothing rewrites ~/.claude or ~/.pi, and nothing pins a spend.
export function chatArgs(
  harness: ChatHarness,
  sessionId: string,
  files: LaunchFiles,
  autoCompactWindow: AutoCompactWindow | null,
) {
  const flag = HARNESSES[harness]?.autoCompactFlag;
  const window =
    flag === undefined || autoCompactWindow === null ? [] : [flag, String(autoCompactWindow)];
  return harness === "claude"
    ? [
        // WARNING: never --continue, which reopens the latest conversation in this directory, possibly someone else's.
        "--session-id",
        sessionId,
        "--append-system-prompt-file",
        files.systemPrompt,
        "--mcp-config",
        files.mcpConfig,
        "--settings",
        files.settings,
        "--model",
        "opus",
        "--effort",
        "medium",
        ...window,
      ]
    : [
        "--session-id",
        sessionId,
        // WARNING: pi reads a path given here as file contents.
        "--append-system-prompt",
        files.systemPrompt,
        "-e",
        files.extension,
        // WARNING: no context files, so the role is the appended prompt, not whatever repository the terminal is in.
        "--no-context-files",
      ];
}

// WARNING: never sendUserMessage, which looks typed by the human; Claude has no push and is told on its next turn.
export function pushable(harness: ChatHarness) {
  return harness === "pi"
    ? {
        attempts: true,
        // WARNING: observed arrival only, never assumed from a flag.
        proven: false,
        how: "Collie's Pi extension hands the batch to Pi's own queue as a custom message, between turns. That the message arrives has not been observed on this installation, so the conversation is still told on its next turn and nothing is marked delivered on the strength of the send.",
      }
    : {
        attempts: false,
        proven: false,
        how: "no push on this installation: Claude's custom channels are an organization opt-in Collie will not consent to on the human's behalf, and the live probe watched an idle pane and saw nothing arrive unasked. News reaches the conversation on its next turn, through collie_news.",
      };
}

// WARNING: reported, not thrown: a chat that will not open must not make the board or Runs unavailable.
export function whyUnavailable(harness: ChatHarness, found: string | null) {
  return found === null
    ? `${harness} is not installed or not on PATH; the board and existing Runs are unaffected`
    : null;
}

export function started(opts: {
  readonly harness: ChatHarness;
  readonly agent: string;
  readonly sessionId: string;
  readonly at: string;
}) {
  return {
    harness: opts.harness,
    agent: opts.agent,
    sessions: { [opts.harness]: opts.sessionId },
    startedAt: opts.at,
  };
}

export function preferredHarness(value: string | undefined) {
  return isChatHarness(value) ? value : DEFAULT_CHAT_HARNESS;
}

// WARNING: independent of the worker harness default; a Herd on Codex still chats in Claude unless told otherwise.
export const chatHarnessOf = Effect.fn("Chat.harnessOf")(function* (userDir: string) {
  const raw = yield* readConfig(userDir);
  const value = raw[CHAT_HARNESS_KEY];
  return preferredHarness(isString(value) ? value : undefined);
});

export const startedNow = Effect.fn("Chat.startedNow")(function* (
  opts: Omit<Parameters<typeof started>[0], "at">,
) {
  return started({ ...opts, at: yield* nowIso });
});

// WARNING: loaded with -e, not installed in ~/.pi, which would change every Pi the human starts.
export function piExtension(
  command: ReadonlyArray<string>,
  tools: ReadonlyArray<PiTool>,
  // WARNING: passed explicitly, never inherited: a pane's env can name another Herd under a probe.
  env: Readonly<Record<string, string>>,
  // WARNING: watch the directory, not the file; the journal is replaced by rename whenever it is trimmed.
  newsDir: string,
  newsFile: string,
  question: (PiTool & { readonly helper: ReadonlyArray<string> }) | null = null,
) {
  return `// Generated by Collie for one chat launch. Do not edit: it is rewritten at launch.
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { promisify } from "node:util";

const COMMAND = ${stringifyJson(command)};
const ENV = ${stringifyJson(env)};
const NEWS_DIR = ${stringifyJson(newsDir)};
const NEWS_FILE = ${stringifyJson(newsFile)};
const TOOLS = ${stringifyJson(tools, 2)};
const QUESTION = ${stringifyJson(question, 2)};
const NO_HOST =
  "No Collie host is running to put your question on your Run. Ask it in your pane instead, and wait for the human's answer there.";

const run = promisify(execFile);
// Never synchronously: a \`collie\` process start on Pi's event loop is Pi's editor
// stopping for as long as the Herd takes to read.
const collie = (args) =>
  run(COMMAND[0], [...COMMAND.slice(1), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...ENV },
  }).catch((cause) => ({ failed: true, stdout: "", stderr: String(cause?.stderr ?? cause) }));

export default function (pi) {
  // What Collie has noticed and nobody has read. Watched, not polled on a timer at a
  // model: a file that has not changed wakes nothing, and an unchanged Herd never writes
  // to it. When it does change, the batch goes in as a **custom message** — never
  // \`sendUserMessage\`, which is the one that appears as if the human typed it — and
  // \`followUp\` so it waits for the agent to finish rather than interrupting a turn or
  // touching a half-typed draft.
  const deliver = async () => {
    const answered = await collie(["chat", "news", "--json"]);
    if (answered.failed) return;
    let batch;
    try {
      batch = JSON.parse(String(answered.stdout ?? "")).data;
    } catch {
      return;
    }
    if (!batch || !batch.text || batch.count === 0) return;
    pi.sendMessage(
      {
        customType: "collie-news",
        content: \`Collie noticed, while you were not asked:\\n\${batch.text}\`,
        display: true,
      },
      // \`followUp\` waits for the agent to finish, so a running turn is never
      // interrupted and a half-typed draft is never touched. \`triggerTurn\` wakes it
      // when it is idle — which is the whole of speaking first: a development nobody
      // asked about has to reach the human without them asking.
      { deliverAs: "followUp", triggerTurn: true },
    );
    // Submitted, and said to be. Whether the conversation read it is what
    // \`collie_news\` settles, and that is a different fact.
    await collie(["chat", "news", "--sent"]);
  };

  // The directory, not the file. There is nothing to watch before the first thing
  // happens, and the journal is trimmed by writing a temporary file and renaming it over
  // the old one — which replaces it, and would leave a file watch attached to something
  // nobody writes to again.
  try {
    watch(NEWS_DIR, { persistent: false }, (_event, name) => {
      // The journal itself, never the \`news.jsonl.<pid>.tmp\` a trim renames over it:
      // one appended item must not be delivered twice.
      if (name === null || name === undefined || String(name) === NEWS_FILE) deliver();
    });
  } catch {
    // No directory yet, or no watch on this platform. The tool read still works.
  }

  for (const spec of TOOLS) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_id, params) {
        const answered = await collie(["tools", "call", spec.name, "--input", JSON.stringify(params ?? {})]);
        // A refusal is something the model can act on; a thrown tool is a dead turn.
        const text = answered.failed
          ? \`Collie could not answer: \${String(answered.stderr ?? "").trim() || "no output"}\`
          : String(answered.stdout ?? "").trimEnd();
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  if (QUESTION !== null) {
    const { helper, ...spec } = QUESTION;
    pi.registerTool({
      ...spec,
      async execute(id, params, _signal, _onUpdate, ctx) {
        // The payload Claude's AskUserQuestion hook gets, so a question takes its one path to the Run.
        const payload = JSON.stringify({
          session_id: ctx?.sessionManager?.getSessionId?.(),
          hook_event_name: "PreToolUse",
          tool_name: "AskUserQuestion",
          tool_use_id: id,
          tool_input: params,
        });
        const printed = await new Promise((resolve) => {
          const child = execFile(helper[0], helper.slice(1), { encoding: "utf8" }, (_error, stdout) =>
            resolve(String(stdout ?? "")),
          );
          child.stdin?.end(payload);
        });
        let text = NO_HOST;
        try {
          text = JSON.parse(printed).hookSpecificOutput.permissionDecisionReason ?? NO_HOST;
        } catch {
          // Nothing printed: no live host took it.
        }
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
`;
}

export function mcpConfig(command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) {
  const [bin, ...rest] = command;
  return `${stringifyJson({ mcpServers: { collie: { command: bin ?? "collie", args: [...rest, "mcp"], env } } }, 2)}\n`;
}

export function claudeSettings(
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) {
  const run = (sub: string) =>
    Arr.join(
      [
        ...Arr.map(
          Rec.toEntries(env),
          ([key, value]) => `${key}=${Result.getOrThrow(CommandLine.quote(value))}`,
        ),
        Result.getOrThrow(CommandLine.join([...command, "chat", sub])),
      ],
      " ",
    );
  const heard = { type: "command", command: run("heard") };
  const hooks = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: run("context") }, heard] }],
    // WARNING: a turn's words end with its Stop, so an unprompted turn carries none.
    Stop: [{ hooks: [heard] }],
  };
  return `${stringifyJson({ hooks }, 2)}\n`;
}

// WARNING: only UserPromptSubmit carries a prompt; other hooks' input has none.
const HookInput = Schema.fromJsonString(
  Schema.Struct({ session_id: Schema.String, prompt: Schema.optionalKey(Schema.String) }),
);

const HeardSchema = Schema.Struct({ session: Schema.String, said: Schema.String });
const HeardJson = Schema.fromJsonString(HeardSchema);

export const HEARD_MAX = 2000;

const heardOf = (prompt: string) => {
  const said = redact(prompt);
  return said.length <= HEARD_MAX ? said : `${pipe(said, Str.slice(0, HEARD_MAX - 1))}…`;
};

const heardPath = Effect.fn("Chat.heardPath")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* chatDir(stateDir, key), "heard.json");
});

export const hear = Effect.fn("Chat.hear")(function* (env: PluginEnv, input: string) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  const given = Schema.decodeOption(HookInput)(input);
  if (key === null || given._tag === "None") {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const file = yield* heardPath(env.stateDir, key);
  if (given.value.prompt === undefined) {
    const kept = Schema.decodeOption(HeardJson)(
      yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")),
    );
    if (kept._tag === "Some" && kept.value.session === given.value.session_id) {
      yield* fs.remove(file, { force: true });
    }
    return;
  }
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(
    tmp,
    yield* Schema.encodeEffect(HeardJson)({
      session: given.value.session_id,
      said: heardOf(given.value.prompt),
    }).pipe(Effect.orDie),
  );
  yield* fs.rename(tmp, file);
});

export const heardVoice = Effect.fn("Chat.heardVoice")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  if (key === null) {
    return {};
  }
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(yield* heardPath(env.stateDir, key))
    .pipe(Effect.orElseSucceed(() => ""));
  const heard = Schema.decodeOption(HeardJson)(raw);
  const running = yield* readChat(yield* chatPath(env.stateDir, key));
  const current = running === null ? undefined : running.sessions[running.harness];
  return heard._tag === "Some" && heard.value.session === current
    ? { conversation: NATIVE, said: heard.value.said }
    : { conversation: NATIVE };
});

export interface PiTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

export const writeLaunchFiles = Effect.fn("Chat.writeLaunchFiles")(function* (opts: {
  readonly dir: string;
  readonly pluginRoot: string;
  readonly userDir: string;
  readonly home: string;
  readonly self: ReadonlyArray<string>;
  readonly serverEnv: Readonly<Record<string, string>>;
  readonly tools: ReadonlyArray<PiTool>;
  readonly news: string;
  readonly mcpConfig: string;
  readonly atLaunch?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(opts.dir, { recursive: true });
  const mcpConfig = path.join(opts.dir, "mcp.json");
  const extension = path.join(opts.dir, "collie.ts");
  const settings = path.join(opts.dir, "settings.json");
  const systemPrompt = path.join(opts.dir, "system-prompt.md");
  const chat = yield* fs
    .readFileString(path.join(opts.pluginRoot, "prompts", "collie-chat.md"))
    .pipe(
      Effect.map(Str.replaceAll("{{prompts}}", path.join(opts.pluginRoot, "prompts"))),
      Effect.orElseSucceed(() => ""),
    );
  const every = yield* everyAgentText({ ...opts, cwd: opts.dir });
  yield* fs.writeFileString(
    systemPrompt,
    `${Arr.join(
      Arr.map(
        Arr.filter(
          [Str.trim(chat), every, opts.atLaunch],
          (part) => part !== null && part !== undefined && part !== "",
        ),
        (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
      ),
      "\n\n",
    )}\n`,
  );
  yield* fs.writeFileString(mcpConfig, opts.mcpConfig);
  yield* fs.writeFileString(settings, claudeSettings(opts.self, opts.serverEnv));
  yield* fs.writeFileString(
    extension,
    piExtension(
      opts.self,
      opts.tools,
      opts.serverEnv,
      path.dirname(opts.news),
      path.basename(opts.news),
    ),
  );
  const returned: LaunchFiles = {
    systemPrompt,
    mcpConfig,
    extension,
    settings,
  };
  return returned;
});

export type Started =
  | { readonly kind: "launched"; readonly record: ChatRecord }
  | { readonly kind: "unavailable"; readonly harness: ChatHarness; readonly why: string };

// WARNING: always a new conversation: a resumed one carries its history and model into every turn; never open the other harness instead.
export const startChat = Effect.fn("Chat.start")(function* (
  herdr: Herdr,
  env: PluginEnv,
  key: string,
  log: (line: string) => Effect.Effect<void, never, never>,
  // WARNING: a probe running from source passes its own entrypoint, since selfCommand would name the probe.
  self: ReadonlyArray<string> = selfCommand(),
  help: typeof installedHelp = installedHelp,
) {
  const harness = yield* chatHarnessOf(env.userDir);
  const unavailable = whyUnavailable(harness, Bun.which(harness, { PATH: Bun.env.PATH ?? "" }));
  if (unavailable !== null) {
    yield* log(`chat: ${unavailable}`);
    const returned: Started = { kind: "unavailable", harness, why: unavailable };
    return returned;
  }

  const adapter = HARNESSES[harness];
  const window =
    adapter === undefined
      ? { passed: null, leftOff: null }
      : yield* autoCompactWindowFor(
          adapter,
          autoCompactWindowAsWritten(
            (yield* readConfig(env.userDir).pipe(
              Effect.orElseSucceed(() => {
                const none: YamlMap = {};
                return none;
              }),
            )).claude_auto_compact_window,
          ),
          help,
        );
  if ("refused" in window) {
    const why = `${window.refused} in ${env.userDir}/config.json`;
    yield* log(`chat: ${why}`);
    const returned: Started = { kind: "unavailable", harness, why };
    return returned;
  }
  if (window.leftOff !== null) {
    yield* log(`chat: started without an auto-compact window: ${window.leftOff}`);
  }

  const cwd = yield* herdDir(env.stateDir, key);
  // WARNING: one object for both adapters; different answers mean two conversations about different Herds. Empty values read as unset.
  const serverEnv = {
    COLLIE_STATE_DIR: env.stateDir,
    COLLIE_USER_DIR: env.userDir,
    COLLIE_CWD: cwd,
  };

  const files = yield* writeLaunchFiles({
    dir: yield* chatDir(env.stateDir, key),
    pluginRoot: env.pluginRoot,
    userDir: env.userDir,
    home: env.home,
    self,
    serverEnv,
    tools: Arr.map(TOOLS, (tool) => ({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.input,
    })),
    news: yield* newsPath(env.stateDir, key),
    mcpConfig: mcpConfig(self, serverEnv),
    atLaunch:
      harness === "pi"
        ? standingDirectionContext(
            yield* standingDirectionOn(env.userDir).pipe(Effect.orElseSucceed(() => undefined)),
          )
        : undefined,
  });

  const sessionId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const failed = yield* herdr
    .agentLaunch({
      name: CHAT_TERMINAL,
      argv: [adapter?.kind ?? harness, ...chatArgs(harness, sessionId, files, window.passed)],
      cwd,
      env: serverEnv,
      labels: {},
    })
    .pipe(
      Effect.as(null),
      Effect.catch((cause) => Effect.succeed(reason(cause))),
    );
  if (failed !== null) {
    const why = `core would not start ${harness} as ${CHAT_TERMINAL}: ${failed}`;
    yield* log(`chat: ${why}`);
    const returned: Started = { kind: "unavailable", harness, why };
    return returned;
  }
  const record = yield* startedNow({ harness, agent: CHAT_TERMINAL, sessionId });
  yield* writeChat(yield* chatPath(env.stateDir, key), record);
  yield* log(`chat: started ${harness}; a new conversation`);
  const returned: Started = { kind: "launched", record };
  return returned;
});
