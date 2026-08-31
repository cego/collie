import { BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { Argument, CliConfig, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadDefaults } from "./config";
import {
  bodySections,
  DefinitionError,
  layers,
  loadDefinitions,
  resolveWorkflow,
  skillDirs,
  validateWorkflow,
  type Definitions,
  type PersonaDef,
  type WorkflowDef,
} from "./definitions";
import {
  CHOICE,
  RUNNER_LOG,
  driverAlive,
  readChoice,
  readProgress,
  stopDriver,
  writeInboxCommand,
} from "./driver";
import { readEnv, type PluginEnv } from "./env";
import { forkDefinition } from "./fork";
import { spawnDriver } from "./flows";
import { Herdr, type WorkspaceInfo } from "./herdr";
import { inferInputs, inputSources, inputValues } from "./inputs";
import { Run, RunStore } from "./run";
import { readRegistry, registryPath, scopeFor } from "./registry";
import { unsafePathComponent } from "./naming";

const ErrorCode = Schema.Literals([
  "workspace_required",
  "workspace_not_found",
  "workflow_not_found",
  "persona_not_found",
  "run_not_found",
  "run_already_active",
  "run_not_waiting",
  "invalid_answer",
  "choice_already_answered",
  "target_exists",
  "needs_input",
  "timeout",
  "invalid_state",
  "operation_failed",
  "invalid_input",
]);

export const ExpectedError = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
  details: Schema.Record(Schema.String, Schema.Unknown),
});
export interface ExpectedError extends Schema.Schema.Type<typeof ExpectedError> {}

const RunBoundary = Schema.Struct({
  id: Schema.String,
  workflow: Schema.String,
  cwd: Schema.String,
  workspace: Schema.NullOr(Schema.String),
  workspace_label: Schema.NullOr(Schema.String),
  workspace_worktree: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "done", "blocked", "failed"]),
  created_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  inputs: Schema.Record(Schema.String, Schema.String),
  input_sources: Schema.Record(Schema.String, Schema.String),
  steps: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  awaiting: Schema.NullOr(Schema.String),
});

type Result = { ok: true; data: unknown; human: string } | { ok: false; error: ExpectedError };
type Global = { readonly workspace: Option.Option<string>; readonly json: boolean };

const err = (code: ExpectedError["code"], message: string, details: Record<string, unknown> = {}): Result => ({
  ok: false,
  error: ExpectedError.make({ code, message, details }),
});

