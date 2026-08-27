import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDefaults, type Defaults } from "../../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../../src/definitions";
import { executeRun } from "../../src/engine";
import { Herdr } from "../../src/herdr";
import { inferInputs } from "../../src/inputs";
import { RunStore, type Run } from "../../src/run";
import type { Rig } from "./recorder";

/** Copies the repo's real baseline definitions into the rig's baseline layer. */
export function installBaseline(rig: Rig): void {
  const root = new URL("../../", import.meta.url).pathname;
  cpSync(`${root}workflows`, `${rig.baselineDir}/workflows`, { recursive: true });
  cpSync(`${root}personas`, `${rig.baselineDir}/personas`, { recursive: true });
}

/** A finished `plan` Run with a SPEC, i.e. what `plan-dir` inference looks for. */
export function plannedRun(rig: Rig, goal: string): string {
  const env = rig.pluginEnv();
  const run = new RunStore(env.stateDir).create({
    workflow: "plan",
    cwd: env.cwd,
    inputs: { goal },
    inputSources: { goal: "asked" },
    stepIds: ["grill"],
    maxIterations: 5,
    primaryInput: goal,
  });
  run.step("grill").status = "done";
  run.record.status = "done";
  run.save();
  const dir = join(run.dir, "plan");
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "SPEC.md"), `# ${goal}\n`);
  writeFileSync(join(dir, "issues", "01-first.md"), "# 01: first\n");
  return dir;
}

export interface RanRun {
  run: Run;
  status: string;
  lines: string[];
}

/** Everything the picker does after the human has answered, then the engine. */
export async function runWorkflow(
  rig: Rig,
  name: string,
  inputs: Record<string, string>,
  opts: {
    hostPaneId?: string | null;
    defaults?: Partial<Defaults>;
    handoffTimeoutMs?: number;
    outputPollMs?: number;
  } = {},
): Promise<RanRun> {
  const env = rig.pluginEnv();
  const herdr = new Herdr(env);
  const defs = loadDefinitions(layers(env));
  const defaults = { ...loadDefaults(env.configDir), ...opts.defaults };
  const wf = resolveWorkflow(name, defs, defaults);
  const errors = validateWorkflow(wf, defs, defaults);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const inferred = await inferInputs(wf.inputs, { cwd: env.cwd, stateDir: env.stateDir });
  const merged: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const r of inferred) {
    merged[r.name] = inputs[r.name] ?? r.value;
    sources[r.name] = inputs[r.name] !== undefined ? "asked" : r.source;
  }

  const run = new RunStore(env.stateDir).create({
    workflow: wf.name,
    cwd: env.cwd,
    inputs: merged,
    inputSources: sources,
    stepIds: wf.steps.map((s) => s.id),
    maxIterations: wf.maxIterations,
    primaryInput:
      inferred.find((r) => merged[r.name] !== "")?.label ??
      Object.values(merged).find((v) => v !== "") ??
      "run",
  });

  const lines: string[] = [];
  const status = await executeRun({
    herdr,
    defs,
    defaults,
    wf,
    run,
    hostPaneId: opts.hostPaneId === undefined ? "1-0" : opts.hostPaneId,
    out: (line) => lines.push(line),
    handoffTimeoutMs: opts.handoffTimeoutMs,
    outputPollMs: opts.outputPollMs,
  });
  return { run, status, lines };
}

export { inferInputs, resolveWorkflow, loadDefinitions, layers };
