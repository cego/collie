// Click to usable Flow in Desktop, end to end (docs/internals.md, Measuring a record open).
// Prints, as its last line, one JSON object of numbers for `collie measure`.

import { mkdirSync, rmSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Effect, Fiber, FileSystem, Option, Stream } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Flow } from "../../src/board-model";
import { connect } from "../../src/host";
import type { PlatformServices } from "../../src/platform";
import { runEffect } from "../../test/support/effect";
import { stopHost } from "../../test/support/host";
import { openPage, type Page } from "./cdp";
import { differences, type Painted, paintedOf } from "./compare";
import { buildView, launchChrome, startDesktop, VIEW_PORT, viewUp, WINDOW } from "./desktop";
import { COUNTS, type Fixture, prepare } from "./fixture";
import { measuring, refusal, userStateDir } from "./guards";
import { barFailures, type CellSummary, summaryOf } from "./stats";
import { enterWorld, live, root, socket, userEnv, world } from "./world";

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
type Cell = (typeof LOCAL)[number];
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
        const cell = LOCAL.find((one) => one === name);
        if (cell === undefined) throw new Error(`no cell ${name}`);
        return cell;
      });
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
}

/** The longest a sample waits for its Flow before it is counted as never painted. */
const NEVER_MS = 60_000;

const body = (
  fixture: Fixture,
  windowOf: () => Promise<Page>,
  chrome: { version: string; flags: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
        return yield* Effect.die(new Error(`waited ${limitMs} ms for ${expression}`));
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
        Effect.map((head) => Option.getOrUndefined(head)?.flow ?? null),
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
                marks: shown.marks,
                start: shown.start,
              };
        yield* close;
        return sample;
      });

    const cycle = (pool: ReadonlyArray<string>) => (at: number) => pool[at % pool.length]!;
    const settled = cycle(fixture.settled);
    const opens: Record<
      Cell,
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
          yield* Effect.scoped(connect(world.state));
          yield* boardSettled;
          return yield* timedOpen("host-cold", warmup, settled(at));
        }).pipe(Effect.orDie),
    };

    /** What a cell runs beside its samples, ended when they are. */
    const beside: Partial<Record<Cell, Effect.Effect<void, never, PlatformServices>>> = {
      // Four Checks on a live Run, each busy until its flag is gone.
      checks: Effect.gen(function* () {
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

    /** A trivial RPC every 50 ms, as a proxy for the host's event-loop lag. */
    const lagProbe = (into: number[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          for (;;) {
            const began = performance.now();
            yield* client.identity();
            into.push(performance.now() - began);
            yield* Effect.sleep("50 millis");
          }
        }),
      ).pipe(
        // A host that restarts takes the connection with it.
        Effect.catchCause(() => Effect.sleep("100 millis")),
        Effect.forever,
      );

    let desktop = startDesktop();
    yield* Effect.addFinalizer(() => Effect.sync(() => desktop.kill()));
    yield* Effect.promise(viewUp);
    let page = yield* Effect.promise(windowOf);
    yield* Effect.addFinalizer(() => Effect.promise(() => page.close()));
    yield* boardSettled;

    mkdirSync(out, { recursive: true });
    const raw = `${out}/samples.jsonl`;
    const summaries: Record<
      string,
      CellSummary & {
        readonly warmup: number;
        readonly stages: ReturnType<typeof stagesOf>;
        readonly lag_p99_ms: number | null;
      }
    > = {};
    for (const cell of cells) {
      yield* say(`${cell}: ${WARMUP} warm-up and ${SAMPLES} timed opens`);
      const lag: number[] = [];
      const fibers = [
        yield* Effect.forkChild(lagProbe(lag)),
        ...(beside[cell] === undefined ? [] : [yield* Effect.forkChild(beside[cell])]),
      ];
      const samples: Sample[] = [];
      for (let at = 0; at < WARMUP + SAMPLES; at++) {
        const sample = yield* opens[cell](at < WARMUP, at);
        appendFileSync(raw, `${JSON.stringify(sample)}\n`);
        if (!sample.warmup) samples.push(sample);
      }
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
      summaries[cell] = {
        ...summaryOf(
          samples.map((sample) => sample.ms),
          samples.filter((sample) => sample.differences.length > 0).length,
        ),
        warmup: WARMUP,
        stages: stagesOf(samples),
        lag_p99_ms: nearest(lag, 0.99),
      };
      yield* say(`${cell}: ${JSON.stringify(summaries[cell])}`);
    }

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
      chrome: { ...chrome, headless: true, software_rendered: true, window: WINDOW },
      vue_prod_devtools: true,
      note: "Chrome numbers from a headless, software-rendered Chrome on a build with Vue's production devtools hooks on; not native Desktop numbers.",
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

const nearest = (samples: ReadonlyArray<number>, q: number) =>
  [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * samples.length) - 1)] ?? null;

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
  const stage = (from: string, to: string) => {
    const spans = marked.map(({ marks }) => marks[to]! - marks[from]!);
    return { p50: nearest(spans, 0.5), p95: nearest(spans, 0.95), max: nearest(spans, 1) };
  };
  return {
    n: marked.length,
    mount: stage("record:click", "record:mounted"),
    bridge_and_host: stage("record:mounted", "record:frame"),
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
      yield* say("building the view");
      buildView();
      yield* say(`preparing ${flags.runs} Runs`);
      const fixture = yield* prepare({ ...COUNTS, runs: Number(flags.runs) });
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
