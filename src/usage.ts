// This Machine's Usage readings (ADR-0049 D1–D2): Claude's from the endpoint Claude Code's
// `/usage` reads and its agents' status lines, ChatGPT's from Codex's app server. Each
// endpoint is called only when asked, and at most once per interval.

import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { withCodex } from "./codex";
import { CONTROL_DIR, readControl } from "./compaction";
import { newestRateLimits } from "./compactors";
import { currentEnv, type PluginEnv } from "./env";
import { sha256Hex } from "./attachments";
import { reason } from "./naming";
import { epochMs } from "./time";
import {
  ClaudeJson,
  ClaudeUsage,
  CodexAccount,
  CodexRateLimits,
  claudeLogin,
  claudeWindows,
  codexLogin,
  codexUsage,
  statusLineWindows,
  type Login,
  type StatusSample,
  type Subscription,
  type UsageReading,
} from "./usage-model";

/** How often an endpoint may be called; Claude's refuses callers that ask more often. */
export const USAGE_INTERVAL_MS = 5 * 60_000;
/** How long one call may take before it becomes a problem. */
export const USAGE_CALL_MS = 10_000;

/** What one source said when asked. */
export interface Asked {
  readonly reading: UsageReading;
  /** Whether an endpoint was called, which is what the interval paces. */
  readonly called: boolean;
  /** Set when the endpoint refused: how long it asked to be left alone. */
  readonly retryAfterMs?: number | null;
}

export interface UsageSources {
  readonly claude: Effect.Effect<Asked>;
  readonly chatgpt: Effect.Effect<Asked>;
  /** The newest Claude agent's status-line sample on this Machine. */
  readonly statusLine: Effect.Effect<StatusSample | null>;
}

export class Usage extends Context.Service<
  Usage,
  { readonly readings: Effect.Effect<ReadonlyArray<UsageReading>> }
>()("collie/Usage") {}

const SOURCE = { claude: "claude-usage", chatgpt: "codex-app-server" } as const;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const problem = (
  subscription: Subscription,
  at: number,
  text: string,
  login: Login = { account: null, accountLabel: null, plan: null },
): UsageReading => ({
  subscription,
  ...login,
  windows: [],
  at: iso(at),
  source: SOURCE[subscription],
  problem: text,
});

/**
 * One source behind its interval: a call only once the last is old enough, a refusal's
 * back-off honoured, and the last good reading kept, with its age, while there is no new one.
 */
const paced = Effect.fn("Usage.paced")(function* (
  subscription: Subscription,
  ask: Effect.Effect<Asked>,
) {
  const single = yield* Semaphore.make(1);
  let until = 0;
  let good: UsageReading | null = null;
  let shown: UsageReading | null = null;
  return single.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (shown !== null && now < until) return shown;
      const asked = yield* ask.pipe(
        Effect.timeoutOption(USAGE_CALL_MS),
        Effect.map(
          Option.getOrElse((): Asked => ({
            reading: problem(
              subscription,
              now,
              `${SOURCE[subscription]} did not answer within ${USAGE_CALL_MS / 1000}s`,
            ),
            called: true,
          })),
        ),
      );
      if (asked.reading.problem === null) good = asked.reading;
      shown =
        good !== null && asked.reading.problem !== null
          ? { ...good, problem: asked.reading.problem }
          : asked.reading;
      if (asked.called) until = now + Math.max(USAGE_INTERVAL_MS, asked.retryAfterMs ?? 0);
      return shown;
    }),
  );
});

/** Claude's reading, with a status-line sample newer than it in place of its session and weekly. */
function withSample(reading: UsageReading, sample: StatusSample | null): UsageReading {
  if (sample === null) return reading;
  const fresh = statusLineWindows(sample.limits);
  if (fresh.length === 0 || (reading.windows.length > 0 && sample.at <= epochMs(reading.at)))
    return reading;
  return {
    ...reading,
    windows: [
      ...fresh,
      ...reading.windows.filter((window) => window.kind !== "session" && window.kind !== "weekly"),
    ],
    at: iso(sample.at),
    source: "claude-status-line",
  };
}

export const makeUsage = Effect.fn("Usage.make")(function* (sources: UsageSources) {
  const claude = yield* paced("claude", sources.claude);
  const chatgpt = yield* paced("chatgpt", sources.chatgpt);
  return Usage.of({
    readings: Effect.all([claude, chatgpt, sources.statusLine], { concurrency: "unbounded" }).pipe(
      Effect.map(([claude, chatgpt, sample]) => [withSample(claude, sample), chatgpt]),
    ),
  });
});

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          accessToken: Schema.String,
          /** Epoch ms. */
          expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);
const decodeCredentials = Schema.decodeUnknownOption(Credentials);
const decodeClaudeJson = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeJson));
const decodeClaudeUsage = Schema.decodeUnknownOption(ClaudeUsage);
const decodeCodexAccount = Schema.decodeUnknownOption(CodexAccount);
const decodeCodexRateLimits = Schema.decodeUnknownOption(CodexRateLimits);

