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
