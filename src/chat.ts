// Native chat in the Herd's Home: which harness Collie opens with, which native session
// that conversation is, and when the pane beside the board is launched into rather than
// adopted.
//
// Collie does not own the conversation. The harness owns the editor, the streaming, the
// history and the compaction; Collie owns which harness, which session, and what the
// model is allowed to reach. That division is the whole point of this file: everything
// here is about *identity and reach*, and nothing about what was said.
//
// Two rules the rest of it falls out of. A changed preference is a **next launch**, never
// a swap: a human who picks Pi while Claude is mid-answer keeps that answer, and Pi is
// what opens next time there is a launch to do. And a conversation is bound to the Herd,
// the harness and a session id Collie mints — never to whichever session the harness
// happened to write last in this directory, which is how a Home reopens into somebody
// else's conversation.

import { Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { readConfig } from "./config";
import { redact } from "./conversation";
import { NATIVE, newsPath } from "./news";
import { selfCommand, type PluginEnv } from "./env";
import { HARNESSES } from "./harness";
import type { AgentInfo, Herdr, PaneInfo } from "./herdr";
import { ensureLockDir, withLock } from "./lock";
import { reason, shellQuote } from "./naming";
import { isString, type JsonObject } from "./schema";
import { herdDir, herdOf } from "./steering";
import { nowIso } from "./time";
import { TOOLS } from "./tools";

/**
 * The harnesses a human may hold this conversation in. Deliberately shorter than
 * `HARNESSES`: chat needs a native editor, a resumable session named by id, and a
 * documented way to add Collie's tools to its native environment. Workers' harnesses are
 * unaffected by anything here.
 */
export const CHAT_HARNESSES = ["claude", "pi"] as const;
export type ChatHarness = (typeof CHAT_HARNESSES)[number];

/** What opens when nobody has chosen, on a new installation and an old one alike. */
export const DEFAULT_CHAT_HARNESS: ChatHarness = "claude";

/** Where the preference is kept. Read with the same fallback everywhere. */
export const CHAT_HARNESS_KEY = "chat_harness";

export function isChatHarness(value: string | undefined): value is ChatHarness {
  return CHAT_HARNESSES.some((harness) => harness === value);
}

/** What the Home's chat pane is marked with, so recovery can tell it from the board. */
export const CHAT_PANE_TOKEN = "collie_chat";

/**
 * What the board keeps when the tab is split: four sevenths, with the remaining three
 * for chat. herdr's ratio is the share the pane being split keeps.
 */
export const BOARD_RATIO = 4 / 7;

/**
 * What this Herd's chat agent is called in herdr. Suffixed per launch: herdr keeps a
 * name until the process using it has gone, and a relaunch that raced that refusal would
 * leave the Home with a chat pane and nothing in it.
 */
export const CHAT_AGENT_PREFIX = "collie-chat";

const RecordSchema = Schema.Struct({
  /** The harness actually running, which is not necessarily the one now preferred. */
  harness: Schema.Literals(CHAT_HARNESSES),
  agent: Schema.String,
  paneId: Schema.String,
  terminalId: Schema.NullOr(Schema.String),
  /** The native session id the running chat was started with, under its harness. */
  sessions: Schema.Record(Schema.String, Schema.String),
  startedAt: Schema.String,
});
export type ChatRecord = Schema.Schema.Type<typeof RecordSchema>;
const RecordJson = Schema.fromJsonString(RecordSchema);
const encodeRecord = Schema.encodeSync(RecordJson);

export const chatPath = Effect.fn("Chat.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "chat.json");
});

export const readChat = Effect.fn("Chat.read")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  if (raw.trim() === "") return null;
  const decoded = Schema.decodeUnknownOption(RecordJson)(raw);
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

export type ChatDecision =
  /**
   * A conversation is live in the Home's chat pane. `next` names a harness the human has
   * since chosen, which is what the next launch will use and what the board says is
   * pending — it is never a reason to interrupt what is running.
   */
  | { readonly kind: "adopt"; readonly record: ChatRecord; readonly next: ChatHarness | null }
  /**
   * Start one, on a new conversation: a resumed one would carry its whole history into
   * every turn, and the model it began on (ADR-0032).
   */
  | { readonly kind: "launch"; readonly harness: ChatHarness; readonly why: string }
  /** The Home has no chat pane to launch into; the board is still usable. */
  | { readonly kind: "no_pane" };

/**
 * Whether the recorded conversation is still the one in the Home's chat pane.
 *
 * Three independent facts have to agree: the Home's pane is the pane the record names,
 * herdr still has the agent, and the process in that pane is the process the record was
 * written about. A pane outlives what ran in it, so `terminalId` is what stops a dead
 * chat's record adopting a shell a human started in the same place.
 */
