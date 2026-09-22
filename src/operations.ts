// What starting, answering, stopping and resuming a Run actually does. Both the CLI
// and the Herdr adapters call these; neither owns the behaviour, so a pane and a
// command cannot drift apart. What stays with each of them is presentation: picking,
// prompting, rendering, and turning a result into text or JSON.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Config, Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { atClock, nowIso, untilFrom } from "./time";
import { diffTargetOf, recorded } from "./strategies";
import { attentionFor } from "./attention";
import type { PluginEnv } from "./env";
import {
  Herdr,
  herdrFailureReason,
  type AgentInfo,
  type PaneInfo,
  type StartedTab,
  type TabInfo,
  type WorkspaceInfo,
} from "./herdr";
import { loadDefaults } from "./config";
import { DefinitionError, layers, loadDefinitions, skillDirs } from "./definitions";
import { carryOutProposal } from "./run-actions";
// Carrying an action out belongs to `run-actions`, which asks the host; it is re-exported
// here so a front door still has one import for "what a human asked Collie to do".
export { carryOutAsked, carryOutProposal, registerRunExecutors } from "./run-actions";
import { approvedFrom } from "./verify-spec";
import { REQUESTABLE, isOutcome } from "./outcome";
import { latest, readDispositions } from "./disposition";
import { fixableRun } from "./workspace";
import { SELF, declaredIn, inputsFor, offersFrom, type OfferFacts } from "./offers";
import { ownerOf } from "./history";
import { postNote, shell, type Runner } from "./mr";
import {
  classifyGivenTarget,
  classifyWorkSource,
  inferInputs,
  inputSources,
  inputStrategies,
  inputValues,
  settle,
  type Resolution,
} from "./inputs";
import { readRegistry, registryPath, scopeFor, scopeKey, scopeOfRun } from "./registry";
import { newTask, writeTask, type TaskChoice, type TaskRecord } from "./task";
import { nameTask, type LiveNames, type NamingDeps, type TaskContext } from "./tasknames";
import {
  amend as amendIntent,
  constraintId,
  propagate,
  defaultsPath,
  describeDefaults,
  EMPTY_DEFAULTS,
  fromWorkSource,
  parseConstraint,
  readDefaults,
  writeDefaults,
  readIntent,
  seedIntent,
  writeIntent,
  writeIntentHeld,
  type Authority,
  type Constraint,
  type Intent,
} from "./intent";
import { currentPid, withLock } from "./lock";
import {
  appendLine,
  budgetPath,
  ledgerPath,
  overrideActive,
  readLedger,
  herdOf,
  reserve,
  settle as settleBudget,
} from "./steering";
import { append, conversationPath, tail, type NewTurn } from "./conversation";
import {
  evaluate,
  validate,
  type Action,
  type CallLimits as EvaluatorLimits,
  type EvaluatorDeps,
  type Validated,
} from "./evaluator";
import {
  actorName,
  admit,
  confirm as confirmProposal,
  decline,
  proposalsPath,
  read as readProposals,
  record as recordProposal,
  type Recorded,
  stepSettled,
  stepStarted,
  type Actor,
  type ProposalRecord,
} from "./proposals";
import { openReports, readDrift } from "./drift";
import { readCards } from "./cards";
import { describeAction } from "./lines";
import { fingerprint } from "./verify";
import { entryFromLive, interrupt, MAX_DELIVERY_BYTES, transaction } from "./dispatcher";
import { executorFor, registerExecutor, registeredKinds, type ExecutionResult } from "./executors";
import type { CollieError } from "./envelope";
import { REVIEW_FILE } from "./output";
import {
  fanoutRepos,
  fanoutUnfinished,
  runningAgents,
  Run,
  RunStore,
  withRunLock,
  type RunRecord,
  type WorktreeRecord,
} from "./run";
import { taskWorkspaceLabel } from "./naming";
import { branchListed, checkoutFor, pruneWorktrees, runNames } from "./worktree";
import { closable, isHomeDirectory } from "./home";
import { probeHelle, probeLinearMcp } from "./optional";
import { forkResolvedDefinition } from "./fork";
import { YamlMapSchema, type YamlMap } from "./yaml";

const ErrorCode = Schema.Literals([
  "workspace_required",
  "workspace_not_found",
  "task_not_found",
  "workflow_not_found",
  "persona_not_found",
  "run_not_found",
  "run_already_active",
  "run_not_waiting",
  "invalid_answer",
  "choice_already_answered",
  "choice_mismatch",
  "target_exists",
  "needs_input",
  "timeout",
  "invalid_state",
  /** The workflow a Run recorded is not the workflow its layers resolve to now. */
  "definition_changed",
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
export type OpResult =
  | {
      ok: true;
      data: object;
      human: string;
    }
  | Failure;

export const err = (
  code: ExpectedError["code"],
  message: string,
  details: YamlMap = {},
): Failure => ({ ok: false, error: ExpectedError.make({ code, message, details }) });

const ok = <A extends object>(data: A, human: string): OpResult => ({
  ok: true,
  data,
  human,
});

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
  if (run.record.awaiting) return "waiting";
  if (run.record.status === "done") return "succeeded";
  return run.record.status === "running" ? "running" : "failed";
});

