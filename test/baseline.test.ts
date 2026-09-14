// The baseline definitions themselves: they must load, validate, and say what
// ADR-0002 and the design say they say.

import { expect, test } from "bun:test";
import { FALLBACK_DEFAULTS } from "../src/config";
import { skillsIn } from "../src/template";
import { layerSet } from "./support/defs";
import { loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";

import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
const ROOT = new URL("../", import.meta.url).pathname;
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const readText = Effect.fn("test.readText")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path);
});
const definitionFiles = Effect.fn("test.definitionFiles")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const files: string[] = [];
  for (const kind of ["workflows", "personas"]) {
    for (const file of yield* fs.readDirectory(join(ROOT, kind))) {
      if (file.endsWith(".md")) files.push(join(ROOT, kind, file));
    }
  }
  return files;
});

function baseline() {
  return loadDefinitions(layerSet(ROOT, join(ROOT, "no-user"), join(ROOT, "no-project")));
}

test("every baseline definition loads and validates", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* baseline();

      expect(defs.errors).toEqual([]);
      for (const name of defs.workflows.keys()) {
        const wf = resolveWorkflow(name, defs, FALLBACK_DEFAULTS);
        expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
      }
    }),
  ));

test("no baseline definition mentions tasks/ or .scratch/ — plans live in the run dir", () =>
  runEffect(
    Effect.gen(function* () {
      const offenders: string[] = [];
      for (const path of yield* definitionFiles()) {
        const text = yield* readText(path);
        if (/tasks\/|\.scratch\//.test(text)) offenders.push(path);
      }

      expect(offenders).toEqual([]);
    }),
  ));

test("the baseline personas are the four the design names, and each names its skills", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* baseline();

      expect([...defs.personas.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
        "architect",
        "implementer",
        "planner",
        "reviewer",
      ]);
      for (const persona of defs.personas.values()) {
        expect(persona.description).not.toBe("");
        // A skill is named, never spelled: the syntax belongs to the harness.
        expect(skillsIn(persona.body).length).toBeGreaterThan(0);
      }
      // The reviewer runs both review skills and merges them into one Output.
      expect(skillsIn(defs.personas.get("reviewer")!.body)).toEqual([
        "code-review",
        "code-review-and-quality",
      ]);
      expect(skillsIn(defs.personas.get("planner")!.body)).toContain("wayfinder");
      expect(skillsIn(defs.personas.get("architect")!.body)).toContain(
        "improve-codebase-architecture",
      );
    }),
  ));

test("every persona ends with the Output contract and a skill-missing fallback", () =>
  runEffect(
    Effect.gen(function* () {
      for (const persona of (yield* baseline()).personas.values()) {
        const headings = [...persona.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
        expect(headings.slice(-2)).toEqual(["Output", "Fallback"]);
        const fallback = persona.body.slice(persona.body.lastIndexOf("## Fallback")).trim();
        expect(fallback.split("\n").length).toBeGreaterThan(1);
        expect(fallback).toContain("skill");
        expect(persona.body).toContain("OUTPUT_PATH");
      }
    }),
  ));

test("no definition spells a skill in one harness's syntax", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* baseline();
      const bodies = [
        ...[...defs.personas.values()].map((p) => [`persona ${p.name}`, p.body] as const),
        ...[...defs.workflows.values()].map((w) => [`workflow ${w.name}`, w.body] as const),
      ];
      // Every skill the design names. `/name` and `/skill:name` are a harness's own
      // spelling; `{{skill:name}}` is the only way a definition may ask for one.
      const skills = [
        "grill-with-docs",
        "wayfinder",
        "to-spec",
        "to-tickets",
        "implement",
        "tdd",
        "code-review",
        "code-review-and-quality",
        "code-simplification",
        "improve-codebase-architecture",
      ];
      const offenders: string[] = [];
      for (const [what, body] of bodies) {
        for (const name of skills) {
          for (const form of [`/${name}`, `/skill:${name}`]) {
            if (body.includes(form)) offenders.push(`${what}: ${form}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    }),
  ));

test("every step that names a user-only skill invokes it as a slash command", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* baseline();
      // These refuse `disable-model-invocation`, so an agent cannot start them itself.
      const userOnly = new Set([
        "grill-with-docs",
        "to-spec",
        "to-tickets",
        "wayfinder",
        "implement",
        "improve-codebase-architecture",
      ]);

      const offenders: string[] = [];
      for (const name of defs.workflows.keys()) {
        const wf = resolveWorkflow(name, defs, FALLBACK_DEFAULTS);
        for (const step of wf.steps) {
          const named = skillsIn(step.prompt);
          const blocked = named.filter((skill) => userOnly.has(skill));
          if (blocked.length > 0 && !blocked.includes(step.skill ?? "")) {
            offenders.push(
              `${name}.${step.id} names ${blocked.join(", ")} but skill: is ${step.skill ?? "unset"}`,
            );
          }
        }
      }

      expect(offenders).toEqual([]);
    }),
  ));

test("every mutating workflow declares the workspace opt-in, so both front doors reach it", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* baseline();

      // Declared rather than intercepted by one adapter: `startRun` settles it from
      // `--input` and a chaining Choice forwards it, so the CLI, the herdr actions and
      // a chained Run all reach the same opt-in through the same Input.
      for (const name of ["implement", "plan", "architecture"]) {
        const wf = resolveWorkflow(name, defs, FALLBACK_DEFAULTS);
        expect(wf.inputs.workspace).toBe("optional");
      }
      // And the ones that chain `implement` hand their own answer on.
      for (const name of ["plan", "architecture"]) {
        const wf = resolveWorkflow(name, defs, FALLBACK_DEFAULTS);
        const chains = wf.steps
          .flatMap((step) => step.choices ?? [])
          .filter((choice) => choice.run === "implement");
        expect(chains).not.toHaveLength(0);
        for (const choice of chains) {
          expect(choice.inputs?.workspace).toBe("{{inputs.workspace}}");
        }
      }
    }),
  ));

test("every step of implement that commits pushes what the next reader will read", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* baseline();
      const wf = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);
      const prompt = (id: string) => wf.steps.find((step) => step.id === id)!.prompt;

      // The reviewers read the merge request, and a merge request shows the remote.
      for (const id of ["build", "fix"]) {
        expect(prompt(id)).toContain("git push");
        // Five loop iterations must not be five pipelines on unapproved code.
        expect(prompt(id)).toContain("ci.skip");
        expect(prompt(id)).toContain('"pushed"');
      }

      const mr = prompt("mr");
      expect(mr).not.toContain("only step in the whole run allowed to touch the remote");
      expect(mr).toContain("Never merge");
      // A push to an auto-merge branch is a merge, and Collie never merges.
      expect(mr).toContain("auto-merge");
    }),
  ));
