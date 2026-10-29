// What a Measurement refuses to say: readings it did not take, samples it did not get, trees
// that moved under it, a plan changed without a reason, and a benchmark a dead host left.

import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option } from "effect";
import { CheckProcesses, hostCheckProcesses } from "../src/check-processes";
import { measure, readMeasurements, type MeasureAsk } from "../src/measurement";
import type { BenchmarkPlan, Measurement } from "../src/measurement-model";
import { stillRunning, startedOf } from "../src/processes";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

type Plan = typeof BenchmarkPlan.Encoded;

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-measure-sampling-" });
  const repo = `${root}/repo`;
  yield* fs.makeDirectory(`${repo}/bench`, { recursive: true });
  const git = (...args: ReadonlyArray<string>) =>
    exec(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: repo });
  const write = (file: string, text: string) =>
    fs.writeFileString(`${repo}/${file}`, text).pipe(Effect.orDie);
  const commit = (message: string) =>
    Effect.gen(function* () {
      yield* git("add", "-A");
      yield* git("commit", "-qm", message);
      return (yield* git("rev-parse", "HEAD")).stdout.trim();
    });
  yield* git("init", "-q");
  yield* write("value", "10\n");
  const base = yield* commit("base");
  yield* write("bench/bench.sh", 'echo "{\\"counter\\": $(cat value)}"\n');
  // Claims the host's own readings, after taking long enough that they cannot be zero.
  yield* write(
    "bench/claims.sh",
    'sleep 0.2; echo \'{"wall_ms": 0, "cpu_ms": 0, "peak_kb": 0, "counter": 1}\'\n',
  );
  yield* write(
    "bench/gaps.sh",
    'echo run >> "$1"\nif [ $(wc -l < "$1") -ne 3 ]; then echo \'{"counter": 1}\'; fi\n',
  );
  yield* write("bench/slow.sh", "sleep 0.6; echo '{\"counter\": 1}'\n");
  yield* write("bench/inflates.sh", "echo 100 > value\n");
  yield* write(
    "bench/restores.sh",
    'echo "{\\"counter\\": $(cat value)}"; git checkout -q -- value\n',
  );
  yield* write(
    "bench/toggles.sh",
    'if [ "$(cat value)" = 100 ]; then git checkout -q -- value; else echo 100 > value; fi\necho \'{"counter": 1}\'\n',
  );
  yield* write("bench/marks.sh", 'sleep 0.6; echo late > "$1"\n');
  yield* write("bench/holds.sh", 'echo $$ > "$1"; while :; do sleep 0.1; done\n');
  const harness = yield* commit("harness");
  yield* write("value", "7\n");
  yield* commit("product");
  return { root, repo, base, harness, write, commit };
});

const planOf = (harness: string, commands: Plan["commands"], more: Partial<Plan> = {}): Plan => ({
  harness: { commits: [harness], paths: ["bench"] },
  commands,
  metrics: [{ name: "bench.counter", direction: "lower", role: "primary" }],
  warmup: 0,
  samples: 2,
  ...more,
});

const sh = (script: string, ...argv: ReadonlyArray<string>): Plan["commands"] => [
  { name: "bench", executable: "sh", argv: [`bench/${script}`, ...argv] },
];

const measuring = (
  root: string,
  ask: Omit<MeasureAsk, "runId" | "pass"> & { readonly pass?: string },
) =>
  measure({
    stateDir: `${root}/state`,
    env: null,
    ask: { runId: "run-1", pass: "calibration", ...ask },
    evidence: `${root}/evidence`,
    awaiting: `${root}/awaiting.json`,
    stopped: Effect.succeed(false),
  }).pipe(
    Effect.flatMap((answered) =>
      answered === "stopped" ? Effect.die("stopped") : Effect.succeed(answered.measurement),
    ),
  );

const resultOf = (measurement: Measurement) => measurement.result;

