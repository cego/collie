import type { BunServices } from "@effect/platform-bun/BunServices";
import {
  Cause,
  Config,
  Duration,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { Argument, CliConfig, CliError, Command, Flag, GlobalFlag } from "effect/unstable/cli";
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

/**
 * Every command ends in exactly one envelope. `Effect.catch` sees typed failures only,
 * so a defect — anything that throws where the error channel was not declared — used
 * to leave both streams empty and only an exit status behind. Both are caught here.
 */
function attempt<E, R>(operation: Effect.Effect<Result, E, R>, json: boolean) {
  return operation.pipe(
    Effect.catch((cause) => Effect.succeed(err("operation_failed", String(cause)))),
    Effect.catchDefect((defect) => Effect.succeed(err("operation_failed", String(defect)))),
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

/**
 * The request id a caller can replay with. A receipt is written for a failure too, so
 * a failure that omits the id leaves the caller nothing to retry with but a fresh one
 * — which is a second Run, not a retry.
 */
function withRequestId(result: Result, id: string): Result {
  if (!result.ok)
    return err(result.error.code, result.error.message, {
      ...result.error.details,
      requestId: id,
    });
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
  // Effect.ensuring, not try/finally: a typed failure out of `apply` unwinds past a
  // generator's finally without entering it, and the lock would outlive the request.
  return yield* Effect.gen(function* () {
    const result = yield* apply(id);
    const withRequest = withRequestId(result, id);
    const tmp = `${path}.${yield* pid}.tmp`;
    yield* fs.writeFileString(tmp, `${Schema.encodeSync(ResultBoundaryJson)(withRequest)}\n`);
    yield* fs.rename(tmp, path);
    return withRequest;
  }).pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
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
).pipe(Command.withDescription("List every Workflow, with its Inputs and the Layer it came from"));

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
).pipe(Command.withDescription("Show one Workflow: its Steps, its Inputs and where it is defined"));

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
).pipe(Command.withDescription("Copy or extend a Workflow into your user or project Layer"));

const workflow = Command.make("workflow").pipe(
  Command.withDescription("Inspect and fork Workflows"),
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
).pipe(Command.withDescription("List every Persona and the Layer it came from"));

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
).pipe(Command.withDescription("Show one Persona's instructions and where it is defined"));

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
).pipe(Command.withDescription("Copy a Persona into your user or project Layer"));

const persona = Command.make("persona").pipe(
  Command.withDescription("Inspect and fork Personas"),
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
          const base = yield* context(global, false);
          if ("ok" in base) return base;
          const explicit = yield* parseInput(input, inputsJson);
          if (!explicit.ok) return explicit.error;
          return yield* mutation(base.env, "run-start", request, (_id) =>
            Effect.gen(function* () {
              // The live workspace is resolved inside the mutation, so replaying a
              // receipt returns what was recorded rather than needing that workspace
              // to still be open. Only a start that is actually happening needs it.
              const resolved = yield* context(global, (yield* selected(global)) !== null);
              if ("ok" in resolved) return resolved;
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
              if (!(run instanceof Run)) return run;
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
).pipe(Command.withDescription("Start a Workflow and return the new Run's id"));

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
).pipe(Command.withDescription("List Runs in the selected workspace, or everywhere without one"));

function runLookup(command: "show" | "logs" | "output") {
  const described = {
    show: "Show one Run: its state, its Inputs, its Steps and any pending Choice",
    logs: "Print what the Run's Driver recorded",
    output: "Print every Output the Run's Steps have written",
  }[command];
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
  ).pipe(Command.withDescription(described));
}

const runShow = runLookup("show");
const runLogs = runLookup("logs");
const runOutput = runLookup("output");

type ParsedTimeout = { ok: true; ms: number | null } | { ok: false; error: Result };

/**
 * A duration, in the short forms this flag has always taken (`30`, `30s`, `500ms`,
 * `2m`) or in the form the rest of this codebase writes (`"25 millis"`, `"2 minutes"`),
 * which Effect parses itself. The short forms stay because they are what the flag has
 * accepted; Effect's are added because they are what a reader of this code expects.
 */
function parseTimeout(value: Option.Option<string>): ParsedTimeout {
  if (Option.isNone(value)) return { ok: true, ms: null };
  const short = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value.value);
  if (short) {
    const factor = short[2] === "m" ? 60_000 : short[2] === "ms" ? 1 : 1_000;
    return { ok: true, ms: Number(short[1]) * factor };
  }
  const spelled = Schema.decodeUnknownOption(Schema.DurationFromString)(value.value);
  if (Option.isSome(spelled)) return { ok: true, ms: Duration.toMillis(spelled.value) };
  return { ok: false, error: err("invalid_input", `Invalid timeout "${value.value}".`) };
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
      /** Why the Run stopped being readable, if it did. Waiting ends; success does not. */
      let lost: Failure | null = null;
      /** One event, as the typed line a program reads or the line a human reads. */
      const say = <A>(event: A, human: string) =>
        process.stdout.write(`${global.json ? Schema.encodeSync(UnknownJson)(event) : human}\n`);

      /** Reports what has happened since the last call, and whether waiting is over. */
      const emit = Effect.fn("collie.runWait.emit")(function* () {
        const fresh = yield* readRun(resolved.env, runId, workspace);
        if (!(fresh instanceof Run)) {
          // Deleted or no longer decoding, mid-wait. That is the typed failure the
          // caller is owed, not a terminal state to be reported as a success.
          lost = fresh;
          return true;
        }
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
      if (lost) return yield* printResult(lost, global.json);
      if (follow || failed) return;
      const terminal = yield* readRun(resolved.env, runId, workspace);
      if (!(terminal instanceof Run)) return yield* printResult(terminal, global.json);
      yield* printResult(
        {
          ok: true,
          data: { run: yield* runData(terminal) },
          human: `${terminal.id}: ${yield* runStatus(terminal)}`,
        },
        global.json,
      );
    }),
).pipe(Command.withDescription("Wait for a Run to finish, optionally following its progress"));

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
                id,
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
).pipe(Command.withDescription("Answer the Choice a waiting Run is asking"));

