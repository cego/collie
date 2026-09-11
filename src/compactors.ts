// The four harnesses' official compaction interfaces, behind the one policy in
// `compaction.ts`. Everything here ships inside Collie: the helpers are generated per
// agent into that agent's control directory, so an installed binary carries them and
// no persistent user or project harness settings are rewritten.
//
// Every adapter reduces to the same two things — a telemetry file the harness's own
// interface appends to, and a channel that asks it to compact — because the shared
// policy owns the threshold, the budget and what counts as an outcome.

import { Clock, Data, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  boundThread,
  compactionItems,
  currentContext as codexContext,
  startCompaction,
  turnOutcome,
  withCodex,
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
import {
  COMPACTION_WAIT_MS,
  Unsubmitted,
  type CompactionDeps,
  type CompactionSettings,
  type CompactionPort,
  type CompactionPorts,
  type AgentContext,
  type LaunchContext,
} from "./compaction";
import { loadDefaults } from "./config";
import { DELIVERY_TOKEN } from "./dispatcher";

/**
 * A compaction request, through the Dispatcher's channel. `Unsubmitted` is reserved for
 * the case the policy treats specially — the channel provably never sent it, so nothing
 * is in flight and the waiting work may be released. Anything else may already have
 * reached the harness, so it is an ordinary failure and the attempt's budget runs.
 */
const submitCompaction = (ctx: AgentContext, requestId: string, text: string) =>
  ctx.channel
    .submit(text, {
      run: ctx.run,
      cause: { kind: "compaction", ref: requestId },
      mode: "boundary",
      intentVersion: 0,
      attempt: 1,
      requestId,
    })
    .pipe(
      Effect.flatMap((outcome) =>
        outcome.ok
          ? Effect.succeed(outcome.submission ?? null)
          : outcome.reason === "unknown"
            ? Effect.succeed(null)
            : outcome.reason === "failed"
              ? Effect.fail(new Error(outcome.detail))
              : Effect.fail(new Unsubmitted({ message: outcome.detail })),
      ),
    );
import type { Herdr } from "./herdr";
import { selfCommand } from "./env";
import { shell } from "./mr";
import { reason, shellQuote } from "./naming";

/**
 * The harness releases these adapters were verified against. The gate refuses an older
 * one: the research traced these contracts in these versions, and a launch that
 * installed controls an older release does not honour would be an unmanaged agent
 * wearing the managed agent's record.
 */
export const VERIFIED_VERSIONS: ReadonlyMap<string, string> = new Map([
  ["claude", "2.1.263"],
  ["codex", "0.153.4"],
  ["opencode", "1.18.9"],
  ["pi", "0.85.1"],
]);

/** The file each agent's controls append their telemetry to, one JSON object per line. */
const TELEMETRY = "events.jsonl";

/**
 * What a control may report. Decoded rather than trusted: a hook, an extension and a
 * loopback server are all untrusted input, and a line Collie cannot decode is dropped
 * rather than allowed to decide whether an agent gets its next piece of work.
 */
const EventSchema = Schema.Struct({
  at: Schema.Number,
  /** The harness's own session identity, so a `/new` in the pane invalidates the rest. */
  session: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["session", "usage", "start", "done", "failed", "auto", "submit"]),
  /** Current-context total. `null` where the harness has not measured this context. */
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Collie's own request id, which is what correlates an outcome to an attempt. */
  request: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  /**
   * Which half of a compaction an uncorrelated event was: Claude's `PostCompact`
   * payload carries no field Collie's marker survives into, so a completion is told
   * from a start by position, and a start that is not Collie's is what makes the
   * completion after it somebody else's.
   */
  phase: Schema.optionalKey(Schema.Literals(["pre", "post"])),
  /**
   * What a harness with no request id of its own had before the request was submitted,
   * so that what it has afterwards can be told apart. Codex's compaction endpoint
   * takes a thread and nothing else, and this is what supplies the correlation.
   */
  items: Schema.optionalKey(Schema.Array(Schema.String)),
});
interface TelemetryEvent extends Schema.Schema.Type<typeof EventSchema> {}
const EventJson = Schema.fromJsonString(EventSchema);
const decodeEvent = Schema.decodeUnknownOption(EventJson);
const encodeEvent = Schema.encodeSync(EventJson);

/**
 * This agent's telemetry, narrowed to the session it is on now. The newest `session`
 * line is the binding: a harness that started a second session in the same pane has a
 * context Collie has measured nothing about, so the older session's samples and
 * outcomes are stale rather than merely old.
 */
