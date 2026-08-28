import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { forkDefinition } from "../src/fork";
import { bodySections, contentHash, isStale, layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
import { FALLBACK_DEFAULTS } from "../src/config";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
  installBaseline(rig);
});

afterEach(async () => {
  await rig.close();
});

test("a fork is a stub that extends the original and names one step", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("review")!;
  expect(source.layer).toBe("baseline");

  const result = forkDefinition(source.path, "workflows", rig.configDir, {
    step: "review",
    section: bodySections(source.body).sections.get("review"),
  });

  expect(result.ok).toBe(true);
  expect(result.path).toBe(join(rig.configDir, "workflows", "review.md"));
  const text = readFileSync(result.path, "utf8");
  expect(text).toContain("extends: review");
  expect(text).toContain("  - id: review");
  expect(text).toContain("## review");
  // The step's own prompt comes along, so there is something to edit.
  expect(text).toContain("Review against the project's own standards");

  // It wins by name, and everything it does not name is still the baseline's.
  const forked = loadDefinitions(layers(env)).workflows.get("review")!;
  expect(forked.layer).toBe("user");
  expect(forked.extends).toBe("review");
  expect(forked.title).toBe(source.title);
  expect(forked.steps.map((s) => s.id)).toEqual(source.steps.map((s) => s.id));
  expect(forked.inputs).toEqual(source.inputs);
});

test("a full copy is the whole file, and records what it copied", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("review")!;
  const before = readFileSync(source.path, "utf8");

  const result = forkDefinition(source.path, "workflows", rig.configDir, { full: true });

  expect(result.ok).toBe(true);
  expect(result.message).toContain("no longer follows the original");
  const text = readFileSync(result.path, "utf8");
  expect(text).toContain(`forked_from_hash: ${contentHash(before)}`);
  // Everything else is the file, byte for byte, after that one line.
  expect(text.replace(/^forked_from_hash: .*\n/m, "")).toBe(before);

  const forked = loadDefinitions(layers(env)).workflows.get("review")!;
  expect(forked.extends).toBeUndefined();
  expect(isStale(forked)).toBe(false);
});

test("a full copy whose original has changed since is stale", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("review")!;

  forkDefinition(source.path, "workflows", rig.configDir, { full: true });
  expect(isStale(loadDefinitions(layers(env)).workflows.get("review")!)).toBe(false);

  // The baseline moves on, which is exactly what a full copy cannot follow.
  Bun.spawnSync(["sh", "-c", `printf '\n<!-- a later change -->\n' >> ${source.path}`]);

  expect(isStale(loadDefinitions(layers(env)).workflows.get("review")!)).toBe(true);
});

test("forking a persona into the project layer changes every workflow that uses it", () => {
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));
  const reviewer = defs.personas.get("reviewer")!;

  const result = forkDefinition(reviewer.path, "personas", join(rig.projectDir, ".herdr"), { full: true });
  expect(result.ok).toBe(true);
  Bun.spawnSync(["sh", "-c", `printf 'Project reviewer.\\n' >> ${result.path}`]);

  const after = loadDefinitions(layers(env));
  expect(after.personas.get("reviewer")!.layer).toBe("project");
  expect(after.personas.get("reviewer")!.body).toContain("Project reviewer.");
  // implement embeds review, whose reviewers and synthesiser use that persona.
  const wf = resolveWorkflow("implement", after, FALLBACK_DEFAULTS);
  expect(wf.steps.filter((s) => s.persona === "reviewer").map((s) => s.id)).toEqual([
    "review",
    "review.synthesize",
  ]);
});

test("forking never overwrites an existing fork", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("plan")!;

  expect(forkDefinition(source.path, "workflows", rig.configDir).ok).toBe(true);
  Bun.spawnSync(["sh", "-c", `printf 'edited\\n' >> ${join(rig.configDir, "workflows", "plan.md")}`]);

  const again = forkDefinition(source.path, "workflows", rig.configDir);

  expect(again.ok).toBe(false);
  expect(again.message).toContain("already exists — edit it instead");
  expect(readFileSync(again.path, "utf8")).toContain("edited");
});

test("forking a definition into the layer it already lives in is refused", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("plan")!;

  forkDefinition(source.path, "workflows", rig.configDir);
  const forked = loadDefinitions(layers(env)).workflows.get("plan")!;

  const result = forkDefinition(forked.path, "workflows", rig.configDir);

  expect(result.ok).toBe(false);
  expect(result.message).toBe("plan.md is already in that layer");
});

test("a fork of the baseline leaves the baseline file untouched", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("implement")!;
  const before = readFileSync(source.path, "utf8");

  forkDefinition(source.path, "workflows", join(rig.projectDir, ".herdr"));
  Bun.spawnSync(["sh", "-c", `printf 'changed\\n' >> ${join(rig.projectDir, ".herdr", "workflows", "implement.md")}`]);

  expect(readFileSync(source.path, "utf8")).toBe(before);
  expect(existsSync(join(rig.projectDir, ".herdr", "workflows", "implement.md"))).toBe(true);
});