/**
 * Whether that state is the end of the Run. `waiting` is not: a Run stopped at a
 * question is still going, and a `run wait` that returned on it would be reporting a
 * Run as over while its Driver holds the menu open.
 *
 * Here beside `runStatus` because it is the same fact: the CLI's wait, the engine's
 * wait on a Repo run and a stop's look at a parent's children each used to spell the
 * three names out again, which is three places to miss a fourth.
 */
export function runSettled(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

/** The live workspace for this environment, shared by both adapters. */
export const resolveWorkspace = Effect.fn("operations.resolveWorkspace")(function* (
  herdr: Herdr,
  env: PluginEnv,
) {
  if (!env.workspaceId) return null;
  const workspace =
    (yield* herdr.workspaceList()).find((item) => item.workspaceId === env.workspaceId) ?? null;
  if (!workspace || workspace.cwd !== "") return workspace;
  // `herdr workspace list` carries no directory, so a workspace resolved by id alone
  // would fall back to the caller's own cwd — and a `--workspace` run would root at
  // whatever shell it was typed in. The workspace's directory is where its panes are.
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  return { ...workspace, cwd: workspaceCwdFromPanes(env.workspaceId, panes) };
});

/**
 * The workspace a request named, resolved to one this herdr actually has — by id, by the
 * label a human would say, or by the directory it stands for. `null` is a request that
 * named none. An error is a name that matches nothing or more than one thing: a launch
 * aimed at a guess is a Run in a repository nobody asked for.
 *
 * A directory nothing is open on is opened: the human naming a checkout has said which
 * repository they mean, and sending them to the board to open it first is chat obstructing
 * the person it serves (ADR-0011).
 */
export const workspaceNamed = Effect.fn("operations.workspaceNamed")(function* (
  env: PluginEnv,
  named: string | undefined,
): Effect.fn.Return<WorkspaceNamed, never, BunServices> {
  if (named === undefined || named.trim() === "") return null;
  const herdr = new Herdr(env);
  const all = yield* herdr.workspaceList().pipe(Effect.catch(() => Effect.succeed([])));
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const wanted = named.trim();
  const byId = all.filter((workspace) => workspace.workspaceId === wanted);
  const matched =
    byId.length > 0
      ? byId
      : all.filter((workspace) => workspace.label.toLowerCase() === wanted.toLowerCase());
  const refused = (error: string): WorkspaceNamed => ({ error });
  if (matched.length === 0) {
    const opened = yield* workspaceForDirectory(env, wanted, all, panes);
    if (opened !== null) return opened;
    return refused(`no workspace "${named}"; ${all.map((w) => w.label).join(", ") || "none"}`);
  }
  if (matched.length > 1)
    return refused(
      `"${named}" names ${matched.length} workspaces (${matched
        .map((w) => w.workspaceId)
        .join(", ")}); say which`,
    );
  const workspace = matched[0]!;
  const cwd =
    workspace.cwd !== "" ? workspace.cwd : workspaceCwdFromPanes(workspace.workspaceId, panes);
  if (cwd === "") return refused(`workspace "${named}" has no directory to run in`);
  return { found: { ...workspace, cwd } };
});

/**
 * A name that is a directory, as the workspace standing for it: the one already on that
 * checkout, or a new one opened there. `null` is a name that is not a directory at all,
 * which is the caller's "matches nothing".
 */
const workspaceForDirectory = Effect.fn("operations.workspaceForDirectory")(function* (
  env: PluginEnv,
  named: string,
  all: ReadonlyArray<WorkspaceInfo>,
  panes: ReadonlyArray<Pick<PaneInfo, "workspaceId" | "cwd">>,
): Effect.fn.Return<WorkspaceNamed, never, BunServices> {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const expanded = named.startsWith("~/") ? path.join(env.home, named.slice(2)) : named;
  const dir = path.resolve(env.cwd, expanded);
  const isDir = yield* fs
    .stat(dir)
    .pipe(Effect.map((info) => info.type === "Directory"))
    .pipe(Effect.catch(() => Effect.succeed(false)));
  if (!isDir) return null;
  const already = all.find(
    (workspace) =>
      (workspace.cwd !== ""
        ? workspace.cwd
        : workspaceCwdFromPanes(workspace.workspaceId, panes)) === dir,
  );
  if (already) return { found: { ...already, cwd: dir } };
  // No workspace is opened for it: a fresh Run gets a task workspace of its own whatever
  // it was launched from, so one opened here only to root the launch is left behind
  // empty beside the Run's. The checkout roots the launch; the caller's workspace is
  // where it was launched from.
  return {
    found: {
      workspaceId: env.workspaceId ?? "",
      label: path.basename(dir),
      cwd: dir,
      worktree: null,
      tokens: {},
    },
  };
});

/** A workspace a request named: the one it is, why it is not one, or none named. */
export type WorkspaceNamed = { found: WorkspaceInfo } | { error: string } | null;

/** The directory a workspace stands for: where its first pane was started. */
export function workspaceCwdFromPanes(
  workspaceId: string,
  panes: ReadonlyArray<Pick<PaneInfo, "workspaceId" | "cwd">>,
): string {
  return panes.find((pane) => pane.workspaceId === workspaceId && pane.cwd)?.cwd ?? "";
}

/**
 * Everything a start needs before anyone is asked anything: the Workflow resolved,
 * proven runnable, and its Inputs inferred. What fills the gaps afterwards — prompts
 * in a pane, flags on a command line — is the caller's business.
 */
export const upgrade = Effect.fn("operations.upgrade")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = (cmd, args, cwd) =>
    shell(cmd, args, cwd, "say"),
) {
  const root = env.pluginRoot;
  const head = () => run("git", ["rev-parse", "--short", "HEAD"], root).pipe(Effect.map(short));
  const checkout = (yield* run("git", ["rev-parse", "--git-dir"], root)).code === 0;

  let before = "";
  let after = "";
  if (checkout) {
    before = yield* head();
    // `--ff-only`: an upgrade that quietly merged or rebased someone's local work
    // would be a surprise nobody asked this command for.
    const pulled = yield* run("git", ["pull", "--ff-only"], root);
    if (pulled.code !== 0) {
      return err("operation_failed", `Could not update ${root}.`, {
        root,
        output: pulled.stdout.trim(),
      });
    }
    after = yield* head();
  }

  const installed = yield* run("sh", ["prepare.sh"], root);
  if (installed.code !== 0) {
    return err("operation_failed", `Could not prepare ${root}.`, {
      root,
      output: installed.stdout.trim(),
    });
  }

  const moved = checkout && before !== after;
  const steps = prepareSteps(installed.stdout);
  return {
    ok: true as const,
    data: { root, checkout, before, after, updated: moved, steps },
    human: [
      checkout
        ? moved
          ? `Updated ${root} from ${before} to ${after}.`
          : `${root} was already up to date at ${before}.`
        : `${root} is not a checkout, so the release was fetched.`,
      // What each preparation step did, rather than the install's own output: a
      // step that was skipped is the thing a reader most needs to see, and `bun
      // install` has a great deal to say about packages it did not have to touch.
      ...steps.map(
        (step) => `  ${step.step.padEnd(16)}${step.state}${step.detail ? ` — ${step.detail}` : ""}`,
      ),
    ].join("\n"),
  };
});

