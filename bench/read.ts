// A large Herd's collie_run reads. `prepare` settles RUNS `hello` Runs under a host on the fake
// herdr and keeps the state it leaves; a sample starts a host on a fresh copy of that state and
// prints, as its last line, what its reads and its idle board cost.

import { tmpdir } from "node:os";
import { Clock, Console, Crypto, Effect, FileSystem, Schema } from "effect";
import { connect, ownerOf } from "../src/host";
import { runEffect } from "../test/support/effect";
import { writeFakeHerdrShim } from "../test/support/fake-herdr-core";
import { GIT_QUIET } from "../test/support/git-quiet";
import { root, stopHost } from "../test/support/host";
import { MODULES } from "../test/support/hosted";
import { testBunfig } from "../test/support/packages";
import { save } from "../test/support/world";

const RUNS = 487;
const ROUNDS = 12;
const IDLE_SECONDS = 20;

const kept = `${process.cwd()}/.scratch/bench-read`;
// The host's socket is in its state directory, so the copy a sample runs needs a short path.
const live = `${tmpdir()}/cb-${Bun.hash(process.cwd()).toString(16).slice(0, 8)}`;
const world = {
  install: `${live}/install`,
  user: `${live}/install/user/workflows`,
  config: `${live}/install/user`,
  state: `${live}/state`,
  home: `${live}/home`,
  project: `${live}/project`,
};

Object.assign(Bun.env, {
  ...GIT_QUIET,
  // Where the fake herdr's socket goes.
  TMPDIR: live,
  HOME: world.home,
  HERDR_PLUGIN_ROOT: world.install,
  HERDR_PLUGIN_STATE_DIR: world.state,
  COLLIE_USER_DIR: world.config,
  COLLIE_CWD: world.project,
  COLLIE_HOST: JSON.stringify([process.execPath, `${root}src/main.ts`]),
  COLLIE_HOST_WATCH_PID: String(process.pid),
  HERDR_BIN_PATH: `${live}/herdr`,
  FAKE_HERDR_LOG: `${live}/herdr-calls.jsonl`,
  PATH: `${live}/harnesses:${Bun.env.PATH ?? ""}`,
});

const Fixture = Schema.fromJsonString(Schema.Struct({ runId: Schema.String }));
const Readings = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number));

/** `cp -a`, which keeps the sockets a stopped host and the fake herdr leave. */
const copy = (from: string, to: string) =>
  Effect.sync(() => Bun.spawnSync(["cp", "-a", from, to])).pipe(
    Effect.flatMap((ran) =>
      ran.exitCode === 0
        ? Effect.void
        : Effect.die(new Error(`cp ${from} ${to}: ${ran.stderr.toString()}`)),
    ),
  );

/** The host's CPU and read syscalls so far, and its memory, from /proc. */
const usageOf = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = (name: string) => Effect.orDie(fs.readFileString(`/proc/${pid}/${name}`));
    const stat = (yield* read("stat")).split(") ")[1]?.split(" ") ?? [];
    const io = yield* read("io");
    const status = yield* read("status");
    const field = (text: string, name: string) =>
      Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? Number.NaN);
    return {
      cpu_ms: (Number(stat[11]) + Number(stat[12])) * 10,
      syscr: field(io, "syscr"),
      rchar: field(io, "rchar"),
      peak_kb: field(status, "VmHWM"),
      rss_kb: field(status, "VmRSS"),
    };
  });

const mean = (xs: ReadonlyArray<number>) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const rank = (xs: ReadonlyArray<number>, q: number) =>
  [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1] ?? Number.NaN;

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const began = yield* Clock.currentTimeMillis;
    yield* Effect.orDie(effect);
    return (yield* Clock.currentTimeMillis) - began;
  });

