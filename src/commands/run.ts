import { Cause, Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { RUNNER_LOG, readProgress } from "../driver";
import { Herdr } from "../herdr";
import {
  answerRun,
  err,
  prepareWorkflow,
  resumeRun,
  runStatus,
  startRun,
  stopRun,
  type Failure,
} from "../operations";
import { Run, RunStore } from "../run";
import { scopeFor } from "../registry";
import { YamlMapSchema } from "../yaml";
import { attempt, guarded, mutation, printResult, say, type Result } from "../envelope";
import {
  PrettyUnknownJson,
  UnknownJson,
  context,
  parseInput,
  readRun,
  root,
  runData,
  selected,
  unreadableRuns,
  type Global,
} from "./shared";

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
        const readable = yield* store.list();
        const runs = readable.filter((item) => !workspace || item.record.workspace === workspace);
        const data = yield* Effect.all(runs.map(runData));
        // A listing hides a Run it cannot read, and `run list` is the one place that
        // has to say so, or an agent never learns it exists. Reported alongside the
        // Runs rather than instead of them: one unreadable Run must not cost the
        // caller every readable one, and it cannot be workspace-filtered because its
        // workspace is precisely what could not be read.
        const broken = yield* unreadableRuns(store, readable);
        return {
          ok: true,
          data: { runs: data, broken },
          human:
            [
              ...data.map((item) => `${item.id}\t${item.status}\t${item.workflow}`),
              ...broken.map((item) => `${item.run}\tunreadable\t${item.reason}`),
            ].join("\n") || "No runs found.",
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
      // `guarded`, not `attempt`: this command streams its own lines rather than
      // returning one result, but a defect must still end as one envelope like
      // everywhere else.
      yield* guarded(waitFor(global, runId, follow, timeout), global.json);
    }),
).pipe(Command.withDescription("Wait for a Run to finish, optionally following its progress"));

export const waitFor = Effect.fn("collie.waitFor")(function* (
  global: Global,
  runId: string,
  follow: boolean,
  timeout: Option.Option<string>,
) {
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
  const sayEvent = <A>(event: A, human: string) =>
    say(global.json ? Schema.encodeSync(UnknownJson)(event) : human);

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
        yield* sayEvent({ type: "snapshot", run: snapshot }, `${fresh.id}: ${status}`);
      }
      const progress = (yield* readProgress(fresh.dir)).slice(progressCount);
      progressCount += progress.length;
      for (const event of progress)
        yield* sayEvent({ type: "progress", runId, ...event }, event.text);
      if (terminal) yield* sayEvent({ type: "terminal", run: snapshot }, `${fresh.id}: ${status}`);
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
      printResult(
        Cause.isTimeoutError(cause)
          ? err("timeout", `Timed out waiting for run "${runId}".`)
          : err("operation_failed", `Could not watch run "${runId}".`, { cause: String(cause) }),
        global.json,
      ).pipe(Effect.as(true)),
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
});

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
            return yield* resumeRun(resolved.env, found, id);
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
    runLogs,
    runOutput,
  ]),
);
