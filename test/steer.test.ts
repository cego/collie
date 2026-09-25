// A steer is a question, and the thing that must not happen is that asking a question
// changes something. So: the journal has both turns, a proposal is recorded pending, and
// nothing at all reached an agent — whatever authority the Run has granted.

import { Effect, FileSystem, Path, Schema, type Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { expect, setDefaultTimeout, test } from "bun:test";
import { steer } from "../src/operations";
import { DEFAULT_AUTHORITY, readIntent, type Authority } from "../src/intent";
import { conversationPath, read as readConversation } from "../src/conversation";
import { proposalsPath, read as readProposals } from "../src/proposals";
import { budgetPath, herdOf, readBudget } from "../src/steering";
import type { PluginEnv } from "../src/env";
import type { PlatformError } from "effect/PlatformError";
import { hosted, hostedRun } from "./support/hosted";
import type { World } from "./support/world";

// Every test here stands a host up: the Runs a steer is about are the host's.
setDefaultTimeout(60_000);

/** What the fake CLI prints, as a real envelope would carry it. */
const envelope = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let world: World;
let stateDir: string;
let env: PluginEnv;
let herdKey: string;

const deps = (root: string) => ({
  herdKey: herdKey,
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

/** One test, in a Herd of its own with a host in it, and a `claude` that says what it is told. */
const inWorld = <A, E>(body: Effect.Effect<A, E, BunServices | Scope.Scope>) =>
  hosted("hw-steer-", (herd) =>
    Effect.gen(function* () {
      world = herd.world;
      stateDir = world.state;
      env = herd.env;
      originalPath = Bun.env.PATH ?? "";
      setReply = yield* fakeClaude(stateDir);
      yield* setReply("{}");
      herdKey = yield* herdOf(env.socketPath);
      return yield* body.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Bun.env.PATH = originalPath;
          }),
        ),
      );
    }),
  );

const aRun = (authority: Authority = DEFAULT_AUTHORITY) =>
  hostedRun(world, "add a picker", authority);

test("a steer executes the requested change without a confirmation hop", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun({ ...DEFAULT_AUTHORITY, auto_correct: true, now_allowed: true });
      yield* setReply(
        envelope({
          result: {
            interpretation: "update the goal",
            targets: [{ run: run.id }],
            actions: [
              {
                kind: "update_intent",
                run: run.id,
                change: "set-goal",
                patch: "ship the picker",
                base_version: 1,
              },
            ],
            confidence: 0.9,
          },
        }),
      );

      const result = yield* steer(env, deps(stateDir), {
        text: "make the goal ship the picker",
        target: run.id,
        requestId: "req-1",
      });
      expect(result.ok).toBe(true);

      const turns = yield* readConversation(yield* conversationPath(stateDir, herdKey));
      expect(turns.map((turn) => turn.role)).toEqual(["human", "collie"]);
      expect(turns[1]?.proposal).toBeDefined();

      const proposals = yield* readProposals(yield* proposalsPath(stateDir, herdKey));
      const recorded = proposals.filter((line) => line.kind === "proposal");
      expect(recorded).toHaveLength(1);

      expect((yield* readIntent(run.dir))?.goal).toBe("ship the picker");
      expect(proposals.some((line) => line.kind === "confirmed")).toBe(true);
    }),
  ));

test("a steer with no target is refused before anything is spent", () =>
  inWorld(
    Effect.gen(function* () {
      yield* aRun();
      const result = yield* steer(env, deps(stateDir), {
        text: "what is going on?",
        requestId: "req-2",
      });
      // A question about the flock is native chat's, which reads the Herd. Refused here
      // rather than answered by a model, and refused before the call rather than after.
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(yield* readBudget(yield* budgetPath(stateDir, herdKey))).toEqual([]);
    }),
  ));

test("a turn the board starts is journaled as the board's, never as the human's", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun();
      yield* setReply(
        envelope({
          result: {
            interpretation: "it stopped because nothing was verified",
            targets: [{ run: run.id }],
            actions: [{ kind: "none", why: "nothing needs doing" }],
            confidence: 0.9,
          },
        }),
      );

      const result = yield* steer(env, deps(stateDir), {
        text: `Run ${run.id} stopped with evidence_missing. What is going on?`,
        target: run.id,
        requestId: "req-event",
        asked: "event",
      });
      expect(result.ok).toBe(true);

      const turns = yield* readConversation(yield* conversationPath(stateDir, herdKey));
      expect(turns.map((turn) => turn.role)).toEqual(["event", "collie"]);
      expect(turns[0]!.text).toContain("stopped with evidence_missing");
    }),
  ));

