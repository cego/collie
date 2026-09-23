import {
  Cause,
  Clock,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { clearOverride, err, type Failure } from "../operations";
import { withDirLock } from "../lock";
import { runDir } from "../native";
import { Herdr } from "../herdr";
import {
  describeWaiting,
  historyRefusal,
  importHistory,
  nativeHistory,
  answerNativeRun,
  anyNativeRuns,
  controlNativeRun,
  invokeNativeOffer,
  nativeOffers,
  steerNativeRun,
  moduleFor,
  neededInputs,
  nativeRun,
  nativeRuns,
  nativeSettled,
  recoverNativeRun,
  startNativeRun,
  statusOf,
  watchNativeRun,
} from "../lifecycle";
import type { HistoryRow } from "../store";
import type { Given, RunView } from "../native";
import { RESERVED_INPUTS } from "../sdk";
import {
  EMPTY_DEFAULTS,
  amend,
  defaultsPath,
  describeDefaults,
  authorityPatch,
  parseConstraint,
  propagate,
  readDefaults,
  readIntent,
  writeDefaults,
  writeIntent,
  writeIntentHeld,
  type Change,
  type Constraint,
  type Defaults,
  type Intent,
} from "../intent";
import { scopeFor, scopeKey } from "../registry";
import { readTask, taskOfWorkspace, type TaskChoice } from "../task";
import { runDeliveries } from "./steer";
import { currentReports, readDrift } from "../drift";
import { newest, readCards } from "../cards";
import { metricsOf, readMetrics } from "../metrics";
import { latest, readDispositions, recordDisposition, statusLine } from "../disposition";
import { nowIso, untilFrom } from "../time";
import type { PluginEnv } from "../env";
import {
  attempt,
  guarded,
  mutation,
  printResult,
  say,
  type CollieError,
  type Result,
} from "../envelope";
import {
  PrettyUnknownJson,
  UnknownJson,
  actorName,
  actorNow,
  context,
  mutating,
  asText,
  parseInput,
  locateRun,
  runFacts,
  requestIdFlag,
  runIdArg,
  root,
  selected,
  selectedTask,
  type Global,
} from "./shared";

/**
 * What `--constraint` and `--severity` say together. Paired by position rather than by
 * interleaved order, because a repeated flag arrives as its own list and the order
 * between two lists is not recoverable — so the pairing has to be one the human can see
 * in what they typed.
 */
function namedConstraints(texts: ReadonlyArray<string>, severities: ReadonlyArray<string>) {
  const constraints: Array<Omit<Constraint, "since">> = [];
  const refuse = (error: string) => ({ error, constraints });
  if (severities.length > texts.length)
    return refuse(`--severity was given more times than --constraint.`);
  for (const [index, text] of texts.entries()) {
    const level = severityOf(severities[index] ?? "warn");
    if (level === null) return refuse(`--severity is block or warn.`);
    const parsed = parseConstraint(text, level);
    if ("error" in parsed) return refuse(parsed.error);
    constraints.push(parsed);
  }
  return { error: null, constraints };
}

/**
 * Which Task this start belongs to. Fresh unless the caller said otherwise: neither the
 * Workflow's name nor the workspace this happens to be in continues anything, because a
 * continuation that was never asked for is how two pieces of work become one.
 *
 * The programmatic front door never waits for a prompt. Outside a Task's workspace,
 * `--continue-task` is missing input and says which flag would supply it.
 */
const chosenTask = Effect.fn("collie.chosenTask")(function* (
  env: PluginEnv,
  named: Option.Option<string>,
  current: boolean,
) {
  const refuse = (error: Result) => ({ ok: false as const, error });
  const taken = (choice: TaskChoice) => ({ ok: true as const, choice });
  if (Option.isSome(named)) {
    const task = yield* readTask(env.stateDir, named.value);
    if (!task)
      return refuse(
        err("task_not_found", `Task "${named.value}" was not found.`, { task: named.value }),
      );
    return taken({ mode: "continue", task });
  }
  if (!current) return taken({ mode: "new" });
  const here = yield* taskOfWorkspace(env.stateDir, env.workspaceId);
  if (!here)
    return refuse(
      err(
        "needs_input",
        "This workspace is not a task workspace; name the Task with --task, as `task list` prints it.",
      ),
    );
  return taken({ mode: "continue", task: here });
});

/**
 * What the host supplies at launch, split from what the author declared. A module may not
 * declare one of these names — `checkEntry` refuses that at load — so a value under one is
 * the host's option and never an input, and nothing of the host's reaches the payload.
 */
function hostOptions(given: Given) {
  return {
    input: {
      json: Object.fromEntries(Object.entries(given.json).filter(([name]) => !isOption(name))),
      text: Object.fromEntries(Object.entries(given.text).filter(([name]) => !isOption(name))),
    },
    options: Object.fromEntries([
      ...Object.entries(given.text).filter(([name]) => isOption(name)),
      ...Object.entries(given.json)
        .filter(([name]) => isOption(name))
        .map(([name, value]) => [name, asOptionText(value)]),
    ]),
  };
}

const isOption = (name: string) => name in RESERVED_INPUTS;

/** A host option is text; one that arrived as typed JSON is written back down as it came. */
const asOptionText = (value: Schema.Json) => (isText(value) ? value : asJsonText(value));
const isText = Schema.is(Schema.String);
const asJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * The launch flags a saved module does not take yet. Refused rather than dropped: a goal
 * nobody recorded and a decision nobody answered are worse than being told so here.
 */
function unsupportedFlags(flags: {
  readonly decide: ReadonlyArray<string>;
  readonly goal: Option.Option<string>;
  readonly constraint: ReadonlyArray<string>;
}): Failure | null {
  const given = [
    ...(flags.decide.length > 0 ? ["--decide"] : []),
    ...(Option.isSome(flags.goal) ? ["--goal"] : []),
    ...(flags.constraint.length > 0 ? ["--constraint"] : []),
  ];
  if (given.length === 0) return null;
  return err(
    "invalid_input",
    `A workflow saved as a module takes its own inputs; ${given.join(", ")} is not one of them yet.`,
  );
}

const runStart = Command.make(
  "start",
  {
    workflow: Argument.String("workflow").pipe(
      Argument.withDescription("Which Workflow to run, as `workflow list` names it"),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription(
        "key=value, repeatable; the names a Workflow takes are what `workflow show` lists",
      ),
      Flag.atLeast(0),
    ),
    inputsJson: Flag.String("inputs-json").pipe(
      Flag.withDescription("Every Input at once, as one JSON object"),
      Flag.optional,
    ),
    decide: Flag.String("decide").pipe(
      Flag.withDescription(
        "step=title, repeatable; answers a Choice step now instead of stopping there",
      ),
      Flag.atLeast(0),
    ),
    goal: Flag.String("goal").pipe(
      Flag.withDescription("What this Run is for, in the human's own words"),
      Flag.optional,
    ),
    constraint: Flag.String("constraint").pipe(
      Flag.withDescription(
        "What the work must respect, repeatable; `rule:<kind>:<args>` for one Collie checks",
      ),
      Flag.atLeast(0),
    ),
    severity: Flag.String("severity").pipe(
      Flag.withDescription(
        "block or warn for the --constraint in the same position; warn where none is given",
      ),
      Flag.atLeast(0),
    ),
    task: Flag.String("task").pipe(
      Flag.withDescription("Continue this Task instead of starting a new one, by its id"),
      Flag.optional,
    ),
    continueTask: Flag.Boolean("continue-task").pipe(
      Flag.withDescription("Continue the Task whose workspace this is; fails outside one"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({
    workflow,
    input,
    inputsJson,
    decide,
    goal,
    constraint,
    severity,
    task: taskId,
    continueTask,
    requestId: request,
  }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const base = yield* context(global, false);
          if (base._tag === "ContextFailure") return base.result;
          const explicit = yield* parseInput(input, inputsJson);
          if (!explicit.ok) return explicit.error;
          const named = namedConstraints(constraint, severity);
          if (named.error !== null) return err("invalid_input", named.error);
          return yield* mutation(base.env, "run-start", request, (requestId) =>
            Effect.gen(function* () {
              // The live workspace is resolved inside the mutation, so replaying a
              // receipt returns what was recorded rather than needing that workspace
              // to still be open. Only a start that is actually happening needs it.
              const resolved = yield* context(global, (yield* selected(global)) !== null);
              if (resolved._tag === "ContextFailure") return resolved.result;
              // Which Task, before the Workflow is prepared: inference is task-local,
              // so a continuation sees its own Task's plans and a fresh start sees only
              // the Runs recorded before Tasks existed.
              const task = yield* chosenTask(resolved.env, taskId, continueTask);
              if (!task.ok) return task.error;
              // A workflow saved as a module is that module, wherever a Markdown
              // definition of the same name also is: what an id runs is decided by what
              // is saved for this project, never by a flag naming an engine.
              const saved = yield* moduleFor(resolved.env, workflow);
              if (saved !== null) {
                const unsupported = unsupportedFlags({ decide, goal, constraint });
                if (unsupported !== null) return unsupported;
                // The host's own options are settled apart from the author's payload, so
                // nothing the host supplies is ever injected into a module's input.
                const launch = hostOptions(explicit.given);
                // What it declares and nobody gave, with the schemas to answer it by, so
                // a caller can fill the gaps and retry under the same request id.
                const needed = "inputs" in saved ? neededInputs(saved, launch.input) : null;
                if (needed !== null) return needed;
                const started = yield* startNativeRun(resolved.env, {
                  id: workflow,
                  request: requestId,
                  input: launch.input,
                  options: launch.options,
                  task: task.choice,
                });
                if (!started.ok) return started;
                return {
                  ok: true,
                  data: {
                    runId: started.runId,
                    workflow,
                    registration: started.registration,
                    fresh: started.fresh,
                  },
                  human: `Started run ${started.runId}.`,
                };
              }
              // Nothing else runs work. An id with no module is a workflow this
              // installation does not have, said once, with where to look.
              return err(
                "workflow_not_found",
                `No workflow module is saved as "${workflow}". \`collie workflow list\` is what this installation has, and \`collie workflow create ${workflow}\` starts one.`,
                { workflow },
              );
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Start a Workflow and return the new Run's id"),
  Command.withExamples([
    {
      command:
        "collie run start review --input target=https://gitlab.example.com/acme/app/-/merge_requests/2",
      description: "Review a merge request, by URL or by bare iid",
    },
    {
      command: "collie run start implement --input plan=ENG-123",
      description: "Build from a Linear issue, a plan directory, or a description",
    },
  ]),
);

/** The text Inputs an older Collie settled, as it wrote them. */
const TextMap = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const runList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        // Scoped to the Task whose workspace this is, where it is one: Runs belong to
        // Tasks now, and a workspace that is not a Task's narrows nothing.
        const task = yield* selectedTask(global);
        const native = yield* nativeRuns(resolved.env, task);
        // Beside them, what an older Collie recorded. One listing: an operator asking
        // what has been done here should not have to know which engine did it.
        const imported = yield* nativeHistory(resolved.env, task);
        return {
          ok: true,
          data: {
            runs: native.runs,
            history: imported.rows,
            unreadable: native.unreadable ?? imported.unreadable,
          },
          human:
            [
              ...native.runs.map((view) => `${view.runId}\t${statusOf(view)}\t${view.workflow}`),
              ...imported.rows.map((row) => `${row.run}\t${row.status}\t${row.workflow}\thistory`),
              ...(native.unreadable === null ? [] : [`runs: ${native.unreadable}`]),
              ...(imported.unreadable === null ? [] : [`history: ${imported.unreadable}`]),
            ].join("\n") || "No runs found.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("List Runs in the selected workspace, or everywhere without one"));

/** The Run this command is about, and the environment it was resolved in. */
const resolveCommandRun = Effect.fn("collie.resolveCommandRun")(function* (
  global: Global,
  runId: string,
) {
  const resolved = yield* context(global, false);
  if (resolved._tag === "ContextFailure")
    return { _tag: "RunFailure" as const, result: resolved.result };
  const located = yield* locateRun(resolved.env, runId, yield* selectedTask(global));
  // The environment travels with the Run: a command that then reads the Run's children
  // out of the same state directory should not resolve the context twice.
  return located._tag === "RunFailure" ? located : { ...located, env: resolved.env };
});

/**
 * A parent's Runs, one line each: an agent driving Collie follows a chain from here, and
 * work that spans repositories is several Runs whose relation is otherwise only in the
 * `--json` payload.
 */
const childLines = Effect.fn("run.childLines")(function* (env: PluginEnv, runId: string) {
  const children = (yield* nativeRuns(env, null)).runs.filter((view) => view.parent === runId);
  return children.map((view) => `  ${view.runId}\t${view.workflow}\t${statusOf(view)}`);
});

const runShow = Command.make(
  "show",
  {
    runId: runIdArg,
  },
  ({ runId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") return resolved.result;
          // Both facts on the head line: how execution ended, and what became of the
          // work. A Run that failed and whose work shipped anyway says both.
          const disposition = latest(yield* readDispositions(resolved.dir));
          if (resolved._tag === "Imported") {
            const row = resolved.row;
            return {
              ok: true,
              data: { run: importedData(row), disposition },
              human: [
                `${row.run}\t${statusLine(row.status, disposition)}\t${row.workflow}`,
                // Said on every read of one, because the id looks like any other and
                // the one thing a caller must not do with it is expect it to carry on.
                "Recorded by the engine Collie no longer has: readable, never resumable.",
              ].join("\n"),
            };
          }
          const view = resolved.view;
          return {
            ok: true,
            data: {
              run: view,
              disposition,
              outcome: view.outcome,
              waiting: view.waiting,
              next_action: view.waiting[0]?.name ?? null,
            },
            human: [
              `${view.runId}\t${statusLine(statusOf(view), disposition)}\t${view.workflow}`,
              ...describeWaiting(view),
              ...(yield* childLines(resolved.env, runId)),
            ].join("\n"),
          };
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Show one Run: its state, its Inputs, and any question it is waiting on"),
);

const runMetrics = Command.make(
  "metrics",
  {
    runId: runIdArg,
  },
  ({ runId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") return resolved.result;
          const facts = runFacts(resolved);
          const metrics = metricsOf(yield* readMetrics(resolved.evidence), facts.created);
          const said = (value: number | null) =>
            value === null ? "not yet" : `${Math.round(value)}s`;
          return {
            ok: true,
            data: { metrics, outcome: facts.outcome },
            human: [
              `${facts.id}\t${facts.workflow}\t${facts.outcome}`,
              `time to first evidence: ${said(metrics.timeToFirstEvidence)}`,
              `verifications: ${metrics.verifications.pass} pass, ${metrics.verifications.fail} fail, ${metrics.verifications.unstable} unstable (${metrics.verifications.byCollie} by collie)`,
              `slices: ${metrics.slices.done} of ${metrics.slices.total} done`,
              `rework: ${metrics.rework} (fix rounds and halts)`,
              metrics.peakContext === null
                ? "context: nothing sampled"
                : `context: ${metrics.peakContext.tokens} tokens at most, on ${metrics.peakContext.agent}`,
            ].join("\n"),
          };
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "What a Run actually did: evidence, slices, rework and context — not pane activity",
  ),
);

/**
 * Everything the Run wrote, as JSON where it is JSON. The files are the record — an
 * agent's Output, a review, a plan — so this reads the directory rather than a list some
 * engine kept of what it put there.
 */
const runOutput = Command.make(
  "output",
  {
    runId: runIdArg,
  },
  ({ runId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") return resolved.result;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outputs: Array<{ path: string; value?: unknown; error?: string }> = [];
          for (const file of yield* outputFiles(resolved.dir)) {
            const relative = path.relative(resolved.dir, file);
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
            human:
              outputs
                .map((output) => {
                  const body = output.error
                    ? `Error: ${output.error}`
                    : Schema.encodeSync(PrettyUnknownJson)(output.value);
                  return `${output.path}\n${body
                    .split("\n")
                    .map((line) => `  ${line}`)
                    .join("\n")}`;
                })
                .join("\n\n") || "This Run has written no Outputs.",
          };
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Print every Output this Run has written"));

/** Every `.json` a Run left, wherever under its own directory it left it. */
const outputFiles = Effect.fn("run.outputFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: string[] = [];
  const walk = Effect.fn("run.outputFiles.walk")(function* (
    at: string,
    depth: number,
  ): Generator<Effect.Effect<unknown, PlatformError.PlatformError, FileSystem.FileSystem>, void> {
    if (depth > 4) return;
    for (const name of yield* fs.readDirectory(at).pipe(Effect.catch(() => Effect.succeed([])))) {
      const here = path.join(at, name);
      const stat = yield* fs.stat(here).pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat === null) continue;
      if (stat.type === "Directory") yield* walk(here, depth + 1);
      else if (name.endsWith(".json")) found.push(here);
    }
  });
  yield* walk(dir, 0);
  return found.sort();
});

/**
 * How often an attention wait re-reads a Run whose Driver may have died silently, and
 * the ceiling it backs off to. The check costs a process probe — a `ps` on a system with
 * no `/proc` — and a Run that takes two hours does not need one every two seconds for
 * all of it. Quick at first, because a Driver that dies is most likely to die early and a
 * caller who has just started waiting is the one still watching; then rarer, because a
 * wait that has gone on for an hour is a wait on something that is working. The ceiling
 * is what keeps it bounded: a lost Driver is always noticed, within half a minute.
 */
const HEALTH_CHECK_MS = 2_000;
const HEALTH_CHECK_CEILING_MS = 30_000;

/**
 * How often filesystem events are acted on: at most one look per window, with the
 * first of each window passing straight through. Short enough that nobody notices,
 * long enough that a Run writing a burst of log lines is one look rather than twenty.
 */
const EVENT_WINDOW = {
  cost: () => 1,
  units: 1,
  duration: "100 millis",
  strategy: "enforce",
} as const;

/** The bounded re-read itself: it ends the moment the Run has something to say. */
const healthCheck = Effect.fn("collie.runWait.healthCheck")(function* (
  emit: () => Effect.Effect<boolean, CollieError, BunServices>,
) {
  let wait = HEALTH_CHECK_MS;
  for (;;) {
    yield* Effect.sleep(wait);
    if (yield* emit()) return;
    wait = Math.min(wait * 2, HEALTH_CHECK_CEILING_MS);
  }
});

type ParsedTimeout = { ok: true; ms: number | null } | { ok: false; error: Result };

/** A duration in Effect's canonical `DurationFromString` grammar. */
function parseTimeout(value: Option.Option<string>): ParsedTimeout {
  if (Option.isNone(value)) return { ok: true, ms: null };
  const duration = Schema.decodeUnknownOption(Schema.DurationFromString)(value.value);
  return Option.isSome(duration)
    ? { ok: true, ms: Duration.toMillis(duration.value) }
    : { ok: false, error: err("invalid_input", `Invalid timeout "${value.value}".`) };
}

type Until = "terminal" | "attention";
type ParsedUntil = { ok: true; until: Until } | { ok: false; error: Result };

/** What ends the wait. Omitted keeps the terminal-only wait every caller already has. */
function parseUntil(value: Option.Option<string>): ParsedUntil {
  if (Option.isNone(value)) return { ok: true, until: "terminal" };
  if (value.value === "terminal" || value.value === "attention")
    return { ok: true, until: value.value };
  return {
    ok: false,
    error: err("invalid_input", `Invalid --until "${value.value}"; use terminal or attention.`),
  };
}

const runWait = Command.make(
  "wait",
  {
    runId: runIdArg,
    follow: Flag.Boolean("follow").pipe(
      Flag.withDescription("Print each Step's progress while waiting, instead of only the result"),
      Flag.withDefault(false),
    ),
    timeout: Flag.String("timeout").pipe(
      Flag.withDescription("Give up after this long, e.g. `30 seconds`, `10 minutes`"),
      Flag.optional,
    ),
    until: Flag.String("until").pipe(
      Flag.withDescription(
        "`terminal` (the default) waits for the Run to end; `attention` also returns on a question",
      ),
      Flag.optional,
    ),
  },
  ({ runId, follow, timeout, until }) =>
    Effect.gen(function* () {
      const global = yield* root;
      // `guarded`, not `attempt`: this command streams its own lines rather than
      // returning one result, but a defect must still end as one envelope like
      // everywhere else.
      yield* guarded(waitFor(global, runId, follow, timeout, until), global.json);
    }),
).pipe(
  Command.withDescription("Wait for a Run to finish, or to need attention, optionally following"),
);

/**
 * A native Run watched to the end, or to the question it is waiting on. Every state the
 * host reports arrives here, current one first — so a wait that starts long after the
 * work did is not waiting for an update that has already happened.
 */
const waitForNative = Effect.fn("collie.waitForNative")(function* (
  global: Global,
  env: PluginEnv,
  runId: string,
  options: {
    readonly follow: boolean;
    readonly ms: number | null;
    readonly wantsAttention: boolean;
  },
) {
  const seen = yield* Ref.make<RunView | null>(null);
  const enough = (view: RunView) =>
    nativeSettled(view) || (options.wantsAttention && view.status.status === "suspended");
  const watching = watchNativeRun(env, runId, (view) =>
    Effect.gen(function* () {
      const last = yield* Ref.getAndSet(seen, view);
      // One line per change, not per look: a run polled while it waits is not news.
      if (options.follow && (last === null || statusOf(last) !== statusOf(view))) {
        yield* say(
          global.json
            ? Schema.encodeSync(UnknownJson)({ type: "status", run: view })
            : `${view.runId}: ${statusOf(view)}`,
        );
      }
      return enough(view);
    }).pipe(Effect.orDie),
  ).pipe(Effect.scoped);
  const bounded = options.ms === null ? watching : watching.pipe(Effect.timeout(options.ms));
  const failed = yield* bounded.pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Cause.isTimeoutError(cause)
          ? err("timeout", `Timed out waiting for run "${runId}".`)
          : err("operation_failed", `Could not watch run "${runId}".`, { cause: String(cause) }),
      ),
    ),
  );
  if (failed !== null) return yield* printResult(failed, global.json);
  // `--follow` has already said everything as it happened, as it does for a Run with a
  // Driver: one envelope after the stream would be the last line twice.
  if (options.follow) return;
  const view = yield* Ref.get(seen);
  if (view === null)
    return yield* printResult(
      err("run_not_found", `Run "${runId}" was not found.`, { run: runId }),
      global.json,
    );
  yield* printResult(
    { ok: true, data: { run: view }, human: `${view.runId}: ${statusOf(view)}` },
    global.json,
  );
});

export const waitFor = Effect.fn("collie.waitFor")(function* (
  global: Global,
  runId: string,
  follow: boolean,
  timeout: Option.Option<string>,
  until: Option.Option<string> = Option.none(),
) {
  const resolved = yield* context(global, false);
  if (resolved._tag === "ContextFailure") return yield* printResult(resolved.result, global.json);
  const timeoutResult = parseTimeout(timeout);
  if (!timeoutResult.ok) return yield* printResult(timeoutResult.error, global.json);
  const { ms } = timeoutResult;
  const untilResult = parseUntil(until);
  if (!untilResult.ok) return yield* printResult(untilResult.error, global.json);
  const wantsAttention = untilResult.until === "attention";
  const located = yield* locateRun(resolved.env, runId, yield* selectedTask(global));
  if (located._tag === "RunFailure") return yield* printResult(located.result, global.json);
  // Imported work has already happened. A wait on it answers with what it became rather
  // than watching a directory nothing will write to again.
  if (located._tag === "Imported") {
    const row = located.row;
    return yield* printResult(
      { ok: true, data: { run: importedData(row) }, human: `${row.run}: ${row.status}` },
      global.json,
    );
  }
  return yield* waitForNative(global, resolved.env, runId, { follow, ms, wantsAttention });
});

/** An imported Run as a front door returns one: its facts, and that it is history. */
function importedData(row: HistoryRow) {
  return {
    id: row.run,
    workflow: row.workflow,
    project: row.project,
    task: row.task,
    parent: row.parent,
    status: row.status,
    created_at: row.created,
    finished_at: row.finished,
    summary: row.summary,
    inputs: Schema.decodeUnknownSync(TextMap)(row.inputs),
    provenance: Schema.decodeUnknownSync(UnknownJson)(row.provenance),
    evidence: Schema.decodeUnknownSync(UnknownJson)(row.evidence),
    /** Nothing can run it again, and every door says so the same way. */
    resumable: false,
  };
}

/**
 * One command against one Run. The host settles it, because the host is the only thing
 * executing anything; an id it does not have is either unknown or imported, and imported
 * work is told what it is rather than reported missing.
 */
function runMutationCommand(
  operation: string,
  runId: string,
  requestId: Option.Option<string>,
  wanted: string,
  native: (env: PluginEnv, id: string) => Effect.Effect<Result, CollieError, BunServices>,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* mutation(resolved.env, operation, requestId, (id) =>
          Effect.gen(function* () {
            const imported = yield* historyRefusal(resolved.env, runId, wanted);
            if (imported !== null) return imported;
            if (!(yield* anyNativeRuns(resolved.env)))
              return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
            return yield* native(resolved.env, id);
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
    runId: runIdArg,
    answer: Argument.String("answer").pipe(
      Argument.withDescription("The Choice to take, as `run show` titles it"),
    ),
    expectChoice: Flag.String("expect-choice").pipe(
      Flag.withDescription(
        "Only answer while this is still the pending Choice, as `run wait --until attention` returns its id",
      ),
      Flag.optional,
    ),
    decision: Flag.String("decision").pipe(
      Flag.withDescription(
        "Which question, for a workflow module waiting on more than one; `run show` names them",
      ),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, answer, expectChoice, decision, requestId }) =>
    runMutationCommand("run-answer", runId, requestId, "answered", (env, id) =>
      answerNativeRun(env, {
        runId,
        decision: Option.getOrNull(decision),
        value: answer,
        request: id,
      }),
    ),
).pipe(Command.withDescription("Answer the Choice or the decision a waiting Run is asking"));

const runSteer = Command.make(
  "steer",
  {
    runId: runIdArg,
    text: Argument.String("text").pipe(
      Argument.withDescription("What to say to the agent this Run has, in your own words"),
    ),
    operation: Flag.String("operation").pipe(
      Flag.withDescription("Which of the Run's agents; the one most recently launched by default"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, text, operation, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          if (!(yield* anyNativeRuns(resolved.env))) {
            return err("run_not_found", `No workflow host has a Run "${runId}".`, { run: runId });
          }
          return yield* mutation(resolved.env, "run-steer", requestId, (id) =>
            steerNativeRun(resolved.env, {
              runId,
              text,
              request: id,
              operation: Option.getOrNull(operation) ?? undefined,
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Say something to the agent a workflow module's Run has, through the one sender",
  ),
);

const mutationFlags = {
  runId: runIdArg,
  requestId: requestIdFlag,
};

const runStop = Command.make("stop", mutationFlags, ({ runId, requestId }) =>
  // A Run stops where it next looks, and its agent keeps whatever it is holding:
  // halting a harness is its own action, not something a stopped Run implies.
  runMutationCommand("run-stop", runId, requestId, "stopped", (env) =>
    controlNativeRun(env, { runId, control: "stop", set: true }),
  ),
).pipe(Command.withDescription("Stop a Run and close only the panes it owns"));

const reasonFlag = Flag.String("reason").pipe(
  Flag.withDescription("Why, in your own words; it is shown wherever the hold is"),
  Flag.withDefault("no reason given"),
);

const untilFlag = Flag.String("until").pipe(
  Flag.withDescription("When the hold lifts by itself: `14:00`, or a full timestamp"),
  Flag.optional,
);

const holdWorkspaceFlag = Flag.String("workspace").pipe(
  Flag.withDescription("Hold every unfinished Run in this workspace instead of one Run"),
  Flag.optional,
);

type ParsedEnd = { ok: true; until: string | null } | { ok: false; error: Result };

/**
 * When a hold ends. Refused here rather than carried as words nobody can act on: a hold
 * whose end the Driver cannot read is a hold that never lifts.
 */
function parseEnd(value: Option.Option<string>, nowMs: number): ParsedEnd {
  if (Option.isNone(value)) return { ok: true, until: null };
  const at = untilFrom(value.value, nowMs);
  return at === null
    ? {
        ok: false,
        error: err(
          "invalid_input",
          `Invalid --until "${value.value}"; use a clock time like 14:00, or a full timestamp.`,
        ),
      }
    : { ok: true, until: at };
}

/**
 * Every Run of the Task this workspace belongs to, held. A workspace is where a Task is
 * worked, so "hold this workspace" is the Task's Runs and not whatever else is open in it.
 */
const holdTask = Effect.fn("run.holdTask")(function* (env: PluginEnv, workspace: string) {
  const task = yield* taskOfWorkspace(env.stateDir, workspace);
  if (task === null)
    return err("invalid_input", `Workspace "${workspace}" is not a Task's.`, { workspace });
  const runs = (yield* nativeRuns(env, task.id)).runs.filter((view) => !nativeSettled(view));
  const held: string[] = [];
  for (const view of runs) {
    const done = yield* controlNativeRun(env, { runId: view.runId, control: "hold", set: true });
    if (done.ok) held.push(view.runId);
  }
  return {
    ok: true as const,
    data: { task: task.id, workspace, held },
    human: held.length === 0 ? "Nothing here is running." : `Held ${held.join(", ")}.`,
  };
});

const runHold = Command.make(
  "hold",
  {
    runId: runIdArg.pipe(Argument.optional),
    workspace: holdWorkspaceFlag,
    reason: reasonFlag,
    until: untilFlag,
    requestId: requestIdFlag,
  },
  ({ runId, workspace, reason, until, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      const ends = parseEnd(until, yield* Clock.currentTimeMillis);
      const where = Option.getOrNull(workspace);
      const id = Option.getOrNull(runId);
      yield* attempt(
        Effect.gen(function* () {
          if (!ends.ok) return ends.error;
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          if (where !== null) {
            return yield* mutation(resolved.env, "run-hold-workspace", requestId, () =>
              holdTask(resolved.env, where),
            );
          }
          if (id === null) {
            return err(
              "invalid_input",
              "`run hold` takes a Run's id, or `--workspace <id>` for every Run in one.",
            );
          }
          return yield* mutation(resolved.env, "run-hold", requestId, () =>
            Effect.gen(function* () {
              const imported = yield* historyRefusal(resolved.env, id, "held");
              if (imported !== null) return imported;
              if (!(yield* anyNativeRuns(resolved.env)))
                return err("run_not_found", `Run "${id}" was not found.`, { run: id });
              return yield* controlNativeRun(resolved.env, {
                runId: id,
                control: "hold",
                set: true,
              });
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Stop a Run taking on new work; what is already running carries on"),
);

const runRelease = Command.make(
  "release",
  { runId: runIdArg, reason: reasonFlag, requestId: requestIdFlag },
  ({ runId, reason, requestId }) =>
    runMutationCommand("run-release", runId, requestId, "released", (env) =>
      controlNativeRun(env, { runId, control: "hold", set: false }),
    ),
).pipe(Command.withDescription("Let a held Run carry on"));

const runClearOverride = Command.make(
  "clear-override",
  {
    runId: runIdArg,
    agent: Argument.String("agent").pipe(
      Argument.withDescription("The agent, as `run show` names it"),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, agent, requestId }) =>
    runMutationCommand("run-clear-override", runId, requestId, "corrected again", (env, id) =>
      clearOverride(env.stateDir, new Herdr(env), runId, agent, actorName(actorNow(id))),
    ),
).pipe(
  Command.withDescription("Let Collie correct an agent again after someone typed into its pane"),
);

/**
 * What became of a Run's work, which is not the same fact as how its execution ended. A
 * Run that failed still failed; this says whether the work landed anyway, and by what.
 * Nothing here can reach the Run's status, so a row can stop being a lie without the
 * history becoming one. Without `--as` it reads rather than writes, like its neighbours.
 */
const runDisposition = Command.make(
  "disposition",
  {
    runId: runIdArg,
    as: Flag.Literals("as", ["merged", "abandoned", "superseded"]).pipe(
      Flag.withDescription("Record what became of the work; without it, this only reads"),
      Flag.optional,
    ),
    ref: Flag.String("ref").pipe(
      Flag.withDescription("What backs it up: a merge request, a commit, or the Run that took it"),
      Flag.withDefault(""),
    ),
    note: Flag.String("note").pipe(
      Flag.withDescription("Anything a reader would need, in your own words"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, as, ref, note, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") return resolved.result;
          const facts = runFacts(resolved);
          const status = resolved._tag === "Native" ? statusOf(resolved.view) : resolved.row.status;
          const kind = Option.getOrNull(as);
          if (kind === null) {
            const lines = yield* readDispositions(resolved.evidence);
            return {
              ok: true,
              data: { run: facts.id, status, disposition: latest(lines), lines },
              human: statusLine(status, latest(lines)),
            };
          }
          return yield* mutation(resolved.env, "run-disposition", requestId, (id) =>
            Effect.gen(function* () {
              const line = {
                at: yield* nowIso(),
                by: actorName(actorNow(id)),
                kind,
                ref,
                note: Option.getOrNull(note),
              };
              yield* recordDisposition(resolved.evidence, line);
              return {
                ok: true,
                data: { run: facts.id, status, disposition: line },
                human: statusLine(status, line),
              };
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("What became of a Run's work, recorded beside its status not over it"),
);

const runDrift = Command.make("drift", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const lines = yield* readDrift(resolved.evidence);
        const reports = currentReports(lines);
        const skipped = lines.flatMap((line) => (line.kind === "skipped" ? [line] : []));
        return {
          ok: true,
          data: { reports, skipped },
          human:
            [
              ...reports.map(
                (report) =>
                  `${report.resolution}\t${report.severity}\t${report.kind}\t${report.constraint}\t${report.evidence
                    .map((ref) => ref.path ?? ref.excerpt ?? ref.kind)
                    .join(", ")}${report.evidence_truncated ? " (evidence truncated)" : ""}`,
              ),
              // A judgement nobody could make is worth saying: the alternative is a Run
              // that looks clean because nothing looked at it.
              ...skipped.map((line) => `skipped\t${line.reason}`),
            ].join("\n") || "Nothing has drifted.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("What this Run has drifted from, and the evidence for it"));

const runCards = Command.make("cards", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const cards = newest(yield* readCards(resolved.evidence));
        return {
          ok: true,
          data: { cards },
          human:
            cards
              .map(
                (card) =>
                  `${card.at}\t${card.kind}\t${card.step}\t${card.readiness}\t${card.significance}\taligned:${card.aligned}` +
                  (card.missing.length > 0 ? `\n  unchecked: ${card.missing.join("; ")}` : ""),
              )
              .join("\n") || "No cards yet.",
        };
      }),
      global.json,
    );
  }),
).pipe(
  Command.withDescription(
    "Each slice of this Run's work: what changed, what backs it, what does not",
  ),
);

/**
 * What a finished Run offers to do next. The offers are the Workflow's own declaration,
 * decided against the facts as they are now — so what this prints is what invoking one
 * would actually do, not what a card said a minute ago.
 */
const runActions = Command.make("actions", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        // Current code supplies the actions, so a Run whose module has gone offers
        // nothing and says why — and imported work offers nothing at all.
        const imported = yield* historyRefusal(resolved.env, runId, "asked what it offers");
        if (imported !== null) return imported;
        if (!(yield* anyNativeRuns(resolved.env)))
          return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
        return yield* nativeOffers(resolved.env, runId);
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("What this Run offers to do next, and why each one is there"));

const runAction = Command.make(
  "action",
  {
    runId: runIdArg,
    offer: Argument.String("offer").pipe(
      Argument.withDescription("The offer's id, as `run actions` lists it"),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription("key=value, repeatable: what the offer's own arguments take"),
      Flag.atLeast(0),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, offer, input, requestId }) =>
    runMutationCommand("run-action", runId, requestId, "asked to do anything", (env, id) =>
      invokeNativeOffer(env, {
        runId,
        offer,
        input: Object.fromEntries(
          input.flatMap((pair) => {
            const at = pair.indexOf("=");
            return at === -1 ? [] : [[pair.slice(0, at), pair.slice(at + 1)] as const];
          }),
        ),
        request: id,
      }),
    ),
).pipe(Command.withDescription("Do one of the things this Run offers, if it still offers it"));

/** Said to a human who reached for `--workspace` as though it moved the Run. */
const RESUME_WORKSPACE =
  "--workspace only chose where this command looked; it does not move a Run. The Run goes back to its Task's workspace, which is reopened on its checkout if herdr has closed it.";

const runResume = Command.make("resume", mutationFlags, ({ runId, requestId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* mutation(resolved.env, "run-resume", requestId, () =>
          Effect.gen(function* () {
            // Imported work cannot be picked up: the engine that was running it is not
            // here, and its record says what it got to rather than where it stopped.
            const imported = yield* historyRefusal(resolved.env, runId, "resumed");
            if (imported !== null) return imported;
            if (!(yield* anyNativeRuns(resolved.env)))
              return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
            // What picks a Run up is the host registering the modules as they are now and
            // handing over what is still outstanding — which a repaired file needs — and
            // then the stop being cleared, so work that was stopped is not stopped again.
            const recovered = yield* recoverNativeRun(resolved.env, runId);
            if (!recovered.ok) return recovered;
            // Cleared after the module is registered again, so the run that wakes up is
            // one this host can run and does not find the stop that parked it still set.
            yield* controlNativeRun(resolved.env, { runId, control: "stop", set: false });
            if (Option.isNone(global.workspace) || !recovered.ok) return recovered;
            return {
              ok: true as const,
              data: { ...recovered.data, note: RESUME_WORKSPACE },
              human: `${recovered.human}\n${RESUME_WORKSPACE}`,
            };
          }),
        );
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Pick a Run up again on the modules as they are now"));

/**
 * Every `run intent` mutation goes through here: read the Intent, apply one pure
 * `amend`, write it back. The version the caller is told is the one on disk, so a
 * change that turned out to be a no-op reports the version that still stands rather
 * than one nobody wrote.
 */
function intentChange(
  operation: string,
  runId: string,
  requestId: Option.Option<string>,
  change: (intent: Intent) => Change | Failure,
  options: { readonly propagate?: boolean } = {},
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        if (resolved._tag === "Imported")
          return err(
            "operation_failed",
            `${runId} was recorded by the engine Collie no longer has; its Intent is history and cannot be amended.`,
            { run: runId, history: true },
          );
        const dir = resolved.dir;
        return yield* mutation(resolved.env, operation, requestId, (id) =>
          Effect.gen(function* () {
            // Read, decide and write as one act. Two amendments that both read v1 would
            // otherwise both report v2 and the later rename would erase the earlier one.
            const amended = yield* withDirLock<
              Failure | Intent,
              Error | PlatformError.PlatformError,
              FileSystem.FileSystem | Path.Path | BunServices
            >(
              dir,
              Effect.gen(function* () {
                const intent = yield* readIntent(dir).pipe(
                  Effect.mapError((cause) => new Error(String(cause))),
                );
                if (intent === null)
                  return err("invalid_state", `Run "${runId}" has no Intent to amend.`);
                const wanted = change(intent);
                if ("ok" in wanted) return wanted;
                const next = amend(intent, wanted, actorName(actorNow(id)), yield* nowIso());
                if (next !== intent) yield* writeIntentHeld(dir, next);
                return next;
              }),
            );
            if ("ok" in amended) return amended;
            // Nothing is told: a Run reads its Intent at its next boundary, from the file
            // it has just been written to, which is what makes this one write rather than
            // a write and a message that can disagree with it.
            const propagated = options.propagate
              ? yield* propagateToChildren(resolved.env, runId, amended)
              : [];
            return {
              ok: true,
              data: { runId, version: amended.version, propagated },
              human: [`${runId}: intent v${amended.version}`, ...propagated].join("\n"),
            };
          }),
        );
      }),
      global.json,
    );
  });
}

/**
 * The parent's amended Intent applied to every child that is still going. The child's own
 * entries are kept and conflicts are reported, never resolved — `propagate` decides that,
 * and this only writes what it decided. Each child picks the new version up at its next
 * boundary.
 */
const propagateToChildren = Effect.fn("run.propagateToChildren")(function* (
  env: PluginEnv,
  parent: string,
  intent: Intent,
) {
  const lines: string[] = [];
  const children = (yield* nativeRuns(env, null)).runs.filter(
    (view) => view.parent === parent && !nativeSettled(view),
  );
  for (const child of children) {
    const dir = runDir(env.stateDir, child.runId);
    const current = yield* readIntent(dir).pipe(Effect.catch(() => Effect.succeed(null)));
    if (current === null) continue;
    const { intent: next, conflicts } = propagate(intent, current);
    yield* writeIntent(dir, next);
    lines.push(
      `  ${child.runId}: propagated${conflicts.length ? ` (${conflicts.join("; ")})` : ""}`,
    );
  }
  return lines;
});

const severityFlag = Flag.String("severity").pipe(
  Flag.withDescription("block or warn; warn is the default"),
  Flag.withDefault("warn"),
);

const propagateFlag = Flag.Boolean("propagate").pipe(
  Flag.withDescription("Apply the amended Intent to every child Run that is still going"),
  Flag.withDefault(false),
);

function severityOf(value: string): "block" | "warn" | null {
  return value === "block" || value === "warn" ? value : null;
}

const intentShow = Command.make("show", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const intent = yield* readIntent(resolved.dir);
        if (intent === null) return err("invalid_state", `Run "${runId}" has no Intent.`);
        return {
          ok: true,
          data: { intent },
          human: [
            `v${intent.version}\tgoal: ${intent.goal ?? "(none)"}`,
            ...intent.constraints.map(
              (c) => `  ${c.id}\t${c.severity}\t${c.kind}\t${c.source}\t${c.text}`,
            ),
            ...intent.history.map((h) => `  v${h.version}\t${h.by}\t${h.change}`),
          ].join("\n"),
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Show a Run's goal, constraints, authority and history"));

const intentSetGoal = Command.make(
  "set-goal",
  {
    runId: runIdArg,
    goal: Argument.String("goal").pipe(Argument.withDescription("What this Run is for")),
    propagate: propagateFlag,
    requestId: requestIdFlag,
  },
  ({ runId, goal, propagate: wants, requestId }) =>
    intentChange("run-intent-goal", runId, requestId, () => ({ kind: "set-goal", goal }), {
      propagate: wants,
    }),
).pipe(Command.withDescription("Set what a Run is for"));

const intentAdd = Command.make(
  "add-constraint",
  {
    runId: runIdArg,
    text: Argument.String("text").pipe(
      Argument.withDescription("The constraint, or `rule:<kind>:<args>` for one Collie checks"),
    ),
    severity: severityFlag,
    propagate: propagateFlag,
    requestId: requestIdFlag,
  },
  ({ runId, text, severity, propagate: wants, requestId }) =>
    intentChange(
      "run-intent-add",
      runId,
      requestId,
      () => {
        const level = severityOf(severity);
        if (level === null) return err("invalid_input", `--severity is block or warn.`);
        const constraint = parseConstraint(text, level);
        if ("error" in constraint) return err("invalid_input", constraint.error);
        return { kind: "add-constraint", constraint };
      },
      { propagate: wants },
    ),
).pipe(Command.withDescription("Add a constraint this Run's work is judged against"));

const intentRemove = Command.make(
  "remove-constraint",
  {
    runId: runIdArg,
    id: Argument.String("constraint-id").pipe(
      Argument.withDescription("The constraint's id, as `run intent show` lists it"),
    ),
    propagate: propagateFlag,
    requestId: requestIdFlag,
  },
  ({ runId, id, propagate: wants, requestId }) =>
    intentChange("run-intent-remove", runId, requestId, () => ({ kind: "remove-constraint", id }), {
      propagate: wants,
    }),
).pipe(Command.withDescription("Remove a constraint from a Run's Intent"));

const authorityArgs = Argument.String("pair").pipe(
  Argument.withDescription("k=v, repeatable; e.g. auto_correct=true"),
  Argument.variadic({ min: 1 }),
);

const intentAuthority = Command.make(
  "authority",
  { runId: runIdArg, pairs: authorityArgs, propagate: propagateFlag, requestId: requestIdFlag },
  ({ runId, pairs, propagate: wants, requestId }) =>
    intentChange(
      "run-intent-authority",
      runId,
      requestId,
      () => {
        const patch = authorityPatch(pairs);
        return "error" in patch ? err("invalid_input", patch.error) : { kind: "authority", patch };
      },
      { propagate: wants },
    ),
).pipe(Command.withDescription("Grant or withdraw what Collie may do to a Run without asking"));

/**
 * The one grant that is not a `k=v` word: a command Collie may run itself, bound argument
 * for argument. The wrapper is part of what was approved — `bun test` and `bun test
 * --bail` are two different permissions.
 */
const intentVerification = Command.make(
  "verification",
  {
    runId: runIdArg,
    name: Flag.String("name").pipe(
      Flag.withDescription("What to call it; the same name a `command_exit` rule refers to"),
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("`worktree`, or a path relative to the Run's cwd"),
      Flag.withDefault("worktree"),
    ),
    remove: Flag.Boolean("remove").pipe(
      Flag.withDescription("Withdraw the grant of this name instead of making one"),
      Flag.withDefault(false),
    ),
    command: Argument.String("command").pipe(
      Argument.withDescription("The executable and its arguments, after `--`"),
      Argument.variadic({ min: 0 }),
    ),
    propagate: propagateFlag,
    requestId: requestIdFlag,
  },
  ({ runId, name, cwd, remove, command, propagate: wants, requestId }) =>
    intentChange(
      "run-intent-verification",
      runId,
      requestId,
      (intent) => {
        const approved = intent.authority.run_verification.filter((spec) => spec.name !== name);
        if (remove) return { kind: "authority", patch: { run_verification: approved } };
        const [executable, ...argv] = command;
        if (executable === undefined)
          return err("invalid_input", "A verification grant needs a command, after `--`.");
        return {
          kind: "authority",
          patch: { run_verification: [...approved, { name, executable, argv, cwd }] },
        };
      },
      { propagate: wants },
    ),
).pipe(Command.withDescription("Let Collie run one exact command itself, as a verification"));

/** The Session's own defaults file, which is what every Run it starts begins with. */
const defaultsFile = Effect.fn("run.defaultsFile")(function* (env: PluginEnv) {
  return yield* defaultsPath(env.stateDir, scopeKey(scopeFor(env, env.cwd)));
});

function defaultsCommand(
  operation: string,
  requestId: Option.Option<string>,
  change: (defaults: Defaults) => Defaults | Failure,
) {
  return mutating(operation, requestId, (env) =>
    Effect.gen(function* () {
      const file = yield* defaultsFile(env);
      const current = (yield* readDefaults(file)) ?? EMPTY_DEFAULTS;
      const next = change(current);
      if ("ok" in next) return next;
      yield* writeDefaults(file, next);
      return { ok: true, data: { defaults: next }, human: describeDefaults(next) };
    }),
  );
}

const defaultsShow = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        const defaults = (yield* readDefaults(yield* defaultsFile(resolved.env))) ?? EMPTY_DEFAULTS;
        return { ok: true, data: { defaults }, human: describeDefaults(defaults) };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Show what every Run started here begins with"));

const defaultsAdd = Command.make(
  "add-constraint",
  {
    text: Argument.String("text").pipe(
      Argument.withDescription("The constraint, or `rule:<kind>:<args>` for one Collie checks"),
    ),
    severity: severityFlag,
    requestId: requestIdFlag,
  },
  ({ text, severity, requestId }) =>
    defaultsCommand("run-intent-defaults-add", requestId, (defaults) => {
      const level = severityOf(severity);
      if (level === null) return err("invalid_input", `--severity is block or warn.`);
      const parsed = parseConstraint(text, level);
      if ("error" in parsed) return err("invalid_input", parsed.error);
      // Filed as what it is: a default, not something a human typed for this Run.
      const constraint = { ...parsed, source: "workspace-default" as const, since: 1 };
      return {
        ...defaults,
        constraints: [...defaults.constraints.filter((c) => c.id !== constraint.id), constraint],
      };
    }),
).pipe(Command.withDescription("Add a constraint every Run started here begins with"));

const defaultsRemove = Command.make(
  "remove-constraint",
  {
    id: Argument.String("constraint-id").pipe(
      Argument.withDescription("The constraint's id, as `defaults show` lists it"),
    ),
    requestId: requestIdFlag,
  },
  ({ id, requestId }) =>
    defaultsCommand("run-intent-defaults-remove", requestId, (defaults) => ({
      ...defaults,
      constraints: defaults.constraints.filter((c) => c.id !== id),
    })),
).pipe(Command.withDescription("Remove a constraint from this workspace's defaults"));

const defaultsAuthority = Command.make(
  "set-authority",
  { pairs: authorityArgs, requestId: requestIdFlag },
  ({ pairs, requestId }) =>
    defaultsCommand("run-intent-defaults-authority", requestId, (defaults) => {
      const patch = authorityPatch(pairs);
      if ("error" in patch) return err("invalid_input", patch.error);
      return { ...defaults, authority: { ...defaults.authority, ...patch } };
    }),
).pipe(Command.withDescription("Set what every Run started here may do without asking"));

const intentDefaults = Command.make("defaults").pipe(
  Command.withDescription("What every Run started in this workspace begins with"),
  Command.withSubcommands([defaultsShow, defaultsAdd, defaultsRemove, defaultsAuthority]),
);

const runIntent = Command.make("intent").pipe(
  Command.withDescription("A Run's goal, its constraints and what Collie may do about them"),
  Command.withSubcommands([
    intentShow,
    intentSetGoal,
    intentAdd,
    intentRemove,
    intentAuthority,
    intentVerification,
    intentDefaults,
  ]),
);

export const run = Command.make("run").pipe(
  Command.withDescription("Start Runs and follow, answer, stop or resume them"),
  Command.withSubcommands([
    runStart,
    runList,
    runShow,
    runWait,
    runStop,
    runResume,
    runAnswer,
    runHold,
    runRelease,
    runSteer,
    runClearOverride,
    runDeliveries,
    runDisposition,
    runMetrics,
    runDrift,
    runCards,
    runActions,
    runAction,
    runIntent,
    runOutput,
  ]),
);
