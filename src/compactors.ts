import * as Num from "effect/Number";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import {
  Cache,
  Cause,
  Config,
  ConfigProvider,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Result,
  Schedule,
  Order,
  Schema,
  flow,
} from "effect";
import type { Source } from "./usage-ledger-model";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";
import {
  agentThreads,
  askedQuestions,
  boundThread,
  compactionItems,
  interruptTurn,
  currentContext as codexContext,
  startCompaction,
  turnOutcome,
  withCodex,
  codexReachable,
} from "./codex";
import {
  compactionAfter,
  compactionIds,
  currentContext,
  messages as openCodeMessages,
  sessionIsHere,
  sessionModel,
  summarize,
  createSession,
} from "./opencode";
import { current, isFull, resetPhrase, StatusLineLimits, statusLineWindows } from "./usage-model";
import type { StatusSample } from "./usage-model";
import { CONTROL_DIR, Unsubmitted, readControl } from "./compaction";
import type {
  CompactionPort,
  Marked,
  CompactionPorts,
  AgentContext,
  LaunchContext,
  ReadyContext,
  StopTarget,
  SeenProcess,
  Stopped,
} from "./compaction";
import {
  processOf,
  processAbsent,
  readsSessions,
  sessionOf,
  stillRunning,
  terminate,
} from "./processes";
import type { ProcessInfo } from "./processes";
import { holderLives, hostLockOf, lockHolder, withLock } from "./lock";
import { tellHost } from "./tell-host";
import { carriedDelivery } from "./dispatcher";
import { epochMs } from "./time";
import { stringifyJson } from "./json";

const submitCompaction = Effect.fn("Compactors.submitCompaction")(function* (
  ctx: AgentContext,
  requestId: string,
  text: string,
) {
  const outcome = yield* ctx.channel.submit(text, {
    run: ctx.run,
    cause: { kind: "compaction", ref: requestId },
    mode: "boundary",
    intentVersion: 0,
    attempt: 1,
    requestId,
  });
  if (outcome.ok) {
    return outcome.submission ?? null;
  }
  if (outcome.reason === "unknown") {
    return null;
  }
  if (outcome.reason === "failed") {
    return yield* new Submitting({ message: outcome.detail, cause: outcome });
  }
  return yield* new Unsubmitted({ message: outcome.detail, cause: outcome });
});
import { selfCommand } from "./env";
import { shell } from "./mr";
import { reason } from "./naming";
import { isToStandard, questionRepair } from "./question-standard";
import type { JsonObject } from "./schema";

// WARNING: the gate refuses an older release; a launch that installs controls an older release ignores would be an unmanaged agent wearing a managed record.
export const VERIFIED_VERSIONS: ReadonlyMap<string, string> = new Map([
  ["claude", "2.1.263"],
  ["codex", "0.162.0"],
  ["opencode", "1.18.9"],
  ["pi", "0.87.1"],
]);

const TELEMETRY = "events.jsonl";
const TELEMETRY_LOCK = "events.lock";
// WARNING: appended so a writer that could not record can say so; absence in a file reads as nothing having happened.
const LOSSES = "events.lost";
const TELEMETRY_CLAIMS = 200;

const EventSchema = Schema.Struct({
  at: Schema.Finite,
  session: Schema.NullOr(Schema.String),
  kind: Schema.Literals([
    "session",
    "usage",
    "start",
    "done",
    "failed",
    "auto",
    "submit",
    "out",
    "stopped",
    "cancelled",
  ]),
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  request: Schema.optionalKey(Schema.String),
  delivery: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  // WARNING: Claude's PostCompact carries no marker, so a completion is told from its start by position.
  phase: Schema.optionalKey(Schema.Literals(["pre", "post"])),
  // WARNING: a relaunched agent reuses its session id, so a boundary only counts for the launch it came from.
  launch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // WARNING: Codex's compaction endpoint takes only a thread, so this before-list supplies the correlation.
  items: Schema.optionalKey(Schema.Array(Schema.String)),
  limits: Schema.optionalKey(StatusLineLimits),
  transcript: Schema.optionalKey(Schema.String),
});
interface TelemetryEvent extends Schema.Schema.Type<typeof EventSchema> {}
const EventJson = Schema.fromJsonString(EventSchema);
const decodeEvent = Schema.decodeUnknownOption(EventJson);
const encodeEvent = flow(Schema.encodeResult(EventJson), Result.getOrThrow);

const LossJson = Schema.fromJsonString(Schema.Struct({ at: Schema.Finite }));
const decodeLoss = Schema.decodeUnknownOption(LossJson);
const encodeLoss = flow(Schema.encodeResult(LossJson), Result.getOrThrow);

// WARNING: a correlation that reads absence cannot answer from a file with a hole in it.
const lostSince = Effect.fn("Compactors.lostSince")(function* (dir: string, since: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, LOSSES);
  if (!(yield* fs.exists(file))) {
    return false;
  }
  const lines = yield* fs.readFileString(file);
  return Arr.some(Str.split(lines, "\n"), (line) => {
    const decoded = decodeLoss(line);
    return decoded._tag === "Some" && decoded.value.at >= since;
  });
});

// WARNING: the newest session line binds; an older session's samples and outcomes are stale, not merely old.
const readEvents = Effect.fn("Compactors.readEvents")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, TELEMETRY);
  if (!(yield* fs.exists(file))) {
    return [];
  }
  const lines = yield* fs
    .readFileString(file)
    .pipe(Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => Str.trim(line) !== "")));
  const bound = boundSession(lines);
  if (bound === undefined) {
    return [];
  }
  const events: Array<TelemetryEvent> = [];
  for (const line of lines) {
    const decoded = decodeEvent(line);
    if (decoded._tag === "Some" && decoded.value.session === bound) {
      events.push(decoded.value);
    }
  }
  return events;
});

// WARNING: Claude writes a --session-id conversation only on its first submitted turn, so an id with none cannot be resumed.
// WARNING: the turn record outlives the telemetry cap; a relaunch reads it to know the session has a conversation.
export const TURNS = "turns.jsonl";

// WARNING: the hook runs inside the harness's process, so the launch Collie gave it is in the environment it inherited.
const launchLabel = Effect.gen(function* () {
  const supplied = yield* Effect.serviceOption(ConfigProvider.ConfigProvider);
  const provider = Option.getOrElse(supplied, () => ConfigProvider.fromEnv());
  const label = yield* Config.String("COLLIE_LAUNCH").pipe(
    Config.withDefault(""),
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );
  return label === "" ? null : label;
});

export const turnTaken = Effect.fn("Compactors.turnTaken")(function* (
  dir: string,
  session: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const turns = path.join(dir, TURNS);
  const recorded = (yield* fs.exists(turns))
    ? yield* fs.readFileString(turns).pipe(Effect.orElseSucceed(() => ""))
    : "";
  if (Arr.some(Str.split(recorded, "\n"), (line) => Str.trim(line) === session)) {
    return true;
  }
  const events = yield* readEvents(dir).pipe(Effect.orElseSucceed(() => []));
  if (Arr.some(events, (one) => one.kind === "submit" && one.session === session)) {
    return true;
  }
  const transcript = Option.getOrUndefined(
    Arr.findLast(events, (one) => one.transcript !== undefined && one.session === session),
  )?.transcript;
  if (transcript === undefined) {
    return false;
  }
  return yield* fs.readFileString(transcript).pipe(
    Effect.map((text) =>
      Arr.some(['"type":"user"', '"type":"assistant"'], (mark) => Str.includes(mark)(text)),
    ),
    Effect.orElseSucceed(() => false),
  );
});

// WARNING: a status line writes on every event, so an append-only file would be tens of thousands of lines by lunchtime.
export const KEEP_LINES = 200;

const KEEP_LIFECYCLE = 6;

function protectedLines(lines: ReadonlyArray<string>) {
  const keep = new Set<number>();
  let lifecycle = 0;
  let bound = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const decoded = decodeEvent(lines[i]!);
    if (decoded._tag !== "Some") {
      continue;
    }
    const kind = decoded.value.kind;
    if (kind === "session") {
      if (bound) {
        continue;
      }
      bound = true;
    } else if (kind === "usage" || kind === "submit" || lifecycle === KEEP_LIFECYCLE) {
      continue;
    } else {
      lifecycle += 1;
    }
    keep.add(i);
  }
  const returned: ReadonlySet<number> = keep;
  return returned;
}

