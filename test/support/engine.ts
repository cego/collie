import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDefaults, type Defaults } from "../../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../../src/definitions";
import { executeRun } from "../../src/engine";
import { Herdr } from "../../src/herdr";
import { classifyWorkSource, inferInputs, inputSources, inputValues, targetKind } from "../../src/inputs";
import { RunStore, type Run } from "../../src/run";
import type { Rig } from "./recorder";
import type { EnginePrompts } from "../../src/engine";
import type { PickItem } from "../../src/picker";

/** Copies the repo's real baseline definitions into the rig's baseline layer. */
export function installBaseline(rig: Rig): void {
  const root = new URL("../../", import.meta.url).pathname;
  cpSync(`${root}workflows`, `${rig.baselineDir}/workflows`, { recursive: true });
  cpSync(`${root}personas`, `${rig.baselineDir}/personas`, { recursive: true });
}

/** A menu and a keyboard the tests drive: picks by title, answers in order. */
export function scriptedPrompts(
  picks: (string | null)[],
  answers: string[] = [],
): EnginePrompts & { offered: string[][]; asked: string[] } {
  const offered: string[][] = [];
  const asked: string[] = [];
  return {
    offered,
    asked,
    async menu(items: PickItem[]) {
      offered.push(items.map((i) => i.title));
      if (picks.length === 0) {
        throw new Error(`menu offered [${items.map((i) => i.title).join(", ")}] with no scripted pick left`);
      }
      const want = picks.shift()!;
      if (want === null) return null;
      const found = items.find((i) => i.title === want);
      if (!found) {
        throw new Error(`scripted pick "${want}" was not offered (offered: ${items.map((i) => i.title).join(", ")})`);
      }
      return found;
    },
    async ask(question: string) {
      asked.push(question);
      return answers.shift() ?? null;
    },
  };
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
    prompts?: EnginePrompts;
    env?: Record<string, string>;
    workspaceLabel?: string;
  } = {},
): Promise<RanRun> {
  const env = rig.pluginEnv(opts.env);
  const herdr = new Herdr(env);
  const defs = loadDefinitions(layers(env));
  const defaults = { ...loadDefaults(env.configDir), ...opts.defaults };
  const wf = resolveWorkflow(name, defs, defaults);
  const errors = validateWorkflow(wf, defs, defaults);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const inferred = await inferInputs(wf.inputs, { cwd: env.cwd, stateDir: env.stateDir });
  for (const r of inferred) {
    const override = inputs[r.name];
    if (override === undefined) continue;
    r.value = override;
    r.source = "asked";
    // An overridden Input still owes the prompts its kind, as the picker would.
    if (r.strategy === "work-source") r.kind = classifyWorkSource(override).kind;
    if (r.strategy === "diff-target") r.kind = targetKind(override);
  }
  // Through the same funnel the picker uses, so a run here has the keys a real one has.
  const merged = inputValues(inferred);
  const sources = inputSources(inferred);

  const run = new RunStore(env.stateDir).create({
    workflow: wf.name,
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: opts.workspaceLabel ?? "test",
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
    prompts: opts.prompts,
    env,
  });
  return { run, status, lines };
}

export { inferInputs, resolveWorkflow, loadDefinitions, layers };
