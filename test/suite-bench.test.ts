import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { suiteReadings } from "../tools/suite-bench";

const ran = `$ bun run tools/test.ts
test: waiting behind the whole suite in run-1, which queued first
test: 12 workers of a budget of 16
bun test v1.4.4 (38afee6c8) 12x PARALLEL

(fail) a scenario that broke [5337.84ms]

 1520 pass
 2 fail
 9014 expect() calls
Ran 1522 tests across 230 files. [598.31s]
test: queued 41.50 s, built 11.02 s, ran 598.31 s
test: 12 workers of a budget of 16, 4 of it kept for small runs
test: 13561 processes started
test: 609.33 s including builds
`;

test("a suite's own time, its wait and its counts are read from the runner's and Bun's summaries", () => {
  expect(suiteReadings(ran)).toEqual({
    ok: true,
    readings: { own_ms: 609_330, queued_ms: 41_500, passed: 1520, failed: 2 },
  });
});

test("output with no queued line, or no Bun summary, is an error and never a zero", () => {
  const unqueued = pipe(ran, Str.replace(/^test: queued .*\n/m, ""));
  expect(suiteReadings(unqueued)).toEqual({
    ok: false,
    error: "no `test: queued …, built …, ran …` line in the suite's output",
  });
  expect(suiteReadings(pipe(ran, Str.replace(/^ \d+ fail\n/m, "")))).toEqual({
    ok: false,
    error: "no Bun `N pass` and `N fail` summary in the suite's output",
  });
});
