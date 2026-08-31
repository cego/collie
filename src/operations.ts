// What starting, answering, stopping and resuming a Run actually does. Both the CLI
// and the Herdr adapters call these; neither owns the behaviour, so a pane and a
// command cannot drift apart. What stays with each of them is presentation: picking,
// prompting, rendering, and turning a result into text or JSON.

import { Config, Crypto, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { nowIso } from "./time";
import type { PluginEnv } from "./env";
import { Herdr, type WorkspaceInfo } from "./herdr";
import { loadDefaults } from "./config";
import {
  DefinitionError,
  layers,
  loadDefinitions,
  resolveWorkflow,
  skillDirs,
  validateWorkflow,
  type ResolvedWorkflow,
} from "./definitions";
import {
  CHOICE,
  driverAlive,
  inboxFiles,
  InboxCommandJson,
  readChoice,
  stopDriver,
  type InboxCommandValue,
} from "./driver";
import { inferInputs, inputSources, inputValues, type Resolution } from "./inputs";
import { readRegistry, registryPath, type RegistryScope } from "./registry";
import { breakStaleLock, releaseOwnLock, tryClaimLock } from "./lock";
import { Run, RunStore } from "./run";
import { YamlMapSchema, type YamlMap } from "./yaml";

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
  details: YamlMapSchema,
});
export interface ExpectedError extends Schema.Schema.Type<typeof ExpectedError> {}

export type Failure = { ok: false; error: ExpectedError };
export type OpResult = { ok: true; data: unknown; human: string } | Failure;

export const err = (
  code: ExpectedError["code"],
  message: string,
  details: YamlMap = {},
): Failure => ({ ok: false, error: ExpectedError.make({ code, message, details }) });

const ok = <A>(data: A, human: string): OpResult => ({ ok: true, data, human });

/** A fresh id for a mutation whose caller supplied none. Reusing one replays it. */
export const newRequestId = Effect.fn("operations.newRequestId")(function* () {
  return yield* (yield* Crypto.Crypto).randomUUIDv4;
});

const InboxAnswerCommand = Schema.Struct({
  type: Schema.Literal("answer"),
  choiceId: Schema.String,
});
const InboxAnswerCommandJson = Schema.fromJsonString(InboxAnswerCommand);

const DriverCommandJson = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String));

/** A command for the owning Driver: written whole under a name only this request can claim. */
export const writeInbox = Effect.fn("operations.writeInbox")(function* (
  dir: string,
  command: InboxCommandValue,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inbox = path.join(dir, "inbox");
  yield* fs.makeDirectory(inbox, { recursive: true });
  const target = path.join(inbox, `${encodeURIComponent(command.requestId)}.json`);
  const tmp = `${target}.${globalThis.process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${Schema.encodeSync(InboxCommandJson)(command)}\n`, {
    flag: "wx",
  });
  yield* fs.rename(tmp, target);
});

/**
 * The executable that drives a run, plus its arguments. The compiled driver is
 * one path passed whole — never split, so a checkout under a directory with
 * spaces launches normally. COLLIE_DRIVER overrides it for development
 * and tests, with an explicit contract instead of shell parsing: a JSON array
 * (`["bun","src/main.ts"]`) is executable-plus-arguments, anything else is one
 * executable path.
 */
export const driverCommand = Effect.fn("operations.driverCommand")(function* (env: PluginEnv) {
  const override = yield* Config.option(Config.string("COLLIE_DRIVER"));
  if (override._tag === "None") return [`${env.pluginRoot}/bin/collie`] as const;
  const value = override.value;
  if (value.trimStart().startsWith("[")) {
    return yield* Schema.decodeUnknownEffect(DriverCommandJson)(value).pipe(
      Effect.mapError(
        () => new Error(`COLLIE_DRIVER must be one path or a JSON array of strings, not ${value}`),
      ),
    );
  }
  // The pre-JSON form was a space-separated command; a bare value with spaces
  // that names no file would otherwise die as a raw spawn ENOENT.
  const fs = yield* FileSystem.FileSystem;
  if (/\s/.test(value) && !(yield* fs.exists(value))) {
    return yield* Effect.fail(
      new Error(
        `COLLIE_DRIVER must be one executable path or a JSON array of strings (e.g. ["bun","src/main.ts"]), not ${value}`,
      ),
    );
  }
  return [value] as const;
});

