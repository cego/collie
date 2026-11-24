import * as ParseResult from "effect/Result";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import type { PlatformServices } from "../platform";
import type { FileSystem } from "effect";
import { Effect, Option, Schema, Stdio, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Argument, Command, Flag } from "effect/cli";
import { layers, loadDefinitions } from "../definitions";
import { currentEnv } from "../env";
import type { PluginEnv } from "../env";
import { unsafePathComponent } from "../naming";
import { err, workspaceNamed } from "../operations";
import type { Failure, NamedDirectory } from "../operations";
import { evidenceDir, runDir } from "../engine";
import type { Given, RunView } from "../engine";
import { asksRun, hostTaskOf } from "../lifecycle";
import { outOfReach } from "../run-read";
import type { RunScope } from "../run-read";
import { FrontDoor } from "../board-model";
import { connect } from "../host";
import { actorName } from "../proposals";
import { attempt, mutation } from "../envelope";
import type { Call, CollieError, Result } from "../envelope";
import type { YamlMap } from "../yaml";
import { isHostName } from "../gitlab-token";

const InputsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

export const stdinText = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
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
export const selected = (global: Global) => Effect.succeed(Option.getOrNull(global.workspace));

export const selectedTask = Effect.fn("collie.selectedTask")(function* (global: Global) {
  const env = yield* currentEnv;
  return (yield* hostTaskOf(env, yield* selected(global)))?.id ?? null;
});

export const runScope = Effect.fn("collie.runScope")(function* (global: Global) {
  const env = yield* currentEnv;
  const door = yield* cliDoor(env);
  const returned: RunScope = {
    task: yield* selectedTask(global),
    caller: Schema.is(FrontDoor)(door) ? env.raw["COLLIE_RUN"] || null : door.from.run,
  };
  return returned;
});

export type ContextResolution =
  | {
      readonly _tag: "ResolvedContext";
      readonly env: PluginEnv;
      readonly workspace: NamedDirectory | null;
    }
  | { readonly _tag: "ContextFailure"; readonly result: Failure };

const resolvedContext: (env: PluginEnv, workspace: NamedDirectory | null) => ContextResolution = (
  env,
  workspace,
) => ({
  _tag: "ResolvedContext",
  env,
  workspace,
});

const contextFailure: (result: Failure) => ContextResolution = (result) => ({
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
  const reach = Option.isSome(global.machine)
    ? { pairs: true, machine: global.machine.value }
    : { pairs: true };
  // WARNING: who asked comes from the front door, so a receipt scopes to the Run the agent claim resolves to.
  const base = { ...baseEnv, ...reach, caller: yield* callerIn(baseEnv) };
  if (!id) {
    return requireScope
      ? contextFailure(err("workspace_required", "This operation requires a workspace."))
      : resolvedContext(base, null);
  }
  if (!resolveLive) {
    return resolvedContext(base, null);
  }

  const named = yield* workspaceNamed(base, id);
  const lookup =
    named === null
      ? { workspace: null, cause: "" }
      : "error" in named
        ? { workspace: null, cause: named.error }
        : { workspace: named.found, cause: "" };
  if (!lookup.workspace) {
    const details: YamlMap = { workspace: id };
    if (lookup.cause) {
      details["cause"] = lookup.cause;
    }
    return contextFailure(err("workspace_not_found", `Workspace "${id}" was not found.`, details));
  }
  return resolvedContext(
    { ...base, cwd: base.cwdExplicit ? base.cwd : lookup.workspace.cwd || base.cwd },
    lookup.workspace,
  );
});

export const discoveryContext = Effect.fn("collie.discoveryContext")(function* (global: Global) {
  if (Option.isSome(global.workspace)) {
    return yield* context(global, true);
  }
  // WARNING: an inherited workspace may have closed and there may be no herdr to ask; this is never a reason to fail.
  const tried = yield* context(global, (yield* selected(global)) !== null).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (tried?._tag === "ResolvedContext") {
    return tried;
  }
  return yield* context({ ...global, workspace: Option.none() }, false);
});

export const definitions = Effect.fn("collie.definitions")(function* (env: PluginEnv) {
  return yield* loadDefinitions(yield* layers(env));
});

export type Located =
  | {
      readonly _tag: "Hosted";
      readonly view: RunView;
      readonly dir: string;
      readonly evidence: string;
    }
  | { readonly _tag: "RunFailure"; readonly result: Failure };

export const locateRun: (
  env: PluginEnv,
  id: string,
  scope: RunScope,
) => Effect.Effect<
  Located,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | PlatformServices
