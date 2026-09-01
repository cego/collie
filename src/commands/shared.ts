import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { PlatformError } from "effect/PlatformError";
import { layers, loadDefinitions, type PersonaDef, type WorkflowDef } from "../definitions";
import { readChoice, readProgress } from "../driver";
import { currentEnv, type PluginEnv } from "../env";
import { Herdr, type WorkspaceInfo } from "../herdr";
import { reason, unsafePathComponent } from "../naming";
import { err, runStatus, type Failure } from "../operations";
import { InvalidRunState, Run, RunStore } from "../run";
import type { YamlMap } from "../yaml";
import type { CollieError, Result } from "../envelope";

const InputsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

/** Everything on stdin, for `--inputs-json -`, through the Stdio service. */
const stdinText = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runFold(
      (): string => "",
      (all, chunk) => all + chunk,
    ),
  );
}).pipe(Effect.orDie);
export const UnknownJson = Schema.fromJsonString(Schema.Unknown);
export const PrettyUnknownJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });

export type Global = { readonly workspace: Option.Option<string>; readonly json: boolean };
type CollieServices = BunServices;

export const selected = Effect.fn("collie.selected")(function* (global: Global) {
  if (Option.isSome(global.workspace)) return global.workspace.value;
  return (yield* currentEnv).workspaceId;
});

export const context = Effect.fn("collie.context")(function* (
  global: Global,
  resolveLive: boolean,
  requireScope = false,
): Effect.fn.Return<
  { env: PluginEnv; workspace: WorkspaceInfo | null } | Result,
  CollieError,
  CollieServices
> {
  const id = yield* selected(global);
  const baseEnv = yield* currentEnv;
  const base = { ...baseEnv, workspaceId: id };
  if (!id)
    return requireScope
      ? err("workspace_required", "This operation requires a workspace.")
      : { env: base, workspace: null };
  if (!resolveLive) return { env: base, workspace: null };
  // A herdr that will not answer is a workspace that cannot be resolved, which is what
  // the spec names this code for; the reason it could not be resolved goes in details
  // rather than becoming a different, less useful code.
  const live = yield* new Herdr(base).workspaceList().pipe(
    Effect.map((workspaces) => ({ workspaces, cause: "" })),
    Effect.catch((cause) => Effect.succeed({ workspaces: [], cause: String(cause) })),
  );
  const workspace = live.workspaces.find((item) => item.workspaceId === id);
  if (!workspace) {
    const details: YamlMap = { workspace: id };
    if (live.cause) details["cause"] = live.cause;
    return err("workspace_not_found", `Workspace "${id}" was not found.`, details);
  }
  return {
    workspace,
    env: { ...base, workspaceId: id, cwd: workspace.cwd || base.context.workspace_cwd || base.cwd },
  };
});

/**
 * Where a discovery command looks. The spec makes Workflow and Persona discovery
 * global and reserves `workspace_not_found` for a workspace the caller named, so an id
 * inherited from a pane whose workspace has since closed falls back to no scope rather
 * than failing a listing that needs no workspace at all. Project-layer resolution then
 * uses the process's own directory, which is the best answer available.
 */
export const discoveryContext = Effect.fn("collie.discoveryContext")(function* (global: Global) {
  // Named on the command line: the strict path, so an unresolvable workspace is the
  // caller's error, as the spec requires.
  if (Option.isSome(global.workspace)) return yield* context(global, true);
  // Inherited from the environment: used where it helps, never a reason to fail. It
  // may name a workspace that has closed, and there may be no herdr to ask at all.
  const tried = yield* context(global, (yield* selected(global)) !== null).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  if (tried !== null && !("ok" in tried)) return tried;
  return yield* context({ ...global, workspace: Option.none() }, false);
});

export const definitions = Effect.fn("collie.definitions")(function* (env: PluginEnv) {
  return yield* loadDefinitions(yield* layers(env));
});

export function workflowData(wf: WorkflowDef) {
  return {
    name: wf.name,
    title: wf.title,
    description: wf.description,
    inputs: wf.inputs,
    steps: wf.steps.map((step) => step.id),
    layer: wf.layer,
    path: wf.path,
    extends: wf.extends ?? null,
  };
}

