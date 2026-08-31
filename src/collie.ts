import type { BunServices } from "@effect/platform-bun/BunServices";
import { Cause, Config, Console, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import {
  Argument,
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli";
import type { PlatformError } from "effect/PlatformError";
import {
  bodySections,
  layers,
  loadDefinitions,
  type PersonaDef,
  type WorkflowDef,
} from "./definitions";
import { RUNNER_LOG, readChoice, readProgress } from "./driver";
import { currentEnv, type PluginEnv } from "./env";
import { forkDefinition } from "./fork";
import { Herdr, HerdrError, type WorkspaceInfo } from "./herdr";
import { InvalidRunState, Run, RunStore } from "./run";
import { scopeFor } from "./registry";
import {
  answerRun,
  err,
  newRequestId,
  ExpectedError,
  prepareWorkflow,
  resumeRun,
  runStatus,
  startRun,
  stopRun,
  type Failure,
  type OpResult,
} from "./operations";
import { unsafePathComponent } from "./naming";
import { breakStaleLock, releaseOwnLock, tryClaimLock } from "./lock";
import { YamlMapSchema } from "./yaml";

const ResultBoundary = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown, human: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: ExpectedError }),
]);
const ResultBoundaryJson = Schema.fromJsonString(ResultBoundary);

const ResultJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
    Schema.Struct({ ok: Schema.Literal(false), error: ExpectedError }),
  ]),
);

const InputsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const PrettyUnknownJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });

type Result = OpResult;
type Global = { readonly workspace: Option.Option<string>; readonly json: boolean };
type CollieError = Config.ConfigError | Error | HerdrError | PlatformError;
type CollieServices = BunServices;

const pid = Effect.sync(() => globalThis.process.pid);