function isResult(value: unknown): value is Result {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function print(result: Result, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error })}\n`);
  } else {
    process.stdout.write(`${result.ok ? result.human : result.error.message}\n`);
  }
  if (!result.ok) process.exitCode = ["invalid_input", "needs_input", "workspace_required"].includes(result.error.code) ? 2 : 1;
}

function attempt(operation: () => Promise<Result> | Result, json: boolean) {
  return Effect.promise(async () => {
    try {
      print(await operation(), json);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      print(err("operation_failed", message), json);
    }
  });
}

function selected(global: Global): string | null {
  if (Option.isSome(global.workspace)) return global.workspace.value;
  if (process.env.HERDR_WORKSPACE_ID) return process.env.HERDR_WORKSPACE_ID;
  try {
    const value = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as { workspace_id?: unknown };
    return typeof value.workspace_id === "string" && value.workspace_id !== "" ? value.workspace_id : null;
  } catch {
    return null;
  }
}

async function context(
  global: Global,
  resolveLive: boolean,
  requireScope = false,
): Promise<{ env: PluginEnv; workspace: WorkspaceInfo | null } | Result> {
  const id = selected(global);
  const base = readEnv({ ...process.env, HERDR_WORKSPACE_ID: id ?? undefined });
  if (!id) return requireScope
    ? err("workspace_required", "This operation requires a workspace.")
    : { env: base, workspace: null };
  if (!resolveLive) return { env: base, workspace: null };
  const workspace = (await new Herdr(base).workspaceList()).find((item) => item.workspaceId === id);
  if (!workspace) return err("workspace_not_found", `Workspace "${id}" was not found.`, { workspace: id });
  return {
    workspace,
    env: { ...base, workspaceId: id, cwd: workspace.cwd || base.context.workspace_cwd || base.cwd },
  };
}

function definitions(env: PluginEnv): Definitions {
  return loadDefinitions(layers(env));
}

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

function readRun(env: PluginEnv, id: string, workspace: string | null): Run | Result {
  if (unsafePathComponent(id)) return err("run_not_found", `Run "${id}" was not found.`, { run: id });
  let run: Run;
  try {
    run = new RunStore(env.stateDir).load(id);
  } catch {
    return err("run_not_found", `Run "${id}" was not found.`, { run: id });
  }
  try {
    Schema.decodeUnknownSync(RunBoundary)(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")));
  } catch (cause) {
    return err("invalid_state", `Run "${id}" has invalid persisted state.`, { run: id, cause: String(cause) });
  }
  if (workspace && run.record.workspace !== workspace) {
    return err("run_not_found", `Run "${id}" was not found in workspace "${workspace}".`, { run: id, workspace });
  }
  return run;
}

function status(run: Run): "running" | "waiting" | "succeeded" | "failed" | "stopped" {
  if (existsSync(join(run.dir, "stopped"))) return "stopped";
  if (run.record.awaiting || existsSync(join(run.dir, CHOICE))) return "waiting";
  if (run.record.status === "done") return "succeeded";
  if (run.record.status === "failed") return "failed";
  return "running";
}

function runData(run: Run) {
  return {
    ...run.record,
    status: status(run),
    progress: readProgress(run.dir),
    choice: readChoice(run.dir),
  };
}

function requestId(value: Option.Option<string>): string {
  return Option.isSome(value) ? value.value : crypto.randomUUID();
}

function receiptPath(env: PluginEnv, operation: string, id: string): string {
  return join(env.stateDir, "requests", operation, `${encodeURIComponent(id)}.json`);
}

async function mutation(
  env: PluginEnv,
  operation: string,
  requested: Option.Option<string>,
  apply: (id: string) => Promise<Result> | Result,
): Promise<Result> {
  const id = requestId(requested);
  const path = receiptPath(env, operation, id);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Result;
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Result;
    return err("operation_failed", `Request "${id}" is already in progress.`, { requestId: id });
  }
  try {
    const result = await apply(id);
    const withRequest = result.ok
      ? { ...result, data: { ...(result.data as object), requestId: id } }
      : result;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(withRequest)}\n`);
    renameSync(tmp, path);
    return withRequest;
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

function layerDir(env: PluginEnv, layer: "user" | "project"): string {
  const all = layers(env);
  return layer === "user" ? all[1]!.dir : all[2]!.dir;
}

function parseInput(values: ReadonlyArray<string>, json: Option.Option<string>): Promise<Record<string, string> | Result> {
  return (async () => {
    let parsed: Record<string, string> = {};
    if (Option.isSome(json)) {
      const raw = json.value === "-" ? await Bun.stdin.text() : json.value;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return err("invalid_input", "--inputs-json must be a JSON object.");
      }
      if (!value || Array.isArray(value) || typeof value !== "object") return err("invalid_input", "--inputs-json must be a JSON object.");
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== "string") return err("invalid_input", `Input "${key}" must be a string.`);
        parsed[key] = item;
      }
    }
    for (const entry of values) {
      const at = entry.indexOf("=");
      if (at <= 0) return err("invalid_input", `Input "${entry}" must be key=value.`);
      parsed[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return parsed;
  })();
}

const root = Command.make("collie").pipe(
  Command.withSharedFlags({
    workspace: Flag.string("workspace").pipe(Flag.optional),
    json: Flag.boolean("json").pipe(Flag.withDefault(false)),
  }),
  Command.withDescription("Discover and run Collie workflows"),
);

const workflowList = Command.make("list", {}, () => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, selected(global) !== null);
    if ("ok" in resolved) return resolved;
    const defs = definitions(resolved.env);
    const workflows = [...defs.workflows.values()].sort((a, b) => a.name.localeCompare(b.name)).map(workflowData);
    return { ok: true, data: { workflows, errors: defs.errors }, human: workflows.map((item) => `${item.name}\t${item.description}`).join("\n") || "No workflows found." };
  }, global.json);
}));

