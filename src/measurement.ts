// A Measurement: a Run's benchmark plan sampled on a base tree and a candidate tree of this
// Machine, alternately, and judged (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement,
// D1, D2 and D4). `collie measure` and `host.measure` both come here.

import { loadavg } from "node:os";
import {
  Clock,
  Data,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { AwaitingJson } from "./awaiting";
import { CheckProcesses, type CheckOf } from "./check-processes";
import type { PluginEnv } from "./env";
import { appendJournal, readJournal } from "./journal";
import { ensureLockDir, withLock } from "./lock";
import { judge, MeasurementRefused } from "./measurement-verdict";
import {
  BenchmarkPlan,
  MeasurementJson,
  PASS_LABEL,
  type Measurement,
  type Sample,
} from "./measurement-model";
import { machineMemory } from "./memory";
import { waitForMemory } from "./memory-wait";
import { shell } from "./mr";
import { machineName } from "./peers";
import { nowIso } from "./time";
import { contentOf, environmentOf, fingerprint, resolveExecutable, TOO_LARGE } from "./verify";

const MeasurementLine = Schema.fromJsonString(MeasurementJson);

export class MeasureRefused extends Data.TaggedError("MeasureRefused")<{ readonly why: string }> {}

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
];

const OUTPUT_BYTES = 4 * 1024;
/** Of stdout, for its last line: a longer one is cut, and its metrics are missing. */
const LINE_BYTES = 64 * 1024;
/** What the host reads of every command, which no command's own JSON replaces. */
const HOST_READINGS = ["wall_ms", "cpu_ms", "peak_kb"];
/** A benchmark's process as the host's checks record it; a dead host's are ended by the next Measurement. */
const MEASURING = "measure: ";

export const measurementsDir = (stateDir: string) => `${stateDir}/measurements`;
/** Every base tree a Run's Measurements were taken on, Cleanup's to remove. */
export const baseTreesDir = (stateDir: string, runId: string) =>
  `${measurementsDir(stateDir)}/trees/${runId}`;
const journalOf = (evidence: string) => `${evidence}/measurements.jsonl`;

export const readMeasurements = (evidence: string) =>
  readJournal(journalOf(evidence), MeasurementLine);

export interface MeasureAsk {
  readonly runId: string;
  /** The commit the base tree is made at. */
  readonly base: string;
  /** The candidate tree: the caller has checked it is the Run's. */
  readonly cwd: string;
  readonly plan: unknown;
  readonly pass: string;
  /** Why the plan changed: needed where the Run was measured under another. */
  readonly reason?: string;
}

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const git = (args: ReadonlyArray<string>, cwd: string) => shell("git", [...args], cwd);

const tail = (text: string, bytes = OUTPUT_BYTES) =>
  text.length <= bytes ? text : text.slice(-bytes);

/** The last `bytes` of a stream, kept as it arrives rather than buffered whole. */
const tailOf = (stream: ReadableStream<Uint8Array>, bytes: number) =>
  Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }).pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (kept: string, chunk: string) => tail(kept + chunk, bytes),
    ),
    Effect.orElseSucceed(() => ""),
  );

const digestOf = (text: string) => Bun.hash(text).toString(16);

/** The commit `ref` names, or why it names none. */
const commitOf = (ref: string, cwd: string) =>
  Effect.gen(function* () {
    const ran = yield* git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    if (ran.code !== 0) return yield* new MeasureRefused({ why: `"${ref}" is not a commit here` });
    return ran.stdout.trim();
  });

const lockfilesOf = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: Record<string, string> = {};
    for (const name of LOCKFILES) {
      const bytes = yield* fs.readFile(`${root}/${name}`).pipe(Effect.option);
      if (Option.isSome(bytes)) found[name] = digestOf(Buffer.from(bytes.value).toString("latin1"));
    }
    return found;
  });

const treeAt = (cwd: string) =>
  Effect.gen(function* () {
    const { head_sha, fingerprint: print } = yield* fingerprint(cwd);
    return {
      cwd,
      head_sha,
      fingerprint: print,
      content: yield* contentOf(cwd),
      lockfiles: yield* lockfilesOf(cwd),
    };
  });

