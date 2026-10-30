// A Measurement taken by the shipped host, asked through `collie measure` and through
// `host.measure` (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement, D1, D2, D4).

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schema, flow, Result } from "effect";
import { evidenceDir, runDir } from "../src/engine";
import { readMeasurements } from "../src/measurement";
import type { BenchmarkPlan, Measurement } from "../src/measurement-model";
import { memoryWaitOf } from "../src/memory-wait";
import { epochMs } from "../src/time";
import { exec } from "./support/command";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
type Plan = typeof BenchmarkPlan.Encoded;
const Started = Schema.Struct({ runId: Schema.String });
const Waited = Schema.Struct({
  run: Schema.Struct({ status: Schema.Struct({ status: Schema.String, value: Schema.String }) }),
});
const Shown = Schema.Struct({
  run: Schema.Struct({ awaiting: Schema.NullOr(Schema.Struct({ on: Schema.String })) }),
  memory: Schema.NullOr(Schema.String),
});
/** What the `measured` fixture answers: its Measurement, and the outcome table's reading as `performance`. */
const Read = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    withoutPatch: Schema.Boolean,
    gaps: Schema.Array(Schema.String),
  }),
);
const Proves = Schema.Struct({
  run: Schema.Struct({ outcome: Schema.String, measurement: Schema.NullOr(Schema.String) }),
});
const Answered = Schema.Struct({
  ran: Schema.Boolean,
  measurement: Schema.Struct({ id: Schema.String }),
});

/** The world's project as three commits: a base, a harness on it, and a product change. */
const project = (world: World) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const write = (file: string, text: string) =>
      fs.writeFileString(`${world.project}/${file}`, text).pipe(Effect.orDie);
    const commit = (message: string) =>
      Effect.gen(function* () {
        yield* exec(["git", "add", "-A"], { cwd: world.project });
        yield* exec(
          ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", message],
          { cwd: world.project },
        );
        return Str.trim((yield* exec(["git", "rev-parse", "HEAD"], { cwd: world.project })).stdout);
      });
    yield* write("value", "10\n");
    yield* write("bun.lock", "{}\n");
    const base = yield* commit("base");
    yield* fs.makeDirectory(`${world.project}/bench`).pipe(Effect.orDie);
    // Counts each run outside the tree, by the tree it ran in, then prints the counter.
    yield* write("bench/bench.sh", 'echo "$PWD" >> "$1"\necho "{\\"counter\\": $(cat value)}"\n');
    // 5, then 15, then 5 …, by how often it has run: noise no tree causes.
    yield* write(
      "bench/noisy.sh",
      'echo "$PWD" >> "$1"\nif [ $(($(wc -l < "$1") % 2)) -eq 1 ]; then echo \'{"counter": 5}\'; else echo \'{"counter": 15}\'; fi\n',
    );
    // Holds its sample until the file it names exists.
    yield* write(
      "bench/gate.sh",
      'echo "$PWD" >> "$1"\nwhile [ ! -e "$2" ]; do sleep 0.1; done\necho \'{"counter": 1}\'\n',
    );
    const harness = yield* commit("harness");
    yield* write("value", "7\n");
    const product = yield* commit("product");
    return { base, harness, product, commit, write };
  });

const planOf = (
  harness: string,
  script: string,
  ran: string,
  more: { readonly limit?: number } = {},
  argv: ReadonlyArray<string> = [],
): Plan => ({
  harness: { commits: [harness], paths: ["bench"] },
  commands: [{ name: "bench", executable: "sh", argv: [`bench/${script}`, ran, ...argv] }],
  metrics: [{ name: "bench.counter", direction: "lower", role: "primary" }],
  warmup: 1,
  samples: 2,
  ...more,
});