const readEvents = Effect.fn("Compactors.readEvents")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, TELEMETRY);
  if (!(yield* fs.exists(file))) return [];
  const lines = yield* fs
    .readFileString(file)
    .pipe(Effect.map((text) => text.split("\n").filter((line) => line.trim() !== "")));
  const bound = boundSession(lines);
  // Nothing has said which session this agent is on, so nothing here describes a
  // context Collie can vouch for.
  if (bound === undefined) return [];
  const events: TelemetryEvent[] = [];
  for (const line of lines) {
    const decoded = decodeEvent(line);
    if (decoded._tag === "Some" && decoded.value.session === bound) events.push(decoded.value);
  }
  return events;
});

/**
 * How many lines of telemetry one agent keeps. A status line runs on every event in a
 * harness's own UI, so an append-only file would be tens of thousands of lines by
 * lunchtime; only the newest sample and the current attempt are ever read.
 */
const KEEP_LINES = 200;

/**
 * Appends one event, keeping the file bounded. Read-slice-write rather than append: the
 * cap is the point, and a torn write only loses telemetry, which the policy already
 * treats as unavailable rather than as an answer.
 */
export const writeEvent = Effect.fn("Compactors.writeEvent")(function* (
  dir: string,
  /** Everything but the timestamp, which is the writer's to stamp. */
  written: Omit<TelemetryEvent, "at">,
) {
  const event: TelemetryEvent = { ...written, at: yield* Clock.currentTimeMillis };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, TELEMETRY);
  yield* fs.makeDirectory(dir, { recursive: true });
  const existing = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
  const lines = existing.split("\n").filter((line) => line.trim() !== "");
  // Identity is the writer's job, once, rather than every adapter's: an event on a
  // session nothing has bound yet binds it, and one on a session that has changed
  // rebinds — which is what makes every earlier sample and attempt stale. An event
  // that is itself a session line needs no second one in front of it.
  const bound = boundSession(lines);
  const rebinds = bound !== event.session && event.kind !== "session";
  const session: TelemetryEvent[] = rebinds
    ? [{ at: event.at, session: event.session, kind: "session" }]
    : [];
  const added = [...session, event].map((line) => encodeEvent(line));
  const kept = [...lines.slice(-(KEEP_LINES - added.length)), ...added];
  yield* fs.writeFileString(file, `${kept.join("\n")}\n`);
});

/** The session every later line is read against: the newest one a `session` line named. */
function boundSession(lines: ReadonlyArray<string>): string | null | undefined {
  for (const line of [...lines].reverse()) {
    const decoded = decodeEvent(line);
    if (decoded._tag === "Some" && decoded.value.kind === "session") return decoded.value.session;
  }
  return undefined;
}

/** The harness's own latest current-context total, or null where it has none. */
const latestUsage = Effect.fn("Compactors.latestUsage")(function* (dir: string) {
  const events = yield* readEvents(dir);
  return events.filter((event) => event.kind === "usage").at(-1)?.tokens ?? null;
});

/**
 * What this request has established. Only an outcome carrying this request id counts:
 * a native automatic compaction, another Run's request and a duplicate event all
 * appear here, and none of them may complete an attempt they do not belong to.
 */
const outcomeOf = Effect.fn("Compactors.outcomeOf")(function* (dir: string, requestId: string) {
  const events = yield* readEvents(dir);
  const mine = events.filter((event) => event.request === requestId);
  if (mine.some((event) => event.kind === "done")) return { kind: "success" } as const;
  const failed = mine.find((event) => event.kind === "failed");
  if (failed)
    return { kind: "failure", reason: failed.message ?? "the harness reported an error" } as const;
  return null;
});

/** `a.b.c` against `x.y.z`, numerically, missing parts as zero. */
export function atLeast(installed: string, wanted: string): boolean {
  const parts = (text: string) =>
    (/(\d+(?:\.\d+)*)/.exec(text)?.[1] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = parts(installed);
  const need = parts(wanted);
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const [h, n] = [have[i] ?? 0, need[i] ?? 0];
    if (h !== n) return h > n;
  }
  return true;
}

/**
 * One version check per harness per process. A gate runs before every launch, and a
 * subprocess per step to ask a CLI its own version is a cost with no new information
 * in it — the installed binary does not change under a running Driver.
 */
const gated = new Map<string, string | null>();

/**
 * What this machine has installed, as the harness itself reports it, or null where it
 * cannot be asked. Unknown is never treated as new enough: a gate that guessed would be
 * a gate.
 */
