import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
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
import type { CodexError } from "./codex";
import { CONTROL_DIR, readControl } from "./compaction";
import { rateLimitsReader } from "./compactors";
import { currentEnv } from "./env";
import type { PluginEnv } from "./env";
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
} from "./usage-model";
import type { Login, StatusSample, Subscription, UsageReading } from "./usage-model";
import { stringifyJson } from "./json";

// WARNING: Claude's endpoint refuses callers who ask more often than this.
export const USAGE_INTERVAL_MS = 5 * 60_000;
export const USAGE_CALL_MS = 10_000;

export interface Asked {
  readonly reading: UsageReading;
  readonly called: boolean;
  readonly retryAfterMs?: number | null;
}

export interface UsageSources {
  readonly claude: Effect.Effect<Asked>;
  readonly chatgpt: Effect.Effect<Asked>;
  readonly statusLine: Effect.Effect<StatusSample | null>;
}

export class Usage extends Context.Service<
  Usage,
  { readonly readings: Effect.Effect<ReadonlyArray<UsageReading>> }
>()("collie/Usage") {}

const SOURCE = { claude: "claude-usage", chatgpt: "codex-app-server" } as const;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const problem: (
  subscription: Subscription,
  at: number,
  text: string,
  login?: Login,
) => UsageReading = (
  subscription,
  at,
  text,
  login = { account: null, accountLabel: null, plan: null },
) => ({
  subscription,
  ...login,
  windows: [],
  at: iso(at),
  source: SOURCE[subscription],
  problem: text,
});

// WARNING: a refusal's back-off is honoured and the last good reading kept while no new one lands.
const paced = Effect.fn("Usage.paced")(function* (
  subscription: Subscription,
  ask: Effect.Effect<Asked>,
) {
  const single = yield* Semaphore.make(1);
  let until = 0;
  let good: UsageReading | null = null;
  let shown: UsageReading | null = null;
  return yield* Effect.succeed(
    single.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (shown !== null && now < until) return shown;
        const asked = yield* ask.pipe(
          Effect.timeoutOption(USAGE_CALL_MS),
          Effect.map(
            Option.getOrElse(() => {
              const returned: Asked = {
                reading: problem(
                  subscription,
                  now,
                  `${SOURCE[subscription]} did not answer within ${USAGE_CALL_MS / 1000}s`,
                ),
                called: true,
              };
              return returned;
            }),
          ),
        );
        if (asked.reading.problem === null) good = asked.reading;
        shown =
          good !== null && asked.reading.problem !== null
            ? {
                ...good,
                problem: asked.reading.problem,
              }
            : asked.reading;
        if (asked.called) until = now + Math.max(USAGE_INTERVAL_MS, asked.retryAfterMs ?? 0);
        return shown;
      }),
    ),
  );
});

function withSample(reading: UsageReading, sample: StatusSample | null) {
  if (sample === null) {
    const returned: UsageReading = reading;
    return returned;
  }
  const fresh = statusLineWindows(sample.limits);
  if (fresh.length === 0 || (reading.windows.length > 0 && sample.at <= epochMs(reading.at))) {
    const returned: UsageReading = reading;
    return returned;
  }
  const returned: UsageReading = {
    ...reading,
    windows: [
      ...fresh,
      ...Arr.filter(
        reading.windows,
        (window) => window.kind !== "session" && window.kind !== "weekly",
      ),
    ],
    at: iso(sample.at),
    source: "claude-status-line",
  };
  return returned;
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
          expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
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

export interface ClaudeLoginSource {
  readonly credentials: Effect.Effect<string | null>;
  readonly claudeJson: Effect.Effect<string | null>;
}

type LoginReaders = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  }).pipe(Effect.orElseSucceed(() => null));

