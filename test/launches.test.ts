// A Run's agents, read back from the launch records its agents layer wrote, and shown in
// its detail and in `collie run show`.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Option, Stream } from "effect";
import { frontDoor, socketOf } from "../src/host";
import { agentLines } from "../src/commands/run";
import { orderLaunch, recordLaunch, runAgents, type Launched } from "../src/launches";
import { runFacts } from "../src/operations";
import { findRun } from "../src/runs";
import { exec } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { hosted, settledRun } from "./support/hosted";
import { collie, collieCommand } from "./support/world";
import { recordIn } from "../src/board-model";
import { recordsAt } from "./support/records";

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

const seed = Effect.fn("test.seed")(function* (launches: ReadonlyArray<Launched>) {
  for (const one of launches) {
    yield* recordLaunch(one);
    yield* orderLaunch(one);
  }
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
      yield* seed(twoAgents("r1"));

      const agents = yield* runAgents("r1");
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
        `  review  ${agents[0]!.agent}  codex/gpt-5`,
        `  build  ${agents[1]!.agent}  claude/opus xhigh`,
        `  re-review  ${agents[2]!.agent}  claude/default`,
      ]);
      expect(yield* runAgents("never-ran")).toEqual([]);
    }),
  ));

test("a Fallback's launch says what it fell back from and why, and an earlier one says neither", () =>
  runEffect(
    Effect.gen(function* () {
      yield* seed([
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
      const agents = yield* runAgents("r1");
      expect(agentLines(agents)).toEqual([
        `  review  ${agents[0]!.agent}  codex/default (fell back from claude/opus: session 100%, resets 15:45)`,
        `  build  ${agents[1]!.agent}  claude/default`,
      ]);
      expect(Arr.map(yield* runAgents("r1"), ({ at }) => at)).toEqual([
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
        yield* seed(twoAgents(run.id)).pipe(Effect.provide(recordsAt(world.state)));

        const detail = yield* (yield* frontDoor(socketOf(world.state)))
          .runDetail({ runId: run.id, tail: false, pages: 1, refreshMr: false })
          .pipe(Stream.map(recordIn), Stream.runHead, Effect.timeout("30 seconds"));
        expect(
          Option.getOrUndefined(
            Option.flatMap(Option.fromNullishOr(Option.getOrNull(detail)), (present) =>
              Option.map(Option.fromNullishOr(present.agents), (present_) =>
                Arr.map(present_, (one) => one.operation),
              ),
            ),
          ),
        ).toEqual(["review", "build", "re-review"]);

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
        expect(human.stdout).toContain(
          `\n  review  ${run.id}-review-r1  codex/gpt-5\n  build  ${run.id}-build-r1  claude/opus xhigh\n`,
        );
      }),
    ),
  60_000,
);
