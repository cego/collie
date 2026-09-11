// Claude Code's official compaction interface, as Collie's adapter installs and reads
// it: the status-line accounting, the manual-versus-automatic hook lifecycle, and what
// may not complete an attempt. The payloads are the documented ones; the version and
// launch-flag checks run against the installed harness.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { COMPACTION_PORTS, recordClaudeEvent, VERIFIED_VERSIONS } from "../src/compactors";
import type { AgentContext } from "../src/compaction";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const claude = COMPACTION_PORTS.claude!;
const prompted: string[] = [];

const ctx = (): AgentContext => ({
  agent: "build-r1",
  harness: "claude",
  cwd: rig.projectDir,
  dir,
  endpoint: null,
  herdr: {
    agentPrompt: (_target, text) =>
      Effect.sync(() => {
        prompted.push(text);
        return "observed" as const;
      }),
  },
});

/**
 * A status-line payload, as `docs/en/statusline` documents it. `current_usage` present
 * means the window has been measured; the combined totals already fold the cache
 * components into `total_input_tokens`.
 */
const StatusLine = Schema.Struct({
  session_id: Schema.String,
  context_window: Schema.NullOr(
    Schema.Struct({
      total_input_tokens: Schema.Number,
      total_output_tokens: Schema.Number,
      used_percentage: Schema.NullOr(Schema.Number),
      current_usage: Schema.NullOr(
        Schema.Struct({
          input_tokens: Schema.Number,
          output_tokens: Schema.Number,
          cache_creation_input_tokens: Schema.Number,
          cache_read_input_tokens: Schema.Number,
        }),
      ),
    }),
  ),
  cost: Schema.optionalKey(Schema.Struct({ total_cost_usd: Schema.Number })),
});
const encodeStatusLine = Schema.encodeSync(Schema.fromJsonString(StatusLine));

/**
 * The two hook payloads as the installed release builds them:
 * `hook_event_name:"PreCompact",trigger,custom_instructions` and
 * `hook_event_name:"PostCompact",trigger,compact_summary`. The instructions reach
 * `PreCompact` only — a `PostCompact` has no field carrying Collie's marker, which is
 * why a completion is correlated by position rather than by token.
 */
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
const encodePre = Schema.encodeSync(Schema.fromJsonString(Pre));
const encodePost = Schema.encodeSync(Schema.fromJsonString(Post));

/** One compaction's pair of hooks, as Claude fires them. */
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

const measured = (session: string, input: number, output: number, percent: number) =>
  encodeStatusLine({
    session_id: session,
    context_window: {
      total_input_tokens: input,
      total_output_tokens: output,
      used_percentage: percent,
      current_usage: {
        input_tokens: input - 7_000,
        output_tokens: output,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 2_000,
      },
    },
    // A cumulative billing total sits in the same payload. Reading it would be the
    // mistake this accounting exists to avoid.
    cost: { total_cost_usd: 12.5 },
  });

/** Before the first API call, and again after a compaction: nothing is measured. */
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
      // 15,500 already contains the 5,000 written to cache and the 2,000 read from it.
      const line = yield* recordClaudeEvent(dir, measured("s-1", 15_500, 1_200, 8));

      expect(yield* claude.usage(ctx())).toBe(16_700);
      // The status line Collie borrowed still says something to the human.
      expect(line).toBe("context: 8%");
    }),
  ));

test("no measurement yet is unavailable, not a context of zero tokens", () =>
  runEffect(
    Effect.gen(function* () {
      const line = yield* recordClaudeEvent(dir, unmeasured("s-1"));

      expect(yield* claude.usage(ctx())).toBeNull();
      expect(line).toBe("context: not measured yet");
    }),
  ));

test("a compaction invalidates the sample before it, until the next API call", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1_000, 99));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      yield* recordClaudeEvent(dir, unmeasured("s-1"));

      expect(yield* claude.usage(ctx())).toBeNull();
    }),
  ));