function trimmed(lines: ReadonlyArray<string>, room: number) {
  if (lines.length <= room) {
    const returned: ReadonlyArray<string> = lines;
    return returned;
  }
  let excess = lines.length - room;
  const keep = protectedLines(lines);
  const kept = Arr.filter(lines, (line, at) => {
    if (excess === 0 || keep.has(at)) {
      return true;
    }
    excess -= 1;
    return false;
  });
  const returned: ReadonlyArray<string> = kept.length > room ? kept.slice(-room) : kept;
  return returned;
}

// WARNING: read-slice-write because the cap is the point; under the agent's lock because several processes write the same file.
export const writeEvent = Effect.fn("Compactors.writeEvent")(function* (
  dir: string,
  written: Omit<TelemetryEvent, "at">,
) {
  const event: TelemetryEvent = { ...written, at: yield* Clock.currentTimeMillis };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, TELEMETRY);
  yield* fs.makeDirectory(dir, { recursive: true });
  const line = encodeEvent(event);
  yield* withLock(
    path.join(dir, TELEMETRY_LOCK),
    // WARNING: nothing goes into the telemetry outside the lock; the holder's snapshot would overwrite it.
    fs.writeFileString(path.join(dir, LOSSES), `${encodeLoss({ at: event.at })}\n`, {
      flag: "a",
    }),
    Effect.gen(function* () {
      const existing = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
      const older = trimmed(
        Arr.filter(Str.split(existing, "\n"), (text) => Str.trim(text) !== ""),
        KEEP_LINES - 2,
      );
      // WARNING: read from what survives the trim, so a binding the cap removed is put back by this write.
      // WARNING: the turn record outlives the telemetry cap, which is what a relaunch reads to know a session has a conversation.
      if (event.kind === "submit" && event.session !== null) {
        yield* fs.writeFileString(path.join(dir, TURNS), `${event.session}\n`, {
          flag: "a",
        });
      }
      const bound = boundSession(older);
      const rebinds = bound !== event.session && event.kind !== "session";
      const session = rebinds
        ? [encodeEvent({ at: event.at, session: event.session, kind: "session" })]
        : [];
      yield* fs.writeFileString(file, `${Arr.join([...older, ...session, line], "\n")}\n`);
    }),
    TELEMETRY_CLAIMS,
  );
});

export class TelemetryUnwritten extends Data.TaggedError("TelemetryUnwritten")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// WARNING: a hole nobody marked reads as nothing having happened, so a failed write must be marked or loud.
export const recordEvent = Effect.fn("Compactors.recordEvent")(function* (
  dir: string,
  written: Omit<TelemetryEvent, "at">,
) {
  const written_ = yield* Effect.result(writeEvent(dir, written));
  if (Result.isSuccess(written_)) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marked = yield* Effect.result(
    fs.writeFileString(
      path.join(dir, LOSSES),
      `${encodeLoss({ at: yield* Clock.currentTimeMillis })}\n`,
      {
        flag: "a",
      },
    ),
  );
  if (Result.isSuccess(marked)) {
    return;
  }
  return yield* new TelemetryUnwritten({
    message: `${written.kind} could not be recorded, and its loss could not be marked either`,
    cause: written_.failure,
  });
});

function boundSession(lines: ReadonlyArray<string>) {
  for (const line of [...lines].reverse()) {
    const decoded = decodeEvent(line);
    if (decoded._tag === "Some" && decoded.value.kind === "session") {
      const returned: string | null | undefined = decoded.value.session;
      return returned;
    }
  }
  const returned: string | null | undefined = undefined;
  return returned;
}

// WARNING: the telemetry outlives a launch, so a relaunch's readiness is an event of that launch.
const reported = (ctx: ReadyContext) =>
  readEvents(ctx.dir).pipe(
    Effect.map(
      (events) =>
        events.length > 0 &&
        (ctx.launch === null ||
          ctx.launch === undefined ||
          Arr.some(events, (one) => one.launch === ctx.launch)),
    ),
    Effect.orElseSucceed(() => false),
  );

const latestUsage = Effect.fn("Compactors.latestUsage")(function* (dir: string) {
  const events = yield* readEvents(dir);
  return Arr.filter(events, (event) => event.kind === "usage").at(-1)?.tokens ?? null;
});

const outcomeOf = Effect.fn("Compactors.outcomeOf")(function* (dir: string, mark: Marked) {
  const events = yield* readEvents(dir);
  const mine = Arr.filter(events, (event) => event.request === mark.id && fromMarked(event, mark));
  if (Arr.some(mine, (event) => event.kind === "done")) {
    return { kind: "success" } as const;
  }
  const failed = Option.getOrUndefined(
    Arr.findFirst(mine, (event) => event.kind === "failed" || event.kind === "cancelled"),
  );
  if (failed) {
    return {
      kind: "failure",
      reason: failed.message ?? failed.reason ?? "the harness reported an error",
    } as const;
  }
  return null;
});

export function atLeast(installed: string, wanted: string) {
  const parts = (text: string) =>
    Arr.map(
      Str.split(/(\d+(?:\.\d+)*)/.exec(text)?.[1] ?? "", "."),
      (n) => Number.parseInt(n, 10) || 0,
    );
  const have = parts(installed);
  const need = parts(wanted);
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const [h, n] = [have[i] ?? 0, need[i] ?? 0];
    if (h !== n) {
      return h > n;
    }
  }
  return true;
}

const FAILED_PROBE_TTL = Duration.minutes(1);

export class HarnessVersionError extends Data.TaggedError("HarnessVersionError")<{
  readonly harness: string;
  readonly message: string;
}> {}

const versions = Effect.runSync(
  Cache.makeWith(
    (harness: string) =>
      shell(harness, ["--version"], process.cwd()).pipe(
        Effect.flatMap(({ code, stdout }) =>
          code === 0
            ? Effect.succeed(
                Option.getOrUndefined(
                  Option.map(
                    Option.fromNullishOr(Str.split(Str.trim(stdout), "\n").at(-1)),
                    (present) => Str.trim(present),
                  ),
                ) ?? "",
              )
            : Effect.fail(
                new HarnessVersionError({
                  harness,
                  message: `cannot ask ${harness} its version (exit ${code})`,
                }),
              ),
        ),
      ),
    {
      capacity: VERIFIED_VERSIONS.size,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : FAILED_PROBE_TTL),
      requireServicesAt: "lookup",
    },
  ),
);

// WARNING: unknown is never treated as new enough; a gate that guessed would be no gate.
export const installedVersion = Effect.fn("Compactors.installedVersion")(function* (
  harness: string,
) {
  const { code, stdout } = yield* shell(harness, ["--version"], process.cwd()).pipe(
    Effect.orElseSucceed(() => ({
      code: 1,
      stdout: "",
      stderr: "",
    })),
  );
  if (code !== 0) {
    return null;
  }
  return (
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(Str.split(Str.trim(stdout), "\n").at(-1)), (present_) =>
        Str.trim(present_),
      ),
    ) || null
  );
});

const gateVersion = Effect.fn("Compactors.gateVersion")(function* (harness: string) {
  const wanted = VERIFIED_VERSIONS.get(harness);
  if (!wanted) {
    return;
  }
  const installed = yield* Cache.get(versions, harness);
  if (!atLeast(installed, wanted)) {
    return yield* new HarnessVersionError({
      harness,
      message: `${harness} ${installed || "(no version)"} is older than the ${wanted} its compaction controls support`,
    });
  }
});

