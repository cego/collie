import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, Schema } from "effect";
import { FakeHerdr, Rig } from "./support/recorder";
import { fakeHerdr } from "./support/fake-herdr-core";
import { FakeBin } from "./support/bin";
import { installBaseline, plannedRun } from "./support/engine";
import { testDefaults } from "./support/compaction";
import { layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
import { attentionFor } from "../src/attention";
import { driverOwnership, ownershipFrom, RUNNER_PID } from "../src/driver";
import { Herdr } from "../src/herdr";
import { resumeRun } from "../src/operations";
import { RunStore, type Run } from "../src/run";
import { runEffect } from "./support/effect";

const Json = Schema.fromJsonString(Schema.Any);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeUnknownSync(Json);

Object.defineProperty(FakeHerdr.prototype, "exec", {
  value(args: string[]) {
    return fakeHerdr(args).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(Bun.env))),
    );
  },
});

let rig: Rig;
let bin: FakeBin;
let planDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      planDir = yield* plannedRun(rig, "add-picker").pipe(Effect.orDie);
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

const CLEAN = { verdict: "clean", findings: [] };
/** What the synthesiser writes: a review.json plus the summary a human reads. */
const SYNTH = { ...CLEAN, summary: "A small change to the CLI. Nothing wrong with it." };

/** A run whose `build` step already finished in a previous session. */
function interruptedRun() {
  return Effect.gen(function* () {
    const env = rig.pluginEnv();
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    const wf = resolveWorkflow("implement", defs, yield* testDefaults(env.configDir));
    const store = new RunStore(env.stateDir);
    const run = yield* store.create({
      workflow: "implement",
      cwd: env.cwd,
      inputs: { plan: planDir, target: "worktree", target_kind: "worktree" },
      inputSources: { plan: "plan run", target: "working tree" },
      stepIds: wf.steps.map((s) => s.id),
      maxIterations: wf.maxIterations,
      namedAfter: "add-picker",
    });
    const build = run.step("build");
    build.status = "done";
    build.iteration = 1;
    build.variants = [
      {
        harness: "claude",
        model: "sonnet",
        effort: null,
        permissions: null,
        agent: "dead-build-agent",
        label: "implement-add-picker/build",
        tabId: null,
        paneId: "9-9",
        status: "done",
        output: "steps/build/build.json",
        error: null,
        repairs: [],
        nudges: 0,
      },
    ];
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      yield* run.outputPath("build", null, "build.json"),
      encodeJson(CLEAN),
    );
    run.record.status = "blocked";
    yield* run.save();
    return run;
  });
}

function resume(run: Run, queue: Schema.Json[]) {
  return Effect.gen(function* () {
    yield* rig.queueOutputs(queue);
    const env = rig.pluginEnv();
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    const defaults = yield* testDefaults(env.configDir);
    const wf = resolveWorkflow(run.record.workflow, defs, defaults);
    const lines: string[] = [];
    const status = yield* Effect.promise(() =>
      import("../src/engine").then(({ executeRun }) =>
        runEffect(
          executeRun({
            herdr: new FakeHerdr(env),
            defs,
            defaults,
            wf,
            run,
            env,
            out: (line) =>
              Effect.sync(() => {
                lines.push(line);
              }),
          }),
        ),
      ),
    ).pipe(Effect.orDie);
    return { status, lines };
  });
}

test(
  "resumable lists only runs that still have unfinished steps",
  () =>
    runEffect(
      Effect.gen(function* () {
        const env = rig.pluginEnv();
        const store = new RunStore(env.stateDir);
        const run = yield* interruptedRun();

        expect((yield* store.resumable()).map((r) => r.id)).toEqual([run.id]);
        expect((yield* store.resumable())[0]!.unfinished().map((s) => s.id)).toEqual([
          "review",
          "review.synthesize",
          "fix",
          "mr",
        ]);

        for (const step of run.record.steps) step.status = "done";
        run.record.status = "done";
        yield* run.save();
        expect(yield* store.resumable()).toEqual([]);
      }),
    ),
  20_000,
);

test(
  "resuming skips the finished step and never reattaches to its agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();

        const { status, lines } = yield* resume(run, [SYNTH]);

        expect(status).toBe("done");
        expect(lines[0]).toBe("✓ build — already done, skipped");
        expect(run.step("build").variants[0]!.agent).toBe("dead-build-agent");

        const prompted = (yield* rig.calls())
          .filter((c) => c.cmd === "agent prompt")
          .map((c) => c.argv![2]);
        expect(prompted).not.toContain("dead-build-agent");
        // The one review, and then nothing: the loop is clean, so `fix` is skipped, and
        // the synthesiser is never prompted because there is nothing to reconcile. The
        // `mr` step is skipped too — this rig has no glab.
        expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(1);

        // No herdr call may touch the dead pane either.
        expect((yield* rig.calls()).flatMap((c) => c.argv ?? [])).not.toContain("9-9");
      }),
    ),
  20_000,
);

