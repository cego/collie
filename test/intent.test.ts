// The Intent is what every later comparison is made against, so the things it must
// never do are tested first: never default a file it cannot read, never take authority
// from text, never lose a child's own constraints when a parent propagates.

import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  DEFAULT_AUTHORITY,
  IntentUnreadable,
  amend,
  constraintId,
  extractRequirements,
  followPlan,
  PLAN_AUTHOR,
  parseConstraint,
  propagate,
  readIntent,
  seedIntent,
  writeIntent,
} from "../src/intent";
import { runEffect } from "./support/effect";
import { Crypto } from "effect";
import { connect } from "../src/host";
import { runDir } from "../src/engine";
import { isSettled } from "../src/lifecycle";
import { hosted } from "./support/hosted";
import { until } from "./support/host";

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

test("a plan's out-of-scope and done-when bullets are constraints, and out of scope says so", () => {
  const spec = [
    "# Spec: a thing",
    "",
    "## Out of Scope",
    "",
    "- Rewriting the scheduler",
    "",
    "## Done when",
    "",
    "- the suite is green",
  ].join("\n");
  const found = extractRequirements(spec, "SPEC.md");
  expect(found.constraints.map((c) => c.text)).toEqual([
    "Out of scope: Rewriting the scheduler",
    "the suite is green",
  ]);
  for (const constraint of found.constraints) {
    expect(constraint.kind).toBe("semantic");
    expect(constraint.severity).toBe("warn");
  }
  expect(found.constraints.map((c) => c.provenance?.heading)).toEqual([
    "Out of Scope",
    "Done when",
  ]);
});

test("a plan bullet is one constraint, its wrapped lines and nested bullets included", () => {
  // run-6ed7b18b's Done When and Out of Scope, as its plan wrapped and nested them.
  const spec = [
    "# Spec: Roll out nuxt module 9.1.1",
    "",
    "## Done When",
    "",
    "- Six MRs are open, one per consumer in the table above. Each moves its include to 9.1.1, is",
    "  assigned to mk, is linked to FRO-487 through its title, and has a green pipeline.",
    "- support-backoffice's MR also records:",
    "  - the stage deploy under a Helle claim, and",
    "  - the 9.0.0 baseline it was compared",
    "    with.",
    "- Re-run",
    "  the container checks on each consumer after the bump.",
    "- The suite is green.",
    "",
    "## Out of Scope",
    "",
    "- A canary gate between waves; a wave still waits only for the",
    "  Repo runs before it.",
    "",
    "## Further Notes",
    "",
    "- not a requirement,",
    "  nor this line.",
  ].join("\n");
  const found = extractRequirements(spec, "SPEC.md");
  expect(
    found.constraints.map(({ text, provenance }) => [text, provenance?.heading, provenance?.line]),
  ).toEqual([
    [
      "Six MRs are open, one per consumer in the table above. Each moves its include to 9.1.1, is assigned to mk, is linked to FRO-487 through its title, and has a green pipeline.",
      "Done When",
      5,
    ],
    [
      "support-backoffice's MR also records: the stage deploy under a Helle claim, and the 9.0.0 baseline it was compared with.",
      "Done When",
      7,
    ],
    ["Re-run the container checks on each consumer after the bump.", "Done When", 11],
    ["The suite is green.", "Done When", 13],
    [
      "Out of scope: A canary gate between waves; a wave still waits only for the Repo runs before it.",
      "Out of Scope",
      17,
    ],
  ]);
  // A one-line bullet is what it always was, id included.
  expect(found.constraints[3]?.id).toBe(constraintId("The suite is green."));
});

/** A constraint the Run's own planner wrote into `plan/SPEC.md`. */
const fromOwnPlan = (text: string) => ({
  id: text,
  kind: "semantic" as const,
  text,
  severity: "warn" as const,
  source: "plan" as const,
  provenance: { file: "plan/SPEC.md", heading: "Done when", line: 3 },
});