const workflowShow = Command.make("show", { workflow: Argument.string("workflow") }, ({ workflow }) => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, selected(global) !== null);
    if ("ok" in resolved) return resolved;
    const wf = definitions(resolved.env).workflows.get(workflow);
    return wf
      ? { ok: true, data: { workflow: workflowData(wf) }, human: `${wf.title}\n${wf.description}\nInputs: ${JSON.stringify(wf.inputs)}` }
      : err("workflow_not_found", `Workflow "${workflow}" was not found.`);
  }, global.json);
}));

const forkFlags = {
  layer: Flag.choice("layer", ["user", "project"]),
  name: Flag.string("name"),
  requestId: Flag.string("request-id").pipe(Flag.optional),
};

const workflowFork = Command.make("fork", {
  workflow: Argument.string("workflow"),
  ...forkFlags,
  mode: Flag.choice("mode", ["extends", "copy"]),
  step: Flag.string("step").pipe(Flag.optional),
}, ({ workflow, layer, mode, name, requestId: request, step }) => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, layer === "project", layer === "project");
    if ("ok" in resolved) return resolved;
    return mutation(resolved.env, "workflow-fork", request, () => {
      const wf = definitions(resolved.env).workflows.get(workflow);
      if (!wf) return err("workflow_not_found", `Workflow "${workflow}" was not found.`);
      if (unsafePathComponent(name)) return err("invalid_input", `"${name}" is not a valid Workflow name.`);
      const target = join(layerDir(resolved.env, layer), "workflows", `${name}.md`);
      if (existsSync(target)) return err("target_exists", `${target} already exists.`, { path: target });
      const pickedStep = Option.isSome(step) ? step.value : undefined;
      if (pickedStep && !wf.steps.some((item) => item.id === pickedStep)) {
        return err("invalid_input", `Workflow "${workflow}" has no Step "${pickedStep}".`);
      }
      const result = forkDefinition(wf.path, "workflows", layerDir(resolved.env, layer), {
        name,
        full: mode === "copy",
        step: pickedStep,
        section: pickedStep ? bodySections(wf.body).sections.get(pickedStep) : undefined,
      });
      if (!result.ok) return err("target_exists", result.message, { path: result.path });
      const path = result.path;
      return { ok: true, data: { path, name, layer, mode }, human: `Forked ${workflow} to ${path}.` };
    });
  }, global.json);
}));

const workflow = Command.make("workflow").pipe(Command.withSubcommands([workflowList, workflowShow, workflowFork]));

const personaList = Command.make("list", {}, () => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, selected(global) !== null);
    if ("ok" in resolved) return resolved;
    const defs = definitions(resolved.env);
    const personas = [...defs.personas.values()].sort((a, b) => a.name.localeCompare(b.name)).map(personaData);
    return { ok: true, data: { personas, errors: defs.errors }, human: personas.map((item) => `${item.name}\t${item.description}`).join("\n") || "No personas found." };
  }, global.json);
}));

const personaShow = Command.make("show", { persona: Argument.string("persona") }, ({ persona }) => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, selected(global) !== null);
    if ("ok" in resolved) return resolved;
    const found = definitions(resolved.env).personas.get(persona);
    return found
      ? { ok: true, data: { persona: personaData(found) }, human: `${found.name}\n${found.description}\n\n${found.body}` }
      : err("persona_not_found", `Persona "${persona}" was not found.`);
  }, global.json);
}));

const personaFork = Command.make("fork", {
  persona: Argument.string("persona"),
  ...forkFlags,
}, ({ persona, layer, name, requestId: request }) => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, layer === "project", layer === "project");
    if ("ok" in resolved) return resolved;
    return mutation(resolved.env, "persona-fork", request, () => {
      const found = definitions(resolved.env).personas.get(persona);
      if (!found) return err("persona_not_found", `Persona "${persona}" was not found.`);
      if (unsafePathComponent(name)) return err("invalid_input", `"${name}" is not a valid Persona name.`);
      const target = join(layerDir(resolved.env, layer), "personas", `${name}.md`);
      if (existsSync(target)) return err("target_exists", `${target} already exists.`, { path: target });
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(found.path, target);
      const text = readFileSync(target, "utf8").replace(new RegExp(`(^name:\\s*)${found.name}$`, "m"), `$1${name}`);
      writeFileSync(target, text);
      return { ok: true, data: { path: target, name, layer }, human: `Forked ${persona} to ${target}.` };
    });
  }, global.json);
}));

const persona = Command.make("persona").pipe(Command.withSubcommands([personaList, personaShow, personaFork]));

