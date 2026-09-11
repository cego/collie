// A steer is a question, and the thing that must not happen is that asking a question
// changes something. So: the journal has both turns, a proposal is recorded pending, and
// nothing at all reached an agent — whatever authority the Run has granted.

import { Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { steer } from "../src/operations";
import { RunStore } from "../src/run";
import { DEFAULT_AUTHORITY, seedIntent, writeIntent } from "../src/intent";
import { conversationPath, read as readConversation } from "../src/conversation";
import { proposalsPath, read as readProposals } from "../src/proposals";
import { budgetPath, readBudget } from "../src/steering";
import { currentEnv, type PluginEnv } from "../src/env";
import type { PlatformError } from "effect/PlatformError";
import { runEffect } from "./support/effect";

/** What the fake CLI prints, as a real envelope would carry it. */
const envelope = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let stateDir: string;
let env: PluginEnv;

const deps = (root: string) => ({
  herdKey: "herd-1",
  evaluator: {
    // Every flag present, so the gate lets the call through and the test is about what
    // comes back rather than about the gate.
    help: Effect.succeed(
      [
        "--print",
        "--output-format",
        "--json-schema",
        "--tools",
        "--restricted",
        "--strict-mcp-config",
        "--setting-sources",
        "--no-session-persistence",
        "--max-budget-usd",
        "--append-system-prompt-file",
      ].join(" "),
    ),
    systemPromptFile: `${root}/prompts/steward.md`,
    limits: {
      maxSeconds: 5,
      maxOutputBytes: 262_144,
      model: "sonnet",
      effort: "low",
    },
  },
  limits: {
    maxSeconds: 5,
    maxOutputBytes: 262_144,
    model: "sonnet",
    effort: "low",
  },
});

/** A `claude` on PATH that prints whatever the test put in `reply`. */
const fakeClaude = Effect.fn("test.fakeClaude")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = path.join(dir, "bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  const replyFile = path.join(dir, "reply.json");
  yield* fs.writeFileString(
    path.join(bin, "claude"),
    `#!/bin/sh\ncat > /dev/null\ncat ${replyFile}\n`,
  );
  yield* fs.chmod(path.join(bin, "claude"), 0o755);
  Bun.env.PATH = `${bin}:${Bun.env.PATH ?? ""}`;
  return (text: string) => fs.writeFileString(replyFile, text);
});

let setReply: (text: string) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>;
let originalPath: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-steer-" });
      originalPath = Bun.env.PATH ?? "";
      setReply = yield* fakeClaude(stateDir);
      yield* setReply("{}");
      env = { ...(yield* currentEnv), stateDir, socketPath: "/tmp/herd.sock" };
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      Bun.env.PATH = originalPath;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

const aRun = Effect.fn("test.aRun")(function* (authority = DEFAULT_AUTHORITY) {
  const run = yield* new RunStore(stateDir).create({
    workflow: "implement",
    cwd: stateDir,
    inputs: {},
    inputSources: {},
    stepIds: ["build"],
    maxIterations: 1,
    namedAfter: "picker",
  });
  yield* writeIntent(run.dir, { ...seedIntent(run.id, { goal: "add a picker" }), authority });
  return run;
});

test("asking about a Run records both turns and a pending proposal, and sends nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* aRun({ ...DEFAULT_AUTHORITY, auto_correct: true, now_allowed: true });
      yield* setReply(
        envelope({
          result: {
            interpretation: "it is building on the wrong branch",
            targets: [{ run: run.id }],
            actions: [{ kind: "hold", run: run.id }],
            confidence: 0.9,
          },
        }),
      );

      const result = yield* steer(env, deps(stateDir), {
        text: "why is it on main?",
        target: run.id,
        requestId: "req-1",
      });
      expect(result.ok).toBe(true);

      const turns = yield* readConversation(yield* conversationPath(stateDir, "herd-1"));
      expect(turns.map((turn) => turn.role)).toEqual(["human", "collie"]);
      expect(turns[1]?.proposal).toBeDefined();

      const proposals = yield* readProposals(yield* proposalsPath(stateDir, "herd-1"));
      const recorded = proposals.filter((line) => line.kind === "proposal");
      expect(recorded).toHaveLength(1);

      // The Run granted auto_correct and now; the proposal is still pending, because the
      // grant was for the Driver's own drift checks, not for a conversation's conclusions.
      if (result.ok && "proposal" in result.data) {
        // SAFETY: the envelope this operation returns names `proposal.actions` with a
        // `status` on each; the assertion above is what proves the branch was taken.
        const { proposal } = result.data as { proposal: { actions: Array<{ status: string }> } };
        expect(proposal.actions.map((a) => a.status)).toEqual(["pending"]);
      }

      // Nothing was queued for anybody: a question does not act.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(run.dir, "inbox"))).toBe(false);
    }),
  ));