// WARNING: loaded with -e, not written into ~/.pi, which would load into every Pi the human starts.
function piExtension(file: string, launch: string | null) {
  return `// Generated by Collie for one agent. Do not edit: it is rewritten at launch.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = ${stringifyJson(file)};
const KEEP = ${KEEP_LINES};
const KEEP_LIFECYCLE = ${KEEP_LIFECYCLE};
const USAGE_LIMIT = /usage limit|usage_limit|exceeded your current quota/i;
const LAUNCH = process.env.COLLIE_LAUNCH ?? ${stringifyJson(launch)};

export default function (pi) {
  let session = null;

  const kindOf = (line) => {
    try {
      return JSON.parse(line).kind;
    } catch {
      return undefined;
    }
  };

  // The newest identity line and the newest few compaction events, which is what a
  // waiting Run polls for: the cap drops the oldest of everything else instead.
  const protect = (lines) => {
    const keep = new Set();
    let lifecycle = 0;
    let bound = false;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const kind = kindOf(lines[i]);
      if (kind === "session") {
        if (bound) continue;
        bound = true;
      } else if (kind === undefined || kind === "usage" || lifecycle === KEEP_LIFECYCLE) {
        continue;
      } else lifecycle += 1;
      keep.add(i);
    }
    return keep;
  };

  // Read-slice-write rather than append, so one agent's telemetry stays bounded
  // however long it runs: only the newest sample and the current attempt are read.
  const write = (event) => {
    try {
      let kept = [];
      try {
        kept = readFileSync(FILE, "utf8").split("\\n").filter((line) => line.trim() !== "");
      } catch {
        // Nothing written yet.
      }
      let excess = kept.length - (KEEP - 1);
      if (excess > 0) {
        const keep = protect(kept);
        kept = kept.filter((line, at) => {
          if (excess === 0 || keep.has(at)) return true;
          excess -= 1;
          return false;
        });
        kept = kept.slice(-(KEEP - 1));
      }
      if (event.kind !== "session" && !kept.some((line) => kindOf(line) === "session")) {
        kept.push(JSON.stringify({ at: Date.now(), session, kind: "session" }));
      }
      kept.push(JSON.stringify({ at: Date.now(), session, launch: LAUNCH, ...event }));
      writeFileSync(FILE, \`\${kept.join("\\n")}\\n\`);
    } catch {
      // Telemetry is never worth breaking the human's agent for.
    }
  };

  // Pi's own session identity. Written whenever it changes, because a /new or a /resume
  // in this pane leaves every earlier sample describing a context that is gone.
  const bind = (ctx) => {
    const next = ctx.sessionManager.getSessionFile() ?? null;
    if (next === session) return;
    session = next;
    write({ kind: "session" });
  };

  // ctx.getContextUsage() is the estimate Pi's own compaction threshold and footer use.
  // It is undefined before the first assistant response and again after a compaction
  // until the next one, and that is reported as null rather than as zero.
  const sample = (ctx) => {
    bind(ctx);
    const usage = ctx.getContextUsage();
    const tokens = usage && typeof usage.tokens === "number" ? usage.tokens : null;
    write({ kind: "usage", tokens, transcript: ctx.sessionManager.getSessionFile() ?? undefined });
  };

  // How the last turn died, where it did: pi may still retry it until it settles.
  let died = null;
  pi.on("session_start", async (_event, ctx) => sample(ctx));
  pi.on("turn_end", async (event, ctx) => {
    sample(ctx);
    // pi does not retry a spent subscription, so an error stop saying so is the end of it.
    const message = event?.message;
    const said = String(message?.errorMessage ?? "");
    const error = message?.stopReason === "error";
    const out = error && USAGE_LIMIT.test(said) && !/overloaded/i.test(said);
    if (out)
      write({ kind: "out", reason: said, transcript: ctx.sessionManager.getSessionFile() ?? undefined });
    died = error && !out ? said : null;
  });
  pi.on("agent_settled", async (event, ctx) => {
    sample(ctx);
    if (died !== null && event?.aborted !== true)
      write({ kind: "stopped", reason: died || undefined, transcript: ctx.sessionManager.getSessionFile() ?? undefined });
    died = null;
  });

  // Recorded with their reason and no request id: a threshold or overflow compaction is
  // Pi's own, and must never satisfy a request Collie made.
  pi.on("session_compact", async (event, ctx) => {
    bind(ctx);
    write({ kind: "auto", reason: event.reason });
    sample(ctx);
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    bind(ctx);
    write({ kind: "auto", reason: event.reason, message: event.errorMessage ?? "" });
  });

  pi.registerCommand("collie-compact", {
    description: "Collie: compact this session and report the outcome",
    handler: async (args, ctx) => {
      // The first word: the prompt also carries its delivery token, on a line of its own.
      const request = String(args ?? "").trim().split(/\\s+/)[0] ?? "";
      if (request === "") return;
      bind(ctx);
      write({ kind: "start", request });
      // The callbacks are the correlation: they belong to this call and to no other
      // compaction the session may run.
      ctx.compact({
        onComplete: () => {
          write({ kind: "done", request });
          sample(ctx);
        },
        onError: (error) => {
          write({ kind: "failed", request, message: String(error?.message ?? error) });
        },
      });
    },
  });
}
`;
}

const pi: CompactionPort = {
  gate: gateVersion("pi"),
  install: (ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const extension = path.join(ctx.dir, "collie.ts");
      const launch = yield* launchLabel.pipe(Effect.orElseSucceed(() => null));
      yield* fs.writeFileString(extension, piExtension(path.join(ctx.dir, TELEMETRY), launch));
      return { args: ["-e", extension] };
    }),
  usage: (ctx) => latestUsage(ctx.dir),
  records: (ctx) =>
    transcriptsIn(ctx.dir).pipe(
      Effect.map(Arr.map((path) => ({ path, format: "pi", parent: null }) satisfies Source)),
    ),
  ready: reported,
  exitOf: (ctx) => Effect.map(stoppedSince(ctx.dir, 0), (one) => one?.why ?? null),
  // WARNING: the human's channel, so a refusal from herdr is a request that never left.
  request: (ctx, requestId) => submitCompaction(ctx, requestId, `/collie-compact ${requestId}`),
  mark: (ctx) => claudeMark(ctx.dir),
  poll: (ctx, mark) => outcomeOf(ctx.dir, mark),
};

export class Submitting extends Data.TaggedError("Submitting")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const submitting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new Submitting({ message: reason(cause), cause })));

const beforeSubmitting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof Submitting ? cause : new Unsubmitted({ message: reason(cause), cause }),
    ),
  );

// WARNING: every field optional, so a renamed field makes the sample unavailable rather than crashing the human's status line.
const ClaudePayload = Schema.Struct({
  session_id: Schema.optionalKey(Schema.String),
  hook_event_name: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  error_details: Schema.optionalKey(Schema.String),
  transcript_path: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  custom_instructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rate_limits: Schema.optionalKey(Schema.Unknown),
  tool_name: Schema.optionalKey(Schema.String),
  tool_use_id: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Unknown),
  context_window: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        total_input_tokens: Schema.optionalKey(Schema.Finite),
        total_output_tokens: Schema.optionalKey(Schema.Finite),
        used_percentage: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        // WARNING: null before the first call and after a compaction; a zero there is not a measurement.
        current_usage: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ input_tokens: Schema.optionalKey(Schema.Finite) })),
        ),
      }),
    ),
  ),
});
const decodeClaudePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudePayload));

export const AgentQuestion = Schema.Struct({
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) }),
  ),
  multiSelect: Schema.optionalKey(Schema.Boolean),
});
export type AgentQuestion = typeof AgentQuestion.Type;

const AskedQuestions = Schema.Struct({ questions: Schema.NonEmptyArray(AgentQuestion) });
const decodeAsked = Schema.decodeUnknownOption(AskedQuestions);

export const piQuestionTool = (self: ReadonlyArray<string>, dir: string) => {
  const document = Schema.toJsonSchemaDocument(AskedQuestions);
  return {
    name: "ask_user_question",
    label: "Ask the human",
    description:
      'Ask the human one or more questions. Give each at least three options, each with a description of what it leads to, and end exactly one option\'s label with " (Recommended)". The questions go on your Run, and the answers arrive as your next message.',
    // WARNING: a JSON Schema document is JSON.
    parameters: { ...document.schema, $defs: document.definitions } as JsonObject,
    helper: [...self, "herdr", "compaction", dir],
  };
};

export const AskedCall = Schema.Struct({
  at: Schema.Finite,
  session: Schema.NullOr(Schema.String),
  id: Schema.String,
  questions: Schema.Array(AgentQuestion),
  repair: Schema.optionalKey(Schema.Literals(["in-reply", "by-delivery"])),
});
export type AskedCall = typeof AskedCall.Type;

const repairs = (last: AskedCall | undefined, questions: ReadonlyArray<AgentQuestion>) =>
  last?.repair === undefined && !Arr.every(questions, isToStandard);
const encodeAskedCall = flow(
  Schema.encodeResult(Schema.fromJsonString(AskedCall)),
  Result.getOrThrow,
);
const decodeAskedCall = Schema.decodeUnknownOption(Schema.fromJsonString(AskedCall));

// WARNING: the telemetry cap trims lines, so questions live in their own file that the cap leaves alone.
export const QUESTIONS = "questions.jsonl";

const deniedWith = (reason: string) =>
  stringifyJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

const DENIED_QUESTION = deniedWith(
  "Collie has put your question on your Run for a human to answer. End your turn now: the answer will be your next message.",
);

export const UNREPAIRED = "#unrepaired";

export const postUnrepaired = Effect.fn("Compactors.postUnrepaired")(function* (
  dir: string,
  call: AskedCall,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const asked: AskedCall = {
    at: call.at,
    session: call.session,
    id: `${call.id}${UNREPAIRED}`,
    questions: call.questions,
  };
  yield* fs.writeFileString(path.join(dir, QUESTIONS), `${encodeAskedCall(asked)}\n`, {
    flag: "a",
  });
  return asked;
});

