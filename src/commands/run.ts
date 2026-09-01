import { Cause, Duration, Effect, FileSystem, Option, Path, Ref, Schema, Stream } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { RUNNER_LOG, readProgress } from "../driver";
import { Herdr } from "../herdr";
import { classifyWorkSource, settle, targetKind } from "../inputs";
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
import { RunStore } from "../run";
import type { Run } from "../run";
import type { PluginEnv } from "../env";
import { scopeFor } from "../registry";
import { YamlMapSchema } from "../yaml";
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
    input: Flag.string("input").pipe(Flag.atLeast(0)),
    inputsJson: Flag.string("inputs-json").pipe(Flag.optional),
    requestId: Flag.string("request-id").pipe(Flag.optional),
  },
  ({ workflow, input, inputsJson, requestId: request }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const base = yield* context(global, false);
          if (base._tag === "ContextFailure") return base.result;
          const explicit = yield* parseInput(input, inputsJson);
          if (!explicit.ok) return explicit.error;
          return yield* mutation(base.env, "run-start", request, (_id) =>
            Effect.gen(function* () {
              // The live workspace is resolved inside the mutation, so replaying a
              // receipt returns what was recorded rather than needing that workspace
              // to still be open. Only a start that is actually happening needs it.
              const resolved = yield* context(global, (yield* selected(global)) !== null);
              if (resolved._tag === "ContextFailure") return resolved.result;
              const prepared = yield* prepareWorkflow(resolved.env, workflow);
              if (!prepared.ok) return prepared;
              const wf = prepared.workflow;
              for (const item of prepared.resolutions) {
                const value = explicit.inputs[item.name];
                if (value === undefined) continue;
                // A given value owes the prompts its kind, exactly as the picker and a
                // chained Run record it: the workflow body branches on `<name>_kind`,
                // and an inferred kind left over from a candidate would describe the
                // value that was not chosen.
                const kind =
                  item.strategy === "work-source"
                    ? (yield* classifyWorkSource(value)).kind
                    : item.strategy === "diff-target"
                      ? targetKind(value)
                      : undefined;
                settle(item, { value, source: "explicit", kind });
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
              const started = yield* startRun(resolved.env, {
                workflow: wf,
                resolutions: prepared.resolutions,
                workspace: resolved.workspace,
              });
              if (started._tag === "Rejected") return started.result;
              return {
                ok: true,
                data: { runId: started.run.id, run: yield* runData(started.run) },
                human: `Started run ${started.run.id}.`,
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
        if (resolved._tag === "ContextFailure") return resolved.result;
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

const resolveCommandRun = Effect.fn("collie.resolveCommandRun")(function* (
  global: Global,
  runId: string,
) {
  const resolved = yield* context(global, false);
  if (resolved._tag === "ContextFailure")
    return { _tag: "RunFailure" as const, result: resolved.result };
  return yield* readRun(resolved.env, runId, yield* selected(global));
});

const runShow = Command.make("show", { runId: Argument.string("run-id") }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        return {
          ok: true,
          data: { run: yield* runData(resolved.run) },
          human: `${resolved.run.id}\t${yield* runStatus(resolved.run)}\t${resolved.run.record.workflow}`,
        };
      }),
      global.json,
    );
  }),
).pipe(
  Command.withDescription("Show one Run: its state, its Inputs, its Steps and any pending Choice"),
);

const runLogs = Command.make("logs", { runId: Argument.string("run-id") }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(resolved.run.dir, RUNNER_LOG);
        const logs = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
        return { ok: true, data: { runId, logs }, human: logs };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Print what the Run's Driver recorded"));

const runOutput = Command.make("output", { runId: Argument.string("run-id") }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outputs: Array<{ path: string; value?: unknown; error?: string }> = [];
        const inside = `${path.resolve(resolved.run.dir)}/`;
        for (const variant of resolved.run.record.steps.flatMap((step) => step.variants)) {
          const relative = variant.output;
          if (!relative) continue;
          const file = path.resolve(resolved.run.dir, relative);
          if (!file.startsWith(inside))
            return err("invalid_state", `Run "${runId}" has an unsafe Output path.`);
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
              .join("\n\n") || "This Run has no Outputs.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Print every Output the Run's Steps have written"));

type ParsedTimeout = { ok: true; ms: number | null } | { ok: false; error: Result };

/** A duration in Effect's canonical `DurationFromString` grammar. */
function parseTimeout(value: Option.Option<string>): ParsedTimeout {
  if (Option.isNone(value)) return { ok: true, ms: null };
  const duration = Schema.decodeUnknownOption(Schema.DurationFromString)(value.value);
  return Option.isSome(duration)
    ? { ok: true, ms: Duration.toMillis(duration.value) }
    : { ok: false, error: err("invalid_input", `Invalid timeout "${value.value}".`) };
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
  if (resolved._tag === "ContextFailure") return yield* printResult(resolved.result, global.json);
  const workspace = yield* selected(global);
  const found = yield* readRun(resolved.env, runId, workspace);
  if (found._tag === "RunFailure") return yield* printResult(found.result, global.json);
  const watchedRun = found.run;
  const timeoutResult = parseTimeout(timeout);
  if (!timeoutResult.ok) return yield* printResult(timeoutResult.error, global.json);
  const { ms } = timeoutResult;

  const progressCount = yield* Ref.make(0);
  const sentSnapshot = yield* Ref.make(false);
  /** Why the Run stopped being readable, if it did. Waiting ends; success does not. */
  const lost = yield* Ref.make<Failure | null>(null);
  /** One event, as the typed line a program reads or the line a human reads. */
  const sayEvent = <A>(event: A, human: string) =>
    say(global.json ? Schema.encodeSync(UnknownJson)(event) : human);

  /** Reports what has happened since the last call, and whether waiting is over. */
  const emit = Effect.fn("collie.runWait.emit")(function* () {
    const fresh = yield* readRun(resolved.env, runId, workspace);
    if (fresh._tag === "RunFailure") {
      // Deleted or no longer decoding, mid-wait. That is the typed failure the
      // caller is owed, not a terminal state to be reported as a success.
      yield* Ref.set(lost, fresh.result);
      return true;
    }
    const current = fresh.run;
    const snapshot = yield* runData(current);
    const status = yield* runStatus(current);
    const terminal = ["succeeded", "failed", "stopped"].includes(status);
    if (follow) {
      // Once, not once per event: a Run with no progress yet leaves progressCount
      // at zero however many times its directory is touched.
      if (!(yield* Ref.getAndSet(sentSnapshot, true)))
        yield* sayEvent({ type: "snapshot", run: snapshot }, `${current.id}: ${status}`);
      const seen = yield* Ref.get(progressCount);
      const progress = (yield* readProgress(current.dir)).slice(seen);
      yield* Ref.update(progressCount, (count) => count + progress.length);
      for (const event of progress)
        yield* sayEvent({ type: "progress", runId, ...event }, event.text);
      if (terminal)
        yield* sayEvent({ type: "terminal", run: snapshot }, `${current.id}: ${status}`);
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
    const events = yield* Stream.toQueue(fs.watch(watchedRun.dir), { capacity: "unbounded" });
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
  const lostRun = yield* Ref.get(lost);
  if (lostRun) return yield* printResult(lostRun, global.json);
  if (follow || failed) return;
  const terminal = yield* readRun(resolved.env, runId, workspace);
  if (terminal._tag === "RunFailure") return yield* printResult(terminal.result, global.json);
  yield* printResult(
    {
      ok: true,
      data: { run: yield* runData(terminal.run) },
      human: `${terminal.run.id}: ${yield* runStatus(terminal.run)}`,
    },
    global.json,
  );
});

function runMutationCommand(
  operation: string,
  runId: string,
  requestId: Option.Option<string>,
  apply: (env: PluginEnv, run: Run, id: string) => Effect.Effect<Result, CollieError, BunServices>,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        const workspace = yield* selected(global);
        return yield* mutation(resolved.env, operation, requestId, (id) =>
          Effect.gen(function* () {
            const found = yield* readRun(resolved.env, runId, workspace);
            if (found._tag === "RunFailure") return found.result;
            return yield* apply(resolved.env, found.run, id);
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
  ({ runId, answer, requestId }) =>
    runMutationCommand("run-answer", runId, requestId, (_env, run, id) =>
      answerRun(run, answer, id),
    ),
).pipe(Command.withDescription("Answer the Choice a waiting Run is asking"));

const mutationFlags = {
  runId: Argument.string("run-id"),
  requestId: Flag.string("request-id").pipe(Flag.optional),
};

const runStop = Command.make("stop", mutationFlags, ({ runId, requestId }) =>
  runMutationCommand("run-stop", runId, requestId, (env, run, id) =>
    stopRun(env.stateDir, new Herdr(env), run, scopeFor(env, run.record.cwd), id),
  ),
).pipe(Command.withDescription("Stop a Run and close only the panes it owns"));

const runResume = Command.make("resume", mutationFlags, ({ runId, requestId }) =>
  runMutationCommand("run-resume", runId, requestId, (env, run, id) => resumeRun(env, run, id)),
).pipe(Command.withDescription("Start a fresh Driver for a Run, skipping finished Steps"));
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