const asking = (world: World, extra: Record<string, string>) =>
  Effect.gen(function* () {
    const started = yield* collie(world, ["run", "start", "asks", "--input", "goal=hold"], extra);
    expect(started.envelope.ok).toBe(true);
    return (yield* Schema.decodeUnknownEffect(Started)(started.envelope.data).pipe(Effect.orDie))
      .runId;
  });

const measuring = (
  world: World,
  extra: Record<string, string>,
  runId: string,
  base: string,
  plan: Plan,
  pass = "calibration",
  reason?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${world.home}/plan-${Bun.hash(encode(plan)).toString(16)}.json`;
    yield* fs.writeFileString(file, encode(plan)).pipe(Effect.orDie);
    return yield* collie(
      world,
      [
        "measure",
        "--run",
        runId,
        "--base",
        base,
        "--plan",
        file,
        "--pass",
        pass,
        ...(reason === undefined ? [] : ["--reason", reason]),
      ],
      extra,
    );
  });

const recorded = (world: World, runId: string) =>
  readMeasurements(evidenceDir(world.state, runId)).pipe(Effect.orElseSucceed(() => []));

const linesOf = (world: World, file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
    Effect.orElseSucceed((): Array<string> => []),
  );

const verdictOf = (measurement: Measurement, metric: string) =>
  measurement.result._tag === "Judged"
    ? (Option.getOrUndefined(
        Arr.findFirst(measurement.result.verdicts, (one) => one.metric === metric),
      )?.verdict ?? null)
    : null;

test(
  "collie measure and host.measure sample A B B A after a warmup and judge a lower counter a gain, an equal one no change",
  () =>
    proves(
      "collie-measure-gain-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const extra = {};
          const { base, harness, product, commit, write } = yield* project(world);
          const ran = `${world.home}/ran`;
          const plan = planOf(harness, "bench.sh", ran);
          const runId = yield* asking(world, extra);

          const answered = yield* measuring(world, extra, runId, base, plan);
          expect(answered.envelope.error).toBeUndefined();
          expect(
            (yield* Schema.decodeUnknownEffect(Answered)(answered.envelope.data).pipe(Effect.orDie))
              .ran,
          ).toBe(true);
          const [measured] = yield* recorded(world, runId);
          expect(measured).toBeDefined();
          const cli = measured!;
          expect(verdictOf(cli, "bench.counter")).toBe("gain");
          expect(Arr.map(cli.samples, (one) => [one.tree, one.warmup])).toEqual([
            ["base", true],
            ["candidate", true],
            ["base", false],
            ["candidate", false],
            ["candidate", false],
            ["base", false],
          ]);
          expect(Arr.map(cli.samples, (one) => one.readings["bench.counter"])).toEqual([
            10, 7, 10, 7, 7, 10,
          ]);
          // What ran, in the order it ran: the base tree is a checkout of Collie's own.
          const order = yield* linesOf(world, ran);
          expect(Arr.map(order, (dir) => (dir === world.project ? "candidate" : "base"))).toEqual(
            Arr.map(cli.samples, (one) => one.tree),
          );
          expect(cli.base.commit).toBe(base);
          expect(cli.candidate.head_sha).toBe(product);
          expect(cli.base.fingerprint).not.toBe("");
          expect(cli.candidate.fingerprint).not.toBe("");
          expect(cli.base.lockfiles).toEqual(cli.candidate.lockfiles);
          expect(Rec.keys(cli.candidate.lockfiles)).toEqual(["bun.lock"]);
          expect(cli.plan.commands).toEqual(plan.commands);
          expect(Arr.every(cli.samples, (one) => one.load.length === 3)).toBe(true);
          expect(cli.waited).toEqual({ memory: false, machine: [] });

          // The same request through a workflow records the same Measurement.
          const started = yield* collie(world, [
            "run",
            "start",
            "measured",
            "--input",
            `base=${base}`,
            "--input",
            `plan=${encode(plan)}`,
            "--input",
            "pass=calibration",
          ]);
          const workflowRun = (yield* Schema.decodeUnknownEffect(Started)(
            started.envelope.data,
          ).pipe(Effect.orDie)).runId;
          const finished = yield* collie(world, ["run", "wait", workflowRun]);
          const status = (yield* Schema.decodeUnknownEffect(Waited)(finished.envelope.data).pipe(
            Effect.orDie,
          )).run.status;
          expect(status.status).toBe("complete");
          const [fromWorkflow] = yield* recorded(world, workflowRun);
          const read = yield* Schema.decodeEffect(Read)(status.value).pipe(Effect.orDie);
          expect(fromWorkflow?.id).toBe(read.id);
          // The host's evidence carries the Measurements: a product change is no tree to end on.
          expect(read.withoutPatch).toBe(false);
          expect(read.gaps).toContainEqual(expect.stringContaining("no `final` Measurement"));
          const same = (one: Measurement) => ({
            keys: Rec.keys(one).sort(),
            pass: one.pass,
            plan_digest: one.plan_digest,
            base: {
              commit: one.base.commit,
              fingerprint: one.base.fingerprint,
              lockfiles: one.base.lockfiles,
            },
            candidate: one.candidate,
            environment: one.environment,
            samples: Arr.map(one.samples, (sample) => [
              sample.tree,
              sample.warmup,
              sample.readings["bench.counter"],
            ]),
            result: one.result,
          });
          expect(same(fromWorkflow!)).toEqual(same(cli));

          // An equal counter on both sides is no change.
          yield* write("value", "10\n");
          yield* commit("back");
          const level = yield* measuring(world, extra, runId, base, plan);
          expect(level.envelope.ok).toBe(true);
          expect(verdictOf((yield* recorded(world, runId)).at(-1)!, "bench.counter")).toBe(
            "no-change",
          );

          // Back at the base tree's content, a `final` Measurement reads as no patch, judged
          // against the merge base the host found rather than the base it was asked for.
          yield* exec(["git", "branch", "-M", "master"], { cwd: world.project });
          const back = Str.trim(
            (yield* exec(["git", "rev-parse", "HEAD"], {
              cwd: world.project,
            })).stdout,
          );
          const again = yield* collie(world, [
            "run",
            "start",
            "measured",
            "--input",
            `base=${base}`,
            "--input",
            `plan=${encode(plan)}`,
            "--input",
            "pass=final",
          ]);
          const againRun = (yield* Schema.decodeUnknownEffect(Started)(again.envelope.data).pipe(
            Effect.orDie,
          )).runId;
          const reread = yield* Schema.decodeEffect(Read)(
            (yield* Schema.decodeUnknownEffect(Waited)(
              (yield* collie(world, ["run", "wait", againRun])).envelope.data,
            ).pipe(Effect.orDie)).run.status.value,
          ).pipe(Effect.orDie);
          expect(reread.withoutPatch).toBe(true);
          expect(reread.gaps).toContainEqual(expect.stringContaining(`not the merge base ${back}`));
          const shown = (yield* collie(world, ["run", "show", againRun])).envelope.data;
          expect((yield* Schema.decodeUnknownEffect(Proves)(shown).pipe(Effect.orDie)).run).toEqual(
            {
              outcome: "performance",
              measurement: expect.stringContaining(
                `final Measurement ${reread.id}: bench.counter no-change`,
              ),
            },
          );

          // Its base tree goes with the Run, once a sweep finds nothing needs it.
          const trees = `${world.state}/measurements/trees/${runId}`;
          expect(yield* fs.readDirectory(trees)).toHaveLength(1);
          yield* collie(world, ["run", "stop", runId]);
          const swept = yield* collie(world, ["cleanup", "--apply", "--request-id", "sweep-1"]);
          expect(swept.envelope.ok).toBe(true);
          expect(yield* fs.exists(trees)).toBe(false);
          const listed = yield* exec(["git", "worktree", "list", "--porcelain"], {
            cwd: world.project,
          });
          expect(listed.stdout).not.toContain(trees);
          yield* stopHost(world.state);
        }),
      ["asks.workflow.ts", "measured.workflow.ts"],
    ),
  240_000,
);

test(
  "a recorded comparison answers again without running; a new plan, a time limit, a stray harness path and a failed prepare each say so",
  () =>
    proves(
      "collie-measure-once-",
      (world) =>
        Effect.gen(function* () {
          const extra = {};
          const { base, harness, commit, write } = yield* project(world);
          const ran = `${world.home}/ran`;
          const runId = yield* asking(world, extra);

          const noisy = planOf(harness, "noisy.sh", ran);
          const first = yield* measuring(world, extra, runId, base, noisy);
          expect(first.envelope.ok).toBe(true);
          const [inconclusive] = yield* recorded(world, runId);
          expect(verdictOf(inconclusive!, "bench.counter")).toBe("inconclusive");
          const runs = (yield* linesOf(world, ran)).length;

          const again = yield* measuring(world, extra, runId, base, noisy, "cycle 1");
          expect(
            yield* Schema.decodeUnknownEffect(Answered)(again.envelope.data).pipe(Effect.orDie),
          ).toEqual({
            ran: false,
            measurement: expect.objectContaining({ id: inconclusive!.id }),
          });
          expect((yield* linesOf(world, ran)).length).toBe(runs);
          expect(yield* recorded(world, runId)).toEqual([inconclusive!]);

          const replanned = yield* measuring(
            world,
            extra,
            runId,
            base,
            { ...noisy, samples: 3 },
            "calibration",
            "three samples a side",
          );
          expect(
            (yield* Schema.decodeUnknownEffect(Answered)(replanned.envelope.data).pipe(
              Effect.orDie,
            )).ran,
          ).toBe(true);
          expect((yield* linesOf(world, ran)).length).toBeGreaterThan(runs);
          expect(yield* recorded(world, runId)).toHaveLength(2);
          expect((yield* recorded(world, runId)).at(-1)?.plan_reason).toBe("three samples a side");

          // A sample over the plan's limit ends it without a verdict.
          const slow = yield* measuring(
            world,
            extra,
            runId,
            base,
            planOf(harness, "gate.sh", ran, { limit: 1 }, [`${world.home}/never`]),
            "calibration",
            "a gated benchmark",
          );
          expect(slow.envelope.ok).toBe(true);
          expect((yield* recorded(world, runId)).at(-1)?.result).toEqual({
            _tag: "TimedOut",
            tree: "base",
            stage: "sample",
            command: "bench",
          });

          // A harness commit reaching past the harness paths is refused, naming each.
          yield* write("bench/more.sh", "true\n");
          yield* write("README", "product\n");
          const stray = yield* commit("stray harness");
          const refused = yield* measuring(world, extra, runId, base, {
            ...planOf(harness, "bench.sh", ran),
            harness: { commits: [harness, stray], paths: ["bench"] },
          });
          expect(refused.envelope.ok).toBe(false);
          expect(refused.envelope.error?.message).toContain("README");
          expect(refused.envelope.error?.message).not.toContain("bench/more.sh");

          // A base whose prepare fails ends it without a verdict, naming the tree.
          const before = (yield* recorded(world, runId)).length;
          const prepared = yield* measuring(
            world,
            extra,
            runId,
            base,
            {
              ...planOf(harness, "bench.sh", ran),
              prepare: {
                executable: "sh",
                argv: ["-c", "echo preparing $(cat value); test $(cat value) != 10"],
              },
            },
            "calibration",
            "a prepare step",
          );
          expect(prepared.envelope.ok).toBe(true);
          const failed = (yield* recorded(world, runId)).at(-1)!;
          expect((yield* recorded(world, runId)).length).toBe(before + 1);
          expect(failed.result).toMatchObject({ _tag: "Failed", tree: "base", stage: "prepare" });
          expect(failed.prepare[0]?.output).toContain("preparing 10");
          yield* stopHost(world.state);
        }),
      ["asks.workflow.ts"],
    ),
  240_000,
);

test(
  "one Measurement holds the Machine while the next waits on its card, a Stop ends a wait, and a wait for memory is recorded",
  () =>
    proves(
      "collie-measure-machine-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const proc = `${world.home}/proc`;
          const memory = (availableGiB: number) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(proc, { recursive: true });
              yield* fs.writeFileString(
                `${proc}/meminfo`,
                `MemTotal: ${100 * 1048576} kB\nMemAvailable: ${availableGiB * 1048576} kB\n`,
              );
            }).pipe(Effect.orDie);
          yield* memory(50);
          const extra = { COLLIE_PROC: proc, COLLIE_MEMORY_EVERY: "100 millis" };
          const { base, harness } = yield* project(world);
          const ran = `${world.home}/ran`;
          const gate = `${world.home}/gate`;
          const gated = planOf(harness, "gate.sh", ran, {}, [gate]);
          const [holder, waiter, stopped] = [
            yield* asking(world, extra),
            yield* asking(world, extra),
            yield* asking(world, extra),
          ];
          const shown = (runId: string) =>
            collie(world, ["run", "show", runId], extra).pipe(
              Effect.map((one) =>
                flow(Schema.decodeUnknownResult(Shown), Result.getOrThrow)(one.envelope.data),
              ),
            );

          const holding = yield* Effect.forkChild(measuring(world, extra, holder, base, gated));
          yield* until(
            () => linesOf(world, ran),
            (lines) => lines.length > 0,
          );
          const waiting = yield* Effect.forkChild(measuring(world, extra, waiter, base, gated));
          const ending = yield* Effect.forkChild(measuring(world, extra, stopped, base, gated));
          for (const runId of [waiter, stopped])
            expect(
              (yield* until(
                () => shown(runId),
                (one) => one.run.awaiting !== null,
              )).run.awaiting?.on,
            ).toContain(`Measurement ${holder}-measurement-`);

          yield* collie(world, ["run", "stop", stopped], extra);
          const ended = yield* Fiber.join(ending);
          expect(ended.envelope.ok).toBe(false);
          expect(ended.envelope.error?.code).toBe("invalid_state");
          expect((yield* shown(stopped)).run.awaiting).toBeNull();
          expect(yield* recorded(world, stopped)).toEqual([]);

          yield* fs.writeFileString(gate, "").pipe(Effect.orDie);
          expect((yield* Fiber.join(holding)).envelope.ok).toBe(true);
          expect((yield* Fiber.join(waiting)).envelope.ok).toBe(true);
          const [held] = yield* recorded(world, holder);
          const [after] = yield* recorded(world, waiter);
          expect(after?.waited.machine).toEqual([held!.id]);
          expect(epochMs(after!.started)).toBeGreaterThanOrEqual(epochMs(held!.at));
          expect((yield* shown(waiter)).run.awaiting).toBeNull();

          // Short of memory: it waits, says so, and records that it did.
          yield* memory(2);
          const short = yield* Effect.forkChild(
            measuring(
              world,
              extra,
              waiter,
              base,
              planOf(harness, "bench.sh", ran),
              "calibration",
              "an ungated benchmark",
            ),
          );
          yield* until(
            () => memoryWaitOf(runDir(world.state, waiter)),
            (one) => one !== null,
          );
          expect((yield* recorded(world, waiter)).length).toBe(1);
          yield* memory(50);
          expect((yield* Fiber.join(short)).envelope.ok).toBe(true);
          expect((yield* recorded(world, waiter)).at(-1)?.waited.memory).toBe(true);
          yield* stopHost(world.state);
        }),
      ["asks.workflow.ts"],
    ),
  240_000,
);