export const questionsSince = Effect.fn("Compactors.questionsSince")(function* (
  dir: string,
  since: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(dir, QUESTIONS))
    .pipe(Effect.orElseSucceed(() => ""));
  return Arr.filter(
    Arr.flatMap(Str.split(text, "\n"), (line) => Option.toArray(decodeAskedCall(line))),
    (call) => call.at >= since,
  );
});
export const takeHarnessQuestions = Effect.fn("Compactors.takeHarnessQuestions")(function* (
  stateDir: string,
  ports: CompactionPorts,
  agent: string,
) {
  const record = yield* readControl(stateDir, agent);
  const read = record === null ? undefined : ports[record.harness]?.questions;
  if (record === null || read === undefined) {
    return;
  }
  const asked = yield* read(record).pipe(Effect.orElseSucceed(() => []));
  const recorded = yield* questionsSince(record.dir, 0);
  const known = new Set(Arr.map(recorded, (call) => call.id));
  const fresh = Arr.filter(asked, (call) => !known.has(call.id));
  if (fresh.length === 0) {
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = yield* Clock.currentTimeMillis;
  let last = recorded.at(-1);
  const lines = Arr.map(fresh, (call) => {
    const line: AskedCall = repairs(last, call.questions)
      ? { at, session: null, id: call.id, questions: call.questions, repair: "by-delivery" }
      : { at, session: null, id: call.id, questions: call.questions };
    last = line;
    return encodeAskedCall(line);
  });
  yield* fs.writeFileString(path.join(record.dir, QUESTIONS), `${Arr.join(lines, "\n")}\n`, {
    flag: "a",
  });
});
const decodeLimits = Schema.decodeUnknownOption(StatusLineLimits);

const newestIn: (text: string) => StatusSample | null = (text) => {
  let newest: StatusSample | null = null;
  for (const line of Str.split(text, "\n")) {
    const event = Option.getOrNull(decodeEvent(line));
    if (event?.limits && (newest === null || event.at > newest.at)) {
      newest = { at: event.at, limits: event.limits };
    }
  }
  return newest;
};

// WARNING: decodes only agents whose telemetry changed by size and mtime; a status line rewrites its file on every event.
export const rateLimitsReader = Effect.fn("Compactors.rateLimitsReader")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, CONTROL_DIR);
  const read = new Map<
    string,
    { readonly size: bigint; readonly mtime: number; readonly newest: StatusSample | null }
  >();
  const newestNow = Effect.gen(function* () {
    const agents = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const present = new Set(agents);
    for (const agent of read.keys()) {
      if (!present.has(agent)) {
        read.delete(agent);
      }
    }
    let newest: StatusSample | null = null;
    for (const agent of agents) {
      const file = path.join(root, agent, TELEMETRY);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info)) {
        read.delete(agent);
        continue;
      }
      const size = BigInt(info.value.size);
      const mtime = Option.match(info.value.mtime, {
        onNone: () => -1,
        onSome: (at) => at.getTime(),
      });
      let known = read.get(agent);
      if (known === undefined || known.size !== size || known.mtime !== mtime) {
        const text = yield* fs.readFileString(file).pipe(Effect.option);
        if (Option.isSome(text)) {
          known = { size, mtime, newest: newestIn(text.value) };
          read.set(agent, known);
        }
      }
      const sample = known?.newest ?? null;
      if (sample !== null && (newest === null || sample.at > newest.at)) {
        newest = sample;
      }
    }
    return newest;
  });
  return { newest: newestNow };
});

export const newestRateLimits = (stateDir: string) =>
  Effect.flatMap(rateLimitsReader(stateDir), (reader) => reader.newest);

// WARNING: Claude's compaction has no request id; its instructions are the one field surviving into a hook, which tells Collie's request from a human's /compact.
const CLAUDE_MARKER = /\(collie:([A-Za-z0-9-]+)\)/;

// WARNING: the opening tag is the only sign, and it is checked before the delivery token, since a task's output can quote one.
const CLAUDE_INJECTED = ["<task-notification>", "<agent-message "];

function claudeInstructions(requestId: string) {
  return `Keep the work in progress, the decisions taken and what is left to do. (collie:${requestId})`;
}

// WARNING: the status-line case must print Claude's line back, or the human's own status bar goes blank.
export const recordClaudeEvent = Effect.fn("Compactors.recordClaudeEvent")(function* (
  dir: string,
  stdin: string,
) {
  const decoded = decodeClaudePayload(stdin);
  if (decoded._tag === "None") {
    return "";
  }
  const payload = decoded.value;
  const session = payload.session_id ?? null;
  const launch = yield* launchLabel;
  const record = (event: Omit<TelemetryEvent, "at" | "launch">) =>
    recordEvent(dir, { launch, ...event });
  const window = payload.context_window ?? null;
  const measured = (window?.current_usage ?? null) !== null;
  const tokens = measured
    ? (window?.total_input_tokens ?? 0) + (window?.total_output_tokens ?? 0)
    : null;

  const event = payload.hook_event_name;
  if (event === "UserPromptSubmit") {
    // WARNING: the prompt is not stored whole; only who submitted it is kept.
    const prompt = payload.prompt ?? "";
    const delivery = carriedDelivery(prompt);
    yield* record(
      Arr.some(CLAUDE_INJECTED, (tag) => pipe(prompt, Str.startsWith(tag)))
        ? { session, kind: "submit", reason: "harness" }
        : delivery === null
          ? { session, kind: "submit", reason: "external" }
          : { session, kind: "submit", reason: "collie", delivery },
    );
    return "";
  }
  if (event === "PreToolUse") {
    const asked = payload.tool_name === "AskUserQuestion" ? decodeAsked(payload.tool_input) : null;
    if (asked === null || asked._tag === "None") {
      return "";
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const owner = yield* lockHolder(hostLockOf(path.dirname(path.dirname(dir))));
    if (owner === null || !(yield* holderLives(owner))) {
      return "";
    }
    const at = yield* Clock.currentTimeMillis;
    const { questions } = asked.value;
    const repairing = repairs((yield* questionsSince(dir, 0)).at(-1), questions);
    const call: AskedCall = { at, session, id: payload.tool_use_id ?? String(at), questions };
    const line = encodeAskedCall(repairing ? { ...call, repair: "in-reply" } : call);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, QUESTIONS), `${line}\n`, { flag: "a" });
    // WARNING: nothing watches the file, so the host must be told for the question to reach the Run.
    yield* tellHost(path.dirname(path.dirname(dir)), [path.join(dir, QUESTIONS)]);
    return repairing ? deniedWith(questionRepair(questions)) : DENIED_QUESTION;
  }
  const transcript = payload.transcript_path;
  if (event === "StopFailure") {
    // WARNING: StopFailure fires once Claude has given up on the turn; an overload stops nothing.
    const error = payload.error ?? "unknown";
    if (error === "rate_limit" || error === "billing_error") {
      yield* record({
        session,
        kind: "out",
        reason: (yield* lastFullWindow(dir)) ?? error,
        ...(transcript && { transcript }),
      });
    } else if (error !== "overloaded") {
      yield* record({
        session,
        kind: "stopped",
        reason: payload.error_details ?? error,
        ...(transcript && { transcript }),
      });
    }
    return "";
  }
  if (event === "PreCompact" || event === "PostCompact") {
    const request =
      event === "PreCompact" && payload.trigger === "manual"
        ? CLAUDE_MARKER.exec(payload.custom_instructions ?? "")?.[1]
        : undefined;
    yield* record(
      request
        ? { session, kind: "start", request, ...(transcript && { transcript }) }
        : {
            session,
            kind: "auto",
            reason: payload.trigger ?? "unknown",
            phase: event === "PreCompact" ? "pre" : "post",
          },
    );
    return "";
  }

  const limits = Option.getOrUndefined(decodeLimits(payload.rate_limits));
  yield* record({
    session,
    kind: "usage",
    tokens,
    ...(limits && { limits }),
    ...(transcript && { transcript }),
  });
  const now = yield* Clock.currentTimeMillis;
  const full =
    limits && Arr.some(statusLineWindows(limits), (window) => isFull(current(window, now)));
  const told = Arr.some(
    yield* readEvents(dir).pipe(Effect.orElseSucceed(() => [])),
    (one) => one.kind === "out",
  );
  if (full && !told) {
    yield* record({
      session,
      kind: "out",
      reason: (yield* lastFullWindow(dir)) ?? "a window at 100%",
      ...(transcript && { transcript }),
    });
  }
  const percent = window?.used_percentage;
  return percent === null || percent === undefined
    ? "context: not measured yet"
    : `context: ${Math.round(percent)}%`;
});

