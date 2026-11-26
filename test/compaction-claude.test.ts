import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, ConfigProvider, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { parseJson } from "../src/json";
import { epochMs, isoAt } from "../src/time";
import { TestClock } from "effect/testing";
import * as PlatformError from "effect/PlatformError";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { onMachineWith } from "./support/live";
import { fakeChannel } from "./support/compaction";
import {
  atLeast,
  claudeSettings,
  COMPACTION_PORTS,
  externalSubmissions,
  newestRateLimits,
  questionsSince,
  rateLimitsReader,
  ranOutSince,
  recordClaudeEvent,
  recordEvent,
  stoppedSince,
  submittedDelivery,
  turnTaken,
  VERIFIED_VERSIONS,
} from "../src/compactors";
import { pollCompaction, readControl } from "../src/compaction";
import type { CompactionDeps } from "../src/compaction";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const claude = COMPACTION_PORTS.claude!;
const markedOn = (id: string, launch: string) => ({ id, session: null, launch, transcript: null });
const marked = (id: string) => markedOn(id, "l-1");
const withLaunch: <A, E>(
  effect: Parameters<typeof runEffect<A, E>>[0],
) => ReturnType<typeof runEffect<A, E>> = (effect) =>
  runEffect(
    effect.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ COLLIE_LAUNCH: "l-1" }),
      ),
    ),
  );
const prompted: Array<string> = [];

const ctx = () => ({
  agent: "build-r1",
  run: "run-1",
  harness: "claude",
  cwd: rig.projectDir,
  dir,
  endpoint: null,
  channel: fakeChannel(prompted),
});

const StatusLine = Schema.Struct({
  session_id: Schema.String,
  context_window: Schema.NullOr(
    Schema.Struct({
      total_input_tokens: Schema.Finite,
      total_output_tokens: Schema.Finite,
      used_percentage: Schema.NullOr(Schema.Finite),
      current_usage: Schema.NullOr(
        Schema.Struct({
          input_tokens: Schema.Finite,
          output_tokens: Schema.Finite,
          cache_creation_input_tokens: Schema.Finite,
          cache_read_input_tokens: Schema.Finite,
        }),
      ),
    }),
  ),
  cost: Schema.optionalKey(Schema.Struct({ total_cost_usd: Schema.Finite })),
});
const encodeStatusLine = flow(
  Schema.encodeResult(Schema.fromJsonString(StatusLine)),
  Result.getOrThrow,
);

// WARNING: PreCompact alone carries the instructions; PostCompact has no field with Collie's marker, so completion is correlated by position.
const Pre = Schema.Struct({
  session_id: Schema.String,
  hook_event_name: Schema.tag("PreCompact"),
  trigger: Schema.String,
  custom_instructions: Schema.NullOr(Schema.String),
});
const Post = Schema.Struct({
  session_id: Schema.String,
  hook_event_name: Schema.tag("PostCompact"),
  trigger: Schema.String,
  compact_summary: Schema.String,
});
const encodePre = flow(Schema.encodeResult(Schema.fromJsonString(Pre)), Result.getOrThrow);
const encodePost = flow(Schema.encodeResult(Schema.fromJsonString(Post)), Result.getOrThrow);

const pre = (session: string, trigger: string, instructions: string | null) =>
  encodePre({
    session_id: session,
    hook_event_name: "PreCompact",
    trigger,
    custom_instructions: instructions,
  });
const post = (session: string, trigger: string) =>
  encodePost({
    session_id: session,
    hook_event_name: "PostCompact",
    trigger,
    compact_summary: "what the agent was doing, condensed",
  });

const Submit = Schema.Struct({
  session_id: Schema.String,
  hook_event_name: Schema.tag("UserPromptSubmit"),
  prompt: Schema.String,
});
const encodeSubmit = flow(Schema.encodeResult(Schema.fromJsonString(Submit)), Result.getOrThrow);
const submit = (prompt: string) =>
  encodeSubmit({ session_id: "s-1", hook_event_name: "UserPromptSubmit", prompt });