export const installedVersion = Effect.fn("Compactors.installedVersion")(function* (
  harness: string,
) {
  const { code, stdout } = yield* shell(harness, ["--version"], process.cwd()).pipe(
    Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })),
  );
  if (code !== 0) return null;
  return stdout.trim().split("\n").at(-1)?.trim() || null;
});

const gateVersion = Effect.fn("Compactors.gateVersion")(function* (harness: string) {
  const wanted = VERIFIED_VERSIONS.get(harness);
  if (!wanted) return;
  const cached = gated.get(harness);
  if (cached === null) return;
  if (cached !== undefined) return yield* Effect.fail(new Error(cached));
  const { code, stdout } = yield* shell(harness, ["--version"], process.cwd());
  const installed = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  const problem =
    code !== 0
      ? `cannot ask ${harness} its version (exit ${code}) — Collie manages its compaction and will not launch an agent it cannot manage`
      : !atLeast(installed, wanted)
        ? `${harness} ${installed || "(no version)"} is older than the ${wanted} its compaction controls were verified against — upgrade it, or set compact_at_tokens to 0`
        : null;
  gated.set(harness, problem);
  if (problem) return yield* Effect.fail(new Error(problem));
});

/**
 * The Pi extension Collie loads into one agent, generated with that agent's telemetry
 * path in it. Pi's official extension surface supplies all three parts: the current
 * context estimate its own compaction and footer use, a command that calls `compact`
 * with per-request completion callbacks, and the compaction lifecycle events that tell
 * a native automatic compaction from this one.
 *
 * `-e` rather than a discovered location: an extension written into `~/.pi` would be a
 * persistent settings change, and would load into every Pi the human ever starts.
 */