/**
 * The run driver, detached: it outlives this pane, because the picker closes the
 * moment it has started one and a run takes hours.
 *
 * `detached` is the load-bearing word. Closing a pane sends SIGHUP to the whole
 * process group, and `nohup` protects only the process it wraps — the driver's own
 * `herdr` calls died with `exit 129` the first time this was tried. A session of its
 * own is what actually takes the driver out of the terminal's reach.
 */
export const spawnDriver = Effect.fn("operations.spawnDriver")(function* (
  env: PluginEnv,
  runId: string,
  cwd: string,
) {
  const commandLine = yield* driverCommand(env);
  const command = commandLine[0];
  const rest = commandLine.slice(1);
  // Bun.spawn throws where the executable is not there, which is the ordinary state
  // of a checkout whose bin/collie has not been built. Unwrapped it was a defect, and
  // a defect is what left a Run created, marked running, and driven by nobody.
  yield* Effect.try({
    try: () =>
      Bun.spawn([command, ...rest, "herdr", "drive"], {
        cwd,
        // The real environment first, then what herdr gave this process. `env.raw`
        // holds only the keys env.ts reads, so passing it alone handed the Driver no
        // PATH: every `git`, `glab` and `herdr` it runs by bare name then resolved
        // against execvp's /bin:/usr/bin fallback only, and `shell` reads that miss as
        // exit 127 — which the MR and diff paths cannot tell from "no GitLab here".
        env: { ...globalThis.process.env, ...env.raw, COLLIE_RUN: runId, COLLIE_CWD: cwd },
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).unref(),
    catch: (cause) => new Error(`could not start ${command}: ${String(cause)}`),
  });
});

/**
 * The Run's state as the spec names it, which the record alone does not spell: the
 * stop marker and a pending Choice both outrank what the record last recorded.
 *
 * The engine's `blocked` — a Step that needs the human, or max_iterations reached
 * with findings — is the spec's `failed`, "execution ended unsuccessfully with
 * unfinished work". It is terminal, so reporting it as `running` left `run wait`
 * watching a directory nothing would write again. Which kind of unsuccessful it was
 * is in the Run's own `outstanding` and Step notes, which `run show` returns whole.
 */
export const runStatus = Effect.fn("operations.runStatus")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(path.join(run.dir, "stopped"))) return "stopped";
  if (run.record.awaiting || (yield* fs.exists(path.join(run.dir, CHOICE)))) return "waiting";
  if (run.record.status === "done") return "succeeded";
  return run.record.status === "running" ? "running" : "failed";
});

/**
 * Everything a start needs before anyone is asked anything: the Workflow resolved,
 * proven runnable, and its Inputs inferred. What fills the gaps afterwards — prompts
 * in a pane, flags on a command line — is the caller's business.
 */
export const prepareWorkflow = Effect.fn("operations.prepareWorkflow")(function* (
  env: PluginEnv,
  name: string,
) {
  const definitions = yield* loadDefinitions(yield* layers(env));
  const defaults = yield* loadDefaults(env.configDir);
  let workflow: ResolvedWorkflow;
  try {
    workflow = resolveWorkflow(name, definitions, defaults);
  } catch (cause) {
    if (cause instanceof DefinitionError) return err("workflow_not_found", cause.message);
    throw cause;
  }
  const problems = yield* validateWorkflow(workflow, definitions, defaults, yield* skillDirs(env));
  if (problems.length > 0) {
    return err(
      "operation_failed",
      `${name} is not runnable.`,
      Schema.decodeUnknownSync(YamlMapSchema)({ problems }),
    );
  }
  const resolutions = yield* inferInputs(workflow.inputs, {
    cwd: env.cwd,
    stateDir: env.stateDir,
  });
  return { ok: true, workflow, resolutions } as const;
});

/** A path value would slug the whole path, so a strategy may offer a short name. */
function primaryInput(resolutions: Resolution[]): string {
  const first = resolutions.find((r) => r.value !== "");
  if (!first) return "run";
  return first.label ?? first.value;
}

