import {
  Cause,
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
import { attentionFor, type Attention } from "../attention";
import { RUNNER_LOG, readProgress } from "../driver";
import { Herdr } from "../herdr";
import {
  answerRun,
  clearOverride,
  err,
  followUp,
  holdRun,
  releaseRun,
  prepareWorkflow,
  resumeRun,
  settleGiven,
  runStatus,
  runSettled,
  startRun,
  stopRun,
  writeInbox,
  type Failure,
} from "../operations";
import { fanoutRepos, withRunLock, RunStore } from "../run";
import {
  EMPTY_DEFAULTS,
  amend,
  defaultsPath,
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
import { runDeliveries } from "./steer";
import { currentReports, readDrift } from "../drift";
import { newest, readCards } from "../cards";
import { nowIso } from "../time";
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
  actorName,
  actorNow,
  context,
  mutating,
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
    goal: Flag.string("goal").pipe(
      Flag.withDescription("What this Run is for, in the human's own words"),
      Flag.optional,
    ),
    constraint: Flag.string("constraint").pipe(
      Flag.withDescription(
        "What the work must respect, repeatable; `rule:<kind>:<args>` for one Collie checks",
      ),
      Flag.atLeast(0),
    ),
    severity: Flag.string("severity").pipe(
      Flag.withDescription(
        "block or warn for the --constraint in the same position; warn where none is given",
      ),
      Flag.atLeast(0),
    ),
    requestId: requestIdFlag,
  },
  ({ workflow, input, inputsJson, decide, goal, constraint, severity, requestId: request }) =>
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
                intent: { goal: Option.getOrNull(goal), constraints: named.constraints },
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

const reasonFlag = Flag.string("reason").pipe(
  Flag.withDescription("Why, in your own words; it is shown wherever the hold is"),
  Flag.withDefault("no reason given"),
);

const runHold = Command.make(
  "hold",
  { runId: runIdArg, reason: reasonFlag, requestId: requestIdFlag },
  ({ runId, reason, requestId }) =>
    runMutationCommand("run-hold", runId, requestId, (_env, run, id) => holdRun(run, reason, id)),
).pipe(
  Command.withDescription("Stop a Run taking on new work; what is already running carries on"),
);

const runRelease = Command.make(
  "release",
  { runId: runIdArg, reason: reasonFlag, requestId: requestIdFlag },
  ({ runId, reason, requestId }) =>
    runMutationCommand("run-release", runId, requestId, (_env, run, id) =>
      releaseRun(run, reason, id),
    ),
).pipe(Command.withDescription("Let a held Run carry on"));

const runClearOverride = Command.make(
  "clear-override",
  {
    runId: runIdArg,
    agent: Argument.string("agent").pipe(
      Argument.withDescription("The agent, as `run show` names it"),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, agent, requestId }) =>
    runMutationCommand("run-clear-override", runId, requestId, (env, run, id) =>
      clearOverride(env.stateDir, new Herdr(env), run, agent, actorName(actorNow(id))),
    ),
).pipe(
  Command.withDescription("Let Collie correct an agent again after someone typed into its pane"),
);

const runDrift = Command.make("drift", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const lines = yield* readDrift(resolved.run.dir);
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
        const cards = newest(yield* readCards(resolved.run.dir));
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

const runFollowUp = Command.make(
  "follow-up",
  {
    runId: runIdArg,
    text: Argument.string("text").pipe(
      Argument.withDescription("What still needs doing, in your own words"),
    ),
    allowDirty: Flag.boolean("allow-dirty").pipe(
      Flag.withDescription("Build on the uncommitted changes already in that checkout"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, text, allowDirty, requestId }) =>
    runMutationCommand("run-follow-up", runId, requestId, (env, run, id) =>
      followUp(env, run, text, id, { allowDirty }),
    ),
).pipe(
  Command.withDescription("Start a child Run on a finished one's outcome, on the same branch"),
);

const runResume = Command.make("resume", mutationFlags, ({ runId, requestId }) =>
  runMutationCommand("run-resume", runId, requestId, (env, run, id) => resumeRun(env, run, id)),
).pipe(Command.withDescription("Start a fresh Driver for a Run, skipping finished Steps"));
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
  return runMutationCommand(operation, runId, requestId, (env, target, id) =>
    Effect.gen(function* () {
      // Read, decide and write as one act. Two amendments that both read v1 would
      // otherwise both report v2 and the later rename would erase the earlier one.
      const amended = yield* withRunLock<
        Failure | Intent,
        Error | PlatformError.PlatformError,
        FileSystem.FileSystem | Path.Path | BunServices
      >(
        target.dir,
        Effect.gen(function* () {
          const intent = yield* readIntent(target.dir).pipe(
            Effect.mapError((cause) => new Error(String(cause))),
          );
          if (intent === null)
            return err("invalid_state", `Run "${runId}" has no Intent to amend.`);
          const wanted = change(intent);
          if ("ok" in wanted) return wanted;
          const next = amend(intent, wanted, actorName(actorNow(id)), yield* nowIso());
          if (next !== intent) yield* writeIntentHeld(target.dir, next);
          return next;
        }),
      );
      if ("ok" in amended) return amended;
      // The command a confirmed `update_intent` writes. Without it a live Driver keeps
      // checking against the version it loaded (SPEC §9.4).
      yield* writeInbox(target.dir, {
        type: "intent_changed",
        requestId: id,
        version: amended.version,
      }).pipe(Effect.ignore);
      const propagated = options.propagate ? yield* propagateToChildren(env, target, amended) : [];
      return {
        ok: true,
        data: { runId, version: amended.version, propagated },
        human: [`${runId}: intent v${amended.version}`, ...propagated].join("\n"),
      };
    }),
  );
}

/**
 * The parent's amended Intent applied to every child that is still going. The child's own
 * entries are kept and conflicts are reported, never resolved — `propagate` decides that,
 * and this only writes what it decided.
 *
 * The child's file is written but its Driver is not told: it picks the new version up at
 * its next boundary.
 */
const propagateToChildren = Effect.fn("run.propagateToChildren")(function* (
  env: PluginEnv,
  parent: Run,
  intent: Intent,
) {
  const store = new RunStore(env.stateDir);
  const lines: string[] = [];
  for (const id of parent.record.children) {
    const child = yield* store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
    if (child === null) continue;
    if (child.record.status !== "running" && child.record.status !== "blocked") continue;
    const current = yield* readIntent(child.dir).pipe(Effect.catch(() => Effect.succeed(null)));
    if (current === null) continue;
    const { intent: next, conflicts } = propagate(intent, current);
    yield* writeIntent(child.dir, next);
    yield* child.log(`intent propagated from ${parent.id} v${intent.version}`);
    lines.push(`  ${id}: propagated${conflicts.length ? ` (${conflicts.join("; ")})` : ""}`);
  }
  return lines;
});

const severityFlag = Flag.string("severity").pipe(
  Flag.withDescription("block or warn; warn is the default"),
  Flag.withDefault("warn"),
);

const propagateFlag = Flag.boolean("propagate").pipe(
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
        const intent = yield* readIntent(resolved.run.dir);
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
    goal: Argument.string("goal").pipe(Argument.withDescription("What this Run is for")),
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
    text: Argument.string("text").pipe(
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
    id: Argument.string("constraint-id").pipe(
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

const authorityArgs = Argument.string("pair").pipe(
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
    name: Flag.string("name").pipe(
      Flag.withDescription("What to call it; the same name a `command_exit` rule refers to"),
    ),
    cwd: Flag.string("cwd").pipe(
      Flag.withDescription("`worktree`, or a path relative to the Run's cwd"),
      Flag.withDefault("worktree"),
    ),
    remove: Flag.boolean("remove").pipe(
      Flag.withDescription("Withdraw the grant of this name instead of making one"),
      Flag.withDefault(false),
    ),
    command: Argument.string("command").pipe(
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

function describeDefaults(defaults: Defaults): string {
  return [
    ...defaults.constraints.map((c) => `${c.id}\t${c.severity}\t${c.kind}\t${c.text}`),
    ...Object.entries(defaults.authority).map(([k, v]) => `authority ${k}=${JSON.stringify(v)}`),
  ].join("\n");
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
    text: Argument.string("text").pipe(
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
    id: Argument.string("constraint-id").pipe(
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
    runClearOverride,
    runDeliveries,
    runDrift,
    runCards,
    runFollowUp,
    runIntent,
    runLogs,
    runOutput,
  ]),
);