const measured = (session: string, input: number, output: number, percent: number) =>
  encodeStatusLine({
    session_id: session,
    context_window: {
      total_input_tokens: input,
      total_output_tokens: output,
      used_percentage: percent,
      current_usage: {
        input_tokens: input - 7000,
        output_tokens: output,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 2000,
      },
    },
    // WARNING: The cumulative cost total is billing, not context; reading it is the mistake this accounting avoids.
    cost: { total_cost_usd: 12.5 },
  });

const unmeasured = (session: string) =>
  encodeStatusLine({
    session_id: session,
    context_window: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      used_percentage: null,
      current_usage: null,
    },
  });

beforeEach(() =>
  withLaunch(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });
      prompted.length = 0;
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("the sample is input plus output, with the cache folded in exactly once", () =>
  withLaunch(
    Effect.gen(function* () {
      // WARNING: 15,500 already contains the cache writes and reads; do not add them again.
      const line = yield* recordClaudeEvent(dir, measured("s-1", 15_500, 1200, 8));

      expect(yield* claude.usage(ctx())).toBe(16_700);
      expect(line).toBe("context: 8%");
    }),
  ));

test("no measurement yet is unavailable, not a context of zero tokens", () =>
  withLaunch(
    Effect.gen(function* () {
      const line = yield* recordClaudeEvent(dir, unmeasured("s-1"));

      expect(yield* claude.usage(ctx())).toBeNull();
      expect(line).toBe("context: not measured yet");
    }),
  ));

test("a compaction invalidates the sample before it, until the next API call", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1000, 99));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      yield* recordClaudeEvent(dir, unmeasured("s-1"));

      expect(yield* claude.usage(ctx())).toBeNull();
    }),
  ));

test("the marked PreCompact is the start, and the PostCompact after it the success", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1000, 99));
      yield* claude.request(ctx(), "req-1");
      const instructions = pipe_(prompted[0]!, Str.replace(/^\/compact /, ""));
      expect(prompted[0]).toStartWith("/compact ");
      expect(instructions).toContain("(collie:req-1)");

      // WARNING: PostCompact carries no marker, so the next manual completion on the session is what finishes the attempt.
      yield* recordClaudeEvent(dir, pre("s-1", "manual", instructions));
      expect(yield* claude.poll(ctx(), marked("req-1"))).toBeNull();
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      expect(yield* claude.poll(ctx(), marked("req-1"))).toEqual({ kind: "success" });
    }),
  ));

test("a completion before Collie asked is not the answer to what it asked", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));

      expect(yield* claude.poll(ctx(), marked("req-1"))).toBeNull();
    }),
  ));

test("an automatic compaction cannot complete Collie's request", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, pre("s-1", "auto", null));
      yield* recordClaudeEvent(dir, post("s-1", "auto"));

      expect(yield* claude.poll(ctx(), marked("req-1"))).toBeNull();
    }),
  ));

test("a human typing /compact in the pane cannot complete it either", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, pre("s-1", "manual", "just tidy it up please"));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));

      expect(yield* claude.poll(ctx(), marked("req-1"))).toBeNull();
    }),
  ));

test("another session's hooks cannot complete it, and rebind what is current", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1000, 99));
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, post("s-2", "manual"));

      expect(yield* claude.usage(ctx())).toBeNull();
      expect(yield* claude.poll(ctx(), marked("req-1"))).toBeNull();
    }),
  ));

test("a duplicate PostCompact says success once, not twice, and never a failure", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));

      expect(yield* claude.poll(ctx(), marked("req-1"))).toEqual({ kind: "success" });
    }),
  ));

test("a background task finishing is Claude's own turn, not a person typing", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        submit(
          "<task-notification>\n<task-id>b11e8rx1q</task-id>\n<status>completed</status>\n</task-notification>",
        ),
      );
      yield* recordClaudeEvent(
        dir,
        submit('<agent-message from="reviewer">\nthe review is done\n</agent-message>'),
      );

      yield* recordClaudeEvent(
        dir,
        submit("<task-notification>\n<summary>grep collie-delivery:run-1-steer-1</summary>"),
      );

      expect(yield* externalSubmissions(dir)).toBe(0);
      expect(yield* submittedDelivery(dir, "run-1-steer-1")).toBe(false);
    }),
  ));

