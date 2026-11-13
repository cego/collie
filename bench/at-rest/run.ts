/* oxlint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-console-in-effect, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, effecttsgo/prefer-effect-string, effecttsgo/prefer-schema-over-json, no-restricted-globals, no-restricted-properties -- the benchmark's drivers speak to processes, files and /proc on their own terms, as record-open's do. */
// Linux /proc counts the host's work separately from this driver and its fake herdr.

import { Database } from "bun:sqlite";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { Deferred, Effect, Fiber, Schedule, Stream } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { RunView } from "../../src/engine";
import { connect, frontDoor, type HostClient, socketOf } from "../../src/host";
import { runEffect } from "../../test/support/effect";
import { stopHost } from "../../test/support/host";
import { filledSinceStart, measuring, refusal, userStateDir } from "../record-open/guards";
import type { Manifest } from "./fixture";
import { enterWorld, keptFixture, live, manifestPath, root, socket, userEnv, world } from "./world";
import { logArrivals, viewMismatches, type ViewCheck } from "./checks";
import { wakeDeadline, writerMarkers } from "./observations";
import { shiftDates, shiftHistory } from "./history-time";

const WARM = "10 seconds";
const WINDOW = "60 seconds";
const LISTINGS = 20;
const WAKE_SECONDS = 4;
const LATE = {
  listing_ms: 10_000,
  report_ms: 10_000,
  wake_ms: 3_000,
  record_ms: 5_000,
  door_ms: 500,
};
const heapFile = `${live}/host-heap.json`;
const ticksPerSecond = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString());
if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) throw new Error("cannot read CLK_TCK");
const tickMs = 1000 / ticksPerSecond;

const say = (line: string) => Effect.sync(() => console.error(line));

const threadsCpu = (pid: number) => {
  const cpu = { main: 0, worker: 0, other: 0 };
  for (const tid of readdirSync(`/proc/${pid}/task`))
    try {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ms = (Number(f[11]) + Number(f[12])) * tickMs;
      const comm = readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8").trim();
      if (tid === String(pid)) cpu.main += ms;
      else if (comm === "Worker") cpu.worker += ms;
      else cpu.other += ms;
    } catch {
      // A thread that ended takes its share with it; the process total below keeps it.
    }
  return cpu;
};
const usage = (pid: number) => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const io = Object.fromEntries(
    readFileSync(`/proc/${pid}/io`, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [key = "", value = ""] = line.split(": ");
        return [key, value];
      }),
  );
  const threads = threadsCpu(pid);
  return {
    // utime and stime are fields 14-15, cutime and cstime 16-17, minflt and cminflt 10-11.
    cpu_ms: (Number(f[11]) + Number(f[12])) * tickMs,
    // Mostly the fake herdr and git it spawns: a Bun script here, a native binary in use.
    children_cpu_ms: (Number(f[13]) + Number(f[14])) * tickMs,
    main_cpu_ms: threads.main,
    worker_cpu_ms: threads.worker,
    read_syscalls: Number(io.syscr),
    read_bytes: Number(io.rchar),
    minor_faults: Number(f[7]) + Number(f[8]),
  };
};
type Usage = ReturnType<typeof usage>;
const delta = (after: Usage, before: Usage) =>
  Object.fromEntries(
    Object.entries(after).map(([key, value], at) => [key, value - Object.values(before)[at]!]),
  );
const statusKb = (pid: number, field: "VmRSS" | "VmHWM") =>
  Number(new RegExp(`${field}:\\s+(\\d+)`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
const load1 = () => Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);

const hostHeap = (pid: number) =>
  Effect.gen(function* () {
    rmSync(heapFile, { force: true });
    process.kill(pid, "SIGUSR2");
    for (let waited = 0; !existsSync(heapFile); waited += 100) {
      if (waited > 30_000) return yield* Effect.die(new Error("the host wrote no heap reading"));
      yield* Effect.sleep("100 millis");
    }
    const read: { heap_kb: number; objects: number } = JSON.parse(readFileSync(heapFile, "utf8"));
    return { host_heap_kb: read.heap_kb, host_heap_objects: read.objects };
  });

const nearest = (samples: ReadonlyArray<number>, q: number) =>
  [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * samples.length) - 1)] ?? -1;