function piExtension(file: string): string {
  return `// Generated by Collie for one agent. Do not edit: it is rewritten at launch.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = ${JSON.stringify(file)};
const KEEP = ${KEEP_LINES};

export default function (pi) {
  let session = null;

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
      kept = kept.slice(-(KEEP - 1));
      kept.push(JSON.stringify({ at: Date.now(), session, ...event }));
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
    write({ kind: "usage", tokens });
  };

  pi.on("session_start", async (_event, ctx) => sample(ctx));
  pi.on("turn_end", async (_event, ctx) => sample(ctx));
  pi.on("agent_settled", async (_event, ctx) => sample(ctx));

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
      const request = String(args ?? "").trim();
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
  gate: () => gateVersion("pi"),
  install: (ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const extension = path.join(ctx.dir, "collie.ts");
      yield* fs.writeFileString(extension, piExtension(path.join(ctx.dir, TELEMETRY)));
      return { args: ["-e", extension] };
    }),
  usage: (ctx) => latestUsage(ctx.dir),
  // Through the human's channel, which is what a slash command is: the extension's
  // command carries the request id, so the outcome that comes back is this request's.
  // The human's channel, so a refusal from herdr is a request that never left.
  request: (ctx, requestId) => submitCompaction(ctx, requestId, `/collie-compact ${requestId}`),
  poll: (ctx, requestId) => outcomeOf(ctx.dir, requestId),
};

/**
 * The two sides of one line: the call that submits a compaction, and everything an
 * adapter does before it. Only the adapter knows where that line is, and the policy
 * needs to know which side a failure came from — a request that never left may release
 * the waiting work, and one that may have been accepted may not.
 */
class Submitting extends Data.TaggedError("Submitting")<{ readonly message: string }> {}

/** The one call that hands the request to the harness. */
const submitting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new Submitting({ message: reason(cause) })));

/**
 * Everything else in a `request`: connecting, binding, reading, recording. A
 * `Submitting` passes through as it is — it is already an `Error`, and keeping it says
 * in a log which side of the line the failure came from.
 */
const beforeSubmitting = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof Submitting ? cause : new Unsubmitted({ message: reason(cause) }),
    ),
  );

/**
 * Claude Code's status-line and hook payloads, as much of them as Collie reads. Every
 * field optional: the payload is a documented contract, but it arrives on a pipe from
 * a process Collie does not control, and a version that renamed one field must make
 * the sample unavailable rather than crash a human's status line.
 */
const ClaudePayload = Schema.Struct({
  session_id: Schema.optionalKey(Schema.String),
  /** Absent for the status line; `PreCompact` or `PostCompact` for a hook. */
  hook_event_name: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(Schema.String),
  /** `UserPromptSubmit` only: what was submitted, which is how Collie's own is told. */
  prompt: Schema.optionalKey(Schema.String),
  custom_instructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
  context_window: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        total_input_tokens: Schema.optionalKey(Schema.Number),
        total_output_tokens: Schema.optionalKey(Schema.Number),
        used_percentage: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        /**
         * Null before the first API call and again after a compaction until the next
         * one. That is the freshness signal: the totals beside it are `0` in both
         * cases, and a zero read as a measurement would be a sample of an empty
         * context that is not empty.
         */
        current_usage: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ input_tokens: Schema.optionalKey(Schema.Number) })),
        ),
      }),
    ),
  ),
});
const decodeClaudePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudePayload));

/**
 * The token Collie puts in `/compact`'s own instructions and reads back out of the
 * `PreCompact` payload. Claude's compaction has no request id of its own, and its
 * manual instructions are the one field that survives from the request into a hook —
 * so this is what tells Collie's request from a human typing `/compact` in the pane.
 */
const CLAUDE_MARKER = /\(collie:([A-Za-z0-9-]+)\)/;

function claudeInstructions(requestId: string): string {
  return `Keep the work in progress, the decisions taken and what is left to do. (collie:${requestId})`;
}

/**
 * What Claude's own status line and compaction hooks report, decoded into one agent's
 * telemetry. Run as `collie herdr compaction <dir>` with the payload on stdin, so the
 * helper a launch installs is the binary that installed it — no `jq`, no shell JSON
 * parsing, and one place that validates an untrusted payload.
 *
 * The status-line case also prints the line Claude displays: Collie is borrowing the
 * human's status line, and giving it back a blank one would be taking something away.
 */
export const recordClaudeEvent = Effect.fn("Compactors.recordClaudeEvent")(function* (
  dir: string,
  stdin: string,
) {
  const decoded = decodeClaudePayload(stdin);
  if (decoded._tag === "None") return "";
  const payload = decoded.value;
  const session = payload.session_id ?? null;
  const window = payload.context_window ?? null;
  const measured = (window?.current_usage ?? null) !== null;
  const tokens = measured
    ? (window?.total_input_tokens ?? 0) + (window?.total_output_tokens ?? 0)
    : null;

  const event = payload.hook_event_name;
  if (event === "UserPromptSubmit") {
    // Recorded whole? No: the prompt is the human's own text, and a transcript is not
    // Collie's to keep (SPEC §2). Only whether it carried Collie's delivery token, which
    // is the whole question attribution asks.
    yield* writeEvent(dir, {
      session,
      kind: "submit",
      reason: (payload.prompt ?? "").includes(DELIVERY_TOKEN) ? "collie" : "external",
    });
    return "";
  }
  if (event === "PreCompact" || event === "PostCompact") {
    // Only `PreCompact` is given the instructions back, so only it can carry the
    // marker. Everything else — Claude's own automatic compaction, a human's
    // `/compact`, and the `PostCompact` that ends any of them — is recorded with its
    // trigger and its half, because that is what `claudeOutcome` reads.
    const request =
      event === "PreCompact" && payload.trigger === "manual"
        ? CLAUDE_MARKER.exec(payload.custom_instructions ?? "")?.[1]
        : undefined;
    yield* writeEvent(
      dir,
      request
        ? { session, kind: "start", request }
        : {
            session,
            kind: "auto",
            reason: payload.trigger ?? "unknown",
            phase: event === "PreCompact" ? "pre" : "post",
          },
    );
    return "";
  }

  yield* writeEvent(dir, { session, kind: "usage", tokens });
  const percent = window?.used_percentage;
  return percent === null || percent === undefined
    ? "context: not measured yet"
    : `context: ${Math.round(percent)}%`;
});

/**
 * The run-scoped settings a launch loads with `--settings`, which is additional
 * settings rather than a rewrite: the human's own `~/.claude/settings.json` and the
 * project's are untouched, and this file dies with the agent's control directory.
 *
 * The status line is the official current-context contract, and the two compaction
 * hooks are the official lifecycle. Both are matched on `manual` and `auto`, because
 * an automatic compaction is what invalidates a sample Collie is about to read.
 */
function claudeSettings(dir: string): string {
  const helper = [...selfCommand(), "herdr", "compaction", dir].map(shellQuote).join(" ");
  const hook = { matcher: "manual|auto", hooks: [{ type: "command", command: helper }] };
  // `UserPromptSubmit` is the only place a submitted turn is visible to Collie, and it
  // is what attribution rests on: a prompt with no delivery token is somebody typing in
  // the pane. It carries no matcher — every submission counts, which is the point.
  const submitted = { hooks: [{ type: "command", command: helper }] };
  return `${JSON.stringify(
    {
      statusLine: { type: "command", command: helper },
      hooks: { PreCompact: [hook], PostCompact: [hook], UserPromptSubmit: [submitted] },
    },
    null,
    2,
  )}\n`;
}

/**
 * What Claude has established about one request. Its `PostCompact` payload is
 * `{hook_event_name, trigger, compact_summary}` — nothing of the request survives into
 * it — so the completion is correlated the way Codex's and OpenCode's are: by what was
 * not there when Collie asked. The marked `PreCompact` is the start, and the first
 * manual completion after it on the same session is that compaction's.
 *
 * A start that is not Collie's in between — a human's own `/compact` — makes the
 * completion after it theirs, and leaves the attempt unresolved rather than taking it.
 * An `auto` trigger is Claude's own automatic compaction and never an answer either.
 */
const claudeOutcome = Effect.fn("Compactors.claudeOutcome")(function* (
  dir: string,
  requestId: string,
) {
  const events = yield* readEvents(dir);
  const at = events.findIndex((event) => event.kind === "start" && event.request === requestId);
  if (at < 0) return null;
  for (const event of events.slice(at + 1)) {
    if (event.kind !== "auto" || event.reason !== "manual") continue;
    if (event.phase === "pre") return null;
    return { kind: "success" } as const;
  }
  return null;
});

const claude: CompactionPort = {
  gate: () => gateVersion("claude"),
  install: (ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const settings = path.join(ctx.dir, "settings.json");
      yield* fs.writeFileString(settings, claudeSettings(ctx.dir));
      return { args: ["--settings", settings] };
    }),
  usage: (ctx) => latestUsage(ctx.dir),
  // The documented native command, through the human's channel. Its instructions are
  // real instructions with the correlation token appended: Claude has no request id
  // for a compaction, and this field is the only one both hooks give back.
  request: (ctx, requestId) =>
    submitCompaction(ctx, requestId, `/compact ${claudeInstructions(requestId)}`),
  // No documented compact-failed hook exists, so `poll` can only ever return success
  // or nothing: a missing PostCompact is an unresolved outcome, which the shared
  // policy pauses on, and never a confirmed failure.
  poll: (ctx, requestId) => claudeOutcome(ctx.dir, requestId),
};

/**
 * A local server of this agent's own, started through a shell and waited on until it
 * says it is up. Two adapters need one — Codex's App Server, whose port is only ever on
 * its own stdout, and the `opencode serve` that exists just long enough to create a
 * session — and both had their own copy of the shell redirect, the detach, the deadline
 * loop and the failure message. The copy without a test was the one that read its log
 * before the shell had created it.
 *
 * Always detached and unreffed, and always reporting its pid: the spawner's own
 * finalizer would otherwise take down the server it just started, and who stops it is
 * the caller's decision — Codex records the pid for the agent's lifetime, OpenCode
 * stops it as soon as it has its session.
 *
 * `found` is the first capture group of `listening`, where the pattern has one. A
 * pattern that only asks whether the server is up leaves it empty.
 */
export const servedEndpoint = Effect.fn("Compactors.servedEndpoint")(function* (opts: {
  cwd: string;
  /** The log the server is redirected into, inside the agent's control directory. */
  log: string;
  /** The command exactly as a shell runs it, without the redirect. */
  command: string;
  /** The line that says the server is up. */
  listening: RegExp;
  startMs: number;
  /** What did not come up, for the failure a human reads. */
  what: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  // Created before the server is, because the wait below reads it: the shell's redirect
  // makes it too, but a read that gets there first is a launch that fails on a missing
  // file instead of waiting for the line it is waiting for.
  yield* fs.writeFileString(opts.log, "");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pid = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", `exec ${opts.command} >${shellQuote(opts.log)} 2>&1`], {
          cwd: opts.cwd,
          extendEnv: true,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      // Unref before the scope closes, or the spawner's finalizer kills the server it
      // just started — the same reason a detached Driver is unreffed.
      yield* Effect.asVoid(handle.unref);
      return handle.pid;
    }),
  );

  const deadline = (yield* Clock.currentTimeMillis) + opts.startMs;
  for (;;) {
    const said = opts.listening.exec(yield* fs.readFileString(opts.log));
    if (said) return { pid, found: said[1] ?? "" };
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* Effect.fail(
        new Error(`${opts.what} did not come up within ${opts.startMs}ms — see ${opts.log}`),
      );
    }
    yield* Effect.sleep(200);
  }
});

/** Stops a server this agent no longer needs. Best effort: it may already be gone. */
const stopServer = (pid: number) => Effect.ignore(Effect.sync(() => process.kill(pid, "SIGTERM")));

/**
 * One App Server per agent, on a loopback port it picks itself, with the ordinary
 * interactive TUI in the pane connected to it by `--remote`. One server per agent is
 * not tidiness: it is the whole of Collie's thread identity. On a shared server
 * `thread/loaded/list` answers with every agent's thread and nothing in the protocol
 * says which is whose, so `boundThread` refuses rather than guesses.
 *
 * `--listen ws://127.0.0.1:0` rather than a port Collie picked: binding a port to read
 * its number and then handing it over is a race with everything else on the machine,
 * and the server prints the port it actually got. `unix://` is a documented form and
 * binds, but nothing sent over that socket on 0.153.4 is ever answered.
 */
const CODEX_SERVER = "codex app-server";
const CODEX_LOG = "app-server.log";
const CODEX_LISTENING = /ws:\/\/127\.0\.0\.1:(\d+)/;
const CODEX_START_MS = 20_000;

const codexEndpoint = Effect.fn("Compactors.codexEndpoint")(function* (ctx: LaunchContext) {
  const path = yield* Path.Path;
  // Through a shell, because the port it chose is only on its stdout.
  const served = yield* servedEndpoint({
    cwd: ctx.cwd,
    log: path.join(ctx.dir, CODEX_LOG),
    command: `${CODEX_SERVER} --listen ws://127.0.0.1:0`,
    listening: CODEX_LISTENING,
    startMs: CODEX_START_MS,
    what: "codex app-server",
  });
  return { endpoint: `ws://127.0.0.1:${served.found}`, pid: served.pid, command: CODEX_SERVER };
});

/** The endpoint this agent's controls talk to, or a failure naming what is missing. */
const codexAt = (ctx: AgentContext) =>
  ctx.endpoint === null
    ? Effect.fail(new Error(`${ctx.agent} has no Codex App Server endpoint recorded`))
    : Effect.succeed(ctx.endpoint);

const codex: CompactionPort = {
  gate: () => gateVersion("codex"),
  install: (ctx) =>
    codexEndpoint(ctx).pipe(
      Effect.map(({ endpoint, pid, command }) => ({
        args: ["--remote", endpoint],
        endpoint,
        pid,
        command,
      })),
    ),
  usage: (ctx) =>
    Effect.gen(function* () {
      const url = yield* codexAt(ctx);
      return yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const threadId = yield* boundThread(client, ctx.cwd);
          // The TUI has not started a thread yet, so there is no context to measure.
          if (threadId === null) return null;
          yield* writeEvent(ctx.dir, { session: threadId, kind: "session" });
          return yield* codexContext(client, threadId);
        }),
      );
    }),
  request: (ctx, requestId) =>
    Effect.gen(function* () {
      // Connecting, binding the thread and listing what it already has all happen
      // before the request itself, so their failures are requests that never left.
      // `startCompaction`'s is not: its socket can close after the server took the
      // frame, and the thread may be compacting on the strength of it.
      const url = yield* codexAt(ctx);
      yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const threadId = yield* boundThread(client, ctx.cwd);
          if (threadId === null) {
            return yield* Effect.fail(
              new Unsubmitted({ message: `${ctx.agent} has no Codex thread to compact` }),
            );
          }
          // The compactions this thread already has, recorded before the request is
          // submitted. `thread/compact/start` carries no request id, so a compaction
          // that was not there before is the only thing that can be this request's.
          const before = yield* compactionItems(client, threadId);
          yield* writeEvent(ctx.dir, {
            session: threadId,
            kind: "start",
            request: requestId,
            items: before.map((item) => item.id),
          });
          yield* submitting(startCompaction(client, threadId));
        }),
      );
      // Its own socket, not the human's channel: no submission for herdr to have seen.
      return null;
    }).pipe(beforeSubmitting),
  poll: (ctx, requestId) =>
    Effect.gen(function* () {
      const url = yield* codexAt(ctx);
      const events = yield* readEvents(ctx.dir);
      const started = events.find((event) => event.kind === "start" && event.request === requestId);
      // Nothing was recorded as submitted, so nothing here can have completed it.
      if (!started?.session) return null;
      const threadId = started.session;
      const before = new Set(started.items ?? []);
      return yield* withCodex(url, (client) =>
        Effect.gen(function* () {
          const now = yield* compactionItems(client, threadId);
          const mine = now.find((item) => !before.has(item.id));
          if (!mine) return null;
          // A compaction runs as a turn of its own, so the turn's own status is the
          // protocol's terminal answer rather than an inference from idleness.
          const outcome = yield* turnOutcome(client, threadId, mine.turnId);
          if (outcome.kind === "running") return null;
          return outcome.kind === "completed"
            ? ({ kind: "success" } as const)
            : ({ kind: "failure", reason: outcome.reason } as const);
        }),
      );
    }),
};

