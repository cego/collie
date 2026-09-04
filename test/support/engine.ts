import { Effect, FileSystem, Path } from "effect";
import { loadDefaults, type Defaults } from "../../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../../src/definitions";
import { executeRun } from "../../src/engine";
import { Herdr } from "../../src/herdr";
import type { PluginEnv } from "../../src/env";
import { fakeHerdr } from "./fake-herdr-core";
import type { Rig } from "./recorder";
import {
  classifyWorkSource,
  inferInputs,
  inputSources,
  inputValues,
  targetKind,
} from "../../src/inputs";
import { RunStore, type Run, type WorktreeRecord } from "../../src/run";
import type { EnginePrompts } from "../../src/engine";
import type { PickItem } from "../../src/inputs";

export class EffectFakeHerdr extends Herdr {
  constructor(
    env: PluginEnv,
    private readonly configEnv: Record<string, string | undefined>,
  ) {
    super(env);
  }

  protected override exec(args: string[]) {
    return fakeHerdr(args, this.configEnv);
  }
}

/** Copies the repo's real baseline definitions into the rig's baseline layer. */
export function installBaseline(rig: Rig) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    yield* fs.copy(path.join(root, "workflows"), path.join(rig.baselineDir, "workflows"));
    yield* fs.copy(path.join(root, "personas"), path.join(rig.baselineDir, "personas"));
  });
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
    menu(items: PickItem[]) {
      offered.push(items.map((i) => i.title));
      if (picks.length === 0) {
        return Effect.fail(
          new Error(
            `menu offered [${items.map((i) => i.title).join(", ")}] with no scripted pick left`,
          ),
        );
      }
      const want = picks.shift()!;
      if (want === null) return Effect.succeed(null);
      const found = items.find((i) => i.title === want);
      if (!found) {
        return Effect.fail(
          new Error(
            `scripted pick "${want}" was not offered (offered: ${items.map((i) => i.title).join(", ")})`,
          ),
        );
      }
      return Effect.succeed(found);
    },
    ask(question: string) {
      asked.push(question);
      return Effect.succeed(answers.shift() ?? null);
    },
  };
}

/** A finished `plan` Run with a SPEC, i.e. what `plan-dir` inference looks for. */
export function plannedRun(rig: Rig, goal: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = rig.pluginEnv();
    const run = yield* new RunStore(env.stateDir).create({
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
    yield* run.save();
    const dir = path.join(run.dir, "plan");
    yield* fs.makeDirectory(path.join(dir, "issues"), { recursive: true });
    yield* fs.writeFileString(path.join(dir, "SPEC.md"), `# ${goal}\n`);
    yield* fs.writeFileString(path.join(dir, "issues", "01-first.md"), "# 01: first\n");
    return dir;
  });
}

export interface RanRun {
  run: Run;
  status: string;
  lines: string[];
}

/** Everything the picker does after the human has answered, then the engine. */
export function runWorkflow(
  rig: Rig,
  name: string,
  inputs: Record<string, string>,
  opts: {
    defaults?: Partial<Defaults>;
    handoffTimeoutMs?: number;
    outputPollMs?: number;
    prompts?: EnginePrompts;
    /** For prompts that need the run dir, which only exists once the run does. */
    promptsFor?: (run: Run) => EnginePrompts;
    env?: Record<string, string>;
    workspaceLabel?: string;
    /** What the human answered at launch, by Choice step id. */
    decisions?: Record<string, string>;
    /** The checkout the Run owns, as `startRun` would have recorded it. */
    worktree?: WorktreeRecord | null;
    /**
     * Run a Workflow the way a chained Run and a resumed Driver do: resolved, but never
     * validated. Only for testing what the engine still refuses on its own.
     */
    unvalidated?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const configEnv = rig.env(opts.env);
    const env = rig.pluginEnv(opts.env);
    const herdr = new EffectFakeHerdr(env, configEnv);
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    const defaults = Object.assign(yield* loadDefaults(env.configDir), opts.defaults);
    const wf = resolveWorkflow(name, defs, defaults);
    const errors = opts.unvalidated ? [] : yield* validateWorkflow(wf, defs, defaults);
    if (errors.length > 0) return yield* Effect.fail(new Error(errors.join("\n")));

    const inferred = yield* inferInputs(wf.inputs, { cwd: env.cwd, stateDir: env.stateDir });
    for (const r of inferred) {
      const override = inputs[r.name];
      if (override === undefined) continue;
      r.value = override;
      r.source = "asked";
      if (r.strategy === "work-source") {
        const kind = yield* classifyWorkSource(override).pipe(Effect.map((c) => c.kind));
        r.kind = kind;
      }
      if (r.strategy === "diff-target") {
        const kind = targetKind(override);
        r.kind = kind;
      }
    }
    const merged = inputValues(inferred);
    const sources = inputSources(inferred);

    const run = yield* new RunStore(env.stateDir).create({
      workflow: wf.name,
      cwd: opts.worktree?.path ?? env.cwd,
      session: env.socketPath,
      workspace: env.workspaceId,
      workspaceLabel: opts.workspaceLabel ?? "test",
      worktree: opts.worktree,
      inputs: merged,
      inputSources: sources,
      decisions: opts.decisions,
      stepIds: wf.steps.map((s) => s.id),
      maxIterations: wf.maxIterations,
      primaryInput:
        inferred.find((r) => merged[r.name] !== "")?.label ??
        Object.values(merged).find((v) => v !== "") ??
        "run",
    });

    const lines: string[] = [];
    const status = yield* executeRun({
      herdr,
      defs,
      defaults,
      wf,
      run,
      out: (line) =>
        Effect.sync(() => {
          lines.push(line);
        }),
      handoffTimeoutMs: opts.handoffTimeoutMs,
      outputPollMs: opts.outputPollMs,
      prompts: opts.promptsFor ? opts.promptsFor(run) : opts.prompts,
      env,
    }).pipe(Effect.catch(() => Effect.succeed("failed")));
    return { run, status, lines };
  }).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))));
}

export { inferInputs, resolveWorkflow, loadDefinitions, layers };
