// The hand-off a confirmed compaction releases, through the path that carries it:
// Claude's own payloads into the real recorder, the real adapter's poll, the shared
// boundary, and the work the engine sends after it. Only the harness is a stand-in.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { fakeChannel } from "./support/compaction";
import {
  COMPACTION_PORTS,
  externalSubmissions,
  KEEP_LINES,
  recordClaudeEvent,
} from "../src/compactors";
import type { AgentContext, CompactionPort } from "../src/compaction";

let rig: Rig;
let bin: FakeBin;
let fs: FileSystem.FileSystem;
let path: Path.Path;

const claude = COMPACTION_PORTS.claude!;
const SESSION = "14847c86-4d69-4f11-8661-f35ad9a4897e";

/** The status line, on a measured window: one line per conversation update. */
const statusLine = (tokens: number) =>
  JSON.stringify({
    session_id: SESSION,
    context_window: {
      total_input_tokens: tokens,
      total_output_tokens: 0,
      used_percentage: 96,
      current_usage: { input_tokens: tokens },
    },
  });

/** A live claim on a lock, as `lock.ts` writes one, and one telemetry line as a control appends it. */
const encodeClaim = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, start: Schema.NullOr(Schema.String) })),
);
const encodeSample = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      at: Schema.Number,
      session: Schema.String,
      kind: Schema.String,
      tokens: Schema.Number,
    }),
  ),
);

/** A turn somebody typed into the pane themselves, carrying none of Collie's tokens. */
const userPrompt = (text: string) =>
  JSON.stringify({ session_id: SESSION, hook_event_name: "UserPromptSubmit", prompt: text });

/** The two hooks of one manual compaction, as the installed release fires them. */
const preCompact = (instructions: string) =>
  JSON.stringify({
    session_id: SESSION,
    hook_event_name: "PreCompact",
    trigger: "manual",
    custom_instructions: instructions,
  });
const postCompact = () =>
  JSON.stringify({
    session_id: SESSION,
    hook_event_name: "PostCompact",
    trigger: "manual",
    compact_summary: "what the agent was doing, condensed",
  });

/**
 * Claude's side of one compaction: the marked `/compact` reaches the pane, its hooks
 * record the start and the completion, and the agent then waits for work. `seed` is how
 * much ordinary status-line traffic came before the boundary.
 */
function harness(seed: number): CompactionPort {
  return {
    ...claude,
    // The installed release's version is checked by this file's own gate test; a
    // subprocess per launch would say nothing about the hand-off.
    gate: () => Effect.void,
    install: (ctx) =>
      Effect.gen(function* () {
        const installed = yield* claude.install(ctx);
        for (let i = 0; i < seed; i++) yield* recordClaudeEvent(ctx.dir, statusLine(577_493));
        return installed;
      }),
    request: (ctx, requestId) =>
      Effect.gen(function* () {
        let submitted = "";
        const channel = {
          ...ctx.channel,
          submit: (text: string, draft: Parameters<AgentContext["channel"]["submit"]>[1]) =>
            Effect.suspend(() => {
              submitted = text;
              return ctx.channel.submit(text, draft);
            }),
        };
        const outcome = yield* claude.request({ ...ctx, channel }, requestId);
        // The instructions Collie submitted are what `PreCompact` gives back, marker
        // and all: the correlation crosses the harness rather than being handed over.
        yield* recordClaudeEvent(ctx.dir, preCompact(submitted.replace(/^\/compact /, "")));
        yield* recordClaudeEvent(ctx.dir, postCompact());
        return outcome;
      }),
  };
}

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("git", `echo main`);
      // Two steps, the second on the first's agent: the smallest workflow with a work
      // boundary in it.
      yield* writeDef(
        path.join(rig.projectDir, ".herdr"),
        "workflows",
        "reuse",
        `---
name: reuse
inputs: {}
steps:
  - id: one
    persona: implementer
    output: one.json
  - id: two
    persona: implementer
    agent: one
    output: two.json
---

## one

Do the first thing.

## two

Do the second thing.
`,
      );
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

test(
  "a compaction confirmed before its deadline releases the waiting work, once",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        // Hours of ordinary traffic, so the completion is the write that trims the
        // file. An agent that has just compacted is idle: nothing writes after it, and
        // what that write dropped is what every poll until the deadline reads.
        const port = { claude: harness(KEEP_LINES - 2) };

        const { run, status, lines } = yield* runWorkflow(
          rig,
          "reuse",
          {},
          {
            compaction: port,
            outputPollMs: 20,
            compactionWaitMs: 2_000,
          },
        );

        expect(status).toBe("done");
        expect(lines.join("\n")).toContain("asking it to compact before two");
        const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
        expect(log).toContain("native compaction");
        // The work the boundary was holding: sent, after the completion, exactly once.
        const prompts = (yield* rig.calls()).filter((call) => call.cmd === "agent prompt");
        const compactions = prompts.filter((call) => (call.argv![3] ?? "").startsWith("/compact"));
        const waiting = prompts.filter((call) =>
          (call.argv![3] ?? "").includes(path.join("steps", "two")),
        );
        expect([compactions.length, waiting.length]).toEqual([1, 1]);
      }),
    ),
  { timeout: 30_000 },
);