export function personaData(persona: PersonaDef) {
  return {
    name: persona.name,
    description: persona.description,
    body: persona.body,
    layer: persona.layer,
    path: persona.path,
    extends: persona.extends ?? null,
  };
}

/** A Run named on the command line, or the reason the caller cannot have it. */
export const readRun = Effect.fn("collie.readRun")(function* (
  env: PluginEnv,
  id: string,
  workspace: string | null,
) {
  if (unsafePathComponent(id))
    return err("run_not_found", `Run "${id}" was not found.`, { run: id });
  const run = yield* new RunStore(env.stateDir)
    .load(id)
    .pipe(Effect.catch((cause) => Effect.succeed(notLoaded(id, cause))));
  if (!(run instanceof Run)) return run;
  if (workspace && run.record.workspace !== workspace) {
    return err("run_not_found", `Run "${id}" was not found in workspace "${workspace}".`, {
      run: id,
      workspace,
    });
  }
  return run;
});

/**
 * Why a Run would not load. RunStore decodes `run.json`, so a Run that exists but
 * is not a Run is `invalid_state` and anything else is simply absent.
 */
function notLoaded(id: string, cause: Error | PlatformError): Failure {
  if (cause instanceof InvalidRunState)
    return err("invalid_state", `Run "${id}" has invalid persisted state.`, {
      run: id,
      cause: cause.cause,
    });
  return err("run_not_found", `Run "${id}" was not found.`, { run: id });
}

/**
 * The Run directories the store declined to hand back, and why: a `run.json` that will
 * not decode, and one that is not there at all — which is what a Run half-created by
 * `run start` looks like, since the directory is claimed before the record is written.
 */
export const unreadableRuns = Effect.fn("collie.unreadableRuns")(function* (
  store: RunStore,
  readable: ReadonlyArray<Run>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* store.rootEffect;
  if (!(yield* fs.exists(root))) return [];
  // Only the directories the store did not hand back are loaded again. Reading every
  // one a second time was the cost of asking, and there is usually nothing broken.
  const known = new Set(readable.map((run) => run.id));
  const broken: Array<{ run: string; reason: string }> = [];
  for (const name of yield* fs.readDirectory(root)) {
    if (name.startsWith(".") || known.has(name)) continue;
    const loaded = yield* store.load(name).pipe(Effect.result);
    if (loaded._tag === "Failure") broken.push({ run: name, reason: reason(loaded.failure) });
  }
  return broken;
});

export const runData = Effect.fn("collie.runData")(function* (run: Run) {
  return {
    ...run.record,
    status: yield* runStatus(run),
    progress: yield* readProgress(run.dir),
    choice: yield* readChoice(run.dir),
  };
});

export const layerDir = Effect.fn("collie.layerDir")(function* (
  env: PluginEnv,
  layer: "user" | "project",
) {
  const all = yield* layers(env);
  return layer === "user" ? all[1]!.dir : all[2]!.dir;
});

type ParsedInputs = { ok: true; inputs: Record<string, string> } | { ok: false; error: Result };

export const parseInput = Effect.fn("collie.parseInput")(function* (
  values: ReadonlyArray<string>,
  json: Option.Option<string>,
): Effect.fn.Return<ParsedInputs, never, Stdio.Stdio> {
  let parsed: Record<string, string> = {};
  if (Option.isSome(json)) {
    const raw = json.value === "-" ? yield* stdinText : json.value;
    try {
      parsed = Schema.decodeUnknownSync(InputsJson)(raw);
    } catch {
      return { ok: false, error: err("invalid_input", "--inputs-json must be a JSON object.") };
    }
  }
  for (const entry of values) {
    const at = entry.indexOf("=");
    if (at <= 0)
      return { ok: false, error: err("invalid_input", `Input "${entry}" must be key=value.`) };
    parsed[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return { ok: true, inputs: parsed };
});

export const root = Command.make("collie").pipe(
  Command.withSharedFlags({
    workspace: Flag.string("workspace").pipe(
      Flag.withDescription("Scope to this herdr workspace id"),
      Flag.optional,
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Emit one machine-readable envelope instead of text"),
      Flag.withDefault(false),
    ),
  }),
  Command.withDescription("Discover and run Collie workflows"),
);
