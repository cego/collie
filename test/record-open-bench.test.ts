import { describe, expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, flow, Result, Schema } from "effect";
import * as Arr from "effect/Array";
import type { Flow } from "../src/board-model";
import { processStartTime } from "../src/lock";
import { measuring, refusal } from "../bench/record-open/guards";
import {
  differences,
  type Painted,
  type PaintedNode,
  paintedOf,
} from "../bench/record-open/compare";
import { barFailures, summaryOf } from "../bench/record-open/stats";
import { runEffect } from "./support/effect";
import { flowNode } from "./support/flow";

const encodeClaim = flow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Struct({ pid: Schema.Finite, start: Schema.NullOr(Schema.String) }),
    ),
  ),
  Result.getOrThrow,
);

describe("the record-open benchmark's statistics", () => {
  // 37 is coprime with 200, so this is 1..200 in a scrambled order.
  const scrambled = Array.from({ length: 200 }, (_, i) => ((i * 37) % 200) + 1);

  test("reads p50, p95 and max of 200 samples by nearest rank", () => {
    expect(summaryOf(scrambled, 0)).toEqual({ p50: 100, p95: 190, max: 200, n: 200, failed: 0 });
  });

  test("a cell whose p95 is under the bar but whose max is over it fails the bar", () => {
    const samples = [
      ...Array.from({ length: 189 }, () => 100),
      ...Array.from({ length: 10 }, () => 199),
      201,
    ];
    const cell = summaryOf(samples, 0);
    expect(cell).toMatchObject({ p95: 199, max: 201 });
    expect(barFailures({ first: cell }, 200)).toEqual(["first: max 201 ms"]);
    expect(
      barFailures(
        {
          first: summaryOf(
            Array.from({ length: 200 }, () => 199),
            0,
          ),
        },
        200,
      ),
    ).toEqual([]);
  });

  test("a sample that failed correctness fails the bar however fast the cell was", () => {
    expect(barFailures({ live: summaryOf([10, 20, 30], 1) }, 200)).toEqual([
      "live: 1 sample painted a wrong Flow",
    ]);
  });
});

describe("the record-open benchmark's Flow comparison", () => {
  const host: Flow = {
    lanes: [
      {
        run: "build-run",
        workflow: "implement",
        title: "Implement",
        machine: "laptop",
        execution: "running",
        declared: true,
        requestedBy: null,
        nodes: [
          flowNode("build", {
            state: "running",
            said: "Slice 4 of 6",
            primary: "log",
            attempts: [
              { at: "2026-10-23T09:00:00.000Z", cause: null },
              { at: "2026-10-23T09:05:00.000Z", cause: "restarted" },
            ],
          }),
          flowNode("review", { wait: "check" }),
        ],
      },
    ],
    current: { run: "build-run", node: "build" },
    release: null,
  };
  /** What the record paints of `host`, as its accessible names read. */
  const painted = (): Painted => [
    {
      name: "Implement, build-run, on laptop, running",
      nodes: [
        { name: "Build, running, Slice 4 of 6, Log", attempts: 2, wait: null, actions: ["Log"] },
        { name: "Review, expected", attempts: 0, wait: "check", actions: [] },
      ],
    },
  ];
  const differ = (shown: Painted) => differences(shown, paintedOf(host, "laptop"));
  /** The painted Flow with node `at` changed. */
  const changed = (at: number, over: Partial<PaintedNode>): Painted =>
    Arr.map(painted(), (row) => ({
      ...row,
      nodes: Arr.map(row.nodes, (node, i) => (i === at ? { ...node, ...over } : node)),
    }));

  test("the host's own Flow, painted, passes", () => {
    expect(differ(painted())).toEqual([]);
  });

  test("a node in another state fails", () => {
    expect(differ(changed(1, { name: "Review, running" }))).toEqual([
      'Implement, build-run, on laptop, running: node 2 is "Review, running", not "Review, expected"',
    ]);
  });

  test("a node with another attempt count fails", () => {
    expect(differ(changed(0, { attempts: 1 }))).toEqual([
      "Implement, build-run, on laptop, running: Build, running, Slice 4 of 6, Log has 1 attempts, not 2",
    ]);
  });

  test("a node missing its action fails", () => {
    expect(differ(changed(0, { actions: [] }))).toEqual([
      'Implement, build-run, on laptop, running: Build, running, Slice 4 of 6, Log offers "", not "Log"',
    ]);
  });

  test("a missing row or node fails", () => {
    expect(differ([])).toEqual(['rows are "", not "Implement, build-run, on laptop, running"']);
    expect(differ(Arr.map(painted(), (row) => ({ ...row, nodes: row.nodes.slice(0, 1) })))).toEqual(
      ["Implement, build-run, on laptop, running: 1 nodes, not 2"],
    );
  });
});

describe("the record-open benchmark's guards", () => {
  const home = "/home/someone";
  const user = `${home}/.local/state/herdr/plugins/cego.collie`;

  test("refuses the user's state directory and its socket, wherever the environment puts it", () =>
    runEffect(
      Effect.gen(function* () {
        expect(
          yield* refusal({ state: user, socket: "/tmp/b/host.sock" }, { home, env: {} }),
        ).toMatch(/state directory/);
        expect(
          yield* refusal({ state: "/tmp/b", socket: `${user}/host.sock` }, { home, env: {} }),
        ).toMatch(/socket/);
        expect(
          yield* refusal(
            { state: "/srv/collie/", socket: "/tmp/b/host.sock" },
            { home, env: { HERDR_PLUGIN_STATE_DIR: "/srv/collie" } },
          ),
        ).toMatch(/state directory/);
        expect(
          yield* refusal({ state: "/tmp/b", socket: "/tmp/b/host.sock" }, { home, env: {} }),
        ).toBeNull();
      }),
    ));

  test("samples nothing while another process holds the Machine Measurement lock, and says so", () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const lock = `${dir}/machine.lock`;
        const holder = Bun.spawn(["sleep", "30"]);
        yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill()));
        yield* fs.writeFileString(
          lock,
          encodeClaim({ pid: holder.pid, start: yield* processStartTime(holder.pid) }),
        );
        const said: string[] = [];
        let sampled = false;
        const sampling = yield* Effect.forkScoped(
          measuring(
            lock,
            (line) => Effect.sync(() => said.push(line)),
            Effect.sync(() => (sampled = true)),
          ),
        );
        yield* Effect.sleep("1500 millis");
        expect(sampled).toBe(false);
        expect(said).toEqual([
          `waiting: process ${holder.pid} holds the Machine Measurement lock ${lock}`,
        ]);
        holder.kill();
        yield* Fiber.join(sampling);
        expect(sampled).toBe(true);
        expect(yield* fs.exists(lock)).toBe(false);
      }).pipe(Effect.scoped),
    ));
});