test("following the plan adds and removes only its own constraints", () => {
  const human = { ...fromOwnPlan("h"), source: "human" as const, provenance: undefined };
  const planDir = {
    ...fromOwnPlan("d"),
    provenance: { file: "SPEC.md", heading: "Done when", line: 3 },
  };
  const intent = seedIntent("r1", { constraints: [human, planDir, fromOwnPlan("A")] });
  const next = followPlan(intent, [fromOwnPlan("B")], "2026-09-30T00:00:00Z");
  expect(next.constraints.map((c) => c.id).toSorted()).toEqual(["B", "d", "h"]);
  expect(next.version).toBe(intent.version + 2);
  expect(next.history.slice(-2).map((entry) => entry.by)).toEqual([PLAN_AUTHOR, PLAN_AUTHOR]);
  expect(next.authority).toEqual(intent.authority);
});

test("a constraint a human removed is never brought back by the plan", () => {
  const seeded = seedIntent("r1", { constraints: [fromOwnPlan("A")] });
  const intent = amend(
    seeded,
    { kind: "remove-constraint", id: "A" },
    "cli:x",
    "2026-09-30T00:00:00Z",
  );
  expect(followPlan(intent, [fromOwnPlan("A")], "2026-09-30T00:01:00Z")).toBe(intent);
});

test("a bullet the plan repeats is one amendment", () => {
  const intent = seedIntent("r1", {});
  const next = followPlan(intent, [fromOwnPlan("A"), fromOwnPlan("A")], "2026-09-30T00:00:00Z");
  expect(next.version).toBe(intent.version + 1);
});

test("following an unchanged plan changes nothing", () => {
  const found = [fromOwnPlan("A"), fromOwnPlan("B")];
  const once = followPlan(seedIntent("r1", {}), found, "2026-09-30T00:00:00Z");
  expect(followPlan(once, found, "2026-09-30T00:01:00Z")).toBe(once);
});

test("what the human typed beats a workspace default, and a default grants only boundary correction", () => {
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
  expect(intent.authority.auto_correct).toBe(true);
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

test(
  "a started Run has its Intent before its work runs, and one started from it inherits it",
  () =>
    hosted("hw-intent-seed-", ({ world }) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const uuid = (yield* Crypto.Crypto).randomUUIDv4;
        const human = { kind: "semantic", severity: "warn", source: "human" } as const;
        const started = yield* client
          .start({
            project: world.project,
            id: "hello",
            request: yield* uuid,
            input: { name: "seed" },
            intent: {
              goal: "greet whoever asks",
              constraints: [{ ...human, id: "short", text: "keep it short" }],
              defaults: {
                constraints: [
                  {
                    ...human,
                    id: "tone",
                    text: "stay polite",
                    source: "workspace-default",
                    since: 1,
                  },
                  {
                    ...human,
                    id: "short",
                    text: "be brief",
                    source: "workspace-default",
                    since: 1,
                  },
                ],
                authority: { ...DEFAULT_AUTHORITY, auto_correct: true },
              },
            },
          })
          .pipe(Effect.orDie);
        const seeded = yield* readIntent(runDir(world.state, started.runId));
        expect(seeded?.version).toBe(1);
        expect(seeded?.goal).toBe("greet whoever asks");
        // What was named at launch replaces the workspace's own entry with the same id.
        expect(seeded?.constraints.map((one) => `${one.id}: ${one.text}`)).toEqual([
          "tone: stay polite",
          "short: keep it short",
        ]);
        expect(seeded?.authority.auto_correct).toBe(true);

        const child = yield* client
          .start({
            project: world.project,
            id: "hello",
            request: yield* uuid,
            // No goal of its own, so the parent's is the one it works to.
            input: { name: "" },
            parent: started.runId,
          })
          .pipe(Effect.orDie);
        const inherited = yield* readIntent(runDir(world.state, child.runId));
        expect(inherited?.goal).toBe("greet whoever asks");
        expect(inherited?.parent?.run).toBe(started.runId);
        expect(inherited?.constraints.map((one) => `${one.source}:${one.id}`)).toEqual([
          "parent:tone",
          "parent:short",
        ]);
        yield* until(
          () => client.run({ runId: child.runId }).pipe(Effect.orDie),
          (view) => view !== null && isSettled(view),
        );
      }),
    ),
  60_000,
);
