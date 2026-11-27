import type { Verification } from "../verify";
import type { VerifySpec } from "../verify-spec";
import type { IntentChangeSchema } from "../intent-model";
import * as Arr from "effect/Array";
import { withArtefacts, uploadArtefact } from "../artefact-client";
import type { RegisterArtefact } from "../artefact-model";
import { parkLine } from "../park-cause";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import type { FileSystem } from "effect";
import {
  Cause,
  Data,
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
import { err } from "../operations";
import type { Failure, OpResult } from "../operations";
import { GIVEN, INFERRED } from "../engine";
import { textOf } from "../runs";
import { DEFAULT_LIMIT, LIST_STATES, listAsked, outputSummary } from "../run-list";
import {
  asksRun,
  followCheckLog,
  describeWaiting,
  nextAction,
  answerRun,
  anyRuns,
  controlRun,
  withdrawNoteRun,
  disposeRun,
  setFindingRun,
  seeRun,
  invokeOffer,
  showOffers,
  steerRun,
  moduleFor,
  runViews,
  usageFor,
  flockArtefacts,
  asksArtefactRun,
  flockRunPage,
  isSettled,
  resumeRun,
  publishRun,
  startRun,
  statusOf,
  watchRun,
  runShown,
  runProgress,
  reportFor,
  hostTasks,
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
} from "../intent";
import type { Change, Constraint, Defaults, Intent } from "../intent";
import { scopeFor, scopeKey } from "../registry";
import type { TaskChoice } from "../task";
import { runDeliveries } from "./steer";
import { givenVerifications } from "../verify-spec";
import { agentStartRefusal, CLI_CHECKOUT_FIX, hostOptions, insideCheckout } from "../agent-start";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "../projects";
import { currentReports } from "../drift";
import { newest } from "../cards";
import { metricsOf } from "../metrics";
import { compareRuns } from "../trial-compare";
import { trialLines } from "../trial-model";
import { usageLines } from "../usage-ledger-model";
import { requestedByLine, ranOn } from "../board-model";
import type { RunAgent, RunProgress } from "../board-model";
import { followEvents, followLine, readyLines, reached, UNTILS } from "../following";
import type { Followed, Until } from "../following";
import { reportLines } from "../report";
import { latest, statusLine } from "../disposition";
import { replyLine } from "../replies";
import { epochMs } from "../time";
import type { PluginEnv } from "../env";
import {
  attempt,
  guarded,
  mutation,
  printResult,
  requestId as requested,
  ResultBoundary,
  say,
  withRequestId,
} from "../envelope";
import type { Call, CollieError, Result } from "../envelope";
import {
  PrettyUnknownJson,
  UnknownJson,
  cliDoor,
  context,
  mutating,
  parseInput,
  locateRun,
  runFacts,
  runScope,
  requestIdFlag,
  resolvedAt,
  runIdArg,
  root,
  selected,
  selectedTask,
} from "./shared";
import type { Global } from "./shared";
import { outOfReach, readRunLines } from "../run-read";
import { DEFAULT_LINES } from "../text-lines";

const inputPairs = (pairs: ReadonlyArray<string>) =>
  Rec.fromEntries(
    Arr.flatMap(pairs, (pair) => {
      const at = Option.getOrElse(pipe_(pair, Str.indexOf("=")), () => -1);
      return at === -1
        ? []
        : [[pipe_(pair, Str.slice(0, at)), pipe_(pair, Str.slice(at + 1))] as const];
    }),
  );

// WARNING: paired by position; a repeated flag arrives as its own list, so order between lists is lost.
function namedConstraints(texts: ReadonlyArray<string>, severities: ReadonlyArray<string>) {
  const constraints: Array<Omit<Constraint, "since">> = [];
  const refuse = (error: string) => ({ error, constraints });
  if (severities.length > texts.length) {
    return refuse(`--severity was given more times than --constraint.`);
  }
  for (const [index, text] of texts.entries()) {
    const level = severityOf(severities[index] ?? "warn");
    if (level === null) {
      return refuse(`--severity is block or warn.`);
    }
    const parsed = parseConstraint(text, level);
    if ("error" in parsed) {
      return refuse(parsed.error);
    }
    constraints.push(parsed);
  }
  return { error: null, constraints };
}

// WARNING: fresh unless the caller names a Task; an unasked continuation is how two pieces of work become one.
const chosenTask = Effect.fn("collie.chosenTask")(function* (
  env: PluginEnv,
  named: Option.Option<string>,
) {
  const taken = (choice: TaskChoice) => ({ ok: true as const, choice });
  if (Option.isNone(named)) {
    return taken({ mode: "new" });
  }
  const task = Option.getOrNull(
    Arr.findFirst(yield* hostTasks(env), (one) => one.id === named.value),
  );
  if (!task) {
    return {
      ok: false as const,
      error: err("task_not_found", `Task "${named.value}" was not found.`, { task: named.value }),
    };
  }
  return taken({ mode: "continue", task });
});

// WARNING: refused rather than dropped; a decision nobody answered is worse than being told so here.
function unsupportedDecide(decide: ReadonlyArray<string>) {
  if (decide.length === 0) {
    return null;
  }
  return err(
    "invalid_input",
    "A workflow saved as a module asks its questions when its work reaches them; --decide is not one of its inputs.",
  );
}

const attachFlag = Flag.String("attach").pipe(
  Flag.withDescription("A file to give the Run, repeatable; the host copies it into the Run"),
  Flag.atLeast(0),
);

const absolute = (env: PluginEnv, files: ReadonlyArray<string>) =>
  Effect.map(Path.Path, (path) =>
    files.length === 0 ? undefined : Arr.map(files, (file) => path.resolve(env.cwd, file)),
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
          const id = yield* requested(request);
          const withId = (failure: OpResult) => withRequestId(failure, id);
          const base = yield* context(global, false);
          if (base._tag === "ContextFailure") {
            return withId(base.result);
          }
          const resolved = yield* context(global, (yield* selected(global)) !== null);
          if (resolved._tag === "ContextFailure") {
            return withId(resolved.result);
          }
          const explicit = yield* parseInput(input, inputsJson);
          if (!explicit.ok) {
            return withId(explicit.error);
          }
          const named = namedConstraints(constraint, severity);
          if (named.error !== null) {
            return withId(err("invalid_input", named.error));
          }
          const given = givenVerifications(verify);
          if (!given.ok) {
            return withId(err("invalid_input", given.error));
          }
          return yield* mutation(
            base.env,
            {
              operation: "run-start",
              run: null,
              destination: "cwd",
              at: resolvedAt(resolved),
              files: attach,
              args: {
                workflow,
                input: { json: explicit.given.json, text: explicit.given.text },
                decide: [...decide],
                task: Option.getOrNull(taskId),
                title: Option.getOrNull(title),
                goal: Option.getOrNull(goal),
                constraints: named.constraints,
                verify: given.specs,
                harness: Option.getOrNull(harness),
                model: Option.getOrNull(model),
                effort: Option.getOrNull(effort),
              },
            },
            Option.some(id),
            (requestId) =>
              Effect.gen(function* () {
                // WARNING: inference is task-local, so a continuation sees its own Task's plans and a fresh start sees only the Runs recorded before Tasks.
                const task = yield* chosenTask(resolved.env, taskId);
                if (!task.ok) {
                  return task.error;
                }
                const saved =
                  resolved.env.machine === undefined
                    ? yield* moduleFor(resolved.env, workflow)
                    : { id: workflow };
                if (saved !== null) {
                  const unsupported = unsupportedDecide(decide);
                  if (unsupported !== null) {
                    return unsupported;
                  }
                  // WARNING: the host's own options are kept apart from the author's payload, so a module's input never gets host values.
                  const launch = hostOptions(explicit.given);
                  const agent = Arr.flatMap(
                    Rec.toEntries({ harness, model, effort }),
                    ([name, value]) => (Option.isSome(value) ? [[name, value.value] as const] : []),
                  );
                  if ("inputs" in saved) {
                    const needed = yield* agentStartRefusal(resolved.env, saved, launch.input, {
                      named: yield* namedCheckout(resolved.env, launch.options.workspace ?? ""),
                      fix: CLI_CHECKOUT_FIX,
                    });
                    if (needed !== null) {
                      return needed;
                    }
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
                    attachments: yield* absolute(base.env, attach),
                  });
                  if (!started.ok) {
                    return started;
                  }
                  const data = {
                    runId: started.runId,
                    workflow,
                    registration: started.registration,
                    fresh: started.fresh,
                    ...redactedField(started.redacted),
                  };
                  return {
                    ok: true,
                    data:
                      started.followed === undefined
                        ? data
                        : { ...data, followed: started.followed },
                    human: withNotice(
                      started.followed === undefined
                        ? `Started run ${started.runId}.`
                        : `Run ${started.runId} already follows ${started.followed}.`,
                      started.redacted,
                    ),
                  };
                }
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

const runList = Command.make(
  "list",
  {
    status: Flag.String("status").pipe(
      Flag.withDescription(`Only Runs in this state, repeatable: ${Arr.join(LIST_STATES, ", ")}`),
      Flag.atLeast(0),
    ),
    limit: Flag.String("limit").pipe(
      Flag.withDescription(`At most this many Runs, newest first; ${DEFAULT_LIMIT} by default`),
      Flag.optional,
    ),
    fields: Flag.String("fields").pipe(
      Flag.withDescription(
        "summary (the default) or full, each Run's whole view; full with no --limit is every Run",
      ),
      Flag.optional,
    ),
    after: Flag.String("after").pipe(
      Flag.withDescription("The next page: a listing's `next` token, given alone"),
      Flag.optional,
    ),
    since: Flag.String("since").pipe(
      Flag.withDescription("Only Runs changed after a listing's `cursor`"),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const read = listAsked(
            {
              status: flags.status,
              limit: Option.getOrNull(flags.limit),
              fields: Option.getOrNull(flags.fields),
              after: Option.getOrNull(flags.after),
              since: Option.getOrNull(flags.since),
            },
            yield* selectedTask(global),
          );
          if (!read.ok) {
            return err("invalid_input", read.message);
          }
          const listed = yield* flockRunPage(resolved.env, read.asked);
          if (!listed.ok) {
            return listed;
          }
          return {
            ok: true,
            data: {
              runs: Arr.map(listed.runs, ({ machine, summary, view }) => ({
                ...(view ?? summary),
                machine,
              })),
              complete: listed.complete,
              next: listed.next,
              cursor: listed.cursor,
              omitted: listed.omitted,
              unreadable: listed.unreadable,
              machines: listed.machines,
            },
            human: Arr.join(
              [
                ...Arr.map(
                  listed.runs,
                  ({ machine, summary }) =>
                    `${summary.runId}\t${machine}\t${summary.state}\t${summary.workflow}${summary.blocker === null ? "" : `\t${summary.blocker}`}`,
                ),
                ...(listed.runs.length === 0 ? ["No runs found."] : []),
                ...(listed.unreadable === null ? [] : [`runs: ${listed.unreadable}`]),
                ...Arr.map(listed.machines, (one) => `${one.machine}: away, ${one.note}`),
                ...(listed.next === null
                  ? []
                  : [`${listed.omitted} more not listed: collie run list --after ${listed.next}`]),
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
    "List Runs in the selected workspace, or everywhere without one: a page of summaries, newest first",
  ),
);

export const agentLines = (agents: ReadonlyArray<RunAgent>) =>
  Arr.map(agents, (agent) => `  ${agent.operation}  ${agent.agent}  ${ranOn(agent)}`);

const resolveCommandRun = Effect.fn("collie.resolveCommandRun")(function* (
  global: Global,
  runId: string,
) {
  const resolved = yield* context(global, false);
  if (resolved._tag === "ContextFailure") {
    return { _tag: "RunFailure" as const, result: resolved.result };
  }
  const located = yield* locateRun(resolved.env, runId, yield* runScope(global));
  return located._tag === "RunFailure" ? located : { ...located, env: resolved.env };
});

const namedCheckout = Effect.fn("run.namedCheckout")(function* (env: PluginEnv, workspace: string) {
  const given = Str.trim(workspace);
  if (given === PROJECTS_ROOT_OPTION) {
    return (yield* projectsRoot(env)).path;
  }
  if (pipe_(given, Str.startsWith("/"))) {
    return given;
  }
  if (given !== "" || (yield* insideCheckout(env.cwd))) {
    return env.cwd;
  }
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
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          if (unsafePathComponent(runId)) {
            return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
          }
          const shown = yield* runShown(resolved.env, runId);
          if (!shown.ok) {
            return shown;
          }
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
            branchProgress = null,
          } = shown;
          const refused = yield* outOfReach(resolved.env, view, machine, yield* runScope(global));
          if (refused !== null) {
            return refused;
          }
          const progress = yield* runProgress(resolved.env, runId);
          const ready = progress.ok && progress.value !== null ? progress.value.ready : null;
          const left = yield* asksRun(resolved.env, runId, (client) =>
            client.runFindings({ runId }),
          );
          if (!left.ok) {
            return left;
          }
          const findings = left.value;
          return {
            ok: true,
            data: {
              run: view,
              findings,
              agents,
              disposition,
              startedBy: startedBy ?? null,
              outcome: view.outcome,
              waiting: view.waiting,
              next_action: nextAction(view),
              machine,
              handoffs,
              replies,
              ready,
              memory,
              flow,
              branchProgress,
            },
            human: Arr.join(
              [
                `${view.runId}\t${statusLine(statusOf(view), disposition)}\t${view.workflow}`,
                ...(view.park == null ? [] : [`  ${parkLine(view.park)}`]),
                ...((view.recovery?.length ?? 0) === 0
                  ? []
                  : ["  Recovery:", ...Arr.map(view.recovery ?? [], (line) => `    ${line}`)]),
                ...(branchProgress === null ? [] : [branchProgress]),
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
                ...(findings.length === 0
                  ? []
                  : ["  Findings:", ...Arr.map(findings, (one) => `    ${findingLine(one)}`)]),
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

const trialFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.atLeast(0));

const runMetrics = Command.make(
  "metrics",
  {
    runId: runIdArg.pipe(Argument.optional),
    compare: trialFlag(
      "compare",
      "A Run of the first set, as <run> or <run>=<case>, repeatable; Runs sharing a case are its repeats",
    ),
    against: trialFlag("against", "A Run of the second set, as --compare takes one, repeatable"),
    audit: trialFlag(
      "audit",
      "<run>=<review-run>: the review Run of that Run's final tree, whose blocking findings escaped it",
    ),
    plant: trialFlag(
      "plant",
      "<case>=<file>:<line>: a regression planted in that case, caught where a reviewer names it",
    ),
  },
  ({ runId: given, compare, against, audit, plant }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          if (compare.length > 0 || against.length > 0) {
            const resolved = yield* context(global, false);
            if (resolved._tag === "ContextFailure") {
              return resolved.result;
            }
            const compared = yield* compareRuns(resolved.env, { compare, against, audit, plant });
            if (!compared.ok) {
              return compared;
            }
            return {
              ok: true,
              data: compared.value,
              human: Arr.join(trialLines(compared.value), "\n"),
            };
          }
          if (Option.isNone(given)) {
            return err(
              "invalid_input",
              "Name a Run, or two sets of them with --compare and --against",
            );
          }
          const runId = given.value;
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") {
            return resolved.result;
          }
          const facts = runFacts(resolved);
          const records = yield* asksRun(resolved.env, runId, (client) =>
            client.runMetrics({ runId }),
          );
          if (!records.ok) {
            return records;
          }
          const metrics = metricsOf(records.value, facts.created);
          const spent = yield* usageFor(resolved.env, runId);
          if (!spent.ok) {
            return spent;
          }
          const usage = spent.value;
          const said = (value: number | null) =>
            value === null ? "not yet" : `${Math.round(value)}s`;
          return {
            ok: true,
            data: { metrics, usage, outcome: facts.outcome },
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
                ...usageLines(usage),
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
    "What a Run actually did: evidence, slices, rounds, rework, context and tokens — not pane activity; or two sets of Runs compared per case and per accepted change",
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
      const say = (text: string) =>
        Stream.make(text).pipe(
          Stream.run(stdio[global.json ? "stderr" : "stdout"]({ endOnDone: false })),
          Effect.ignore,
        );
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const records = yield* asksRun(resolved.env, runId, (client) =>
            client.runChecks({ runId }),
          );
          if (!records.ok) {
            return records;
          }
          const running = records.value.running;
          if (follow) {
            if (running?.log == null) {
              return {
                ok: true as const,
                data: { run: runId, ended: null },
                human: `No check is running for ${runId}.`,
              };
            }
            const ended = yield* Effect.scoped(
              Effect.gen(function* () {
                const log = yield* followCheckLog(resolved.env, runId);
                const nothingYet: () => Verification | null = () => null;
                const last = yield* Stream.runFoldEffect(log, nothingYet, (last, event) =>
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
          if (from !== null && Number.isNaN(epochMs(from))) {
            return err("invalid_input", `--since is not a date: ${from}`);
          }
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const done = yield* reportFor(resolved.env, from);
          if (!done.ok) {
            return done;
          }
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

// WARNING: the files are the record; read the directory, not an engine's list of what it wrote.
const runOutput = Command.make(
  "output",
  {
    runId: runIdArg,
    full: Flag.Boolean("full").pipe(
      Flag.withDescription("Each Output whole, as the Run wrote it, diffs included"),
      Flag.withDefault(false),
    ),
    path: Flag.String("path").pipe(
      Flag.withDescription("Only the Output at this path, as the summary's `read` names it"),
      Flag.optional,
    ),
  },
  ({ runId, full, path }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") {
            return resolved.result;
          }
          const records = yield* asksRun(resolved.env, runId, (client) =>
            client.runOutputs({ runId }),
          );
          if (!records.ok) {
            return records;
          }
          const outputs = Option.match(path, {
            onNone: () => records.value,
            onSome: (one) => Arr.filter(records.value, (output) => output.path === one),
          });
          if (Option.isSome(path) && outputs.length === 0) {
            return err("invalid_input", `Run ${runId} has no Output at ${path.value}.`, {
              path: path.value,
            });
          }
          if (!full) {
            const summaries = Arr.map(outputs, (output) => outputSummary(runId, output));
            return {
              ok: true,
              data: { runId, outputs: summaries },
              human:
                Arr.join(
                  Arr.map(summaries, (one) =>
                    Arr.join(
                      [
                        `${one.path}${one.verdict === null ? "" : `  ${one.verdict}`}${one.findings === null ? "" : `, ${one.findings} finding(s)`}`,
                        ...(one.error === undefined ? [] : [`  Error: ${one.error}`]),
                        ...(one.summary === null ? [] : [`  ${one.summary}`]),
                        `  ${one.read}`,
                      ],
                      "\n",
                    ),
                  ),
                  "\n\n",
                ) || "This Run has written no Outputs.",
            };
          }
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
).pipe(
  Command.withDescription(
    "Summarise each Output this Run has written, with where to read it; --full prints them whole",
  ),
);

const runRead = Command.make(
  "read",
  {
    runId: runIdArg,
    ref: Argument.String("ref").pipe(
      Argument.withDescription(
        "What to read: log, review, diff:<path>, evidence:<name>, plan:<file>, verification:<id>, …",
      ),
    ),
    start: Flag.Int("start").pipe(
      Flag.withDescription("The first line, counted from 1; a search looks from here"),
      Flag.withDefault(1),
    ),
    count: Flag.Int("count").pipe(
      Flag.withDescription(`How many lines, or matches with --search (default ${DEFAULT_LINES})`),
      Flag.withDefault(DEFAULT_LINES),
    ),
    search: Flag.String("search").pipe(
      Flag.withDescription(
        "A regular expression: the lines it matches, each with the line either side",
      ),
      Flag.optional,
    ),
  },
  ({ runId, ref, start, count, search }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const read = yield* readRunLines(resolved.env, yield* runScope(global), runId, ref, {
            start,
            count,
            search: Option.getOrNull(search),
          });
          if (!read.ok) {
            return read;
          }
          const page = read.data;
          const numbered = (line: number, mark: string, text: string) =>
            `${pipe_(String(line), Str.padStart(6))}${mark} ${text}`;
          return {
            ok: true,
            data: page,
            human: Arr.join(
              [
                ...Arr.flatMap(page.lines, (one) =>
                  one.before === undefined
                    ? [numbered(one.line, " ", one.text)]
                    : [
                        ...(one.before === null ? [] : [numbered(one.line - 1, "-", one.before)]),
                        numbered(one.line, ":", one.text),
                        ...(one.after == null ? [] : [numbered(one.line + 1, "-", one.after)]),
                      ],
                ),
                page.complete
                  ? `Lines ${page.from}-${page.to} of ${page.total}: complete.`
                  : `Lines ${page.from}-${page.to} of ${page.total}: not complete; read on with --start ${page.next}.`,
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
    "Read a Run's log, diff, review, evidence, plan or verification by line range, or search it",
  ),
);

type ParsedTimeout = { ok: true; ms: number | null } | { ok: false; error: Result };

function parseTimeout(value: Option.Option<string>) {
  if (Option.isNone(value)) {
    const returned: ParsedTimeout = { ok: true, ms: null };
    return returned;
  }
  const duration = Schema.decodeOption(Schema.DurationFromString)(value.value);
  const returned: ParsedTimeout = Option.isSome(duration)
    ? { ok: true, ms: Duration.toMillis(duration.value) }
    : { ok: false, error: err("invalid_input", `Invalid timeout "${value.value}".`) };
  return returned;
}

type ParsedUntil = { ok: true; until: Until } | { ok: false; error: Result };

function parseUntil(value: Option.Option<string>) {
  if (Option.isNone(value)) {
    const returned: ParsedUntil = { ok: true, until: "terminal" };
    return returned;
  }
  const until = Option.getOrUndefined(Arr.findFirst(UNTILS, (one) => one === value.value));
  if (until !== undefined) {
    const returned: ParsedUntil = { ok: true, until };
    return returned;
  }
  const returned: ParsedUntil = {
    ok: false,
    error: err("invalid_input", `Invalid --until "${value.value}"; use ${Arr.join(UNTILS, ", ")}.`),
  };
  return returned;
}

const runWait = Command.make(
  "wait",
  {
    runIds: runIdArg.pipe(Argument.variadic({ min: 1 })),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription(
        "With several Runs, wait until every one has met the condition, not the first",
      ),
      Flag.withDefault(false),
    ),
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
  ({ runIds, all, follow, timeout, until }) =>
    Effect.gen(function* () {
      const global = yield* root;
      // WARNING: guarded, not attempt: the stream prints its own lines, but a defect must still end as one envelope.
      yield* guarded(waitFor(global, runIds, follow, timeout, until, all), global.json);
    }),
).pipe(
  Command.withDescription(
    "Wait for Runs to finish, or to need attention: the first of them, or with --all every one",
  ),
);

// WARNING: the current state arrives first; what the status stream lacks (readiness, steps, agents, CI) is polled.
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
    if (!options.follow) {
      return;
    }
    const now = { view: yield* Ref.get(seen), progress: yield* Ref.get(progressed) };
    for (const event of followEvents(yield* Ref.getAndSet(told, now), now)) {
      yield* say(
        global.json
          ? yield* Schema.encodeEffect(UnknownJson)({ ...event, run: runId }).pipe(Effect.orDie)
          : followLine(runId, event),
      );
    }
  });
  const once = watchRun(env, runId, (view) =>
    Effect.gen(function* () {
      const last = yield* Ref.getAndSet(seen, view);
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
  // WARNING: a host replaced under the wait ends its stream; the wait goes on against the next host.
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
  // WARNING: a host restarting fails a look or two; one that never answers cannot end a wait for readiness.
  const polling = Effect.gen(function* () {
    let failures = 0;
    for (;;) {
      const read = yield* runProgress(env, runId);
      if (read.ok && read.value !== null) {
        failures = 0;
        yield* Ref.set(progressed, read.value);
        yield* tell;
        if ((yield* verdict) !== "waiting") {
          return null;
        }
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
  if (failed !== null) {
    return failed;
  }
  if (asking) {
    const last = yield* runProgress(env, runId);
    if (last.ok && last.value !== null) {
      yield* Ref.set(progressed, last.value);
    }
    yield* tell;
  }
  const progress = yield* Ref.get(progressed);
  if ((yield* verdict) === "stuck") {
    return err(
      "invalid_state",
      `Run "${runId}" will not become ready by itself: ${Arr.join(
        Arr.map(progress?.ready.missing ?? [], (one) => one.said),
        "; ",
      )}.`,
      { run: runId },
    );
  }
  // WARNING: --follow already said everything as it happened; one more envelope would print the last line twice.
  if (options.follow) {
    return null;
  }
  const view = yield* Ref.get(seen);
  if (view === null) {
    return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
  }
  const waited: Result = {
    ok: true,
    data: progress === null ? { run: view } : { run: view, ready: progress.ready },
    human:
      progress === null
        ? `${view.runId}: ${statusOf(view)}`
        : `${view.runId}: ${statusOf(view)}\n${Arr.join(
            Arr.map(readyLines(progress.ready), (line) => `  ${line}`),
            "\n",
          )}`,
  };
  return waited;
});

const PROGRESS_EVERY = "2 seconds";
const PROGRESS_TRIES = 5;

export const waitFor = Effect.fn("collie.waitFor")(function* (
  global: Global,
  runIds: ReadonlyArray<string>,
  follow: boolean,
  timeout: Option.Option<string>,
  until: Option.Option<string> = Option.none(),
  all = false,
) {
  const resolved = yield* context(global, false);
  if (resolved._tag === "ContextFailure") {
    return yield* printResult(resolved.result, global.json);
  }
  const timeoutResult = parseTimeout(timeout);
  if (!timeoutResult.ok) {
    return yield* printResult(timeoutResult.error, global.json);
  }
  const { ms } = timeoutResult;
  const untilResult = parseUntil(until);
  if (!untilResult.ok) {
    return yield* printResult(untilResult.error, global.json);
  }

  const scope = yield* runScope(global);
  for (const runId of runIds) {
    const shown = yield* runShown(resolved.env, runId);
    if (!shown.ok) {
      return yield* printResult(shown, global.json);
    }
    const refused = yield* outOfReach(resolved.env, shown.view, shown.machine, scope);
    if (refused !== null) {
      return yield* printResult(refused, global.json);
    }
  }
  const one = (runId: string, bound: number | null) =>
    waitForRun(global, resolved.env, runId, { follow, ms: bound, until: untilResult.until });
  const waited =
    runIds.length === 1
      ? yield* one(runIds[0]!, ms)
      : yield* (
          all
            ? everyWaited(Arr.map(runIds, (id) => one(id, null)))
            : Effect.raceAll(Arr.map(runIds, (id) => one(id, null)))
        ).pipe(
          (both) => (ms === null ? both : both.pipe(Effect.timeout(ms))),
          Effect.catchTag("TimeoutError", () =>
            Effect.succeed(err("timeout", `Timed out waiting for runs ${Arr.join(runIds, ", ")}.`)),
          ),
        );
  if (waited !== null) {
    yield* printResult(waited, global.json);
  }
});

class WaitFailed extends Data.TaggedError("WaitFailed")<{ readonly result: Result }> {}

const everyWaited = <E, R>(waits: ReadonlyArray<Effect.Effect<Result | null, E, R>>) =>
  Effect.all(
    Arr.map(waits, (wait) =>
      wait.pipe(
        Effect.filterOrFail(
          (one) => one === null || one.ok,
          (one) => new WaitFailed({ result: one! }),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((results) => {
      const done = Arr.flatMap(results, (one) => (one !== null && one.ok ? [one] : []));
      const waited: Result | null =
        done.length === 0
          ? null
          : {
              ok: true,
              data: { runs: Arr.map(done, (one) => one.data) },
              human: Arr.join(
                Arr.map(done, (one) => one.human),
                "\n",
              ),
            };
      return waited;
    }),
    Effect.catchIf(
      (cause): cause is WaitFailed => cause instanceof WaitFailed,
      (failed) => Effect.succeed(failed.result),
    ),
  );

function runMutationCommand(
  call: Call,
  requestId: Option.Option<string>,
  hosted: (env: PluginEnv, id: string) => Effect.Effect<Result, CollieError, PlatformServices>,
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
        return yield* mutation(resolved.env, call, requestId, (id) => hosted(resolved.env, id));
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
      Argument.withDescription("The Choice to take, by the id or the title `run show` lists"),
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
    runMutationCommand(
      {
        operation: "run-answer",
        run: runId,
        args: {
          runId,
          answer,
          decision: Option.getOrNull(decision),
        },
      },
      requestId,
      (env, id) =>
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
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const door = yield* cliDoor(resolved.env);
          const attachments = yield* absolute(resolved.env, attach);
          return yield* mutation(
            resolved.env,
            {
              operation: "run-steer",
              run: runId,
              files: attach,
              args: {
                runId,
                text,
                to: Option.getOrNull(to),
                operation: Option.getOrNull(operation),
                step: Option.getOrNull(step),
              },
            },
            requestId,
            (id) =>
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

const runPublish = Command.make(
  "publish",
  {
    runId: runIdArg,
    title: Flag.String("title").pipe(Flag.withDefault("")),
    file: Flag.String("file").pipe(Flag.withDefault("")),
    onto: Flag.String("onto").pipe(Flag.optional),
    pushOnly: Flag.Boolean("push-only").pipe(Flag.withDefault(false)),
    skipCi: Flag.Boolean("skip-ci").pipe(Flag.withDefault(false)),
    requestId: requestIdFlag,
  },
  ({ runId, title, file, onto, pushOnly, skipCi, requestId }) =>
    runMutationCommand(
      {
        operation: "run-publish",
        run: runId,
        args: {
          runId,
          title,
          file,
          onto: Option.getOrNull(onto),
          pushOnly,
          skipCi,
        },
      },
      requestId,
      (env, request) =>
        Effect.flatMap(cliDoor(env), (door) =>
          publishRun(env, {
            door,
            runId,
            title,
            file,
            onto: Option.getOrUndefined(onto),
            pushOnly,
            skipCi,
            request,
          }),
        ),
    ),
).pipe(
  Command.withDescription(
    "Check public text, push the branch, and open or update its merge request",
  ),
);

const runWithdrawNote = Command.make(
  "withdraw-note",
  {
    runId: runIdArg,
    note: Argument.String("note"),
    requestId: requestIdFlag,
  },
  ({ runId, note, requestId }) =>
    runMutationCommand(
      { operation: "withdraw-note", run: runId, args: { runId, note } },
      requestId,
      (env, request) =>
        Effect.flatMap(cliDoor(env), (door) =>
          withdrawNoteRun(env, { runId, note, request, door }),
        ),
    ),
);

const runStop = Command.make("stop", mutationFlags, ({ runId, requestId }) =>
  runMutationCommand({ operation: "run-stop", run: runId, args: { runId } }, requestId, (env, id) =>
    Effect.flatMap(cliDoor(env), (door) =>
      controlRun(env, { door, runId, control: "stop", set: true, request: id }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Stop a Run where it is, and its agents with it; its workspace stays for the resume",
  ),
);

const holdTaskFlag = Flag.String("task").pipe(
  Flag.withDescription("Hold every unfinished Run of this Task, by its id, instead of one Run"),
  Flag.optional,
);

const holdTask = Effect.fn("run.holdTask")(function* (
  env: PluginEnv,
  id: string,
  request: string,
  reason: string | undefined,
) {
  const task = Option.getOrNull(Arr.findFirst(yield* hostTasks(env), (one) => one.id === id));
  if (task === null) {
    return err("task_not_found", `Task "${id}" was not found.`, { task: id });
  }
  const runs = Arr.filter((yield* runViews(env, task.id)).runs, (view) => !isSettled(view));
  const held: Array<string> = [];
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
    if (done.ok) {
      held.push(view.runId);
    }
  }
  return {
    ok: true as const,
    data: { task: task.id, held },
    human: held.length === 0 ? "Nothing here is running." : `Held ${Arr.join(held, ", ")}.`,
  };
});

const runHold = Command.make(
  "hold",
  {
    runId: runIdArg.pipe(Argument.optional),
    task: holdTaskFlag,
    before: Flag.String("before").pipe(Flag.optional),
    reason: Flag.String("reason").pipe(
      Flag.withDescription("Why, in your own words, which the board's drawer shows"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ runId, task, reason, before, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      const why = Option.getOrUndefined(reason);
      const where = Option.getOrNull(task);
      const id = Option.getOrNull(runId);
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          if (where !== null) {
            if (Option.isSome(before)) {
              return err("invalid_input", "--before names one Run's Step; give its Run id");
            }
            return yield* mutation(
              resolved.env,
              { operation: "run-hold-task", run: null, args: { task: where, reason: why ?? null } },
              requestId,
              (request) => holdTask(resolved.env, where, request, why),
            );
          }
          if (id === null) {
            return err(
              "invalid_input",
              "`run hold` takes a Run's id, or `--task <id>` for every Run of one.",
            );
          }
          return yield* mutation(
            resolved.env,
            {
              operation: "run-hold",
              run: id,
              args: {
                runId: id,
                reason: why ?? null,
                before: Option.getOrNull(before),
              },
            },
            requestId,
            (request) =>
              Effect.gen(function* () {
                if (!(yield* anyRuns(resolved.env))) {
                  return err("run_not_found", `Run "${id}" was not found.`, { run: id });
                }
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
    runMutationCommand(
      {
        operation: "run-release",
        run: runId,
        args: { runId, before: Option.getOrNull(before) },
      },
      requestId,
      (env, id) =>
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
    runMutationCommand(
      { operation: "run-clear-override", run: runId, args: { runId, agent } },
      requestId,
      (env, id) =>
        Effect.gen(function* () {
          const result = yield* asksRun(
            env,
            runId,
            (client) => client.clearOverride({ runId, agent, request: id }),
            yield* cliDoor(env),
          );
          if (!result.ok) {
            return result;
          }
          return yield* Schema.decodeUnknownEffect(ResultBoundary)(result.value).pipe(Effect.orDie);
        }),
    ),
).pipe(
  Command.withDescription("Let Collie correct an agent again after someone typed into its pane"),
);

const runDisposition = Command.make(
  "disposition",
  {
    runId: runIdArg,
    as: Flag.Literals("as", ["merged", "abandoned", "superseded"]).pipe(
      Flag.withDescription("Record what became of the work; without it, this only reads"),
      Flag.optional,
    ),
    ref: Flag.String("ref").pipe(
      Flag.withDescription(
        "The merge request it is about, or what backs it up: a commit, or the Run that took it",
      ),
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
          if (resolved._tag === "RunFailure") {
            return resolved.result;
          }
          const facts = runFacts(resolved);
          const status = statusOf(resolved.view);
          const kind = Option.getOrNull(as);
          if (kind === null) {
            const records = yield* asksRun(resolved.env, runId, (client) =>
              client.runDispositions({ runId }),
            );
            if (!records.ok) {
              return records;
            }
            const lines = records.value;
            return {
              ok: true,
              data: { run: facts.id, status, disposition: latest(lines), lines },
              human: statusLine(status, latest(lines)),
            };
          }
          return yield* mutation(
            resolved.env,
            {
              operation: "run-disposition",
              run: facts.id,
              args: { runId: facts.id, as: kind, ref, note: Option.getOrNull(note) },
            },
            requestId,
            (id) =>
              Effect.gen(function* () {
                const done = yield* disposeRun(resolved.env, {
                  door: yield* cliDoor(resolved.env),
                  runId: facts.id,
                  kind,
                  ref,
                  note: Option.getOrNull(note),
                  request: id,
                });
                if (!done.ok) {
                  return done;
                }
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

const findingLine = (finding: {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly severity: string;
  readonly title: string;
}) =>
  `${finding.id} ${finding.status}${finding.reason === null ? "" : ` — ${finding.reason}`} (${finding.severity}) ${finding.title}`;

const runFindings = Command.make("findings", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") {
          return resolved.result;
        }
        const facts = runFacts(resolved);
        const read = yield* asksRun(resolved.env, runId, (client) => client.runFindings({ runId }));
        if (!read.ok) {
          return read;
        }
        const findings = read.value;
        return {
          ok: true,
          data: { run: facts.id, findings },
          human:
            findings.length === 0
              ? `${facts.id} left no findings.`
              : Arr.join(Arr.map(findings, findingLine), "\n"),
        };
      }),
      global.json,
    );
  }),
).pipe(Command.withDescription("Every finding a Run left, with the status it has now"));

const runFinding = Command.make(
  "finding",
  {
    runId: runIdArg,
    id: Argument.String("id").pipe(
      Argument.withDescription("The finding's id, as `run findings` lists it"),
    ),
    dismiss: Flag.String("dismiss").pipe(
      Flag.withDescription("Why it is dismissed; required, and never blank"),
      Flag.optional,
    ),
    reopen: Flag.Boolean("reopen").pipe(
      Flag.withDescription("Take a dismissal back, so the finding is open again"),
      Flag.withDefault(false),
    ),
    requestId: requestIdFlag,
  },
  ({ runId, id, dismiss, reopen, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") {
            return resolved.result;
          }
          const facts = runFacts(resolved);
          const why = Option.getOrNull(dismiss);
          if (reopen === (why !== null)) {
            return err("invalid_input", "Give exactly one of --dismiss <reason> and --reopen.");
          }
          if (why !== null && Str.trim(why) === "") {
            return err("invalid_input", "--dismiss needs a reason of its own.");
          }
          const status = why === null ? "open" : "dismissed";
          return yield* mutation(
            resolved.env,
            {
              operation: "run-finding",
              run: facts.id,
              args: { runId: facts.id, id, status, reason: why ?? null },
            },
            requestId,
            (request) =>
              Effect.gen(function* () {
                const set = yield* setFindingRun(resolved.env, {
                  door: yield* cliDoor(resolved.env),
                  runId: facts.id,
                  id,
                  status,
                  reason: why,
                  request,
                });
                if (!set.ok) {
                  return set;
                }
                return {
                  ok: true,
                  data: { run: facts.id, finding: set.value },
                  human: `${set.value.id} ${set.value.status}${set.value.reason === null ? "" : ` — ${set.value.reason}`}`,
                };
              }),
          );
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription("Set one finding's status: dismissed with its reason, or open again"),
);

const runSeen = Command.make(
  "seen",
  { runId: runIdArg, requestId: requestIdFlag },
  ({ runId, requestId }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* resolveCommandRun(global, runId);
          if (resolved._tag === "RunFailure") {
            return resolved.result;
          }
          const facts = runFacts(resolved);
          return yield* mutation(
            resolved.env,
            { operation: "run-seen", run: facts.id, args: { runId: facts.id } },
            requestId,
            (id) =>
              Effect.gen(function* () {
                const done = yield* seeRun(resolved.env, {
                  door: yield* cliDoor(resolved.env),
                  runId: facts.id,
                  request: id,
                });
                if (!done.ok) {
                  return done;
                }
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
        if (resolved._tag === "RunFailure") {
          return resolved.result;
        }
        const records = yield* asksRun(resolved.env, runId, (client) => client.runDrift({ runId }));
        if (!records.ok) {
          return records;
        }
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
                // WARNING: a judgement nobody could make is worth saying; the alternative is a Run that looks clean because nothing looked at it.
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
        if (resolved._tag === "RunFailure") {
          return resolved.result;
        }
        const records = yield* asksRun(resolved.env, runId, (client) => client.runCards({ runId }));
        if (!records.ok) {
          return records;
        }
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

const runActions = Command.make("actions", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
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
  ({ runId, offer, input, attach, requestId }) => {
    const inputs = inputPairs(input);
    return runMutationCommand(
      {
        operation: "run-action",
        run: runId,
        files: attach,
        args: { runId, offer, inputs },
      },
      requestId,
      (env, id) =>
        Effect.flatMap(Effect.zip(cliDoor(env), absolute(env, attach)), ([door, attachments]) =>
          invokeOffer(env, {
            attachments,
            door,
            runId,
            offer,
            input: inputs,
            request: id,
          }),
        ),
    );
  },
).pipe(Command.withDescription("Do one of the things this Run offers, if it still offers it"));

const RESUME_WORKSPACE =
  "--workspace only chose where this command looked; it does not move a Run. The Run resumes in its own checkout.";

const runResume = Command.make("resume", mutationFlags, ({ runId, requestId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
        return yield* mutation(
          resolved.env,
          { operation: "run-resume", run: runId, args: { runId } },
          requestId,
          (request) =>
            Effect.gen(function* () {
              const recovered = yield* resumeRun(resolved.env, {
                door: yield* cliDoor(resolved.env),
                runId,
                request,
              });
              if (Option.isNone(global.workspace) || !recovered.ok) {
                return recovered;
              }
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

function intentChange(
  operation: string,
  runId: string,
  requestId: Option.Option<string>,
  change: (intent: Intent) => Change | Failure,
  options: {
    readonly propagate?: boolean;
    readonly verification?: {
      readonly name: string;
      readonly command: Omit<VerifySpec, "name"> | null;
    };
  } = {},
) {
  return Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") {
          return resolved.result;
        }
        let wanted: typeof IntentChangeSchema.Type;
        if (options.verification !== undefined) {
          wanted = { kind: "verification", ...options.verification };
        } else {
          const current = yield* asksRun(resolved.env, runId, (client) =>
            client.runIntent({ runId }),
          );
          if (!current.ok) {
            return current;
          }
          if (current.value === null) {
            return err("invalid_state", `Run "${runId}" has no Intent to amend.`);
          }
          const chosen = change(current.value);
          if ("ok" in chosen) {
            return chosen;
          }
          wanted = chosen;
        }
        return yield* mutation(
          resolved.env,
          {
            operation,
            run: runId,
            args: { runId, change: wanted, propagate: options.propagate ?? false },
          },
          requestId,
          (request) =>
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
              if (!result.ok) {
                return result;
              }
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

function severityOf(value: string) {
  return value === "block" || value === "warn" ? value : null;
}

const intentShow = Command.make("show", { runId: runIdArg }, ({ runId }) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* resolveCommandRun(global, runId);
        if (resolved._tag === "RunFailure") {
          return resolved.result;
        }
        const records = yield* asksRun(resolved.env, runId, (client) =>
          client.runIntent({ runId }),
        );
        if (!records.ok) {
          return records;
        }
        const intent = records.value;
        if (intent === null) {
          return err("invalid_state", `Run "${runId}" has no Intent.`);
        }
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
        if (level === null) {
          return err("invalid_input", `--severity is block or warn.`);
        }
        const constraint = parseConstraint(text, level);
        if ("error" in constraint) {
          return err("invalid_input", constraint.error);
        }
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

// WARNING: the wrapper is part of the check: bun test and bun test --bail are two different checks.
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
    if (!remove && granted === null) {
      return Effect.gen(function* () {
        const global = yield* root;
        yield* printResult(missing, global.json);
      });
    }
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
          if (resolved._tag === "RunFailure") {
            return resolved.result;
          }
          return yield* mutation(
            resolved.env,
            { operation: "run-intent-remember", run: runId, args: { runId, replace } },
            requestId,
            (request) =>
              Effect.gen(function* () {
                const result = yield* asksRun(
                  resolved.env,
                  runId,
                  (client) => client.rememberVerification({ runId, replace, request }),
                  yield* cliDoor(resolved.env),
                );
                return result.ok
                  ? yield* Schema.decodeUnknownEffect(ResultBoundary)(result.value).pipe(
                      Effect.orDie,
                    )
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

const defaultsFile = Effect.fn("run.defaultsFile")(function* (env: PluginEnv) {
  return yield* defaultsPath(env.stateDir, scopeKey(scopeFor(env.cwd)));
});

function defaultsCommand(
  operation: string,
  args: Schema.Json,
  requestId: Option.Option<string>,
  change: (defaults: Defaults) => Defaults | Failure,
) {
  return mutating({ operation, run: null, destination: "cwd", args }, requestId, (env) =>
    Effect.gen(function* () {
      const file = yield* defaultsFile(env);
      const current = (yield* readDefaults(file)) ?? EMPTY_DEFAULTS;
      const next = change(current);
      if ("ok" in next) {
        return next;
      }
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
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
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
    defaultsCommand("run-intent-defaults-add", { text, severity }, requestId, (defaults) => {
      const level = severityOf(severity);
      if (level === null) {
        return err("invalid_input", `--severity is block or warn.`);
      }
      const parsed = parseConstraint(text, level);
      if ("error" in parsed) {
        return err("invalid_input", parsed.error);
      }
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
    defaultsCommand("run-intent-defaults-remove", { id }, requestId, (defaults) => ({
      ...defaults,
      constraints: Arr.filter(defaults.constraints, (c) => c.id !== id),
    })),
).pipe(Command.withDescription("Remove a constraint from this workspace's defaults"));

const defaultsAuthority = Command.make(
  "set-authority",
  { pairs: authorityArgs, requestId: requestIdFlag },
  ({ pairs, requestId }) =>
    defaultsCommand(
      "run-intent-defaults-authority",
      { patch: authorityPatch(pairs) },
      requestId,
      (defaults) => {
        const patch = authorityPatch(pairs);
        if ("error" in patch) {
          return err("invalid_input", patch.error);
        }
        return { ...defaults, authority: { ...defaults.authority, ...patch } };
      },
    ),
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

const artefactResult = (read: {
  readonly runId: string;
  readonly id?: string;
  readonly revision?: number;
  readonly offset?: number;
  readonly op: string;
  readonly requestId?: Option.Option<string>;
  readonly registration?: RegisterArtefact;
  readonly metadata?: string;
  readonly upload?: boolean;
}) =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") {
          return resolved.result;
        }
        const runId = read.runId;
        const door = yield* cliDoor(resolved.env);
        if (read.registration !== undefined) {
          const metadata =
            read.metadata === undefined
              ? Option.some(undefined)
              : Schema.decodeOption(Schema.fromJsonString(Schema.Json))(read.metadata);
          if (Option.isNone(metadata)) {
            return err("invalid_input", "--metadata is not JSON");
          }
          const input = { ...read.registration, metadata: metadata.value };
          const path = input.path;
          const uploaded = read.upload === true ? path : undefined;
          const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
          const pathSvc = yield* Path.Path;
          return yield* mutation(
            resolved.env,
            {
              operation: "artefact-register",
              run: runId,
              files: uploaded === undefined ? [] : [uploaded],
              args: {
                registration:
                  uploaded === undefined
                    ? read.registration
                    : { ...read.registration, path: undefined, snapshot: true },
                metadata: metadata.value ?? null,
                upload: uploaded !== undefined,
              },
            },
            read.requestId ?? Option.none(),
            (request) =>
              asksArtefactRun(
                resolved.env,
                runId,
                (client, runId) =>
                  withArtefacts(
                    client.board(),
                    Effect.gen(function* () {
                      const sent =
                        uploaded === undefined
                          ? {}
                          : {
                              path: yield* uploadArtefact(
                                client,
                                pathSvc.resolve(resolved.env.cwd, uploaded),
                              ),
                              snapshot: true,
                            };
                      return yield* client.artefactRegister({ runId, request, ...input, ...sent });
                    }).pipe(Effect.provideContext(files)),
                  ),
                door,
              ).pipe(
                Effect.map((answer) =>
                  answer.ok
                    ? {
                        ok: true as const,
                        data: answer.value,
                        human: Schemaflow(
                          Schema.encodeResult(PrettyUnknownJson),
                          SchemaResult.getOrThrow,
                        )(answer.value),
                      }
                    : answer,
                ),
              ),
          );
        }
        if (read.op === "seen" || read.op === "unseen") {
          return yield* mutation(
            resolved.env,
            {
              operation: "artefact-seen",
              run: runId,
              args: {
                runId,
                id: read.id ?? null,
                revision: read.op === "unseen" ? null : (read.revision ?? null),
                op: read.op,
              },
            },
            read.requestId ?? Option.none(),
            (request) =>
              asksArtefactRun(
                resolved.env,
                runId,
                (client, runId) =>
                  withArtefacts(
                    client.board(),
                    client.artefactSeen({
                      runId,
                      id: read.id!,
                      revision: read.op === "unseen" ? null : read.revision!,
                      request,
                    }),
                  ),
                door,
              ).pipe(
                Effect.map((answer) =>
                  answer.ok
                    ? {
                        ok: true as const,
                        data: answer.value,
                        human: Schemaflow(
                          Schema.encodeResult(PrettyUnknownJson),
                          SchemaResult.getOrThrow,
                        )(answer.value),
                      }
                    : answer,
                ),
              ),
          );
        }
        if (read.op === "read") {
          const answer = yield* asksArtefactRun(
            resolved.env,
            runId,
            (client, runId) =>
              withArtefacts(
                client.board(),
                client.artefactRead({
                  runId,
                  id: read.id!,
                  revision: read.revision!,
                  offset: read.offset ?? 0,
                }),
              ),
            door,
          );
          return answer.ok
            ? {
                ok: true as const,
                data: answer.value,
                human: Schemaflow(
                  Schema.encodeResult(PrettyUnknownJson),
                  SchemaResult.getOrThrow,
                )(answer.value),
              }
            : answer;
        }
        const answer = yield* asksArtefactRun(
          resolved.env,
          runId,
          (client, runId) =>
            withArtefacts(
              client.board(),
              client.artefacts({ runId, refresh: read.op === "refresh" }),
            ),
          door,
        );
        if (!answer.ok) {
          return answer;
        }
        const item =
          read.id === undefined
            ? answer.value
            : Option.getOrUndefined(Arr.findFirst(answer.value.items, (one) => one.id === read.id));
        return item === undefined
          ? err("invalid_input", "No such artefact")
          : {
              ok: true as const,
              data: item,
              human: Schemaflow(
                Schema.encodeResult(PrettyUnknownJson),
                SchemaResult.getOrThrow,
              )(item),
            };
      }),
      global.json,
    );
  });
const runArtefacts = Command.make("artefacts", { runId: runIdArg }, ({ runId }) =>
  artefactResult({ runId, op: "list" }),
);
const artefactId = Argument.String("id");

const searchText = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);
export const artefacts = Command.make(
  "artefacts",
  {
    query: searchText(
      "query",
      "Words in a title, description, URL or source path; not file contents",
    ),
    run: searchText("run", "One Run: its id, or <installation>:<run> or <machine>:<run>"),
    kind: searchText("kind", "file, link, claude-artefact, codex-site or a kind of your own"),
    role: searchText("role", "input, deliverable, plan, evidence or handoff"),
    unseen: Flag.Boolean("unseen").pipe(
      Flag.withDescription("Only what has a revision not yet seen"),
      Flag.withDefault(false),
    ),
    cursor: searchText("cursor", "The next page, as the last page's next said"),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("At most this many, up to 200"),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") {
            return resolved.result;
          }
          const found = yield* flockArtefacts(resolved.env, {
            ...Rec.map(
              {
                query: flags.query,
                run: flags.run,
                kind: flags.kind,
                role: flags.role,
                cursor: flags.cursor,
              },
              Option.getOrUndefined,
            ),
            limit: Option.getOrUndefined(flags.limit),
            unseen: flags.unseen,
          }).pipe(Effect.result);
          if (found._tag === "Failure") {
            return found.failure._tag === "AmbiguousRun"
              ? err("invalid_input", found.failure.message, {
                  run: found.failure.run,
                  candidates: found.failure.candidates,
                })
              : err("invalid_input", found.failure.reason);
          }
          const page = found.success;
          return {
            ok: true,
            data: page,
            human:
              Arr.join(
                [
                  ...Arr.map(
                    page.items,
                    ({ machine, item }) =>
                      `${item.title}\t${machine}:${item.run}\t${item.kind}\t${item.role}\trevision ${item.revision}\t${item.seen !== null && item.seen.revision >= item.revision ? "seen" : "unseen"}\t${item.id}`,
                  ),
                  ...Arr.flatMap(page.machines, (one) =>
                    one.state !== "searched"
                      ? [`${one.machine}: not searched, ${one.reason}`]
                      : one.indexed < one.runs
                        ? [`${one.machine}: ${one.indexed} of ${one.runs} Runs indexed so far`]
                        : [],
                  ),
                  ...(page.next === null ? [] : [`More: --cursor ${page.next}`]),
                ],
                "\n",
              ) || "No artefacts found.",
          };
        }),
        global.json,
      );
    }),
).pipe(
  Command.withDescription(
    "Find retained material across Runs and Machines without marking it seen",
  ),
);
const revisionFlag = Flag.Int("revision");
const runArtefact = Command.make("artefact").pipe(
  Command.withSubcommands([
    Command.make(
      "register",
      {
        runId: runIdArg,
        path: Flag.String("path").pipe(
          Flag.withDescription(
            "The file, on the Machine running this command with --upload, else on the Run's Machine; with --url, its retained export",
          ),
          Flag.optional,
        ),
        url: Flag.String("url").pipe(
          Flag.withDescription("An http or https destination: a link, Claude artefact or Site"),
          Flag.optional,
        ),
        id: Flag.String("id").pipe(
          Flag.withDescription("Retarget this artefact instead of registering a new one"),
          Flag.optional,
        ),
        title: Flag.String("title").pipe(Flag.optional),
        kind: Flag.String("kind").pipe(
          Flag.withDescription(
            "file, asset, link, claude-artefact, codex-site or a namespaced kind of your own",
          ),
          Flag.optional,
        ),
        role: Flag.String("role").pipe(Flag.optional),
        description: Flag.String("description").pipe(Flag.optional),
        provider: Flag.String("provider").pipe(
          Flag.withDescription("Who hosts the resource, such as claude or codex-sites"),
          Flag.optional,
        ),
        namespace: Flag.String("namespace").pipe(
          Flag.withDescription("The provider account or workspace the resource belongs to"),
          Flag.optional,
        ),
        resource: Flag.String("resource").pipe(
          Flag.withDescription(
            "The provider's id for it, such as an artefact id or Site project id",
          ),
          Flag.optional,
        ),
        version: Flag.String("version").pipe(
          Flag.withDescription("The version the provider returned, reported as such"),
          Flag.optional,
        ),
        metadata: Flag.String("metadata").pipe(
          Flag.withDescription("Up to 16 KiB of JSON kept with the artefact as data"),
          Flag.optional,
        ),
        created: Flag.String("created").pipe(Flag.optional),
        updated: Flag.String("updated").pipe(Flag.optional),
        snapshot: Flag.Boolean("snapshot").pipe(
          Flag.withDescription("Retain this copy only; do not track later changes to the source"),
          Flag.optional,
        ),
        upload: Flag.Boolean("upload").pipe(
          Flag.withDescription(
            "Send the file from this Machine to the Run's, as a retained snapshot",
          ),
          Flag.withDefault(false),
        ),
        requestId: requestIdFlag,
      },
      ({
        runId,
        requestId,
        upload,
        snapshot,
        metadata,
        provider,
        namespace,
        resource,
        version,
        ...given
      }) =>
        artefactResult({
          runId,
          requestId,
          upload,
          op: "register",
          metadata: Option.getOrUndefined(metadata),
          registration: {
            ...Rec.map(given, Option.getOrUndefined),
            snapshot: Option.getOrUndefined(snapshot),
            provider: Option.getOrUndefined(
              Option.map(provider, (name) => ({
                name,
                namespace: Option.getOrUndefined(namespace),
                resource: Option.getOrUndefined(resource),
                version: Option.getOrUndefined(version),
              })),
            ),
          },
        }),
    ),
    Command.make("show", { runId: runIdArg, id: artefactId }, (args) =>
      artefactResult({ ...args, op: "show" }),
    ),
    Command.make(
      "read",
      {
        runId: runIdArg,
        id: artefactId,
        revision: revisionFlag,
        offset: Flag.Int("offset").pipe(Flag.withDefault(0)),
      },
      (args) => artefactResult({ ...args, op: "read" }),
    ),
    Command.make("refresh", { runId: runIdArg }, (args) =>
      artefactResult({ ...args, op: "refresh" }),
    ),
    Command.make(
      "seen",
      { runId: runIdArg, id: artefactId, revision: revisionFlag, requestId: requestIdFlag },
      (args) => artefactResult({ ...args, op: "seen" }),
    ),
    Command.make("unseen", { runId: runIdArg, id: artefactId, requestId: requestIdFlag }, (args) =>
      artefactResult({ ...args, op: "unseen" }),
    ),
  ]),
);

export const run = Command.make("run").pipe(
  Command.withDescription("Start Runs and follow, answer, stop or resume them"),
  Command.withSubcommands([
    runStart,
    runPublish,
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
    runFindings,
    runFinding,
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
    runRead,
    runArtefacts,
    runArtefact,
  ]),
);