/** Each path a harness commit touches outside the plan's harness paths. */
const outsideHarness = (
  commits: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  cwd: string,
) =>
  Effect.gen(function* () {
    const roots = paths.map((one) => one.replace(/\/+$/, ""));
    const outside = new Set<string>();
    for (const commit of commits) {
      const touched = yield* git(["show", "--name-only", "--format=", "-m", commit], cwd);
      for (const file of touched.stdout.split("\n"))
        if (file !== "" && !roots.some((root) => file === root || file.startsWith(`${root}/`)))
          outside.add(file);
    }
    return [...outside].sort();
  });

/**
 * The base tree: a detached worktree at `commit` with the harness commits applied, kept for
 * the Run's later Measurements of the same base and removed by Cleanup.
 */
const baseTree = (
  stateDir: string,
  runId: string,
  repository: string,
  commit: string,
  harness: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${baseTreesDir(stateDir, runId)}/${digestOf([commit, ...harness].join("\n"))}`;
    const complete = Effect.gen(function* () {
      if (!(yield* fs.exists(dir))) return false;
      const above = yield* git(["rev-list", "--count", `${commit}..HEAD`], dir);
      const on = yield* git(["merge-base", "--is-ancestor", commit, "HEAD"], dir);
      const changed = yield* git(["status", "--porcelain", "--untracked-files=no"], dir);
      return (
        above.code === 0 &&
        Number(above.stdout.trim()) === harness.length &&
        on.code === 0 &&
        changed.code === 0 &&
        changed.stdout.trim() === ""
      );
    }).pipe(Effect.orElseSucceed(() => false));
    if (yield* complete) return dir;
    yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* git(["worktree", "prune"], repository);
    yield* fs.makeDirectory(baseTreesDir(stateDir, runId), { recursive: true }).pipe(Effect.orDie);
    const added = yield* git(["worktree", "add", "--detach", dir, commit], repository);
    if (added.code !== 0)
      return yield* new MeasureRefused({
        why: `the base tree could not be made at ${commit}: ${added.stderr?.trim() ?? ""}`,
      });
    if (harness.length === 0) return dir;
    const picked = yield* git(
      [
        "-c",
        "user.name=Collie",
        "-c",
        "user.email=collie@localhost",
        "cherry-pick",
        "--keep-redundant-commits",
        ...harness,
      ],
      dir,
    );
    if (picked.code === 0) return dir;
    yield* git(["worktree", "remove", "--force", dir], repository);
    return yield* new MeasureRefused({
      why: `the harness commits do not apply on ${commit}: ${picked.stderr?.trim() ?? picked.stdout.trim()}`,
    });
  });

type Ended =
  | {
      readonly _tag: "Exited";
      readonly exit: number;
      readonly stdout: string;
      readonly output: string;
      readonly wall: number;
      readonly cpu: number;
      readonly peak: number;
    }
  | { readonly _tag: "TimedOut" };

/**
 * One command, recorded as the host's checks are and its process group ended whichever way it
 * leaves; no shell between. Spawned here rather than by the checks, for its CPU time and peak.
 * Timed out where `deadline`, in epoch ms, passes before it exits, its recording included.
 */
const runOnce = (
  check: CheckOf,
  command: { readonly executable: string; readonly argv: ReadonlyArray<string> },
  cwd: string,
  deadline: number,
) =>
  Effect.gen(function* () {
    const timedOut: Ended = { _tag: "TimedOut" };
    if ((yield* Clock.currentTimeMillis) >= deadline) return timedOut;
    const checks = yield* CheckProcesses;
    const began = yield* Clock.currentTimeNanos;
    let group: number | undefined;
    let expired = false;
    const end = () => {
      try {
        if (group !== undefined) process.kill(-group, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    yield* Effect.addFinalizer(() => Effect.sync(end));
    // Adoption cannot be interrupted once it spawns, so its deadline ends the command beside it.
    yield* Effect.forkScoped(
      Effect.sleep(Duration.millis(deadline - (yield* Clock.currentTimeMillis))).pipe(
        Effect.andThen(
          Effect.sync(() => {
            expired = true;
            end();
          }),
        ),
      ),
    );
    const adopted = yield* checks
      .adopt(check, (markers) =>
        Effect.sync(() => {
          const spawned = Bun.spawn([command.executable, ...command.argv], {
            cwd,
            env: { ...process.env, ...markers },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
          });
          group = spawned.pid;
          if (expired) end();
          return spawned;
        }),
      )
      .pipe(Effect.mapError((cause) => new MeasureRefused({ why: cause.why })));
    // This host began to end before it spawned.
    if (adopted === null) return yield* Effect.interrupt;
    const spawned = adopted.handle;
    const left = deadline - (yield* Clock.currentTimeMillis);
    const collecting = Effect.all(
      [
        tailOf(spawned.stdout, LINE_BYTES),
        tailOf(spawned.stderr, OUTPUT_BYTES),
        Effect.promise(() => spawned.exited),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(([stdout, stderr, exit]) =>
        Effect.map(Clock.currentTimeNanos, (now): Ended => {
          const usage = spawned.resourceUsage();
          return {
            _tag: "Exited",
            exit,
            stdout,
            output: tail(`${stdout}${stderr}`),
            wall: Number(now - began) / 1e6,
            cpu: Number(usage?.cpuTime.total ?? 0) / 1000,
            // ponytail: Linux keeps the host's RSS at the fork in a child's maxRSS, so this has
            // the host's size as a floor; a clean peak needs a small launcher between them.
            peak: Number(usage?.maxRSS ?? 0) / 1024,
          };
        }),
      ),
      Effect.timeoutOption(Duration.millis(left)),
      Effect.map((ended) => (expired ? timedOut : Option.getOrElse(ended, () => timedOut))),
    );
    // A check its host ended as it stops never answers, so no failure is recorded of it.
    return yield* adopted.collected(left <= 0 || expired ? Effect.succeed(timedOut) : collecting);
  }).pipe(Effect.scoped);

/** The named numbers of a command's last stdout line, where it is one JSON object. */
const reportedBy = (stdout: string) => {
  const last = stdout.trimEnd().split("\n").at(-1) ?? "";
  const parsed = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
  )(last);
  if (Option.isNone(parsed)) return [];
  return Object.entries(parsed.value).flatMap(([key, value]) =>
    Schema.is(Schema.Finite)(value) ? [[key, value] as const] : [],
  );
};

/** A B B A …: base first, then each pair turned round, so drift falls on both sides alike. */
export const sampleOrder = (samples: number): ReadonlyArray<"base" | "candidate"> =>
  Array.from({ length: samples }, (_, at) =>
    at % 2 === 0 ? (["base", "candidate"] as const) : (["candidate", "base"] as const),
  ).flat();

/** A recorded Measurement of the same trees under the same plan answers again. */
const recordedFor = (
  records: ReadonlyArray<Measurement>,
  key: {
    readonly commit: string;
    readonly digest: string;
    readonly head: string;
    readonly print: string;
  },
) =>
  records.find(
    (one) =>
      key.print !== TOO_LARGE &&
      one.base.commit === key.commit &&
      one.plan_digest === key.digest &&
      one.candidate.head_sha === key.head &&
      one.candidate.fingerprint === key.print,
  ) ?? null;

/** What a Measurement waited on before it sampled, filled in as it waits. */
interface Waited {
  memory: boolean;
  readonly machine: Array<string>;
}

export interface Measuring {
  readonly stateDir: string;
  /** Where the Machine's memory is read; without one, nothing waits for memory. */
  readonly env: PluginEnv | null;
  readonly ask: MeasureAsk;
  /** The Run's evidence directory. */
  readonly evidence: string;
  /** The Run's `awaiting` file, which says what its waiting Measurement waits for. */
  readonly awaiting: string;
  readonly stopped: Effect.Effect<boolean, never, FileSystem.FileSystem>;
  readonly say?: (line: string) => Effect.Effect<void>;
}

/**
 * The recorded Measurement of these trees under this plan, or a new one taken while this
 * Machine runs no other: `ran` says which. `stopped` where the Run's Stop ended it first,
 * which records nothing.
 */
export const measure = Effect.fn("Measurement.measure")(function* (
  opts: Measuring,
): Effect.fn.Return<
  { readonly measurement: Measurement; readonly ran: boolean } | "stopped",
  MeasureRefused,
  Services
> {
  const { ask } = opts;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const say = opts.say ?? (() => Effect.void);
  if (!PASS_LABEL.test(ask.pass))
    return yield* new MeasureRefused({
      why: `the pass is "calibration", "cycle N" or "final", not "${ask.pass}"`,
    });
  const plan = yield* Schema.decodeUnknownEffect(BenchmarkPlan)(ask.plan).pipe(
    Effect.mapError(
      (cause) => new MeasureRefused({ why: `the plan is not one: ${cause.message}` }),
    ),
  );
  const primaries = plan.metrics.filter((one) => one.role === "primary").length;
  if (primaries !== 1)
    return yield* new MeasureRefused({
      why: `a plan declares exactly one primary metric, not ${primaries}`,
    });
  const digest = digestOf(Schema.encodeSync(Schema.fromJsonString(BenchmarkPlan))(plan));
  const repository = (yield* git(["rev-parse", "--show-toplevel"], ask.cwd)).stdout.trim();
  if (repository === "")
    return yield* new MeasureRefused({ why: `"${ask.cwd}" is not in a git checkout` });
  const commit = yield* commitOf(ask.base, ask.cwd);
  const harness: Array<string> = [];
  for (const one of plan.harness.commits) harness.push(yield* commitOf(one, ask.cwd));
  const outside = yield* outsideHarness(harness, plan.harness.paths, ask.cwd);
  if (outside.length > 0)
    return yield* new MeasureRefused({
      why: `a harness commit touches ${outside.join(", ")}, outside the plan's harness paths (${plan.harness.paths.join(", ")})`,
    });

  const recorded = Effect.gen(function* () {
    const now = yield* fingerprint(ask.cwd);
    const records = yield* readMeasurements(opts.evidence).pipe(Effect.orElseSucceed(() => []));
    return recordedFor(records, { commit, digest, head: now.head_sha, print: now.fingerprint });
  });
  const before = yield* recorded;
  if (before !== null) return { measurement: before, ran: false };
  const reason = ask.reason?.trim() || null;
  const earlier = yield* readMeasurements(opts.evidence).pipe(Effect.orElseSucceed(() => []));
  if (reason === null && earlier.length > 0 && !earlier.some((one) => one.plan_digest === digest))
    return yield* new MeasureRefused({
      why: `run ${ask.runId} was measured under another plan; a new plan is measured only with its reason`,
    });

  const waited: Waited = { memory: false, machine: [] };
  const id = `${ask.runId}-measurement-${yield* Clock.currentTimeMillis}`;
  const lock = `${measurementsDir(opts.stateDir)}/machine.lock`;
  const holderFile = `${measurementsDir(opts.stateDir)}/holder.json`;
  const Holder = Schema.fromJsonString(Schema.Struct({ id: Schema.String, run: Schema.String }));

  const taken = Effect.gen(function* () {
    const again = yield* recorded;
    if (again !== null) return { measurement: again, ran: false };
    yield* fs
      .writeFileString(holderFile, Schema.encodeSync(Holder)({ id, run: ask.runId }))
      .pipe(Effect.orDie);
    if (opts.env !== null) {
      const memory = yield* waitForMemory({
        env: opts.env,
        stateDir: opts.stateDir,
        runId: ask.runId,
        what: `measure ${ask.pass}`,
        stopped: opts.stopped,
        say,
      });
      if (memory === "stopped") return "stopped" as const;
      waited.memory = memory === "waited";
    }
    const checks = yield* CheckProcesses;
    for (const leftover of yield* checks.left)
      if (
        leftover.name?.startsWith(MEASURING) &&
        (yield* checks.endLeftover(leftover)) === "still running"
      )
        return yield* new MeasureRefused({
          why: `${leftover.name} of ${leftover.run} (pid ${leftover.leader.pid}), left by an earlier host, survived SIGTERM and SIGKILL; \`collie cleanup --apply\` tries to end it again`,
        });
    return yield* taking({
      ...opts,
      plan,
      digest,
      reason,
      id,
      commit,
      harness,
      repository,
      waited,
      path,
    });
  }).pipe(Effect.ensuring(fs.remove(holderFile).pipe(Effect.ignore)));

  yield* ensureLockDir(lock).pipe(Effect.orDie);
  const clearWait = Effect.gen(function* () {
    const before = yield* fs
      .readFileString(opts.awaiting)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AwaitingJson)), Effect.option);
    if (Option.isSome(before) && before.value.on.startsWith("this Machine"))
      yield* fs.remove(opts.awaiting);
  }).pipe(Effect.ignore);
  return yield* Effect.gen(function* () {
    const since = yield* nowIso();
    for (;;) {
      const held = yield* withLock(
        lock,
        Effect.succeed(Option.none()),
        Effect.map(Effect.result(taken), Option.some),
      ).pipe(Effect.orDie);
      if (Option.isSome(held)) return yield* Effect.fromResult(held.value);
      if (yield* opts.stopped) return "stopped" as const;
      const holder = yield* fs
        .readFileString(holderFile)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.option);
      if (Option.isNone(holder) || waited.machine.includes(holder.value.id)) continue;
      waited.machine.push(holder.value.id);
      const on = `this Machine: Measurement ${holder.value.id} of ${holder.value.run} is running on it`;
      yield* fs
        .writeFileString(opts.awaiting, Schema.encodeSync(AwaitingJson)({ on, who: null, since }))
        .pipe(Effect.orDie);
      yield* say(`waiting for ${on}`);
    }
  }).pipe(Effect.ensuring(clearWait));
});