/**
 * The ordinary OpenCode TUI, hosting its own loopback server on a port Collie picked.
 * That is the whole of the integration: no second process, and the endpoint lives
 * exactly as long as the agent does, because the agent is the process serving it.
 *
 * Collie has to pick the port. `--port 0` lets OpenCode choose, but the TUI prints it
 * nowhere Collie can read, and `opencode serve` + `attach` — which does print it —
 * refuses `--model` and `--auto`, so a Collie-launched agent would lose its model and
 * its unattended switch. A port claimed and released a moment earlier is a small race
 * that a launch fails loudly on; a launch that silently drops the model is not.
 */
const OPENCODE_LOG = "server.log";
const OPENCODE_LISTENING = /http:\/\/127\.0\.0\.1:\d+/;
const OPENCODE_START_MS = 30_000;

const openPort = Effect.fn("Compactors.openPort")(function* () {
  const listening = yield* Effect.try({
    try: () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } }),
    catch: (cause) => new Error(`could not find a free loopback port: ${reason(cause)}`),
  });
  const port = listening.port;
  yield* Effect.sync(() => listening.stop(true));
  return port;
});

const opencodeAt = (ctx: AgentContext) =>
  ctx.endpoint === null
    ? Effect.fail(new Error(`${ctx.agent} has no OpenCode server endpoint recorded`))
    : Effect.succeed(ctx.endpoint);

