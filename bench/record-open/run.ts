// Click to usable Flow in Desktop, end to end (docs/internals.md, Measuring a record open).
// Prints, as its last line, one JSON object of numbers for `collie measure`.

import { mkdirSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Effect, Fiber, FileSystem, Option, Schedule, Stream } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Flow } from "../../src/board-model";
import { connect, frontDoor, socketOf } from "../../src/host";
import type { PlatformServices } from "../../src/platform";
import { runEffect } from "../../test/support/effect";
import { stopHost } from "../../test/support/host";
import { openPage, type Page } from "./cdp";
import { differences, type Painted, paintedOf } from "./compare";
import { buildView, launchChrome, startDesktop, VIEW_PORT, viewUp, WINDOW } from "./desktop";
import { COUNTS, type Fixture, prepare } from "./fixture";
import { filledSinceStart, measuring, refusal, userStateDir } from "./guards";
import { barFailures, type CellSummary, summaryOf } from "./stats";
import { enterWorld, live, recordMarksFile, root, socket, userEnv, world } from "./world";

const LOCAL = [
  "first",
  "repeat",
  "rapid",
  "large",
  "old",
  "live",
  "checks",
  "desktop-cold",
  "host-cold",
  // Last: it adds Runs, which would change the board every cell after it reads.
  "storm",
] as const;
/** Cells timed over the host's front door, with no Desktop or Chrome started. */
const HOST_ONLY = ["first-host", "checks-host", "storm-host"] as const;
type DesktopCell = (typeof LOCAL)[number];
type Cell = DesktopCell | (typeof HOST_ONLY)[number];
const isHostOnly = (cell: Cell) => HOST_ONLY.some((one) => one === cell);
const isDesktopCell = (cell: Cell): cell is DesktopCell => !isHostOnly(cell);
/** What the last stdout line gives of each cell, for `collie measure`. */
const NUMBERS = ["p50", "p95", "max", "n", "failed"] as const satisfies ReadonlyArray<
  keyof CellSummary
>;

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cells: { type: "string", default: "local" },
    bar: { type: "string" },
    cdp: { type: "string" },
    chrome: { type: "string" },
    samples: { type: "string", default: "200" },
    warmup: { type: "string", default: "5" },
    runs: { type: "string", default: String(COUNTS.runs) },
    out: { type: "string" },
  },
});
const cells: ReadonlyArray<Cell> =
  flags.cells === "local"
    ? LOCAL
    : flags.cells.split(",").map((name) => {
        const cell = [...LOCAL, ...HOST_ONLY].find((one) => one === name);
        if (cell === undefined) throw new Error(`no cell ${name}`);
        return cell;
      });
const hostOnly = cells.every(isHostOnly);
if (!hostOnly && cells.some(isHostOnly)) {
  console.error(`${HOST_ONLY.join(", ")} runs with no Desktop attached: run it on its own`);
  process.exit(2);
}
const began = Date.now();
const SAMPLES = Number(flags.samples);
const WARMUP = Number(flags.warmup);
const out =
  flags.out ?? `${root}.scratch/record-open/${new Date().toISOString().replace(/:/g, "-")}`;
const say = (line: string) => Effect.sync(() => console.error(line));

const refused = await runEffect(
  refusal({ state: world.state, socket }, { home: homedir(), env: userEnv }),
);
if (refused !== null) {
  console.error(refused);
  process.exit(2);
}

interface Sample {
  readonly cell: Cell;
  readonly warmup: boolean;
  readonly run: string;
  readonly ms: number;
  readonly differences: ReadonlyArray<string>;
  readonly stale: boolean;
  readonly marks: Readonly<Record<string, number>>;
  readonly start: number;
}
interface Seen {
  readonly ms: number;
  readonly stale: boolean;
  readonly painted: Painted;
  readonly marks: Readonly<Record<string, number>>;
  readonly start: number;
  /** The page's time origin, in epoch milliseconds. */
  readonly origin: number;
}