// WARNING: additional settings, never a rewrite; matched on manual and auto because an automatic compaction invalidates a sample.
export function claudeSettings(dir: string, stopFailure: boolean) {
  const helper = Result.getOrThrow(
    CommandLine.join([...selfCommand(), "herdr", "compaction", dir]),
  );
  const hook = { matcher: "manual|auto", hooks: [{ type: "command", command: helper }] };
  // WARNING: UserPromptSubmit is the only place a submitted turn is visible; with no matcher every submission counts.
  const submitted = { hooks: [{ type: "command", command: helper }] };
  const failed = { hooks: [{ type: "command", command: helper }] };
  return `${stringifyJson(
    {
      statusLine: { type: "command", command: helper },
      hooks: {
        PreCompact: [hook],
        PostCompact: [hook],
        UserPromptSubmit: [submitted],
        PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: helper }] }],
        ...(stopFailure && { StopFailure: [failed] }),
      },
    },
    2,
  )}\n`;
}

export const claudeMark = Effect.fn("Compactors.claudeMark")(function* (dir: string) {
  const events = yield* readEvents(dir).pipe(Effect.orElseSucceed(() => []));
  const bound = Option.getOrUndefined(
    Arr.findLast(events, (event) => event.session !== null && event.session !== undefined),
  );
  return {
    session: bound?.session ?? null,
    launch: bound?.launch ?? null,
    transcript:
      Option.getOrUndefined(Arr.findLast(events, (event) => event.transcript !== undefined))
        ?.transcript ?? null,
  };
});

// WARNING: the request id alone is not the caller: another launch of the same session writes the same one.
// WARNING: a request with no launch recorded has no proof of its caller, so nothing settles it.
const fromMarked = (
  event: TelemetryEvent,
  mark: { readonly session: string | null; readonly launch: string | null },
) =>
  mark.launch !== null &&
  (event.launch ?? null) === mark.launch &&
  (mark.session === null || event.session === mark.session);

// WARNING: PostCompact carries nothing of the request, so only the marked start's own session finishing it counts.
const claudeOutcome = Effect.fn("Compactors.claudeOutcome")(function* (dir: string, mark: Marked) {
  const events = yield* readEvents(dir);
  // WARNING: a conversation id outlives a launch, so only the launch's own events prove this request finished.
  const fromMarked = (event: TelemetryEvent) =>
    mark.launch !== null &&
    event.launch === mark.launch &&
    (mark.session === null || event.session === mark.session);
  const at = Option.getOrElse(
    Arr.findLastIndex(
      events,
      (event) => event.kind === "start" && event.request === mark.id && fromMarked(event),
    ),
    () => -1,
  );
  if (at < 0) {
    return null;
  }
  const incarnation = mark.session ?? events[at]!.session;
  for (const event of events.slice(at + 1)) {
    if (event.kind === "cancelled" && event.request === mark.id) {
      return { kind: "failure", reason: event.reason ?? "its compaction was cancelled" } as const;
    }
    if (event.kind === "start") {
      return null;
    }
    if (event.kind !== "auto" || event.reason !== "manual") {
      continue;
    }
    if (event.phase === "pre") {
      return null;
    }
    // WARNING: another launch of the same conversation is another agent's compaction, not this request's.
    if (event.session !== incarnation || !fromMarked(event)) {
      return null;
    }
    // WARNING: a hole since the request leaves it unresolved, not a success.
    return (yield* lostSince(dir, events[at]!.at)) ? null : ({ kind: "success" } as const);
  }
  return null;
});

const claudeReconcile = Effect.fn("Compactors.claudeReconcile")(function* (
  dir: string,
  mark: Marked,
  since: number,
) {
  if (mark.transcript === null || mark.launch === null) {
    return null;
  }
  // WARNING: a conversation id outlives a launch, so a launch that took it over asked for nothing of this request's.
  const events = yield* readEvents(dir).pipe(Effect.orElseSucceed(() => []));
  const takenOver = Arr.some(
    events,
    (one) =>
      (one.kind === "start" || one.kind === "session") &&
      one.session === mark.session &&
      (one.launch ?? null) !== null &&
      (one.launch ?? null) !== mark.launch &&
      one.at >= since,
  );
  // WARNING: a marked request leaves its own launch's start in the telemetry; without it nothing says who wrote the boundary.
  const asked = Arr.some(
    events,
    (one) =>
      (one.kind === "start" || one.kind === "session") &&
      (one.launch ?? null) === mark.launch &&
      one.session === mark.session,
  );
  if (takenOver || !asked) {
    return null;
  }
  const text = yield* (yield* FileSystem.FileSystem).readFileString(mark.transcript);
  const lines = Str.split(text, "\n");
  let named = false;
  let markers = 0;
  let candidates = 0;
  for (const line of lines) {
    const entry = Option.getOrUndefined(decodeTranscriptLine(line));
    if (entry === undefined) {
      continue;
    }
    // WARNING: the turn that typed the marker is the only turn whose compaction is the request's.
    if (entry.type === "user") {
      const request = namedRequest(entry);
      named = request === mark.id;
      markers += named ? 1 : 0;
      continue;
    }
    if (entry.type === "assistant") {
      named = false;
      continue;
    }
    if (
      named &&
      manualBoundary(entry) &&
      writerOf(entry, mark) &&
      epochMs(entry.timestamp) >= since
    ) {
      candidates += 1;
      if (candidates > 1) {
        return null;
      }
    }
  }
  return markers === 1 && candidates === 1 ? ({ kind: "success" } as const) : null;
});

const lastFullWindow = Effect.fn("Compactors.lastFullWindow")(function* (dir: string) {
  const sampled = Option.getOrUndefined(
    Arr.findLast(
      yield* readEvents(dir).pipe(Effect.orElseSucceed(() => [])),
      (one) => one.limits !== undefined,
    ),
  )?.limits;
  const now = yield* Clock.currentTimeMillis;
  const windows = sampled
    ? Arr.map(statusLineWindows(sampled), (window) => current(window, now))
    : [];
  const [busiest] = Arr.sortWith(
    windows,
    (value) => value,
    (a, b) => Num.sign(b.usedPercent - a.usedPercent),
  );
  if (busiest === undefined) {
    return null;
  }
  const reset = busiest.resetsAt === null ? "" : `, ${resetPhrase(busiest.resetsAt, now)}`;
  return `${Str.toLowerCase(busiest.label)} ${Math.round(busiest.usedPercent)}%${reset}`;
});

// WARNING: StopFailure exists only from this Claude Code version; older ones are left to their status line.
const CLAUDE_STOP_FAILURE = "2.1.291";

export const ranOutSince = Effect.fn("Compactors.ranOutSince")(function* (
  dir: string,
  since: number,
) {
  const out = Option.getOrUndefined(
    Arr.findLast(
      yield* readEvents(dir).pipe(Effect.orElseSucceed(() => [])),
      (event) => event.kind === "out" && event.at >= since,
    ),
  );
  return out === undefined
    ? null
    : { why: out.reason ?? "its usage ran out", transcript: out.transcript ?? null };
});

export const stoppedSince = Effect.fn("Compactors.stoppedSince")(function* (
  dir: string,
  since: number,
) {
  const stopped = Option.getOrUndefined(
    Arr.findLast(
      yield* readEvents(dir).pipe(Effect.orElseSucceed(() => [])),
      (event) => event.kind === "stopped" && event.at >= since,
    ),
  );
  return stopped === undefined
    ? null
    : {
        why: stopped.reason ?? "its turn ended on an error",
        transcript: stopped.transcript ?? null,
      };
});

export const transcriptOf = Effect.fn("Compactors.transcriptOf")(function* (
  stateDir: string,
  agent: string,
) {
  const path = yield* Path.Path;
  const events = yield* readEvents(path.join(stateDir, CONTROL_DIR, agent)).pipe(
    Effect.orElseSucceed(() => []),
  );
  return (
    Option.getOrUndefined(Arr.findLast(events, (event) => event.transcript !== undefined))
      ?.transcript ?? null
  );
});

const transcriptsIn = (dir: string) =>
  readEvents(dir).pipe(
    Effect.map((events) =>
      Arr.dedupe(Arr.getSomes(Arr.map(events, (event) => Option.fromNullishOr(event.transcript)))),
    ),
  );

