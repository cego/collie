// The Intent is what every later comparison is made against, so the things it must
// never do are tested first: never default a file it cannot read, never take authority
// from text, never lose a child's own constraints when a parent propagates.

import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DEFAULT_AUTHORITY,
  IntentUnreadable,
  amend,
  extractRequirements,
  parseConstraint,
  propagate,
  readIntent,
  seedIntent,
  writeIntent,
} from "../src/intent";
import { runEffect } from "./support/effect";

let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      dir = yield* fs.makeTempDirectory({ prefix: "hw-intent-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ),
);

test("a Run with no Intent reads as none, and a written one round trips", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* readIntent(dir)).toBeNull();
      const intent = seedIntent("r1", {
        goal: "ship the steering work",
        constraints: [
          {
            id: "c1",
            kind: "rule",
            text: "only these paths",
            severity: "block",
            source: "human",
            since: 1,
            rule: { kind: "protected_paths", globs: ["src/**"] },
          },
        ],
      });
      yield* writeIntent(dir, intent);
      const back = yield* readIntent(dir);
      expect(back).toEqual(intent);
      expect(back?.authority).toEqual(DEFAULT_AUTHORITY);
    }),
  ));

test("an Intent that cannot be decoded is an error, never a default", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(dir, "intent.json"), `{"version":"one"}`);
      const failure = yield* readIntent(dir).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(IntentUnreadable);
    }),
  ));

test("an amendment bumps the version and says who made it", () => {
  const v1 = seedIntent("r1", { goal: null });
  const v2 = amend(
    v1,
    { kind: "set-goal", goal: "land it" },
    "human:req-1",
    "2026-09-09T00:00:00Z",
  );
  expect(v1.version).toBe(1);
  expect(v2.version).toBe(2);
  expect(v2.goal).toBe("land it");
  expect(v2.history).toHaveLength(1);
  expect(v2.history[0]?.by).toBe("human:req-1");
  const v3 = amend(
    v2,
    { kind: "authority", patch: { auto_correct: true } },
    "human:req-2",
    "2026-09-09T00:01:00Z",
  );
  expect(v3.authority.auto_correct).toBe(true);
  expect(v3.history).toHaveLength(2);
});

test("removing a constraint that is not there does not invent a version", () => {
  const v1 = seedIntent("r1", {});
  expect(amend(v1, { kind: "remove-constraint", id: "nope" }, "human:x", "t")).toBe(v1);
});

test("propagation replaces the parent's entries, keeps the child's own, and lists conflicts", () => {
  const parent = seedIntent("parent", {
    goal: "parent goal",
    constraints: [
      {
        id: "p1",
        kind: "semantic",
        text: "keep the envelope",
        severity: "block",
        source: "human",
        since: 1,
      },
    ],
  });
  const child = propagate(parent, seedIntent("child", {})).intent;
  expect(child.parent).toEqual({ run: "parent", version: 1, applied: 1 });
  expect(child.constraints.map((c) => c.source)).toEqual(["parent"]);

  const amended = amend(
    child,
    {
      kind: "add-constraint",
      constraint: {
        id: "own",
        kind: "semantic",
        text: "the child's own",
        severity: "warn",
        source: "human",
      },
    },
    "human:req",
    "t",
  );
  const later = amend(parent, { kind: "set-goal", goal: "moved on" }, "human:req", "t");
  const { intent, conflicts } = propagate(later, amended);
  expect(intent.parent).toEqual({ run: "parent", version: 2, applied: 2 });
  expect(intent.constraints.map((c) => c.id).sort()).toEqual(["own", "p1"]);
  expect(intent.goal).toBe(amended.goal);
  expect(conflicts).toEqual(['goal: parent "moved on" differs from the child\'s "parent goal"']);
});