test("a submission is Collie's when it carries a delivery token, and a person's otherwise", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, submit("collie-delivery:run-1-steer-1\nStop and do this."));
      yield* recordClaudeEvent(dir, submit("wait, use the other branch"));

      expect(yield* submittedDelivery(dir, "run-1-steer-1")).toBe(true);
      expect(yield* externalSubmissions(dir)).toBe(1);
      const written = yield* fs.readFileString(path.join(dir, "events.jsonl"));
      expect(written).not.toContain("other branch");
    }),
  ));

test("a payload Collie cannot decode records nothing and prints nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, "not json")).toBe("");
      expect(yield* claude.usage(ctx())).toBeNull();
    }),
  ));

const encodeJsonText = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);
const decodeJsonText = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

const asking = (tool: string, questions: Schema.Json) =>
  encodeJsonText({
    session_id: "s-1",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_use_id: "toolu_1",
    tool_input: { questions },
  });

const TWO = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres (Recommended)", description: "the one ops runs" },
      { label: "SQLite", description: "a file beside the app" },
      { label: "JSONL", description: "no migration" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks?",
    header: "Checks",
    options: [
      { label: "lint (Recommended)", description: "oxlint" },
      { label: "typecheck", description: "tsgo" },
      { label: "none", description: "CI runs them" },
    ],
    multiSelect: false,
  },
];

const hostLive = Effect.suspend(() =>
  fs.writeFileString(
    path.join(rig.root, "host.lock"),
    encodeJsonText({ pid: process.pid, start: null }),
  ),
);

test("an AskUserQuestion call is recorded whole for its Run, and denied at once", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* hostLive;
      const printed = yield* recordClaudeEvent(dir, asking("AskUserQuestion", TWO));

      expect(yield* questionsSince(dir, 0)).toEqual([
        { at: expect.any(Number), session: "s-1", id: "toolu_1", questions: TWO },
      ]);
      expect(decodeJsonText(printed)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("on your Run"),
        },
      });
      expect(printed).toContain("End your turn now");
      expect(printed).toContain("your next message");
    }),
  ));

test("with no live host, a question is left to the agent's pane and never said to be on its Run", () =>
  withLaunch(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", TWO))).toBe("");
      yield* fs.writeFileString(
        path.join(rig.root, "host.lock"),
        encodeJsonText({ pid: 2 ** 22 + 1, start: null }),
      );
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", TWO))).toBe("");
      expect(yield* questionsSince(dir, 0)).toEqual([]);
    }),
  ));

test("another tool, and a question Collie cannot decode, record and print nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, asking("Bash", TWO))).toBe("");
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", [{ header: 1 }]))).toBe("");
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", "which?"))).toBe("");
      expect(yield* questionsSince(dir, 0)).toEqual([]);
    }),
  ));

test("the helpers record identity, usage and outcome — never conversation content", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        `{"session_id":"s-1","transcript_path":"/home/mk/.claude/x.jsonl","hook_event_name":"PostCompact","trigger":"manual","compact_summary":"The user asked about their salary."}`,
      );

      const written = yield* fs.readFileString(path.join(dir, "events.jsonl"));
      expect(written).toContain("s-1");
      expect(written).not.toContain("transcript");
      expect(written).not.toContain("salary");
    }),
  ));

test("install writes run-scoped settings and passes them with Claude's own flag", () =>
  withLaunch(
    Effect.gen(function* () {
      const args = yield* claude.install({
        agent: "build-r1",
        harness: "claude",
        cwd: rig.projectDir,
        dir,
      });

      const settings = path.join(dir, "settings.json");
      expect(args.args).toEqual(["--settings", settings]);
      const written = yield* fs.readFileString(settings);
      expect(written).toContain(`"statusLine"`);
      expect(written).toContain(`"PreCompact"`);
      expect(written).toContain(`"PostCompact"`);
      expect(written).toContain(`"manual|auto"`);
      expect(written).toContain(`herdr compaction ${dir}`);
      expect(written).toContain(`"PreToolUse"`);
      expect(written).toContain(`"AskUserQuestion"`);
    }),
  ));