// WARNING: Claude Code suffixes its Keychain item with a hash of its config dir when one is set.
const keychain = (configDir: string | undefined) =>
  Effect.gen(function* () {
    const service =
      configDir === undefined
        ? "Claude Code-credentials"
        : `Claude Code-credentials-${pipe_(sha256Hex(configDir), Str.slice(0, 8))}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("security", ["find-generic-password", "-s", service, "-w"], {
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const text = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
    return Number(yield* handle.exitCode) === 0 ? Str.trim(text) : null;
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
    const returned: ClaudeLoginSource = {
      credentials: Effect.provideContext(credentials, services),
      claudeJson: readText(
        configDir === undefined
          ? path.join(env.home, ".claude.json")
          : path.join(configDir, ".claude.json"),
      ).pipe(Effect.provideContext(services)),
    };
    return returned;
  });

// WARNING: never refresh or write this login: a refresh rotates the token and signs Claude Code out.
export const askClaude: (
  login: ClaudeLoginSource,
) => Effect.Effect<Asked, never, HttpClient.HttpClient> = (login) =>
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
    const failed = (text: string, retryAfterMs?: number | null) => {
      const returned: Asked = {
        reading: problem("claude", now, text, account),
        called: true,
        retryAfterMs,
      };
      return returned;
    };
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

export interface CodexAnswers {
  readonly rateLimits: unknown;
  readonly account: unknown;
}

export type CodexAsk = Effect.Effect<CodexAnswers, CodexError | Cause.UnknownError>;

export const codexReading: (ask: CodexAsk) => Effect.Effect<Asked> = (ask) =>
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

const viaEndpoint: (endpoint: string) => CodexAsk = (endpoint) =>
  withCodex(endpoint, (client) =>
    Effect.all({
      rateLimits: client.call(RATE_LIMITS, {}),
      account: client.call(ACCOUNT, {}),
    }),
  );

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
    id: Schema.optionalKey(Schema.Finite),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeReply = Schema.decodeUnknownOption(RpcReply);

const viaStdio: Effect.Effect<
  CodexAnswers,
  Cause.UnknownError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const lines = Arr.map(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "collie", version: "0" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: RATE_LIMITS, params: {} },
      { jsonrpc: "2.0", id: 3, method: ACCOUNT, params: {} },
    ],
    (message) => `${stringifyJson(message)}\n`,
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("codex", ["app-server"], {
        // WARNING: a closed stdin tells the server to stop before it answers, so stdin is held open.
        stdin: Stream.concat(
          Stream.make(new TextEncoder().encode(Arr.join(lines, ""))),
          Stream.never,
        ),
        stdout: "pipe",
        stderr: "ignore",
        extendEnv: true,
      }),
    )
    .pipe(
      Effect.mapError(
        () => new Cause.UnknownError(undefined, "Codex is not installed on this Machine"),
      ),
    );
  const answers = new Map<number, unknown>();
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapEffect((line) => {
      const reply = Option.getOrNull(decodeReply(line));
      if (reply?.id === undefined || reply.id < 2) return Effect.void;
      if (reply.error)
        return Effect.fail(
          new Cause.UnknownError(
            reply.error,
            `codex ${reply.id === 2 ? RATE_LIMITS : ACCOUNT}: ${reply.error.message}`,
          ),
        );
      answers.set(reply.id, reply.result);
      return Effect.void;
    }),
    Stream.takeUntil(() => answers.size === 2),
    Stream.runDrain,
    Effect.mapError((cause) =>
      Cause.isUnknownError(cause) ? cause : new Cause.UnknownError(cause, reason(cause)),
    ),
  );
  if (answers.size < 2)
    return yield* new Cause.UnknownError(undefined, "codex app-server stopped before it answered");
  return { rateLimits: answers.get(2), account: answers.get(3) };
}).pipe(Effect.scoped);

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
    const returned: UsageSources = {
      claude: askClaude(login).pipe(Effect.provide(FetchHttpClient.layer)),
      chatgpt: codexReading(codex),
      statusLine: (yield* rateLimitsReader(env.stateDir)).newest.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provideContext(services),
      ),
    };
    return returned;
  });

export const usageLayer = Layer.effect(
  Usage,
  currentEnv.pipe(Effect.orDie, Effect.flatMap(liveSources), Effect.flatMap(makeUsage)),
);
