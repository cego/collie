// A Codex agent's question, as its App Server carries it: never `blocked`, but an
// `agentMessage` with `questions` on its thread. `fixtures/codex-question.json` is that
// item as `thread/items/list` read it back from codex-cli 0.166.0, live; the stand-in in
// `support/codex-server.ts` serves it on the agent's thread.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Layer, Schema, flow, Result } from "effect";
import { TestClock } from "effect/testing";
import type { PlatformServices } from "../src/platform";
import { Agents, agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { foundationLayer } from "../src/engine";
import { codexPort } from "../src/compactors";
import { agentName } from "../src/naming";
import { Store } from "../src/store";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { asRun, enveloped } from "./support/enveloped";
import type { StandIn } from "./support/codex-server";
import question from "./fixtures/codex-question.json";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

let rig: Rig;
let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
      yield* (yield* FileSystem.FileSystem).makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

const Started = Schema.fromJsonString(Schema.Struct({ pid: Schema.Finite }));

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const events = yield* (yield* FileSystem.FileSystem)
        .readFileString(`${rig.root}/codex-server.events`)
        .pipe(Effect.orElseSucceed(() => ""));
      for (const line of Str.split(events, "\n"))
        for (const { pid } of Option.toArray(Schema.decodeOption(Started)(line)))
          yield* Effect.sync(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore);
      yield* rig.close();
    }),
  ),
);

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

const Verdict = Schema.Struct({ verdict: Schema.String });
const work = enveloped({ name: "agent-work", input: { skip: Schema.Boolean }, success: Verdict });
const body = work.toLayer((payload) =>
  agentWork({
    operation: "review",
    role: "reviewer",
    workflow: "agent-work",
    cwd: rig.projectDir,
    instructions: "Review it.",
    output: Verdict,
  }).pipe(asRun(payload)),
);

const SERVER = `${import.meta.dir}/support/codex-server.ts`;
const config = () => `${rig.root}/codex-server.json`;

const hostOf = (compactAtTokens = 1_000_000): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "codex",
  model: "default",
  permissions: "auto",
  compactAtTokens,
  pollMs: 1_000,
  collectMs: 120_000,
  help: () => Effect.succeed("  --dangerously-bypass-hook-trust"),
  ports: { codex: { ...codexPort(`bun ${SERVER} ${config()}`), gate: Effect.void } },
});

const session = <A, E, R>(run: Effect.Effect<A, E, R>, host = hostOf()) =>
  run.pipe(
    Effect.provide(
      body.pipe(
        Layer.provideMerge(agentsLayer(host)),
        Layer.provideMerge(foundationLayer({ dir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const waitFor = <E, R>(reached: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* reached)) yield* TestClock.withLive(Effect.sleep("10 millis"));
  });

const spend = (ms: number) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + ms;
    yield* waitFor(Effect.map(Clock.currentTimeMillis, (now) => now >= until));
  });

/** The text of every prompt typed into an agent, in the order typed. */
const typed = (calls: ReadonlyArray<Call>) =>
  Arr.map(
    Arr.filter(calls, (call) => call.cmd === "agent prompt"),
    (call) => call.argv?.[3] ?? "",
  );
const typedCount = (about: string) =>
  rig.calls().pipe(
    Effect.map((calls) => Arr.filter(typed(calls), (one) => pipe(one, Str.includes(about))).length),
    Effect.orElseSucceed(() => 0),
  );

const STEP = "Your task for this step";

/** The recorded question, asked to standard: Blue recommended among three. */
const standard = {
  ...question,
  item: {
    ...question.item,
    questions: [
      {
        title: "Which colour should the file be, red or blue?",
        options: ["Red", "Blue (Recommended)", "Green"],
      },
    ],
  },
};

/** The agent's next question after a repair, still two options and no recommendation. */
const stillShort = {
  ...question,
  item: {
    ...question.item,
    id: "call_again",
    questions: [{ title: "Red or blue, then?", options: ["Red", "Blue"] }],
  },
};

test(
  "a Codex agent's question is a Decision on its Run, its next step waits while it is open, and the answer reaches it first",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const standIn: StandIn = {
          events: `${rig.root}/codex-server.events`,
          threads: [{ id: "thread-1", cwd: rig.projectDir, items: [standard] }],
        };
        yield* fs.writeFileString(config(), asJson(standIn)).pipe(Effect.orDie);
        yield* rig.queueOutputs([null, null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            const store = yield* Store;
            yield* waitFor(Effect.map(store.asked("r1"), (asked) => asked.length > 0));
            const [asked] = yield* store.asked("r1");
            expect(asked?.decision).toBe("ask-review-1");
            expect(asked?.answer).toBeNull();
            expect(asked?.prompt).toBe("Which colour should the file be, red or blue?");

            yield* Effect.forkChild(
              (yield* Agents).launch({
                runId: "r1",
                operation: "fix",
                role: "reviewer",
                workflow: "agent-work",
                task: null,
                agent: "review",
                cwd: rig.projectDir,
                prompt: "Fix it.",
                output: `${dir}/agents/r1/fix.json`,
                skill: null,
                harness: "codex",
                model: null,
                effort: null,
                permissions: null,
              }),
            );
            yield* spend(30_000);
            expect(yield* typedCount(STEP)).toBe(1);
            expect(yield* fs.readFileString(`${dir}/agents/deliveries.log`)).toContain(
              `${agentName("r1", "review", null, 1)} cannot take a prompt yet (agent_blocked)`,
            );

            yield* store.settle({
              run: "r1",
              decision: "ask-review-1",
              value: "1",
              request: "a",
            });
            yield* waitFor(Effect.map(typedCount(STEP), (count) => count === 2));
            const lastLines = Arr.map(typed(yield* rig.calls()), (one) =>
              Option.getOrElse(Arr.last(Str.split(one, "\n")), () => ""),
            );
            expect(lastLines).toEqual([
              expect.stringContaining("/review.prompt.md"),
              "Your question Which colour should the file be, red or blue? is answered: Blue",
              expect.stringContaining("/fix.prompt.md"),
            ]);
          }),
        );
      }),
    ),
  120_000,
);