const claudeRecords = Effect.fn("Compactors.claudeRecords")(function* (ctx: AgentContext) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sources: Array<Source> = [];
  for (const transcript of yield* transcriptsIn(ctx.dir)) {
    sources.push({ path: transcript, format: "claude", parent: null });
    const session = path.basename(transcript, ".jsonl");
    const subagents = path.join(path.dirname(transcript), session, "subagents");
    const names = yield* fs.readDirectory(subagents).pipe(Effect.orElseSucceed(() => []));
    for (const name of Arr.sort(names, Order.String)) {
      if (Str.endsWith(".jsonl")(name)) {
        sources.push({ path: path.join(subagents, name), format: "claude", parent: session });
      }
    }
  }
  return sources;
});

const COMPACT_ARGS =
  /^Keep the work in progress, the decisions taken and what is left to do\. \(collie:([A-Za-z0-9-]+)\)$/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const CLAUDE_COMMAND = /^\/compact\s+([\s\S]*)$/;
const PI_COMMAND = /^\/collie-compact ([A-Za-z0-9-]+)$/;
const asText = Schema.decodeUnknownOption(Schema.String);

const identifier = (captured: string | undefined) => captured ?? null;

// WARNING: a request is named by the command that asked for it, word for word, never by a mention of its marker.
const namedRequest = (entry: {
  readonly message?: { readonly content?: unknown };
  readonly type?: string;
}) => {
  const said = Str.trim(Option.getOrElse(asText(entry.message?.content), () => ""));
  if (entry.type === "message") {
    return identifier(PI_COMMAND.exec(said)?.[1]);
  }
  const tagged = COMMAND_NAME.exec(said);
  const args = tagged === null ? CLAUDE_COMMAND.exec(said)?.[1] : COMMAND_ARGS.exec(said)?.[1];
  const named = tagged === null || Str.trim(tagged[1] ?? "") === "/compact";
  return named && args !== undefined ? identifier(COMPACT_ARGS.exec(Str.trim(args))?.[1]) : null;
};

const boundary = (line: { readonly type?: string; readonly subtype?: string }) =>
  line.type === "system" && line.subtype === "compact_boundary";

const manualBoundary = (line: {
  readonly type?: string;
  readonly subtype?: string;
  readonly compactMetadata?: { readonly trigger?: string };
}) => boundary(line) && line.compactMetadata?.trigger === "manual";

// WARNING: a relaunch appends to the same conversation file, so the line's own writer is what tells it apart.
const writerOf = (
  entry: { readonly sessionId?: string },
  mark: { readonly session: string | null },
) => mark.session !== null && entry.sessionId === mark.session;

const decodeTranscriptLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      subtype: Schema.optionalKey(Schema.String),
      compactMetadata: Schema.optionalKey(
        Schema.Struct({ trigger: Schema.optionalKey(Schema.String) }),
      ),
      timestamp: Schema.String,
      sessionId: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Schema.Json) })),
    }),
  ),
);

// WARNING: for a harness whose attempt cannot be told to stop, the record is the only disposition left.
export const recordCancelled = (
  dir: string,
  mark: { readonly id: string; readonly session: string | null; readonly launch?: string | null },
  why: string,
) =>
  recordEvent(dir, {
    session: mark.session,
    launch: mark.launch ?? undefined,
    kind: "cancelled",
    request: mark.id,
    reason: why,
  });

const claude: CompactionPort = {
  gate: gateVersion("claude"),
  install: (ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = path.join(ctx.dir, "settings.json");
      const installed = yield* installedVersion("claude");
      const stopFailure = installed !== null && atLeast(installed, CLAUDE_STOP_FAILURE);
      yield* fs.writeFileString(settings, claudeSettings(ctx.dir, stopFailure));
      return { args: ["--settings", settings] };
    }),
  usage: (ctx) => latestUsage(ctx.dir),
  records: claudeRecords,
  // WARNING: the status line is drawn with the REPL, so its first call means the prompt is there.
  ready: reported,
  exitOf: (ctx) => Effect.map(stoppedSince(ctx.dir, 0), (one) => one?.why ?? null),
  request: (ctx, requestId) =>
    submitCompaction(ctx, requestId, `/compact ${claudeInstructions(requestId)}`),
  mark: (ctx) => claudeMark(ctx.dir),
  // WARNING: no documented compact-failed hook exists, so poll can only return success or nothing.
  poll: (ctx, mark) => claudeOutcome(ctx.dir, mark),
  reconcile: (ctx, mark, since) => claudeReconcile(ctx.dir, mark, since),
  cancel: (ctx, mark, why) =>
    recordEvent(ctx.dir, {
      session: mark.session,
      kind: "cancelled",
      request: mark.id,
      reason: why,
    }),
};

export const ServerStartDeadline = Context.Reference<Duration.Duration | null>(
  "collie/ServerStartDeadline",
  { defaultValue: () => null },
);

export const servedEndpoint = Effect.fn("Compactors.servedEndpoint")(function* (opts: {
  cwd: string;
  log: string;
  command: string;
  listening: RegExp;
  startMs: number;
  what: string;
  env?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  // WARNING: created before the server so the wait never reads a missing file.
  yield* fs.writeFileString(opts.log, "");
  const log = yield* Effect.orDie(Effect.fromResult(CommandLine.quote(opts.log)));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pid = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "sh",
          ["-c", Arr.join([...(opts.env ?? []), `exec ${opts.command} >${log} 2>&1`], "\n")],
          {
            cwd: opts.cwd,
            extendEnv: true,
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      );
      // WARNING: unref before the scope closes, or the spawner's finalizer kills the server it just started.
      yield* Effect.asVoid(handle.unref);
      return handle.pid;
    }),
  );

  const budget = (yield* ServerStartDeadline) ?? Duration.millis(opts.startMs);
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(budget);
  const said = yield* fs.readFileString(opts.log).pipe(
    Effect.map((log) => opts.listening.exec(log)),
    Effect.repeat({
      until: (said) => said !== null,
      schedule: Schedule.spaced(200).pipe(Schedule.while(({ now }) => now < deadline)),
    }),
  );
  if (said) {
    return { pid, found: said[1] ?? "" };
  }
  return yield* new Cause.TimeoutError(
    `${opts.what} did not come up within ${opts.startMs}ms — see ${opts.log}`,
  );
});

// WARNING: a loopback port 0, not a picked port (which races); unix:// binds but nothing sent over it is answered on 0.153.4.
const CODEX_SERVER = "codex app-server";
const CODEX_LOG = "app-server.log";
const CODEX_LISTENING = /ws:\/\/127\.0\.0\.1:(\d+)/;
const CODEX_START_MS = 20_000;

const codexEndpoint = Effect.fn("Compactors.codexEndpoint")(function* (
  ctx: LaunchContext,
  server: string,
) {
  const path = yield* Path.Path;
  const served = yield* servedEndpoint({
    cwd: ctx.cwd,
    log: path.join(ctx.dir, CODEX_LOG),
    command: Arr.join(
      [
        `${server} --listen ws://127.0.0.1:0`,
        ...(yield* Effect.orDie(
          Effect.forEach(ctx.mcp ?? [], (word) => Effect.fromResult(CommandLine.quote(word))),
        )),
      ],
      " ",
    ),
    listening: CODEX_LISTENING,
    startMs: CODEX_START_MS,
    what: "codex app-server",
    env: ctx.env,
  });
  return { endpoint: `ws://127.0.0.1:${served.found}`, pid: served.pid, command: server };
});

const codexAt = (ctx: ReadyContext) =>
  ctx.endpoint === null
    ? Effect.fail(
        new Cause.NoSuchElementError(`${ctx.agent} has no Codex App Server endpoint recorded`),
      )
    : Effect.succeed(ctx.endpoint);