const hostPid = () => {
  const log = readFileSync(`${world.state}/host.log`, "utf8");
  const found = [...log.matchAll(/host started, pid (\d+)/g)].at(-1);
  if (found === undefined) throw new Error("the host logged no pid");
  return Number(found[1]);
};

const herdrCalls = () => {
  try {
    return readFileSync(Bun.env.FAKE_HERDR_LOG!, "utf8").split("\n").length - 1;
  } catch {
    return 0;
  }
};

const mismatchesOf = (views: ReadonlyArray<RunView>, manifest: Manifest) => {
  const expected: ViewCheck[] = [
    ...manifest.settled.map((runId) => ({
      runId,
      status: "complete",
      report: null,
      delivery: null,
      closed: false,
      wakes: null,
    })),
    ...Object.entries(manifest.reported).map(([runId, report]) => ({
      runId,
      status: "complete",
      report,
      delivery: "undelivered",
      closed: true,
      wakes: null,
    })),
    ...[...manifest.owing, ...manifest.asking, ...manifest.sleeping].map((runId) => ({
      runId,
      status: "suspended",
      report: null,
      delivery: null,
      closed: false,
      wakes: manifest.wakes[runId] ?? null,
    })),
  ];
  return viewMismatches(
    views.map((view) => ({
      runId: view.runId,
      status: view.status.status,
      report: view.report?.at ?? null,
      delivery: view.report?.state ?? null,
      closed: view.report?.closed ?? false,
      wakes: view.wakes ?? null,
    })),
    expected,
  );
};

const doorProbe = (into: number[], errors: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(world.state);
      for (;;) {
        const began = performance.now();
        yield* client.identity();
        into.push(performance.now() - began);
        yield* Effect.sleep("100 millis");
      }
    }),
  ).pipe(Effect.catchCause((cause) => Effect.sync(() => void errors.push(String(cause)))));

interface RecordFrame {
  at: number;
  text: string;
  added: number | null;
}
const holdRecord = (runId: string, into: RecordFrame[], errors: string[]) =>
  Effect.gen(function* () {
    const door = yield* frontDoor(socketOf(world.state));
    const ready = yield* Deferred.make<void>();
    const began = performance.now();
    yield* Effect.forkScoped(
      Stream.runForEach(
        door.runDetail({ runId, tail: true, pages: 1, refreshMr: false, parts: true }),
        (frame) =>
          Effect.gen(function* () {
            if (frame === null || "_tag" in frame) return;
            into.push({
              at: Date.now(),
              text: frame.tail?._tag === "Text" ? frame.tail.text : "",
              added: frame.diff?.files.find((file) => file.path === "sample.ts")?.added ?? null,
            });
            if (frame.pending?.length === 0) yield* Deferred.succeed(ready, undefined);
          }),
      ).pipe(Effect.catchCause((cause) => Effect.sync(() => void errors.push(String(cause))))),
    );
    yield* Deferred.await(ready).pipe(Effect.timeout("30 seconds"));
    return Math.round(performance.now() - began);
  });

