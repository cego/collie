// A Run's agents, read back from the launch records its agents layer wrote, and shown in
// its detail and in `collie run show`.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { frontDoor } from "../src/host";
import { agentLines } from "../src/commands/run";
import { LAUNCH_ORDER, launchDir, runAgents, type Launched } from "../src/launches";
import { runFacts } from "../src/operations";
import { findRun } from "../src/runs";
import { exec } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { hosted, settledRun } from "./support/hosted";
import { collie, collieCommand } from "./support/world";

const launched = (runId: string, over: Partial<Launched>): Launched => ({
  agent: `${runId}-build-r1`,
  output: "/dev/null",
  reused: false,
  runId,
  operation: "build",
  role: "implementer",
  workflow: "implement",
  harness: "claude",
  ...over,
});

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Writes a Run's launch records as the agents layer does: one file each, and the order. */
const seed = Effect.fn("test.seed")(function* (
  stateDir: string,
  runId: string,
  launches: ReadonlyArray<Launched>,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = launchDir(stateDir, runId);
  yield* fs.makeDirectory(dir, { recursive: true });
  for (const one of launches)
    yield* fs.writeFileString(`${dir}/${one.operation}.launch.json`, encode(one));
  yield* fs.writeFileString(
    `${dir}/${LAUNCH_ORDER}`,
    `${launches.map((one) => one.operation).join("\n")}\n`,
  );
});

const twoAgents = (runId: string) => [
  launched(runId, {
    operation: "review",
    agent: `${runId}-review-r1`,
    harness: "codex",
    model: "gpt-5",
  }),
  launched(runId, { model: "opus", effort: "xhigh" }),
  // Reused the reviewer, and recorded before effort and model were.
  launched(runId, { operation: "re-review", agent: `${runId}-review-r1`, reused: true }),
];

test("a Run's agents are its launch records, in launch order, with what each ran on", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-launches-" });
      yield* seed(state, "r1", twoAgents("r1"));

      const agents = yield* runAgents(state, "r1");
      expect(agents).toEqual([
        {
          operation: "review",
          agent: "r1-review-r1",
          harness: "codex",
          model: "gpt-5",
          effort: null,
          from: null,
          why: null,
          at: null,
        },
        {
          operation: "build",
          agent: "r1-build-r1",
          harness: "claude",
          model: "opus",
          effort: "xhigh",
          from: null,
          why: null,
          at: null,
        },
        {
          operation: "re-review",
          agent: "r1-review-r1",
          harness: "claude",
          model: null,
          effort: null,
          from: null,
          why: null,
          at: null,
        },
      ]);
      expect(agentLines(agents)).toEqual([
        "  review  codex/gpt-5",
        "  build  claude/opus xhigh",
        "  re-review  claude/default",
      ]);
      expect(yield* runAgents(state, "never-ran")).toEqual([]);
    }),
  ));

test("a Fallback's launch says what it fell back from and why, and an earlier one says neither", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-launches-" });
      yield* seed(state, "r1", [
        launched("r1", {
          operation: "review",
          agent: "r1-review-r1",
          harness: "codex",
          model: "default",
          effort: null,
          from: { harness: "claude", model: "opus", effort: null },
          why: "session 100%, resets 15:45",
          at: 1791467100000, // 2026-10-08T13:45Z
        }),
        launched("r1", {}),
      ]);
      expect(agentLines(yield* runAgents(state, "r1"))).toEqual([
        "  review  codex/default (fell back from claude/opus: session 100%, resets 15:45)",
        "  build  claude/default",
      ]);
      expect((yield* runAgents(state, "r1")).map(({ at }) => at)).toEqual([
        "2026-10-08T13:45:00.000Z",
        null,
      ]);
    }),
  ));

test(
  "a Run's detail and run show carry its agents",
  () =>
    hosted("collie-launches-", ({ world, env }) =>
      Effect.gen(function* () {
        const run = yield* settledRun(world, "hello");
        yield* seed(world.state, run.id, twoAgents(run.id));

        const detail = yield* (yield* frontDoor(world.state))
          .runDetail({ runId: run.id, tail: false, pages: 1, refreshMr: false })
          .pipe(Stream.runHead, Effect.timeout("30 seconds"));
        expect(Option.getOrNull(detail)?.agents?.map((one) => one.operation)).toEqual([
          "review",
          "build",
          "re-review",
        ]);

        // Chat's read of the Run says the same.
        const facts = yield* runFacts(env, (yield* findRun(env, run.id))!);
        expect(facts).toContain(`### Agents\n\n- review: codex/gpt-5 as ${run.id}-review-r1`);

        const shown = yield* collie(world, ["run", "show", run.id]);
        expect(shown.exit).toBe(0);
        expect(shown.envelope.data).toMatchObject({
          agents: [
            { operation: "review", harness: "codex" },
            { operation: "build", model: "opus", effort: "xhigh" },
            { operation: "re-review", agent: `${run.id}-review-r1` },
          ],
        });

        const human = yield* exec([...(yield* collieCommand), "run", "show", run.id], {
          cwd: world.project,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: world.home,
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            ...(yield* suiteEnv),
          },
        });
        expect(human.stdout).toContain("\n  review  codex/gpt-5\n  build  claude/opus xhigh\n");
      }),
    ),
  60_000,
);