/**
 * A trivial RPC every 50 ms, as a proxy for a host thread's event-loop lag: `identity` is the
 * door's, which reads records, and `registrations` the engine's.
 */
const lagProbe = (into: number[], on: "door" | "engine") =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(world.state);
      for (;;) {
        const began = performance.now();
        yield* on === "door" ? client.identity() : client.registrations();
        into.push(performance.now() - began);
        yield* Effect.sleep("50 millis");
      }
    }),
  ).pipe(
    // A host that restarts takes the connection with it.
    Effect.catchCause(() => Effect.sleep("100 millis")),
    Effect.forever,
  );

/** How many probes a cell's lag is judged over, so its p99 is not its worst probe. */
const LAG_PROBES = 2000;

/**
 * The host's lag while `timed` runs and, after it, while `more` keeps the cell's load on until
 * the window holds `LAG_PROBES` probes.
 */
const lagOver = <R>(
  timed: Effect.Effect<void, never, R>,
  more: (at: number) => Effect.Effect<unknown, never, R>,
) =>
  Effect.gen(function* () {
    const lag: number[] = [];
    const engine: number[] = [];
    const probe = yield* Effect.forkChild(lagProbe(lag, "door"));
    const engineProbe = yield* Effect.forkChild(lagProbe(engine, "engine"));
    yield* timed;
    for (let at = 0; lag.length < LAG_PROBES; at++) yield* more(at);
    yield* Fiber.interrupt(probe);
    yield* Fiber.interrupt(engineProbe);
    return {
      lag_p99_ms: nearest(lag, 0.99),
      lag_max_ms: nearest(lag, 1),
      lag_probes: lag.length,
      engine_lag_p99_ms: nearest(engine, 0.99),
      engine_lag_max_ms: nearest(engine, 1),
      engine_lag_probes: engine.length,
    };
  });

/** Until the host's Run model says it has filled. */
const modelFilled = Effect.suspend(() =>
  Effect.sync(() => {
    try {
      return filledSinceStart(readFileSync(`${world.state}/host.log`, "utf8"));
    } catch {
      return false;
    }
  }),
).pipe(Effect.repeat({ until: (filled) => filled, schedule: Schedule.spaced("100 millis") }));

/** What a cell runs beside its samples, ended when they are. */
const besideOf = (
  fixture: Fixture,
): Partial<Record<Cell, Effect.Effect<void, never, PlatformServices>>> => {
  const beside = {
    // Four Checks on a live Run, each busy until its flag is gone.
    checks: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const flag = `${live}/checks-running`;
      yield* fs.writeFileString(flag, "").pipe(Effect.orDie);
      const client = yield* connect(world.state).pipe(Effect.orDie);
      yield* Effect.forEach(
        [1, 2, 3, 4],
        (n) =>
          Stream.runDrain(
            client.verify({
              runId: fixture.live[0]!,
              name: `busy ${n}`,
              executable: "/bin/sh",
              argv: [
                "-c",
                `i=0; while [ -e ${flag} ]; do i=$((i+1)); [ $((i % 5000)) -eq 0 ] && echo "line $i"; done`,
              ],
              cwd: world.project,
              expect: "pass",
            }),
          ).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.ensuring(fs.remove(flag).pipe(Effect.ignore)));
    }).pipe(Effect.scoped),
    // A Run started every 200 ms, each a board change.
    storm: Effect.gen(function* () {
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const random = yield* SecureRandom.SecureRandom;
      for (;;) {
        yield* client
          .start({
            project: world.project,
            id: "bench-steps",
            request: yield* random.uuidV4(),
            input: { steps: "6", live: "no" },
          })
          .pipe(Effect.ignore);
        yield* Effect.sleep("200 millis");
      }
    }).pipe(Effect.scoped, Effect.orDie),
  };
  return { ...beside, "checks-host": beside.checks, "storm-host": beside.storm };
};

