// `run list` and `run output` as a supervisor reads them: a bounded page that says
// whether it is the whole and how to get the rest.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Result, Schema, flow } from "effect";
import { PARKED, foundationLayer, runDir } from "../src/engine";
import { RunRecords } from "../src/run-records";
import { Store } from "../src/store";
import { stopHost } from "./support/host";
import { collie, proves, type World } from "./support/world";

const Page = Schema.Struct({
  runs: Schema.Array(Schema.Struct({ runId: Schema.String })),
  complete: Schema.Boolean,
  next: Schema.NullOr(Schema.String),
  cursor: Schema.String,
  omitted: Schema.Int,
});
const pageOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Page)(envelope.data).pipe(Effect.orDie);

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

const idOf = (n: number) => `run-${pipe(String(n), Str.padStart(3, "0"))}`;

/** `count` Runs admitted oldest first, `run-000` the oldest; `parked` of them parked. */
const recorded = (world: World, count: number, parked: ReadonlyArray<number> = []) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const records = yield* RunRecords;
    for (let n = 0; n < count; n++)
      yield* store.admit({
        request: idOf(n),
        run: idOf(n),
        workflow: "proof",
        project: world.project,
        input: {},
        provenance: {},
        options: {},
        generation: "proof-1",
        execution: idOf(n),
        task: null,
        parent: null,
      });
    for (const n of parked) yield* records.setControl(PARKED, idOf(n), "waits on a human");
  }).pipe(Effect.provide(foundationLayer({ dir: world.state })), Effect.scoped, Effect.orDie);

const list = (world: World, args: ReadonlyArray<string> = []) =>
  collie(world, ["run", "list", ...args]);

test(
  "run list answers the 50 newest summaries, and following next pages through the rest once each",
  () =>
    proves(
      "collie-run-list-pages-",
      (world) =>
        Effect.gen(function* () {
          yield* recorded(world, 120);
          const first = yield* pageOf((yield* list(world)).envelope);
          expect(Arr.map(first.runs, (one) => one.runId)).toEqual(
            Arr.makeBy(50, (i) => idOf(119 - i)),
          );
          expect(first.complete).toBe(false);
          expect(first.omitted).toBe(70);
          // A summary, not the full view.
          expect(first.runs[0]).not.toHaveProperty("input");

          const seen = Arr.map(first.runs, (one) => one.runId);
          let page = first;
          while (page.next !== null) {
            page = yield* pageOf((yield* list(world, ["--after", page.next])).envelope);
            seen.push(...Arr.map(page.runs, (one) => one.runId));
          }
          expect(page.complete).toBe(true);
          expect(page.omitted).toBe(0);
          expect(seen).toEqual(Arr.makeBy(120, (i) => idOf(119 - i)));
        }),
      [],
    ),
  240_000,
);

test(
  "--status parked lists only the parked Runs, and --since a cursor only the Runs changed after it",
  () =>
    proves(
      "collie-run-list-filters-",
      (world) =>
        Effect.gen(function* () {
          yield* recorded(world, 12, [3, 7]);
          const parked = yield* pageOf((yield* list(world, ["--status", "parked"])).envelope);
          expect(Arr.map(parked.runs, (one) => one.runId)).toEqual([idOf(7), idOf(3)]);
          expect(parked.complete).toBe(true);

          const before = yield* pageOf((yield* list(world)).envelope);
          for (const n of [2, 9])
            expect((yield* collie(world, ["run", "hold", idOf(n), "--reason", "test"])).exit).toBe(
              0,
            );
          const since = yield* pageOf((yield* list(world, ["--since", before.cursor])).envelope);
          expect(Arr.map(since.runs, (one) => one.runId)).toEqual([idOf(9), idOf(2)]);
        }),
      [],
    ),
  240_000,
);