onMachineWith("claude")(
  "the installed Claude is at least the release these controls were verified against",
  () =>
    withLaunch(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("claude") ?? "";
        const installed = yield* Effect.promise(() => Bun.$`claude --version`.text());
        // WARNING: A floor, not an equality: an exact version failed the day Claude updated, which says nothing about the interface.
        expect([Str.trim(installed), atLeast(installed, wanted)]).toEqual([
          Str.trim(installed),
          true,
        ]);
        yield* claude.gate;
      }),
    ),
  { timeout: 30_000 },
);

onMachineWith("claude")(
  "Claude still takes the settings flag the adapter launches an agent with",
  () =>
    withLaunch(
      Effect.gen(function* () {
        const [flag = ""] = (yield* claude.install({
          agent: "r1",
          harness: "claude",
          cwd: rig.projectDir,
          dir,
        })).args;
        const help = yield* Effect.promise(() => Bun.$`claude --help`.text());
        expect(help).toMatch(new RegExp(`(^|[\\s,])${flag}([\\s,=]|$)`, "m"));
      }),
    ),
  { timeout: 30_000 },
);

const encodeLimited = flow(
  Schema.encodeResult(
    Schema.fromJsonString(Schema.Struct({ ...StatusLine.fields, rate_limits: Schema.Json })),
  ),
  Result.getOrThrow,
);
const limited = (rateLimits: Schema.Json) =>
  encodeLimited({
    session_id: "s-1",
    context_window: {
      total_input_tokens: 15_500,
      total_output_tokens: 1200,
      used_percentage: 8,
      current_usage: {
        input_tokens: 8500,
        output_tokens: 1200,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 2000,
      },
    },
    rate_limits: rateLimits,
  });
const fiveHour = (percent: number) => ({
  five_hour: { used_percentage: percent, resets_at: 1_791_457_799 },
  seven_day: { used_percentage: 88, resets_at: 1_791_544_799 },
});

