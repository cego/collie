import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { evidenceGaps } from "../src/outcome";
import type { Outcome } from "../src/outcome";
import type { YamlValue } from "../src/yaml";
import { gateOperations, inventoryOf } from "../workflows/delivering";

const claimed = (kind: Outcome, outputs: Record<string, YamlValue>) =>
  evidenceGaps(kind, {
    verifications: [],
    final: { head_sha: "abc123", fingerprint: "tree-1" },
    approved: [],
    outputs: new Map(Rec.toEntries(outputs)),
    reviewed: new Set<string>(),
    insideRun: () => true,
    tickets: [],
  });

const given = {
  tickets: ["01-first.md"],
  fixed: ["01-first.md.fix-1"],
  fixing: ["gate-fix-1"],
  wrote: ["build-2", "01-first.md.criteria-1"],
};

test("a build's retries and criteria repairs are the gate's, and a feature's fixer is not", () => {
  const operations = gateOperations({ ...given, kind: "feature" });
  expect(operations).toContain("build-2");
  expect(operations).toContain("01-first.md.criteria-1");
  expect(operations).not.toContain("gate-fix-1");
  expect(gateOperations({ ...given, kind: "bug" })).toContain("gate-fix-1");
});

test("a fixer's stray empty tickets_done does not unseat the build the gate reads", () => {
  const build = { verdict: "clean", tickets_done: ["the first one"] };
  const dated = [
    { operation: "build", output: Option.some(build), at: 1 },
    { operation: "gate-fix-1", output: Option.some({ verdict: "clean", tickets_done: [] }), at: 3 },
    { operation: "build-2", output: Option.some(build), at: 2 },
  ];
  const outputs = inventoryOf(
    Arr.filter(dated, (one) =>
      gateOperations({ ...given, kind: "feature" }).includes(one.operation),
    ),
    { build },
  );
  expect([...Rec.keys(outputs)]).toEqual(["build", "build-2"]);
  expect(claimed("feature", outputs)).not.toContain(
    "no ticket is reported built (tickets_done is empty)",
  );
});