const runStart = Command.make("start", {
  workflow: Argument.string("workflow"),
  input: Flag.string("input").pipe(Flag.between(0, 100)),
  inputsJson: Flag.string("inputs-json").pipe(Flag.optional),
  requestId: Flag.string("request-id").pipe(Flag.optional),
}, ({ workflow, input, inputsJson, requestId: request }) => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, selected(global) !== null);
    if ("ok" in resolved) return resolved;
    const explicit = await parseInput(input, inputsJson);
    if (isResult(explicit)) return explicit;
    return mutation(resolved.env, "run-start", request, async () => {
      const defs = definitions(resolved.env);
      let wf;
      try {
        wf = resolveWorkflow(workflow, defs, loadDefaults(resolved.env.configDir));
      } catch (cause) {
        if (cause instanceof DefinitionError) return err("workflow_not_found", cause.message);
        throw cause;
      }
      const problems = validateWorkflow(wf, defs, loadDefaults(resolved.env.configDir), skillDirs(resolved.env));
      if (problems.length > 0) return err("operation_failed", `${workflow} is not runnable.`, { problems });
      const inferred = await inferInputs(wf.inputs, { cwd: resolved.env.cwd, stateDir: resolved.env.stateDir });
      for (const item of inferred) {
        if (explicit[item.name] !== undefined) {
          item.value = explicit[item.name]!;
          item.source = "explicit";
          item.needsAsking = false;
          delete item.candidates;
        }
      }
      const unresolved = inferred.filter((item) => item.needsAsking || item.candidates);
      if (unresolved.length > 0) {
        return err("needs_input", `${workflow} needs input.`, {
          inputs: unresolved.map((item) => ({ name: item.name, candidates: item.candidates ?? [], question: item.question })),
          schema: wf.inputs,
        });
      }
      const values = { ...inputValues(inferred), ...explicit };
      const sources = { ...inputSources(inferred), ...Object.fromEntries(Object.keys(explicit).map((key) => [key, "explicit"])) };
      const run = new RunStore(resolved.env.stateDir).create({
        workflow: wf.name,
        cwd: resolved.env.cwd,
        session: resolved.env.socketPath,
        workspace: resolved.workspace?.workspaceId ?? resolved.env.workspaceId,
        workspaceLabel: resolved.workspace?.label ?? null,
        workspaceWorktree: resolved.workspace?.worktree ?? null,
        inputs: values,
        inputSources: sources,
        stepIds: wf.steps.map((step) => step.id),
        maxIterations: wf.maxIterations,
        primaryInput: Object.values(values)[0] ?? wf.name,
      });
      run.log(`created from ${wf.path} (${wf.layer} layer)`);
      spawnDriver(resolved.env, run.id, run.record.cwd);
      return { ok: true, data: { runId: run.id, run: runData(run) }, human: `Started run ${run.id}.` };
    });
  }, global.json);
}));

const runList = Command.make("list", {}, () => Effect.gen(function*() {
  const global = yield* root;
  yield* attempt(async () => {
    const resolved = await context(global, false);
    if ("ok" in resolved) return resolved;
    const workspace = selected(global);
    const store = new RunStore(resolved.env.stateDir);
    if (existsSync(store.root)) {
      for (const name of readdirSync(store.root).filter((entry) => !entry.startsWith("."))) {
        try {
          Schema.decodeUnknownSync(RunBoundary)(JSON.parse(readFileSync(join(store.root, name, "run.json"), "utf8")));
        } catch (cause) {
          return err("invalid_state", `Run "${name}" has invalid persisted state.`, { run: name, cause: String(cause) });
        }
      }
    }
    const runs = store.list()
      .filter((item) => !workspace || item.record.workspace === workspace)
      .map(runData);
    return { ok: true, data: { runs }, human: runs.map((item) => `${item.id}\t${item.status}\t${item.workflow}`).join("\n") || "No runs found." };
  }, global.json);
}));