test("a status line's rate_limits are the Machine's newest Claude sample, and its line still prints", () =>
  withLaunch(
    Effect.gen(function* () {
      const stateDir = path.join(rig.root, "state");
      const agentDir = path.join(stateDir, "compaction", "build-r1");

      expect(yield* newestRateLimits(stateDir)).toBeNull();
      expect(yield* recordClaudeEvent(agentDir, limited(fiveHour(31)))).toBe("context: 8%");
      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(
        path.join(stateDir, "compaction", "review-r1"),
        limited(fiveHour(40)),
      );

      expect((yield* newestRateLimits(stateDir))?.limits).toEqual(fiveHour(40));
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("the status-line reader decodes again only the agents whose telemetry changed", () =>
  withLaunch(
    Effect.gen(function* () {
      const stateDir = path.join(rig.root, "state");
      const build = path.join(stateDir, "compaction", "build-r1");
      const review = path.join(stateDir, "compaction", "review-r1");
      yield* recordClaudeEvent(build, limited(fiveHour(31)));
      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(review, limited(fiveHour(40)));

      const fs = yield* FileSystem.FileSystem;
      const decoded: Array<string> = [];
      const counting: FileSystem.FileSystem = {
        ...fs,
        readFileString: (file, encoding) => {
          decoded.push(path.basename(path.dirname(file)));
          return fs.readFileString(file, encoding);
        },
      };
      const { newest: read } = yield* rateLimitsReader(stateDir).pipe(
        Effect.provideService(FileSystem.FileSystem, counting),
      );
      expect((yield* read)?.limits).toEqual(fiveHour(40));
      expect(decoded.sort()).toEqual(["build-r1", "review-r1"]);

      decoded.length = 0;
      expect((yield* read)?.limits).toEqual(fiveHour(40));
      expect(decoded).toEqual([]);

      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(build, limited(fiveHour(55)));
      expect((yield* read)?.limits).toEqual(fiveHour(55));
      expect(decoded).toEqual(["build-r1"]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a status line the reader could not read is read again, and its last sample stands meanwhile", () =>
  withLaunch(
    Effect.gen(function* () {
      const stateDir = path.join(rig.root, "state");
      const build = path.join(stateDir, "compaction", "build-r1");
      const review = path.join(stateDir, "compaction", "review-r1");
      yield* recordClaudeEvent(build, limited(fiveHour(31)));
      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(review, limited(fiveHour(40)));

      const fs = yield* FileSystem.FileSystem;
      let failReview = true;
      const flaky: FileSystem.FileSystem = {
        ...fs,
        readFileString: (file, encoding) =>
          failReview && path.basename(path.dirname(file)) === "review-r1"
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "readFileString",
                }),
              )
            : fs.readFileString(file, encoding),
      };
      const { newest: read } = yield* rateLimitsReader(stateDir).pipe(
        Effect.provideService(FileSystem.FileSystem, flaky),
      );
      expect((yield* read)?.limits).toEqual(fiveHour(31));
      failReview = false;
      expect((yield* read)?.limits).toEqual(fiveHour(40));

      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(review, limited(fiveHour(60)));
      failReview = true;
      expect((yield* read)?.limits).toEqual(fiveHour(40));
      failReview = false;
      expect((yield* read)?.limits).toEqual(fiveHour(60));
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("rate_limits Collie cannot read leave the context line alone", () =>
  withLaunch(
    Effect.gen(function* () {
      const payload = limited({ five_hour: { used_percentage: "lots" } });
      expect(yield* recordClaudeEvent(dir, payload)).toBe("context: 8%");
      expect(yield* claude.usage(ctx())).toBe(16_700);
    }),
  ));

const encodeStop = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);
const stopFailure = (error: string, details?: string) =>
  encodeStop({
    session_id: "s-1",
    hook_event_name: "StopFailure",
    error,
    ...(details !== undefined && { error_details: details }),
    transcript_path: "/home/mk/.claude/projects/p/s-1.jsonl",
  });

test("a StopFailure on a spent subscription is the agent running out, with its transcript", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, limited({}));
      yield* recordClaudeEvent(dir, stopFailure("rate_limit"));
      expect(yield* ranOutSince(dir, 0)).toEqual({
        why: "rate_limit",
        transcript: "/home/mk/.claude/projects/p/s-1.jsonl",
      });
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

test("a stop another launch left is not this launch's refusal", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        stopFailure("authentication_failed", "OAuth token has expired. Please run /login."),
      );
      const exitOf = COMPACTION_PORTS.claude!.exitOf!;
      const ctx = (launch: string) => ({
        agent: "build-r1",
        harness: "claude",
        cwd: rig.projectDir,
        dir,
        endpoint: null,
        env: [`COLLIE_LAUNCH=${launch}`],
      });
      expect(yield* exitOf(ctx("l-2"))).toBeNull();
      expect(yield* exitOf(ctx("l-1"))).toBe("OAuth token has expired. Please run /login.");
    }),
  ));

test("a StopFailure on any other error is its harness stopping, saying its details", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        stopFailure("authentication_failed", "OAuth token has expired. Please run /login."),
      );
      expect(yield* stoppedSince(dir, 0)).toEqual({
        why: "OAuth token has expired. Please run /login.",
        transcript: "/home/mk/.claude/projects/p/s-1.jsonl",
        launch: "l-1",
      });
      expect(yield* ranOutSince(dir, 0)).toBeNull();
    }),
  ));

test("a transient overload is not running out", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, limited({}));
      yield* recordClaudeEvent(dir, stopFailure("overloaded"));
      expect(yield* ranOutSince(dir, 0)).toBeNull();
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

