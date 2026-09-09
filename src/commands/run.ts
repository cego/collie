import {
  Cause,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { attentionFor, type Attention } from "../attention";
import { RUNNER_LOG, readProgress } from "../driver";
import { Herdr } from "../herdr";
import {
  answerRun,
  err,
  prepareWorkflow,
  resumeRun,
  settleGiven,
  runStatus,
  runSettled,
  startRun,
  stopRun,
  type Failure,
} from "../operations";
import { fanoutRepos, RunStore } from "../run";
import type { Run } from "../run";
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
  context,
  parseInput,
  readRun,
  requestIdFlag,
  runIdArg,
  root,
  runData,
  selected,
  unreadableRuns,
  type Global,
} from "./shared";

const runStart = Command.make(
  "start",
  {
    workflow: Argument.string("workflow").pipe(
      Argument.withDescription("Which Workflow to run, as `workflow list` names it"),
    ),
    input: Flag.string("input").pipe(
      Flag.withDescription(
        "key=value, repeatable; the names a Workflow takes are what `workflow show` lists",
      ),
      Flag.atLeast(0),
    ),
    inputsJson: Flag.string("inputs-json").pipe(
      Flag.withDescription("Every Input at once, as one JSON object"),
      Flag.optional,
    ),
    decide: Flag.string("decide").pipe(
      Flag.withDescription(
        "step=title, repeatable; answers a Choice step now instead of stopping there",
      ),
      Flag.atLeast(0),
    ),
    requestId: requestIdFlag,
  },
  ({ workflow, input, inputsJson, decide, requestId: request }) =>
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
              const settled = yield* settleGiven(resolved.env, prepared, {
                inputs: explicit.inputs,
                decide,
              });
              if (!settled.ok) return settled;
              const started = yield* startRun(resolved.env, {
                workflow: prepared.workflow,
                resolutions: prepared.resolutions,
                decisions: settled.decisions,
                workspace: resolved.workspace,
                // Not one of the Workflow's own Inputs: it names the checkout the Run
                // works in, and the Workflow never sees it. (`workspace` is a declared
                // Input, so it travels with the rest of them.)
                branch: explicit.inputs.branch,
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
  const found = yield* readRun(resolved.env, runId, yield* selected(global));
  // The environment travels with the Run: `show` reads the Run's children out of the
  // same state directory, and resolving the context twice is two answers to one question.
  return found._tag === "RunFailure" ? found : { ...found, env: resolved.env };
});

/**
 * A parent's Runs, one line each: an agent driving Collie follows a fan-out from here,
 * and a plan that spans repositories is several Runs whose relation is otherwise only
 * in the `--json` payload. The repository comes from the parent's own record; a child
 * chained for anything else has none to name.
 */
const childLines = Effect.fn("run.childLines")(function* (stateDir: string, run: Run) {
  const store = new RunStore(stateDir);
  const repoOf = new Map<string, string>();
  for (const entry of run.record.fanout ? fanoutRepos(run.record.fanout) : []) {
    if (entry.run !== null) repoOf.set(entry.run, entry.repo);
  }
  const lines: string[] = [];
  for (const id of run.record.children) {
    const child = yield* store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
    const status = child === null ? "gone" : yield* runStatus(child);
    lines.push(`  ${id}\t${repoOf.get(id) ?? ""}\t${status}`);
  }
  return lines;
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
          const run = resolved.run;
          // The snapshot carries the status, so it is not worked out a second time here.
          const snapshot = yield* runData(run);
          const head = `${run.id}\t${snapshot.status}\t${run.record.workflow}`;
          // The same facts the attention wait returns, from the same place: a Run that
          // stopped explains itself identically whichever command asked. Reading it
          // changes nothing — no recovery happens here, only the account of it.
          const attention = yield* attentionFor(run, new Herdr(resolved.env));
          return {
            ok: true,
            data: { run: snapshot, attention },
            human: [
              head,
              attention.explanation,
              ...(yield* childLines(resolved.env.stateDir, run)),
            ].join("\n"),
          };
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Show one Run: its state, its Inputs, its Steps and any pending Choice"),
);

const runLogs = Command.make(
  "logs",
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
          const file = path.join(resolved.run.dir, RUNNER_LOG);
          const logs = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
          return { ok: true, data: { runId, logs }, human: logs };
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Print what the Run's Driver recorded"));

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
    follow: Flag.boolean("follow").pipe(
      Flag.withDescription("Print each Step's progress while waiting, instead of only the result"),
      Flag.withDefault(false),
    ),
    timeout: Flag.string("timeout").pipe(
      Flag.withDescription("Give up after this long, e.g. `30 seconds`, `10 minutes`"),
      Flag.optional,
    ),
    until: Flag.string("until").pipe(
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

export const waitFor = Effect.fn("collie.waitFor")(function* (
  global: Global,
  runId: string,
  follow: boolean,
  timeout: Option.Option<string>,
  until: Option.Option<string> = Option.none(),
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
  const herdr = new Herdr(resolved.env);
  const untilResult = parseUntil(until);
  if (!untilResult.ok) return yield* printResult(untilResult.error, global.json);
  const wantsAttention = untilResult.until === "attention";

  const progressCount = yield* Ref.make(0);
  const sentSnapshot = yield* Ref.make(false);
  /** Why the Run stopped being readable, if it did. Waiting ends; success does not. */
  const lost = yield* Ref.make<Failure | null>(null);
  /**
   * The observation that ended an attention wait. Kept rather than looked up again:
   * between waking and replying, a Choice can be answered or replaced by someone else,
   * and a fresh read would report `none` or a different question — an answer to a
   * question the caller was never woken for.
   */
  const observed = yield* Ref.make<{
    run: Effect.Success<ReturnType<typeof runData>>;
    attention: Attention;
  } | null>(null);
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
    const terminal = runSettled(status);
    const attention = wantsAttention ? yield* attentionFor(current, herdr) : null;
    const done = attention ? attention.category !== "none" : terminal;
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
      // Attention that is not the Run ending gets its own event: a caller streaming a
      // Run has to tell "come and answer this" from "it is over".
      else if (done && attention)
        yield* sayEvent({ type: "attention", run: snapshot, attention }, attention.explanation);
    }
    if (done && attention) yield* Ref.set(observed, { run: snapshot, attention });
    return done;
  });

  const fs = yield* FileSystem.FileSystem;
  // One `emit` at a time. The health check below runs beside the watch, and both read
  // the same progress cursor: interleaved, one event would be printed twice.
  const gate = yield* Semaphore.make(1);
  const once = () => gate.withPermits(1)(emit());
  /**
   * The watch is subscribed before the first read, not after it. Reading first
   * left a gap: a Run reaching a terminal state in it wrote the only event that
   * would ever arrive, and the command then waited for another one forever.
   */
  const watched = Effect.gen(function* () {
    const events = yield* Stream.toQueue(fs.watch(watchedRun.dir), { capacity: "unbounded" });
    if (yield* once()) return;
    const changes = Stream.fromQueue(events);
    // Under an attention wait every event costs an ownership probe, which on a system
    // with no /proc means spawning `ps`. A Run writing its log line by line would pay
    // that per line, so bursts are capped: an event only ever means "look again", and
    // anything a window drops the health check below picks up within its own interval.
    const fromEvents = (
      wantsAttention ? changes.pipe(Stream.throttle(EVENT_WINDOW)) : changes
    ).pipe(Stream.runForEachWhile(() => once().pipe(Effect.map((done) => !done))));
    if (!wantsAttention) return yield* fromEvents;
    // A Driver that is killed writes nothing on its way out, so the watch alone would
    // wait for ever on a Run nobody is driving. This is that gap and nothing else: a
    // bounded re-read of the Run's own state, only while an attention wait is open,
    // ending with it. No daemon, and nothing looks at a terminal.
    yield* Effect.race(fromEvents, healthCheck(once));
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
  const seen = yield* Ref.get(observed);
  if (seen)
    return yield* printResult(
      { ok: true, data: seen, human: seen.attention.explanation },
      global.json,
    );
  const terminal = yield* readRun(resolved.env, runId, workspace);
  if (terminal._tag === "RunFailure") return yield* printResult(terminal.result, global.json);
  // The snapshot carries the status, so it is not worked out a second time here.
  const snapshot = yield* runData(terminal.run);
  if (!wantsAttention)
    return yield* printResult(
      { ok: true, data: { run: snapshot }, human: `${terminal.run.id}: ${snapshot.status}` },
      global.json,
    );
  const attention = yield* attentionFor(terminal.run, herdr);
  yield* printResult(
    { ok: true, data: { run: snapshot, attention }, human: attention.explanation },
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
    runId: runIdArg,
    answer: Argument.string("answer").pipe(
      Argument.withDescription("The Choice to take, as `run show` titles it"),
    ),
    expectChoice: Flag.string("expect-choice").pipe(
      Flag.withDescription(
        "Only answer while this is still the pending Choice, as `run wait --until attention` returns its id",
      ),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, answer, expectChoice, requestId }) =>
    runMutationCommand("run-answer", runId, requestId, (_env, run, id) =>
      answerRun(run, answer, id, Option.getOrNull(expectChoice)),
    ),
).pipe(Command.withDescription("Answer the Choice a waiting Run is asking"));

const mutationFlags = {
  runId: runIdArg,
  requestId: requestIdFlag,
};

const runStop = Command.make("stop", mutationFlags, ({ runId, requestId }) =>
  runMutationCommand("run-stop", runId, requestId, (env, run, id) =>
    stopRun(env.stateDir, new Herdr(env), run, id),
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
