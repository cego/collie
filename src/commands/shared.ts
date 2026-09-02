import { Effect, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { PlatformError } from "effect/PlatformError";
import { layers, loadDefinitions, type PersonaDef, type WorkflowDef } from "../definitions";
import { readChoice, readProgress } from "../driver";
import { currentEnv, type PluginEnv } from "../env";
import { Herdr, type WorkspaceInfo } from "../herdr";
import { reason, unsafePathComponent } from "../naming";
import { err, resolveWorkspace, runStatus, type Failure } from "../operations";
import { InvalidRunState, Run, RunStore } from "../run";
import type { Result } from "../envelope";
import type { YamlMap } from "../yaml";

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
export const selected = Effect.fn("collie.selected")(function* (global: Global) {
  if (Option.isSome(global.workspace)) return global.workspace.value;
  return (yield* currentEnv).workspaceId;
});

export type ContextResolution =
  | {
      readonly _tag: "ResolvedContext";
      readonly env: PluginEnv;
      readonly workspace: WorkspaceInfo | null;
    }
  | { readonly _tag: "ContextFailure"; readonly result: Failure };

const resolvedContext = (env: PluginEnv, workspace: WorkspaceInfo | null): ContextResolution => ({
  _tag: "ResolvedContext",
  env,
  workspace,
});

const contextFailure = (result: Failure): ContextResolution => ({
  _tag: "ContextFailure",
  result,
});

export const context = Effect.fn("collie.context")(function* (
  global: Global,
  resolveLive: boolean,
  requireScope = false,
) {
  const id = yield* selected(global);
  const baseEnv = yield* currentEnv;
  const base = { ...baseEnv, workspaceId: id };
  if (!id)
    return requireScope
      ? contextFailure(err("workspace_required", "This operation requires a workspace."))
      : resolvedContext(base, null);
  if (!resolveLive) return resolvedContext(base, null);

  const lookup = yield* resolveWorkspace(new Herdr(base), base).pipe(
    Effect.map((workspace) => ({ workspace, cause: "" })),
    Effect.catch((cause) => Effect.succeed({ workspace: null, cause: String(cause) })),
  );
  if (!lookup.workspace) {
    const details: YamlMap = { workspace: id };
    if (lookup.cause) details["cause"] = lookup.cause;
    return contextFailure(err("workspace_not_found", `Workspace "${id}" was not found.`, details));
  }
  return resolvedContext(
    {
      ...base,
      workspaceId: id,
      // An explicitly named directory wins; the workspace's is an inference (its
      // panes' shells move), and the caller's own cwd is the last resort.
      cwd:
        (base.cwdExplicit ? base.cwd : "") ||
        lookup.workspace.cwd ||
        base.context.workspace_cwd ||
        base.cwd,
    },
    lookup.workspace,
  );
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
  if (tried?._tag === "ResolvedContext") return tried;
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
export type RunResolution =
  | { readonly _tag: "ResolvedRun"; readonly run: Run }
  | { readonly _tag: "RunFailure"; readonly result: Failure };

const runFailure = (result: Failure): RunResolution => ({ _tag: "RunFailure", result });

export const readRun = Effect.fn("collie.readRun")(function* (
  env: PluginEnv,
  id: string,
  workspace: string | null,
): Effect.fn.Return<RunResolution, never, FileSystem.FileSystem | Path.Path> {
  if (unsafePathComponent(id))
    return runFailure(err("run_not_found", `Run "${id}" was not found.`, { run: id }));
  const loaded = yield* new RunStore(env.stateDir).load(id).pipe(
    Effect.map((run) => ({ _tag: "ResolvedRun" as const, run })),
    Effect.catch((cause) => Effect.succeed(runFailure(notLoaded(id, cause)))),
  );
  if (loaded._tag === "RunFailure") return loaded;
  if (workspace && loaded.run.record.workspace !== workspace) {
    return runFailure(
      err("run_not_found", `Run "${id}" was not found in workspace "${workspace}".`, {
        run: id,
        workspace,
      }),
    );
  }
  return loaded;
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
  const available = yield* layers(env);
  return available[layer].dir;
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

/** Every mutation takes one, and it means the same thing on all of them. */
export const requestIdFlag = Flag.string("request-id").pipe(
  Flag.withDescription("Idempotency key; retrying it returns the first result"),
  Flag.optional,
);

/** The Run a `run` subcommand acts on. */
export const runIdArg = Argument.string("run-id").pipe(
  Argument.withDescription("The Run's id, as `run list` prints it"),
);

export const forkFlags = {
  layer: Flag.choice("layer", ["user", "project"]).pipe(
    Flag.withDescription("Which Layer to fork into: your config dir, or this project's `.herdr/`"),
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Name the fork takes; it wins over the one it forked from"),
  ),
  requestId: requestIdFlag,
};

export const root = Command.make("collie").pipe(
  Command.withSharedFlags({
    workspace: Flag.string("workspace").pipe(
      Flag.withDescription(
        "Scope to this herdr workspace id, and root the run at that workspace's directory",
      ),
      Flag.optional,
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Emit one machine-readable envelope instead of text"),
      Flag.withDefault(false),
    ),
  }),
  Command.withDescription("Discover and run Collie workflows"),
);