/**
 * The session Collie created for this agent at launch, checked against its directory.
 * Read from the agent's own telemetry rather than from the server, because the server
 * cannot say which of a project's sessions is this agent's.
 */
const opencodeBound = Effect.fn("Compactors.opencodeBound")(function* (
  ctx: AgentContext,
  base: string,
) {
  const bound = (yield* readEvents(ctx.dir))
    .filter((event) => event.kind === "session")
    .at(-1)?.session;
  if (!bound) {
    return yield* Effect.fail(new Error(`${ctx.agent} has no OpenCode session recorded`));
  }
  yield* sessionIsHere(base, bound, ctx.cwd);
  return bound;
});

/**
 * The launch: a port, a session created on a server that lives just long enough to
 * make it, and the ordinary TUI told to host that port and continue that session.
 *
 * The temporary server is what buys exact identity. `opencode --port N` makes the TUI
 * its own server, so there is nothing to create a session on before it starts — and
 * `serve` + `attach`, which would let Collie own the server for the agent's whole
 * life, refuses `--model` and `--auto` and would cost a Collie-launched agent its
 * model and its unattended switch.
 */
const opencodeLaunch = Effect.fn("Compactors.opencodeLaunch")(function* (ctx: LaunchContext) {
  const path = yield* Path.Path;
  const port = yield* openPort();
  const base = `http://127.0.0.1:${port}`;
  // This server exists only to make the session, so it is stopped the moment it has —
  // including when creating the session fails, because the agent's own TUI is about to
  // want this port back.
  const served = yield* servedEndpoint({
    cwd: ctx.cwd,
    log: path.join(ctx.dir, OPENCODE_LOG),
    command: `opencode serve --hostname 127.0.0.1 --port ${port}`,
    listening: OPENCODE_LISTENING,
    startMs: OPENCODE_START_MS,
    what: "opencode serve",
  });
  const session = yield* createSession(base).pipe(Effect.ensuring(stopServer(served.pid)));

  // Recorded before the agent starts, so the very first boundary reads the session
  // Collie made rather than guessing among the project's.
  yield* writeEvent(ctx.dir, { session, kind: "session" });
  return {
    args: ["--hostname", "127.0.0.1", "--port", String(port), "--session", session],
    endpoint: base,
  };
});