/** The host's, the bridge's and Desktop's first marks for `run` from `after` on, in the page's time. */
const processMarks = (run: string, origin: number, after: number) => {
  const marks: Record<string, number> = {};
  let lines: ReadonlyArray<string> = [];
  try {
    lines = readFileSync(recordMarksFile, "utf8").split("\n");
  } catch {
    return marks;
  }
  for (const line of lines) {
    const [epochMs, at, id] = line.split(" ");
    const time = Number(epochMs) - origin;
    // Their clock gives whole milliseconds.
    if (id !== run || at === undefined || at in marks || time < after - 1) continue;
    marks[at] = time;
  }
  return marks;
};

/** The longest a sample waits for its Flow before it is counted as never painted. */
const NEVER_MS = 60_000;

const body = (
  fixture: Fixture,
  windowOf: () => Promise<Page>,
  chrome: { version: string; flags: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const ev = <A>(expression: string, awaitPromise = false) =>
      Effect.promise(() =>
        page.send<{ result: { value: A } }>("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise,
        }),
      ).pipe(Effect.map(({ result }) => result.value));
    const until = (expression: string, limitMs = NEVER_MS) =>
      Effect.gen(function* () {
        for (let waited = 0; waited < limitMs; waited += 50) {
          if (yield* ev<boolean>(expression)) return;
          yield* Effect.sleep("50 millis");
        }
        const shown = yield* ev<string>(
          `location.href + "\\n" + (document.body?.innerText ?? "").slice(0, 2000)`,
        );
        return yield* Effect.die(
          new Error(`waited ${limitMs} ms for ${expression}; the window showed:\n${shown}`),
        );
      });
    /** The board painted with every card, the folded ones unfolded. */
    const boardSettled = Effect.gen(function* () {
      yield* until("window.__bench?.board() === true");
      let before = -1;
      for (;;) {
        const count = yield* ev<number>(
          `(() => { for (const d of document.querySelectorAll('[data-testid="finished"] > details, [data-testid="waiting"] > details')) d.open = true; return document.querySelectorAll('[data-card]').length })()`,
        );
        if (count === before) return;
        before = count;
        yield* Effect.sleep("1 second");
      }
    });
    const press = (key: string, code: number) =>
      Effect.promise(async () => {
        for (const type of ["keyDown", "keyUp"])
          await page.send("Input.dispatchKeyEvent", {
            type,
            key,
            code: key,
            windowsVirtualKeyCode: code,
          });
      });
    const close = Effect.gen(function* () {
      if (yield* ev<boolean>("window.__bench.board()")) return;
      yield* press("Escape", 27);
      yield* until("window.__bench.board()");
    });
    /** A real click on the card's name, where it is on screen. */
    const clickName = (run: string) =>
      Effect.gen(function* () {
        const at = yield* ev<{ x: number; y: number } | null>(
          `(() => { const name = document.querySelector('[data-testid="card-${run}"] [data-testid="name"]'); if (!name) return null; name.scrollIntoView({ block: "center" }); const box = name.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
        );
        if (at === null) return yield* Effect.die(new Error(`no card for ${run} on the board`));
        yield* Effect.promise(async () => {
          await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
          await page.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...at,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          await page.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...at,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
        });
      });
    const cardOf = (run: string) =>
      ev<string>(
        `document.querySelector('[data-testid="card-${run}"]')?.getAttribute("data-card") ?? ""`,
      );
    const expect = (run: string) =>
      Effect.flatMap(cardOf(run), (card) =>
        ev(`window.__bench.expect(${JSON.stringify(card)}, ${JSON.stringify(run)})`),
      );
    const seen = ev<Seen | null>(
      `Promise.race([window.__benchSample, new Promise((done) => setTimeout(() => done(null), ${NEVER_MS}))])`,
      true,
    );

    const hostFlow = (run: string) =>
      Effect.scoped(
        Effect.flatMap(connect(world.state), (client) =>
          Stream.runHead(client.runDetail({ runId: run, tail: true, pages: 1, refreshMr: false })),
        ),
      ).pipe(
        Effect.map((head) => {
          const one = Option.getOrNull(head);
          // A request without `held` is never answered `Unchanged`.
          return one !== null && "flow" in one ? (one.flow ?? null) : null;
        }),
        Effect.orElseSucceed((): Flow | null => null),
      );
    /** How the painted Flow differs from the host's, read after the paint; a live Run gets a second read. */
    const judge = (run: string, painted: Painted) =>
      Effect.gen(function* () {
        const compare = (shown: Painted, flow: Flow | null) =>
          flow === null ? ["the host gave no Flow"] : differences(shown, paintedOf(flow, "local"));
        const first = compare(painted, yield* hostFlow(run));
        if (first.length === 0 || !fixture.live.includes(run)) return first;
        yield* Effect.sleep("500 millis");
        return compare(yield* ev<Painted>("window.__bench.painted()"), yield* hostFlow(run));
      });

    const timedOpen = (cell: Cell, warmup: boolean, run: string) =>
      Effect.gen(function* () {
        yield* expect(run);
        yield* clickName(run);
        const shown = yield* seen;
        const sample: Sample =
          shown === null
            ? {
                cell,
                warmup,
                run,
                ms: NEVER_MS,
                differences: ["never painted"],
                stale: false,
                marks: {},
                start: 0,
              }
            : {
                cell,
                warmup,
                run,
                ms: shown.ms,
                stale: shown.stale,
                differences: [
                  ...(shown.stale ? ["another Run's Flow was shown after the click"] : []),
                  ...(yield* judge(run, shown.painted)),
                ],
                marks: {
                  ...shown.marks,
                  ...processMarks(run, shown.origin, shown.marks["record:mounted"] ?? shown.start),
                },
                start: shown.start,
              };
        yield* close;
        return sample;
      });

    const cycle = (pool: ReadonlyArray<string>) => (at: number) => pool[at % pool.length]!;
    const settled = cycle(fixture.settled);
    const opens: Record<
      DesktopCell,
      (warmup: boolean, at: number) => Effect.Effect<Sample, never, PlatformServices>
    > = {
      first: (warmup, at) => timedOpen("first", warmup, settled(at)),
      repeat: (warmup, at) =>
        Effect.flatMap(timedOpen("repeat", true, settled(at + 1)), () =>
          timedOpen("repeat", warmup, settled(at + 1)),
        ),
      rapid: (warmup, at) =>
        Effect.gen(function* () {
          const switched = Array.from({ length: 10 }, (_, i) => settled(at * 10 + i));
          for (const run of switched.slice(0, -1)) {
            const began = Date.now();
            yield* close;
            yield* clickName(run);
            yield* until("!window.__bench.board()");
            yield* Effect.sleep(Math.max(0, 100 - (Date.now() - began)));
          }
          yield* close;
          return yield* timedOpen("rapid", warmup, switched.at(-1)!);
        }),
      large: (warmup, at) => timedOpen("large", warmup, cycle(fixture.large)(at)),
      old: (warmup, at) => timedOpen("old", warmup, cycle(fixture.old)(at)),
      live: (warmup, at) => timedOpen("live", warmup, cycle(fixture.live)(at)),
      checks: (warmup, at) => timedOpen("checks", warmup, settled(at)),
      storm: (warmup, at) => timedOpen("storm", warmup, settled(at)),
      "desktop-cold": (warmup, at) =>
        Effect.gen(function* () {
          desktop.kill();
          yield* Effect.promise(() => desktop.exited);
          desktop = startDesktop();
          yield* Effect.promise(viewUp);
          yield* Effect.promise(() => page.close());
          page = yield* Effect.promise(windowOf);
          yield* boardSettled;
          // ponytail: in a tab's first seconds Chrome gives a card's button the click's pointer
          // events but not its mouse events or the click; why is not known.
          yield* Effect.sleep("3 seconds");
          return yield* timedOpen("desktop-cold", warmup, settled(at));
        }),
      "host-cold": (warmup, at) =>
        Effect.gen(function* () {
          yield* stopHost(world.state);
          const started = performance.now();
          yield* Effect.scoped(connect(world.state));
          yield* boardSettled;
          const sample = yield* timedOpen("host-cold", warmup, settled(at));
          // Host start to the record painted, as the host-start criterion reads it.
          return {
            ...sample,
            marks: { ...sample.marks, "host:started-to-painted": performance.now() - started },
          };
        }).pipe(Effect.orDie),
    };

    let desktop = startDesktop();
    yield* Effect.addFinalizer(() => Effect.sync(() => desktop.kill()));
    yield* Effect.promise(viewUp);
    let page = yield* Effect.promise(windowOf);
    yield* Effect.addFinalizer(() => Effect.promise(() => page.close()));
    yield* boardSettled;

    mkdirSync(out, { recursive: true });
    const raw = `${out}/samples.jsonl`;
    const summaries: Summaries = {};
    const beside = besideOf(fixture);
    for (const cell of cells.filter(isDesktopCell)) {
      yield* say(`${cell}: ${WARMUP} warm-up and ${SAMPLES} timed opens`);
      const fibers = beside[cell] === undefined ? [] : [yield* Effect.forkChild(beside[cell])];
      const samples: Sample[] = [];
      const sampled = (at: number) =>
        Effect.map(opens[cell](at < WARMUP, at), (sample) => {
          appendFileSync(raw, `${JSON.stringify(sample)}\n`);
          if (!sample.warmup) samples.push(sample);
        });
      for (let at = 0; at < WARMUP; at++) yield* sampled(at);
      const lag = yield* lagOver(
        Effect.gen(function* () {
          for (let at = WARMUP; at < WARMUP + SAMPLES; at++) yield* sampled(at);
        }),
        (at) => opens[cell](true, WARMUP + (at % SAMPLES)),
      );
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
      summaries[cell] = {
        ...summaryOf(
          samples.map((sample) => sample.ms),
          samples.filter((sample) => sample.differences.length > 0).length,
        ),
        warmup: WARMUP,
        stages: stagesOf(samples),
        ...lag,
        ...startedToPainted(samples),
      };
      yield* say(`${cell}: ${JSON.stringify(summaries[cell])}`);
    }

    return yield* written(fixture, summaries, {
      ...chrome,
      headless: true,
      software_rendered: true,
      window: WINDOW,
    });
  });

type Summaries = Record<
  string,
  CellSummary & {
    readonly warmup: number;
    readonly stages: ReturnType<typeof stagesOf>;
    readonly lag_p99_ms: number | null;
    readonly lag_max_ms: number | null;
    readonly lag_probes: number;
    readonly engine_lag_p99_ms: number | null;
    readonly engine_lag_max_ms: number | null;
    readonly engine_lag_probes: number;
  }
>;

/** Writes the run's summary, says what went over the bar, and answers how many did. */
/** The Chrome a Desktop cell was timed in, as the summary records it. */
interface Browser {
  readonly version: string;
  readonly flags: ReadonlyArray<string>;
  readonly headless: true;
  readonly software_rendered: true;
  readonly window: typeof WINDOW;
}

const written = (fixture: Fixture, summaries: Summaries, browser: Browser | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bar = flags.bar === undefined ? null : Number(flags.bar);
    const failures = bar === null ? [] : barFailures(summaries, bar);
    const summary = {
      tree: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim(),
      fixture: {
        runs: fixture.runs,
        large: fixture.large.length,
        large_steps: 220,
        old: fixture.old.length,
        old_days: 40,
        live: fixture.live.length,
      },
      samples_per_cell: SAMPLES,
      warmup_per_cell: WARMUP,
      wall_s: Math.round((Date.now() - began) / 1000),
      ...(SAMPLES < 200 && {
        full_matrix:
          "The 200-open matrix is run on the delivered tree by ticket 07; fewer opens suffice where every open is seconds over the bar.",
      }),
      ...(browser === null
        ? { note: "Timed over the host's front door, with no Desktop attached." }
        : {
            chrome: browser,
            vue_prod_devtools: true,
            note: "Chrome numbers from a headless, software-rendered Chrome on a build with Vue's production devtools hooks on; not native Desktop numbers.",
          }),
      cells: summaries,
      bar,
      failures,
    };
    yield* fs
      .writeFileString(`${out}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`)
      .pipe(Effect.orDie);
    yield* say(`samples and summary in ${out}`);
    for (const failure of failures) yield* say(`over the bar: ${failure}`);
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(summaries).flatMap(([cell, one]) =>
            NUMBERS.map((key) => [`${cell.replace("-", "_")}_local_${key}`, one[key]]),
          ),
        ),
      ),
    );
    return failures.length;
  });

/** The record's first frame over the front door: request sent to first value received. */
const hostBody = (fixture: Fixture) =>
  Effect.gen(function* () {
    // A client starts the host; the front door only reaches one.
    yield* Effect.scoped(connect(world.state));
    const door = yield* frontDoor(socketOf(world.state));
    mkdirSync(out, { recursive: true });
    const raw = `${out}/samples.jsonl`;
    const summaries: Summaries = {};
    const opened = new Set<string>();
    for (const cell of cells.filter(isHostOnly)) {
      yield* say(`${cell}: ${WARMUP} warm-up and ${SAMPLES} timed opens`);
      yield* modelFilled;
      const fresh = fixture.settled.filter((run) => !opened.has(run));
      if (fresh.length < WARMUP + SAMPLES)
        return yield* Effect.die(
          new Error(`${fresh.length} settled Runs leave too few first opens for ${cell}`),
        );
      const samples: Sample[] = [];
      const firstFrame = (run: string) =>
        door
          .runDetail({ runId: run, tail: true, pages: 1, refreshMr: false, parts: true })
          .pipe(Stream.runHead, Effect.orDie);
      const sampled = (at: number, run: string) =>
        Effect.gen(function* () {
          opened.add(run);
          const start = performance.now();
          const head = yield* firstFrame(run);
          const ms = performance.now() - start;
          const first = Option.getOrNull(head);
          const sample: Sample = {
            cell,
            warmup: at < WARMUP,
            run,
            ms,
            stale: false,
            differences:
              first !== null && "flow" in first && first.flow !== undefined
                ? []
                : ["the first frame carried no Flow"],
            marks: {},
            start,
          };
          appendFileSync(raw, `${JSON.stringify(sample)}\n`);
          if (!sample.warmup) samples.push(sample);
        });
      const runs = fresh.slice(0, WARMUP + SAMPLES);
      const load = besideOf(fixture)[cell];
      const fibers = load === undefined ? [] : [yield* Effect.forkChild(load)];
      for (const [at, run] of runs.slice(0, WARMUP).entries()) yield* sampled(at, run);
      const lag = yield* lagOver(
        Effect.forEach(runs.slice(WARMUP), (run, at) => sampled(WARMUP + at, run), {
          discard: true,
        }),
        // Opened again, untimed: the window needs more probes than first opens there are.
        (at) => firstFrame(runs[at % runs.length]!),
      );
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
      summaries[cell] = {
        ...summaryOf(
          samples.map((sample) => sample.ms),
          samples.filter((sample) => sample.differences.length > 0).length,
        ),
        warmup: WARMUP,
        stages: "absent",
        ...lag,
      };
      yield* say(`${cell}: ${JSON.stringify(summaries[cell])}`);
    }
    return yield* written(fixture, summaries, null);
  });

const nearest = (samples: ReadonlyArray<number>, q: number) =>
  [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * samples.length) - 1)] ?? null;

/** For a cell that starts the host for each open: from host start to the record painted. */
const startedToPainted = (samples: ReadonlyArray<Sample>) => {
  const spans = samples.flatMap(({ marks }) => marks["host:started-to-painted"] ?? []);
  return spans.length === 0
    ? {}
    : {
        started_to_painted: {
          p50: nearest(spans, 0.5),
          p95: nearest(spans, 0.95),
          max: nearest(spans, 1),
        },
      };
};

/** Where a cell's time went, from Desktop's own marks: absent on a tree without them. */
const stagesOf = (samples: ReadonlyArray<Sample>) => {
  const marked = samples.filter(
    ({ marks }) =>
      marks["record:click"] !== undefined &&
      marks["record:mounted"] !== undefined &&
      marks["record:frame"] !== undefined &&
      marks["record:usable"] !== undefined,
  );
  if (marked.length === 0) return "absent";
  const stage = (from: string, to: string, over = marked) => {
    const spans = over.map(({ marks }) => marks[to]! - marks[from]!);
    return { p50: nearest(spans, 0.5), p95: nearest(spans, 0.95), max: nearest(spans, 1) };
  };
  const split = marked.filter(({ marks }) =>
    ["host:emit", "bridge:relay", "desktop:read"].every((at) => marks[at] !== undefined),
  );
  return {
    n: marked.length,
    // Samples whose host, bridge or Desktop mark never came, so the split leaves them out.
    unsplit: marked.length - split.length,
    mount: stage("record:click", "record:mounted"),
    bridge_and_host: stage("record:mounted", "record:frame"),
    ...(split.length > 0 && {
      split: {
        n: split.length,
        host_emit: stage("record:mounted", "host:emit", split),
        bridge: stage("host:emit", "bridge:relay", split),
        desktop_read: stage("bridge:relay", "desktop:read", split),
        to_view: stage("desktop:read", "record:frame", split),
      },
    }),
    render: stage("record:frame", "record:usable"),
  };
};

const failed = await runEffect(
  measuring(
    `${userStateDir(homedir(), userEnv)}/measurements/machine.lock`,
    say,
    Effect.gen(function* () {
      rmSync(live, { recursive: true, force: true });
      yield* enterWorld;
      yield* Effect.addFinalizer(() => stopHost(world.state));
      if (!hostOnly) {
        yield* say("building the view");
        buildView();
      }
      yield* say(`preparing ${flags.runs} Runs`);
      const fixture = yield* prepare({ ...COUNTS, runs: Number(flags.runs) });
      if (hostOnly) return yield* hostBody(fixture);
      const chrome =
        flags.cdp === undefined ? yield* Effect.promise(() => launchChrome(flags.chrome)) : null;
      if (chrome !== null) yield* Effect.addFinalizer(() => Effect.sync(chrome.stop));
      const cdp = flags.cdp ?? chrome!.cdp;
      // SAFETY: `/json/version` answers with the browser it is.
      const version = (yield* Effect.promise(() =>
        fetch(`${cdp}/json/version`).then((r) => r.json()),
      )) as {
        Browser: string;
      };
      const probe = yield* Effect.promise(() =>
        Bun.file(new URL("./probe.js", import.meta.url).pathname).text(),
      );
      /** A tab of Desktop's view, as a window Desktop opens, with the probe in it. */
      const windowOf = async () => {
        const page = await openPage(cdp, "about:blank");
        await page.send("Page.enable");
        await page.send("Emulation.setDeviceMetricsOverride", {
          ...WINDOW,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: probe });
        await page.send("Page.navigate", { url: `http://127.0.0.1:${VIEW_PORT}/` });
        return page;
      };
      return yield* body(fixture, windowOf, {
        version: version.Browser,
        flags: chrome === null ? [`--cdp ${cdp}`] : chrome.flags,
      });
    }).pipe(Effect.scoped, Effect.orDie),
  ),
);
process.exit(failed > 0 ? 1 : 0);
