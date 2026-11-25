import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { parseJson } from "../src/json";
import { isoAt } from "../src/time";
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
  stoppedSince,
  submittedDelivery,
  VERIFIED_VERSIONS,
} from "../src/compactors";
import { pollCompaction, readControl } from "../src/compaction";
import { textHash } from "../src/steering";
import type { CompactionDeps } from "../src/compaction";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const claude = COMPACTION_PORTS.claude!;
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
  runEffect(
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
  runEffect(
    Effect.gen(function* () {
      // WARNING: 15,500 already contains the cache writes and reads; do not add them again.
      const line = yield* recordClaudeEvent(dir, measured("s-1", 15_500, 1200, 8), null);

      expect(yield* claude.usage(ctx())).toBe(16_700);
      expect(line).toBe("context: 8%");
    }),
  ));

test("no measurement yet is unavailable, not a context of zero tokens", () =>
  runEffect(
    Effect.gen(function* () {
      const line = yield* recordClaudeEvent(dir, unmeasured("s-1"), null);

      expect(yield* claude.usage(ctx())).toBeNull();
      expect(line).toBe("context: not measured yet");
    }),
  ));

test("a compaction invalidates the sample before it, until the next API call", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1000, 99), null);
      yield* recordClaudeEvent(dir, post("s-1", "manual"), null);
      yield* recordClaudeEvent(dir, unmeasured("s-1"), null);

      expect(yield* claude.usage(ctx())).toBeNull();
    }),
  ));

test("the marked PreCompact is the start, and the PostCompact after it the success", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1000, 99), null);
      yield* claude.request(ctx(), "req-1");
      const instructions = pipe_(prompted[0]!, Str.replace(/^\/compact /, ""));
      expect(prompted[0]).toStartWith("/compact ");
      expect(instructions).toContain("(collie:req-1)");

      // WARNING: PostCompact carries no marker, so the next manual completion on the session is what finishes the attempt.
      yield* recordClaudeEvent(dir, pre("s-1", "manual", instructions), null);
      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
      yield* recordClaudeEvent(dir, post("s-1", "manual"), null);
      expect(yield* claude.poll(ctx(), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("a completion before Collie asked is not the answer to what it asked", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, post("s-1", "manual"), null);
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`), null);

      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("an automatic compaction cannot complete Collie's request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`), null);
      yield* recordClaudeEvent(dir, pre("s-1", "auto", null), null);
      yield* recordClaudeEvent(dir, post("s-1", "auto"), null);

      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a human typing /compact in the pane cannot complete it either", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`), null);
      yield* recordClaudeEvent(dir, pre("s-1", "manual", "just tidy it up please"), null);
      yield* recordClaudeEvent(dir, post("s-1", "manual"), null);

      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("another session's hooks cannot complete it, and rebind what is current", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1000, 99), null);
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`), null);
      yield* recordClaudeEvent(dir, post("s-2", "manual"), null);

      expect(yield* claude.usage(ctx())).toBeNull();
      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a duplicate PostCompact says success once, not twice, and never a failure", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`), null);
      yield* recordClaudeEvent(dir, post("s-1", "manual"), null);
      yield* recordClaudeEvent(dir, post("s-1", "manual"), null);

      expect(yield* claude.poll(ctx(), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("a background task finishing is Claude's own turn, not a person typing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        submit(
          "<task-notification>\n<task-id>b11e8rx1q</task-id>\n<status>completed</status>\n</task-notification>",
        ),
        null,
      );
      yield* recordClaudeEvent(
        dir,
        submit('<agent-message from="reviewer">\nthe review is done\n</agent-message>'),
        null,
      );

      yield* recordClaudeEvent(
        dir,
        submit("<task-notification>\n<summary>grep collie-delivery:run-1-steer-1</summary>"),
        null,
      );

      expect(yield* externalSubmissions(dir)).toBe(0);
      expect(
        yield* submittedDelivery(dir, {
          id: "run-1-steer-1",
          incarnation: null,
          text_hash: textHash("Stop and do this."),
        }),
      ).toBe(false);
    }),
  ));

