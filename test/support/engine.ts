import { Effect, FileSystem, Path } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import type { PlatformError } from "effect/PlatformError";
import { FALLBACK_DEFAULTS, type Defaults } from "../../src/config";
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
import { primaryName } from "../../src/operations";
import { approvedFrom, VerifySpecSchema } from "../../src/verify-spec";
import { Schema } from "effect";

const encodeSpecs = Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)));
import { RunStore, type Run, type WorktreeRecord } from "../../src/run";
import type { EnginePrompts } from "../../src/engine";
import type { CompactionPorts } from "../../src/compaction";
import { testDefaults } from "./compaction";
import type { PickItem, Resolution } from "../../src/inputs";

/**
 * What a Run is named after, exactly as `startRun` works it out. The harness starts
 * Runs without going through it, and a second copy of this here disagreed with the real
 * one — which hid a bug where every nameless Run was named "run".
 */
function named(inferred: Resolution[], merged: Record<string, string>) {
  const settled = inferred.map((r) => ({ ...r, value: merged[r.name] ?? "" }));
  const name = primaryName(settled);
  return { namedAfter: name.value, slugFrom: name.short };
}

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

/**
 * What a project that has written down its verifications looks like: one approved command
 * that passes. The engine's evidence gate runs it itself, so the Run's proof is collected
 * rather than scripted — which is the whole point of the gate.
 */
export function approveVerification(
  rig: Rig,
  spec: { name: string; executable: string; argv?: string[]; cwd?: string } = {
    name: "tests",
    executable: "true",
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(rig.projectDir, ".herdr", "verify.json");
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, encodeSpecs([{ argv: [], cwd: ".", ...spec }]));
  });
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
      namedAfter: goal,
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
    herdr?: Herdr;
    defaults?: Partial<Defaults>;
    handoffTimeoutMs?: number;
    outputPollMs?: number;
    prompts?: EnginePrompts;
    /** One harness's compaction interface, scripted, in place of the real four. */
    compaction?: CompactionPorts;
    compactionWaitMs?: number;
    /** For prompts that need the run dir, which only exists once the run does. */
    promptsFor?: (run: Run) => EnginePrompts;
    /** Set up state the run only has a directory for once it exists, e.g. its Intent. */
    before?: (run: Run) => Effect.Effect<unknown, Error | PlatformError, BunServices>;
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
    const herdr = opts.herdr ?? new EffectFakeHerdr(env, configEnv);
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    const defaults = Object.assign(
      yield* testDefaults(env.configDir),
      // A test that scripts a harness interface is asking for compaction, and gets
      // the shipped default threshold unless it says otherwise.
      opts.compaction ? { compactAtTokens: FALLBACK_DEFAULTS.compactAtTokens } : {},
      opts.defaults,
    );
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
      definition: wf,
      approvedVerifications: yield* approvedFrom({
        cwd: opts.worktree?.path ?? env.cwd,
        configDir: env.configDir,
      }),
      stepIds: wf.steps.map((s) => s.id),
      maxIterations: wf.maxIterations,
      ...named(inferred, merged),
    });

    if (opts.before) yield* opts.before(run);

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
      compaction: opts.compaction,
      compactionWaitMs: opts.compactionWaitMs,
      prompts: opts.promptsFor ? opts.promptsFor(run) : opts.prompts,
      env,
    }).pipe(Effect.catch(() => Effect.succeed("failed")));
    return { run, status, lines };
  }).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))));
}

export { inferInputs, resolveWorkflow, loadDefinitions, layers };