/**
 * What `prepare.sh` reported, one line per step. Anything else it printed — the
 * install's own output, a stack of npm notices — is not part of the answer.
 *
 * This is one half of a contract whose other half is a `printf` in a shell script,
 * so it is exported for the test that runs the real script and reads its output back
 * through here: a step line reworded on one side and not the other would otherwise
 * empty this report with nothing failing.
 */
const PREPARE_LINE = /^prepare: ([a-z-]+): (done|already in place|skipped|failed)(?: — (.*))?$/;

export function prepareSteps(
  output: string,
): Array<{ step: string; state: string; detail: string }> {
  return output.split("\n").flatMap((line) => {
    const match = PREPARE_LINE.exec(line.trim());
    return match ? [{ step: match[1]!, state: match[2]!, detail: match[3] ?? "" }] : [];
  });
}

/** `git rev-parse` prints one line; anything else means it did not answer. */
function short(result: { code: number; stdout: string }): string {
  return result.code === 0 ? result.stdout.trim() : "";
}

/**
 * What this Run is named after: its first settled Input, both ways round. `value` is
 * what the caller gave, whole. `short` is the name to show — a path value would put the
 * whole path on a tab, so a strategy may offer something shorter — and it is only ever
 * that, because a label is cut to fit a menu and says so to nobody. A length cap is
 * judged against `value`, which is what a chained Run's branch does with the parent's
 * recorded name.
 *
 * Exported for the test harness, which starts Runs without going through `startRun`
 * and had a second copy of this that quietly disagreed with it.
 *
 * Empty where no Input was settled at all: `architecture` declares none that name the
 * work. A stand-in like "run" would slug cleanly and so pass the very guard that exists
 * to stop two Runs keying one checkout — every such Run would be named the same thing.
 * `slugify` still has its own fallback for the tab, which is a label and not an identity.
 */
export function primaryName(resolutions: Resolution[]) {
  const first = resolutions.find((r) => r.value !== "");
  if (!first) return { value: "", short: "" };
  return { value: first.value, short: first.label ?? first.value };
}

/**
 * The names this person already has on their own workspaces, tabs and panes. Read-only,
 * and best effort: a herdr that will not answer costs the namer its vocabulary, not the
 * Run its start.
 */
const liveNames = Effect.fn("operations.liveNames")(function* (herdr: Herdr, everything: boolean) {
  const workspaces = yield* herdr
    .workspaceList()
    .pipe(Effect.catch(() => Effect.succeed<WorkspaceInfo[]>([])));
  // Tabs and panes are vocabulary for the namer alone. Without one to ask, they are two
  // herdr calls whose answer nothing would read.
  const [tabs, panes] = everything
    ? yield* Effect.all([
        herdr.tabList().pipe(Effect.catch(() => Effect.succeed<TabInfo[]>([]))),
        herdr.paneList().pipe(Effect.catch(() => Effect.succeed<PaneInfo[]>([]))),
      ])
    : [[], []];
  return {
    workspaces: workspaces.map((workspace) => workspace.label),
    tabs: tabs.map((tab) => tab.label),
    panes: panes.flatMap((pane) => (pane.label === null ? [] : [pane.label])),
  } satisfies LiveNames;
});