const opencode: CompactionPort = {
  gate: () => gateVersion("opencode"),
  install: opencodeLaunch,
  usage: (ctx) =>
    Effect.gen(function* () {
      const base = yield* opencodeAt(ctx);
      const session = yield* opencodeBound(ctx, base);
      return currentContext(yield* openCodeMessages(base, session));
    }),
  request: (ctx, requestId) =>
    Effect.gen(function* () {
      // Everything up to `summarize` is preparation, so its failures are requests that
      // never left. `summarize`'s own is not: its HTTP call times out on the client
      // while the server's summarize loop keeps running.
      const base = yield* opencodeAt(ctx);
      const session = yield* opencodeBound(ctx, base);
      const all = yield* openCodeMessages(base, session);
      const model = sessionModel(all);
      if (model === null) {
        // Nothing has run in this session, so it has no model to summarize in — and
        // no context worth compacting either.
        return yield* Effect.fail(
          new Unsubmitted({
            message: `${ctx.agent}'s OpenCode session has not settled on a model yet`,
          }),
        );
      }
      // Which compactions the session already had, before the request. Summarizing
      // carries no request id, so a compaction that was not there before is the only
      // thing that can be this one.
      yield* writeEvent(ctx.dir, {
        session,
        kind: "start",
        request: requestId,
        items: compactionIds(all),
      });
      // A 200 here is the handler's own `true` after its loop, which says nothing
      // about what the loop did. The outcome is read back off the session.
      yield* submitting(summarize(base, session, model));
      // Its own HTTP call, not the human's channel: no submission for herdr to see.
      return null;
    }).pipe(beforeSubmitting),
  poll: (ctx, requestId) =>
    Effect.gen(function* () {
      const base = yield* opencodeAt(ctx);
      const started = (yield* readEvents(ctx.dir)).find(
        (event) => event.kind === "start" && event.request === requestId,
      );
      if (!started?.session) return null;
      const state = compactionAfter(
        yield* openCodeMessages(base, started.session),
        new Set(started.items ?? []),
      );
      if (state.kind === "none") return null;
      return state.kind === "done"
        ? ({ kind: "success" } as const)
        : ({ kind: "failure", reason: state.reason } as const);
    }),
};