test("the marked PreCompact is the start, and the PostCompact after it the success", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1_000, 99));
      yield* claude.request(ctx(), "req-1");
      const instructions = prompted[0]!.replace(/^\/compact /, "");
      expect(prompted[0]).toStartWith("/compact ");
      expect(instructions).toContain("(collie:req-1)");

      // `PreCompact` gives the instructions back, which is what says this compaction
      // is Collie's. Its `PostCompact` carries no such field, so what completes the
      // attempt is the next manual completion on this session.
      yield* recordClaudeEvent(dir, pre("s-1", "manual", instructions));
      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      expect(yield* claude.poll(ctx(), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("a completion before Collie asked is not the answer to what it asked", () =>
  runEffect(
    Effect.gen(function* () {
      // A compaction that finished before the request was submitted — a human's, or
      // one from an earlier attempt — is already in the file when Collie asks.
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));

      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("an automatic compaction cannot complete Collie's request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, pre("s-1", "auto", null));
      yield* recordClaudeEvent(dir, post("s-1", "auto"));

      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a human typing /compact in the pane cannot complete it either", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      // Their own `/compact`, with instructions of their own: the completion that
      // follows is theirs, and Collie's attempt stays unresolved rather than taking it.
      yield* recordClaudeEvent(dir, pre("s-1", "manual", "just tidy it up please"));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));

      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("another session's hooks cannot complete it, and rebind what is current", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(dir, measured("s-1", 400_000, 1_000, 99));
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, post("s-2", "manual"));

      // The newest identity is s-2, so s-1's 400k no longer describes this agent — and
      // s-2's completion is not the attempt Collie made on s-1.
      expect(yield* claude.usage(ctx())).toBeNull();
      expect(yield* claude.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a duplicate PostCompact says success once, not twice, and never a failure", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claude.request(ctx(), "req-1");
      yield* recordClaudeEvent(dir, pre("s-1", "manual", `x (collie:req-1)`));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));
      yield* recordClaudeEvent(dir, post("s-1", "manual"));

      expect(yield* claude.poll(ctx(), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("a payload Collie cannot decode records nothing and prints nothing", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* recordClaudeEvent(dir, "not json")).toBe("");
      expect(yield* claude.usage(ctx())).toBeNull();
    }),
  ));

test("the helpers record identity, usage and outcome — never conversation content", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordClaudeEvent(
        dir,
        // A real payload carries a transcript path and, on PostCompact, the summary
        // the compaction produced.
        `{"session_id":"s-1","transcript_path":"/home/mk/.claude/x.jsonl","hook_event_name":"PostCompact","trigger":"manual","compact_summary":"The user asked about their salary."}`,
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
      // The status line is the official current-context contract; the two hooks are
      // the official lifecycle, matched on both triggers so an automatic compaction
      // is seen too. Everything points at the runner that installed them.
      expect(written).toContain(`"statusLine"`);
      expect(written).toContain(`"PreCompact"`);
      expect(written).toContain(`"PostCompact"`);
      expect(written).toContain(`"manual|auto"`);
      expect(written).toContain(`'herdr' 'compaction' '${dir}'`);
    }),
  ));

// Not mocks: whether the interface Collie installs is the one this machine's Claude has
// is exactly the question a mock cannot answer.
test(
  "the installed Claude is at least the release these controls were verified against",
  () =>
    runEffect(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("claude") ?? "";
        const installed = yield* Effect.promise(() => Bun.$`claude --version`.text());
        expect(installed.trim()).toStartWith(wanted);
        yield* claude.gate();
      }),
    ),
  { timeout: 30_000 },
);

test(
  "Claude still takes the settings flag the adapter launches an agent with",
  () =>
    runEffect(
      Effect.gen(function* () {
        const help = yield* Effect.promise(() => Bun.$`claude --help`.text());
        expect(help).toContain("--settings");
      }),
    ),
  { timeout: 30_000 },
);
