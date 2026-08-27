// The baseline definitions themselves: they must load, validate, and say what
// ADR-0002 and the design say they say.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_DEFAULTS } from "../src/config";
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
    expect(persona.body).toMatch(/`\/[a-z-]+`/);
  }
  // The reviewer runs both review skills and merges them into one Output.
  const reviewer = defs.personas.get("reviewer")!.body;
  expect(reviewer).toContain("`/code-review`");
  expect(reviewer).toContain("`/code-review-and-quality`");
  expect(defs.personas.get("planner")!.body).toContain("`/wayfinder`");
  expect(defs.personas.get("architect")!.body).toContain("`/improve-codebase-architecture`");
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