function runStatusMutation(kind: "stop" | "resume") {
  const described =
    kind === "stop"
      ? "Stop a Run and close only the panes it owns"
      : "Start a fresh Driver for a Run, skipping the Steps that finished";
  return Command.make(
    kind,
    {
      runId: Argument.string("run-id"),
      requestId: Flag.string("request-id").pipe(Flag.optional),
    },
    ({ runId, requestId }) => runCommandMutation(kind, runId, undefined, requestId),
  ).pipe(Command.withDescription(described));
}

const runStop = runStatusMutation("stop");
const runResume = runStatusMutation("resume");
const run = Command.make("run").pipe(
  Command.withDescription("Start Runs and follow, answer, stop or resume them"),
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

const jsonAsked = Bun.argv.includes("--json");
/** Help was asked for, as opposed to offered because the command line was wrong. */
const helpAsked = Bun.argv.includes("--help") || Bun.argv.includes("-h");

/**
 * `Console.log` is the only stdout Effect's CLI writes to — the help document it
 * renders for any parse failure, and the version. Under `--json` that moves to
 * stderr, where the spec puts diagnostics, leaving stdout to the envelope a command
 * writes straight to `process.stdout`. Effect's own logger already uses
 * `console.error`, so nothing else moves.
 */
const consoleToStderr = Console.Console.of({
  ...globalThis.console,
  log: (...args: ReadonlyArray<unknown>) => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`);
  },
});

const isShowHelp = Schema.is(CliError.ShowHelp);

/**
 * Everything a command handler did not catch, which is a parse failure or a defect.
 *
 * A ShowHelp is Effect's CLI asking for the help document to be shown, and it raises
 * one both for `--help` and for a command line it could not use — including a command
 * group named with no subcommand, which carries no parse errors at all. Only the first
 * is nobody's failure, so argv is the discriminator: anything else is invalid input,
 * exit 2, and under `--json` one envelope. In human mode Effect's CLI has already
 * printed the help and the reason, so this only sets the status.
 */
export const program = app.pipe(
  Command.run({ version: "0.0.1" }),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      const parse = isShowHelp(cause) ? cause : null;
      if (parse && helpAsked) return;
      const failure = parse
        ? err("invalid_input", parseMessage(parse))
        : err("operation_failed", String(cause));
      if (jsonAsked) return print(failure, true);
      process.exitCode = parse ? 2 : 1;
      if (!parse) yield* Console.error(failure.error.message);
    }),
  ),
  Effect.provide(
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel] }),
  ),
  Effect.provide(jsonAsked ? Layer.succeed(Console.Console, consoleToStderr) : Layer.empty),
);

/** What was wrong with the command line, or that it stopped short of a command. */
function parseMessage(parse: CliError.ShowHelp): string {
  if (parse.errors.length > 0) return parse.errors.map((error) => error.message).join("; ");
  return `${["collie", ...parse.commandPath.slice(1)].join(" ")} needs a subcommand.`;
}