const ctx = (dir: string): AgentContext => ({
  agent: "build-r1",
  run: "run-1",
  harness: "claude",
  cwd: rig.projectDir,
  dir,
  endpoint: null,
  channel: fakeChannel([]),
});

test("a compaction outlasted by its own status line is still the attempt's own", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });

      yield* recordClaudeEvent(dir, statusLine(577_493));
      yield* recordClaudeEvent(dir, preCompact("keep the work in progress (collie:req-1)"));
      // A long compaction on a busy pane writes more status lines than the file keeps.
      for (let i = 0; i < KEEP_LINES + 20; i++) yield* recordClaudeEvent(dir, statusLine(577_493));
      yield* recordClaudeEvent(dir, postCompact());

      expect(yield* claude.poll(ctx(dir), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("ordinary traffic past the cap never leaves the agent's telemetry unreadable", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });

      // Every write, not a chosen one: the sample and the session it belongs to have to
      // survive each trim, because the next read may be the only one before a deadline.
      for (let i = 0; i < KEEP_LINES * 2; i++) {
        yield* recordClaudeEvent(dir, statusLine(100_000 + i));
        expect(yield* claude.usage(ctx(dir))).toBe(100_000 + i);
      }
    }),
  ));

test("a human's submission survives an agent with hundreds of compactions behind it", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });

      for (let i = 0; i < 98; i++) {
        yield* recordClaudeEvent(dir, preCompact(`keep it (collie:req-${i})`));
        yield* recordClaudeEvent(dir, postCompact());
      }
      yield* recordClaudeEvent(dir, userPrompt("do it this way instead"));
      for (let i = 0; i < 2; i++) yield* recordClaudeEvent(dir, statusLine(120_000));

      expect(yield* externalSubmissions(dir)).toBe(1);
      for (let i = 0; i < 20; i++) yield* recordClaudeEvent(dir, statusLine(130_000));
      expect(yield* externalSubmissions(dir)).toBe(1);
    }),
  ));

test(
  "a helper process waits for the writer holding the file, rather than writing past it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const dir = path.join(rig.root, "controls", "build-r1");
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* recordClaudeEvent(dir, statusLine(577_493));
        yield* recordClaudeEvent(dir, preCompact("keep the work in progress (collie:req-1)"));
        const file = path.join(dir, "events.jsonl");
        // What a status line that has read the file, and not yet written it back, holds.
        const snapshot = yield* fs.readFileString(file);
        yield* fs.writeFileString(
          path.join(dir, "events.lock"),
          `${encodeClaim({ pid: process.pid, start: null })}\n`,
        );

        const helper = path.join(import.meta.dir, "..", "src", "main.ts");
        const hook = Bun.spawn(["bun", helper, "herdr", "compaction", dir], {
          stdin: new TextEncoder().encode(postCompact()),
          stdout: "ignore",
          stderr: "ignore",
        });
        yield* Effect.sleep("2 seconds");

        // A writer that gave up on the lock and wrote anyway would have exited by now.
        expect([hook.exitCode, yield* claude.poll(ctx(dir), "req-1")]).toEqual([null, null]);
        yield* fs.writeFileString(
          file,
          `${snapshot.trim()}\n${encodeSample({ at: 1, session: SESSION, kind: "usage", tokens: 600_000 })}\n`,
        );
        yield* fs.remove(path.join(dir, "events.lock"));
        yield* Effect.promise(() => hook.exited);

        expect(yield* claude.usage(ctx(dir))).toBe(600_000);
        expect(yield* claude.poll(ctx(dir), "req-1")).toEqual({ kind: "success" });
      }),
    ),
  { timeout: 60_000 },
);

test(
  "an event no helper could record leaves the attempt unresolved, not completed",
  () =>
    runEffect(
      Effect.gen(function* () {
        const dir = path.join(rig.root, "controls", "build-r1");
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* recordClaudeEvent(dir, statusLine(577_493));
        yield* recordClaudeEvent(dir, preCompact("keep the work in progress (collie:req-1)"));
        yield* fs.writeFileString(
          path.join(dir, "events.lock"),
          `${encodeClaim({ pid: process.pid, start: null })}\n`,
        );

        // The human types `/compact` in the same pane. Their start is what makes the
        // completion after it theirs — and it is the event that never gets written.
        const helper = path.join(import.meta.dir, "..", "src", "main.ts");
        const theirs = Bun.spawn(["bun", helper, "herdr", "compaction", dir], {
          stdin: new TextEncoder().encode(preCompact("just tidy it up please")),
          stdout: "ignore",
          stderr: "ignore",
        });
        yield* Effect.promise(() => theirs.exited);
        yield* fs.remove(path.join(dir, "events.lock"));
        yield* recordClaudeEvent(dir, postCompact());

        expect(yield* claude.poll(ctx(dir), "req-1")).toBeNull();
      }),
    ),
  { timeout: 60_000 },
);
