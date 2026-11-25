import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import type { Schema } from "effect";
import {
  OPEN_FINDINGS,
  findingsWithStatus,
  openCountIn,
  openFindingsRead,
  readFindingStatuses,
  recordFindingStatus,
  storeOpenCount,
} from "../src/finding-status";
import type { FindingStatus } from "../src/board-model";
import { RunRecords } from "../src/run-records";
import { recordsAt } from "./support/records";
import { stringifyJson } from "../src/json";
import { runEffect } from "./support/effect";
import { declaredByModule } from "../src/engine";
import { offersFrom } from "../src/offers";
import type { ActionFacts } from "../src/sdk";
import reviewWorkflow from "../workflows/review.workflow";

const line: (over?: Partial<FindingStatus>) => FindingStatus = (over = {}) => ({
  id: "r1-F1",
  status: "dismissed",
  reason: "not worth it",
  offer: null,
  run: null,
  by: "human:req-1",
  at: "2026-11-24T10:00:00.000Z",
  ...over,
});

const inRun = <A, E>(
  findings: ReadonlyArray<Schema.Json>,
  use: (dir: string) => Effect.Effect<A, E, RunRecords | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const state = yield* fs.makeTempDirectoryScoped({ prefix: "hw-finding-status-" });
    const dir = `${state}/runs/r1`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/findings.json`, stringifyJson(findings));
    return yield* use(dir).pipe(Effect.provide(recordsAt(state)));
  });

test("a disputed finding is open and a fixed or obsolete one is not, until a later line reopens it", () =>
  runEffect(
    inRun(
      [
        { id: "r1-F1", severity: "major", title: "one", status: "disputed" },
        { id: "r1-F2", severity: "minor", title: "two", status: "fixed" },
        { id: "r1-F3", severity: "minor", title: "three", status: "obsolete" },
        { id: "r1-F4", severity: "major", title: "four" },
      ],
      (dir) =>
        Effect.gen(function* () {
          expect(yield* openCountIn(dir)).toBe(2);

          yield* recordFindingStatus(dir, line({ id: "r1-F2", status: "open", reason: null }));

          expect(yield* openCountIn(dir)).toBe(3);
        }),
    ),
  ));

test("dismissing a finding reads it dismissed with its reason, and reopening it reads it open", () =>
  runEffect(
    inRun(
      [
        { id: "r1-F1", severity: "major", title: "one" },
        { id: "r1-F2", severity: "minor", title: "two" },
      ],
      (dir) =>
        Effect.gen(function* () {
          expect(Arr.map(yield* findingsWithStatus(dir), (one) => one.status)).toEqual([
            "open",
            "open",
          ]);

          yield* recordFindingStatus(dir, line());
          const dismissed = yield* findingsWithStatus(dir);
          expect(dismissed[0]).toMatchObject({
            id: "r1-F1",
            status: "dismissed",
            reason: "not worth it",
          });
          expect(yield* readFindingStatuses(dir)).toEqual([line()]);
          expect(dismissed[1]).toMatchObject({ id: "r1-F2", status: "open", reason: null });
          expect(yield* openCountIn(dir)).toBe(1);

          yield* recordFindingStatus(dir, line({ status: "open", reason: null }));

          expect(Arr.map(yield* findingsWithStatus(dir), (one) => one.status)).toEqual([
            "open",
            "open",
          ]);
          expect(yield* openCountIn(dir)).toBe(2);
        }),
    ),
  ));

test("the count is the Run's fact, computed and kept the first time a Run that predates it is read", () =>
  runEffect(
    inRun([{ id: "r1-F1", severity: "major", title: "one" }], (dir) =>
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const fs = yield* FileSystem.FileSystem;
        expect(yield* records.fact("r1", OPEN_FINDINGS)).toBeNull();

        expect(yield* openFindingsRead(dir)).toBe(1);
        expect(yield* records.fact("r1", OPEN_FINDINGS)).toBe("1");
        yield* fs.remove(`${dir}/findings.json`);
        expect(yield* openFindingsRead(dir)).toBe(1);

        yield* recordFindingStatus(dir, line({ reason: "gone" }));
        yield* storeOpenCount(dir);

        expect(yield* openFindingsRead(dir)).toBe(0);
      }),
    ),
  ));

const facts: (over?: Partial<ActionFacts>) => ActionFacts = (over = {}) => ({
  outcome: "review",
  succeeded: true,
  branch: "mk/thing",
  mrUrl: null,
  planIssues: 0,
  disposed: false,
  openFindings: 0,
  diffTarget: "mr:gitlab.cego.dk/mk/collie!7",
  review: { head: "H1", reviewed: "H1", owned: true },
  claim: null,
  ...over,
});

test("Improve is unavailable once every open finding is dismissed, and available again after one is reopened", () =>
  runEffect(
    inRun(
      [
        { id: "r1-F1", severity: "major", title: "one" },
        { id: "r1-F2", severity: "minor", title: "two" },
      ],
      (dir) =>
        Effect.gen(function* () {
          const improve = (openFindings: number) =>
            Option.getOrUndefined(
              Arr.findFirst(
                offersFrom(declaredByModule(reviewWorkflow), facts({ openFindings }), {
                  keepUnavailable: true,
                }),
                (one) => one.id === "improve",
              ),
            );
          const now = () => openCountIn(dir).pipe(Effect.map((open) => improve(open)?.unavailable));

          expect(yield* now()).toBeNull();

          yield* recordFindingStatus(dir, line());
          yield* recordFindingStatus(dir, line({ id: "r1-F2", reason: "stale" }));

          expect(yield* now()).toBe("no finding is open at the current head");

          yield* recordFindingStatus(dir, line({ status: "open", reason: null }));

          expect(yield* now()).toBeNull();
        }),
    ),
  ));