test("plan requirements become warn constraints with provenance, and never authority", () => {
  const spec = [
    "# Spec: a thing",
    "",
    "## Objective",
    "",
    "Make the thing work end to end.",
    "",
    "Second paragraph is not the goal.",
    "",
    "## Requirements",
    "",
    "- the envelope stays stable",
    "- every boundary decodes",
    "",
    "## Notes",
    "",
    "- not a requirement",
    "",
    "### Success criteria",
    "",
    "- the suite is green",
  ].join("\n");
  const found = extractRequirements(spec, "SPEC.md");
  expect(found.goal).toBe("Make the thing work end to end.");
  expect(found.constraints.map((c) => c.text)).toEqual([
    "the envelope stays stable",
    "every boundary decodes",
    "the suite is green",
  ]);
  for (const constraint of found.constraints) {
    expect(constraint.source).toBe("plan");
    expect(constraint.kind).toBe("semantic");
    expect(constraint.severity).toBe("warn");
    expect(constraint.provenance?.file).toBe("SPEC.md");
    expect(constraint.provenance?.line).toBeGreaterThan(0);
  }
  expect(found.constraints[0]?.provenance?.heading).toBe("Requirements");
  expect(found.constraints[2]?.provenance?.heading).toBe("Success criteria");
  // Nothing in a plan is a grant: `extractRequirements` returns constraints only.
  expect(Object.keys(found)).toEqual(["goal", "constraints"]);
});

test("a numbered plan has a goal and constraints like any other", () => {
  // This repository's own SPEC.md numbers its headings. Reading it as a document with
  // neither goal nor requirements would seed every plan-dir Run with nothing to steer by.
  const numbered = [
    "# Spec: something",
    "",
    "## 1. Objective",
    "",
    "Make the thing work end to end.",
    "",
    "## 8. Requirements by area",
    "",
    "- the envelope stays stable",
    "",
    "### 9.2 Success criteria",
    "",
    "- the suite is green",
  ].join("\n");
  const found = extractRequirements(numbered, "SPEC.md");
  expect(found.goal).toBe("Make the thing work end to end.");
  expect(found.constraints.map((c) => c.text)).toEqual([
    "the envelope stays stable",
    "the suite is green",
  ]);
  expect(found.constraints[0]?.provenance?.heading).toBe("Requirements");
});

test("what the human typed beats a workspace default, and defaults never grant authority", () => {
  const intent = seedIntent("r1", {
    defaults: {
      constraints: [
        {
          id: "d1",
          kind: "semantic",
          text: "no new dependencies",
          severity: "warn",
          source: "workspace-default",
          since: 1,
        },
      ],
      authority: { ...DEFAULT_AUTHORITY, max_corrections_per_constraint: 5 },
    },
    goal: "typed goal",
    constraints: [
      {
        id: "d1",
        kind: "semantic",
        text: "no new dependencies",
        severity: "block",
        source: "human",
        since: 1,
      },
    ],
  });
  expect(intent.goal).toBe("typed goal");
  expect(intent.constraints).toHaveLength(1);
  expect(intent.constraints[0]?.severity).toBe("block");
  expect(intent.constraints[0]?.source).toBe("human");
  expect(intent.authority.max_corrections_per_constraint).toBe(5);
  expect(intent.authority.auto_correct).toBe(false);
});

test("a rule constraint is spelled out, and a misspelled one says how", () => {
  const paths = parseConstraint("rule:protected_paths:src/**,test/**", "block");
  expect(paths).toMatchObject({
    kind: "rule",
    severity: "block",
    rule: { kind: "protected_paths", globs: ["src/**", "test/**"] },
  });
  expect(parseConstraint("rule:output_field:build:verdict:eq:clean", "warn")).toMatchObject({
    rule: { kind: "output_field", step: "build", path: "verdict", op: "eq", value: "clean" },
  });
  expect(parseConstraint("rule:branch_is", "warn")).toEqual({
    error: "rule:branch_is is spelled rule:branch_is:<branch>",
  });
  expect(parseConstraint("rule:invented:x", "warn")).toEqual({ error: 'unknown rule "invented"' });
  expect(parseConstraint("keep the envelope stable", "warn")).toMatchObject({
    kind: "semantic",
    source: "human",
  });
});