export function decideChat(
  record: ChatRecord | null,
  chatPaneId: string | null,
  panes: ReadonlyArray<PaneInfo>,
  agents: ReadonlyArray<AgentInfo>,
  preferred: ChatHarness,
): ChatDecision {
  if (chatPaneId === null) return { kind: "no_pane" };
  const launch = (why: string): ChatDecision => ({ kind: "launch", harness: preferred, why });
  if (record === null) return launch("no chat has been started for this Herd");
  if (record.paneId !== chatPaneId) return launch("the Home's chat pane is a different pane");
  const agent = agents.find((entry) => entry.name === record.agent);
  if (agent === undefined) return launch(`herdr no longer has ${record.agent}`);
  const pane = panes.find((entry) => entry.paneId === chatPaneId);
  if (record.terminalId !== null && pane?.terminalId !== record.terminalId)
    return launch("a different process is in the Home's chat pane");
  return { kind: "adopt", record, next: preferred === record.harness ? null : preferred };
}

/** Where a launch's generated tool wiring is written. One directory per Herd, rewritten each launch. */
export const chatDir = Effect.fn("Chat.dir")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "chat");
});

export interface LaunchFiles {
  /** The Collie role, appended to the harness's own system prompt. Never installed as config. */
  readonly systemPrompt: string;
  /** Claude's MCP server list, for `--mcp-config`. */
  readonly mcpConfig: string;
  /** Pi's extension, for `-e`. */
  readonly extension: string;
  /** Claude's additional settings, for `--settings`: the hook that attaches the selection. */
  readonly settings: string;
}

/**
 * What `herdr agent start ... -- <args>` is given.
 *
 * Every flag is this launch only. Nothing here rewrites `~/.claude` or `~/.pi`, and
 * nothing pins a spend: native authentication is the human's, and a chat that silently
 * overrode it would be a different product wearing the harness's name. Claude runs on the
 * latest Opus at medium effort (ADR-0032).
 *
 * Both harnesses keep their native tools and configuration alongside Collie's tools.
 */
export function chatArgs(
  harness: ChatHarness,
  sessionId: string,
  files: LaunchFiles,
): ReadonlyArray<string> {
  return harness === "claude"
    ? [
        // Never `--continue`: "the most recent conversation in this directory" is how a
        // Home reopens into somebody else's.
        "--session-id",
        sessionId,
        "--append-system-prompt-file",
        files.systemPrompt,
        "--mcp-config",
        files.mcpConfig,
        // Additional settings, never a rewrite of the human's own.
        "--settings",
        files.settings,
        "--model",
        "opus",
        "--effort",
        "medium",
      ]
    : [
        "--session-id",
        sessionId,
        // pi reads a path here as file contents.
        "--append-system-prompt",
        files.systemPrompt,
        "-e",
        files.extension,
        // The role is the appended prompt above, not whatever repository the pane's
        // directory happens to be.
        "--no-context-files",
      ];
}

/**
 * Whether this harness can be **pushed** to, which is a different question from whether
 * it can be started, and is reported separately for that reason.
 *
 * Pi documents an extension interface for it: a custom message, queued, delivered when
 * the agent is between turns. Collie's extension uses that and nothing else — never
 * `sendUserMessage`, which is the one that appears as if the human typed it.
 *
 * Claude has no such interface on this installation, and that is a recorded observation
 * rather than a reading of its help page: `tools/chat-live.ts` writes news while the pane
 * sits idle and watches the pane, and nothing arrives until the human speaks. Custom
 * channels are a research-preview opt-in an organization enables, and neither
 * auto-confirming that consent nor emulating push by typing into the editor is something
 * Collie will do. So Claude is told **on its next turn**, through `collie_news` — which is
 * a real answer to "what happened", just not an interruption.
 */
export function pushable(harness: ChatHarness): {
  /** Whether Collie attempts a push at all on this harness. */
  readonly attempts: boolean;
  /** Whether a push has actually been seen to arrive here. Never assumed from a flag. */
  readonly proven: boolean;
  readonly how: string;
} {
  return harness === "pi"
    ? {
        attempts: true,
        proven: false,
        how: "Collie's Pi extension hands the batch to Pi's own queue as a custom message, between turns. That the message arrives has not been observed on this installation, so the conversation is still told on its next turn and nothing is marked delivered on the strength of the send.",
      }
    : {
        attempts: false,
        proven: false,
        how: "no push on this installation: Claude's custom channels are an organization opt-in Collie will not consent to on the human's behalf, and the live probe watched an idle pane and saw nothing arrive unasked. News reaches the conversation on its next turn, through collie_news.",
      };
}