function runLookup(command: "show" | "logs" | "output") {
  return Command.make(command, { runId: Argument.string("run-id") }, ({ runId }) => Effect.gen(function*() {
    const global = yield* root;
    yield* attempt(async () => {
      const resolved = await context(global, false);
      if ("ok" in resolved) return resolved;
      const found = readRun(resolved.env, runId, selected(global));
      if (!(found instanceof Run)) return found;
      if (command === "show") return { ok: true, data: { run: runData(found) }, human: `${found.id}\t${status(found)}\t${found.record.workflow}` };
      if (command === "logs") {
        const logs = existsSync(join(found.dir, RUNNER_LOG)) ? readFileSync(join(found.dir, RUNNER_LOG), "utf8") : "";
        return { ok: true, data: { runId, logs }, human: logs };
      }
      const outputs: Array<{ path: string; value: unknown }> = [];
      for (const variant of found.record.steps.flatMap((step) => step.variants)) {
        if (!variant.output) continue;
        const path = resolve(found.dir, variant.output);
        if (!path.startsWith(`${resolve(found.dir)}/`)) return err("invalid_state", `Run "${runId}" has an unsafe Output path.`);
        outputs.push({ path: variant.output, value: JSON.parse(readFileSync(path, "utf8")) });
      }
      return { ok: true, data: { runId, outputs }, human: JSON.stringify(outputs, null, 2) };
    }, global.json);
  }));
}

const runShow = runLookup("show");
const runLogs = runLookup("logs");
const runOutput = runLookup("output");

function parseTimeout(value: Option.Option<string>): number | null | Result {
  if (Option.isNone(value)) return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value.value);
  if (!match) return err("invalid_input", `Invalid timeout "${value.value}".`);
  const factor = match[2] === "m" ? 60_000 : match[2] === "ms" ? 1 : 1_000;
  return Number(match[1]) * factor;
}

