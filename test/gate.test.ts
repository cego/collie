import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, ConfigProvider, Effect, Path } from "effect";
import { FakeHerdr, Rig } from "./support/recorder";
import { fakeHerdr } from "./support/fake-herdr-core";
import { FakeBin } from "./support/bin";
import {
  approveVerification,
  approveVerifications,
  installBaseline,
  runWorkflow,
  scriptedPrompts,
} from "./support/engine";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { filePrompts, parseGateAnswer, readChoice, type PendingChoice } from "../src/driver";
import { answerRun, runStatus } from "../src/operations";
import { RunStore, type Run } from "../src/run";
import { readVerifications } from "../src/verify";

const OFFERED = ["tests", "lint"];

test("a gate is answered with approve, skip, or the list edited down", () => {
  expect(parseGateAnswer("approve", OFFERED)).toEqual({
    kind: "approve",
    verifications: null,
  });
  expect(parseGateAnswer("skip", OFFERED)).toEqual({ kind: "skip" });
  expect(parseGateAnswer("approve:tests", OFFERED)).toEqual({
    kind: "approve",
    verifications: ["tests"],
  });
  expect(parseGateAnswer(" approve: tests , lint ", OFFERED)).toEqual({
    kind: "approve",
    verifications: ["tests", "lint"],
  });
});

test("a gate refuses an answer that is not one of its own", () => {
  // An edit down to nothing is Skip by another name, and a name nobody approved would
  // hold the Run to a command Collie may not run.
  expect(parseGateAnswer("", OFFERED)).toBeNull();
  expect(parseGateAnswer("yes", OFFERED)).toBeNull();
  expect(parseGateAnswer("approve:", OFFERED)).toBeNull();
  expect(parseGateAnswer("approve:typecheck", OFFERED)).toBeNull();
});

const GATED = `---
name: gated
title: gated — build it, then open the merge request
inputs:
  goal: goal
  outcome: optional
steps:
  - id: build
    persona: implementer
    output: build.json
  - id: mr
    persona: implementer
    agent: build
    requires: gitlab
    output: mr.json
---
Build {{inputs.goal}}.

## build
Build it.

## mr
Open the merge request.
`;

const CLEAN = { verdict: "clean", findings: [] };

Object.defineProperty(FakeHerdr.prototype, "exec", {
  value(args: string[]) {
    return fakeHerdr(args).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(Bun.env))),
    );
  },
});

let rig: Rig;
let bin: FakeBin;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "gated", GATED);
      yield* approveVerification(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      // glab and git as they look in a repo that really is on GitLab: the case the
      // evidence gate exists for, and the only one where it holds anything.
      yield* bin.add("glab", `case "$1" in "--version") echo "glab 1.40.0" ;; *) exit 1 ;; esac`);
      yield* bin.add(
        "git",
        `case "$1 $2" in
  "remote -v") printf 'origin\tgit@gitlab.cego.dk:cego/collie.git (fetch)\\n' ;;
  *) echo main ;;
esac`,
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

interface Waiting {
  run: Run;
  choice: PendingChoice;
  finished: Promise<{ run: Run; status: string; lines: string[] }>;
}

/**
 * The run driven to its gate and left holding there, with the Choice it wrote. Driven
 * through the real `filePrompts`, so an answer travels the way the board's does: through
 * the run directory.
 */
const atTheGate = Effect.fn("test.atTheGate")(function* (opts: { existing?: Run } = {}) {
  const started: Run[] = [];
  const finished = runEffect(
    runWorkflow(
      rig,
      "gated",
      { goal: "add a picker" },
      {
        existing: opts.existing,
        promptsFor: (run) => {
          started.push(run);
          return filePrompts({
            dir: run.dir,
            run: run.id,
            step: () => run.record.steps.find((s) => s.status === "running")?.id ?? "",
            timeoutMs: 4_000,
            pollMs: 10,
          });
        },
      },
    ).pipe(Effect.orDie),
  );
  const deadline = (yield* Clock.currentTimeMillis) + 5_000;
  while (started[0] === undefined || (yield* readChoice(started[0].dir)) === null) {
    if ((yield* Clock.currentTimeMillis) > deadline)
      return yield* Effect.die(new Error("no gate inside 5s"));
    yield* Effect.sleep("5 millis");
  }
  const run = started[0];
  return {
    run,
    choice: (yield* readChoice(run.dir))!,
    finished,
  } satisfies Waiting;
});

const answered = (run: Run, answer: string) =>
  answerRun(run, answer, `test-${answer}`).pipe(Effect.orDie);

test(
  "a run holding at its evidence gate records it where a question lives",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN]);

        const { run, choice, finished } = yield* atTheGate();

        expect(choice.kind).toBe("gate");
        expect(choice.step).toBe("mr");
        expect(choice.verifications).toEqual(["tests"]);
        expect(choice.header).toContain("tests");
        // Not running: a Run at a gate is waiting on a human, and the board says so.
        expect(yield* runStatus(run)).toBe("waiting");
        expect(run.record.awaiting).toBe("mr");

        expect((yield* answered(run, "approve")).ok).toBe(true);
        const done = yield* Effect.promise(() => finished);
        expect(done.status).toBe("done");
      }),
    ),
  20_000,
);