const sample = (manifest: Manifest) =>
  Effect.gen(function* () {
    const numbers: Record<string, number> = {};
    const errors: string[] = [];
    const before = performance.now();
    const client = yield* connect(world.state);
    yield* Effect.sync(() => {
      try {
        return filledSinceStart(readFileSync(`${world.state}/host.log`, "utf8"));
      } catch {
        return false;
      }
    }).pipe(
      Effect.repeat({ until: (filled) => filled, schedule: Schedule.spaced("50 millis") }),
      Effect.timeout("3 minutes"),
    );
    numbers.host_start_ms = Math.round(performance.now() - before);
    const built = [
      ...readFileSync(`${world.state}/host.log`, "utf8").matchAll(
        /the Run model holds \d+ Runs, filled in (\d+) ms/g,
      ),
    ].at(-1);
    if (built === undefined)
      return yield* Effect.die(new Error("the first board build has no timing"));
    numbers.board_build_ms = Number(built[1]);
    const host = hostPid();

    const door = yield* frontDoor(socketOf(world.state));
    let boardFrames = 0;
    const boardReady = yield* Deferred.make<void>();
    const boardBegan = performance.now();
    yield* Effect.forkScoped(
      Stream.runForEach(door.board(), (frame) =>
        Effect.gen(function* () {
          boardFrames++;
          if (frame._tag === "Snapshot") yield* Deferred.succeed(boardReady, undefined);
        }),
      ).pipe(Effect.catchCause((cause) => Effect.sync(() => void errors.push(String(cause))))),
    );
    yield* Deferred.await(boardReady).pipe(Effect.timeout("3 minutes"));
    numbers.board_ready_ms = Math.round(performance.now() - boardBegan);
    const settledFrames: RecordFrame[] = [];
    numbers.record_open_ms = yield* holdRecord(manifest.settled[0]!, settledFrames, errors);
    yield* Effect.forkScoped(
      Stream.runDrain(client.watch({ runId: manifest.asking[0]! })).pipe(
        Effect.catchCause((cause) => Effect.sync(() => void errors.push(String(cause)))),
      ),
    );
    yield* Effect.sleep(WARM);

    yield* say(`idle for ${WINDOW}`);
    const idleBegan = performance.now();
    const idle = {
      board: boardFrames,
      record: settledFrames.length,
      herdr: herdrCalls(),
      at: usage(host),
    };
    yield* Effect.sleep(WINDOW);
    const idleUsed = delta(usage(host), idle.at);
    numbers.idle_elapsed_ms = Math.round(performance.now() - idleBegan);
    for (const [key, value] of Object.entries(idleUsed)) numbers[`host_idle_${key}`] = value;
    numbers.host_idle_board_frames = boardFrames - idle.board;
    numbers.host_idle_record_frames = settledFrames.length - idle.record;
    numbers.host_idle_herdr_calls = herdrCalls() - idle.herdr;
    numbers.machine_idle_load1 = load1();
    numbers.host_rss_kb = statusKb(host, "VmRSS");
    Object.assign(numbers, yield* hostHeap(host));

    const listed: number[] = [];
    let views: ReadonlyArray<RunView> = [];
    for (let at = 0; at < LISTINGS; at++) {
      const began = performance.now();
      views = yield* client.runs({ task: null });
      listed.push(performance.now() - began);
    }
    numbers.runs_p50_ms = Math.round(nearest(listed, 0.5));
    numbers.runs_p95_ms = Math.round(nearest(listed, 0.95));
    numbers.runs_max_ms = Math.round(nearest(listed, 1));
    numbers.listings_slow = listed.filter((ms) => ms > LATE.listing_ms).length;
    const wrong = mismatchesOf(views, manifest);
    numbers.mismatches = wrong.length;
    for (const one of wrong.slice(0, 5)) yield* say(`mismatch: ${one}`);

    const readTimes: number[] = [];
    for (let at = 0; at < 10; at++) {
      const began = performance.now();
      const read = yield* client.read({ tool: "collie_run", input: { run: manifest.settled[0]! } });
      if (!JSON.stringify(read).includes(manifest.settled[0]!))
        errors.push("agent read lost the requested Run");
      readTimes.push(performance.now() - began);
    }
    numbers.agent_read_p95_ms = Math.round(nearest(readTimes, 0.95));
    const verifyBegan = performance.now();
    const verified = yield* client
      .verify({
        runId: manifest.settled[0]!,
        name: "fixture-diff",
        executable: "git",
        argv: ["diff", "--check"],
        expect: "pass",
      })
      .pipe(Stream.runCollect);
    numbers.verify_ms = Math.round(performance.now() - verifyBegan);
    if (!verified.some((event) => event._tag === "Result" && event.verification.result === "pass"))
      errors.push("verification did not pass");
    const answerBegan = performance.now();
    yield* client.answer({
      runId: manifest.asking[1]!,
      decision: null,
      value: "answered",
      request: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
    });
    yield* client.run({ runId: manifest.asking[1]! }).pipe(
      Effect.repeat({
        until: (view) => view?.status.status === "complete",
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeout("30 seconds"),
    );
    numbers.answer_ms = Math.round(performance.now() - answerBegan);

    yield* say(`active for ${WINDOW}: a Run writing with its record open, a report owed, wakes`);
    const active = yield* activeWindow(client, host, errors);
    for (const [key, value] of Object.entries(active)) numbers[key] = value;
    numbers.host_cpu_ms = numbers.host_idle_cpu_ms! + numbers.host_active_cpu_ms!;
    numbers.host_read_syscalls =
      numbers.host_idle_read_syscalls! + numbers.host_active_read_syscalls!;
    numbers.host_hwm_kb = statusKb(host, "VmHWM");
    numbers.stream_errors = errors.length;
    for (const error of errors) yield* say(error);
    yield* say(`sample diagnostics: ${JSON.stringify(numbers)}`);
    for (const [name, value] of Object.entries(numbers))
      if (!Number.isFinite(value) || value < 0)
        return yield* Effect.die(new Error(`invalid metric ${name}`));
    for (const name of [
      "mismatches",
      "stream_errors",
      "active_log_missing",
      "active_diff_missing",
      "record_missing",
      "wakes_missing",
    ])
      if (numbers[name] !== 0) return yield* Effect.die(new Error(`${name}: ${numbers[name]}`));
    return numbers;
  });

const activeWindow = (client: HostClient, host: number, errors: string[]) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const start = (
      id: string,
      input: Record<string, string>,
      options: Record<string, string> = {},
    ) =>
      Effect.flatMap(random.uuidV4(), (request) =>
        client.start({ project: world.project, id, request, input, options }),
      ).pipe(Effect.map(({ runId }) => runId));
    const doorLag: number[] = [];
    const probe = yield* Effect.forkScoped(doorProbe(doorLag, errors));
    const from = usage(host);
    const began = performance.now();

    const writing = yield* start("bench-active", {}, { workspace: world.project, branch: "bench" });
    const frames: RecordFrame[] = [];
    const activeOpen = yield* holdRecord(writing, frames, errors);

    const reportStarted = performance.now();
    const reporting = yield* start("bench-report", { on: "done", steps: "6" });
    const reportFiber = yield* Effect.forkScoped(
      client.run({ runId: reporting }).pipe(
        Effect.repeat({
          until: (view) => view?.report?.closed === true,
          schedule: Schedule.spaced("250 millis"),
        }),
        Effect.map((view) => {
          if (view?.status.status !== "complete" || view.report?.state !== "undelivered")
            errors.push("report changed the outcome or delivery state");
          return performance.now() - reportStarted;
        }),
        Effect.timeout("60 seconds"),
        Effect.orElseSucceed(() => 60_000),
      ),
    );

    const woke = new Map<string, number>();
    const wakers = yield* Effect.forEach([0, 1], () =>
      Effect.gen(function* () {
        const run = yield* start("bench-wait", { on: "sleep", seconds: String(WAKE_SECONDS) });
        yield* Effect.forkScoped(
          Stream.runForEachWhile(client.watch({ runId: run }), (view) =>
            Effect.sync(() => {
              if (view?.status.status !== "complete") return true;
              woke.set(run, Date.now());
              return false;
            }),
          ).pipe(Effect.ignore),
        );
        return run;
      }),
    );

    yield* Effect.sleep(Math.max(0, 60_000 - (performance.now() - began)));
    const written = yield* writerMarkers(
      client.run({ runId: writing }).pipe(
        Effect.repeat({
          until: (view) => view?.status.status === "complete",
          schedule: Schedule.spaced("250 millis"),
        }),
      ),
      `${world.state}/runs/${writing}/log.txt`,
    );
    const used = delta(usage(host), from);
    const activeElapsed = Math.round(performance.now() - began);
    yield* Fiber.interrupt(probe);
    const reportMs = yield* Fiber.join(reportFiber);
    yield* Effect.sleep(LATE.record_ms);
    const db = new Database(`${world.state}/host.db`, { readonly: true });
    let wakeLag: number[];
    try {
      wakeLag = wakers.map((run) => {
        const seen = woke.get(run);
        return seen === undefined ? 60_000 : seen - wakeDeadline(db, run);
      });
    } finally {
      db.close();
    }

    const arrivals = logArrivals(frames);
    const recordLag = written.flatMap(({ sequence, at }) => {
      const next = arrivals.get(sequence);
      return next === undefined ? [] : [next - at];
    });
    const steps = written.length;
    return {
      ...Object.fromEntries(
        Object.entries(used).map(([key, value]) => [`host_active_${key}`, value]),
      ),
      machine_active_load1: load1(),
      active_elapsed_ms: activeElapsed,
      active_record_frames: frames.length,
      active_record_open_ms: activeOpen,
      active_log_missing: 29 - steps,
      active_diff_missing: [2, 3].filter((added) => !frames.some((frame) => frame.added === added))
        .length,
      record_fresh_p95_ms: Math.round(nearest(recordLag, 0.95)),
      record_missing: steps - recordLag.length,
      record_late: steps - recordLag.filter((ms) => ms <= LATE.record_ms).length,
      report_fresh_ms: Math.round(reportMs),
      report_late: reportMs > LATE.report_ms ? 1 : 0,
      wake_fresh_max_ms: Math.max(...wakeLag),
      wakes_late: wakeLag.filter((ms) => ms > LATE.wake_ms).length,
      wakes_missing: wakers.filter((run) => !woke.has(run)).length,
      door_lag_p99_ms: Math.round(nearest(doorLag, 0.99)),
      door_lag_slow: doorLag.filter((ms) => ms > LATE.door_ms).length,
    };
  });