/**
 * Whether this harness can be started at all, as a sentence or null. The board and the
 * Runs stay usable either way — a chat that will not open is a missing conversation, not
 * a missing control plane — so this is reported rather than thrown.
 */
export function whyUnavailable(harness: ChatHarness, found: string | null): string | null {
  return found === null
    ? `${harness} is not installed or not on PATH; the board and existing Runs are unaffected`
    : null;
}

/** A record for a launch that has just happened. */
export function started(opts: {
  readonly harness: ChatHarness;
  readonly agent: string;
  readonly paneId: string;
  readonly terminalId: string | null;
  readonly sessionId: string;
  readonly at: string;
}): ChatRecord {
  return {
    harness: opts.harness,
    agent: opts.agent,
    paneId: opts.paneId,
    terminalId: opts.terminalId,
    sessions: { [opts.harness]: opts.sessionId },
    startedAt: opts.at,
  };
}

/** The preference as configuration has it, coerced: chat has to open in one of the two. */
export function preferredHarness(value: string | undefined): ChatHarness {
  return isChatHarness(value) ? value : DEFAULT_CHAT_HARNESS;
}

/**
 * Which harness the next launch uses, read from the human's config. Independent of the
 * worker harness default: a Herd whose Runs are on Codex still talks in Claude Code
 * unless somebody said otherwise, on an existing installation as much as a new one.
 */
export const chatHarnessOf = Effect.fn("Chat.harnessOf")(function* (userDir: string) {
  const raw = yield* readConfig(userDir);
  const value = raw[CHAT_HARNESS_KEY];
  return preferredHarness(isString(value) ? value : undefined);
});

export const startedNow = Effect.fn("Chat.startedNow")(function* (
  opts: Omit<Parameters<typeof started>[0], "at">,
) {
  return started({ ...opts, at: yield* nowIso() });
});

// ---------------------------------------------------------------------------
// Launching it
// ---------------------------------------------------------------------------

/**
 * The Pi extension one chat launch is loaded with, generated with this binary's own path
 * in it, so the tools a launch offers are the tools the binary that launched it has.
 *
 * `-e` rather than a discovered location, for the same reason compaction's extension is:
 * one written into `~/.pi` would be a persistent settings change, and would load into
 * every Pi the human ever starts.
 */
export function piExtension(
  command: ReadonlyArray<string>,
  tools: ReadonlyArray<PiTool>,
  /**
   * Which Collie the tools read, named rather than inherited. Pi's own process env is the
   * pane's, which is usually right and was not the Herd at all under a probe — and
   * "usually right" is not something a control plane should rest on. Claude's server is
   * pinned the same way, so both adapters answer about one Collie.
   */
  env: Readonly<Record<string, string>>,
  /** Where this Herd's news journal is, and what it is called: the extension watches the
   * directory, because the file is replaced by rename whenever the journal is trimmed. */
  newsDir: string,
  newsFile: string,
): string {
  return `// Generated by Collie for one chat launch. Do not edit: it is rewritten at launch.
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { promisify } from "node:util";

const COMMAND = ${JSON.stringify(command)};
const ENV = ${JSON.stringify(env)};
const NEWS_DIR = ${JSON.stringify(newsDir)};
const NEWS_FILE = ${JSON.stringify(newsFile)};
const TOOLS = ${JSON.stringify(tools, null, 2)};

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
}
`;
}

/**
 * The `--mcp-config` document a Claude launch is given: this binary, serving these tools
 * over stdio. Here rather than beside the server, so the board does not carry the MCP
 * SDK to draw a pane.
 */
export function mcpConfig(command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) {
  const [bin, ...rest] = command;
  return `${JSON.stringify(
    { mcpServers: { collie: { command: bin ?? "collie", args: [...rest, "mcp"], env } } },
    null,
    2,
  )}\n`;
}

/**
 * The `--settings` document a Claude launch is given: prompt hooks that attach the board's
 * selection as context and hand the prompt to the tool host. Pi has no such hook, so its
 * conversation asks with a run-scoped tool given no run.
 */