const runWait = Command.make("wait", {
  runId: Argument.string("run-id"),
  follow: Flag.boolean("follow").pipe(Flag.withDefault(false)),
  timeout: Flag.string("timeout").pipe(Flag.optional),
}, ({ runId, follow, timeout }) => Effect.gen(function*() {
  const global = yield* root;
  const resolved = yield* Effect.promise(() => context(global, false));
  if ("ok" in resolved) return print(resolved, global.json);
  const found = readRun(resolved.env, runId, selected(global));
  if (!(found instanceof Run)) return print(found, global.json);
  const ms = parseTimeout(timeout);
  if (ms !== null && typeof ms !== "number") return print(ms, global.json);

  let progressCount = 0;
  const emit = () => {
    const fresh = readRun(resolved.env, runId, selected(global));
    if (!(fresh instanceof Run)) return true;
    const snapshot = runData(fresh);
    if (follow) {
      if (progressCount === 0) process.stdout.write(`${global.json ? JSON.stringify({ type: "snapshot", run: snapshot }) : `${fresh.id}: ${status(fresh)}`}\n`);
      const progress = readProgress(fresh.dir).slice(progressCount);
      progressCount += progress.length;
      for (const event of progress) process.stdout.write(`${global.json ? JSON.stringify({ type: "progress", runId, ...event }) : event.text}\n`);
      if (["succeeded", "failed", "stopped"].includes(status(fresh))) {
        process.stdout.write(`${global.json ? JSON.stringify({ type: "terminal", run: snapshot }) : `${fresh.id}: ${status(fresh)}`}\n`);
      }
    }
    return ["succeeded", "failed", "stopped"].includes(status(fresh));
  };
  if (emit()) {
    if (!follow) print({ ok: true, data: { run: runData(found) }, human: `${found.id}: ${status(found)}` }, global.json);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const wait = fs.watch(found.dir).pipe(Stream.runForEachWhile(() => Effect.sync(() => !emit())));
  const bounded = ms === null ? wait : wait.pipe(Effect.timeout(ms));
  yield* bounded.pipe(Effect.catch((cause) => Effect.sync(() => {
    print(
      (cause as { _tag?: string })._tag === "TimeoutError"
        ? err("timeout", `Timed out waiting for run "${runId}".`)
        : err("operation_failed", `Could not watch run "${runId}".`, { cause: String(cause) }),
      global.json,
    );
  })));
  if (!follow && process.exitCode !== 1) {
    const terminal = readRun(resolved.env, runId, selected(global));
    if (terminal instanceof Run) print({ ok: true, data: { run: runData(terminal) }, human: `${terminal.id}: ${status(terminal)}` }, global.json);
  }
}));

function commandMutation(kind: "answer" | "stop" | "resume") {
  const config = kind === "answer"
    ? { runId: Argument.string("run-id"), answer: Argument.string("answer"), requestId: Flag.string("request-id").pipe(Flag.optional) }
    : { runId: Argument.string("run-id"), requestId: Flag.string("request-id").pipe(Flag.optional) };
  return Command.make(kind, config as Command.Command.Config, (args: any) => Effect.gen(function*() {
    const global = yield* root;
    yield* attempt(async () => {
      const resolved = await context(global, false);
      if ("ok" in resolved) return resolved;
      return mutation(resolved.env, `run-${kind}`, args.requestId, async (id) => {
        const found = readRun(resolved.env, args.runId, selected(global));
        if (!(found instanceof Run)) return found;
        if (kind === "answer") {
          const choice = readChoice(found.dir);
          if (!choice) return err("run_not_waiting", `Run "${found.id}" is not waiting for a Choice.`);
          const inbox = join(found.dir, "inbox");
          if (existsSync(inbox) && readdirSync(inbox).some((name) => {
            try {
              const command = JSON.parse(readFileSync(join(inbox, name), "utf8")) as { type?: string; choiceId?: string };
              return command.type === "answer" && command.choiceId === choice.id;
            } catch {
              return false;
            }
          })) return err("choice_already_answered", `Choice "${choice.id}" already has an answer.`);
          if (choice.kind !== "menu" || !choice.items.some((item) => item.id === args.answer)) {
            return err("invalid_answer", `"${args.answer}" is not a valid answer.`, { answers: choice.items.map((item) => item.id) });
          }
          writeInbox(found, { type: "answer", requestId: id, choiceId: choice.id, answer: args.answer });
          return { ok: true, data: { runId: found.id, answer: args.answer }, human: `Answered ${found.id}: ${args.answer}.` };
        }
        if (kind === "stop") {
          if (status(found) === "succeeded") return err("invalid_state", `Run "${found.id}" has already succeeded.`);
          writeInbox(found, { type: "stop", requestId: id });
          const entries = readRegistry(registryPath(resolved.env.stateDir, scopeFor(resolved.env, found.record.cwd)))
            .filter((entry) => entry.runId === found.id);
          const herdr = new Herdr(resolved.env);
          await Promise.allSettled(entries.map((entry) => herdr.paneClose(entry.paneId)));
          if (!driverAlive(found.dir)) {
            writeFileSync(join(found.dir, "stopped"), `${new Date().toISOString()}\n`);
            found.record.status = "blocked";
            found.save();
          } else stopDriver(found.dir);
          return { ok: true, data: { runId: found.id, status: "stopped" }, human: `Stopped run ${found.id}.` };
        }
        if (driverAlive(found.dir)) return err("run_already_active", `Run "${found.id}" is already active.`);
        if (status(found) === "succeeded") return err("invalid_state", `Run "${found.id}" has already succeeded.`);
        rmSync(join(found.dir, "stopped"), { force: true });
        for (const step of found.record.steps) if (step.status !== "done") step.status = "pending";
        found.record.status = "running";
        found.record.finished_at = null;
        found.save();
        writeInbox(found, { type: "resume", requestId: id });
        spawnDriver(resolved.env, found.id, found.record.cwd);
        return { ok: true, data: { runId: found.id, status: "running" }, human: `Resumed run ${found.id}.` };
      });
    }, global.json);
  }));
}

function writeInbox(run: Run, command: Record<string, unknown>): void {
  writeInboxCommand(run.dir, command);
}

const runAnswer = commandMutation("answer");
const runStop = commandMutation("stop");
const runResume = commandMutation("resume");
const run = Command.make("run").pipe(Command.withSubcommands([
  runStart,
  runList,
  runShow,
  runWait,
  runStop,
  runResume,
  runAnswer,
  runLogs,
  runOutput,
]));

export const app = root.pipe(Command.withSubcommands([workflow, persona, run]));

export const program = app.pipe(
  Command.run({ version: "0.0.1" }),
  Effect.catch((cause) => Effect.sync(() => {
    process.exitCode = 2;
    if (process.argv.includes("--json")) {
      const error = ExpectedError.make({ code: "invalid_input", message: String(cause), details: {} });
      process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    } else {
      process.stderr.write(`${String(cause)}\n`);
    }
  })),
  Effect.provide(BunServices.layer),
  Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel] })),
);