/**
 * Creates the Run and hands it to a detached Driver. Inputs are already settled.
 * Returns the Run, or the reason no Driver could be started for it.
 */
export const startRun = Effect.fn("operations.startRun")(function* (
  env: PluginEnv,
  options: {
    readonly workflow: ResolvedWorkflow;
    readonly resolutions: Resolution[];
    readonly workspace: WorkspaceInfo | null;
    readonly note?: string;
  },
) {
  const { workflow, resolutions, workspace } = options;
  const run = yield* new RunStore(env.stateDir).create({
    workflow: workflow.name,
    cwd: env.cwd,
    session: env.socketPath,
    workspace: workspace?.workspaceId ?? env.workspaceId,
    workspaceLabel: workspace?.label ?? null,
    workspaceWorktree: workspace?.worktree ?? null,
    inputs: inputValues(resolutions),
    inputSources: inputSources(resolutions),
    stepIds: workflow.steps.map((step) => step.id),
    maxIterations: workflow.maxIterations,
    primaryInput: primaryInput(resolutions),
  });
  yield* run.log(`created from ${workflow.path} (${workflow.layer} layer)`);
  if (options.note) yield* run.log(options.note);
  const undriven = yield* handOver(env, run);
  if (undriven) return undriven.result;
  return run;
});

/**
 * Hands the Run to a detached Driver, or says why none could be started — and records
 * that on the Run, because nothing is advancing it and nothing will, and a Run left
 * reported as `running` has no terminal state for `run wait` to return on.
 *
 * The reason comes back as a result rather than a failure so a caller's request
 * receipt records it, and a retry with the same request id replays it.
 */
export const handOver = Effect.fn("operations.handOver")(function* (env: PluginEnv, run: Run) {
  const why = yield* spawnDriver(env, run.id, run.record.cwd).pipe(
    Effect.as(null),
    Effect.catch((cause) => Effect.succeed(String(cause))),
  );
  if (!why) return null;
  yield* run.log(`driver did not start: ${why}`);
  run.record.status = "failed";
  run.record.finished_at = yield* nowIso();
  yield* run.save();
  return {
    why,
    result: err("operation_failed", `Could not start a Driver for run "${run.id}".`, {
      run: run.id,
      cause: why,
    }),
  };
});

/**
 * Which Choices this Run's inbox already answers. A command that will not read is
 * not an answer to anything: only the owning Driver acts on these, and it decides
 * for itself what to do with one it cannot parse.
 */
const answeredChoices = Effect.fn("operations.answeredChoices")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const answered = new Set<string>();
  for (const file of yield* inboxFiles(dir)) {
    const command = yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InboxAnswerCommandJson)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (command) answered.add(command.choiceId);
  }
  return answered;
});

/**
 * Answers the Run's current Choice. Only the owning Driver moves the Run on; this
 * checks that there is something to answer and that the answer is one of its own.
 */
export const answerRun = Effect.fn("operations.answerRun")(function* (
  run: { readonly id: string; readonly dir: string },
  answer: string,
  requestId: string,
) {
  const choice = yield* readChoice(run.dir);
  if (!choice) return err("run_not_waiting", `Run "${run.id}" is not waiting for a Choice.`);
  if ((yield* answeredChoices(run.dir)).has(choice.id))
    return err("choice_already_answered", `Choice "${choice.id}" already has an answer.`);
  // An empty answer is how a menu is dismissed; it leaves the Run open for a resume.
  if (choice.kind === "menu" && answer !== "" && !choice.items.some((item) => item.id === answer)) {
    return err("invalid_answer", `"${answer}" is not a valid answer.`, {
      answers: choice.items.map((item) => item.id),
    });
  }
  yield* writeInbox(run.dir, { type: "answer", requestId, choiceId: choice.id, answer });
  return ok({ runId: run.id, answer }, `Answered ${run.id}: ${answer}.`);
});

/**
 * Stops orchestration and closes only the panes this Run owns. Its agents keep
 * whatever they wrote; the repository is left exactly as it is.
 *
 * Two channels, because neither alone is enough. The inbox command is the record the
 * spec asks for and is what a Driver waiting on a Choice consumes. The signal is what
 * reaches a Driver that is mid-Step, waiting on an agent and reading no files.
 */