test("a submission is Collie's when it carries a delivery token, and a person's otherwise", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        submit("collie-delivery:run-1-steer-1\nStop and do this."),
        "term-7",
      );
      yield* recordClaudeEvent(dir, submit("wait, use the other branch"), "term-7");

      expect(
        yield* submittedDelivery(dir, {
          id: "run-1-steer-1",
          incarnation: "term-7",
          text_hash: textHash("Stop and do this."),
        }),
      ).toBe(true);
      expect(
        yield* submittedDelivery(dir, {
          id: "run-1-steer-1",
          incarnation: "term-2",
          text_hash: textHash("Stop and do this."),
        }),
      ).toBe(false);
      expect(yield* externalSubmissions(dir)).toBe(1);
      const written = yield* fs.readFileString(path.join(dir, "events.jsonl"));
      expect(written).not.toContain("other branch");
    }),
  ));

test("a submit that names a delivery but carried other words does not settle it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        submit("collie-delivery:run-1-steer-1\nanother matter entirely"),
        "term-7",
      );

      expect(
        yield* submittedDelivery(dir, {
          id: "run-1-steer-1",
          incarnation: "term-7",
          text_hash: textHash("Stop and do this."),
        }),
      ).toBe(false);
    }),
  ));

test("a payload Collie cannot decode records nothing and prints nothing", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, "not json", null)).toBe("");
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
  runEffect(
    Effect.gen(function* () {
      yield* hostLive;
      const printed = yield* recordClaudeEvent(dir, asking("AskUserQuestion", TWO), null);

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
  runEffect(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", TWO), null)).toBe("");
      yield* fs.writeFileString(
        path.join(rig.root, "host.lock"),
        encodeJsonText({ pid: 2 ** 22 + 1, start: null }),
      );
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", TWO), null)).toBe("");
      expect(yield* questionsSince(dir, 0)).toEqual([]);
    }),
  ));

test("another tool, and a question Collie cannot decode, record and print nothing", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, asking("Bash", TWO), null)).toBe("");
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", [{ header: 1 }]), null)).toBe(
        "",
      );
      expect(yield* recordClaudeEvent(dir, asking("AskUserQuestion", "which?"), null)).toBe("");
      expect(yield* questionsSince(dir, 0)).toEqual([]);
    }),
  ));

test("the helpers record identity, usage and outcome — never conversation content", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        `{"session_id":"s-1","transcript_path":"/home/mk/.claude/x.jsonl","hook_event_name":"PostCompact","trigger":"manual","compact_summary":"The user asked about their salary."}`,
        null,
      );

      const written = yield* fs.readFileString(path.join(dir, "events.jsonl"));
      expect(written).toContain("s-1");
      expect(written).not.toContain("transcript");
      expect(written).not.toContain("salary");
    }),
  ));