test("a question with no target is answered, and cannot be a proposal", () =>
  runEffect(
    Effect.gen(function* () {
      yield* aRun();
      yield* setReply(
        envelope({
          result: {
            text: "two runs are going; neither is blocked",
            evidence_refs: [],
            targets: [],
          },
        }),
      );

      const result = yield* steer(env, deps(stateDir), {
        text: "what is going on?",
        requestId: "req-2",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.human).toContain("two runs are going");

      // Charged to the Herd rather than to a Run, because it was about neither.
      const budget = yield* readBudget(yield* budgetPath(stateDir, "herd-1"));
      const reserved = budget.filter((line) => line.kind === "reserve");
      expect(reserved).toHaveLength(1);
      expect(reserved[0]).toMatchObject({ run: null });

      // And nothing was recorded as a proposal, because there is nothing to confirm.
      const proposals = yield* readProposals(yield* proposalsPath(stateDir, "herd-1"));
      expect(proposals.filter((line) => line.kind === "proposal")).toEqual([]);
    }),
  ));

test("a Run nobody named is not one Collie will guess at", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* steer(env, deps(stateDir), {
        text: "stop it",
        target: "no-such-run",
        requestId: "req-3",
      });
      expect(result).toMatchObject({ ok: false, error: { code: "run_not_found" } });
    }),
  ));

test("every call is counted and costed, and none is refused over the count", () =>
  runEffect(
    Effect.gen(function* () {
      // An Intent from before spending caps were dropped still decodes, and the quota it
      // carries decides nothing: the user's decision is that usage is data, never a
      // restriction on their work.
      const run = yield* aRun({ ...DEFAULT_AUTHORITY, model_calls_per_run: 1 });
      yield* setReply(
        envelope({
          result: {
            interpretation: "slow down",
            targets: [{ run: run.id }],
            actions: [{ kind: "hold", run: run.id }],
            confidence: 0.5,
          },
          total_cost_usd: 0.0123,
        }),
      );

      for (const requestId of ["req-count-1", "req-count-2"]) {
        const result = yield* steer(env, deps(stateDir), {
          text: "slow down",
          target: run.id,
          requestId,
        });
        expect(result.ok).toBe(true);
      }

      // Both calls are in the record — started, then settled with what the CLI said they
      // cost — which is the telemetry that stays.
      const lines = yield* readBudget(yield* budgetPath(stateDir, "herd-1"));
      expect(lines.map((line) => line.kind)).toEqual(["reserve", "settle", "reserve", "settle"]);
      expect(lines.filter((line) => line.kind === "settle").map((line) => line.usd)).toEqual([
        0.0123, 0.0123,
      ]);
      expect(lines.filter((line) => line.kind === "reserve").map((line) => line.run)).toEqual([
        run.id,
        run.id,
      ]);
    }),
  ));

test("a dry run prints what it would propose and records nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* aRun();
      yield* setReply(
        envelope({
          result: {
            interpretation: "hold it while you look",
            targets: [{ run: run.id }],
            actions: [{ kind: "hold", run: run.id }],
            confidence: 0.7,
          },
        }),
      );

      const result = yield* steer(env, deps(stateDir), {
        text: "hold on a moment",
        target: run.id,
        dryRun: true,
        requestId: "req-4",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.human).toContain("hold it while you look");

      const proposals = yield* readProposals(yield* proposalsPath(stateDir, "herd-1"));
      expect(proposals.filter((line) => line.kind === "proposal")).toEqual([]);
    }),
  ));

test("a model that answers outside its schema is not acted on", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* aRun();
      yield* setReply(envelope({ result: "I think you should stop it" }));

      const result = yield* steer(env, deps(stateDir), {
        text: "what now?",
        target: run.id,
        requestId: "req-5",
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error.message).toContain("evaluator_invalid_output");

      // The call still cost something, and the budget still says so.
      const budget = yield* readBudget(yield* budgetPath(stateDir, "herd-1"));
      expect(budget.filter((line) => line.kind === "settle")).toMatchObject([
        { outcome: "failed" },
      ]);
    }),
  ));

test("the pack names the runs and the target's own intent, and no pane text", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = yield* aRun();
      // The fake keeps what it was given on stdin, which is the only way to see the pack.
      const packFile = path.join(stateDir, "pack.txt");
      yield* fs.writeFileString(
        path.join(stateDir, "bin", "claude"),
        `#!/bin/sh\ncat > ${packFile}\ncat ${path.join(stateDir, "reply.json")}\n`,
      );
      yield* fs.chmod(path.join(stateDir, "bin", "claude"), 0o755);
      yield* setReply(
        envelope({
          result: {
            interpretation: "it is adding a picker",
            targets: [{ run: run.id }],
            actions: [{ kind: "none", why: "nothing to do" }],
            confidence: 0.9,
          },
        }),
      );

      yield* steer(env, deps(stateDir), {
        text: "what is this run for?",
        target: run.id,
        requestId: "req-6",
      });

      const pack = yield* fs.readFileString(packFile);
      expect(pack).toContain("## The question");
      expect(pack).toContain("what is this run for?");
      expect(pack).toContain(run.id);
      expect(pack).toContain("Goal: add a picker");
      expect(pack).toContain("Intent version: 1");
      // What an agent is doing reaches this as herdr's own status, and no further: there
      // is no pane read anywhere in the pack's construction.
      expect(pack).not.toContain("paneRead");
    }),
  ));