test(
  "the steps that borrowed the dead agent share one new agent instead",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();
        const FINDING = {
          verdict: "findings",
          findings: [
            {
              file: "cli.js",
              severity: "major",
              title: "no exit code",
              detail: "It returns 1 on success, so a caller cannot tell it worked.",
            },
          ],
        };

        // `fix` and `mr` both declare `agent: build`, which is gone.
        const synthesized = { ...FINDING, summary: "A small change to the CLI. It exits wrong." };
        yield* resume(run, [synthesized, CLEAN, SYNTH]);

        const fixer = run.step("fix").variants[0]!;
        expect(fixer.paneId).not.toBe("9-9");
        expect(fixer.agent).not.toBe("dead-build-agent");
        const starts = (yield* rig.calls())
          .filter((c) => c.cmd === "agent start")
          .map((c) => c.argv![2]);
        // One new agent for every step that borrowed the dead one, not one each.
        expect(starts.filter((a) => a === fixer.agent)).toHaveLength(1);
        expect(starts).not.toContain("dead-build-agent");
      }),
    ),
  20_000,
);

test(
  "a restarted continuation keeps the mode its chain was opened in",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();
        // `build` asked for the harness's own prompting and is gone; architecture,
        // simplify and fix all continue it, so restarting them must not quietly reopen
        // the chain on the Run default, which is `bypass`.
        run.step("build").variants[0]!.permissions = "harness";
        yield* run.save();

        // A findings review, so the `fix` step runs and continues the dead agent's chain.
        yield* resume(run, [
          {
            verdict: "findings",
            summary: "A small change to the CLI. It exits wrong.",
            dropped: [],
            findings: [
              { file: "cli.js", severity: "major", title: "no exit code", detail: "returns 1" },
            ],
          },
          { ...CLEAN, checks: [{ name: "tests" }] },
        ]);

        const fixer = run.step("fix").variants[0]!;
        expect(fixer.permissions).toBe("harness");
        const started = (yield* rig.calls())
          .filter((c) => c.cmd === "agent start")
          .find((c) => c.argv![2] === fixer.agent)!.argv!;
        expect(started).not.toContain("--permission-mode");

        // A step that starts an agent of its own is untouched by the chain: `review` is
        // fresh, so it opens on the Run default.
        const reviewer = run.step("review").variants[0]!;
        expect(reviewer.permissions).toBe("bypass");
        expect(
          (yield* rig.calls()).find(
            (c) => c.cmd === "agent start" && c.argv![2] === reviewer.agent,
          )!.argv!,
        ).toContain("--permission-mode");
      }),
    ),
  20_000,
);

test(
  "a resumed run opens its own tab and no pane of the run's own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();

        yield* resume(run, [SYNTH]);

        // A resumed run is driven headlessly like any other: it opens a tab for the first
        // unfinished step's agent, and nothing for itself.
        expect((yield* rig.cmds()).filter((c) => c === "tab create").length).toBeGreaterThan(0);
        for (const cmd of ["pane move", "pane swap", "pane zoom"])
          expect(yield* rig.cmds()).not.toContain(cmd);
        expect(run.step("review").variants[0]!.paneId).not.toBeNull();
      }),
    ),
  20_000,
);

test(
  "a resumed run toasts when it finishes and records the new status",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const run = yield* interruptedRun();

        yield* resume(run, [SYNTH]);

        const record = decodeJson(yield* fs.readFileString(path.join(run.dir, "run.json")));
        expect(record.status).toBe("done");
        expect(record.finished_at).not.toBeNull();
        expect(record.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
        const toast = (yield* rig.calls())
          .filter((c) => c.cmd === "notification show")
          .at(-1)!.argv!;
        expect(toast[2]).toBe("project · implement-add-picker finished");
      }),
    ),
  20_000,
);

test(
  "a step that failed and then succeeds does not keep the failure note",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();
        const review = run.step("review");
        review.status = "failed";
        review.note = "herdr agent start failed (exit 1): blocked during startup";
        yield* run.save();

        yield* resume(run, [SYNTH]);

        expect(run.step("review").status).toBe("done");
        expect(run.step("review").note).toBeNull();
        expect(run.record.summary).not.toContain("blocked during startup");
      }),
    ),
  20_000,
);