test("a status line with a window at 100% is the agent running out, saying the window and reset", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, limited(fiveHour(99)));
      expect(yield* ranOutSince(dir, 0)).toBeNull();
      yield* recordClaudeEvent(dir, limited(fiveHour(100)));
      expect((yield* ranOutSince(dir, 0))?.why).toMatch(/^session 100%, resets .+ \(in .+\)$/);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a status line's full window whose reset has passed is not the agent running out", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* TestClock.setTime(1_791_457_799 * 1000 + 60_000);
      yield* recordClaudeEvent(dir, limited(fiveHour(100)));
      expect(yield* ranOutSince(dir, 0)).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("the StopFailure hook is installed only on a Claude known to have it, for every error", () => {
  const [hook] = parseJson(Schema.Any, claudeSettings(dir, true)).hooks.StopFailure;
  expect(hook.matcher).toBeUndefined();
  expect(hook.hooks[0].command).toContain(`herdr compaction ${dir}`);
  expect(claudeSettings(dir, false)).not.toContain("StopFailure");
});

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const lostCompletion = (
  transcript: (askedIso: string) => string,
  written: { unmarked?: boolean; noEvents?: boolean } = {},
  takeover?: { launch: string } | { installed: string },
) =>
  Effect.gen(function* () {
    const control = `${rig.stateDir}/compaction/build-r1`;
    const asked = (yield* Clock.currentTimeMillis) - 11 * 60_000;
    const file = path.join(rig.root, "s-1.jsonl");
    yield* fs.writeFileString(file, transcript(isoAt(asked + 60_000)));
    yield* fs.makeDirectory(control, { recursive: true });
    const attempt = {
      id: "req-1",
      run: "run-1",
      step: "02-ui",
      deadline: asked + 5 * 60_000,
      asked,
      session: "s-1",
      launch: "l-1",
      transcript: written.unmarked === true ? undefined : file,
    };
    yield* fs.writeFileString(
      `${control}/control.json`,
      asJson({ agent: "build-r1", harness: "claude", cwd: rig.projectDir, dir: control, attempt }),
    );
    if (written.noEvents !== true) {
      yield* recordClaudeEvent(control, asJson({ session_id: "s-1", transcript_path: file }));
      yield* recordClaudeEvent(
        control,
        pre("s-1", "manual", "Keep the work in progress. (collie:req-1)"),
      );
    }
    if (takeover !== undefined && "installed" in takeover) {
      yield* claude.install({
        agent: "build-r1",
        harness: "claude",
        cwd: rig.projectDir,
        dir: control,
        session: "s-1",
        env: [`COLLIE_LAUNCH=${takeover.installed}`],
      });
    } else if (takeover !== undefined) {
      const now = yield* Clock.currentTimeMillis;
      yield* fs.writeFileString(
        `${control}/events.jsonl`,
        `${asJson({ at: now, session: "s-1", kind: "start", launch: takeover.launch })}\n`,
        { flag: "a" },
      );
    }
    const said: Array<string> = [];
    const deps: CompactionDeps = {
      ports: COMPACTION_PORTS,
      stateDir: rig.stateDir,
      configured: 1000,
      herdr: { agentList: () => Effect.succeed([]) },
      log: (line) => Effect.sync(() => void said.push(line)),
      warn: (line) => Effect.sync(() => void said.push(line)),
      waitMs: 5 * 60_000,
      pollMs: 1000,
    };
    const due = yield* pollCompaction(deps, "build-r1");
    const left = (yield* readControl(rig.stateDir, "build-r1"))?.attempt;
    return { due, said, left };
  });

test("a lost completion is reconciled as done after the bound, where the transcript names the marked request", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, said, left } = yield* lostCompletion(
        (at) => `${naming("req-1", at)}\n${boundaryAt(at)}\n`,
      );
      expect(due).toEqual({ dispatch: true });
      expect(left).toBeNull();
      expect(said).toContain("build-r1: native compaction req-1 completed");
    }),
  ));

test("a replacement launch settles nothing even where its own hooks were lost", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) => `${naming("req-1", at)}\n${boundaryAt(at)}\n`,
        {},
        { installed: "l-2" },
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a lost completion whose transcript shows no completion of it stays unresolved", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","message":{"role":"user","content":"/compact"}}\n`,
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a boundary with no evidence of the launch that asked settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) => `${naming("req-1", at)}\n${boundaryAt(at)}\n`,
        { noEvents: true },
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a boundary a replacement launch appended to the same session settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) => `${naming("req-1", at)}\n${boundaryAt(at)}\n`,
        {},
        { launch: "l-2" },
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a command word that merely starts like /compact settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","sessionId":"s-1","message":{"role":"user","content":"/compactly (collie:req-1)"}}\n${boundaryAt(at)}\n`,
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("an argument that merely quotes the marker settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","sessionId":"s-1","message":{"role":"user","content":"/compact repeat what (collie:req-1) said"}}\n${boundaryAt(at)}\n`,
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a command Claude records as tags settles the request it was given", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","sessionId":"s-1","message":{"role":"user","content":"<command-name>/compact</command-name>\\n<command-message>compact</command-message>\\n<command-args>Keep the work in progress, the decisions taken and what is left to do. (collie:req-1)</command-args>"}}\n${boundaryAt(at)}\n`,
      );
      expect(due).toEqual({ dispatch: true });
      expect(left).toBeNull();
    }),
  ));

