import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { InvestigationOutput } from "../workflows/investigate.workflow";

const read = Schema.decodeUnknownResult(InvestigationOutput, { errors: "all" });

const problemOf = (report: Schema.Json) => {
  const decoded = read(report);
  return decoded._tag === "Success" ? "" : decoded.failure.message;
};

const finding = (at: number, severity = "major") => ({ severity, title: `finding ${at}` });

const many = (count: number, severity = "major") =>
  Arr.map(Arr.range(1, count), (at) => finding(at, severity));

const report = (findings: ReadonlyArray<Schema.Json>) => ({
  answer: "The peer's bundle is stale because its watcher ignores the bundle's directory.",
  cause: "The watcher's ignore list holds the output directory.",
  summary: "The peer build is stale",
  findings,
});

test("an investigation reports at most seven findings and at most one of them minor", () => {
  expect(read(report(many(7)))._tag).toBe("Success");
  expect(read(report([finding(1), finding(2, "minor"), ...many(5).slice(1)]))._tag).toBe("Success");
  expect(problemOf(report(many(8)))).toContain("at most 7");
  expect(problemOf(report([finding(1, "minor"), finding(2, "minor"), ...many(5)]))).toContain(
    "at most one minor",
  );
});