/** Where Claude Code keeps its login, and what to read it with. */
export interface ClaudeLoginSource {
  /** Claude Code's stored login, as text, or null where there is none. */
  readonly credentials: Effect.Effect<string | null>;
  /** `~/.claude.json`, as text, or null. */
  readonly claudeJson: Effect.Effect<string | null>;
}

type LoginReaders = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  }).pipe(Effect.orElseSucceed(() => null));

/** On macOS the Keychain's item, suffixed by the config directory's hash where one is set. */
const keychain = (configDir: string | undefined) =>
  Effect.gen(function* () {
    const service =
      configDir === undefined
        ? "Claude Code-credentials"
        : `Claude Code-credentials-${sha256Hex(configDir).slice(0, 8)}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("security", ["find-generic-password", "-s", service, "-w"], {
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const text = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return Number(yield* handle.exitCode) === 0 ? text.trim() : null;
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => null),
  );

export const claudeLoginSource = (env: PluginEnv) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const configDir = env.raw["CLAUDE_CONFIG_DIR"];
    const dir = configDir ?? path.join(env.home, ".claude");
    const services = yield* Effect.context<LoginReaders>();
    const credentials: Effect.Effect<string | null, never, LoginReaders> =
      process.platform === "darwin"
        ? keychain(configDir)
        : readText(path.join(dir, ".credentials.json"));
    return {
      credentials: Effect.provideContext(credentials, services),
      claudeJson: readText(
        configDir === undefined
          ? path.join(env.home, ".claude.json")
          : path.join(configDir, ".claude.json"),
      ).pipe(Effect.provideContext(services)),
    } satisfies ClaudeLoginSource;
  });

/**
 * Asks Claude's usage endpoint with the login Claude Code keeps, read and never refreshed
 * or written: a refresh rotates the token and signs Claude Code out.
 */
export const askClaude = (
  login: ClaudeLoginSource,
): Effect.Effect<Asked, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stored = Option.getOrNull(
      decodeCredentials((yield* login.credentials) ?? ""),
    )?.claudeAiOauth;
    if (!stored)
      return {
        reading: problem("claude", now, "Claude Code is not logged in on this Machine"),
        called: false,
      };
    const account = claudeLogin(
      Option.getOrNull(decodeClaudeJson((yield* login.claudeJson) ?? "")),
      stored.subscriptionType ?? null,
    );
    const failed = (text: string, retryAfterMs?: number | null): Asked => ({
      reading: problem("claude", now, text, account),
      called: true,
      retryAfterMs,
    });
    if (stored.expiresAt != null && stored.expiresAt <= now)
      return {
        reading: problem(
          "claude",
          now,
          "Claude Code's login expired; it refreshes when Claude Code next runs",
          account,
        ),
        called: false,
      };
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${stored.accessToken}`),
        HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
      ),
    ).pipe(Effect.result);
    if (response._tag === "Failure")
      return failed(`Claude's usage endpoint: ${reason(response.failure)}`);
    const { status, headers } = response.success;
    if (status === 429) {
      const seconds = Number(headers["retry-after"]);
      return failed(
        "Claude's usage endpoint is refusing calls for now; the last reading stands",
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      );
    }
    if (status === 401 || status === 403)
      return failed(
        "Claude's usage endpoint refused Claude Code's login; it refreshes when Claude Code next runs",
      );
    if (status < 200 || status >= 300) return failed(`Claude's usage endpoint answered ${status}`);
    const body = yield* response.success.json.pipe(Effect.orElseSucceed(() => null));
    const usage = Option.getOrNull(decodeClaudeUsage(body));
    if (usage === null)
      return failed("Claude's usage endpoint answered in a shape Collie does not read");
    const windows = claudeWindows(usage);
    return {
      reading: {
        subscription: "claude",
        ...account,
        windows,
        at: iso(now),
        source: "claude-usage",
        problem: null,
      },
      called: true,
    } satisfies Asked;
  });

/** What a Codex app server answers to the two calls a reading takes. */
export interface CodexAnswers {
  readonly rateLimits: unknown;
  readonly account: unknown;
}

/** A Codex app server for one exchange: a running agent's own, else one over stdio. */
export type CodexAsk = Effect.Effect<CodexAnswers, Error>;