/**
 * What naming one Task may cost, or null where it cannot be asked at all: no Herd to
 * account the call against, or no frozen prompt in this build to ask with. The prompt is
 * the whole of what keeps the person's own labels data rather than instructions, so its
 * absence is a reason not to call rather than a reason to improvise one.
 *
 * A tighter clock than a steer's: somebody is waiting on this to see their workspace
 * open, and the stand-in name is already to hand.
 */
const namingDeps = Effect.fn("operations.namingDeps")(function* (env: PluginEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const herd = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (herd === null) return null;
  const systemPromptFile = path.join(env.pluginRoot, "prompts", "namer.md");
  if (!(yield* fs.exists(systemPromptFile).pipe(Effect.catch(() => Effect.succeed(false)))))
    return null;
  const evaluation = yield* evaluationDeps(env);
  const limits = { ...evaluation.limits, maxSeconds: 30, maxOutputBytes: 4 * 1024 };
  return {
    evaluator: { ...evaluation.evaluator, systemPromptFile, limits },
    budget: yield* budgetPath(env.stateDir, herd),
  } satisfies NamingDeps;
});

/**
 * What a fresh Task is called, worked out before its checkout: `workspace=new` has herdr
 * open the workspace itself, and a workspace can only be opened under a name that
 * already exists.
 */
const freshTaskLabel = Effect.fn("operations.freshTaskLabel")(function* (
  herdr: Herdr,
  env: PluginEnv,
  context: TaskContext,
) {
  const naming = yield* namingDeps(env);
  return taskWorkspaceLabel(
    yield* nameTask(naming, context, yield* liveNames(herdr, naming !== null)),
  );
});

/**
 * The Task a start belongs to, and the herdr workspace its Runs and agents live in.
 *
 * A fresh start gets a workspace of its own, whatever workspace it was launched from:
 * that is what keeps one human's several pieces of work from accumulating beside each
 * other. The exception is a checkout herdr already opened a workspace for, which is the
 * same thing by another route and is taken rather than duplicated — under the name herdr
 * reports for it, so the Task is called what that sidebar row is actually called.
 *
 * A continuation is given its Task, and goes where that Task already is. Membership is
 * the record, never the label: two Tasks may be called much the same thing, and a
 * workspace a human renamed is still the Task's.
 */
const taskFor = Effect.fn("operations.taskFor")(function* (
  herdr: Herdr,
  env: PluginEnv,
  choice: TaskChoice,
  opts: {
    /** What a fresh Task is called, worked out before the checkout that may use it. */
    readonly label: string;
    /** The workspace herdr opened for this Run's checkout, where it opened one. */
    readonly opened: { readonly id: string; readonly label: string | null } | null;
  },
) {
  const kept = (task: TaskRecord, launchPane: StartedTab | null = null) => ({
    _tag: "Ok" as const,
    task,
    launchPane,
  });
  const refuse = (message: string, cause: string) => ({
    _tag: "Rejected" as const,
    result: err("operation_failed", message, { cause }),
  });
  if (choice.mode === "continue") {
    // The Task's workspace has to still be there. Continuing into one herdr has closed
    // would put the Run's tabs and agents nowhere, which is worse than not starting.
    const open = yield* Effect.result(herdr.workspaceList());
    if (open._tag === "Failure")
      return refuse(
        `Task "${choice.task.id}" could not be checked: ${herdrFailureReason(open.failure)}`,
        herdrFailureReason(open.failure),
      );
    if (!open.success.some((workspace) => workspace.workspaceId === choice.task.workspace))
      return refuse(
        `Task "${choice.task.id}" has no workspace any more; start fresh or continue another.`,
        "workspace_closed",
      );
    yield* Effect.ignore(herdr.workspaceFocus(choice.task.workspace));
    return kept(choice.task);
  }
  // What herdr says the workspace is called wins over what it was asked to call it: a
  // workspace it opened rather than created keeps the name it already had.
  const label = opts.opened?.label ?? opts.label;
  let id = opts.opened?.id ?? null;
  // The shell tab a created workspace comes with, for the Run's first agent to take
  // over instead of leaving an empty "1" beside its own tabs.
  let launchPane: StartedTab | null = null;
  if (id === null) {
    const made = yield* Effect.result(herdr.workspaceCreate({ cwd: env.cwd, label }));
    if (made._tag === "Failure") {
      const cause = herdrFailureReason(made.failure);
      return refuse(`No workspace could be opened for this task: ${cause}`, cause);
    }
    id = made.success.workspaceId;
    launchPane = made.success.rootTab;
  }
  const task = yield* writeTask(
    env.stateDir,
    yield* newTask({ workspace: id, label, cwd: env.cwd }),
  );
  // Focused, not just created: a human who started work is taken to it.
  yield* Effect.ignore(herdr.workspaceFocus(id));
  return kept(task, launchPane);
});

/**
 * Creates the Run and hands it to a detached Driver. Inputs are already settled.
 * Returns an explicit started/rejected outcome so adapters cannot mistake a failure for a Run.
 */
