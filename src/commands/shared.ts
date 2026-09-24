import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { PlatformError } from "effect/PlatformError";
import { layers, loadDefinitions, type PersonaDef } from "../definitions";
import { currentEnv, type PluginEnv } from "../env";
import { Herdr, type WorkspaceInfo } from "../herdr";
import { reason, unsafePathComponent } from "../naming";
import { err, resolveWorkspace, type Failure } from "../operations";
import { evidenceDir, runDir, type Given, type RunView } from "../engine";
import { runView } from "../lifecycle";
import { actorName, type Actor } from "../proposals";
import { taskOfWorkspace } from "../task";
import { branchListed } from "../worktree";
import { attempt, mutation, type CollieError, type Result } from "../envelope";
import type { YamlMap } from "../yaml";

const InputsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

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

/**
 * What a Run lookup is scoped to. Runs belong to Tasks, not to whichever workspace a
 * command was typed in, so the scope is the Task whose workspace is selected — and
 * nothing at all where that workspace is not a Task's. A human who starts a Run from
 * their project workspace can still wait on it from there.
 */
export const selectedTask = Effect.fn("collie.selectedTask")(function* (global: Global) {
  const env = yield* currentEnv;
  return (yield* taskOfWorkspace(env.stateDir, yield* selected(global)))?.id ?? null;
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

/**
 * A Run named on the command line, with the work it produced and the evidence filed about
 * it, or the reason the caller cannot have it.
 */
export type Located =
  | {
      readonly _tag: "Hosted";
      readonly view: RunView;
      readonly dir: string;
      readonly evidence: string;
    }
  | { readonly _tag: "RunFailure"; readonly result: Failure };

/** Which of those this id is. */
export const locateRun = Effect.fn("collie.locateRun")(function* (
  env: PluginEnv,
  id: string,
  /** The Task this lookup is scoped to; null scopes to nothing, as `selectedTask` says. */
  task: string | null,
): Effect.fn.Return<
  Located,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const missing: Located = {
    _tag: "RunFailure",
    result: err("run_not_found", `Run "${id}" was not found.`, { run: id }),
  };
  if (unsafePathComponent(id)) return missing;
  const dir = runDir(env.stateDir, id);
  const view = yield* runView(env, id);
  if (view === null || !("runId" in view)) return missing;
  if (task !== null && view.task !== task) return outsideTask(id, task);
  return { _tag: "Hosted", view, dir, evidence: evidenceDir(env.stateDir, id) };
});

const outsideTask = (id: string, task: string): Located => ({
  _tag: "RunFailure",
  result: err("run_not_found", `Run "${id}" is not part of task "${task}".`, { run: id, task }),
});

/** What a located Run is called and what it was for. */
export function runFacts(located: Extract<Located, { _tag: "Hosted" }>) {
  return {
    id: located.view.runId,
    workflow: located.view.workflow,
    project: located.view.project,
    task: located.view.task,
    outcome: located.view.outcome,
    created: located.view.created,
  };
}

export const layerDir = Effect.fn("collie.layerDir")(function* (
  env: PluginEnv,
  layer: "user" | "project",
) {
  const available = yield* layers(env);
  return available[layer].dir;
});

type ParsedInputs = { ok: true; given: Given } | { ok: false; error: Result };

export const parseInput = Effect.fn("collie.parseInput")(function* (
  values: ReadonlyArray<string>,
  json: Option.Option<string>,
): Effect.fn.Return<ParsedInputs, never, Stdio.Stdio> {
  let typed: Record<string, Schema.Json> = {};
  if (Option.isSome(json)) {
    const raw = json.value === "-" ? yield* stdinText : json.value;
    try {
      typed = Schema.decodeUnknownSync(InputsJson)(raw);
    } catch {
      return { ok: false, error: err("invalid_input", "--inputs-json must be a JSON object.") };
    }
  }
  const text: Record<string, string> = {};
  for (const entry of values) {
    const at = entry.indexOf("=");
    if (at <= 0)
      return { ok: false, error: err("invalid_input", `Input "${entry}" must be key=value.`) };
    text[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return { ok: true, given: { json: typed, text } };
});

/** Every mutation takes one, and it means the same thing on all of them. */
export const requestIdFlag = Flag.String("request-id").pipe(
  Flag.withDescription("Idempotency key; retrying it returns the first result"),
  Flag.optional,
);

/** The Run a `run` subcommand acts on. */
export const runIdArg = Argument.String("run-id").pipe(
  Argument.withDescription("The Run's id, as `run list` prints it"),
);

export const forkFlags = {
  layer: Flag.Literals("layer", ["user", "project"]).pipe(
    Flag.withDescription("Which Layer to fork into: your config dir, or this project's `.collie/`"),
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("Name the fork takes; it wins over the one it forked from"),
  ),
  requestId: requestIdFlag,
};

export const root = Command.make("collie").pipe(
  Command.withSharedFlags({
    workspace: Flag.String("workspace").pipe(
      Flag.withDescription(
        "Scope to this herdr workspace id, and root the run at that workspace's directory",
      ),
      Flag.optional,
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Emit one machine-readable envelope instead of text"),
      Flag.withDefault(false),
    ),
  }),
  Command.withDescription("Discover and run Collie workflows"),
);

/**
 * A command that answers a question: the global flags, the resolved context, and one
 * envelope. A workspace the caller named that cannot be resolved is refused here rather
 * than in each command.
 */
export function answering<E, R>(
  apply: (env: PluginEnv) => Effect.Effect<Result, E, R>,
  resolveLive = false,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, resolveLive);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* apply(resolved.env);
      }),
      global.json,
    );
  });
}

/**
 * The same for a command that changes something, with the request id around it: a retry
 * of the same id returns the first result rather than acting twice.
 */
export function mutating(
  operation: string,
  requestId: Option.Option<string>,
  apply: (env: PluginEnv, id: string) => Effect.Effect<Result, CollieError, BunServices>,
) {
  return answering((env) => mutation(env, operation, requestId, (id) => apply(env, id)));
}

/**
 * Attribution only: a piped command is still a CLI request, not a Driver.
 *
 * All three streams, not stdout alone: `collie --json confirm … > out.json` is a person
 * at a terminal, and a Driver has a pipe on every one of them.
 */
export function actorNow(requestId: string): Actor {
  const terminal = process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY;
  return { origin: terminal ? "cli-tty" : "cli", requestId };
}

export { actorName };
