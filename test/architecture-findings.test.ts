import * as Arr from "effect/Array";
import { Effect, FileSystem, Option, Stream } from "effect";
import type { Schema } from "effect";
import { expect, test } from "bun:test";
import { connect } from "../src/host";
import { hosted } from "./support/hosted";
import { hostRecords } from "./support/records";
import { RunRecords } from "../src/run-records";
import { sectionOf } from "../src/board-model";
import { runDir } from "../src/engine";
import { until } from "./support/host";
import { stringifyJson } from "../src/json";

const root = new URL("../", import.meta.url).pathname;
const encode: (value: Schema.Json) => string = stringifyJson;

const deferred: ReadonlyArray<Schema.Json> = [
  {
    severity: "major",
    title: "Two registries read the same table",
    file: "src/registry.ts",
    line: 12,
    basis: "fact",
    evidence: "both names are constructed in main.ts",
    suggested: "ticket",
  },
  { severity: "minor", title: "The adapter's names have drifted", basis: "inference" },
];

const report: (candidates: ReadonlyArray<Schema.Json>) => Schema.Json = (candidates) => ({
  verdict: "clean",
  findings: [],
  report: "plan/ARCHITECTURE.md",
  applied: [],
  deferred: candidates,
  slug: "one-registry",
  outcome: "refactor",
});

// WARNING: the shipped module reads its prose and its offers beside it, so both are copied where the Run finds it.
const install = (world: { readonly install: string; readonly user: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${world.install}/personas`, { recursive: true });
    for (const name of ["architecture.workflow.ts", "architecture.md", "selected.ts"]) {
      yield* fs.copyFile(`${root}workflows/${name}`, `${world.user}/${name}`);
    }
    yield* fs.copyFile(`${root}personas/architect.md`, `${world.install}/personas/architect.md`);
  }).pipe(Effect.orDie);

const started = (
  world: {
    readonly install: string;
    readonly user: string;
    readonly state: string;
    readonly project: string;
    readonly home: string;
  },
  output: Schema.Json,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* install(world);
    yield* fs.writeFileString(`${world.home}/outputs.json`, encode([output]));
    const client = yield* connect(world.state).pipe(Effect.orDie);
    const began = yield* client
      .start({
        project: world.project,
        id: "architecture",
        request: "survey",
        input: { goal: "why are there two registries" },
        options: { workspace: world.project },
      })
      .pipe(Effect.orDie);
    const parked = yield* until(
      () => client.run({ runId: began.runId }).pipe(Effect.orDie),
      (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "next"),
    );
    yield* client
      .answer({
        runId: began.runId,
        decision: Option.getOrThrow(
          Option.map(
            Arr.findFirst(parked?.waiting ?? [], (one) => one.name === "next"),
            (one) => one.name,
          ),
        ),
        value: "Stop here",
        request: "stop-here",
      })
      .pipe(Effect.orDie);
    yield* until(
      () => client.run({ runId: began.runId }).pipe(Effect.orDie),
      (view) => view?.status.status === "complete",
    );
    return { id: began.runId, dir: runDir(world.state, began.runId), client };
  });

const openCount = (state: string, run: string) =>
  hostRecords(
    state,
    RunRecords.use((records) => records.fact(run, "open-findings")),
  ).pipe(Effect.map(Number));

const cardOf = (state: string, run: string) =>
  Effect.gen(function* () {
    const client = yield* connect(state).pipe(Effect.orDie);
    const first = yield* client.board().pipe(Stream.runHead, Effect.orDie);
    const board = yield* Option.match(first, {
      onNone: () => Effect.die("the board sent nothing"),
      onSome: (one) => Effect.succeed(one),
    });
    const tasks = board._tag === "Snapshot" ? board.tasks : [];
    return yield* Option.match(
      Arr.findFirst(tasks, (one) => one.run === run),
      {
        onNone: () => Effect.die(`no card for ${run}`),
        onSome: (one) => Effect.succeed(one),
      },
    );
  });

test("an architecture Run's deferred candidates hold its card as findings to choose from", () =>
  hosted(
    "hw-architecture-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* started(world, report(deferred));
        const [first, second] = [`${run.id}-F1`, `${run.id}-F2`];

        expect(
          Arr.map(yield* run.client.runFindings({ runId: run.id }), (one) => [
            one.id,
            one.status,
            one.title,
          ]),
        ).toEqual([
          [first, "open", "Two registries read the same table"],
          [second, "open", "The adapter's names have drifted"],
        ]);
        expect(yield* openCount(world.state, run.id)).toBe(2);
        expect(
          Arr.map(yield* run.client.offers({ runId: run.id }), (one) => [
            one.id,
            one.selects ?? null,
          ]),
        ).toEqual([
          ["implement-selected", "many"],
          ["investigate-further", "one"],
          ["plan-this", "one"],
          ["file-to-linear", "one"],
        ]);
        const held = yield* cardOf(world.state, run.id);
        expect({ landed: held.landed, section: sectionOf(held) }).toEqual({
          landed: false,
          section: "waiting",
        });
      }),
    [],
  ));

test("an architecture Run that defers nothing leaves no findings and finishes as it did", () =>
  hosted(
    "hw-architecture-none-",
    ({ world }) =>
      Effect.gen(function* () {
        const run = yield* started(world, report([]));
        const fs = yield* FileSystem.FileSystem;

        expect(yield* fs.exists(`${run.dir}/findings.json`)).toBe(false);
        expect(yield* run.client.runFindings({ runId: run.id })).toEqual([]);
        expect(yield* openCount(world.state, run.id)).toBe(0);
        const offers = yield* run.client.offers({ runId: run.id });
        expect(Arr.filter(offers, (one) => one.unavailable === null)).toEqual([]);
        const card = yield* cardOf(world.state, run.id);
        expect({ landed: card.landed, section: sectionOf(card) }).toEqual({
          landed: true,
          section: "finished",
        });
      }),
    [],
  ));