test("a user row of parts between the ask and the boundary ends the marked turn", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) =>
          `${naming("req-1", at)}\n{"type":"user","timestamp":"${at}","sessionId":"s-1","message":{"role":"user","content":[{"type":"text","text":"and one more thing"}]}}\n${boundaryAt(at)}\n`,
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a transcript that merely mentions the marked request settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","sessionId":"s-1","message":{"role":"user","content":"please compact later with the marker (collie:req-1)"}}\n${boundaryAt(at)}\n`,
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

const naming = (request: string, at: string) =>
  `{"type":"user","timestamp":"${at}","sessionId":"s-1","message":{"role":"user","content":"/compact Keep the work in progress, the decisions taken and what is left to do. (collie:${request})"}}`;

const boundaryAt = (at: string, trigger = "manual", session = "s-1") =>
  `{"type":"system","subtype":"compact_boundary","timestamp":"${at}","sessionId":"${session}","compactMetadata":{"trigger":"${trigger}","preTokens":180000}}`;

const lostAttempt = (evidence: {
  transcript?: (after: string, asked: string) => string;
  also?: (control: string, after: string, asked: string) => Effect.Effect<void, never>;
}) =>
  Effect.gen(function* () {
    const control = `${rig.stateDir}/compaction/build-r1`;
    const asked = (yield* Clock.currentTimeMillis) - 11 * 60_000;
    const file = path.join(rig.root, "s-1.jsonl");
    const [afterIso, askedIso] = [isoAt(asked + 60_000), isoAt(asked)];
    yield* fs.writeFileString(file, evidence.transcript?.(afterIso, askedIso) ?? "");
    yield* fs.makeDirectory(control, { recursive: true });
    yield* fs.writeFileString(
      `${control}/control.json`,
      asJson({
        agent: "build-r1",
        harness: "claude",
        cwd: rig.projectDir,
        dir: control,
        attempt: {
          id: "req-1",
          run: "run-1",
          step: "02-ui",
          deadline: asked + 5 * 60_000,
          asked,
          session: "s-1",
          launch: "l-1",
          transcript: file,
        },
      }),
    );
    yield* recordClaudeEvent(
      control,
      asJson({ session_id: "s-1", transcript_path: file, hook_event_name: "SessionStart" }),
    );
    if (evidence.also !== undefined) {
      yield* evidence.also(control, afterIso, askedIso);
    }
    const deps: CompactionDeps = {
      ports: COMPACTION_PORTS,
      stateDir: rig.stateDir,
      configured: 1000,
      herdr: { agentList: () => Effect.succeed([]) },
      log: () => Effect.void,
      warn: () => Effect.void,
      waitMs: 5 * 60_000,
      pollMs: 1000,
    };
    const due = yield* pollCompaction(deps, "build-r1");
    const left = (yield* readControl(rig.stateDir, "build-r1"))?.attempt;
    return { due, left };
  });