test(
  "a command's own JSON never replaces the readings the host took",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, sh("claims.sh")),
        });
        for (const sample of measured.samples) {
          expect(sample.readings["bench.wall_ms"]).toBeGreaterThan(100);
          expect(sample.readings["bench.cpu_ms"]).toBeGreaterThan(0);
          expect(sample.readings["bench.peak_kb"]).toBeGreaterThan(0);
        }
      }),
    ),
  30_000,
);

test(
  "a sample without a declared metric's reading leaves the Measurement unjudged, naming it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, sh("gaps.sh", `${root}/runs`), { samples: 3 }),
        });
        expect(measured.samples).toHaveLength(6);
        expect(resultOf(measured)).toEqual({
          _tag: "Unjudged",
          reason: expect.stringContaining("bench.counter"),
        });
      }),
    ),
  30_000,
);

test(
  "the time limit is one sample's, however many commands it runs",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const twice: Plan["commands"] = [
          { name: "one", executable: "sh", argv: ["bench/slow.sh"] },
          { name: "two", executable: "sh", argv: ["bench/slow.sh"] },
        ];
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, twice, {
            limit: 1,
            metrics: [{ name: "one.counter", direction: "lower", role: "primary" }],
          }),
        });
        expect(resultOf(measured)).toEqual({
          _tag: "TimedOut",
          tree: "base",
          stage: "sample",
          command: "two",
        });
      }),
    ),
  30_000,
);

test(
  "a tree its prepare changes is unjudged, even where its samples restore it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, sh("restores.sh"), {
            prepare: { executable: "sh", argv: ["bench/inflates.sh"] },
          }),
        });
        expect(resultOf(measured)).toEqual({
          _tag: "Unjudged",
          reason: expect.stringMatching(/base and candidate trees changed/),
        });
        expect(measured.samples).toEqual([]);
      }),
    ),
  30_000,
);

test(
  "a tree one sample changes is unjudged, even where a later sample restores it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, sh("toggles.sh")),
        });
        expect(resultOf(measured)).toEqual({
          _tag: "Unjudged",
          reason: expect.stringMatching(/base tree changed/),
        });
        expect(measured.samples).toHaveLength(1);
      }),
    ),
  30_000,
);

test(
  "the time limit counts the time its benchmark takes to be recorded and spawned",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const plain = yield* CheckProcesses;
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, sh("bench.sh"), { limit: 0.3 }),
        }).pipe(
          Effect.provideService(CheckProcesses, {
            ...plain,
            adopt: (check, spawn, say) =>
              Effect.delay(plain.adopt(check, spawn, say), "500 millis"),
          }),
        );
        expect(resultOf(measured)).toEqual({
          _tag: "TimedOut",
          tree: "base",
          stage: "sample",
          command: "bench",
        });
      }),
    ),
  30_000,
);

test(
  "a benchmark still being recorded is ended at its time limit, so it does nothing after",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, repo, base, harness } = yield* project;
        const plain = yield* CheckProcesses;
        const marker = `${root}/late`;
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, sh("marks.sh", marker), { limit: 0.3 }),
        }).pipe(
          Effect.provideService(CheckProcesses, {
            ...plain,
            adopt: (check, spawn, say) =>
              plain.adopt(check, spawn, say).pipe(Effect.tap(() => Effect.sleep("900 millis"))),
          }),
        );
        expect(resultOf(measured)).toMatchObject({ _tag: "TimedOut", tree: "base" });
        expect(yield* fs.exists(marker)).toBe(false);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a benchmark its host ends as it stops records nothing, so the next host measures afresh",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, repo, base, harness } = yield* project;
        const state = `${root}/state`;
        yield* fs.makeDirectory(state, { recursive: true });
        const checks = yield* hostCheckProcesses({
          dir: state,
          installation: "measurement-shutdown-test-installation",
          sweep: false,
        });
        const pidFile = `${root}/held.pid`;
        const running = yield* Effect.forkScoped(
          measuring(root, {
            base,
            cwd: repo,
            plan: planOf(harness, sh("holds.sh", pidFile)),
          }).pipe(Effect.provideService(CheckProcesses, checks)),
        );
        yield* until(
          () => fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => "")),
          (text) => text.trim() !== "",
        );
        yield* checks.endAll;
        expect(
          Option.isNone(yield* Fiber.join(running).pipe(Effect.timeoutOption("2 seconds"))),
        ).toBe(true);
        expect(yield* readMeasurements(`${root}/evidence`)).toEqual([]);
      }),
    ),
  30_000,
);