test("ownership is live, conclusively absent, or honestly unknown", () => {
  const claim = { pid: 42, start: "900", at: "2026-09-08T09:00:00.000Z" };

  // Nothing claims it, or the pid is gone: nobody is driving, and a resume is safe.
  expect(ownershipFrom(null, false, null)).toBe("none");
  expect(ownershipFrom(claim, false, null)).toBe("none");
  // The pid answers and its identity matches, or there is no identity to check.
  expect(ownershipFrom(claim, true, "900")).toBe("live");
  expect(ownershipFrom({ ...claim, start: null }, true, null)).toBe("live");
  // The number was reused by something else: that is not this Driver.
  expect(ownershipFrom(claim, true, "1200")).toBe("none");
  // The pid answers but its identity cannot be read. Saying "gone" here is how a
  // second Driver gets started for a Run that already has one.
  expect(ownershipFrom(claim, true, null)).toBe("unknown");
});

test("a claim file that cannot be read is unknown, never an unclaimed Run", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "collie-own-" });

      // No claim at all is the only conclusive absence.
      expect(yield* driverOwnership(dir)).toBe("none");

      // A truncated or corrupt claim decodes to nothing, which is not the same fact:
      // the Driver that wrote it may still own the Run, so no resume is offered.
      yield* fs.writeFileString(path.join(dir, RUNNER_PID), '{"pid":');
      expect(yield* driverOwnership(dir)).toBe("unknown");
    }),
  ));

test("a resume is not offered while an agent the Run recorded is still there", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const run = yield* interruptedRun();
      // The record still calls this one running, which on its own says nothing: only
      // herdr knows whether it is there.
      run.step("build").variants[0]!.status = "running";
      run.record.status = "running";
      yield* run.save();
      // A claim that is there and dead: the Driver is conclusively gone, which is the
      // only case where a resume would be offered at all.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(run.dir, RUNNER_PID),
        `{"pid":2147483646,"start":null,"at":"2026-09-08T09:00:00.000Z"}\n`,
      );
      yield* rig.addAgent("dead-build-agent", "9-9");
      Bun.env.FAKE_HERDR_AGENT_STATUS = "working";

      const working = yield* attentionFor(run, new Herdr(env));
      expect(working.agentsAlive).toBe("live");
      expect(working.actions).not.toContain("resume");
      // What the explanation tells the operator to do has to be in the list they read.
      expect(working.explanation).toContain("stop that before resuming");
      expect(working.actions).toContain("stop");
      // And the mutation refuses too, so advice that has gone stale cannot restart a
      // Step under an agent that is writing in the same worktree.
      const refused = yield* resumeRun(env, run, "req-live");
      expect(refused.ok).toBe(false);

      // Once herdr no longer has it, nothing is competing and a resume is safe again.
      rig.dropAgent("dead-build-agent");
      const gone = yield* attentionFor(run, new Herdr(env));
      expect(gone.agentsAlive).toBe("absent");
      expect(gone.actions).toContain("resume");
    }),
  ));

test("a slice whose Output was refused leaves its agent in its pane, and a resume asks about it", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const run = yield* interruptedRun();
      // The Output was refused, so the record calls the variant failed and the step
      // blocked — but the agent that wrote it is still sitting idle in its pane.
      const build = run.step("build");
      build.status = "blocked";
      // Its own name: an earlier test told the fake that "dead-build-agent" is gone.
      build.variants[0]!.agent = "refused-build-agent";
      build.variants[0]!.status = "failed";
      build.variants[0]!.error = "steps/build/1/build.json: findings[0]: severity is required";
      run.record.status = "blocked";
      yield* run.save();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(run.dir, RUNNER_PID),
        `{"pid":2147483646,"start":null,"at":"2026-09-08T09:00:00.000Z"}\n`,
      );
      yield* rig.addAgent("refused-build-agent", "9-9");
      Bun.env.FAKE_HERDR_AGENT_STATUS = "idle";

      // A fresh Driver would start a second agent under the same name, in the same
      // worktree, beside the one herdr still has.
      const idle = yield* attentionFor(run, new Herdr(env));
      expect(idle.agentsAlive).toBe("live");
      expect(idle.actions).not.toContain("resume");
      const refused = yield* resumeRun(env, run, "req-refused-output");
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("run_already_active");

      rig.dropAgent("refused-build-agent");
      const gone = yield* attentionFor(run, new Herdr(env));
      expect(gone.agentsAlive).toBe("absent");
      expect(gone.actions).toContain("resume");
    }),
  ));
