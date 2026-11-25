import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { evidenceGaps } from "../src/outcome";
import type { Outcome } from "../src/outcome";
import type { YamlValue } from "../src/yaml";
import { gateOperations, inventoryOf } from "../workflows/delivering";

const claimed = (
  kind: Outcome,
  outputs: Record<string, YamlValue>,
  claims: ReadonlyArray<string>,
) =>
  evidenceGaps(kind, {
    verifications: [],
    final: { head_sha: "abc123", fingerprint: "tree-1" },
    approved: [],
    outputs: new Map(Rec.toEntries(outputs)),
    claims: new Set(claims),
    reviewed: new Set<string>(),
    insideRun: () => true,
    tickets: [],
  });

const given = {
  tickets: ["01-first.md"],
  fixed: ["01-first.md.fix-1"],
  fixing: ["gate-fix-1"],
  claims: ["build-2"],
  repairs: ["01-first.md.criteria-1"],
};

const of = (date: ReadonlyArray<{ operation: string; output: YamlValue | null; at: number }>) =>
  Arr.map(date, (one) => ({
    operation: one.operation,
    output: one.output === null ? Option.none<YamlValue>() : Option.some(one.output),
    at: one.at,
  }));

test("a build's retries and criteria repairs are read, and only the build's claims are the gate's", () => {
  const gate = gateOperations({ ...given, kind: "feature" });
  expect(gate.claims).toContain("build-2");
  expect(gate.claims).not.toContain("01-first.md.criteria-1");
  expect(gate.claims).not.toContain("gate-fix-1");
  expect(gate.outputs).toContain("build-2");
  expect(gate.outputs).toContain("01-first.md.criteria-1");
  expect(gateOperations({ ...given, kind: "bug" }).claims).toContain("gate-fix-1");
});

test("a criteria repair's empty tickets_done does not unseat the build the gate reads", () => {
  const build = { verdict: "clean", tickets_done: ["the first one"] };
  const gate = gateOperations({ ...given, kind: "feature" });
  const outputs = inventoryOf(
    Arr.filter(
      of([
        { operation: "build", output: build, at: 1 },
        {
          operation: "01-first.md.criteria-1",
          output: { verdict: "clean", tickets_done: [] },
          at: 3,
        },
        { operation: "build-2", output: build, at: 2 },
      ]),
      (one) => gate.outputs.includes(one.operation),
    ),
    { build },
  );
  expect([...Rec.keys(outputs)]).toEqual(["build", "build-2", "01-first.md.criteria-1"]);
  expect(claimed("feature", outputs, gate.claims)).not.toContain(
    "no ticket is reported built (tickets_done is empty)",
  );
});