const taking = Effect.fn("Measurement.taking")(function* (
  opts: Measuring & {
    readonly plan: BenchmarkPlan;
    readonly digest: string;
    readonly reason: string | null;
    readonly id: string;
    readonly commit: string;
    readonly harness: ReadonlyArray<string>;
    readonly repository: string;
    readonly waited: Waited;
    readonly path: Path.Path;
  },
) {
  const { ask, plan, path } = opts;
  const started = yield* nowIso();
  const candidate = yield* treeAt(ask.cwd);
  const baseRoot = yield* baseTree(
    opts.stateDir,
    ask.runId,
    opts.repository,
    opts.commit,
    opts.harness,
  );
  const base = {
    commit: opts.commit,
    ...(yield* treeAt(path.join(baseRoot, path.relative(opts.repository, ask.cwd)))),
  };
  const roots = { base: base.cwd, candidate: candidate.cwd };
  const checkOf = { run: ask.runId, pass: { pass: ask.pass }, by: "collie" } as const;
  const environment: Record<string, string | null> = {};
  for (const command of plan.commands) {
    const absolute = yield* resolveExecutable(command.executable, candidate.cwd);
    environment[command.name] = absolute === null ? null : yield* environmentOf(absolute);
  }
  const prepared: Array<Measurement["prepare"][number]> = [];
  const samples: Array<Sample> = [];
  const record = (result: Measurement["result"]) =>
    Effect.gen(function* () {
      const measurement: Measurement = {
        id: opts.id,
        run: ask.runId,
        pass: ask.pass,
        machine: machineName(),
        plan,
        plan_digest: opts.digest,
        plan_reason: opts.reason,
        base,
        candidate,
        environment,
        waited: { memory: opts.waited.memory, machine: [...opts.waited.machine] },
        prepare: prepared,
        samples,
        result,
        started,
        at: yield* nowIso(),
      };
      yield* appendJournal(journalOf(opts.evidence), MeasurementLine, measurement).pipe(
        Effect.orDie,
      );
      return { measurement, ran: true };
    });

  const moved = Effect.gen(function* () {
    const trees: Array<string> = [];
    for (const [tree, was] of [
      ["base", base],
      ["candidate", candidate],
    ] as const) {
      const now = yield* fingerprint(was.cwd);
      if (now.head_sha !== was.head_sha || now.fingerprint !== was.fingerprint) trees.push(tree);
    }
    return trees.length === 0
      ? null
      : `the ${trees.join(" and ")} ${trees.length > 1 ? "trees" : "tree"} changed while ${trees.length > 1 ? "they were" : "it was"} measured, so no reading is of the tree recorded`;
  });

  const work = Effect.gen(function* () {
    if (plan.prepare !== null)
      for (const tree of ["base", "candidate"] as const) {
        const ended = yield* runOnce(
          { ...checkOf, name: `${MEASURING}prepare` },
          plan.prepare,
          roots[tree],
          (yield* Clock.currentTimeMillis) + plan.limit * 1000,
        );
        const command = [plan.prepare.executable, ...plan.prepare.argv].join(" ");
        if (ended._tag === "TimedOut")
          return yield* record({ _tag: "TimedOut", tree, stage: "prepare", command });
        prepared.push({ tree, exit: ended.exit, seconds: ended.wall / 1000, output: ended.output });
        if (ended.exit !== 0)
          return yield* record({
            _tag: "Failed",
            tree,
            stage: "prepare",
            command,
            exit: ended.exit,
            output: ended.output,
          });
      }
    const prepareMoved = yield* moved;
    if (prepareMoved !== null) return yield* record({ _tag: "Unjudged", reason: prepareMoved });
    const order = [
      ...sampleOrder(plan.warmup).map((tree) => ({ tree, warmup: true })),
      ...sampleOrder(plan.samples).map((tree) => ({ tree, warmup: false })),
    ];
    for (const { tree, warmup } of order) {
      const memory =
        opts.env === null
          ? null
          : yield* machineMemory(opts.env).pipe(
              Effect.map((read) => read.memory),
              Effect.orElseSucceed(() => null),
            );
      const load = loadavg();
      const at = yield* nowIso();
      const readings: Record<string, number> = {};
      const deadline = (yield* Clock.currentTimeMillis) + plan.limit * 1000;
      for (const command of plan.commands) {
        const ended = yield* runOnce(
          { ...checkOf, name: `${MEASURING}${command.name}` },
          command,
          roots[tree],
          deadline,
        );
        if (ended._tag === "TimedOut")
          return yield* record({ _tag: "TimedOut", tree, stage: "sample", command: command.name });
        if (ended.exit !== 0)
          return yield* record({
            _tag: "Failed",
            tree,
            stage: "sample",
            command: command.name,
            exit: ended.exit,
            output: ended.output,
          });
        for (const [key, value] of reportedBy(ended.stdout))
          if (!HOST_READINGS.includes(key)) readings[`${command.name}.${key}`] = value;
        readings[`${command.name}.wall_ms`] = ended.wall;
        readings[`${command.name}.cpu_ms`] = ended.cpu;
        readings[`${command.name}.peak_kb`] = ended.peak;
      }
      samples.push({
        tree,
        warmup,
        readings,
        load,
        memory:
          memory !== null && memory.known
            ? { available: memory.available, total: memory.total, pressure: memory.pressure }
            : null,
        at,
      });
      const sampleMoved = yield* moved;
      if (sampleMoved !== null) return yield* record({ _tag: "Unjudged", reason: sampleMoved });
    }
    const judged = yield* Effect.forEach(plan.metrics, (metric) => {
      const judgedSamples = samples.filter((one) => !one.warmup);
      const gap = judgedSamples.find((one) => one.readings[metric.name] === undefined);
      if (gap !== undefined)
        return Effect.fail(
          new MeasurementRefused({
            metric: metric.name,
            reason: `a ${gap.tree} sample at ${gap.at} has no reading of it`,
          }),
        );
      const of = (tree: "base" | "candidate") =>
        judgedSamples.flatMap((one) => {
          const value = one.readings[metric.name];
          return one.tree === tree && value !== undefined ? [value] : [];
        });
      return judge(
        opts.id,
        {
          metric: metric.name,
          direction: metric.direction,
          base: of("base"),
          candidate: of("candidate"),
        },
        plan,
      );
    }).pipe(Effect.result);
    return yield* record(
      judged._tag === "Success"
        ? { _tag: "Judged", verdicts: judged.success }
        : { _tag: "Unjudged", reason: judged.failure.message },
    );
  });
  const stopping = opts.stopped.pipe(
    Effect.repeat({ until: (stop) => stop, schedule: Schedule.spaced("1 second") }),
    Effect.as("stopped" as const),
  );
  return yield* Effect.raceFirst(work, stopping);
});