test(
  "a base tree left without its harness commits is made again, not sampled",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, repo, base, harness, write, commit } = yield* project;
        const plan = planOf(harness, sh("bench.sh"));
        expect(resultOf(yield* measuring(root, { base, cwd: repo, plan }))._tag).toBe("Judged");
        // As a crash between its `worktree add` and its cherry-pick leaves it.
        const trees = `${root}/state/measurements/trees/run-1`;
        const [made] = yield* fs.readDirectory(trees);
        yield* exec(["git", "reset", "-q", "--hard", base], { cwd: `${trees}/${made}` });
        yield* write("value", "8\n");
        yield* commit("another product");

        const again = yield* measuring(root, { base, cwd: repo, plan });
        expect(resultOf(again)._tag).toBe("Judged");
        expect(again.samples.find((one) => one.tree === "base")?.readings["bench.counter"]).toBe(
          10,
        );
      }),
    ),
  30_000,
);

test(
  "a Run's new plan is measured only with its reason, which its Measurement keeps",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, repo, base, harness } = yield* project;
        const plan = planOf(harness, sh("bench.sh"));
        expect((yield* measuring(root, { base, cwd: repo, plan })).plan_reason).toBeNull();

        const more = { ...plan, samples: 3 };
        const refused = yield* Effect.flip(measuring(root, { base, cwd: repo, plan: more }));
        expect(refused.why).toContain("reason");

        const replanned = yield* measuring(root, {
          base,
          cwd: repo,
          plan: more,
          reason: "three samples a side",
        });
        expect(replanned.plan_reason).toBe("three samples a side");
        expect(replanned.samples).toHaveLength(6);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a benchmark a dead host left running is ended before the next Measurement takes a sample",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, repo, base, harness } = yield* project;
        const state = `${root}/state`;
        yield* fs.makeDirectory(state, { recursive: true });
        const installation = "measurement-sampling-test-installation";
        const dead = yield* hostCheckProcesses({ dir: state, installation, sweep: false });
        const pidFile = `${root}/left.pid`;
        yield* Effect.forkScoped(
          dead.adopt({ run: "run-0", name: "measure: bench", by: "collie" }, (markers) =>
            Effect.sync(() =>
              Bun.spawn(["sh", "-c", 'echo $$ > "$0"; while :; do sleep 0.1; done', pidFile], {
                env: { ...process.env, ...markers },
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
              }),
            ),
          ),
        );
        const pid = Number(
          yield* until(
            () => fs.readFileString(pidFile).pipe(Effect.orElseSucceed(() => "")),
            (text) => text.trim() !== "",
          ),
        );
        const left = { pid, started: (yield* startedOf(pid)) ?? "" };

        const next = yield* hostCheckProcesses({ dir: state, installation, sweep: false });
        const alone: Plan["commands"] = [
          {
            name: "bench",
            executable: "sh",
            argv: [
              "-c",
              'if kill -0 "$(cat "$0")" 2>/dev/null; then exit 1; fi; echo \'{"counter": 1}\'',
              pidFile,
            ],
          },
        ];
        const measured = yield* measuring(root, {
          base,
          cwd: repo,
          plan: planOf(harness, alone),
        }).pipe(Effect.provideService(CheckProcesses, next));
        expect(resultOf(measured)._tag).toBe("Judged");
        expect(yield* stillRunning(left)).toBe(false);
      }),
    ),
  30_000,
);