function print(result: Result, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${Schema.encodeSync(ResultJson)(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error })}\n`,
    );
  } else {
    process.stdout.write(`${result.ok ? result.human : result.error.message}\n`);
  }
  if (!result.ok)
    process.exitCode = ["invalid_input", "needs_input", "workspace_required"].includes(
      result.error.code,
    )
      ? 2
      : 1;
}

const printResult = (result: Result, json: boolean) => Effect.sync(() => print(result, json));

function attempt<E, R>(operation: Effect.Effect<Result, E, R>, json: boolean) {
  return operation.pipe(
    Effect.catch((cause) => Effect.succeed(err("operation_failed", String(cause)))),
    Effect.flatMap((result) => printResult(result, json)),
  );
}

const selected = Effect.fn("collie.selected")(function* (global: Global) {
  if (Option.isSome(global.workspace)) return global.workspace.value;
  return (yield* currentEnv).workspaceId;
});

const context = Effect.fn("collie.context")(function* (
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
  const workspace = (yield* new Herdr(base).workspaceList()).find(
    (item) => item.workspaceId === id,
  );
  if (!workspace)
    return err("workspace_not_found", `Workspace "${id}" was not found.`, { workspace: id });
  return {
    workspace,
    env: { ...base, workspaceId: id, cwd: workspace.cwd || base.context.workspace_cwd || base.cwd },
  };
});

const definitions = Effect.fn("collie.definitions")(function* (env: PluginEnv) {
  return yield* loadDefinitions(yield* layers(env));
});

function workflowData(wf: WorkflowDef) {
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

function personaData(persona: PersonaDef) {
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
const readRun = Effect.fn("collie.readRun")(function* (
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

const runData = Effect.fn("collie.runData")(function* (run: Run) {
  return {
    ...run.record,
    status: yield* runStatus(run),
    progress: yield* readProgress(run.dir),
    choice: yield* readChoice(run.dir),
  };
});

const requestId = Effect.fn("collie.requestId")(function* (value: Option.Option<string>) {
  return Option.isSome(value) ? value.value : yield* newRequestId();
});

const receiptPath = Effect.fn("collie.receiptPath")(function* (
  env: PluginEnv,
  operation: string,
  id: string,
) {
  const path = yield* Path.Path;
  return path.join(env.stateDir, "requests", operation, `${encodeURIComponent(id)}.json`);
});

/** A receipt this version cannot read is a failure to report, never a defect to die on. */
const readReceipt = Effect.fn("collie.readReceipt")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeUnknownEffect(ResultBoundaryJson)(yield* fs.readFileString(file));
});

function withRequestId(result: Result, id: string): Result {
  if (!result.ok) return result;
  const data = Option.getOrElse(Schema.decodeUnknownOption(YamlMapSchema)(result.data), () => ({}));
  return { ...result, data: { ...data, requestId: id } };
}

const mutation = Effect.fn("collie.mutation")(function* (
  env: PluginEnv,
  operation: string,
  requested: Option.Option<string>,
  apply: (id: string) => Effect.Effect<Result, CollieError, CollieServices>,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const id = yield* requestId(requested);
  const path = yield* receiptPath(env, operation, id);
  if (yield* fs.exists(path)) return yield* readReceipt(path);
  yield* fs.makeDirectory(pathSvc.dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  if (
    !(yield* tryClaimLock(lock)) &&
    (!(yield* breakStaleLock(lock)) || !(yield* tryClaimLock(lock)))
  ) {
    if (yield* fs.exists(path)) return yield* readReceipt(path);
    return err("operation_failed", `Request "${id}" is already in progress.`, { requestId: id });
  }
  try {
    const result = yield* apply(id);
    const withRequest = withRequestId(result, id);
    const tmp = `${path}.${yield* pid}.tmp`;
    yield* fs.writeFileString(tmp, `${Schema.encodeSync(ResultBoundaryJson)(withRequest)}\n`);
    yield* fs.rename(tmp, path);
    return withRequest;
  } finally {
    yield* releaseOwnLock(lock);
  }
});

const layerDir = Effect.fn("collie.layerDir")(function* (
  env: PluginEnv,
  layer: "user" | "project",
) {
  const all = yield* layers(env);
  return layer === "user" ? all[1]!.dir : all[2]!.dir;
});

type ParsedInputs = { ok: true; inputs: Record<string, string> } | { ok: false; error: Result };

const parseInput = Effect.fn("collie.parseInput")(function* (
  values: ReadonlyArray<string>,
  json: Option.Option<string>,
): Effect.fn.Return<ParsedInputs, never> {
  let parsed: Record<string, string> = {};
  if (Option.isSome(json)) {
    const raw = json.value === "-" ? yield* Effect.promise(() => Bun.stdin.text()) : json.value;
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

const root = Command.make("collie").pipe(
  Command.withSharedFlags({
    workspace: Flag.string("workspace").pipe(Flag.optional),
    json: Flag.boolean("json").pipe(Flag.withDefault(false)),
  }),
  Command.withDescription("Discover and run Collie workflows"),
);

const workflowList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, (yield* selected(global)) !== null);
        if ("ok" in resolved) return resolved;
        const defs = yield* definitions(resolved.env);
        const workflows = [...defs.workflows.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(workflowData);
        return {
          ok: true,
          data: { workflows, errors: defs.errors },
          human:
            workflows.map((item) => `${item.name}\t${item.description}`).join("\n") ||
            "No workflows found.",
        };
      }),
      global.json,
    );
  }),
);

const workflowShow = Command.make(
  "show",
  { workflow: Argument.string("workflow") },
  ({ workflow }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, (yield* selected(global)) !== null);
          if ("ok" in resolved) return resolved;
          const wf = (yield* definitions(resolved.env)).workflows.get(workflow);
          return wf
            ? {
                ok: true,
                data: { workflow: workflowData(wf) },
                human: `${wf.title}\n${wf.description}\nInputs: ${Schema.encodeSync(UnknownJson)(wf.inputs)}`,
              }
            : err("workflow_not_found", `Workflow "${workflow}" was not found.`);
        }),
        global.json,
      );
    }),
);

const forkFlags = {
  layer: Flag.choice("layer", ["user", "project"]),
  name: Flag.string("name"),
  requestId: Flag.string("request-id").pipe(Flag.optional),
};

const workflowFork = Command.make(
  "fork",
  {
    workflow: Argument.string("workflow"),
    ...forkFlags,
    mode: Flag.choice("mode", ["extends", "copy"]),
    step: Flag.string("step").pipe(Flag.optional),
  },
  ({ workflow, layer, mode, name, requestId: request, step }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, layer === "project", layer === "project");
          if ("ok" in resolved) return resolved;
          return yield* mutation(resolved.env, "workflow-fork", request, (id) =>
            Effect.gen(function* () {
              void id;
              const wf = (yield* definitions(resolved.env)).workflows.get(workflow);
              if (!wf) return err("workflow_not_found", `Workflow "${workflow}" was not found.`);
              if (unsafePathComponent(name))
                return err("invalid_input", `"${name}" is not a valid Workflow name.`);
              const pathSvc = yield* Path.Path;
              const fs = yield* FileSystem.FileSystem;
              const target = pathSvc.join(
                yield* layerDir(resolved.env, layer),
                "workflows",
                `${name}.md`,
              );
              if (yield* fs.exists(target))
                return err("target_exists", `${target} already exists.`, { path: target });
              const pickedStep = Option.isSome(step) ? step.value : undefined;
              if (pickedStep && !wf.steps.some((item) => item.id === pickedStep)) {
                return err("invalid_input", `Workflow "${workflow}" has no Step "${pickedStep}".`);
              }
              const result = yield* forkDefinition(
                wf.path,
                "workflows",
                yield* layerDir(resolved.env, layer),
                {
                  name,
                  full: mode === "copy",
                  step: pickedStep,
                  section: pickedStep ? bodySections(wf.body).sections.get(pickedStep) : undefined,
                },
              );
              if (!result.ok) return err("target_exists", result.message, { path: result.path });
              return {
                ok: true,
                data: { path: result.path, name, layer, mode },
                human: `Forked ${workflow} to ${result.path}.`,
              };
            }),
          );
        }),
        global.json,
      );
    }),
);

const workflow = Command.make("workflow").pipe(
  Command.withSubcommands([workflowList, workflowShow, workflowFork]),
);

const personaList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, (yield* selected(global)) !== null);
        if ("ok" in resolved) return resolved;
        const defs = yield* definitions(resolved.env);
        const personas = [...defs.personas.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(personaData);
        return {
          ok: true,
          data: { personas, errors: defs.errors },
          human:
            personas.map((item) => `${item.name}\t${item.description}`).join("\n") ||
            "No personas found.",
        };
      }),
      global.json,
    );
  }),
);

const personaShow = Command.make("show", { persona: Argument.string("persona") }, ({ persona }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, (yield* selected(global)) !== null);
        if ("ok" in resolved) return resolved;
        const found = (yield* definitions(resolved.env)).personas.get(persona);
        return found
          ? {
              ok: true,
              data: { persona: personaData(found) },
              human: `${found.name}\n${found.description}\n\n${found.body}`,
            }
          : err("persona_not_found", `Persona "${persona}" was not found.`);
      }),
      global.json,
    );
  }),
);

const personaFork = Command.make(
  "fork",
  {
    persona: Argument.string("persona"),
    ...forkFlags,
  },
  ({ persona, layer, name, requestId: request }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, layer === "project", layer === "project");
          if ("ok" in resolved) return resolved;
          return yield* mutation(resolved.env, "persona-fork", request, (_id) =>
            Effect.gen(function* () {
              const found = (yield* definitions(resolved.env)).personas.get(persona);
              if (!found) return err("persona_not_found", `Persona "${persona}" was not found.`);
              if (unsafePathComponent(name))
                return err("invalid_input", `"${name}" is not a valid Persona name.`);
              const result = yield* forkDefinition(
                found.path,
                "personas",
                yield* layerDir(resolved.env, layer),
                {
                  name,
                  full: true,
                },
              );
              if (!result.ok) return err("target_exists", result.message, { path: result.path });
              return {
                ok: true,
                data: { path: result.path, name, layer },
                human: `Forked ${persona} to ${result.path}.`,
              };
            }),
          );
        }),
        global.json,
      );
    }),
);

const persona = Command.make("persona").pipe(
  Command.withSubcommands([personaList, personaShow, personaFork]),
);

const runStart = Command.make(
  "start",
  {
    workflow: Argument.string("workflow"),
    input: Flag.string("input").pipe(Flag.between(0, 100)),
    inputsJson: Flag.string("inputs-json").pipe(Flag.optional),
    requestId: Flag.string("request-id").pipe(Flag.optional),
  },
  ({ workflow, input, inputsJson, requestId: request }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, (yield* selected(global)) !== null);
          if ("ok" in resolved) return resolved;
          const explicit = yield* parseInput(input, inputsJson);
          if (!explicit.ok) return explicit.error;
          return yield* mutation(resolved.env, "run-start", request, (_id) =>
            Effect.gen(function* () {
              const prepared = yield* prepareWorkflow(resolved.env, workflow);
              if (!prepared.ok) return prepared;
              const wf = prepared.workflow;
              for (const item of prepared.resolutions) {
                const value = explicit.inputs[item.name];
                if (value === undefined) continue;
                item.value = value;
                item.source = "explicit";
                item.needsAsking = false;
                delete item.candidates;
              }
              // A command line cannot be asked; an unsettled Input is the caller's to give.
              const unresolved = prepared.resolutions.filter(
                (item) => item.needsAsking || item.candidates,
              );
              if (unresolved.length > 0) {
                return err(
                  "needs_input",
                  `${workflow} needs input.`,
                  Schema.decodeUnknownSync(YamlMapSchema)({
                    inputs: unresolved.map((item) => ({
                      name: item.name,
                      candidates: item.candidates ?? [],
                      question: item.question,
                    })),
                    schema: wf.inputs,
                  }),
                );
              }
              const run = yield* startRun(resolved.env, {
                workflow: wf,
                resolutions: prepared.resolutions,
                workspace: resolved.workspace,
              });
              return {
                ok: true,
                data: { runId: run.id, run: yield* runData(run) },
                human: `Started run ${run.id}.`,
              };
            }),
          );
        }),
        global.json,
      );
    }),
);

const runList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if ("ok" in resolved) return resolved;
        const workspace = yield* selected(global);
        const store = new RunStore(resolved.env.stateDir);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* store.rootEffect;
        // A listing hides a broken Run; `run list` is the one place that has to say
        // so, because an agent reading it would otherwise never learn the Run exists.
        if (yield* fs.exists(root)) {
          for (const name of (yield* fs.readDirectory(root)).filter(
            (entry) => !entry.startsWith("."),
          )) {
            const loaded = yield* store.load(name).pipe(Effect.result);
            if (loaded._tag === "Failure" && loaded.failure instanceof InvalidRunState)
              return notLoaded(name, loaded.failure);
          }
        }
        const runs = (yield* store.list()).filter(
          (item) => !workspace || item.record.workspace === workspace,
        );
        const data = yield* Effect.all(runs.map(runData));
        return {
          ok: true,
          data: { runs: data },
          human:
            data.map((item) => `${item.id}\t${item.status}\t${item.workflow}`).join("\n") ||
            "No runs found.",
        };
      }),
      global.json,
    );
  }),
);

function runLookup(command: "show" | "logs" | "output") {
  return Command.make(command, { runId: Argument.string("run-id") }, ({ runId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if ("ok" in resolved) return resolved;
          const found = yield* readRun(resolved.env, runId, yield* selected(global));
          if (!(found instanceof Run)) return found;
          if (command === "show")
            return {
              ok: true,
              data: { run: yield* runData(found) },
              human: `${found.id}\t${yield* runStatus(found)}\t${found.record.workflow}`,
            };
          if (command === "logs") {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const file = path.join(found.dir, RUNNER_LOG);
            const logs = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
            return { ok: true, data: { runId, logs }, human: logs };
          }
          const fs = yield* FileSystem.FileSystem;
          const pathSvc = yield* Path.Path;
          const outputs: Array<{ path: string; value?: unknown; error?: string }> = [];
          const inside = `${pathSvc.resolve(found.dir)}/`;
          for (const variant of found.record.steps.flatMap((step) => step.variants)) {
            const relative = variant.output;
            if (!relative) continue;
            const file = pathSvc.resolve(found.dir, relative);
            if (!file.startsWith(inside))
              return err("invalid_state", `Run "${runId}" has an unsafe Output path.`);
            // A Step that blocked has its Output path recorded with no file at it, and
            // an agent may write prose where JSON was asked for. The engine records
            // both deliberately, so neither may cost the caller the Outputs that did
            // land: each entry says what is there, and the command still succeeds.
            outputs.push(
              yield* fs.readFileString(file).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(UnknownJson)),
                Effect.map((value) => ({ path: relative, value })),
                Effect.catch((cause) => Effect.succeed({ path: relative, error: String(cause) })),
              ),
            );
          }
          return {
            ok: true,
            data: { runId, outputs },
            human: Schema.encodeSync(PrettyUnknownJson)(outputs),
          };
        }),
        global.json,
      );
    }),
  );
}

const runShow = runLookup("show");
const runLogs = runLookup("logs");
const runOutput = runLookup("output");

type ParsedTimeout = { ok: true; ms: number | null } | { ok: false; error: Result };

function parseTimeout(value: Option.Option<string>): ParsedTimeout {
  if (Option.isNone(value)) return { ok: true, ms: null };
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value.value);
  if (!match)
    return { ok: false, error: err("invalid_input", `Invalid timeout "${value.value}".`) };
  const factor = match[2] === "m" ? 60_000 : match[2] === "ms" ? 1 : 1_000;
  return { ok: true, ms: Number(match[1]) * factor };
}

const runWait = Command.make(
  "wait",
  {
    runId: Argument.string("run-id"),
    follow: Flag.boolean("follow").pipe(Flag.withDefault(false)),
    timeout: Flag.string("timeout").pipe(Flag.optional),
  },
  ({ runId, follow, timeout }) =>
    Effect.gen(function* () {
      const global = yield* root;
      const resolved = yield* context(global, false);
      if ("ok" in resolved) return yield* printResult(resolved, global.json);
      const workspace = yield* selected(global);
      const found = yield* readRun(resolved.env, runId, workspace);
      if (!(found instanceof Run)) return yield* printResult(found, global.json);
      const timeoutResult = parseTimeout(timeout);
      if (!timeoutResult.ok) return yield* printResult(timeoutResult.error, global.json);
      const { ms } = timeoutResult;

      let progressCount = 0;
      let sentSnapshot = false;
      /** One event, as the typed line a program reads or the line a human reads. */
      const say = <A>(event: A, human: string) =>
        process.stdout.write(`${global.json ? Schema.encodeSync(UnknownJson)(event) : human}\n`);

      /** Reports what has happened since the last call, and whether waiting is over. */
      const emit = Effect.fn("collie.runWait.emit")(function* () {
        const fresh = yield* readRun(resolved.env, runId, workspace);
        if (!(fresh instanceof Run)) return true;
        const snapshot = yield* runData(fresh);
        const status = yield* runStatus(fresh);
        const terminal = ["succeeded", "failed", "stopped"].includes(status);
        if (follow) {
          // Once, not once per event: a Run with no progress yet leaves progressCount
          // at zero however many times its directory is touched.
          if (!sentSnapshot) {
            sentSnapshot = true;
            say({ type: "snapshot", run: snapshot }, `${fresh.id}: ${status}`);
          }
          const progress = (yield* readProgress(fresh.dir)).slice(progressCount);
          progressCount += progress.length;
          for (const event of progress) say({ type: "progress", runId, ...event }, event.text);
          if (terminal) say({ type: "terminal", run: snapshot }, `${fresh.id}: ${status}`);
        }
        return terminal;
      });

      const fs = yield* FileSystem.FileSystem;
      /**
       * The watch is subscribed before the first read, not after it. Reading first
       * left a gap: a Run reaching a terminal state in it wrote the only event that
       * would ever arrive, and the command then waited for another one forever.
       */
      const watched = Effect.gen(function* () {
        const events = yield* Stream.toQueue(fs.watch(found.dir), { capacity: "unbounded" });
        if (yield* emit()) return;
        yield* Stream.fromQueue(events).pipe(
          Stream.runForEachWhile(() => emit().pipe(Effect.map((done) => !done))),
        );
      }).pipe(Effect.scoped);
      const bounded = ms === null ? watched : watched.pipe(Effect.timeout(ms));
      const failed = yield* bounded.pipe(
        Effect.as(false),
        Effect.catch((cause) =>
          Effect.sync(() => {
            print(
              Cause.isTimeoutError(cause)
                ? err("timeout", `Timed out waiting for run "${runId}".`)
                : err("operation_failed", `Could not watch run "${runId}".`, {
                    cause: String(cause),
                  }),
              global.json,
            );
            return true;
          }),
        ),
      );
      if (!follow && !failed) {
        const terminal = yield* readRun(resolved.env, runId, workspace);
        if (terminal instanceof Run)
          yield* printResult(
            {
              ok: true,
              data: { run: yield* runData(terminal) },
              human: `${terminal.id}: ${yield* runStatus(terminal)}`,
            },
            global.json,
          );
      }
    }),
);

function runCommandMutation(
  kind: "answer" | "stop" | "resume",
  runId: string,
  answer: string | undefined,
  requestId: Option.Option<string>,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if ("ok" in resolved) return resolved;
        const workspace = yield* selected(global);
        return yield* mutation(resolved.env, `run-${kind}`, requestId, (id) =>
          Effect.gen(function* () {
            const found = yield* readRun(resolved.env, runId, workspace);
            if (!(found instanceof Run)) return found;
            if (kind === "answer") return yield* answerRun(found, answer ?? "", id);
            if (kind === "stop") {
              return yield* stopRun(
                resolved.env.stateDir,
                new Herdr(resolved.env),
                found,
                scopeFor(resolved.env, found.record.cwd),
              );
            }
            return yield* resumeRun(resolved.env, found);
          }),
        );
      }),
      global.json,
    );
  });
}

const runAnswer = Command.make(
  "answer",
  {
    runId: Argument.string("run-id"),
    answer: Argument.string("answer"),
    requestId: Flag.string("request-id").pipe(Flag.optional),
  },
  ({ runId, answer, requestId }) => runCommandMutation("answer", runId, answer, requestId),
);

function runStatusMutation(kind: "stop" | "resume") {
  return Command.make(
    kind,
    {
      runId: Argument.string("run-id"),
      requestId: Flag.string("request-id").pipe(Flag.optional),
    },
    ({ runId, requestId }) => runCommandMutation(kind, runId, undefined, requestId),
  );
}

const runStop = runStatusMutation("stop");
const runResume = runStatusMutation("resume");
const run = Command.make("run").pipe(
  Command.withSubcommands([
    runStart,
    runList,
    runShow,
    runWait,
    runStop,
    runResume,
    runAnswer,
    runLogs,
    runOutput,
  ]),
);

export const app = root.pipe(Command.withSubcommands([workflow, persona, run]));

/**
 * Under `--json` the caller is a program, so the help document Effect's CLI renders on
 * stdout for a parse failure is noise that breaks the one-value contract. The
 * formatter decides what that document contains, so this is where it is silenced;
 * human invocations keep it.
 */
const jsonAsked = Bun.argv.includes("--json");
const cliOutput = CliOutput.defaultFormatter();
const quietHelp = CliOutput.layer({
  formatHelpDoc: jsonAsked ? () => "" : cliOutput.formatHelpDoc,
  formatCliError: cliOutput.formatCliError,
  formatError: cliOutput.formatError,
  formatErrors: cliOutput.formatErrors,
  formatVersion: cliOutput.formatVersion,
});

const isShowHelp = Schema.is(CliError.ShowHelp);

/**
 * Everything a command handler did not catch, which is a parse failure or a defect.
 *
 * A parse failure is invalid input: exit 2, and under `--json` one envelope carrying
 * what Effect's CLI would otherwise only render for a human. In human mode it has
 * already printed the help and the reason itself, so this only sets the status. An
 * explicit `--help` arrives as a ShowHelp with no errors and is nobody's failure.
 */
export const program = app.pipe(
  Command.run({ version: "0.0.1" }),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      const parse = isShowHelp(cause) ? cause : null;
      // An explicit `--help` is a ShowHelp carrying no errors, and nobody's failure.
      if (parse && parse.errors.length === 0) return;
      const failure = parse
        ? err("invalid_input", parse.errors.map((error) => error.message).join("; "))
        : err("operation_failed", String(cause));
      if (jsonAsked) return print(failure, true);
      // Effect's CLI has already printed the help and the reason for a parse failure,
      // so saying it again here would only be a third copy.
      process.exitCode = parse ? 2 : 1;
      if (!parse) yield* Console.error(failure.error.message);
    }),
  ),
  Effect.provide(quietHelp),
  Effect.provide(
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel] }),
  ),
);