const prepare = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(kept, { recursive: true, force: true });
  for (const dir of [
    world.user,
    `${world.install}/workflows`,
    world.state,
    world.home,
    world.project,
  ])
    yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${world.home}/.bunfig.toml`, testBunfig);
  Bun.spawnSync(["git", "init", "-q"], { cwd: world.project });
  yield* save(world.user, MODULES);
  yield* fs.makeDirectory(`${live}/harnesses`);
  // Never the operator's claude.
  yield* fs.writeFileString(
    `${live}/harnesses/claude`,
    `#!/bin/sh\n[ "$1" = --help ] && echo "  --autocompact <auto|tokens>" && exit 0\nexit 1\n`,
    { mode: 0o755 },
  );
  yield* writeFakeHerdrShim(`${live}/herdr`);
  const client = yield* connect(world.state);
  const crypto = yield* Crypto.Crypto;
  const runIds = yield* Effect.forEach(
    Array.from({ length: RUNS }, (_, at) => at),
    (at) =>
      Effect.gen(function* () {
        const own = yield* connect(world.state);
        const request = yield* crypto.randomUUIDv4;
        const started = yield* own.start({
          project: world.project,
          id: "hello",
          request,
          input: { name: `n${at}` },
        });
        return started.runId;
      }).pipe(Effect.scoped),
    { concurrency: 16 },
  );
  for (;;) {
    const views = yield* client.runs({ task: null });
    if (views.filter((view) => view.status.status === "complete").length >= RUNS) break;
    yield* Effect.sleep("1 second");
  }
  yield* stopHost(world.state);
  yield* fs.makeDirectory(kept, { recursive: true });
  yield* copy(live, `${kept}/world`);
  yield* fs.writeFileString(
    `${kept}/fixture.json`,
    Schema.encodeSync(Fixture)({ runId: runIds.at(-1) ?? "" }),
  );
}).pipe(Effect.orDie, Effect.ensuring(stopHost(world.state)));

const sample = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { runId } = yield* Schema.decodeUnknownEffect(Fixture)(
    yield* fs.readFileString(`${kept}/fixture.json`),
  );
  yield* copy(`${kept}/world`, live);
  yield* writeFakeHerdrShim(`${live}/herdr`);
  // A host that has just started: its first board and its first answer.
  const cold_read_ms = yield* timed(
    connect(world.state).pipe(
      Effect.flatMap((client) => client.read({ tool: "collie_run", input: { run: runId } })),
    ),
  );
  const owner = yield* ownerOf(world.state);
  if (owner === null) return yield* Effect.die(new Error("no host owns the fixture's state"));
  const client = yield* connect(world.state);
  yield* Effect.sleep("10 seconds");
  const idleFrom = yield* usageOf(owner.pid);
  yield* Effect.sleep(`${IDLE_SECONDS} seconds`);
  const idleTo = yield* usageOf(owner.pid);
  const took: Record<"read" | "shown" | "runs" | "progress", Array<number>> = {
    read: [],
    shown: [],
    runs: [],
    progress: [],
  };
  const readSyscr: Array<number> = [];
  for (let round = 0; round < ROUNDS; round++) {
    const before = yield* usageOf(owner.pid);
    took.read.push(yield* timed(client.read({ tool: "collie_run", input: { run: runId } })));
    readSyscr.push((yield* usageOf(owner.pid)).syscr - before.syscr);
    took.shown.push(yield* timed(client.shown({ runId })));
    took.runs.push(yield* timed(client.runs({ task: null })));
    took.progress.push(yield* timed(client.progress({ runId })));
  }
  const after = yield* usageOf(owner.pid);
  return {
    cold_read_ms,
    idle_cpu_ms_per_s: (idleTo.cpu_ms - idleFrom.cpu_ms) / IDLE_SECONDS,
    idle_syscr_per_s: (idleTo.syscr - idleFrom.syscr) / IDLE_SECONDS,
    idle_rchar_kb_per_s: (idleTo.rchar - idleFrom.rchar) / 1024 / IDLE_SECONDS,
    read_mean_ms: mean(took.read),
    read_p50_ms: rank(took.read, 0.5),
    read_p95_ms: rank(took.read, 0.95),
    read_max_ms: Math.max(...took.read),
    read_syscr_mean: mean(readSyscr),
    shown_mean_ms: mean(took.shown),
    runs_mean_ms: mean(took.runs),
    progress_mean_ms: mean(took.progress),
    progress_max_ms: Math.max(...took.progress),
    host_peak_kb: after.peak_kb,
    host_rss_kb: after.rss_kb,
  };
}).pipe(Effect.orDie, Effect.ensuring(stopHost(world.state)));

await runEffect(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const clear = fs.remove(live, { recursive: true, force: true }).pipe(Effect.orDie);
    yield* clear;
    if (process.argv[2] === "prepare") yield* prepare.pipe(Effect.ensuring(clear));
    else
      yield* Console.log(Schema.encodeSync(Readings)(yield* sample.pipe(Effect.ensuring(clear))));
  }),
);
process.exit(0);
