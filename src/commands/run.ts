import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Option,
  Path,
  Ref,
  Schema,
  Stdio,
  Stream,
  flow as Schemaflow,
  Result as SchemaResult,
} from "effect";
import { CommandLine } from "effect/process";
import { redactedField, withNotice } from "../redact";
import type { PlatformServices } from "../platform";
import { Argument, Command, Flag } from "effect/cli";
import { err, type Failure } from "../operations";
import { GIVEN, INFERRED } from "../engine";
import { textOf } from "../runs";
import {
  asksRun,
  followCheckLog,
  describeWaiting,
  answerRun,
  anyRuns,
  controlRun,
  withdrawNoteRun,
  disposeRun,
  seeRun,
  invokeOffer,
  showOffers,
  steerRun,
  moduleFor,
  runViews,
  flockRuns,
  isSettled,
  resumeRun,
  startRun,
  statusOf,
  watchRun,
  runShown,
  runProgress,
  reportFor,
} from "../lifecycle";
import { unsafePathComponent } from "../naming";
import type { RunView } from "../engine";
import {
  EMPTY_DEFAULTS,
  defaultsPath,
  describeDefaults,
  authorityPatch,
  outcomeChange,
  parseConstraint,
  readDefaults,
  verificationGrant,
  writeDefaults,
  type Change,
  type Constraint,
  type Defaults,
  type Intent,
} from "../intent";
import { scopeFor, scopeKey } from "../registry";
import { readTask, taskOfWorkspace, type TaskChoice } from "../task";
import { runDeliveries } from "./steer";
import { givenVerifications } from "../verify-spec";
import { agentStartRefusal, CLI_CHECKOUT_FIX, hostOptions, insideCheckout } from "../agent-start";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "../projects";
import { currentReports } from "../drift";
import { newest } from "../cards";
import { metricsOf } from "../metrics";
import { requestedByLine, ranOn, type RunAgent, type RunProgress } from "../board-model";
import {
  followEvents,
  followLine,
  readyLines,
  reached,
  UNTILS,
  type Followed,
  type Until,
} from "../following";
import { reportLines } from "../report";
import { latest, statusLine } from "../disposition";
import { replyLine } from "../replies";
import { epochMs } from "../time";
import type { PluginEnv } from "../env";
import {
  attempt,
  guarded,
  mutation,
  ResultBoundary,
  printResult,
  say,
  type CollieError,
  type Result,
} from "../envelope";
import {
  PrettyUnknownJson,
  UnknownJson,
  cliDoor,
  context,
  mutating,
  parseInput,
  locateRun,
  outOfReach,
  runFacts,
  runScope,
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
 * continuation that was never asked for is how two pieces of work become one. The host
 * still gives a fresh start the open Task already working its branch.
 *
 * The programmatic front door never waits for a prompt. Outside a Task's workspace,
 * `--continue-task` is missing input and says which flag would supply it.
 */
const chosenTask = Effect.fn("collie.chosenTask")(function* (
  env: PluginEnv,
  named: Option.Option<string>,
  current: boolean,
  here: boolean,
) {
  const refuse = (error: Result) => ({ ok: false as const, error });
  const taken = (choice: TaskChoice) => ({ ok: true as const, choice });
  if (here && (Option.isSome(named) || current))
    return refuse(
      err(
        "invalid_input",
        "--here keeps the Run in this workspace; it takes no --task or --continue-task.",
      ),
    );
  if (here) return taken({ mode: "here" });
  if (Option.isSome(named)) {
    const task = yield* readTask(env.stateDir, named.value);
    if (!task)
      return refuse(
        err("task_not_found", `Task "${named.value}" was not found.`, { task: named.value }),
      );
    return taken({ mode: "continue", task });
  }
  if (!current) return taken({ mode: "new" });
  const kept = yield* taskOfWorkspace(env.stateDir, env.workspaceId);
  if (!kept)
    return refuse(
      err(
        "needs_input",
        "This workspace is not a task workspace; name the Task with --task, as `task list` prints it, or keep the Run here with --here.",
      ),
    );
  return taken({ mode: "continue", task: kept });
});

/**
 * `--decide` answers a question before it is asked, which a module never does: its
 * questions are asked when the work reaches them. Refused rather than dropped, since a
 * decision nobody answered is worse than being told so here.
 */
function unsupportedDecide(decide: ReadonlyArray<string>): Failure | null {
  if (decide.length === 0) return null;
  return err(
    "invalid_input",
    "A workflow saved as a module asks its questions when its work reaches them; --decide is not one of its inputs.",
  );
}

const attachFlag = Flag.String("attach").pipe(
  Flag.withDescription("A file to give the Run, repeatable; the host copies it into the Run"),
  Flag.atLeast(0),
);

/** Each `--attach` as an absolute path, resolved against where the command runs. */
const absolute = (files: ReadonlyArray<string>) =>
  Effect.map(Path.Path, (path) =>
    files.length === 0 ? undefined : Arr.map(files, (file) => path.resolve(file)),
  );

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
    title: Flag.String("title").pipe(
      Flag.withDescription("What a new Task is called; inferred from the work otherwise"),
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
    here: Flag.Boolean("here").pipe(
      Flag.withDescription(
        "Keep the Run in this herdr workspace instead of opening one for its worktree",
      ),
      Flag.withDefault(false),
    ),
    verify: Flag.String("verify").pipe(
      Flag.withDescription(
        'A check Collie may run to prove this Run, repeatable: one verify.json entry, {"name","executable","argv","cwd"}',
      ),
      Flag.atLeast(0),
    ),
    harness: Flag.String("harness").pipe(
      Flag.withDescription("The harness this Run's agents run on, over the workflow's own"),
      Flag.optional,
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription("The model this Run's agents run on, over the workflow's own"),
      Flag.optional,
    ),
    effort: Flag.String("effort").pipe(
      Flag.withDescription("The effort this Run's agents are asked for, over the workflow's own"),
      Flag.optional,
    ),
    attach: attachFlag,
    requestId: requestIdFlag,
  },
  ({
    workflow,
    input,
    inputsJson,
    decide,
    goal,
    title,
    constraint,
    severity,
    task: taskId,
    continueTask,
    here,
    verify,
    harness,
    model,
    effort,
    attach,
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
          const given = givenVerifications(verify);
          if (!given.ok) return err("invalid_input", given.error);
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
              const task = yield* chosenTask(resolved.env, taskId, continueTask, here);
              if (!task.ok) return task.error;
              // What an id runs is the module saved for this project.
              // A Machine named with --machine has its own modules, and says what it lacks.
              const saved =
                resolved.env.machine === undefined
                  ? yield* moduleFor(resolved.env, workflow)
                  : { id: workflow };
              if (saved !== null) {
                const unsupported = unsupportedDecide(decide);
                if (unsupported !== null) return unsupported;
                // The host's own options are settled apart from the author's payload, so
                // nothing the host supplies is ever injected into a module's input.
                const launch = hostOptions(explicit.given);
                const agent = Arr.flatMap(
                  Rec.toEntries({ harness, model, effort }),
                  ([name, value]) => (Option.isSome(value) ? [[name, value.value] as const] : []),
                );
                // What it declares and nobody gave, with what would fill each, so a caller
                // can fill the gaps and retry under the same request id.
                if ("inputs" in saved) {
                  const needed = yield* agentStartRefusal(resolved.env, saved, launch.input, {
                    named: yield* namedCheckout(resolved.env, launch.options.workspace ?? ""),
                    fix: CLI_CHECKOUT_FIX,
                  });
                  if (needed !== null) return needed;
                }
                const started = yield* startRun(resolved.env, {
                  door: yield* cliDoor(resolved.env),
                  id: workflow,
                  request: requestId,
                  input: launch.input,
                  options: { ...launch.options, ...Rec.fromEntries(agent) },
                  task: task.choice,
                  intent: Option.isSome(goal)
                    ? { goal: goal.value, constraints: named.constraints }
                    : { constraints: named.constraints },
                  title: Option.getOrUndefined(title),
                  verify: given.specs.length > 0 ? given.specs : undefined,
                  attachments: yield* absolute(attach),
                });
                if (!started.ok) return started;
                return {
                  ok: true,
                  data: {
                    runId: started.runId,
                    workflow,
                    registration: started.registration,
                    fresh: started.fresh,
                    ...redactedField(started.redacted),
                  },
                  human: withNotice(`Started run ${started.runId}.`, started.redacted),
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
        "collie run start review --input target=https://gitlab.example.com/acme/app/-/merge_requests/2 --input plan= --input proves=",
      description:
        "Review a merge request, by URL or by bare iid, giving the optional Inputs as empty",
    },
    {
      command: "collie run start implement --input plan=ENG-123",
      description: "Build from a Linear issue, a plan directory, or a description",
    },
    {
      command: 'collie run start plan --input goal="one registry" --input then=implement',
      description: "Plan and build it with nobody asked anything; then= to be asked what next",
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
        // Scoped to the Task whose workspace this is, where it is one: Runs belong to
        // Tasks now, and a workspace that is not a Task's narrows nothing.
        const task = yield* selectedTask(global);
        const hosted = yield* flockRuns(resolved.env, task);
        return {
          ok: true,
          data: { runs: hosted.runs, unreadable: hosted.unreadable, machines: hosted.machines },
          human:
            Arr.join(
              [
                ...Arr.map(
                  hosted.runs,
                  (view) => `${view.runId}\t${view.machine}\t${statusOf(view)}\t${view.workflow}`,
                ),
                ...(hosted.unreadable === null ? [] : [`runs: ${hosted.unreadable}`]),
              ],
              "\n",
            ) || "No runs found.",
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("List Runs in the selected workspace, or everywhere without one"));

/** `run show`'s line for each agent: `  review  claude/opus xhigh`. */
export const agentLines = (agents: ReadonlyArray<RunAgent>) =>
  Arr.map(agents, (agent) => `  ${agent.operation}  ${agent.agent}  ${ranOn(agent)}`);

/** The Run this command is about, and the environment it was resolved in. */
const resolveCommandRun = Effect.fn("collie.resolveCommandRun")(function* (
  global: Global,
  runId: string,
) {
  const resolved = yield* context(global, false);
  if (resolved._tag === "ContextFailure")
    return { _tag: "RunFailure" as const, result: resolved.result };
  const located = yield* locateRun(resolved.env, runId, yield* runScope(global));
  // The environment travels with the Run: a command that then reads the Run's children
  // out of the same state directory should not resolve the context twice.
  return located._tag === "RunFailure" ? located : { ...located, env: resolved.env };
});

/**
 * The directory a CLI start names as its checkout, or null for none: its `workspace`
 * option, else the checkout the command was run in.
 */
const namedCheckout = Effect.fn("run.namedCheckout")(function* (env: PluginEnv, workspace: string) {
  const given = Str.trim(workspace);
  if (given === PROJECTS_ROOT_OPTION) return (yield* projectsRoot(env)).path;
  if (pipe_(given, Str.startsWith("/"))) return given;
  if (given !== "" || (yield* insideCheckout(env.cwd))) return env.cwd;
  return null;
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
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          if (unsafePathComponent(runId))
            return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
          const shown = yield* runShown(resolved.env, runId);
          if (!shown.ok) return shown;
          const {
            view,
            agents,
            disposition,
            children,
            machine,
            startedBy,
            handoffs = [],
            replies = [],
            memory = null,
            flow = null,
          } = shown;
          const refused = outOfReach(view, machine, yield* runScope(global));
          if (refused !== null) return refused;
          const progress = yield* runProgress(resolved.env, runId);
          const ready = progress.ok && progress.value !== null ? progress.value.ready : null;
          // Both facts on the head line: how execution ended, and what became of the
          // work. A Run that failed and whose work shipped anyway says both.
          return {
            ok: true,
            data: {
              run: view,
              agents,
              disposition,
              startedBy: startedBy ?? null,
              outcome: view.outcome,
              waiting: view.waiting,
              next_action: view.waiting[0]?.name ?? null,
              machine,
              handoffs,
              replies,
              ready,
              memory,
              flow,
            },
            human: Arr.join(
              [
                `${view.runId}\t${statusLine(statusOf(view), disposition)}\t${view.workflow}`,
                ...(memory === null ? [] : [`  ${memory}`]),
                ...(machine === null ? [] : [`  on ${machine}`]),
                `  in ${view.cwd}${view.provenance["workspace"] === INFERRED ? " (inferred)" : ""}`,
                ...(view.measurement ? [`  proves ${view.outcome}; ${view.measurement}`] : []),
                ...Arr.map(
                  Rec.toEntries(view.input),
                  ([name, value]) =>
                    `  ${name} = ${textOf(value)} (${view.provenance[name] ?? GIVEN})`,
                ),
                ...(startedBy === undefined ? [] : [`  ${startedBy}`]),
                ...(view.requestedBy === undefined
                  ? []
                  : [`  ${requestedByLine(view.requestedBy)}`]),
                ...(view.report === undefined
                  ? []
                  : [
                      `  Report ${view.report.state}: ${view.report.note}`,
                      ...(view.report.closure === undefined ? [] : [`  ${view.report.closure}`]),
                    ]),
                ...Arr.map(
                  Arr.filter(view.linkNotices ?? [], (one) => one.state === "undelivered"),
                  (one) => `  ${one.phase} link notice undelivered: ${one.note}`,
                ),
                ...Arr.map(
                  Arr.filter(view.stepNotes ?? [], (one) => one.read === null),
                  (one) => `  Unread note ${one.id} for ${one.step}, from ${one.by}: ${one.text}`,
                ),
                ...agentLines(agents),
                ...describeWaiting(view),
                ...Arr.map(
                  children,
                  (child) => `  ${child.runId}\t${child.workflow}\t${statusOf(child)}`,
                ),
                ...Arr.map(handoffs, (file) => `  handoff ${file.path} (${file.bytes} bytes)`),
                ...Arr.map(replies, (reply) => `  ${replyLine(reply)}`),
                ...(ready === null ? [] : Arr.map(readyLines(ready), (line) => `  ${line}`)),
              ],
              "\n",
            ),
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
          const records = yield* asksRun(resolved.env, runId, (client) =>
            client.runMetrics({ runId }),
          );
          if (!records.ok) return records;
          const metrics = metricsOf(records.value, facts.created);
          const said = (value: number | null) =>
            value === null ? "not yet" : `${Math.round(value)}s`;
          return {
            ok: true,
            data: { metrics, outcome: facts.outcome },
            human: Arr.join(
              [
                `${facts.id}\t${facts.workflow}\t${facts.outcome}`,
                `time to first evidence: ${said(metrics.timeToFirstEvidence)}`,
                `verifications: ${metrics.verifications.pass} pass, ${metrics.verifications.fail} fail, ${metrics.verifications.unstable} unstable (${metrics.verifications.byCollie} by collie)`,
                `slices: ${metrics.slices.done} of ${metrics.slices.total} done`,
                `rework: ${metrics.rework} (fix rounds and halts)`,
                metrics.peakContext === null
                  ? "context: nothing sampled"
                  : `context: ${metrics.peakContext.tokens} tokens at most, on ${metrics.peakContext.agent}`,
              ],
              "\n",
            ),
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

const runChecks = Command.make(
  "checks",
  {
    runId: runIdArg,
    follow: Flag.Boolean("follow").pipe(
      Flag.withDescription("Print the running check's output as it is written, until it ends"),
      Flag.withDefault(false),
    ),
  },
  ({ runId, follow }) =>
    Effect.gen(function* () {
      const global = yield* root;
      const stdio = yield* Stdio.Stdio;
      // Under --json the envelope is stdout's, so the output goes to stderr.
      const say = (text: string) =>
        Stream.make(text).pipe(
          Stream.run(stdio[global.json ? "stderr" : "stdout"]({ endOnDone: false })),
          Effect.ignore,
        );
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const records = yield* asksRun(resolved.env, runId, (client) =>
            client.runChecks({ runId }),
          );
          if (!records.ok) return records;
          const running = records.value.running;
          if (follow) {
            if (running?.log == null)
              return {
                ok: true as const,
                data: { run: runId, ended: null },
                human: `No check is running for ${runId}.`,
              };
            const ended = yield* Effect.scoped(
              Effect.gen(function* () {
                const log = yield* followCheckLog(resolved.env, runId);
                const last = yield* Stream.runFoldEffect(
                  log,
                  (): import("../verify").Verification | null => null,
                  (last, event) =>
                    event._tag === "Output"
                      ? say(event.text).pipe(Effect.as(last))
                      : Effect.succeed(event.check),
                );
                return last;
              }),
            );
            return {
              ok: true as const,
              data: { run: runId, ended },
              human:
                ended === null
                  ? `${running.name} ended without a record: it was refused or interrupted.`
                  : `${ended.name} ended ${ended.result} (exit ${ended.exit}) after ${Math.round(ended.seconds)}s.`,
            };
          }
          const done = records.value.done;
          const passOf = (pass: string, round: number | null) =>
            round === null ? pass : `${pass} ${round}`;
          const human = [
            ...(running === null
              ? []
              : [
                  `running\t${passOf(running.pass, running.round)}\t${running.name}\t${running.sentence}\t${running.log ?? "no log"}`,
                ]),
            ...Arr.map(
              done,
              (one) =>
                `${one.result}\t${passOf(one.pass, one.round)}\t${one.name}\t${Math.round(one.seconds)}s\t${pipe_(one.revision, Str.slice(0, 12))}\t${one.log ?? "no log"}`,
            ),
          ];
          return {
            ok: true as const,
            data: { run: runId, running, done },
            human:
              human.length === 0 ? `Collie has run no checks for ${runId}.` : Arr.join(human, "\n"),
          };
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "The checks Collie has run for a Run, and the one it is running: each pass, why, and how long; --follow prints its output live",
  ),
);

const runReport = Command.make(
  "report",
  {
    since: Flag.String("since").pipe(
      Flag.withDescription("Only Runs admitted at or after this ISO date"),
      Flag.optional,
    ),
  },
  ({ since }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const from = Option.getOrNull(since);
          if (from !== null && Number.isNaN(epochMs(from)))
            return err("invalid_input", `--since is not a date: ${from}`);
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const done = yield* reportFor(resolved.env, from);
          if (!done.ok) return done;
          return {
            ok: true,
            data: { ...done.report, unreadable: done.unreadable },
            human: reportLines(done.report, done.unreadable),
          };
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Where Runs end, across every Run: per workflow, and each one that failed, finished or was stopped",
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
          const records = yield* asksRun(resolved.env, runId, (client) =>
            client.runOutputs({ runId }),
          );
          if (!records.ok) return records;
          const outputs = records.value;
          return {
            ok: true,
            data: { runId, outputs },
            human:
              Arr.join(
                Arr.map(outputs, (output) => {
                  const body = output.error
                    ? `Error: ${output.error}`
                    : Schemaflow(
                        Schema.encodeResult(PrettyUnknownJson),
                        SchemaResult.getOrThrow,
                      )(output.value);
                  return `${output.path}\n${Arr.join(
                    Arr.map(Str.split(body, "\n"), (line) => `  ${line}`),
                    "\n",
                  )}`;
                }),
                "\n\n",
              ) || "This Run has written no Outputs.",
          };
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("Print every Output this Run has written"));

type ParsedTimeout = { ok: true; ms: number | null } | { ok: false; error: Result };

/** A duration in Effect's canonical `DurationFromString` grammar. */
function parseTimeout(value: Option.Option<string>): ParsedTimeout {
  if (Option.isNone(value)) return { ok: true, ms: null };
  const duration = Schema.decodeOption(Schema.DurationFromString)(value.value);
  return Option.isSome(duration)
    ? { ok: true, ms: Duration.toMillis(duration.value) }
    : { ok: false, error: err("invalid_input", `Invalid timeout "${value.value}".`) };
}

type ParsedUntil = { ok: true; until: Until } | { ok: false; error: Result };

/** What ends the wait. Omitted keeps the terminal-only wait every caller already has. */
function parseUntil(value: Option.Option<string>): ParsedUntil {
  if (Option.isNone(value)) return { ok: true, until: "terminal" };
  const until = Option.getOrUndefined(Arr.findFirst(UNTILS, (one) => one === value.value));
  if (until !== undefined) return { ok: true, until };
  return {
    ok: false,
    error: err("invalid_input", `Invalid --until "${value.value}"; use ${Arr.join(UNTILS, ", ")}.`),
  };
}

const runWait = Command.make(
  "wait",
  {
    runId: runIdArg,
    follow: Flag.Boolean("follow").pipe(
      Flag.withDescription(
        "Print each change while waiting: status, steps, agents, parks, the merge request and CI",
      ),
      Flag.withDefault(false),
    ),
    timeout: Flag.String("timeout").pipe(
      Flag.withDescription("Give up after this long, e.g. `30 seconds`, `10 minutes`"),
      Flag.optional,
    ),
    until: Flag.String("until").pipe(
      Flag.withDescription(
        "`terminal` (the default) waits for the Run to end; `attention` also returns on a question, hold, stop or park; `ready` waits for Ready to release; `needs-human` for whatever only a human can move",
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
 * A Run watched to the end, or to whatever `until` names. Every state the host reports
 * arrives here, current one first — so a wait that starts long after the work did is not
 * waiting for an update that has already happened. What the status stream does not carry —
 * Ready to release, steps, agents and CI — is asked for every `PROGRESS_EVERY`.
 */
const waitForRun = Effect.fn("collie.waitForRun")(function* (
  global: Global,
  env: PluginEnv,
  runId: string,
  options: {
    readonly follow: boolean;
    readonly ms: number | null;
    readonly until: Until;
  },
) {
  const seen = yield* Ref.make<RunView | null>(null);
  const progressed = yield* Ref.make<RunProgress | null>(null);
  const told = yield* Ref.make<Followed>({ view: null, progress: null });
  const verdict = Effect.gen(function* () {
    const view = yield* Ref.get(seen);
    return view === null
      ? "waiting"
      : reached(options.until, view, yield* Ref.get(progressed), isSettled(view));
  });
  const tell = Effect.gen(function* () {
    if (!options.follow) return;
    const now = { view: yield* Ref.get(seen), progress: yield* Ref.get(progressed) };
    for (const event of followEvents(yield* Ref.getAndSet(told, now), now))
      yield* say(
        global.json
          ? yield* Schema.encodeEffect(UnknownJson)({ ...event, run: runId }).pipe(Effect.orDie)
          : followLine(runId, event),
      );
  });
  const once = watchRun(env, runId, (view) =>
    Effect.gen(function* () {
      const last = yield* Ref.getAndSet(seen, view);
      // One line per change, not per look: a run polled while it waits is not news.
      if (options.follow && (last === null || statusOf(last) !== statusOf(view))) {
        yield* say(
          global.json
            ? yield* Schema.encodeEffect(UnknownJson)({ type: "status", run: view }).pipe(
                Effect.orDie,
              )
            : `${view.runId}: ${statusOf(view)}`,
        );
      }
      yield* tell;
      return (yield* verdict) !== "waiting";
    }).pipe(Effect.orDie),
  ).pipe(Effect.scoped);
  // A host replaced or restarted under the wait ends its stream before the Run got
  // anywhere. The engine is durable and the next host serves the same Run, so the wait
  // goes on against it rather than reporting a Run that has not moved.
  const watching = Effect.gen(function* () {
    for (;;) {
      const exit = yield* Effect.exit(once);
      const over = (yield* verdict) !== "waiting";
      if (
        Exit.isSuccess(exit) &&
        (exit.value !== null || (yield* Ref.get(seen)) === null || over)
      ) {
        return exit.value;
      }
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause);
      }
      yield* Effect.sleep("500 millis");
    }
  });
  const needsProgress = options.until === "ready" || options.until === "needs-human";
  const asking = options.follow || needsProgress;
  // A host restarting under the wait fails a look or two; one that never answers, such as
  // an older build without `progress`, cannot end a wait for readiness.
  const polling = Effect.gen(function* () {
    let failures = 0;
    for (;;) {
      const read = yield* runProgress(env, runId);
      if (read.ok && read.value !== null) {
        failures = 0;
        yield* Ref.set(progressed, read.value);
        yield* tell;
        if ((yield* verdict) !== "waiting") return null;
      } else if (needsProgress && ++failures >= PROGRESS_TRIES) {
        return err(
          "operation_failed",
          `The host could not say whether run "${runId}" is ready${read.ok ? "" : `: ${read.error.message}`}.`,
          { run: runId },
        );
      }
      yield* Effect.sleep(PROGRESS_EVERY);
    }
  });
  const both = asking ? Effect.raceFirst(watching, polling) : watching;
  const bounded = options.ms === null ? both : both.pipe(Effect.timeout(options.ms));
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
  // The status stream can end the race between two looks: what changed since is still said.
  if (asking) {
    const last = yield* runProgress(env, runId);
    if (last.ok && last.value !== null) yield* Ref.set(progressed, last.value);
    yield* tell;
  }
  const progress = yield* Ref.get(progressed);
  if ((yield* verdict) === "stuck")
    return yield* printResult(
      err(
        "invalid_state",
        `Run "${runId}" will not become ready by itself: ${Arr.join(
          Arr.map(progress?.ready.missing ?? [], (one) => one.said),
          "; ",
        )}.`,
        { run: runId },
      ),
      global.json,
    );
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
    {
      ok: true,
      data: progress === null ? { run: view } : { run: view, ready: progress.ready },
      human:
        progress === null
          ? `${view.runId}: ${statusOf(view)}`
          : `${view.runId}: ${statusOf(view)}\n${Arr.join(
              Arr.map(readyLines(progress.ready), (line) => `  ${line}`),
              "\n",
            )}`,
    },
    global.json,
  );
});

/** How often a wait asks for what the status stream does not carry. */
const PROGRESS_EVERY = "2 seconds";
const PROGRESS_TRIES = 5;

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

  const shown = yield* runShown(resolved.env, runId);
  if (!shown.ok) return yield* printResult(shown, global.json);
  const refused = outOfReach(shown.view, shown.machine, yield* runScope(global));
  if (refused !== null) return yield* printResult(refused, global.json);
  return yield* waitForRun(global, resolved.env, runId, {
    follow,
    ms,
    until: untilResult.until,
  });
});

/**
 * One command against one Run. The host settles it, because the host is the only thing
 * executing anything.
 */
function runMutationCommand(
  operation: string,
  runId: string,
  requestId: Option.Option<string>,
  hosted: (env: PluginEnv, id: string) => Effect.Effect<Result, CollieError, PlatformServices>,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        return yield* mutation(resolved.env, operation, requestId, (id) =>
          hosted(resolved.env, id),
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
    decision: Flag.String("decision").pipe(
      Flag.withDescription(
        "Which question, for a workflow module waiting on more than one; `run show` names them",
      ),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, answer, decision, requestId }) =>
    runMutationCommand("run-answer", runId, requestId, (env, id) =>
      Effect.flatMap(cliDoor(env), (door) =>
        answerRun(env, {
          door,
          runId,
          decision: Option.getOrNull(decision),
          value: answer,
          request: id,
        }),
      ),
    ),
).pipe(Command.withDescription("Answer the Choice or the decision a waiting Run is asking"));

const runSteer = Command.make(
  "steer",
  {
    runId: runIdArg,
    text: Argument.String("text").pipe(
      Argument.withDescription("What to say to the agent this Run has, in your own words"),
    ),
    to: Flag.String("to").pipe(
      Flag.withDescription(
        "builder, reviewer, planner or an agent's name; by default the agent whose step is active, else the builder",
      ),
      Flag.optional,
    ),
    operation: Flag.String("operation").pipe(
      Flag.withDescription("Which of the Run's agents, by its operation or name"),
      Flag.optional,
    ),
    step: Flag.String("step").pipe(Flag.optional),
    attach: attachFlag,
    requestId: requestIdFlag,
  },
  ({ runId, text, to, operation, attach, requestId, step }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const door = yield* cliDoor(resolved.env);
          const attachments = yield* absolute(attach);
          return yield* mutation(resolved.env, "run-steer", requestId, (id) =>
            steerRun(resolved.env, {
              runId,
              text,
              request: id,
              to: Option.getOrUndefined(to),
              operation: Option.getOrNull(operation) ?? undefined,
              step: Option.getOrUndefined(step),
              attachments,
              door,
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

const runWithdrawNote = Command.make(
  "withdraw-note",
  {
    runId: runIdArg,
    note: Argument.String("note"),
    requestId: requestIdFlag,
  },
  ({ runId, note, requestId }) =>
    runMutationCommand("withdraw-note", runId, requestId, (env, request) =>
      Effect.flatMap(cliDoor(env), (door) => withdrawNoteRun(env, { runId, note, request, door })),
    ),
);

const runStop = Command.make("stop", mutationFlags, ({ runId, requestId }) =>
  runMutationCommand("run-stop", runId, requestId, (env, id) =>
    Effect.flatMap(cliDoor(env), (door) =>
      controlRun(env, { door, runId, control: "stop", set: true, request: id }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Stop a Run where it is, and its agents with it; its workspace stays for the resume",
  ),
);

const holdWorkspaceFlag = Flag.String("workspace").pipe(
  Flag.withDescription("Hold every unfinished Run in this workspace instead of one Run"),
  Flag.optional,
);

/**
 * Every Run of the Task this workspace belongs to, held. A workspace is where a Task is
 * worked, so "hold this workspace" is the Task's Runs and not whatever else is open in it.
 */
const holdTask = Effect.fn("run.holdTask")(function* (
  env: PluginEnv,
  workspace: string,
  request: string,
  reason: string | undefined,
) {
  const task = yield* taskOfWorkspace(env.stateDir, workspace);
  if (task === null)
    return err("invalid_input", `Workspace "${workspace}" is not a Task's.`, { workspace });
  const runs = Arr.filter((yield* runViews(env, task.id)).runs, (view) => !isSettled(view));
  const held: string[] = [];
  const door = yield* cliDoor(env);
  for (const view of runs) {
    const done = yield* controlRun(env, {
      door,
      runId: view.runId,
      control: "hold",
      set: true,
      request: `${request}:${view.runId}`,
      reason,
    });
    if (done.ok) held.push(view.runId);
  }
  return {
    ok: true as const,
    data: { task: task.id, workspace, held },
    human: held.length === 0 ? "Nothing here is running." : `Held ${Arr.join(held, ", ")}.`,
  };
});

const runHold = Command.make(
  "hold",
  {
    runId: runIdArg.pipe(Argument.optional),
    workspace: holdWorkspaceFlag,
    before: Flag.String("before").pipe(Flag.optional),
    reason: Flag.String("reason").pipe(
      Flag.withDescription("Why, in your own words, which the board's drawer shows"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, workspace, reason, before, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      const why = Option.getOrUndefined(reason);
      const where = Option.getOrNull(workspace);
      const id = Option.getOrNull(runId);
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          if (where !== null) {
            if (Option.isSome(before))
              return err("invalid_input", "--before names one Run's Step; give its Run id");
            return yield* mutation(resolved.env, "run-hold-workspace", requestId, (request) =>
              holdTask(resolved.env, where, request, why),
            );
          }
          if (id === null) {
            return err(
              "invalid_input",
              "`run hold` takes a Run's id, or `--workspace <id>` for every Run in one.",
            );
          }
          return yield* mutation(resolved.env, "run-hold", requestId, (request) =>
            Effect.gen(function* () {
              if (!(yield* anyRuns(resolved.env)))
                return err("run_not_found", `Run "${id}" was not found.`, { run: id });
              return yield* controlRun(resolved.env, {
                door: yield* cliDoor(resolved.env),
                request,
                runId: id,
                control: "hold",
                set: true,
                reason: why,
                before: Option.getOrUndefined(before),
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
  { runId: runIdArg, requestId: requestIdFlag, before: Flag.String("before").pipe(Flag.optional) },
  ({ runId, requestId, before }) =>
    runMutationCommand("run-release", runId, requestId, (env, id) =>
      Effect.flatMap(cliDoor(env), (door) =>
        controlRun(env, {
          door,
          runId,
          control: "hold",
          set: false,
          request: id,
          before: Option.getOrUndefined(before),
        }),
      ),
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
    runMutationCommand("run-clear-override", runId, requestId, (env, id) =>
      Effect.gen(function* () {
        const result = yield* asksRun(
          env,
          runId,
          (client) => client.clearOverride({ runId, agent, request: id }),
          yield* cliDoor(env),
        );
        if (!result.ok) return result;
        return yield* Schema.decodeUnknownEffect(ResultBoundary)(result.value).pipe(Effect.orDie);
      }),
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
          const status = statusOf(resolved.view);
          const kind = Option.getOrNull(as);
          if (kind === null) {
            const records = yield* asksRun(resolved.env, runId, (client) =>
              client.runDispositions({ runId }),
            );
            if (!records.ok) return records;
            const lines = records.value;
            return {
              ok: true,
              data: { run: facts.id, status, disposition: latest(lines), lines },
              human: statusLine(status, latest(lines)),
            };
          }
          return yield* mutation(resolved.env, "run-disposition", requestId, (id) =>
            Effect.gen(function* () {
              const done = yield* disposeRun(resolved.env, {
                door: yield* cliDoor(resolved.env),
                runId: facts.id,
                kind,
                ref,
                note: Option.getOrNull(note),
                request: id,
              });
              if (!done.ok) return done;
              return {
                ok: true,
                data: { run: facts.id, status, disposition: done.value },
                human: statusLine(status, done.value),
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

/** A finished Run's report acknowledged, for every board in the Flock; reading a Run never does this. */
const runSeen = Command.make(
  "seen",
  { runId: runIdArg, requestId: requestIdFlag },
  ({ runId, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") return resolved.result;
          const facts = runFacts(resolved);
          return yield* mutation(resolved.env, "run-seen", requestId, (id) =>
            Effect.gen(function* () {
              const done = yield* seeRun(resolved.env, {
                door: yield* cliDoor(resolved.env),
                runId: facts.id,
                request: id,
              });
              if (!done.ok) return done;
              return {
                ok: true,
                data: { run: facts.id, seen: done.value },
                human: `${facts.id} seen by ${done.value.by} at ${done.value.at}`,
              };
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Acknowledge a finished Run's report, for every board in the Flock"),
);

const runDrift = Command.make("drift", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        const records = yield* asksRun(resolved.env, runId, (client) => client.runDrift({ runId }));
        if (!records.ok) return records;
        const lines = records.value;
        const reports = currentReports(lines);
        const skipped = Arr.flatMap(lines, (line) => (line.kind === "skipped" ? [line] : []));
        return {
          ok: true,
          data: { reports, skipped },
          human:
            Arr.join(
              [
                ...Arr.map(
                  reports,
                  (report) =>
                    `${report.resolution}\t${report.severity}\t${report.kind}\t${report.constraint}\t${Arr.join(
                      Arr.map(report.evidence, (ref) => ref.path ?? ref.excerpt ?? ref.kind),
                      ", ",
                    )}${report.evidence_truncated ? " (evidence truncated)" : ""}`,
                ),
                // A judgement nobody could make is worth saying: the alternative is a Run
                // that looks clean because nothing looked at it.
                ...Arr.map(skipped, (line) => `skipped\t${line.reason}`),
              ],
              "\n",
            ) || "Nothing has drifted.",
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
        const records = yield* asksRun(resolved.env, runId, (client) => client.runCards({ runId }));
        if (!records.ok) return records;
        const cards = newest(records.value);
        return {
          ok: true,
          data: { cards },
          human:
            Arr.join(
              Arr.map(
                cards,
                (card) =>
                  `${card.at}\t${card.kind}\t${card.step}\t${card.readiness}\t${card.significance}\taligned:${card.aligned}` +
                  (card.missing.length > 0 ? `\n  unchecked: ${Arr.join(card.missing, "; ")}` : ""),
              ),
              "\n",
            ) || "No cards yet.",
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
        // nothing and says why.
        return yield* showOffers(resolved.env, runId);
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
    attach: attachFlag,
    requestId: requestIdFlag,
  },
  ({ runId, offer, input, attach, requestId }) =>
    runMutationCommand("run-action", runId, requestId, (env, id) =>
      Effect.flatMap(Effect.zip(cliDoor(env), absolute(attach)), ([door, attachments]) =>
        invokeOffer(env, {
          attachments,
          door,
          runId,
          offer,
          input: Rec.fromEntries(
            Arr.flatMap(input, (pair) => {
              const at = Option.getOrElse(pipe_(pair, Str.indexOf("=")), () => -1);
              return at === -1
                ? []
                : [[pipe_(pair, Str.slice(0, at)), pipe_(pair, Str.slice(at + 1))] as const];
            }),
          ),
          request: id,
        }),
      ),
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
        return yield* mutation(resolved.env, "run-resume", requestId, (request) =>
          Effect.gen(function* () {
            const recovered = yield* resumeRun(resolved.env, {
              door: yield* cliDoor(resolved.env),
              runId,
              request,
            });
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
  options: {
    readonly propagate?: boolean;
    /** What a hosted Run does instead, where it keeps this outside an Intent. */
    readonly verification?: {
      readonly name: string;
      readonly command: Omit<import("../verify-spec").VerifySpec, "name"> | null;
    };
  } = {},
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") return resolved.result;
        let wanted: typeof import("../intent-model").IntentChangeSchema.Type;
        if (options.verification !== undefined)
          wanted = { kind: "verification", ...options.verification };
        else {
          const current = yield* asksRun(resolved.env, runId, (client) =>
            client.runIntent({ runId }),
          );
          if (!current.ok) return current;
          if (current.value === null)
            return err("invalid_state", `Run "${runId}" has no Intent to amend.`);
          const chosen = change(current.value);
          if ("ok" in chosen) return chosen;
          wanted = chosen;
        }
        return yield* mutation(resolved.env, operation, requestId, (request) =>
          Effect.gen(function* () {
            const result = yield* asksRun(
              resolved.env,
              runId,
              (client) =>
                client.changeIntent({
                  runId,
                  change: wanted,
                  propagate: options.propagate ?? false,
                  request,
                }),
              yield* cliDoor(resolved.env),
            );
            if (!result.ok) return result;
            const { version, propagated, approved, warning, redacted } = result.value;
            return approved === undefined
              ? {
                  ok: true as const,
                  data: { runId, version, propagated, ...redactedField(redacted) },
                  human: withNotice(
                    Arr.join([`${runId}: intent v${version}`, ...propagated], "\n"),
                    redacted,
                  ),
                }
              : {
                  ok: true as const,
                  data: { run: runId, approved, warning },
                  human: Arr.join(
                    [
                      `${runId} may have Collie run:`,
                      ...Arr.map(
                        approved,
                        (one) =>
                          `  ${one.name}: ${CommandLine.display([one.executable, ...one.argv])} (in ${one.cwd})`,
                      ),
                      ...(warning === undefined ? [] : [warning]),
                    ],
                    "\n",
                  ),
                };
          }),
        );
      }),
      global.json,
    );
  });
}

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
        const records = yield* asksRun(resolved.env, runId, (client) =>
          client.runIntent({ runId }),
        );
        if (!records.ok) return records;
        const intent = records.value;
        if (intent === null) return err("invalid_state", `Run "${runId}" has no Intent.`);
        return {
          ok: true,
          data: { intent },
          human: Arr.join(
            [
              `v${intent.version}\tgoal: ${intent.goal ?? "(none)"}`,
              ...Arr.map(
                intent.constraints,
                (c) => `  ${c.id}\t${c.severity}\t${c.kind}\t${c.source}\t${c.text}`,
              ),
              ...Arr.map(intent.history, (h) => `  v${h.version}\t${h.by}\t${h.change}`),
            ],
            "\n",
          ),
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

const intentSetOutcome = Command.make(
  "set-outcome",
  {
    runId: runIdArg,
    kind: Argument.String("kind").pipe(
      Argument.withDescription(
        "feature, bug, refactor, investigation, docs or migration; unspecified clears it",
      ),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, kind, requestId }) =>
    intentChange("run-intent-outcome", runId, requestId, () => outcomeChange(kind)),
).pipe(Command.withDescription("Change the outcome kind a Run is held to"));

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
 * The one amendment that is not a `k=v` word: a check Collie runs itself, bound argument
 * for argument. The wrapper is part of the check — `bun test` and `bun test --bail` are
 * two different ones.
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
      Flag.withDescription("Withdraw the check of this name instead of naming one"),
      Flag.withDefault(false),
    ),
    command: Argument.String("command").pipe(
      Argument.withDescription("The executable and its arguments, after `--`"),
      Argument.variadic({ min: 0 }),
    ),
    propagate: propagateFlag,
    requestId: requestIdFlag,
  },
  ({ runId, name, cwd, remove, command, propagate: wants, requestId }) => {
    const [executable, ...argv] = command;
    const granted = remove || executable === undefined ? null : { executable, argv, cwd };
    const missing = err("invalid_input", "A check needs a command, after `--`.");
    if (!remove && granted === null)
      return Effect.gen(function* () {
        const global = yield* root;
        yield* printResult(missing, global.json);
      });
    return intentChange(
      "run-intent-verification",
      runId,
      requestId,
      (intent) =>
        !remove && granted === null ? missing : verificationGrant(intent, name, granted),
      {
        propagate: wants,
        verification: { name, command: granted },
      },
    );
  },
).pipe(
  Command.withDescription("Name one exact command Collie runs itself as a check for this Run"),
);

const intentRemember = Command.make(
  "remember",
  {
    runId: runIdArg,
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription("Overwrite this repository's remembered checks"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, replace, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") return resolved.result;
          return yield* mutation(resolved.env, "run-intent-remember", requestId, (request) =>
            Effect.gen(function* () {
              const result = yield* asksRun(
                resolved.env,
                runId,
                (client) => client.rememberVerification({ runId, replace, request }),
                yield* cliDoor(resolved.env),
              );
              return result.ok
                ? yield* Schema.decodeUnknownEffect(ResultBoundary)(result.value).pipe(Effect.orDie)
                : result;
            }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Save a Run's checks as its repository's own, for every Run started there later",
  ),
);

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
        constraints: [
          ...Arr.filter(defaults.constraints, (c) => c.id !== constraint.id),
          constraint,
        ],
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
      constraints: Arr.filter(defaults.constraints, (c) => c.id !== id),
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
    intentSetOutcome,
    intentAdd,
    intentRemove,
    intentAuthority,
    intentVerification,
    intentRemember,
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
    runWithdrawNote,
    runClearOverride,
    runDeliveries,
    runDisposition,
    runSeen,
    runMetrics,
    runChecks,
    runReport,
    runDrift,
    runCards,
    runActions,
    runAction,
    runIntent,
    runOutput,
  ]),
);