test(
  "a Codex agent's superseded question no longer holds its next step, and is never answered to it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const standIn: StandIn = {
          events: `${rig.root}/codex-server.events`,
          threads: [{ id: "thread-1", cwd: rig.projectDir, items: [standard] }],
        };
        yield* fs.writeFileString(config(), asJson(standIn)).pipe(Effect.orDie);
        yield* rig.queueOutputs([null, null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            const store = yield* Store;
            yield* waitFor(Effect.map(store.asked("r1"), (asked) => asked.length > 0));
            yield* Effect.forkChild(
              (yield* Agents).launch({
                runId: "r1",
                operation: "fix",
                role: "reviewer",
                workflow: "agent-work",
                task: null,
                agent: "review",
                cwd: rig.projectDir,
                prompt: "Fix it.",
                output: `${dir}/agents/r1/fix.json`,
                skill: null,
                harness: "codex",
                model: null,
                effort: null,
                permissions: null,
              }),
            );
            yield* spend(30_000);
            expect(yield* typedCount(STEP)).toBe(1);

            const superseded = yield* store.supersede({
              run: "r1",
              decision: "ask-review-1",
              cause: "delivery-1",
              actor: { origin: "desktop", requestId: "steer-1" },
              agent: agentName("r1", "review", null, 1),
            });
            expect(superseded._tag).toBe("accepted");
            yield* waitFor(Effect.map(typedCount(STEP), (count) => count === 2));
            expect(yield* typedCount("is answered")).toBe(0);
          }),
        );
      }),
    ),
  120_000,
);

test(
  "with compaction off, a Codex agent's question is still a Decision on its Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const standIn: StandIn = {
          events: `${rig.root}/codex-server.events`,
          threads: [{ id: "thread-1", cwd: rig.projectDir, items: [standard] }],
        };
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(config(), asJson(standIn))
          .pipe(Effect.orDie);
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            const store = yield* Store;
            yield* waitFor(Effect.map(store.asked("r1"), (asked) => asked.length > 0));
            expect((yield* store.asked("r1"))[0]?.decision).toBe("ask-review-1");
          }).pipe(Effect.timeout("60 seconds")),
          hostOf(0),
        );
      }),
    ),
  120_000,
);

test(
  "a Codex agent's short question is repaired by a Delivery and not posted, and its next one is posted flagged",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const standIn: StandIn = {
          events: `${rig.root}/codex-server.events`,
          threads: [{ id: "thread-1", cwd: rig.projectDir, items: [stillShort, question] }],
        };
        yield* fs.writeFileString(config(), asJson(standIn)).pipe(Effect.orDie);
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            const store = yield* Store;
            yield* waitFor(Effect.map(store.asked("r1"), (asked) => asked.length > 0));
            expect(
              Arr.map(yield* store.asked("r1"), (one) => [one.decision, one.prompt, one.shortfall]),
            ).toEqual([
              [
                "ask-review-1",
                "Red or blue, then?",
                "The agent gave 2 options and no recommendation; Collie asked for at least three options and exactly one recommended option.",
              ],
            ]);
            yield* waitFor(
              Effect.map(typedCount("at least three options"), (count) => count === 1),
            );
            expect(yield* fs.readFileString(`${dir}/agents/r1/review.prompt.md`)).toContain(
              'end exactly one option\'s label with " (Recommended)"',
            );
          }).pipe(Effect.timeout("60 seconds")),
        );
      }),
    ),
  120_000,
);

test(
  "a Codex agent's short question whose repair cannot be sent is posted as asked",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const long = `${Str.repeat(9 * 1024)("Which colour? ")}Red or blue?`;
        const standIn: StandIn = {
          events: `${rig.root}/codex-server.events`,
          threads: [
            {
              id: "thread-1",
              cwd: rig.projectDir,
              items: [
                {
                  ...stillShort,
                  item: {
                    ...stillShort.item,
                    questions: [{ title: long, options: ["Red", "Blue"] }],
                  },
                },
              ],
            },
          ],
        };
        yield* fs.writeFileString(config(), asJson(standIn)).pipe(Effect.orDie);
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            const store = yield* Store;
            yield* waitFor(Effect.map(store.asked("r1"), (asked) => asked.length > 0));
            expect(
              Arr.map(yield* store.asked("r1"), (one) => [one.decision, one.prompt, one.shortfall]),
            ).toEqual([
              [
                "ask-review-1",
                long,
                "The agent gave 2 options and no recommendation; Collie asked for at least three options and exactly one recommended option.",
              ],
            ]);
            expect(yield* typedCount("at least three options")).toBe(0);
          }).pipe(Effect.timeout("60 seconds")),
        );
      }),
    ),
  120_000,
);
