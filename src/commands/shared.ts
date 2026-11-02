import * as Arr from "effect/Array";
import * as ParseResult from "effect/Result";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import type { PlatformServices } from "../platform";
import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Argument, Command, Flag } from "effect/cli";
import { layers, loadDefinitions } from "../definitions";
import { currentEnv, type PluginEnv } from "../env";
import { Herdr, type WorkspaceInfo } from "../herdr";
import { unsafePathComponent } from "../naming";
import { err, resolveWorkspace, type Failure } from "../operations";
import { evidenceDir, runDir, type Given, type RunView } from "../engine";
import { asksRun } from "../lifecycle";
import { FrontDoor } from "../board-model";
import { connect } from "../host";
import { actorName } from "../proposals";
import { taskOfWorkspace } from "../task";
import { attempt, mutation, type CollieError, type Result } from "../envelope";
import type { YamlMap } from "../yaml";
import { isHostName } from "../gitlab-token";

const InputsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

/** Everything on stdin, for `--inputs-json -`, through the Stdio service. */
export const stdinText = Effect.gen(function* () {
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

export type Global = {
  readonly workspace: Option.Option<string>;
  readonly machine: Option.Option<string>;
  readonly json: boolean;
};
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

/** Whom a Run lookup is for, built once from the command line. */
export type RunScope = { readonly task: string | null };

export const runScope = Effect.fn("collie.runScope")(function* (global: Global) {
  return { task: yield* selectedTask(global) } satisfies RunScope;
});

/** Why `view`, on `machine` (null for this one), is out of `scope`'s reach; null where it is not. */
export const outOfReach = (
  view: RunView,
  machine: string | null,
  scope: RunScope,
): Failure | null =>
  // A Task is this Machine's, so a Run on another is never outside it.
  machine === null && scope.task !== null && view.task !== scope.task
    ? err("run_not_found", `Run "${view.runId}" is not part of task "${scope.task}".`, {
        run: view.runId,
        task: scope.task,
      })
    : null;

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

/**
 * Where a command scoped to a workspace works. An explicitly named directory wins. A
 * workspace named with `--workspace` roots it at that workspace's directory; one only
 * inherited from the pane the command was typed in does not, because the directory the
 * caller is standing in says more — the Home's pane rooted every command typed there in
 * its state directory.
 */
export const contextCwd = (at: {
  readonly explicit: string;
  readonly named: boolean;
  readonly workspace: string;
  readonly caller: string;
}) => at.explicit || (at.named ? at.workspace || at.caller : at.caller || at.workspace);

export const context = Effect.fn("collie.context")(function* (
  global: Global,
  resolveLive: boolean,
  requireScope = false,
) {
  const id = yield* selected(global);
  const baseEnv = yield* currentEnv;
  // A terminal's command can show the SSH login that pairs a Machine on first reach.
  const reach = Option.isSome(global.machine)
    ? { pairs: true, machine: global.machine.value }
    : { pairs: true };
  const base = { ...baseEnv, workspaceId: id, ...reach };
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
      cwd: contextCwd({
        explicit: base.cwdExplicit ? base.cwd : "",
        named: Option.isSome(global.workspace),
        workspace: lookup.workspace.cwd || base.context.workspace_cwd || "",
        caller: base.cwd,
      }),
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
    Effect.orElseSucceed(() => null),
  );
  if (tried?._tag === "ResolvedContext") return tried;
  return yield* context({ ...global, workspace: Option.none() }, false);
});

export const definitions = Effect.fn("collie.definitions")(function* (env: PluginEnv) {
  return yield* loadDefinitions(yield* layers(env));
});

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
  scope: RunScope,
): Effect.fn.Return<
  Located,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | PlatformServices
