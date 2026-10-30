import assert from "node:assert/strict";
import { cpus } from "node:os";
import { Cause, Console, DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import { runEffect } from "../test/support/effect";
import { ensureLockDir, withLock } from "../src/lock";

const PAIRS = 10;
const T_975_DF9 = 2.2621571628540993;
const DEPENDENCIES = [
  [
    "@effect/platform-node-shared/dist/NodeFileSystem.js",
    "bbeea3bdddff446a1be9484265b3ad1faada19aa67c8ac33909bbddd644079fc",
  ],
  [
    "effect/dist/sql/SqlClient.js",
    "fdcde5285fa86f4d539e02d1a1b1779aef40afed3ed698c08e3103e76adde457",
  ],
  [
    "@effect/sql-sqlite-bun/dist/SqliteClient.js",
    "b3e1aa1722bb29de62f2baa94256c86148a0809abe3acd2522e83e5edf2dae7e",
  ],
] as const;
const mean = (xs: readonly number[]) => Arr.reduce(xs, 0, (sum, x) => sum + x) / xs.length;
const comparison = (base: readonly number[], candidate: readonly number[]) => {
  assert.equal(base.length, PAIRS);
  assert.equal(candidate.length, PAIRS);
  const logs = Arr.map(candidate, (x, i) => {
    const previous = base[i];
    assert.ok(x > 0 && Number.isFinite(x) && previous !== undefined && previous > 0);
    return Math.log(x / previous);
  });
  const average = mean(logs);
  const se = Math.sqrt(
    Arr.reduce(logs, 0, (sum, x) => sum + (x - average) ** 2) / (PAIRS - 1) / PAIRS,
  );
  const ratio = Math.exp(average);
  return {
    baseline_mean: mean(base),
    candidate_mean: mean(candidate),
    ratio,
    ci95: [Math.exp(average - T_975_DF9 * se), Math.exp(average + T_975_DF9 * se)],
    reduction_percent: 100 * (1 - ratio),
  };
};
const example = comparison(Array(10).fill(20), Array(10).fill(10));
assert.ok(Math.abs(example.ratio - 0.5) < 1e-12);
assert.ok(Arr.every(example.ci95, (x) => Math.abs(x - 0.5) < 1e-12));
assert.ok(Math.abs(example.reduction_percent - 50) < 1e-10);
const spread = comparison(Array(10).fill(1), [...Array(9).fill(1), 2.718281828459045]);
assert.ok(Math.abs(spread.ratio - 1.1051709180756477) < 1e-12);
assert.ok(Math.abs((spread.ci95[0] ?? 0) - 0.88142468861435) < 1e-12);
assert.ok(Math.abs((spread.ci95[1] ?? 0) - 1.3857142577663495) < 1e-12);
if (process.argv[2] === "--self-check") process.exit(0);

const Metrics = Schema.fromJsonString(
  Schema.Struct({
    read_mean_ms: Schema.Finite,
    read_p95_ms: Schema.Finite,
    cold_read_ms: Schema.Finite,
    shown_mean_ms: Schema.Finite,
    runs_mean_ms: Schema.Finite,
    progress_mean_ms: Schema.Finite,
    idle_cpu_ms_per_s: Schema.Finite,
    host_peak_kb: Schema.Finite,
    mutation_mean_ms: Schema.Finite,
    mixed_read_mean_ms: Schema.Finite,
    correctness_failures: Schema.Finite,
    raw: Schema.Struct({ sample_answer: Schema.String }),
  }),
);
type Metrics = typeof Metrics.Type;
const decode = Schema.decodeUnknownEffect(Metrics);
const encode = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const study = Effect.gen(function* () {
  const baseline = process.argv[2];
  const destination = process.argv[3];
  assert.ok(
    baseline && destination,
    "bun bench/paired.ts <merge-base checkout> <evidence directory>",
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = process.cwd();
  const base = path.resolve(baseline);
  const out = path.resolve(destination);
  const cache = path.join(candidate, ".scratch/private-bun-cache");
  assert.equal(
    yield* fs.exists(`${out}/manifest.json`),
    false,
    "keep prior studies; use a new evidence directory",
  );
  yield* fs.makeDirectory(out, { recursive: true });
  const git = (cwd: string, ...args: string[]) => {
    const ran = Bun.spawnSync(["git", ...args], { cwd });
    assert.equal(ran.exitCode, 0, ran.stderr.toString());
    return Str.trim(ran.stdout.toString());
  };
  const baseSha = git(base, "rev-parse", "HEAD");
  const candidateSha = git(candidate, "rev-parse", "HEAD");
  assert.equal(baseSha, git(candidate, "merge-base", "HEAD", "origin/master"));
  const source = yield* fs.readFileString(`${candidate}/bench/read.ts`);
  yield* fs.makeDirectory(`${base}/bench`, { recursive: true });
  yield* fs.writeFileString(`${base}/bench/read.ts`, source);
  assert.equal(yield* fs.readFileString(`${base}/bench/read.ts`), source);
  const integrity = (cwd: string) =>
    Effect.forEach(DEPENDENCIES, ([name, expected]) =>
      Effect.gen(function* () {
        const file = path.join(cwd, "node_modules", name);
        const sha256 = new Bun.CryptoHasher("sha256")
          .update(yield* fs.readFile(file))
          .digest("hex");
        const info = yield* fs.stat(file);
        assert.equal(sha256, expected, `${file} differs from the pristine locked 4.1.0 package`);
        assert.equal(
          Number(Option.getOrThrow(info.nlink)),
          1,
          `${file} is shared; install with --backend copyfile`,
        );
        return {
          file: name,
          sha256,
          dev: Number(info.dev),
          inode: Number(Option.getOrThrow(info.ino)),
          links: 1,
        };
      }),
    );
  const dependencies = { baseline: yield* integrity(base), candidate: yield* integrity(candidate) };
  const env = {
    ...Bun.env,
    COLLIE_BENCH_FIXTURE: `${out}/fixture`,
    COLLIE_BENCH_LIVE: "/tmp/collie-bd4539a0-bench",
  };
  const manifest = {
    started: yield* timestamp,
    baseline: baseSha,
    candidate: candidateSha,
    original_baseline: "eadce921",
    harness_sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
    pairs: PAIRS,
    order: "AB/BA alternating, sequential fresh processes; no discarded samples or retries",
    endpoint:
      "host peak RSS (VmHWM) per process, 487 settled Runs; the base already has the read optimization",
    statistics:
      "paired log ratios, two-sided 95% Student t CI, df=9; processes are the sampling units",
    conditions:
      "fresh host per sample; warm OS cache, no drop_caches; 10 s warm-up, 20 s idle CPU window, then warm and concurrent mutation workloads",
    guardrails:
      "peak RSS upper CI ratio <1; upper CI ratio <=1.10 for every latency and idle CPU; every candidate warm p95 <=5000 ms; zero correctness failures and identical settled answer text",
    cpu_count: cpus().length,
    bun: Bun.version,
    fixture: env.COLLIE_BENCH_FIXTURE,
    dependencies,
    dependency_source:
      "fresh private Bun cache, frozen bun.lock integrity, independently copied packages; hashes checked before and after every process",
  };
  yield* fs.writeFileString(`${out}/manifest.json`, yield* encode(manifest));
  const contention = (name: string) =>
    Effect.gen(function* () {
      const processes = Bun.spawnSync(["ps", "-eo", "pid,comm,pcpu", "--sort=-pcpu"]);
      yield* fs.writeFileString(
        `${out}/${name}.contention.txt`,
        `${yield* timestamp}\n${yield* fs.readFileString("/proc/loadavg")}\n${Arr.join(Str.split(processes.stdout.toString(), "\n").slice(0, 26), "\n")}\n`,
      );
    });
  const run = (cwd: string, argv: string[], name: string) =>
    Effect.gen(function* () {
      yield* Console.log(`${yield* timestamp} ${name} started`);
      yield* fs.writeFileString(
        `${out}/${name}-before.dependencies.json`,
        yield* encode({ baseline: yield* integrity(base), candidate: yield* integrity(candidate) }),
      );
      yield* contention(`${name}-before`);
      const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Effect.promise(() => new Response(child.stdout).text()),
          Effect.promise(() => new Response(child.stderr).text()),
          Effect.promise(() => child.exited),
        ],
        { concurrency: "unbounded" },
      );
      yield* fs.writeFileString(`${out}/${name}.stdout`, stdout);
      yield* fs.writeFileString(`${out}/${name}.stderr`, stderr);
      yield* contention(`${name}-after`);
      yield* fs.writeFileString(
        `${out}/${name}-after.dependencies.json`,
        yield* encode({ baseline: yield* integrity(base), candidate: yield* integrity(candidate) }),
      );
      assert.equal(code, 0, `${name} failed; keep its logs and reject this study`);
      yield* Console.log(`${yield* timestamp} ${name} completed`);
      return Str.split(Str.trim(stdout), "\n").at(-1) ?? "";
    });
  const pairs: Array<{ base: Metrics; candidate: Metrics }> = [];
  yield* Effect.gen(function* () {
    yield* run(
      base,
      [
        process.execPath,
        "install",
        "--frozen-lockfile",
        "--cache-dir",
        cache,
        "--backend",
        "copyfile",
      ],
      "install-base",
    );
    yield* run(base, [process.execPath, "bench/read.ts", "prepare"], "prepare");
    yield* fs.writeFileString(
      `${out}/fixture-db.sha256`,
      new Bun.CryptoHasher("sha256")
        .update(yield* fs.readFile(`${env.COLLIE_BENCH_FIXTURE}/world/state/host.db`))
        .digest("hex"),
    );
    for (let pair = 0; pair < PAIRS; pair++) {
      const order =
        pair % 2 === 0 ? (["base", "candidate"] as const) : (["candidate", "base"] as const);
      const readings = new Map<string, Metrics>();
      for (const side of order)
        readings.set(
          side,
          yield* decode(
            yield* run(
              side === "base" ? base : candidate,
              [process.execPath, "bench/read.ts"],
              `${pipe(String(pair + 1), Str.padStart(2, "0"))}-${side}`,
            ),
          ),
        );
      const before = readings.get("base");
      const after = readings.get("candidate");
      assert.ok(before && after);
      pairs.push({ base: before, candidate: after });
    }
    const limits = [
      ["read_mean_ms", 1.1],
      ["read_p95_ms", 1.1],
      ["cold_read_ms", 1.1],
      ["shown_mean_ms", 1.1],
      ["runs_mean_ms", 1.1],
      ["idle_cpu_ms_per_s", 1.1],
      ["host_peak_kb", 1],
      ["mutation_mean_ms", 1.1],
      ["mixed_read_mean_ms", 1.1],
    ] as const;
    const comparisons = Arr.map(limits, ([metric, limit]) => {
      const result = comparison(
        Arr.map(pairs, (one) => one.base[metric]),
        Arr.map(pairs, (one) => one.candidate[metric]),
      );
      return { metric, ...result, limit, held: (result.ci95[1] ?? Infinity) < limit };
    });
    const correctness = Arr.every(
      pairs,
      (one) =>
        one.base.correctness_failures === 0 &&
        one.candidate.correctness_failures === 0 &&
        one.base.raw.sample_answer === one.candidate.raw.sample_answer,
    );
    const within5s = Arr.every(pairs, (one) => one.candidate.read_p95_ms <= 5_000);
    const improved = correctness && within5s && Arr.every(comparisons, (one) => one.held);
    const summary = {
      verdict: improved ? "improved" : "not proved improved",
      correctness,
      within5s,
      comparisons,
      finished: yield* timestamp,
      manifest,
      pairs,
    };
    yield* fs.writeFileString(`${out}/summary.json`, yield* encode(summary));
    yield* Console.log(
      yield* encode({ verdict: summary.verdict, correctness, within5s, comparisons }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      encode({ failed: Cause.pretty(cause), completed_pairs: pairs.length }).pipe(
        Effect.flatMap((text) => fs.writeFileString(`${out}/failed.json`, text)),
        Effect.andThen(Effect.failCause(cause)),
      ),
    ),
  );
});

const lock = process.argv[4];
assert.ok(lock, "name this Machine's measurements/machine.lock as the third argument");
await runEffect(
  ensureLockDir(lock).pipe(
    Effect.andThen(
      withLock(lock, Effect.die(new Error("another Measurement holds this Machine")), study),
    ),
  ),
);