const refused = await runEffect(
  refusal({ state: world.state, socket }, { home: homedir(), env: userEnv }),
);
if (refused !== null) {
  console.error(refused);
  process.exit(2);
}
if (!existsSync(manifestPath)) {
  console.error(`no fixture at ${keptFixture}: run bench/at-rest/prepare.ts first`);
  process.exit(2);
}
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const numbers = await runEffect(
  measuring(
    `${userStateDir(homedir(), userEnv)}/measurements/machine.lock`,
    say,
    Effect.gen(function* () {
      rmSync(live, { recursive: true, force: true });
      cpSync(keptFixture, live, { recursive: true });
      const source: { created: string } = JSON.parse(
        readFileSync(`${root}bench/at-rest/history.json`, "utf8"),
      );
      const shift = Date.now() - 12 * 60 * 60 * 1000 - Date.parse(source.created);
      shiftHistory(live, shift);
      const history: Manifest = JSON.parse(shiftDates(JSON.stringify(manifest), shift));
      cpSync(
        `${root}bench/at-rest/workflows/bench-active.workflow.ts`,
        `${world.user}/bench-active.workflow.ts`,
      );
      yield* enterWorld;
      Bun.env.COLLIE_HOST = JSON.stringify([
        process.execPath,
        "--preload",
        `${root}bench/at-rest/heap-preload.ts`,
        `${root}src/main.ts`,
      ]);
      Bun.env.BENCH_HEAP_FILE = heapFile;
      yield* Effect.addFinalizer(() =>
        stopHost(world.state).pipe(
          Effect.andThen(Effect.sync(() => rmSync(live, { recursive: true, force: true }))),
        ),
      );
      return yield* sample(history);
    }).pipe(Effect.timeout("10 minutes"), Effect.scoped, Effect.orDie),
  ),
);
console.error(JSON.stringify(numbers, null, 2));
console.log(JSON.stringify(numbers));