// WARNING: one SIGTERM only, never SIGKILL; running turns are interrupted first.
const stopCodex = (
  target: StopTarget,
  note: (line: string) => Effect.Effect<void>,
  budgetMs: number,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
    const signalled = [...target.signalled];
    const before = (one: SeenProcess) =>
      Arr.some(signalled, (seen) => seen.pid === one.pid && seen.started === one.started);
    const once = (one: SeenProcess) =>
      before(one)
        ? Effect.void
        : terminate(one.pid).pipe(
            Effect.tap(() =>
              Effect.sync(() => signalled.push({ pid: one.pid, started: one.started })),
            ),
          );
    const server = yield* processOf(target.pid);
    const refused: (why: string) => Stopped = (why) => ({
      state: "failed",
      turns: null,
      reason: why,
      signalled,
      left: [],
      noted: target.noted,
    });
    if (server === null && !(yield* processAbsent(target.pid))) {
      return refused(`pid ${target.pid} is live but its process identity could not be read`);
    }
    if (server === null) {
      return yield* survivors(
        target.pid,
        target.noted,
        null,
        deadline,
        "failed",
        signalled,
        once,
        false,
      );
    }
    if (!pipe(server.command, Str.includes(target.command))) {
      return refused(`pid ${target.pid} is \`${server.command}\`, not \`${target.command}\``);
    }
    if (target.started !== null && server.started !== target.started) {
      return refused(`pid ${target.pid} started at ${server.started}, not ${target.started}`);
    }

    let turns: Stopped["turns"] = null;
    let session: Array<ProcessInfo> = [];
    const noted = [...target.noted];
    let inspected = false;
    let submitted = 0;
    let acknowledged = 0;
    const short: () => Stopped["state"] = () =>
      acknowledged > 0 ? "acknowledged" : submitted > 0 ? "submitted" : "failed";
    const seen: (one: ProcessInfo) => SeenProcess = (one) => ({
      pid: one.pid,
      started: one.started,
    });
    const notQuiet: (reason: string) => Stopped = (reason) => ({
      state: short(),
      turns,
      reason,
      signalled,
      left: Arr.map([server, ...session], seen),
      noted,
    });
    return yield* withCodex(target.endpoint, (client) =>
      Effect.gen(function* () {
        const threads = yield* agentThreads(client, target.cwd);
        const running = Arr.flatMap(threads, (thread) =>
          Arr.map(thread.running, (turn) => ({
            thread: thread.id,
            turn,
            transcript: thread.transcript,
          })),
        );
        turns = running;
        session = yield* sessionOf(target.pid);
        inspected = yield* stillRunning(server);
        for (const one of session) {
          if (!Arr.some(noted, (seen) => seen.pid === one.pid && seen.started === one.started)) {
            noted.push(seen(one));
          }
        }
        yield* once(server);
        const interrupt = (one: (typeof running)[number]) =>
          Effect.gen(function* () {
            const about = `thread ${one.thread} turn ${one.turn}, server ${target.endpoint} pid ${target.pid}${one.transcript === null ? "" : `, transcript ${one.transcript}`}`;
            submitted++;
            yield* note(`${target.agent}: interrupt submitted — ${about}`);
            // WARNING: a refusal is read back rather than believed: the turn may have ended anyway.
            const answered = yield* interruptTurn(client, one.thread, one.turn).pipe(Effect.result);
            if (answered._tag === "Success") {
              acknowledged++;
              yield* note(`${target.agent}: interrupt acknowledged — ${about}`);
            } else {
              yield* note(
                `${target.agent}: interrupt refused (${reason(answered.failure)}) — ${about}`,
              );
            }
          });
        for (const one of running) {
          if (!(yield* stillRunning(server))) {
            break;
          }
          yield* interrupt(one);
        }
        for (;;) {
          if (!(yield* stillRunning(server))) {
            return yield* survivors(
              target.pid,
              noted,
              running,
              deadline,
              short(),
              signalled,
              once,
              inspected,
            );
          }
          // WARNING: read back rather than assumed, every thread again: a lost connection is not a turn that ended, and a sub-agent's turn starts after the first listing.
          let unread: string | null = null;
          const unended: typeof running = [];
          const listed = yield* agentThreads(client, target.cwd).pipe(Effect.result);
          if (listed._tag === "Failure") {
            unread = reason(listed.failure);
            unended.push(...running);
          } else {
            for (const thread of listed.success) {
              for (const turn of thread.running) {
                let one = Option.getOrUndefined(
                  Arr.findFirst(
                    running,
                    (asked) => asked.thread === thread.id && asked.turn === turn,
                  ),
                );
                if (one === undefined) {
                  one = { thread: thread.id, turn, transcript: thread.transcript };
                  running.push(one);
                  yield* interrupt(one);
                }
                unended.push(one);
              }
            }
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            const seconds = Math.round(budgetMs / 1000);
            return notQuiet(
              unread !== null
                ? `its turns could not be read back (${unread}), and its server is still up after ${seconds}s`
                : unended.length > 0
                  ? `${Arr.join(
                      Arr.map(unended, (one) => `turn ${one.turn}`),
                      ", ",
                    )} still running after ${seconds}s`
                  : `its server is still up after ${seconds}s`,
            );
          }
          yield* Effect.sleep(50);
        }
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (yield* stillRunning(server)) {
            return notQuiet(reason(cause));
          }
          return yield* survivors(
            target.pid,
            noted,
            turns,
            deadline,
            short(),
            signalled,
            once,
            inspected,
          );
        }),
      ),
    );
  });

const SURVIVOR_GRACE_MS = 2000;

// WARNING: an unnoted process is named and left alone; only the noted processes get the SIGTERM.
const survivors = (
  root: number,
  noted: ReadonlyArray<SeenProcess>,
  turns: Stopped["turns"],
  deadline: number,
  short: Stopped["state"],
  signalled: ReadonlyArray<SeenProcess>,
  once: (one: SeenProcess) => Effect.Effect<void>,
  inspected: boolean,
) =>
  Effect.gen(function* () {
    const proven = (one: SeenProcess) =>
      Arr.some(noted, (seen) => seen.pid === one.pid && seen.started === one.started);
    const sessions = yield* readsSessions;
    if (!sessions && !inspected) {
      return {
        state: "failed",
        turns,
        reason:
          "its server exited before its session could be inspected; this platform cannot establish whether its child processes have stopped",
        signalled,
        left: noted,
        noted,
      } satisfies Stopped;
    }
    const absent = yield* processAbsent(root).pipe(
      Effect.repeat({
        until: Boolean,
        schedule: Schedule.spaced(50).pipe(Schedule.while(({ now }) => now < deadline)),
      }),
    );
    if (!absent) {
      return yield* new Cause.UnknownError(root, `server process ${root} is not proven absent`);
    }
    const remaining = Effect.gen(function* () {
      return sessions
        ? yield* sessionOf(root)
        : yield* Effect.filter(noted, (one) =>
            Effect.gen(function* () {
              const now = yield* processOf(one.pid);
              if (now !== null) {
                return now.started === one.started;
              }
              if (yield* processAbsent(one.pid)) {
                return false;
              }
              return yield* new Cause.UnknownError(
                one.pid,
                `process ${one.pid} could not be inspected`,
              );
            }),
          );
    });
    for (const one of yield* remaining) {
      if (proven(one)) {
        yield* once(one);
      }
    }
    const until = Math.max(deadline, (yield* Clock.currentTimeMillis) + SURVIVOR_GRACE_MS);
    const left = yield* remaining.pipe(
      Effect.repeat({
        until: (left) => left.length === 0,
        schedule: Schedule.spaced(50).pipe(Schedule.while(({ now }) => now < until)),
      }),
    );
    if (left.length === 0) {
      return {
        state: "quiet",
        turns,
        reason: null,
        signalled,
        left: [],
        noted,
      } satisfies Stopped;
    }
    const named = Arr.map(
      left,
      (one) =>
        `pid ${one.pid}${proven(one) || Arr.some(signalled, (seen) => seen.pid === one.pid && seen.started === one.started) ? "" : " (not signalled: not proven its)"}`,
    );
    return {
      state: short,
      turns,
      reason: `its server exited, but ${Arr.join(named, ", ")} of its session is still running`,
      signalled,
      left: Arr.map(left, (one) => ({ pid: one.pid, started: one.started })),
      noted,
    } satisfies Stopped;
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed<Stopped>({
        state: "failed",
        turns,
        reason: `its server or child processes could not be proven stopped (${reason(cause)})`,
        signalled,
        left: noted,
        noted,
      }),
    ),
  );