export const codexReading = (ask: CodexAsk): Effect.Effect<Asked> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const answered = yield* Effect.result(ask);
    if (answered._tag === "Failure")
      return { reading: problem("chatgpt", now, answered.failure.message), called: true };
    const login = codexLogin(
      Option.getOrElse(decodeCodexAccount(answered.success.account), () => ({})),
    );
    if (login.account === null && login.accountLabel === null)
      return {
        reading: problem(
          "chatgpt",
          now,
          "Codex is not logged in on this Machine; run `codex login`",
        ),
        called: true,
      };
    const limits = Option.getOrNull(decodeCodexRateLimits(answered.success.rateLimits));
    if (limits === null)
      return {
        reading: problem(
          "chatgpt",
          now,
          "Codex's app server answered in a shape Collie does not read",
          login,
        ),
        called: true,
      };
    const usage = codexUsage(limits);
    return {
      reading: {
        subscription: "chatgpt",
        ...login,
        plan: usage.plan ?? login.plan,
        windows: usage.windows,
        at: iso(now),
        source: "codex-app-server",
        problem: null,
      },
      called: true,
    };
  });

const RATE_LIMITS = "account/rateLimits/read";
const ACCOUNT = "account/read";

/** A running Codex agent's own app server, where this Machine has one. */
const runningCodex = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agents = yield* fs
      .readDirectory(path.join(stateDir, CONTROL_DIR))
      .pipe(Effect.orElseSucceed(() => []));
    for (const agent of agents) {
      const control = yield* readControl(stateDir, agent).pipe(Effect.orElseSucceed(() => null));
      if (control?.harness === "codex" && control.endpoint !== null) return control.endpoint;
    }
    return null;
  });

const viaEndpoint = (endpoint: string): CodexAsk =>
  withCodex(endpoint, (client) =>
    Effect.all({
      rateLimits: client.call(RATE_LIMITS, {}),
      account: client.call(ACCOUNT, {}),
    }),
  );

/** This Codex agent's own reading from its app server; null where it has none or it fails. */
export const ownCodexReading = (stateDir: string, agent: string) =>
  readControl(stateDir, agent).pipe(
    Effect.flatMap((control) =>
      control?.harness !== "codex" || control.endpoint === null
        ? Effect.succeed(null)
        : codexReading(viaEndpoint(control.endpoint)).pipe(
            Effect.map(({ reading }) => (reading.problem === null ? reading : null)),
          ),
    ),
    Effect.orElseSucceed(() => null),
  );

const RpcReply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Number),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeReply = Schema.decodeUnknownOption(RpcReply);

/** `codex app-server` over stdio, for one exchange, closed again when it is answered. */
const viaStdio: Effect.Effect<CodexAnswers, Error, ChildProcessSpawner.ChildProcessSpawner> =
  Effect.gen(function* () {
    const lines = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "collie", version: "0" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: RATE_LIMITS, params: {} },
      { jsonrpc: "2.0", id: 3, method: ACCOUNT, params: {} },
    ].map((message) => `${JSON.stringify(message)}\n`);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner
      .spawn(
        ChildProcess.make("codex", ["app-server"], {
          // Held open: a closed stdin is the server's cue to stop before it answers.
          stdin: Stream.concat(Stream.make(new TextEncoder().encode(lines.join(""))), Stream.never),
          stdout: "pipe",
          stderr: "ignore",
          extendEnv: true,
        }),
      )
      .pipe(Effect.mapError(() => new Error("Codex is not installed on this Machine")));
    const answers = new Map<number, unknown>();
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) => {
        const reply = Option.getOrNull(decodeReply(line));
        if (reply?.id === undefined || reply.id < 2) return Effect.void;
        if (reply.error)
          return Effect.fail(
            new Error(`codex ${reply.id === 2 ? RATE_LIMITS : ACCOUNT}: ${reply.error.message}`),
          );
        answers.set(reply.id, reply.result);
        return Effect.void;
      }),
      Stream.takeUntil(() => answers.size === 2),
      Stream.runDrain,
      Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(reason(cause)))),
    );
    if (answers.size < 2)
      return yield* Effect.fail(new Error("codex app-server stopped before it answered"));
    return { rateLimits: answers.get(2), account: answers.get(3) };
  }).pipe(Effect.scoped);

/** This Machine's sources, as the host reads them. */
export const liveSources = (env: PluginEnv) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >();
    const login = yield* claudeLoginSource(env);
    const codex: CodexAsk = runningCodex(env.stateDir).pipe(
      Effect.flatMap((endpoint) =>
        endpoint === null ? viaStdio : viaEndpoint(endpoint).pipe(Effect.catch(() => viaStdio)),
      ),
      Effect.provideContext(services),
    );
    return {
      claude: askClaude(login).pipe(Effect.provide(FetchHttpClient.layer)),
      chatgpt: codexReading(codex),
      statusLine: newestRateLimits(env.stateDir).pipe(
        Effect.orElseSucceed(() => null),
        Effect.provideContext(services),
      ),
    } satisfies UsageSources;
  });

/** This Machine's one reader of its usage, on the environment this process runs in. */
export const usageLayer = Layer.effect(
  Usage,
  currentEnv.pipe(Effect.orDie, Effect.flatMap(liveSources), Effect.flatMap(makeUsage)),
);