export function claudeSettings(
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
): string {
  const run = (sub: string) =>
    [
      ...Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`),
      ...command.map(shellQuote),
      "chat",
      sub,
    ].join(" ");
  const heard = { type: "command", command: run("heard") };
  const hooks = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: run("context") }, heard] }],
    // A turn's words end with it, so a turn nobody prompted carries none.
    Stop: [{ hooks: [heard] }],
  };
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

/** What Claude's hooks are given, as far as Collie reads it: only `UserPromptSubmit` has a prompt. */
const HookInput = Schema.fromJsonString(
  Schema.Struct({ session_id: Schema.String, prompt: Schema.optionalKey(Schema.String) }),
);

const HeardSchema = Schema.Struct({ session: Schema.String, said: Schema.String });
const HeardJson = Schema.fromJsonString(HeardSchema);

/** The most of a prompt kept: it is copied into every record of its turn. */
export const HEARD_MAX = 2000;

const heardOf = (prompt: string) => {
  const said = redact(prompt);
  return said.length <= HEARD_MAX ? said : `${said.slice(0, HEARD_MAX - 1)}…`;
};

const heardPath = Effect.fn("Chat.heardPath")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* chatDir(stateDir, key), "heard.json");
});

/**
 * The human's prompt this turn, kept for the tool host, and forgotten when that session's
 * turn ends. Input that is not a hook's is ignored.
 */
export const hear = Effect.fn("Chat.hear")(function* (env: PluginEnv, input: string) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  const given = Schema.decodeUnknownOption(HookInput)(input);
  if (key === null || given._tag === "None") return;
  const fs = yield* FileSystem.FileSystem;
  const file = yield* heardPath(env.stateDir, key);
  if (given.value.prompt === undefined) {
    const kept = Schema.decodeUnknownOption(HeardJson)(
      yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(""))),
    );
    if (kept._tag === "Some" && kept.value.session === given.value.session_id)
      yield* fs.remove(file, { force: true });
    return;
  }
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(
    tmp,
    Schema.encodeSync(HeardJson)({
      session: given.value.session_id,
      said: heardOf(given.value.prompt),
    }),
  );
  yield* fs.rename(tmp, file);
});

/**
 * Who a chat's operation is recorded as speaking for: Native chat and, where
 * the running chat's own session last said something, those words.
 */
export const heardVoice = Effect.fn("Chat.heardVoice")(function* (env: PluginEnv) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return {};
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(yield* heardPath(env.stateDir, key))
    .pipe(Effect.catch(() => Effect.succeed("")));
  const heard = Schema.decodeUnknownOption(HeardJson)(raw);
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

/**
 * The three files one launch is wired with, written fresh each time into this Herd's own
 * chat directory. Nothing is written to `~/.claude` or `~/.pi`: a conversation Collie
 * opened must not change the harness the human uses for everything else.
 */
export const writeLaunchFiles = Effect.fn("Chat.writeLaunchFiles")(function* (opts: {
  readonly dir: string;
  readonly pluginRoot: string;
  /** How this binary re-invokes itself, which is what both adapters shell back into. */
  readonly self: ReadonlyArray<string>;
  readonly serverEnv: Readonly<Record<string, string>>;
  readonly tools: ReadonlyArray<PiTool>;
  /** This Herd's news journal, for the harness that can be pushed to. */
  readonly news: string;
  readonly mcpConfig: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(opts.dir, { recursive: true });
  const mcpConfig = path.join(opts.dir, "mcp.json");
  const extension = path.join(opts.dir, "collie.ts");
  const settings = path.join(opts.dir, "settings.json");
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
  return {
    systemPrompt: path.join(opts.pluginRoot, "prompts", "collie-chat.md"),
    mcpConfig,
    extension,
    settings,
  } satisfies LaunchFiles;
});

export type Ensured =
  /** A conversation is live. `next` is a preference for the launch after this one. */
  | { readonly kind: "running"; readonly record: ChatRecord; readonly next: ChatHarness | null }
  /** One was just started, on a new conversation. */
  | { readonly kind: "launched"; readonly record: ChatRecord }
  /** There is no conversation, and why. The board and every Run are unaffected. */
  | { readonly kind: "unavailable"; readonly harness: ChatHarness; readonly why: string };

/**
 * The Herd's conversation, found or started, beside a Home that already exists.
 *
 * Separate from `ensureHome` on purpose: the Home owns two panes, and this owns what runs
 * in one of them. A harness that will not start is a missing conversation reported as
 * one — never a reason for the board or a Run to be unavailable, and never a reason to
 * quietly open the other harness instead.
 */
export const ensureChatFor = Effect.fn("Chat.ensureFor")(function* (
  herdr: Herdr,
  env: PluginEnv,
  /** Which Herd this conversation belongs to; the caller resolves it once. */
  key: string,
  home: { readonly chatPaneId?: string | null },
  preferred: ChatHarness,
  log: (line: string) => Effect.Effect<void, never, never>,
  /**
   * How the launch re-invokes Collie — the MCP server Claude starts, and the command Pi's
   * extension shells back into. The compiled binary by default, which is what an install
   * has; a probe running from source passes its own entrypoint, because `selfCommand`
   * would otherwise name the probe rather than Collie.
   */
  self: ReadonlyArray<string> = selfCommand(),
) {
  const file = yield* chatPath(env.stateDir, key);
  yield* ensureLockDir(file);
  return yield* withLock(
    `${file}.lock`,
    // A launch already under way is a launch: the loser returns what the winner will
    // have, rather than starting a second conversation beside it.
    Effect.succeed({
      kind: "unavailable",
      harness: preferred,
      why: "another launch holds this Herd's chat",
    } satisfies Ensured),
    Effect.gen(function* () {
      const nothing = <A>(value: A) => Effect.catch(() => Effect.succeed(value));
      const record = yield* readChat(file);
      const panes = yield* herdr.paneList().pipe(nothing<ReadonlyArray<PaneInfo>>([]));
      const agents = yield* herdr.agentList().pipe(nothing<ReadonlyArray<AgentInfo>>([]));
      const decision = decideChat(record, home.chatPaneId ?? null, panes, agents, preferred);

      if (decision.kind === "no_pane")
        return {
          kind: "unavailable",
          harness: preferred,
          why: "the Home has no chat pane; `collie home show` says what herdr would not do",
        } satisfies Ensured;
      if (decision.kind === "adopt")
        return { kind: "running", record: decision.record, next: decision.next } satisfies Ensured;

      const unavailable = whyUnavailable(decision.harness, Bun.which(decision.harness));
      if (unavailable !== null) {
        yield* log(`chat: ${unavailable}`);
        return {
          kind: "unavailable",
          harness: decision.harness,
          why: unavailable,
        } satisfies Ensured;
      }

      // Which Collie both adapters read. One object, given to both: Claude's server and
      // Pi's extension are fresh processes with none of herdr's environment, and giving
      // them different answers here is two conversations about two different Herds — Pi
      // read the human's real state directory that way, and said so confidently.
      // An empty value reads as unset, which is what a CLI launch with no socket has.
      const serverEnv = {
        HERDR_PLUGIN_STATE_DIR: env.stateDir,
        COLLIE_USER_DIR: env.userDir,
        HERDR_SOCKET_PATH: env.socketPath ?? "",
        COLLIE_CWD: yield* herdDir(env.stateDir, key),
      };

      const files = yield* writeLaunchFiles({
        dir: yield* chatDir(env.stateDir, key),
        pluginRoot: env.pluginRoot,
        self,
        serverEnv,
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          label: tool.title,
          description: tool.description,
          parameters: tool.input,
        })),
        news: yield* newsPath(env.stateDir, key),
        mcpConfig: mcpConfig(self, serverEnv),
      });

      const crypto = yield* Crypto.Crypto;
      const paneId = home.chatPaneId ?? "";
      const kind = HARNESSES[decision.harness]?.kind ?? decision.harness;
      const start = Effect.fn("Chat.start")(function* (sessionId: string) {
        // A fresh name every attempt, never derived from the session: herdr keeps a name
        // until the process holding it has gone, so a relaunch under the same name was
        // refused `agent_name_taken` and left the Home with a pane and nothing in it.
        const agent = `${CHAT_AGENT_PREFIX}-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
        const failed = yield* herdr
          .agentStart({
            name: agent,
            kind,
            paneId,
            args: [...chatArgs(decision.harness, sessionId, files)],
          })
          .pipe(
            Effect.as(null),
            Effect.catch((cause) => Effect.succeed(reason(cause))),
          );
        return { agent, sessionId, failed };
      });

      const attempt = yield* start(yield* crypto.randomUUIDv4);
      if (attempt.failed !== null) {
        // herdr's own words: "would not start it" is not something a human can act on.
        const why = `herdr would not start ${decision.harness} in the Home's chat pane: ${attempt.failed}`;
        yield* log(`chat: ${why}`);
        return { kind: "unavailable", harness: decision.harness, why } satisfies Ensured;
      }
      const after = (yield* herdr.paneList().pipe(nothing<ReadonlyArray<PaneInfo>>([]))).find(
        (entry) => entry.paneId === paneId,
      );
      const next = yield* startedNow({
        harness: decision.harness,
        agent: attempt.agent,
        paneId,
        terminalId: after?.terminalId ?? null,
        sessionId: attempt.sessionId,
      });
      yield* writeChat(file, next);
      yield* log(`chat: started ${decision.harness} (${decision.why}); a new conversation`);
      return { kind: "launched", record: next } satisfies Ensured;
    }),
  );
});