> = Effect.fn("collie.locateRun")(function* (env: PluginEnv, id: string, scope: RunScope) {
  const missing: Located = {
    _tag: "RunFailure",
    result: err("run_not_found", `Run "${id}" was not found.`, { run: id }),
  };
  if (unsafePathComponent(id)) {
    return missing;
  }
  const dir = runDir(env.stateDir, id);
  const found = yield* asksRun(env, id, (client) => client.run({ runId: id }));
  if (!found.ok) {
    return { _tag: "RunFailure" as const, result: found };
  }
  const view = found.value;
  if (view === null) {
    return missing;
  }
  const refused = yield* outOfReach(env, view, found.machine, scope);
  if (refused !== null) {
    return { _tag: "RunFailure", result: refused };
  }
  return {
    _tag: "Hosted",
    view,
    dir,
    evidence: evidenceDir(env.stateDir, id),
  };
});

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

export const parseInput: (
  values: ReadonlyArray<string>,
  json: Option.Option<string>,
) => Effect.Effect<ParsedInputs, never, Stdio.Stdio> = Effect.fn("collie.parseInput")(function* (
  values: ReadonlyArray<string>,
  json: Option.Option<string>,
) {
  let typed: Record<string, Schema.Json> = {};
  if (Option.isSome(json)) {
    const raw = json.value === "-" ? yield* stdinText : json.value;
    const parsed = Schema.decodeResult(InputsJson)(raw);
    if (ParseResult.isFailure(parsed)) {
      return {
        ok: false,
        error: err("invalid_input", "--inputs-json must be a JSON object."),
      };
    }
    typed = parsed.success;
  }
  const text: Record<string, string> = {};
  for (const entry of values) {
    const at = Option.getOrElse(pipe_(entry, Str.indexOf("=")), () => -1);
    if (at <= 0) {
      return {
        ok: false,
        error: err("invalid_input", `Input "${entry}" must be key=value.`),
      };
    }
    text[pipe_(entry, Str.slice(0, at))] = pipe_(entry, Str.slice(at + 1));
  }
  return { ok: true, given: { json: typed, text } };
});

export const requestIdFlag = Flag.String("request-id").pipe(
  Flag.withDescription("Idempotency key; retrying it returns the first result"),
  Flag.optional,
);

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
        "Root the command at this directory or checkout under the Projects root",
      ),
      Flag.optional,
    ),
    machine: Flag.String("machine").pipe(
      Flag.withDescription(
        "Reach this paired Machine, by core's name for it, for a command that names no Run",
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

export function answering<E, R>(
  apply: (env: PluginEnv) => Effect.Effect<Result, E, R>,
  resolveLive = false,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, resolveLive);
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
        return yield* apply(resolved.env);
      }),
      global.json,
    );
  });
}

export function mutating(
  call: Call,
  requestId: Option.Option<string>,
  apply: (env: PluginEnv, id: string) => Effect.Effect<Result, CollieError, PlatformServices>,
) {
  return answering((env) => mutation(env, call, requestId, (id) => apply(env, id)));
}

export function cliOrigin(at: { readonly terminal: boolean; readonly agent: boolean }) {
  return at.terminal && !at.agent ? "cli-tty" : "cli";
}

// WARNING: all three streams, not stdout alone: a redirected command is still a person at a terminal.
export const cliDoor = Effect.fn("Shared.cliDoor")(function* (env: PluginEnv) {
  const terminal = Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
  // WARNING: who it is comes from its launch: core names no agent of a process.
  const named = env.raw.COLLIE_AGENT ?? "";
  if (named !== "") {
    const run = yield* Effect.scoped(
      connect(env.stateDir).pipe(Effect.flatMap((client) => client.agentRun({ agent: named }))),
    ).pipe(Effect.orElseSucceed(() => null));
    if (run !== null) {
      return { origin: "agent" as const, from: { run, agent: named } };
    }
  }
  return cliOrigin({ terminal, agent: named !== "" });
});

export const callerIn = Effect.fn("Shared.callerIn")(function* (env: PluginEnv) {
  const door = yield* cliDoor(env);
  return Schema.is(FrontDoor)(door) ? null : door.from.run;
});

export const actorNow = Effect.fn("Shared.actorNow")(function* (env: PluginEnv, requestId: string) {
  const door = yield* cliDoor(env);
  return Schema.is(FrontDoor)(door) ? { origin: door, requestId } : { ...door, requestId };
});

export { actorName };

export const gitlabHostFlag = Flag.String("gitlab-host").pipe(
  Flag.withDescription("The GitLab to work against, over GITLAB_HOST and gitlab_host"),
  Flag.optional,
);

export const withGitlabHost = (env: PluginEnv, given: Option.Option<string>) => {
  if (Option.isNone(given)) {
    return env;
  }
  if (!isHostName(given.value)) {
    return err("invalid_input", `--gitlab-host has to be a host name, not "${given.value}".`);
  }
  return { ...env, raw: { ...env.raw, GITLAB_HOST: given.value } };
};