export const codexPort: (server: string) => CompactionPort = (server) => ({
  gate: gateVersion("codex"),
  ready: (ctx) =>
    ctx.endpoint === null
      ? Effect.succeed(false)
      : codexReachable(ctx.endpoint).pipe(Effect.as(true)),
  install: (ctx) =>
    codexEndpoint(ctx, server).pipe(
      Effect.map(({ endpoint, pid, command }) => ({
        args: ["--remote", endpoint],
        endpoint,
        pid,
        command,
      })),
    ),
  stop: stopCodex,
  questions: (ctx) =>
    Effect.gen(function* () {
      const url = yield* codexAt(ctx);
      return yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const threadId = yield* boundThread(client, ctx.cwd);
          if (threadId === null) {
            return [];
          }
          return Arr.map(yield* askedQuestions(client, threadId), (asked) => ({
            id: asked.id,
            questions: Arr.map(asked.questions, (one) => ({
              question: one.title,
              options: Arr.map(one.options ?? [], (label) => ({ label })),
            })),
          }));
        }),
      );
    }),
  usage: (ctx) =>
    Effect.gen(function* () {
      const url = yield* codexAt(ctx);
      return yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const threadId = yield* boundThread(client, ctx.cwd);
          if (threadId === null) {
            return null;
          }
          yield* writeEvent(ctx.dir, { session: threadId, kind: "session" });
          return yield* codexContext(client, threadId);
        }),
      );
    }),
  records: (ctx) =>
    Effect.gen(function* () {
      const url = yield* codexAt(ctx);
      const threads = yield* withCodex(url, (client) => agentThreads(client, ctx.cwd));
      return Arr.getSomes(
        Arr.map(threads, (thread) =>
          thread.transcript === null || thread.ephemeral
            ? Option.none()
            : Option.some<Source>({
                path: thread.transcript,
                format: "codex",
                parent: thread.parent,
              }),
        ),
      );
    }),
  request: (ctx, requestId) =>
    Effect.gen(function* () {
      // WARNING: only startCompaction's failure may have reached the server; the steps before it are requests that never left.
      const url = yield* codexAt(ctx);
      yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const threadId = yield* boundThread(client, ctx.cwd);
          if (threadId === null) {
            return yield* new Unsubmitted({
              message: `${ctx.agent} has no Codex thread to compact`,
            });
          }
          // WARNING: thread/compact/start carries no request id, so a compaction that was not there before is the only candidate for this request.
          const before = yield* compactionItems(client, threadId);
          yield* writeEvent(ctx.dir, {
            session: threadId,
            kind: "start",
            request: requestId,
            items: Arr.map(before, (item) => item.id),
          });
          yield* submitting(startCompaction(client, threadId));
        }),
      );
      return null;
    }).pipe(beforeSubmitting),
  poll: (ctx, mark) =>
    Effect.gen(function* () {
      const url = yield* codexAt(ctx);
      const events = yield* readEvents(ctx.dir);
      const started = Option.getOrUndefined(
        Arr.findFirst(events, (event) => event.kind === "start" && event.request === mark.id),
      );
      if (!started?.session) {
        return null;
      }
      const threadId = started.session;
      const before = new Set(started.items ?? []);
      return yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const now = yield* compactionItems(client, threadId);
          const mine = Option.getOrUndefined(Arr.findFirst(now, (item) => !before.has(item.id)));
          if (!mine) {
            return null;
          }
          const outcome = yield* turnOutcome(client, threadId, mine.turnId);
          if (outcome.kind === "running") {
            return null;
          }
          return outcome.kind === "completed"
            ? ({ kind: "success" } as const)
            : ({ kind: "failure", reason: outcome.reason } as const);
        }),
      );
    }),
});

// WARNING: Collie picks the port: --port 0 prints it nowhere readable, and serve + attach refuses --model and --auto.
const OPENCODE_LOG = "server.log";
export const OPENCODE_USAGE = "opencode-usage.jsonl";
const OPENCODE_LISTENING = /http:\/\/127\.0\.0\.1:\d+/;
const OPENCODE_START_MS = 30_000;

const openPort = Effect.fn("Compactors.openPort")(function* () {
  const listening = yield* Effect.try({
    try: () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } }),
    catch: (cause) =>
      new Cause.UnknownError(cause, `could not find a free loopback port: ${reason(cause)}`),
  });
  const port = listening.port;
  yield* Effect.sync(() => listening.stop(true));
  return port;
});

const opencodeAt = (ctx: AgentContext) =>
  ctx.endpoint === null
    ? Effect.fail(
        new Cause.NoSuchElementError(`${ctx.agent} has no OpenCode server endpoint recorded`),
      )
    : Effect.succeed(ctx.endpoint);

// WARNING: read from the agent's own telemetry, since the server cannot say which of a project's sessions is this agent's.
const opencodeBound = Effect.fn("Compactors.opencodeBound")(function* (
  ctx: LaunchContext,
  base: string,
) {
  const bound = Arr.filter(yield* readEvents(ctx.dir), (event) => event.kind === "session").at(
    -1,
  )?.session;
  if (!bound) {
    return yield* new Cause.NoSuchElementError(`${ctx.agent} has no OpenCode session recorded`);
  }
  yield* sessionIsHere(base, bound, ctx.cwd);
  return bound;
});

const opencodeLaunch = Effect.fn("Compactors.opencodeLaunch")(function* (ctx: LaunchContext) {
  const path = yield* Path.Path;
  const port = yield* openPort();
  const base = `http://127.0.0.1:${port}`;
  // WARNING: the temporary server is stopped as soon as the session exists, even when creating it fails, since the TUI wants the port back.
  const created = Effect.gen(function* () {
    const served = yield* servedEndpoint({
      cwd: ctx.cwd,
      log: path.join(ctx.dir, OPENCODE_LOG),
      command: `opencode serve --hostname 127.0.0.1 --port ${port}`,
      listening: OPENCODE_LISTENING,
      startMs: OPENCODE_START_MS,
      what: "opencode serve",
      env: ctx.env,
    });
    return yield* createSession(base).pipe(Effect.ensuring(terminate(served.pid)));
  });
  const session = ctx.session ?? (yield* created);

  // WARNING: recorded before the agent starts, so the first boundary reads the session Collie made.
  yield* writeEvent(ctx.dir, { session, kind: "session" });
  return {
    args: ["--hostname", "127.0.0.1", "--port", String(port), "--session", session],
    endpoint: base,
  };
});

const opencode: CompactionPort = {
  gate: gateVersion("opencode"),
  install: opencodeLaunch,
  ready: (ctx) =>
    ctx.endpoint === null
      ? Effect.succeed(false)
      : opencodeBound(ctx, ctx.endpoint).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
  records: (ctx) =>
    Path.Path.use((path) =>
      Effect.succeed([
        { path: path.join(ctx.dir, OPENCODE_USAGE), format: "opencode" as const, parent: null },
      ]),
    ),
  usage: (ctx) =>
    Effect.gen(function* () {
      const base = yield* opencodeAt(ctx);
      const session = yield* opencodeBound(ctx, base);
      return currentContext(yield* openCodeMessages(base, session));
    }),
  request: (ctx, requestId) =>
    Effect.gen(function* () {
      // WARNING: everything up to summarize is preparation, so its failures are requests that never left; summarize's own is not.
      const base = yield* opencodeAt(ctx);
      const session = yield* opencodeBound(ctx, base);
      const all = yield* openCodeMessages(base, session);
      const model = sessionModel(all);
      if (model === null) {
        return yield* new Unsubmitted({
          message: `${ctx.agent}'s OpenCode session has not settled on a model yet`,
        });
      }
      yield* writeEvent(ctx.dir, {
        session,
        kind: "start",
        request: requestId,
        items: compactionIds(all),
      });
      // WARNING: a 200 is the handler's own true and says nothing about the loop; the outcome is read back off the session.
      yield* submitting(summarize(base, session, model));
      return null;
    }).pipe(beforeSubmitting),
  poll: (ctx, mark) =>
    Effect.gen(function* () {
      const base = yield* opencodeAt(ctx);
      const started = Option.getOrUndefined(
        Arr.findFirst(
          yield* readEvents(ctx.dir),
          (event) => event.kind === "start" && event.request === mark.id,
        ),
      );
      if (!started?.session) {
        return null;
      }
      const state = compactionAfter(
        yield* openCodeMessages(base, started.session),
        new Set(started.items ?? []),
      );
      if (state.kind === "none") {
        return null;
      }
      return state.kind === "done"
        ? ({ kind: "success" } as const)
        : ({ kind: "failure", reason: state.reason } as const);
    }),
};

export const COMPACTION_PORTS: CompactionPorts = {
  claude,
  codex: codexPort(CODEX_SERVER),
  opencode,
  pi,
};

// WARNING: counted, not timestamped, so a submission already turned into an override is not counted again.
export const externalSubmissions = (dir: string) =>
  Effect.map(externalSubmits(dir), (ats) => ats.length);

export const externalSubmits = Effect.fn("Compactors.externalSubmits")(function* (dir: string) {
  return Arr.map(
    Arr.filter(
      yield* readEvents(dir),
      (event) => event.kind === "submit" && event.reason === "external",
    ),
    (event) => event.at,
  );
});

export const submittedDelivery = Effect.fn("Compactors.submittedDelivery")(function* (
  dir: string,
  delivery: string,
) {
  return Arr.some(
    yield* readEvents(dir),
    (event) => event.kind === "submit" && event.delivery === delivery,
  );
});