test(
  "a next token given to --since is refused as invalid input, and one from before a restart as stale",
  () =>
    proves(
      "collie-run-list-tokens-",
      (world) =>
        Effect.gen(function* () {
          yield* recorded(world, 5);
          const first = yield* pageOf((yield* list(world, ["--limit", "2"])).envelope);
          expect(first.next).not.toBeNull();

          const misplaced = yield* list(world, ["--since", first.next!]);
          expect(misplaced.envelope.error?.code).toBe("invalid_input");
          expect(misplaced.envelope.error?.message).toContain("--after");

          yield* stopHost(world.state);
          const stale = yield* list(world, ["--after", first.next!]);
          expect(stale.envelope.error?.code).toBe("stale_cursor");
          const staleCursor = yield* list(world, ["--since", first.cursor]);
          expect(staleCursor.envelope.error?.code).toBe("stale_cursor");
        }),
      [],
    ),
  240_000,
);

const FullView = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      runId: Schema.String,
      input: Schema.Record(Schema.String, Schema.Json),
      status: Schema.Struct({ status: Schema.String }),
      machine: Schema.String,
    }),
  ),
  complete: Schema.Boolean,
});

test(
  "--fields full with no limit lists every Run in its whole view",
  () =>
    proves(
      "collie-run-list-full-",
      (world) =>
        Effect.gen(function* () {
          yield* recorded(world, 60);
          const full = yield* Schema.decodeUnknownEffect(FullView)(
            (yield* list(world, ["--fields", "full"])).envelope.data,
          ).pipe(Effect.orDie);
          expect(full.runs.length).toBe(60);
          expect(full.complete).toBe(true);
          expect(full.runs[0]?.input).toEqual({});
        }),
      [],
    ),
  240_000,
);

const Outputs = Schema.Struct({
  outputs: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      step: Schema.optional(Schema.String),
      verdict: Schema.optional(Schema.NullOr(Schema.String)),
      summary: Schema.optional(Schema.NullOr(Schema.String)),
      findings: Schema.optional(Schema.NullOr(Schema.Int)),
      read: Schema.optional(Schema.String),
      value: Schema.optional(Schema.Json),
    }),
  ),
});

test(
  "run output answers each Output's summary and where to read it, and --full answers them whole",
  () =>
    proves(
      "collie-run-output-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* recorded(world, 1);
          const dir = runDir(world.state, idOf(0));
          const patch = "diff --git a/x b/x\n+changed\n";
          const written = {
            "build.json": { verdict: "clean", summary: "Built it.", findings: [] },
            "review/round-1.json": {
              verdict: "findings",
              summary: "Two things.",
              findings: [{ title: "one" }, { title: "two" }],
            },
            "diff.json": { head: "abc", patches: { x: patch } },
          };
          for (const [path, value] of Rec.toEntries(written)) {
            yield* fs.makeDirectory(`${dir}/review`, { recursive: true });
            yield* fs.writeFileString(`${dir}/${path}`, encode(value));
          }

          const said = yield* collie(world, ["run", "output", idOf(0)]);
          expect(encode(said.envelope.data)).not.toContain("+changed");
          const summary = yield* Schema.decodeUnknownEffect(Outputs)(said.envelope.data);
          expect(summary.outputs).toEqual([
            {
              path: "build.json",
              step: "build",
              verdict: "clean",
              summary: "Built it.",
              findings: 0,
              read: `collie run output ${idOf(0)} --full --path build.json`,
            },
            {
              path: "diff.json",
              step: "diff",
              verdict: null,
              summary: null,
              findings: null,
              read: `collie run output ${idOf(0)} --full --path diff.json`,
            },
            {
              path: "review/round-1.json",
              step: "review/round-1",
              verdict: "findings",
              summary: "Two things.",
              findings: 2,
              read: `collie run output ${idOf(0)} --full --path review/round-1.json`,
            },
          ]);

          const full = yield* Schema.decodeUnknownEffect(Outputs)(
            (yield* collie(world, ["run", "output", idOf(0), "--full"])).envelope.data,
          );
          expect(full.outputs).toEqual([
            { path: "build.json", value: written["build.json"] },
            { path: "diff.json", value: written["diff.json"] },
            { path: "review/round-1.json", value: written["review/round-1.json"] },
          ]);
          const one = yield* Schema.decodeUnknownEffect(Outputs)(
            (yield* collie(world, ["run", "output", idOf(0), "--full", "--path", "diff.json"]))
              .envelope.data,
          );
          expect(one.outputs).toEqual([{ path: "diff.json", value: written["diff.json"] }]);
        }).pipe(Effect.orDie),
      [],
    ),
  240_000,
);
