// The baseline definitions themselves: they must load, validate, and say what
// ADR-0002 and the design say they say.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_DEFAULTS } from "../src/config";
import { skillsIn } from "../src/template";
import { layerSet } from "./support/defs";
import { loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";

const ROOT = new URL("../", import.meta.url).pathname;

function baseline() {
  return loadDefinitions(layerSet(ROOT, join(ROOT, "no-user"), join(ROOT, "no-project")));
}

function definitionFiles(): string[] {
  return ["workflows", "personas"].flatMap((kind) =>
    readdirSync(join(ROOT, kind))
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(ROOT, kind, f)),
  );
}

test("every baseline definition loads and validates", () => {
  const defs = baseline();

  expect(defs.errors).toEqual([]);
  for (const name of defs.workflows.keys()) {
    const wf = resolveWorkflow(name, defs, FALLBACK_DEFAULTS);
    expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
  }
});

test("no baseline definition mentions tasks/ or .scratch/ — plans live in the run dir", () => {
  const offenders: string[] = [];
  for (const path of definitionFiles()) {
    const text = readFileSync(path, "utf8");
    if (/tasks\/|\.scratch\//.test(text)) offenders.push(path);
  }

  expect(offenders).toEqual([]);
});

test("the baseline personas are the four the design names, and each names its skills", () => {
  const defs = baseline();

  expect([...defs.personas.keys()].sort()).toEqual(["architect", "implementer", "planner", "reviewer"]);
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
  expect(skillsIn(defs.personas.get("architect")!.body)).toContain("improve-codebase-architecture");
});

test("every persona ends with the Output contract and a skill-missing fallback", () => {
  for (const persona of baseline().personas.values()) {
    const headings = [...persona.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings.slice(-2)).toEqual(["Output", "Fallback"]);
    const fallback = persona.body.slice(persona.body.lastIndexOf("## Fallback")).trim();
    expect(fallback.split("\n").length).toBeGreaterThan(1);
    expect(fallback).toContain("skill");
    expect(persona.body).toContain("OUTPUT_PATH");
  }
});

test("no definition spells a skill in one harness's syntax", () => {
  const defs = baseline();
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
});

test("every step that names a user-only skill invokes it as a slash command", () => {
  const defs = baseline();
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
        offenders.push(`${name}.${step.id} names ${blocked.join(", ")} but skill: is ${step.skill ?? "unset"}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