test("a completion the hook can record nowhere exits non-zero", () =>
  withLaunch(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      const instructions = pipe_(prompted[0]!, Str.replace(/^\/compact /, ""));
      yield* recordClaudeEvent(dir, pre("s-1", "manual", instructions));
      yield* fs.chmod(dir, 0o555);
      const exited = yield* Effect.sync(() =>
        Bun.spawnSync({
          cmd: [process.execPath, `${import.meta.dir}/../src/main.ts`, "herdr", "compaction", dir],
          cwd: rig.root,
          stdin: Buffer.from(post("s-1", "manual")),
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      yield* fs.chmod(dir, 0o755);
      expect(exited.stderr.toString()).toContain("could not be recorded");
      expect(exited.exitCode).not.toBe(0);
    }),
  ));

test("a boundary from an earlier compaction, before the mark, does not settle it", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (_after, asked) =>
          `${naming("req-1", asked)}\n${boundaryAt(isoAt(epochMs(asked) - 60_000))}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a boundary from another request does not settle it", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) =>
          `${naming("req-1", after)}\n${naming("req-2", after)}\n${boundaryAt(after)}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a boundary from another incarnation of the same agent does not settle it", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        also: (control, after) =>
          fs
            .writeFileString(
              `${control}/events.jsonl`,
              `${asJson({ at: epochMs(after), session: "s-2", kind: "start", request: "req-1" })}\n${asJson({ at: epochMs(after) + 1, session: "s-2", kind: "auto", reason: "manual", phase: "post" })}\n`,
              { flag: "a" },
            )
            .pipe(Effect.orDie),
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("two candidate completions settle nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) =>
          `${naming("req-1", after)}\n${boundaryAt(after)}\n${boundaryAt(after)}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a lost completion that is an automatic compaction is not the marked request's", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) => `${naming("req-1", after)}\n${boundaryAt(after, "auto")}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("the same request named twice in the transcript settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) =>
          `${naming("req-1", after)}\n${naming("req-1", after)}\n${boundaryAt(after)}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a transcript the mark did not name is not read, whoever wrote it there", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostCompletion(
        (after) => `${naming("req-1", after)}\n${boundaryAt(after)}\n`,
        { unmarked: true },
      );
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a completion from another launch of the same session does not settle it", () =>
  withLaunch(
    Effect.gen(function* () {
      const events = [
        { at: 0, session: "s-1", kind: "session" },
        { at: 1, session: "s-1", kind: "start", request: "req-1", launch: "l-1" },
        { at: 2, session: "s-1", kind: "auto", reason: "manual", phase: "post", launch: "l-1" },
      ];
      yield* fs.writeFileString(
        `${dir}/events.jsonl`,
        `${Arr.join(
          Arr.map(events, (one) => asJson(one)),
          "\n",
        )}\n`,
      );

      expect(yield* claude.poll(ctx(), markedOn("req-1", "l-1"))).toEqual({ kind: "success" });
      expect(yield* claude.poll(ctx(), markedOn("req-1", "l-2"))).toBeNull();
    }),
  ));

test("a session from before the turn record is still taken when its own submit is in the telemetry", () =>
  withLaunch(
    Effect.gen(function* () {
      const dir = path.join(rig.root, "aged");
      yield* fs.makeDirectory(dir, { recursive: true });
      expect(yield* turnTaken(dir, "s-1")).toBe(false);
      yield* fs.writeFileString(
        `${dir}/events.jsonl`,
        `${asJson({ at: 0, session: "s-1", kind: "session" })}\n${asJson({
          at: 1,
          session: "s-1",
          kind: "submit",
          reason: "collie",
        })}\n`,
      );
      expect(yield* fs.exists(`${dir}/turns.jsonl`)).toBe(false);
      expect(yield* turnTaken(dir, "s-1")).toBe(true);
      expect(yield* turnTaken(dir, "s-2")).toBe(false);
    }),
  ));

test("a session from before the turn record is still taken when its transcript holds a conversation", () =>
  withLaunch(
    Effect.gen(function* () {
      const dir = path.join(rig.root, "aged-conversation");
      const transcript = path.join(rig.root, "s-3.jsonl");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(transcript, `${naming("req-9", isoAt(1))}\n`);
      yield* recordEvent(dir, { session: "s-3", kind: "usage", transcript });
      expect(yield* turnTaken(dir, "s-3")).toBe(true);
      yield* fs.writeFileString(transcript, "");
      expect(yield* turnTaken(dir, "s-3")).toBe(false);
    }),
  ));

test("a boundary whose trigger nobody recorded settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) =>
          `${naming("req-1", after)}\n{"type":"system","subtype":"compact_boundary","timestamp":"${after}"}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a boundary another session wrote into the same transcript settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) => `${naming("req-1", after)}\n${boundaryAt(after, "manual", "s-2")}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));

test("a boundary that names no request settles nothing", () =>
  withLaunch(
    Effect.gen(function* () {
      const { due, left } = yield* lostAttempt({
        transcript: (after) => `${boundaryAt(after)}\n`,
      });
      expect(due).toBeNull();
      expect(left).not.toBeNull();
    }),
  ));