test("install writes run-scoped settings and passes them with Claude's own flag", () =>
  runEffect(
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
    runEffect(
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
    runEffect(
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
  runEffect(
    Effect.gen(function* () {
      const stateDir = path.join(rig.root, "state");
      const agentDir = path.join(stateDir, "compaction", "build-r1");

      expect(yield* newestRateLimits(stateDir)).toBeNull();
      expect(yield* recordClaudeEvent(agentDir, limited(fiveHour(31)), null)).toBe("context: 8%");
      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(
        path.join(stateDir, "compaction", "review-r1"),
        limited(fiveHour(40)),
        null,
      );

      expect((yield* newestRateLimits(stateDir))?.limits).toEqual(fiveHour(40));
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("the status-line reader decodes again only the agents whose telemetry changed", () =>
  runEffect(
    Effect.gen(function* () {
      const stateDir = path.join(rig.root, "state");
      const build = path.join(stateDir, "compaction", "build-r1");
      const review = path.join(stateDir, "compaction", "review-r1");
      yield* recordClaudeEvent(build, limited(fiveHour(31)), null);
      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(review, limited(fiveHour(40)), null);

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
      yield* recordClaudeEvent(build, limited(fiveHour(55)), null);
      expect((yield* read)?.limits).toEqual(fiveHour(55));
      expect(decoded).toEqual(["build-r1"]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a status line the reader could not read is read again, and its last sample stands meanwhile", () =>
  runEffect(
    Effect.gen(function* () {
      const stateDir = path.join(rig.root, "state");
      const build = path.join(stateDir, "compaction", "build-r1");
      const review = path.join(stateDir, "compaction", "review-r1");
      yield* recordClaudeEvent(build, limited(fiveHour(31)), null);
      yield* TestClock.adjust("1 second");
      yield* recordClaudeEvent(review, limited(fiveHour(40)), null);

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
      yield* recordClaudeEvent(review, limited(fiveHour(60)), null);
      failReview = true;
      expect((yield* read)?.limits).toEqual(fiveHour(40));
      failReview = false;
      expect((yield* read)?.limits).toEqual(fiveHour(60));
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("rate_limits Collie cannot read leave the context line alone", () =>
  runEffect(
    Effect.gen(function* () {
      const payload = limited({ five_hour: { used_percentage: "lots" } });
      expect(yield* recordClaudeEvent(dir, payload, null)).toBe("context: 8%");
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
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, limited({}), null);
      yield* recordClaudeEvent(dir, stopFailure("rate_limit"), null);
      expect(yield* ranOutSince(dir, 0)).toEqual({
        why: "rate_limit",
        transcript: "/home/mk/.claude/projects/p/s-1.jsonl",
      });
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

test("a StopFailure on any other error is its harness stopping, saying its details", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        stopFailure("authentication_failed", "OAuth token has expired. Please run /login."),
        null,
      );
      expect(yield* stoppedSince(dir, 0)).toEqual({
        why: "OAuth token has expired. Please run /login.",
        transcript: "/home/mk/.claude/projects/p/s-1.jsonl",
      });
      expect(yield* ranOutSince(dir, 0)).toBeNull();
    }),
  ));

test("a transient overload is not running out", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, limited({}), null);
      yield* recordClaudeEvent(dir, stopFailure("overloaded"), null);
      expect(yield* ranOutSince(dir, 0)).toBeNull();
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

test("a status line with a window at 100% is the agent running out, saying the window and reset", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, limited(fiveHour(99)), null);
      expect(yield* ranOutSince(dir, 0)).toBeNull();
      yield* recordClaudeEvent(dir, limited(fiveHour(100)), null);
      expect((yield* ranOutSince(dir, 0))?.why).toMatch(/^session 100%, resets .+ \(in .+\)$/);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a status line's full window whose reset has passed is not the agent running out", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(1_791_457_799 * 1000 + 60_000);
      yield* recordClaudeEvent(dir, limited(fiveHour(100)), null);
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

const lostCompletion = (transcript: (askedIso: string) => string) =>
  Effect.gen(function* () {
    const control = `${rig.stateDir}/compaction/build-r1`;
    const asked = (yield* Clock.currentTimeMillis) - 11 * 60_000;
    const file = path.join(rig.root, "s-1.jsonl");
    yield* fs.writeFileString(file, transcript(isoAt(asked + 60_000)));
    yield* fs.makeDirectory(control, { recursive: true });
    yield* fs.writeFileString(
      `${control}/control.json`,
      asJson({
        agent: "build-r1",
        harness: "claude",
        cwd: rig.projectDir,
        dir: control,
        attempt: { id: "req-1", run: "run-1", step: "02-ui", deadline: asked + 5 * 60_000, asked },
      }),
    );
    yield* recordClaudeEvent(control, asJson({ session_id: "s-1", transcript_path: file }), null);
    yield* recordClaudeEvent(
      control,
      pre("s-1", "manual", "Keep the work in progress. (collie:req-1)"),
      null,
    );
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

test("a lost completion is reconciled as done after the bound, where the transcript shows the compaction", () =>
  runEffect(
    Effect.gen(function* () {
      const { due, said, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","message":{"role":"user","content":"/compact"}}\n` +
          `{"type":"system","subtype":"compact_boundary","timestamp":"${at}","compactMetadata":{"trigger":"manual","preTokens":180000}}\n`,
      );
      expect(due).toEqual({ dispatch: true });
      expect(left).toBeNull();
      expect(said).toContain("build-r1: native compaction req-1 completed");
    }),
  ));

test("a lost completion is reconciled as failed after the bound, where the transcript shows none", () =>
  runEffect(
    Effect.gen(function* () {
      const { due, said, left } = yield* lostCompletion(
        (at) =>
          `{"type":"user","timestamp":"${at}","message":{"role":"user","content":"/compact"}}\n`,
      );
      expect(due).toEqual({ dispatch: true });
      expect(left).toBeNull();
      expect(said).toEqual([
        "  ⚠ build-r1: native compaction failed (its transcript shows no compaction since it was asked for) — sending the work anyway",
      ]);
    }),
  ));