test(
  "approving the list holds the run to it, and the answer is on the record",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN]);

        const { run, finished } = yield* atTheGate();
        yield* answered(run, "approve");
        const done = yield* Effect.promise(() => finished);

        expect(done.status).toBe("done");
        expect(done.run.step("mr").status).toBe("done");
        expect(done.run.record.evidence_gaps).toEqual([]);
        expect(done.run.record.choices.map((c) => [c.step, c.title])).toEqual([["mr", "approve"]]);
        expect((yield* readVerifications(run.dir)).map((v) => v.name)).toContain("tests");
      }),
    ),
  20_000,
);

test(
  "skipping the gate opens the merge request without checking the evidence",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN]);

        const { run, finished } = yield* atTheGate();
        yield* answered(run, "skip");
        const done = yield* Effect.promise(() => finished);

        expect(done.status).toBe("done");
        expect(done.run.step("mr").status).toBe("done");
        expect(done.run.record.choices.map((c) => [c.step, c.title])).toEqual([["mr", "skip"]]);
        // Skipped means skipped: nothing was collected and no gap was judged.
        expect(yield* readVerifications(run.dir)).toEqual([]);
        expect(done.lines.some((line) => line.includes("the evidence gate was skipped"))).toBe(
          true,
        );
      }),
    ),
  20_000,
);

test(
  "an edited list is what the run is then held to",
  () =>
    runEffect(
      Effect.gen(function* () {
        // `slow` fails, so the list as it stands would stop this run. Cutting it is the
        // human saying that is not what this Run has to prove.
        yield* approveVerifications(rig, [
          { name: "tests", executable: "true" },
          { name: "slow", executable: "false" },
        ]);
        yield* rig.queueOutputs([CLEAN, CLEAN]);

        const { run, choice, finished } = yield* atTheGate();
        expect(choice.verifications).toEqual(["tests", "slow"]);
        yield* answered(run, "approve:tests");
        const done = yield* Effect.promise(() => finished);

        expect(done.status).toBe("done");
        expect(done.run.record.evidence_gaps).toEqual([]);
        expect(done.run.record.choices.map((c) => c.title)).toEqual(["approve:tests"]);
        expect((yield* readVerifications(run.dir)).map((v) => v.name)).toEqual(["tests"]);
      }),
    ),
  20_000,
);

test(
  "a gate nobody answers blocks the run, and the resumed run asks again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN]);

        const first = yield* atTheGate();
        // Nobody answers: the wait times out, and the run stops where it was rather than
        // opening a merge request nobody approved.
        const blocked = yield* Effect.promise(() => first.finished);
        expect(blocked.status).not.toBe("done");
        expect(blocked.run.step("mr").status).not.toBe("done");

        const reloaded = (yield* new RunStore(rig.pluginEnv().stateDir).load(first.run.id))!;
        reloaded.record.status = "running";
        yield* reloaded.save();
        const again = yield* atTheGate({ existing: reloaded });
        expect(again.choice.kind).toBe("gate");
        yield* answered(again.run, "approve");
        expect((yield* Effect.promise(() => again.finished)).status).toBe("done");
      }),
    ),
  20_000,
);

test(
  "the gate is answered from the CLI, and refuses what is not one of its answers",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN]);

        const { run, finished } = yield* atTheGate();
        const notAnAnswer = yield* answerRun(run, "yes", "test-yes");
        expect(notAnAnswer).toMatchObject({
          ok: false,
          error: { code: "invalid_answer" },
        });
        const notApproved = yield* answerRun(run, "approve:typecheck", "test-unapproved");
        expect(notApproved).toMatchObject({
          ok: false,
          error: { code: "invalid_answer" },
        });

        yield* answered(run, "approve");
        expect((yield* Effect.promise(() => finished)).status).toBe("done");
      }),
    ),
  20_000,
);

test(
  "a gate decided at launch is taken without holding the run up",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN]);

        const done = yield* runWorkflow(
          rig,
          "gated",
          { goal: "add a picker" },
          { decisions: { mr: "approve" }, prompts: scriptedPrompts([]) },
        ).pipe(Effect.orDie);

        expect(done.status).toBe("done");
        expect(done.lines).toContain("  ▸ the evidence gate approved: tests (decided at launch)");
        expect(done.run.record.choices.map((c) => c.title)).toEqual(["approve"]);
      }),
    ),
  20_000,
);