export const clearOverride = Effect.fn("operations.clearOverride")(function* (
  stateDir: string,
  herdr: Herdr,
  runId: string,
  agent: string,
  /** Who is lifting it, as `actorName` writes it. Derived at the front door, never here. */
  by: string,
) {
  const live: AgentInfo[] = yield* herdr.agentList().pipe(Effect.catch(() => Effect.succeed([])));
  const terminalId = live.find((a) => a.name === agent)?.terminalId ?? null;
  if (terminalId === null)
    return err("invalid_state", `herdr has no live agent "${agent}" to clear an override on.`);
  const file = yield* ledgerPath(stateDir, terminalId);
  if (!overrideActive(yield* readLedger(file)))
    return err("invalid_state", `"${agent}" is not under a manual override.`);
  yield* appendLine(file, {
    kind: "override_cleared",
    at: yield* nowIso(),
    incarnation: terminalId,
    by,
  });
  return ok({ runId, agent }, `Cleared the manual override on ${agent}.`);
});

/** Saying no. The other half of a Confirmation, and filed in the same place. */
export const declineProposal = Effect.fn("operations.declineProposal")(function* (
  env: PluginEnv,
  proposalId: string,
  actor: Actor,
) {
  const file = yield* proposalsPath(env.stateDir, yield* herdOf(env.socketPath));
  const done = yield* decline(file, proposalId, actor);
  return done.refused === null
    ? { ok: true as const, data: { declined: proposalId }, human: `Declined ${proposalId}.` }
    : err("invalid_input", done.detail, { reason: done.refused });
});

/**
 * Carrying out a Confirmation: the one place a proposal's actions run, whichever front
 * door said yes. The front door derives who is asking and renders what came back; it does
 * not decide what is checked first, because a second copy of this loop is a second policy
 * on what a confirmed action is still allowed to assume.
 */
/**
 * Which live process each agent a delivery names is now. Recorded with the proposal so a
 * confirmation can refuse rather than deliver to whatever took that agent's name since.
 */
/**
 * A structured request from native chat, validated and executed in the same call.
 *
 * This is the whole of what chat may *do*, and it is deliberately the same path a steer
 * takes from the point the actions exist: the closed `ActionSchema`, `validate`, and the
 * proposals journal. What it does not do is ask a second model what the first one meant —
 * the native agent already expressed this structurally, and paying a model to re-read it
 * would be two interpretations of one request.
 *
 * The journal and stale-target checks are shared with optional proposals. Attribution
 * stays with the chat request; no terminal or second human confirmation is required.
 */
export const request = Effect.fn("operations.request")(function* (
  env: PluginEnv,
  herdKey: string,
  options: {
    readonly interpretation: string;
    readonly actions: ReadonlyArray<Action>;
    /** Who asked. Stamped by the entrypoint, never read out of the request. */
    readonly actor: Actor;
  },
) {
  if (options.actions.length === 0)
    return err("invalid_input", "A request with no actions changes nothing; say what to do.");
  const store = new RunStore(env.stateDir);
  const named = [...new Set(options.actions.flatMap((a) => ("run" in a ? [a.run] : [])))];
  const runs = new Map<string, Run>();
  for (const id of named) {
    const run = yield* store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
    // Refused, not retargeted. A Run nobody has is a request about nothing, and guessing
    // which one was meant is how an action lands on somebody else's work.
    if (run === null) return err("run_not_found", `No Run "${id}".`, { run: id });
    runs.set(id, run);
  }

  const intents = new Map<string, { version: number; authority: Authority }>();
  for (const [id, run] of runs) {
    const intent = yield* readIntent(run.dir).pipe(
      Effect.catch(() => Effect.succeed<Intent | "unreadable">("unreadable")),
    );
    if (intent === "unreadable")
      return err("invalid_state", `${id}'s Intent cannot be read; nothing was proposed.`);
    if (intent !== null) intents.set(id, { version: intent.version, authority: intent.authority });
  }

  const checked = validate(
    {
      interpretation: options.interpretation,
      targets: named.map((run) => ({ run })),
      actions: [...options.actions],
      confidence: 1,
    },
    {
      runs: new Set(runs.keys()),
      agents: new Map([...runs].map(([id, run]) => [id, new Set(runningAgents(run.record))])),
      intents,
      origin: "steer",
      maxDeliveryBytes: MAX_DELIVERY_BYTES,
    },
  );

  const file = yield* proposalsPath(env.stateDir, herdKey);
  const addressed = yield* incarnationsFor(env, checked);
  const proposal: Recorded = {
    interpretation: options.interpretation,
    targets: named.map((run) => ({ run })),
    actions: checked.map((entry) => entry.action),
    allowedNow: [],
    intentVersions: Object.fromEntries([...intents].map(([id, at]) => [id, at.version])),
    by: actorName(options.actor),
  };
  const recorded = yield* recordProposal(
    file,
    Object.keys(addressed).length === 0 ? proposal : { ...proposal, incarnations: addressed },
  );
  return yield* carryOutProposal(env, recorded.id, recorded.content_hash, options.actor);
});

const incarnationsFor = Effect.fn("operations.incarnationsFor")(function* (
  env: PluginEnv,
  checked: ReadonlyArray<Validated>,
) {
  const named = new Set(
    checked.flatMap((entry) =>
      "agent" in entry.action && entry.action.agent !== undefined ? [entry.action.agent] : [],
    ),
  );
  const found: Record<string, string> = {};
  if (named.size === 0) return found;
  const live = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
  for (const agent of named) {
    const terminalId = live.find((entry) => entry.name === agent)?.terminalId;
    if (terminalId !== undefined && terminalId !== null) found[agent] = terminalId;
  }
  return found;
});