test("a Run nobody named is not one Collie will guess at", () =>
  inWorld(
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
  inWorld(
    Effect.gen(function* () {
      // An Intent from before spending caps were dropped still decodes, and the quota it
      // carries decides nothing: the user's decision is that usage is data, never a
      // restriction on their work.
      const run = yield* aRun({ ...DEFAULT_AUTHORITY, model_calls_per_run: 1 });
      yield* setReply(
        envelope({
          result: {
            interpretation: "nothing needs changing",
            targets: [{ run: run.id }],
            actions: [{ kind: "none", why: "nothing needs changing" }],
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
      const lines = yield* readBudget(yield* budgetPath(stateDir, herdKey));
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
  inWorld(
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

      const proposals = yield* readProposals(yield* proposalsPath(stateDir, herdKey));
      expect(proposals.filter((line) => line.kind === "proposal")).toEqual([]);
    }),
  ));

test("a model that answers outside its schema is not acted on", () =>
  inWorld(
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
      const budget = yield* readBudget(yield* budgetPath(stateDir, herdKey));
      expect(budget.filter((line) => line.kind === "settle")).toMatchObject([
        { outcome: "failed" },
      ]);
    }),
  ));

test("the pack names the runs and the target's own intent, and no pane text", () =>
  inWorld(
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

test("a follow-up is answered with the earlier turns of the same conversation", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = yield* aRun();
      const packFile = path.join(stateDir, "pack.txt");
      yield* fs.writeFileString(
        path.join(stateDir, "bin", "claude"),
        `#!/bin/sh\ncat > ${packFile}\ncat ${path.join(stateDir, "reply.json")}\n`,
      );
      yield* fs.chmod(path.join(stateDir, "bin", "claude"), 0o755);
      yield* setReply(
        envelope({
          result: {
            interpretation: "Two are running.",
            targets: [{ run: run.id }],
            actions: [],
            confidence: 0.9,
          },
        }),
      );

      yield* steer(env, deps(stateDir), {
        text: "how is the flock?",
        target: run.id,
        requestId: "req-a",
      });
      yield* steer(env, deps(stateDir), {
        text: "what about the second one?",
        target: run.id,
        requestId: "req-b",
      });

      const pack = yield* fs.readFileString(packFile);
      // Without this the second question is asked with no memory of the first, so
      // "the second one" refers to nothing and the global Collie cannot hold a
      // conversation at all.
      expect(pack).toContain("## This conversation so far");
      expect(pack).toContain("- human: how is the flock?");
      expect(pack).toContain("- collie: Two are running.");
      expect(pack).toContain("what about the second one?");
      // And it still says what the flock is, since that is what it is being asked about.
      expect(pack).toContain(run.id);
    }),
  ));

test("the pack says when it is not listing the whole Herd", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // More Runs than the pack carries, so the cap is doing something.
      const run = yield* aRun();
      for (let n = 0; n < 42; n++) yield* aRun();
      const packFile = path.join(stateDir, "pack.txt");
      yield* fs.writeFileString(
        path.join(stateDir, "bin", "claude"),
        `#!/bin/sh\ncat > ${packFile}\ncat ${path.join(stateDir, "reply.json")}\n`,
      );
      yield* fs.chmod(path.join(stateDir, "bin", "claude"), 0o755);
      yield* setReply(
        envelope({
          result: {
            interpretation: "Busy.",
            targets: [{ run: run.id }],
            actions: [],
            confidence: 0.9,
          },
        }),
      );

      yield* steer(env, deps(stateDir), {
        text: "how is the flock?",
        target: run.id,
        requestId: "req-d",
      });

      const pack = yield* fs.readFileString(packFile);
      // A model told about forty of forty-two and not told so would answer "that is all
      // of them" in good faith.
      expect(pack).toMatch(/\(\d+ more Run\(s\) not listed here\)/);
    }),
  ));