export const stopRun = Effect.fn("operations.stopRun")(function* (
  stateDir: string,
  herdr: Herdr,
  run: Run,
  scope: RegistryScope,
  requestId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* runStatus(run)) === "succeeded")
    return err("invalid_state", `Run "${run.id}" has already succeeded.`);
  // The request is recorded in the Run's own directory before anything is signalled,
  // so it is there whether or not the Driver lives long enough to consume it.
  yield* writeInbox(run.dir, { type: "stop", requestId });
  if (yield* driverAlive(run.dir)) {
    // Signalled before its panes are closed. stopDriver declines when it cannot
    // establish whose process it is about to signal — a claim whose start time will
    // not read is deliberately treated as alive — and when the kill fails. Closing
    // panes first would leave that refusal half-applied: the Driver still
    // orchestrating, its panes gone, and opening more the register cannot match.
    if (!(yield* stopDriver(run.dir)))
      return err("operation_failed", `Run "${run.id}" has a Driver that could not be signalled.`, {
        run: run.id,
      });
  } else {
    // A Run nothing is driving has no process left to notice a signal, so the stop is
    // recorded here instead.
    yield* fs.writeFileString(path.join(run.dir, "stopped"), `${yield* nowIso()}\n`);
    run.record.status = "blocked";
    yield* run.save();
  }
  const entries = (yield* readRegistry(yield* registryPath(stateDir, scope))).filter(
    (entry) => entry.runId === run.id,
  );
  yield* Effect.all(entries.map((entry) => herdr.paneClose(entry.paneId).pipe(Effect.result)));
  return ok({ runId: run.id, status: "stopped" }, `Stopped run ${run.id}.`);
});

/**
 * Starts a fresh Driver for work nothing is driving. Completed Steps stay done;
 * everything else goes back to pending so the new Driver picks it up.
 *
 * One resume at a time: the lock covers the liveness check, the Step reset and the
 * spawn together. A second Driver process can still be launched in the window before
 * the first writes its ownership claim, and the Driver's own `acquireDriver` is what
 * stops that one from driving; closing that window needs the resumer to hand the
 * child a claim it adopts, which is a protocol change, not a lock.
 *
 * Unlike a stop this writes no inbox command. A stop has a Driver to hand it to; a
 * resume runs only when none is alive, so a command in the inbox would have no reader
 * but the Driver this call is about to start, which does not need telling.
 */
export const resumeRun = Effect.fn("operations.resumeRun")(function* (env: PluginEnv, run: Run) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // driverAlive is a look, not a claim. Two resumes could both find no owner, both
  // reset the Steps and save `running`, and the loser's snapshot could then land on
  // top of a Run the winner had already begun advancing. This lock is what makes the
  // look and the reset one decision.
  const lock = path.join(run.dir, "resume.lock");
  const claim = Effect.gen(function* () {
    if (yield* tryClaimLock(lock)) return;
    if ((yield* breakStaleLock(lock)) && (yield* tryClaimLock(lock))) return;
    return yield* Effect.fail(new Error(`another resume of run "${run.id}" is in progress`));
  });
  yield* claim.pipe(Effect.retry({ times: 40, schedule: Schedule.spaced("25 millis") }));
  // Effect.ensuring, not try/finally: a typed failure unwinds past a generator's
  // finally without entering it, and the Run would stay locked against resuming.
  return yield* Effect.gen(function* () {
    if (yield* driverAlive(run.dir))
      return err("run_already_active", `Run "${run.id}" is already active.`);
    if ((yield* runStatus(run)) === "succeeded")
      return err("invalid_state", `Run "${run.id}" has already succeeded.`);
    yield* fs.remove(path.join(run.dir, "stopped"), { force: true });
    for (const step of run.record.steps) if (step.status !== "done") step.status = "pending";
    run.record.status = "running";
    run.record.finished_at = null;
    yield* run.save();
    // The reset has already happened and the stop marker is already gone, so a Run
    // handOver could not place would otherwise be worse off than before it was
    // resumed: reported as advancing, driven by nobody, nothing terminal to wait for.
    const undriven = yield* handOver(env, run);
    if (undriven) return undriven.result;
    return ok({ runId: run.id, status: "running" }, `Resumed run ${run.id}.`);
  }).pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
});