export const COMPACTION_PORTS: CompactionPorts = { claude, codex, opencode, pi };

/**
 * The shared policy's dependencies, assembled once. Every caller supplies only what it
 * alone knows — its herdr, its state directory, and the two channels a warning goes to
 * — and the defaults that must not disagree between callers (the real four ports, the
 * five-minute budget, the poll interval) live here. Here rather than in `compaction.ts`
 * because the threshold comes from the config file and the policy must not know where
 * that is — the same reason the four adapters live here and not there.
 *
 * `known` is what the caller already has in hand: a Run keeps the threshold it was
 * launched with rather than the config file's, and a test scripts a harness interface
 * and shortens the budget through the same field. Without one, the threshold is read
 * from the config file.
 */
export const compactionFor = Effect.fn("Compactors.compactionFor")(function* (opts: {
  herdr: Pick<Herdr, "agentPrompt" | "agentList">;
  stateDir: string;
  /** Where the threshold comes from when `known` does not carry one. */
  configDir: string;
  /** The Run's audit trail. */
  log: CompactionDeps["log"];
  /** The Run's own channel, which the CLI and the board read. A hand-off has none, so
   * its warnings go to the audit trail the sending Run keeps. */
  warn?: CompactionDeps["warn"];
  pollMs?: number;
  known?: CompactionSettings;
}) {
  const configured =
    opts.known?.configured ?? (yield* loadDefaults(opts.configDir)).compactAtTokens;
  return {
    ports: opts.known?.ports ?? COMPACTION_PORTS,
    stateDir: opts.stateDir,
    configured,
    herdr: opts.herdr,
    log: opts.log,
    warn: opts.warn ?? opts.log,
    waitMs: opts.known?.waitMs ?? COMPACTION_WAIT_MS,
    pollMs: opts.pollMs ?? 2000,
  } satisfies CompactionDeps;
});

/**
 * Submissions this agent has taken that Collie did not make. Claude's `UserPromptSubmit`
 * hook is the only place a submitted turn is visible, and a submission without Collie's
 * delivery token is a human typing into that pane — which is the one thing automatic
 * correction must never fight.
 *
 * Counted rather than timestamped: the caller compares this against what it saw last
 * time, so a submission it has already turned into an override is not one again.
 */
export const externalSubmissions = Effect.fn("Compactors.externalSubmissions")(function* (
  dir: string,
) {
  return (yield* readEvents(dir)).filter(
    (event) => event.kind === "submit" && event.reason === "external",
  ).length;
});