> {
  const missing: Located = {
    _tag: "RunFailure",
    result: err("run_not_found", `Run "${id}" was not found.`, { run: id }),
  };
  if (unsafePathComponent(id)) return missing;
  const dir = runDir(env.stateDir, id);
  const found = yield* asksRun(env, id, (client) => client.run({ runId: id }));
  if (!found.ok) return { _tag: "RunFailure" as const, result: found };
  const view = found.value;
  if (view === null) return missing;
  const refused = outOfReach(view, found.machine, scope);
  if (refused !== null) return { _tag: "RunFailure", result: refused };
  return { _tag: "Hosted", view, dir, evidence: evidenceDir(env.stateDir, id) };
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
    const parsed = Schema.decodeResult(InputsJson)(raw);
    if (ParseResult.isFailure(parsed)) {
      return { ok: false, error: err("invalid_input", "--inputs-json must be a JSON object.") };
    }
    typed = parsed.success;
  }
  const text: Record<string, string> = {};
  for (const entry of values) {
    const at = Option.getOrElse(pipe_(entry, Str.indexOf("=")), () => -1);
    if (at <= 0)
      return { ok: false, error: err("invalid_input", `Input "${entry}" must be key=value.`) };
    text[pipe_(entry, Str.slice(0, at))] = pipe_(entry, Str.slice(at + 1));
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
    machine: Flag.String("machine").pipe(
      Flag.withDescription(
        "Reach this paired Machine, by herdr's name for it, for a command that names no Run",
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
  apply: (env: PluginEnv, id: string) => Effect.Effect<Result, CollieError, PlatformServices>,
) {
  return answering((env) => mutation(env, operation, requestId, (id) => apply(env, id)));
}

/**
 * A human's only at a terminal in a pane herdr does not report as an agent's: an agent's
 * harness has a terminal too. `agentPanes` is null where herdr could not say.
 */
export function cliOrigin(at: {
  readonly terminal: boolean;
  readonly pane: string | null;
  readonly agentPanes: ReadonlyArray<string> | null;
}): "cli" | "cli-tty" {
  if (!at.terminal) return "cli";
  if (at.pane === null) return "cli-tty";
  return at.agentPanes !== null && !at.agentPanes.includes(at.pane) ? "cli-tty" : "cli";
}

/**
 * Which front door this command is. A piped command is still a CLI request, not a Driver.
 *
 * All three streams, not stdout alone: `collie --json confirm … > out.json` is a person
 * at a terminal, and a Driver has a pipe on every one of them.
 */
export const cliDoor = Effect.fn("Shared.cliDoor")(function* (env: PluginEnv) {
  const terminal = Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
  const agents =
    env.paneId === null
      ? []
      : yield* new Herdr(env).agentList().pipe(Effect.orElseSucceed(() => null));
  const agent = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(agents), (present) =>
      Option.getOrUndefined(Arr.findFirst(present, (one) => one.paneId === env.paneId)),
    ),
  );
  if (agent !== undefined) {
    const run = yield* Effect.scoped(
      connect(env.stateDir).pipe(
        Effect.flatMap((client) => client.agentRun({ agent: agent.name })),
      ),
    ).pipe(Effect.orElseSucceed(() => null));
    if (run !== null) return { origin: "agent" as const, from: { run, agent: agent.name } };
  }
  return cliOrigin({
    terminal,
    pane: env.paneId,
    agentPanes:
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(agents), (present_) =>
          Arr.map(present_, (one) => one.paneId),
        ),
      ) ?? null,
  });
});

/** Who is asking, for an operation of this command's own. */
export const actorNow = Effect.fn("Shared.actorNow")(function* (env: PluginEnv, requestId: string) {
  const door = yield* cliDoor(env);
  return Schema.is(FrontDoor)(door) ? { origin: door, requestId } : { ...door, requestId };
});

export { actorName };

/** `--gitlab-host`, which names the GitLab for this run ahead of `GITLAB_HOST` and the setting. */
export const gitlabHostFlag = Flag.String("gitlab-host").pipe(
  Flag.withDescription("The GitLab to work against, over GITLAB_HOST and gitlab_host"),
  Flag.optional,
);

/** `env` with `--gitlab-host` as its `GITLAB_HOST`, or the refusal of one that is not a host. */
export const withGitlabHost = (env: PluginEnv, given: Option.Option<string>) => {
  if (Option.isNone(given)) return env;
  if (!isHostName(given.value)) {
    return err("invalid_input", `--gitlab-host has to be a host name, not "${given.value}".`);
  }
  return { ...env, raw: { ...env.raw, GITLAB_HOST: given.value } };
};
