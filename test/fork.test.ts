import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { forkDefinition } from "../src/fork";
import { layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
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

test("forking into the user layer makes the copy win", () => {
  const env = rig.pluginEnv();
  const source = loadDefinitions(layers(env)).workflows.get("review")!;
  expect(source.layer).toBe("baseline");

  const result = forkDefinition(source.path, "workflows", rig.configDir);

  expect(result.ok).toBe(true);
  expect(result.path).toBe(join(rig.configDir, "workflows", "review.md"));
  expect(readFileSync(result.path, "utf8")).toBe(readFileSync(source.path, "utf8"));
  expect(loadDefinitions(layers(env)).workflows.get("review")!.layer).toBe("user");
});

test("forking a persona into the project layer changes every workflow that uses it", () => {
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));
  const reviewer = defs.personas.get("reviewer")!;

  const result = forkDefinition(reviewer.path, "personas", join(rig.projectDir, ".herdr"));
  expect(result.ok).toBe(true);
  Bun.spawnSync(["sh", "-c", `printf 'Project reviewer.\\n' >> ${result.path}`]);

  const after = loadDefinitions(layers(env));
  expect(after.personas.get("reviewer")!.layer).toBe("project");
  expect(after.personas.get("reviewer")!.body).toContain("Project reviewer.");
  // implement embeds review, which uses the reviewer persona.
  const wf = resolveWorkflow("implement", after, FALLBACK_DEFAULTS);
  expect(wf.steps.filter((s) => s.persona === "reviewer")).toHaveLength(1);
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