/** The tree a card was written against, as the one string a confirmation compares. */
function revisionOf(revision: { readonly head_sha: string; readonly fingerprint: string }): string {
  return `${revision.head_sha}:${revision.fingerprint}`;
}

/**
 * The card a steer named, with the revision it was written against — or null when none was
 * named or no card has that id. Binding it is what lets a confirmation say `revision_moved`
 * instead of applying a decision about one tree to a different one (SPEC §7.6).
 */
const cardRevision = Effect.fn("operations.cardRevision")(function* (run: Run, id: string | null) {
  if (id === null) return null;
  const cards = yield* readCards(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
  const card = cards.find((entry) => entry.id === id);
  // A card nobody has is not an unbound proposal: the human asked about a specific piece
  // of work, and answering about the tree in general is answering a different question.
  return card === undefined ? "unknown" : { id, revision: revisionOf(card.revision) };
});

/**
 * What one evaluation is allowed to cost, and what it is asked with. Conservative: the
 * Herd's cap and the Run's own cap bound this again, and a front door never chooses its
 * own budget — a board and a terminal that disagreed about what Collie may spend would be
 * two policies wearing one name.
 */
export const steer = Effect.fn("operations.steer")(function* (
  env: PluginEnv,
  deps: {
    readonly herdKey: string;
    readonly evaluator: EvaluatorDeps;
    readonly limits: EvaluatorLimits;
  },
  options: {
    readonly text: string;
    /** The Run this is about. Required for anything that would change something. */
    readonly target?: string | null;
    readonly from?: string | null;
    readonly dryRun?: boolean;
    readonly requestId: string;
    /**
     * Who is asking. `event` is the board speaking first about something that changed;
     * the question is journaled as that, never as the human's words. It changes what the
     * conversation shows. Unsolicited event suggestions stay proposals.
     */
    readonly asked?: "human" | "event";
  },
) {
  const store = new RunStore(env.stateDir);
  const target = options.target ?? null;
  const run =
    target === null
      ? null
      : yield* store.load(target).pipe(Effect.catch(() => Effect.succeed(null)));
  // A steer is about one Run. A question about the flock is native chat's, which reads
  // the Herd rather than having a model asked one here — and a Run is never guessed at
  // from the words, so there is nothing to fall back to.
  if (target === null)
    return err("invalid_input", "Name the Run this is about with --target.", {
      code: "target_required",
    });
  if (run === null) return err("run_not_found", `No Run "${target}".`, { run: target });

  const journal = yield* conversationPath(env.stateDir, deps.herdKey);
  const roots = (yield* store.list()).map((r) => r.dir);
  const said: NewTurn = { role: options.asked ?? "human", text: options.text };
  yield* append(journal, { ...said, target }, roots);

  const from = options.from ?? null;
  const pack = yield* evidencePack(env, options.text, run, from, journal);

  // An Intent nobody can decode is not a Run with no constraints. Recorded as `{}`, the
  // proposal would skip the version gate at every later confirmation (SPEC §7.1). Read
  // before the call rather than after it: a Run whose Intent cannot be read is one no
  // proposal can be made about, and finding that out afterwards spends the money first.
  const intent = yield* readIntent(run.dir).pipe(
    Effect.catch(() => Effect.succeed<Intent | "unreadable">("unreadable")),
  );
  if (intent === "unreadable")
    return err("invalid_state", `${run.id}'s Intent cannot be read; nothing was proposed.`);

  // Written down as usage — the Herd's, and the Run's where there is one — before the
  // call and after it. Never refused over a count: usage is data, not a quota.
  const budget = yield* budgetPath(env.stateDir, deps.herdKey);
  const callId = yield* newRequestId();
  yield* reserve(budget, { id: callId, run: run.id }, deps.limits);

  const asked = yield* evaluate(deps.evaluator, "proposal", pack);
  // What the call did: a timeout and an output cap are their own facts, and this is the
  // only place either is written down. An unusable answer is `failed` — the call was not ok.
  yield* settleBudget(budget, callId, {
    outcome: asked.spent.outcome === "ok" && asked.error !== null ? "failed" : asked.spent.outcome,
    usd: asked.spent.usd,
    seconds: asked.spent.seconds,
    bytes: asked.spent.bytes,
  });
  if (asked.value === null)
    return err("operation_failed", `Collie could not answer: ${asked.error ?? "no answer"}.`);

  const proposed = asked.value;
  if (!("actions" in proposed))
    return err("operation_failed", "Collie answered a question nobody asked.");

  const checked = validate(proposed, {
    runs: new Set([run.id]),
    agents: new Map([[run.id, new Set(runningAgents(run.record))]]),
    intents: new Map(
      intent === null ? [] : [[run.id, { version: intent.version, authority: intent.authority }]],
    ),
    origin: "steer",
    maxDeliveryBytes: MAX_DELIVERY_BYTES,
  });

  if (options.dryRun)
    return ok(
      {
        preview: { interpretation: proposed.interpretation, actions: checked },
        requestId: options.requestId,
      },
      previewOf(proposed.interpretation, checked),
    );

  const file = yield* proposalsPath(env.stateDir, deps.herdKey);
  const bound = yield* cardRevision(run, from);
  if (bound === "unknown")
    return err("invalid_input", `Run ${run.id} has no card "${from}".`, { card: from ?? "" });
  const proposal: Recorded = {
    interpretation: proposed.interpretation,
    targets: [{ run: run.id }],
    actions: checked.map((entry) => entry.action),
    // A requested action is separate from the Driver's standing authority.
    allowedNow: [],
    intentVersions: intent === null ? {} : { [run.id]: intent.version },
    by: `evaluator:${callId}`,
  };
  const addressed = yield* incarnationsFor(env, checked);
  const withCard: Recorded = bound === null ? proposal : { ...proposal, card: bound };
  const recorded = yield* recordProposal(
    file,
    Object.keys(addressed).length === 0 ? withCard : { ...withCard, incarnations: addressed },
  );
  const reply: NewTurn = {
    role: "collie",
    text: proposed.interpretation,
    target: run.id,
    proposal: recorded.id,
    evaluatorCall: callId,
  };
  yield* append(journal, from === null ? reply : { ...reply, card: from }, roots);

  if (options.asked !== "event")
    return yield* carryOutProposal(env, recorded.id, recorded.content_hash, {
      origin: "cli",
      requestId: options.requestId,
    });

  const driver = yield* ownerOf(run.dir);
  return ok(
    {
      proposal: {
        id: recorded.id,
        hash: recorded.content_hash,
        expires_at: recorded.expires_at,
        actions: checked.map((entry) => ({ ...entry.action, status: entry.state })),
      },
      // Named only when it matters: a Run nobody is driving takes a delivery into its
      // inbox rather than to an agent, and the human should know that before confirming.
      no_driver: driver !== "live",
      requestId: options.requestId,
    },
    [
      previewOf(proposed.interpretation, checked),
      `collie confirm ${recorded.id} --hash ${recorded.content_hash}`,
      driver === "live"
        ? ""
        : "No Driver owns this Run: any delivery will be queued in its inbox on confirm.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );
});

function previewOf(interpretation: string, checked: ReadonlyArray<Validated>): string {
  return [
    interpretation,
    ...checked.map(
      (entry) => `  ${entry.state === "allowed_now" ? "→" : "?"} ${describeAction(entry.action)}`,
    ),
  ].join("\n");
}

/**
 * What the evaluator is shown. Compact Herd facts, then the target's own record — and
 * never a worker's terminal transcript: what an agent is doing reaches this as herdr's
 * own status and title, and no further.
 */
/**
 * How much of the Herd and of the conversation one question carries. Both are caps on a
 * prompt, not policy: a Herd with two hundred Runs must not produce a two-hundred-Run
 * prompt, and a conversation that has run all week must not be re-sent whole.
 */
const HERD_LINES = 40;
const TURNS_IN_CONTEXT = 20;
/** How many of a Run's newest cards a detail read carries. */
const CARDS_IN_CONTEXT = 3;

/**
 * Every Run in the Herd, bounded, with what was left out named.
 *
 * The Herd's, never a workspace's and never the Selection's: a board filter is what a
 * human is looking at, and a filter that decided what could be *read* would hide work by
 * hiding a row. Bounded and saying so, because a model told about forty of two hundred
 * Runs and not told so answers "that is all of them" in good faith.
 *
 * Shared: the evidence pack below and the tools native chat calls both read this, so
 * Collie and the row a human is looking at cannot tell different stories about one Run.
 */

export const evaluationDeps = Effect.fn("operations.evaluationDeps")(function* (env: PluginEnv) {
  const path = yield* Path.Path;
  // Execution bounds, not spending ones: a clock and an output cap. What a call costs is
  // recorded in `budget.jsonl` and never used to refuse the next one.
  const limits = {
    maxSeconds: 120,
    maxOutputBytes: 256 * 1024,
    model: "sonnet",
    effort: "medium",
  };
  return {
    herdKey: yield* herdOf(env.socketPath),
    evaluator: {
      help: Effect.promise(() => Bun.$`claude --help`.text().catch(() => "")),
      systemPromptFile: path.join(env.pluginRoot, "prompts", "steward.md"),
      limits,
    },
    limits,
  };
});

/**
 * What the human said, and what Collie makes of it — as a proposal nobody has acted on.
 *
 * A steer is a question, never a command. Even where a Run has granted Collie authority
 * to correct its own drift, a proposal that came out of a conversation is `pending`: the
 * grant was for the Driver's own checks, and "the human was talking about it" is not the
 * same as "the human asked for it". That is what `allowedNow: []` below is.
 */
export const herdFacts = Effect.fn("operations.herdFacts")(function* (env: PluginEnv) {
  const runs = yield* new RunStore(env.stateDir).list();
  const listed = runs.slice(0, HERD_LINES);
  const lines = yield* Effect.forEach(listed, (item) =>
    Effect.gen(function* () {
      const status = yield* runStatus(item);
      const record = item.record;
      const said = [
        `- run ${item.id}: ${record.workflow}, ${status}`,
        `agents ${runningAgents(record).join(", ") || "none"}`,
        `outcome ${record.outcome ?? "unspecified"}`,
      ];
      if (record.evidence_gaps.length > 0)
        said.push(`not proved: ${record.evidence_gaps.join("; ")}`);
      if (record.obstacle !== null) said.push(`in the way: ${record.obstacle}`);
      const attention = yield* attentionFor(item, new Herdr(env));
      if (attention.category !== "none") said.push(attention.explanation);
      return said.join(", ");
    }),
  );
  // An empty answer is not an answer: a Herd with no Runs says so, rather than handing
  // the model nothing to read.
  if (lines.length === 0) return "- (no Runs in this Herd)";
  return [
    ...lines,
    ...(runs.length > listed.length
      ? [`- (${runs.length - listed.length} more Run(s) not listed here)`]
      : []),
  ].join("\n");
});

/**
 * One Run in the detail a next action turns on: what it is for, what bounds it, what it
 * has got through, what it handed over, and where it has drifted. The same read the
 * evidence pack embeds, so a detail asked for in chat is the detail a proposal was made
 * from.
 */
export const runFacts = Effect.fn("operations.runFacts")(function* (run: Run, env: PluginEnv) {
  const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
  const attention = yield* attentionFor(run, new Herdr(env));
  const lines = [
    `Status: ${yield* runStatus(run)}; Driver: ${attention.driver}`,
    `Directory: ${run.record.cwd}`,
    `Workspace: ${run.record.workspace ?? "none"}`,
    `Goal: ${intent?.goal ?? run.record.inputs.goal ?? "(none recorded)"}`,
    `Intent version: ${intent?.version ?? "(none)"}`,
    attention.explanation,
    `Actions: ${attention.actions.join(", ") || "none"}`,
    ...(intent?.constraints ?? []).map(
      (c) => `- constraint ${c.id} (${c.severity}, ${c.source}): ${c.text}`,
    ),
    "",
    "### Steps",
    "",
    ...run.record.steps.map((step) => `- ${step.id}: ${step.status}`),
  ];
  const cards = yield* readCards(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
  for (const entry of cards.slice(-CARDS_IN_CONTEXT)) {
    if (lines.at(-1) !== "") lines.push("", "### Cards", "");
    lines.push(
      `- card ${entry.id} (${entry.kind}, ${entry.readiness}, ${entry.significance}) at ${entry.revision.head_sha.slice(0, 8)}${entry.revision.dirty ? " +dirty" : ""}`,
      `  aligned ${entry.aligned}; cross-run ${entry.cross_run}`,
      ...entry.claims.map((claim) => `  claim: ${claim.text}`),
      ...entry.verifications.map(
        (verification) => `  verification ${verification.name}: ${verification.result}`,
      ),
      ...entry.missing.map((what) => `  missing: ${what}`),
      ...(entry.drift.length > 0 ? [`  open drift: ${entry.drift.join(", ")}`] : []),
    );
  }
  const drift = openReports(yield* readDrift(run.dir).pipe(Effect.catch(() => Effect.succeed([]))));
  if (drift.length > 0) {
    lines.push("", "### Open drift", "");
    for (const report of drift)
      lines.push(
        `- ${report.constraint} (${report.severity}, ${report.kind}): ${report.correction ?? "no correction recorded"}`,
      );
  }
  return lines.join("\n");
});

const evidencePack = Effect.fn("operations.evidencePack")(function* (
  env: PluginEnv,
  question: string,
  run: Run | null,
  card: string | null,
  journal: string,
) {
  const lines = [
    "## The question",
    "",
    question,
    "",
    "## Runs in this Herd",
    "",
    yield* herdFacts(env),
  ];

  // Everything said in this Herd, whatever it was about. Without this an untargeted
  // question is asked with no memory of the conversation it belongs to, so a follow-up
  // like "what about the second one" has nothing to resolve — which is why the global
  // Collie could not hold a conversation at all.
  const said = yield* tail(journal, TURNS_IN_CONTEXT);
  if (said.length > 0) {
    lines.push(
      "",
      "## This conversation so far",
      "",
      ...said.map(
        (turn) => `- ${turn.role}${turn.target ? ` (about ${turn.target})` : ""}: ${turn.text}`,
      ),
    );
  }
  if (run !== null) {
    lines.push("", `## Run ${run.id}`, "", yield* runFacts(run, env));
    if (card !== null) {
      const cards = yield* readCards(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
      const bound = cards.find((entry) => entry.id === card);
      lines.push(
        "",
        `### Card ${card}`,
        "",
        bound === undefined
          ? "(no card of that id; nothing is bound)"
          : `Bound to this card's revision: ${bound.revision.head_sha} (${bound.readiness}).`,
      );
    }
    const turns = yield* tail(journal, TURNS_IN_CONTEXT, run.id);
    if (turns.length > 0)
      lines.push(
        "",
        "### Earlier turns about this run",
        "",
        ...turns.map((t) => `- ${t.role}: ${t.text}`),
      );
  }
  return lines.join("\n");
});

/**
 * Whether this Run is a parent whose fan-out is not over. Such a Run can record
 * `succeeded` while a repository run of its own is still going, so the guard that
 * refuses to stop or resume a succeeded Run does not apply to it — but only while that
 * is true. Once every repository has ended, a built plan is a succeeded Run like any
 * other, and stopping it would overwrite what it recorded with `stopped`.
 */
const stillFanningOut = (run: Run) =>
  run.record.fanout !== null && fanoutUnfinished(run.record.fanout);

/**
 * The repository runs a parent fanned out that are still going, each with the
 * repository it is building — which is what a caller reporting on one calls it.
 * Loaded rather than trusted: a child's own record is what says whether it has ended.
 */
