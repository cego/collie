// What starting, answering, stopping and resuming a Run actually does. Both the CLI
// and the Herdr adapters call these; neither owns the behaviour, so a pane and a
// command cannot drift apart. What stays with each of them is presentation: picking,
// prompting, rendering, and turning a result into text or JSON.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Config, Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { atClock, nowIso, untilFrom } from "./time";
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
import {
  DefinitionError,
  gateSteps,
  stepSummaries,
  layers,
  loadDefinitions,
  resolveWorkflow,
  skillDirs,
  validateWorkflow,
  stepVariants,
  type ResolvedWorkflow,
} from "./definitions";
import { readSnapshot, stepDifference, stepsDiffer } from "./snapshot";
import { approvedFrom } from "./verify-spec";
import { REQUESTABLE } from "./outcome";
import {
  CHOICE,
  driverAlive,
  driverOwnership,
  inboxFiles,
  STOPPED,
  InboxCommandJson,
  parseGateAnswer,
  readChoice,
  stopDriver,
  type InboxCommandValue,
} from "./driver";
import { parseMrTarget, repoArgs, shell, type Runner } from "./mr";
import {
  classifyGivenTarget,
  classifyWorkSource,
  inferInputs,
  inputSources,
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
  const tmp = `${target}.${yield* currentPid}.tmp`;
  yield* fs.writeFileString(tmp, `${Schema.encodeSync(InboxCommandJson)(command)}\n`, {
    flag: "wx",
  });
  yield* fs.rename(tmp, target);
  // The file it landed in, so a caller can tell an entry the Driver has taken from one
  // still sitting there unread.
  return target;
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
  /** The workspace the Run's tabs belong in; its own, where it has a worktree. */
  workspaceId?: string | null,
  /** The new task workspace's shell pane, which the Driver reads as its launch pane. */
  launchPane?: StartedTab | null,
) {
  const commandLine = yield* driverCommand(env);
  // A Run in its own worktree is in its own workspace, and the Driver has to open its
  // tabs there rather than in whatever workspace started it.
  const workspace: Record<string, string> = {};
  if (workspaceId) {
    workspace.HERDR_WORKSPACE_ID = workspaceId;
    workspace.HERDR_ACTIVE_WORKSPACE_ID = workspaceId;
  }
  if (launchPane) {
    workspace.HERDR_PANE_ID = launchPane.paneId;
    workspace.HERDR_ACTIVE_PANE_ID = launchPane.paneId;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(commandLine[0], [...commandLine.slice(1), "herdr", "drive"], {
          cwd,
          // extendEnv: the Driver inherits this process's environment and herdr's own
          // keys sit on top. Handing it `env.raw` alone gave it no PATH beyond the
          // /bin:/usr/bin fallback, and every git, glab and herdr it runs by bare name
          // became unfindable — which `shell` reports as exit 127, indistinguishable
          // from "no GitLab here".
          env: { ...env.raw, ...workspace, COLLIE_RUN: runId, COLLIE_CWD: cwd },
          extendEnv: true,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      // Unref before the scope closes, or the spawner's finalizer kills the Driver it
      // just started: it leaves a child alone only once it is unreferenced. That is
      // the whole point of a detached Driver — it outlives whatever asked for it,
      // because a Run takes hours and the picker closes the moment it has started one.
      yield* Effect.asVoid(handle.unref);
    }),
  );
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
  if (yield* fs.exists(path.join(run.dir, STOPPED))) return "stopped";
  if (run.record.awaiting || (yield* fs.exists(path.join(run.dir, CHOICE)))) return "waiting";
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
export const prepareWorkflow = Effect.fn("operations.prepareWorkflow")(function* (
  env: PluginEnv,
  name: string,
  /**
   * The Task this start continues, where it continues one. Inference is task-local:
   * a fresh start has no earlier Runs of its own, so it asks rather than reaching for
   * whatever the repository last produced.
   */
  task?: TaskRecord | null,
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
    task: task?.id ?? null,
  });
  return { ok: true, workflow, resolutions } as const;
});

/** `--decide step=title`, checked against the Workflow rather than taken on trust. */
type ParsedDecisions =
  | { ok: true; decisions: Record<string, string> }
  | { ok: false; error: Failure };

function parseDecide(values: ReadonlyArray<string>, wf: ResolvedWorkflow): ParsedDecisions {
  // The evidence gate is decidable too: it is a decision the Run reaches, and a launch
  // that already knows its answer should not have to come back and give it.
  const gates = gateSteps(wf);
  const decidable = [...wf.steps.filter((step) => (step.choices?.length ?? 0) > 0), ...gates];
  const decisions: Record<string, string> = {};
  for (const entry of values) {
    const at = entry.indexOf("=");
    if (at <= 0)
      return { ok: false, error: err("invalid_input", `Decision "${entry}" must be step=title.`) };
    const id = entry.slice(0, at);
    const title = entry.slice(at + 1);
    const step = decidable.find((s) => s.id === id);
    if (!step) {
      const known = decidable.map((s) => s.id).join(", ") || "none";
      return {
        ok: false,
        error: err("invalid_input", `"${id}" is not a Choice step of ${wf.name} (has: ${known}).`),
      };
    }
    // A gate takes its own answers, and an edited list only where the board sends one.
    if (gates.includes(step)) {
      if (title !== "approve" && title !== "skip") {
        return {
          ok: false,
          error: err(
            "invalid_input",
            `"${title}" is not an answer to the ${wf.name} gate at "${id}" (has: approve, skip).`,
          ),
        };
      }
      decisions[id] = title;
      continue;
    }
    const titles = [...new Set((step.choices ?? []).map((c) => c.title))];
    if (!titles.includes(title)) {
      return {
        ok: false,
        error: err(
          "invalid_input",
          `"${title}" is not a choice of ${wf.name} step "${id}" (has: ${titles.join(", ")}).`,
        ),
      };
    }
    decisions[id] = title;
  }
  return { ok: true, decisions };
}

/**
 * Everything between a prepared Workflow and a Run, for a caller that was given its
 * answers rather than asking them: the Inputs settled and classified, the decisions
 * checked against the Workflow's own steps and titles, and one error naming what is
 * still missing. A typo here would otherwise reach the Run — a `--decide` that
 * silently degraded to "ask me then" hangs the unattended run the flag exists for,
 * and a merge-request URL that is not normalised renders `{{target_repo}}` empty.
 */
/**
 * Settles the Inputs a caller already knows, wherever it knew them from: the command
 * line, a chained Run's `inputs:`, or a row in the Collie tab that named one by being
 * clicked. A given value owes the prompts its kind, exactly as the picker and a chained
 * Run record it: the workflow body branches on `<name>_kind`, and an inferred kind left
 * over from a candidate would describe the value that was not chosen. A diff-target is
 * normalised as well as classified, or `{{target_repo}}` renders empty.
 */
export const settleExplicit = Effect.fn("operations.settleExplicit")(function* (
  env: PluginEnv,
  resolutions: Resolution[],
  inputs: Record<string, string>,
) {
  for (const item of resolutions) {
    const value = inputs[item.name];
    if (value === undefined) continue;
    const target =
      item.strategy === "diff-target" ? yield* classifyGivenTarget(value, { cwd: env.cwd }) : null;
    // The label as well as the kind: a work-source's short name is what the Run is
    // named after, and dropping it named a Run given a plan directory after the whole
    // path to it — which is the same name for every plan under one `tasks/` directory.
    const work = item.strategy === "work-source" ? yield* classifyWorkSource(value) : null;
    settle(item, {
      value: target?.value ?? value,
      source: "explicit",
      kind: work?.kind ?? target?.kind,
      label: work?.label ?? target?.label,
    });
  }
});

export const settleGiven = Effect.fn("operations.settleGiven")(function* (
  env: PluginEnv,
  prepared: { readonly workflow: ResolvedWorkflow; readonly resolutions: Resolution[] },
  given: {
    readonly inputs: Record<string, string>;
    readonly decide: ReadonlyArray<string>;
  },
) {
  const { workflow, resolutions } = prepared;
  const decisions = parseDecide(given.decide, workflow);
  if (!decisions.ok) return decisions.error;

  // A previous review named by hand has to exist, and has to have a review in it:
  // the engine falls back to no previous review when it cannot read one, so a run id
  // that carries nothing would review against nothing without ever saying so — the
  // exact failure this input exists to avoid.
  const previous = given.inputs.previous;
  if (previous) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const run = yield* new RunStore(env.stateDir)
      .load(previous)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!run) return err("invalid_input", `No run "${previous}" to review against.`);
    const review = path.join(run.dir, REVIEW_FILE);
    const text = yield* fs.readFileString(review).pipe(Effect.catch(() => Effect.succeed("")));
    if (text.trim() === "") {
      return err("invalid_input", `Run "${previous}" wrote no review to review against.`);
    }
  }

  // A value outside the table would make the Run promise evidence nothing can produce,
  // and it would not find that out until the gate before its merge request.
  const outcome = given.inputs.outcome?.trim();
  if (outcome !== undefined && outcome !== "" && !REQUESTABLE.includes(outcome)) {
    return err(
      "invalid_input",
      `"${outcome}" is not an outcome (one of: ${REQUESTABLE.join(", ")}), or leave it empty.`,
    );
  }

  yield* settleExplicit(env, resolutions, given.inputs);

  // Nobody is here to be asked; an unsettled Input is the caller's to give. A value
  // inference already chose is settled, whatever it offers beside it: candidates are
  // the picker's override menu, not a question this caller has to answer.
  const unresolved = resolutions.filter((item) => item.needsAsking);
  if (unresolved.length > 0) {
    return err(
      "needs_input",
      `${workflow.name} needs input.`,
      Schema.decodeUnknownSync(YamlMapSchema)({
        inputs: unresolved.map((item) => ({
          name: item.name,
          candidates: item.candidates ?? [],
          question: item.question,
        })),
        // `branch` among them: this is the refusal an agent hits whenever any Input is
        // missing, so it is where it is most likely to learn that the Input exists.
        schema: branchListed(workflow.checkout, workflow.inputs),
      }),
    );
  }
  return { ok: true, decisions: decisions.decisions } as const;
});

/**
 * Brings this installation up to date and reports what moved. A checkout is pulled
 * first — its own source is what a release is cut from — and then `prepare.sh` does
 * the same job it does at install time, so there is one place that decides what a
 * prepared machine has on it, and every entry point ends in that one place.
 *
 * The runner is a parameter for the same reason inference takes one: this shells out
 * to git and sh, and a test should be able to watch it do that.
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
export const startRun = Effect.fn("operations.startRun")(function* (
  env: PluginEnv,
  options: {
    readonly workflow: ResolvedWorkflow;
    readonly resolutions: Resolution[];
    /** What the human answered at launch for this Workflow's Choice steps. */
    readonly decisions?: Record<string, string>;
    readonly workspace: WorkspaceInfo | null;
    readonly note?: string;
    /** `--input branch=<name>`, which beats every branch inference. */
    readonly branch?: string | null;
    /** The Run this one came out of, where it came out of one. */
    readonly parent?: string;
    /** The goal and constraints named at launch. Authority is never among them. */
    readonly intent?: {
      readonly goal?: string | null;
      readonly constraints?: ReadonlyArray<Omit<Constraint, "since">>;
    };
    /**
     * Which Task this Run belongs to. A fresh start — the default — gets a task
     * workspace of its own, whatever workspace it was launched from; a continuation
     * goes to the workspace the named Task already has.
     */
    readonly task?: TaskChoice;
  },
) {
  const { workflow, resolutions, workspace } = options;
  if (yield* isHomeDirectory(env.stateDir, env.cwd))
    return {
      _tag: "Rejected" as const,
      result: err(
        "needs_input",
        "Choose the project to work on with --workspace <id> or COLLIE_CWD=/path/to/project. Collie's Home is a state directory, not your project.",
      ),
    };
  // The integrations this Run would reach for and cannot make: asked now, with the
  // fix, rather than at the merge step hours in or by an agent looking for a tool it
  // does not have. Only what this Run needs — a Workflow that never waits on Helle is
  // not refused over Helle.
  if (workflow.steps.some((step) => step.waits?.includes("helle"))) {
    const helle = yield* probeHelle(env);
    if (helle.state !== "ok")
      return {
        _tag: "Rejected" as const,
        result: err("operation_failed", `${workflow.name} waits on Helle: ${helle.detail}.`, {
          fix: helle.fix,
        }),
      };
  }
  const defaults = yield* loadDefaults(env.configDir);
  if (
    resolutions.some((item) => item.kind === "linear") &&
    workflow.steps.some((step) => stepVariants(step, defaults).some((v) => v.harness === "claude"))
  ) {
    const linear = yield* probeLinearMcp(env);
    if (linear.state !== "ok")
      return {
        _tag: "Rejected" as const,
        result: err(
          "operation_failed",
          `${workflow.name} was given a Linear issue, and ${linear.detail}.`,
          { fix: linear.fix },
        ),
      };
  }
  const named = primaryName(resolutions);
  const herdr = new Herdr(env);
  // Collie has no daemon, so pruning happens where it already wakes up. Before the
  // checkout is resolved, so a settled worktree left on this Run's own branch is gone
  // rather than reopened.
  const pruned = yield* pruneWorktrees({
    herdr,
    stateDir: env.stateDir,
    cwd: env.cwd,
    // This Run is about to work here, so nothing may take it out from under it.
    keep: env.cwd,
  });
  const choice = options.task ?? { mode: "new" };
  // A continuation works where its Task already is; a fresh start is still in the
  // workspace it was launched from until its own has been made.
  const from = choice.mode === "continue" ? choice.task : null;
  const launchedIn = from?.workspace ?? workspace?.workspaceId ?? env.workspaceId;
  // Named before the checkout, because `workspace=new` has herdr open this Task's
  // workspace as part of making the checkout and needs the name to open it under.
  const label =
    from === null
      ? yield* freshTaskLabel(herdr, env, {
          workflow: workflow.name,
          named: named.value,
          short: named.short,
          goal: options.intent?.goal ?? null,
          cwd: env.cwd,
        })
      : from.label;
  // A mutating Workflow owns its checkout, keyed by the branch it is about to build,
  // so two of them never share a working tree — or a stash stack.
  const checkout = yield* checkoutFor(herdr, {
    cwd: env.cwd,
    stateDir: env.stateDir,
    workflow: workflow.name,
    checkout: workflow.checkout,
    name: named.short,
    inputs: inputValues(resolutions),
    sources: inputSources(resolutions),
    workspaceId: launchedIn,
    workspaceLabel: from?.label ?? workspace?.label ?? null,
    openLabel: label,
    explicit: options.branch,
    login: env.gitlabLogin,
  });
  // Nothing has been created yet, so a Run that must not share a checkout is simply
  // not started, and the caller is told which branch could not be given one.
  if (checkout.refused) {
    return {
      _tag: "Rejected" as const,
      // In the message: it is the only part the CLI prints and the picker shows.
      result: err(
        "operation_failed",
        `${workflow.name} could not be given a checkout: ${checkout.refused}`,
        { cause: checkout.refused },
      ),
    };
  }
  // Still before anything is created, so a workspace herdr would not open is a Run that
  // was never started rather than one launched into the workspace it came from.
  const resolved = yield* taskFor(herdr, env, choice, {
    label,
    opened:
      checkout.workspaceId === null || checkout.workspaceId === launchedIn
        ? null
        : { id: checkout.workspaceId, label: checkout.workspaceLabel },
  });
  if (resolved._tag === "Rejected") return resolved;
  const task = resolved.task;
  const run = yield* new RunStore(env.stateDir).create({
    workflow: workflow.name,
    cwd: checkout.cwd,
    session: env.socketPath,
    workspace: task.workspace,
    task: task.id,
    workspaceLabel: task.label,
    workspaceWorktree: checkout.worktree?.path ?? workspace?.worktree ?? null,
    activatedCwd: env.cwd,
    worktree: checkout.worktree,
    inputs: inputValues(resolutions),
    inputSources: inputSources(resolutions),
    decisions: options.decisions,
    definition: workflow,
    approvedVerifications: yield* approvedFrom({ cwd: checkout.cwd, configDir: env.configDir }),
    stepIds: workflow.steps.map((step) => step.id),
    stepSummaries: stepSummaries(workflow),
    maxIterations: workflow.maxIterations,
    ...runNames(checkout, named),
    parent: options.parent,
  });
  yield* run.log(`created from ${workflow.path} (${workflow.layer} layer)`);
  for (const line of pruned) yield* run.log(`worktrees: ${line}`);
  if (checkout.note) yield* run.log(checkout.note);
  if (options.note) yield* run.log(options.note);
  yield* seedRunIntent(
    { ...env, workspaceId: from?.workspace ?? env.workspaceId },
    run,
    resolutions,
    options.intent ?? {},
  );
  const undriven = yield* handOver(env, run, resolved.launchPane);
  return undriven
    ? { _tag: "Rejected" as const, result: undriven.result }
    : // The checkout as well as the Run: the branch is decided here, and the line that
      // tells the operator what was started is the only place they see it.
      { _tag: "Started" as const, run, checkout };
});

/**
 * Version 1 of the Run's Intent, written before any Driver could read it: the
 * workspace's defaults, then what the work source's own text asks for, then what the
 * human named at launch — later beating earlier where they name the same constraint.
 *
 * A Run whose Intent could not be written is still started. The Intent is what steering
 * compares against, not a precondition for doing the work, and a Run refused because a
 * defaults file was hand-edited into nonsense would be a worse failure than one that
 * says in its log that it has no Intent.
 */
const seedRunIntent = Effect.fn("operations.seedRunIntent")(function* (
  env: PluginEnv,
  run: Run,
  resolutions: Resolution[],
  named: {
    readonly goal?: string | null;
    readonly constraints?: ReadonlyArray<Omit<Constraint, "since">>;
  },
) {
  const key = scopeKey(scopeFor(env, env.cwd));
  const defaults = yield* readDefaults(yield* defaultsPath(env.stateDir, key)).pipe(
    Effect.catch((cause) =>
      run.log(`no workspace defaults: ${String(cause)}`).pipe(Effect.as(null)),
    ),
  );
  const source = resolutions.find((r) => r.strategy === "work-source");
  const work = source
    ? yield* fromWorkSource(source.kind ?? null, source.value)
    : yield* fromWorkSource(null, "");
  const intent = seedIntent(run.id, {
    defaults,
    goal: named.goal ?? resolutions.find((r) => r.strategy === "goal")?.value ?? work.goal,
    constraints: [...work.constraints, ...(named.constraints ?? [])],
    runVerification: run.record.approved_verifications,
  });
  yield* writeIntent(run.dir, intent).pipe(
    Effect.matchEffect({
      onFailure: (cause) => run.log(`intent v1 not written: ${String(cause)}`),
      onSuccess: () => run.log(`intent v1 written (${intent.constraints.length} constraints)`),
    }),
  );
});

/**
 * Hands the Run to a detached Driver, or says why none could be started — and records
 * that on the Run, because nothing is advancing it and nothing will, and a Run left
 * reported as `running` has no terminal state for `run wait` to return on.
 *
 * The reason comes back as a result rather than a failure so a caller's request
 * receipt records it, and a retry with the same request id replays it.
 */
export const handOver = Effect.fn("operations.handOver")(function* (
  env: PluginEnv,
  run: Run,
  launchPane: StartedTab | null = null,
) {
  // The workspace the Run belongs in, which is the one it was activated from unless
  // herdr opened one for its checkout. A Driver inherits the invoking pane's workspace
  // otherwise, and a `--workspace` run would open its tabs wherever it was typed.
  const workspaceId = run.record.workspace;
  const why = yield* spawnDriver(env, run.id, run.record.cwd, workspaceId, launchPane).pipe(
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
/**
 * Every Choice title this Run can offer, from the definition it froze at creation — not
 * from whatever the layers say now, and not from a re-resolution that could disagree with
 * what the Run is actually running. Empty for a Run with no snapshot, which simply means
 * the guard below has nothing to compare against and lets the answer through.
 */
const choiceTitlesOf = Effect.fn("operations.choiceTitlesOf")(function* (run: Run) {
  const frozen = yield* readSnapshot(run.dir, run.record.definition).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  if (frozen === null) return new Set<string>();
  return new Set(
    frozen.steps.flatMap((step) =>
      (step.choices ?? []).map((choice) => choice.title.trim().toLowerCase()),
    ),
  );
});

export const answerRun = Effect.fn("operations.answerRun")(function* (
  run: { readonly id: string; readonly dir: string },
  answer: string,
  requestId: string,
  /** The Choice this answer was written for, when the caller knows it. */
  expected: string | null = null,
) {
  const fs = yield* FileSystem.FileSystem;
  // What this Run can offer from a menu, where the caller handed over a whole Run to ask.
  // SAFETY: `record` is the field that distinguishes a loaded Run from the id-and-dir
  // shape the board passes, and `Run` is the only type here that has one.
  const whole = "record" in run ? (run as Run) : null;
  const titles = whole === null ? new Set<string>() : yield* choiceTitlesOf(whole);
  const choice = yield* readChoice(run.dir);
  if (!choice) return err("run_not_waiting", `Run "${run.id}" is not waiting for a Choice.`);
  // Checked here rather than in the caller: this is the boundary the Driver reads
  // through, so a question replaced between reading it and answering it is caught
  // however the answer arrived, and the Choice now open is left untouched.
  if (expected !== null && expected !== choice.id)
    return err("choice_mismatch", `Run "${run.id}" is no longer asking Choice "${expected}".`, {
      choiceId: choice.id,
    });
  if ((yield* answeredChoices(run.dir)).has(choice.id))
    return err("choice_already_answered", `Choice "${choice.id}" already has an answer.`);
  // An empty answer is how a menu is dismissed; it leaves the Run open for a resume.
  if (choice.kind === "menu" && answer !== "" && !choice.items.some((item) => item.id === answer)) {
    return err("invalid_answer", `"${answer}" is not a valid answer.`, {
      answers: choice.items.map((item) => item.id),
    });
  }
  if (choice.kind === "gate" && parseGateAnswer(answer, choice.verifications ?? []) === null) {
    return err(
      "invalid_answer",
      `"${answer}" is not an answer to a gate: approve, skip, or approve:<the list, cut down>.`,
      { answers: choice.items.map((item) => item.id), verifications: choice.verifications ?? [] },
    );
  }
  // A settings question is typed into, not picked from — and a Choice title typed into
  // one is somebody answering the menu they were looking at a moment ago. It used to be
  // taken literally and written to `config.json`, which is how a Linear team came to be
  // called "Implement now". The question says what it is asking for; this refuses the one
  // answer it certainly is not.
  if (choice.kind === "ask" && titles.has(answer.trim().toLowerCase())) {
    return err(
      "invalid_answer",
      `"${answer}" is a menu choice, and this Run is asking a settings question: ${choice.header}`,
      { question: choice.header },
    );
  }
  const entry = yield* writeInbox(run.dir, {
    type: "answer",
    requestId,
    choiceId: choice.id,
    answer,
  });
  // The check above and the write cannot be one act, so the Driver may have replaced
  // the Choice in between — and `consumeInboxAnswer` passes over an entry about a
  // question no longer open. Whether that happened, the inbox says: an entry the Driver
  // has taken is gone from disk, so a moved-on Choice with our file consumed means the
  // answer landed, and one with our file still there means nothing will ever read it.
  const asking = (yield* readChoice(run.dir))?.id;
  if (asking !== choice.id && (yield* fs.exists(entry))) {
    yield* fs.remove(entry, { force: true });
    return err("choice_mismatch", `Run "${run.id}" stopped asking Choice "${choice.id}".`);
  }
  return ok({ runId: run.id, answer }, `Answered ${run.id}: ${answer}.`);
});

/**
 * Stops the Run taking on new work, without stopping the work in flight. A hold reaches
 * the Driver through the inbox like every other command, so a Run with no live Driver
 * takes no hold: there is nothing to decline to start work, and a queued hold would be
 * consumed by whoever resumes it and read as a decision they never made.
 */
export const holdRun = Effect.fn("operations.holdRun")(function* (
  run: Run,
  reason: string,
  requestId: string,
  /** When it lifts, ISO. Null is a hold only a human ends. */
  until: string | null = null,
  by = "you",
) {
  if (runSettled(yield* runStatus(run)))
    return err("invalid_state", `Run "${run.id}" has already finished.`);
  yield* writeInbox(
    run.dir,
    until === null
      ? { type: "hold", requestId, reason, by }
      : { type: "hold", requestId, reason, by, until },
  );
  const ends = until === null ? "" : ` until ${atClock(until, yield* Clock.currentTimeMillis)}`;
  return ok({ runId: run.id, reason, until }, `Holding ${run.id}${ends}: ${reason}.`);
});

/**
 * Every unsettled Run of one workspace, held together. What "hold happytiger until 14:00"
 * means: a workspace is a place work is happening, and holding it is holding all of it.
 * Each Run takes its own hold, so releasing or answering one lifts only that one.
 */
export const holdWorkspace = Effect.fn("operations.holdWorkspace")(function* (
  stateDir: string,
  workspace: string,
  reason: string,
  requestId: string,
  until: string | null = null,
  by = "you",
) {
  const runs = (yield* new RunStore(stateDir).list()).filter(
    (run) => run.record.workspace === workspace,
  );
  const held: string[] = [];
  for (const run of runs) {
    if (runSettled(yield* runStatus(run))) continue;
    // One request id per Run: the inbox is keyed by it, and one id across several Runs
    // would be one request the receipts could not tell apart.
    yield* holdRun(run, reason, `${requestId}-${run.id}`, until, by);
    held.push(run.id);
  }
  if (held.length === 0)
    return err("invalid_state", `No unfinished Run in workspace "${workspace}".`);
  const ends = until === null ? "" : ` until ${atClock(until, yield* Clock.currentTimeMillis)}`;
  return ok(
    { workspace, runs: held, reason, until },
    `Holding ${held.length} run(s) in ${workspace}${ends}: ${reason}.`,
  );
});

/** The hold a Run is under, for a reader that has its record and not its inbox. */
export function heldUntil(record: RunRecord): RunRecord["held"] {
  return record.held;
}

/** Lets a held Run take on work again. Only a human ever writes this. */
export const releaseRun = Effect.fn("operations.releaseRun")(function* (
  run: Run,
  reason: string,
  requestId: string,
) {
  if (runSettled(yield* runStatus(run)))
    return err("invalid_state", `Run "${run.id}" has already finished.`);
  yield* writeInbox(run.dir, { type: "release", requestId, reason });
  return ok({ runId: run.id, reason }, `Released ${run.id}.`);
});

/**
 * The one thing that lifts a manual override. Automatic corrections to an agent someone
 * typed into stop the moment that is noticed, and nothing times them back on: a human
 * who took the keyboard is assumed to still have it until they say otherwise.
 */
export const clearOverride = Effect.fn("operations.clearOverride")(function* (
  stateDir: string,
  herdr: Herdr,
  run: Run,
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
  yield* run.log(`${agent}: override cleared by ${by}`);
  return ok({ runId: run.id, agent }, `Cleared the manual override on ${agent}.`);
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
export const carryOutProposal = Effect.fn("operations.carryOutProposal")(function* (
  env: PluginEnv,
  proposalId: string,
  hash: string | undefined,
  actor: Actor,
) {
  // The operations register what they can carry out; without this the registry is empty
  // and every action is refused as `executor_missing`, which would be a lie about this
  // build rather than a fact about it.
  yield* registerRunExecutors(env);
  const file = yield* proposalsPath(env.stateDir, yield* herdOf(env.socketPath));
  const store = new RunStore(env.stateDir);
  const proposal = (yield* readProposals(file)).find(
    (line): line is ProposalRecord => line.kind === "proposal" && line.id === proposalId,
  );
  const versions = new Map<string, number>();
  for (const target of proposal?.targets ?? []) {
    const run = yield* store.load(target.run).pipe(Effect.catch(() => Effect.succeed(null)));
    if (run === null) continue;
    const intent = yield* readIntent(run.dir);
    if (intent !== null) versions.set(target.run, intent.version);
  }

  const judged = yield* confirmProposal(
    file,
    proposalId,
    hash ?? proposal?.content_hash ?? "",
    actor,
    versions,
  );
  if ("refused" in judged) return err("invalid_input", judged.detail, { reason: judged.refused });

  const results: Array<{ index: number; kind: string; state: string; note: string }> = [];
  const expectedVersions = { ...judged.proposal.intent_versions };
  // Runs an earlier action failed on: what was asked about them next was asked assuming
  // the failure did not happen. Everything else in the request is independent of it —
  // six launches asked for in one breath are six requests, and the first path that does
  // not exist is no reason to leave the other five unattempted.
  const failedRuns = new Set<string>();
  for (const [index, proposed] of judged.actions.entries()) {
    if ("run" in proposed && failedRuns.has(proposed.run)) {
      yield* stepSettled(file, proposalId, index, "skipped", "after_failure");
      results.push({ index, kind: proposed.kind, state: "skipped", note: "after_failure" });
      continue;
    }
    // All edits in a request name the snapshot it was checked against. Advance only
    // for edits this sequence applied; unrelated concurrent edits still fail admission.
    const action =
      proposed.kind === "update_intent" &&
      proposed.base_version === judged.proposal.intent_versions[proposed.run]
        ? { ...proposed, base_version: expectedVersions[proposed.run] ?? proposed.base_version }
        : proposed;
    if (action.kind === "none" || action.kind === "ask_human") {
      const state = action.kind === "none" ? "applied" : "failed";
      const note = action.kind === "none" ? action.why : action.question;
      yield* stepSettled(file, proposalId, index, state, note);
      results.push({ index, kind: action.kind, state, note });
      if (action.kind === "ask_human") break;
      continue;
    }
    const executor = executorFor(action.kind);
    if (!executor) {
      yield* stepSettled(file, proposalId, index, "skipped", "executor_missing");
      results.push({ index, kind: action.kind, state: "skipped", note: "executor_missing" });
      break;
    }
    const refusal = yield* admissionFor(env, action, {
      ...judged.proposal,
      intent_versions: expectedVersions,
    });
    if (refusal !== null) {
      yield* stepSettled(file, proposalId, index, "skipped", refusal);
      results.push({ index, kind: action.kind, state: "skipped", note: refusal });
      break;
    }
    yield* stepStarted(file, proposalId, index);
    const outcome = yield* executor(action, actorName(actor));
    yield* stepSettled(file, proposalId, index, outcome.state, outcome.note);
    results.push({
      index,
      kind: action.kind,
      state: outcome.state,
      note: outcome.note ?? "",
    });
    if (outcome.state === "failed" && "run" in action) failedRuns.add(action.run);
    if (outcome.state !== "failed" && action.kind === "update_intent")
      expectedVersions[action.run] = action.base_version + 1;
  }
  const message = results
    .map((r) => `${r.index} ${r.kind}: ${r.state}${r.note ? ` — ${r.note}` : ""}`)
    .join("\n");
  if (results.some((r) => r.state === "failed" || r.state === "skipped")) {
    const changed = results.some((r) => r.state === "applied" && r.kind !== "none");
    // needs_input is retryable without a receipt only when nothing has happened yet.
    const code =
      results.at(-1)?.kind === "ask_human" && !changed ? "needs_input" : "operation_failed";
    return err(code, message, {
      proposal: proposalId,
      results,
    });
  }
  return {
    ok: true as const,
    data: { proposal: proposalId, results },
    human: message,
  };
});

/**
 * One action the human asked for in chat, carried out now. The same closed union, the
 * same last-moment admission check and the same executors a confirmation runs; what it
 * has no part of is a proposal, because nobody is being asked — the human already said
 * it (ADR-0011). What Collie wants of its own accord still goes through `request`.
 */
export const carryOutAsked = Effect.fn("operations.carryOutAsked")(function* (
  env: PluginEnv,
  actions: ReadonlyArray<Action>,
  actor: Actor,
) {
  yield* registerRunExecutors(env);
  const results: Array<{ kind: string; state: string; note: string }> = [];
  for (const action of actions) {
    const executor = executorFor(action.kind);
    if (!executor) {
      results.push({ kind: action.kind, state: "skipped", note: "executor_missing" });
      continue;
    }
    const refusal = yield* admissionFor(env, action, null);
    if (refusal !== null) {
      results.push({ kind: action.kind, state: "skipped", note: refusal });
      continue;
    }
    const outcome = yield* executor(action, actorName(actor));
    results.push({ kind: action.kind, state: outcome.state, note: outcome.note ?? "" });
    // What follows a failure was asked for on the assumption that it did not happen.
    if (outcome.state === "failed") break;
  }
  return results;
});

/** Everything the proposal assumed, asked again immediately before the action runs. */
const admissionFor = Effect.fn("operations.admissionFor")(function* (
  env: PluginEnv,
  action: Parameters<typeof admit>[0],
  /** Null for an action nobody proposed: there is then nothing it assumed earlier. */
  proposal: ProposalRecord | null,
) {
  const store = new RunStore(env.stateDir);
  const id = "run" in action ? action.run : null;
  const run =
    id === null ? null : yield* store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
  if (run === null) return admit(action, emptyAdmission());
  const live = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
  const agent = "agent" in action ? (action.agent ?? null) : null;
  // An Intent nobody can decode is not an Intent with no constraints. Refusing here is
  // what stops a corrupt file reading as "no version to disagree with" (SPEC §7.1).
  const intent = yield* readIntent(run.dir).pipe(
    Effect.catch(() => Effect.succeed<Intent | "unreadable">("unreadable")),
  );
  if (intent === "unreadable") return `${run.id}'s Intent cannot be read`;
  const bound = proposal?.card;
  const now =
    bound === undefined
      ? null
      : revisionOf(yield* fingerprint(run.record.worktree?.path ?? run.record.cwd));
  return admit(action, {
    run: { id: run.id, status: yield* runStatus(run) },
    driverLive: (yield* driverOwnership(run.dir)) === "live",
    pendingChoice: (yield* readChoice(run.dir))?.id ?? null,
    incarnation: agent === null ? null : (live.find((a) => a.name === agent)?.terminalId ?? null),
    proposedIncarnation: agent === null ? null : (proposal?.incarnations?.[agent] ?? null),
    intentVersion: intent?.version ?? null,
    proposedIntentVersion: proposal?.intent_versions[run.id] ?? null,
    revision: bound === undefined || now === null ? null : { card: bound.revision, now },
  });
});

function emptyAdmission(): Parameters<typeof admit>[1] {
  return {
    run: null,
    driverLive: false,
    pendingChoice: null,
    incarnation: null,
    proposedIncarnation: null,
    intentVersion: null,
    proposedIntentVersion: null,
    revision: null,
  };
}

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

  const driver = yield* driverOwnership(run.dir);
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
    ...(attention.choice === null
      ? []
      : [
          `Question ${attention.choice.id}: ${attention.choice.header}`,
          ...attention.choice.items.map(
            (item) => `- ${item.title}${item.subtitle ? ` — ${item.subtitle}` : ""}`,
          ),
        ]),
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
const fanoutChildren = Effect.fn("operations.fanoutChildren")(function* (
  stateDir: string,
  run: Run,
) {
  const store = new RunStore(stateDir);
  const running: Array<{ repo: string; child: Run }> = [];
  for (const entry of run.record.fanout ? fanoutRepos(run.record.fanout) : []) {
    if (entry.run === null) continue;
    const child = yield* store.load(entry.run).pipe(Effect.catch(() => Effect.succeed(null)));
    if (child === null) continue;
    const status = yield* runStatus(child);
    if (!runSettled(status)) running.push({ repo: entry.repo, child });
  }
  return running;
});

/**
 * Stops orchestration and closes only the panes this Run owns. Its agents keep
 * whatever they wrote; the repository is left exactly as it is.
 *
 * Two channels, because neither alone is enough. The inbox command is the record the
 * spec asks for and is what a Driver waiting on a Choice consumes. The signal is what
 * reaches a Driver that is mid-Step, waiting on an agent and reading no files.
 */
const stopOne = Effect.fn("operations.stopOne")(function* (
  stateDir: string,
  herdr: Herdr,
  run: Run,
  requestId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* runStatus(run)) === "succeeded" && !stillFanningOut(run))
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
    const stoppedAt = yield* nowIso();
    yield* fs.writeFileString(path.join(run.dir, STOPPED), `${stoppedAt}\n`);
    run.record.status = "blocked";
    run.record.finished_at = stoppedAt;
    yield* run.save();
  }
  // The Run's own register, not the caller's: closing the panes its agents are in is
  // the only thing that stops them, and both front doors used to hand this the scope
  // they happened to be in — so a stop from another workspace signalled the Driver,
  // said it had stopped the run, and left its agents working in their own checkout.
  const register = yield* registryPath(stateDir, scopeOfRun(run.record));
  const entries = (yield* readRegistry(register)).filter((entry) => entry.runId === run.id);
  yield* Effect.all(entries.map((entry) => herdr.paneClose(entry.paneId).pipe(Effect.result)));
  return ok({ runId: run.id, status: "stopped" }, `Stopped run ${run.id}.`);
});

/**
 * Stops a Run, and every repository run it fanned out first: "stop this" on a plan run
 * means the whole plan, and a child left building for a parent that is gone would keep
 * committing to a branch nobody is waiting for.
 *
 * A repository run that will not stop is the whole answer, and the parent is left
 * alone. Stopping the parent anyway and reporting `ok` would say the plan had stopped
 * while one of its repository runs was still orchestrating agents — and the parent
 * still waiting on that run is what makes a second `run stop` mean something.
 */
export const stopRun = Effect.fn("operations.stopRun")(function* (
  stateDir: string,
  herdr: Herdr,
  run: Run,
  requestId: string,
) {
  const alive: string[] = [];
  for (const { repo, child } of yield* fanoutChildren(stateDir, run)) {
    const stopped = yield* stopOne(stateDir, herdr, child, requestId);
    if (!stopped.ok) alive.push(`${repo} (${child.id})`);
  }
  if (alive.length > 0) {
    return err(
      "operation_failed",
      `Run "${run.id}" was left running: these repository runs could not be stopped: ${alive.join(", ")}.`,
      { run: run.id, running: alive },
    );
  }
  return yield* stopOne(stateDir, herdr, run, requestId);
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
 * The request goes in the inbox like a stop's. A resume runs only when no Driver is
 * alive, so its reader is the Driver this call starts: that Driver takes the request id
 * off the command and records it, which is what gives the Run's own audit trail a
 * resume as well as a stop.
 */
/**
 * Whether the workflow this Run recorded and the one its layers resolve to now are the
 * same shape, for a Run that has no frozen definition to compare against. A failure to
 * resolve at all is the same answer: a Run cannot be resumed into a definition that is
 * not there.
 */
const definitionMoved = Effect.fn("operations.definitionMoved")(function* (
  env: PluginEnv,
  run: Run,
) {
  const defs = yield* loadDefinitions(yield* layers({ ...env, cwd: run.record.cwd }));
  const defaults = yield* loadDefaults(env.configDir);
  let wf: ResolvedWorkflow;
  try {
    wf = resolveWorkflow(run.record.workflow, defs, defaults);
  } catch (cause) {
    if (cause instanceof DefinitionError)
      return err("definition_changed", `Run "${run.id}" cannot be resumed: ${cause.message}`);
    throw cause;
  }
  const recorded = run.record.steps.map((step) => step.id);
  const now = wf.steps.map((step) => step.id);
  if (!stepsDiffer(recorded, now)) return null;
  return err(
    "definition_changed",
    `Run "${run.id}" recorded steps ${recorded.join(", ")}, and ${wf.path} ${stepDifference(recorded, now)}. ` +
      `This Run predates frozen definitions, so resuming it would run a workflow it never started. Nothing was changed.`,
    { workflow: wf.name, path: wf.path, recorded: recorded.join(", "), now: now.join(", ") },
  );
});

export const resumeRun = Effect.fn("operations.resumeRun")(function* (
  env: PluginEnv,
  run: Run,
  requestId: string,
) {
  if (yield* isHomeDirectory(env.stateDir, run.record.cwd))
    return err(
      "needs_input",
      "This Run points at Collie Home, not a project. Start a new Run with --workspace <id> or COLLIE_CWD=/path/to/project; resuming would reuse the wrong directory.",
    );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The ownership check is a look, not a claim. Two resumes could both find no owner, both
  // reset the Steps and save `running`, and the loser's snapshot could then land on
  // top of a Run the winner had already begun advancing. This lock is what makes the
  // look and the reset one decision.
  const lock = path.join(run.dir, "resume.lock");
  return yield* withLock(
    lock,
    Effect.fail(new Error(`another resume of run "${run.id}" is in progress`)),
    Effect.gen(function* () {
      // Ownership, not just liveness: a claim whose identity could not be read is not
      // permission to start a second Driver. Re-checked here rather than trusted from
      // whatever the caller was shown, which may be minutes old.
      const owner = yield* driverOwnership(run.dir);
      if (owner === "live") return err("run_already_active", `Run "${run.id}" is already active.`);
      if (owner === "unknown")
        return err(
          "run_already_active",
          `Whether a Driver still owns run "${run.id}" could not be determined; stop it explicitly before resuming.`,
        );
      // The Driver is not the only thing that can still be working in this worktree.
      // Resuming resets every unfinished Step, so an agent one of them started and
      // herdr still has running would find its Step restarted underneath it — and an
      // agent herdr could not be asked about is not evidence that nothing is there.
      const agents = yield* new Herdr(env).agentsAlive(runningAgents(run.record));
      if (agents === "live")
        return err(
          "run_already_active",
          `Run "${run.id}" still has a live agent; stop it before resuming.`,
        );
      if (agents === "unverified")
        return err(
          "run_already_active",
          `Whether run "${run.id}" still has a live agent cannot be verified; retry when herdr is reachable.`,
        );
      if ((yield* runStatus(run)) === "succeeded" && !stillFanningOut(run))
        return err("invalid_state", `Run "${run.id}" has already succeeded.`);
      // A Run with no frozen definition resolves from whatever the layers say now, and a
      // resume resets its unfinished steps against that. Where the two no longer agree,
      // resuming would run a workflow this Run never started — so it is refused, and
      // nothing is written: the record is left exactly as the human found it.
      if (run.record.definition === null) {
        const changed = yield* definitionMoved(env, run);
        if (changed !== null) return changed;
      }
      yield* fs.remove(path.join(run.dir, STOPPED), { force: true });
      for (const step of run.record.steps) if (step.status !== "done") step.status = "pending";
      run.record.status = "running";
      run.record.finished_at = null;
      yield* run.save();
      // Recorded in the Run's own directory, as the spec asks: the inbox is where a
      // command and its outcome live, and the Driver this call is about to start is what
      // reads it — `clearPreviousDriver` takes the request id off it before clearing.
      yield* writeInbox(run.dir, { type: "resume", requestId });
      // The reset has already happened and the stop marker is already gone, so a Run
      // handOver could not place would otherwise be worse off than before it was
      // resumed: reported as advancing, driven by nobody, nothing terminal to wait for.
      const undriven = yield* handOver(env, run);
      if (undriven) return undriven.result;
      return ok({ runId: run.id, status: "running" }, `Resumed run ${run.id}.`);
    }),
  );
});

/**
 * The review reaches the merge request as one note, and Collie sends it: asking an
 * agent to repeat a file it has already written is how "verbatim" stops being true.
 * Here rather than in the engine because the Choice and the app's merge-request panel
 * are two callers of one behaviour.
 */
export const postReview = Effect.fn("operations.postReview")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const file = pathService.join(run.dir, REVIEW_FILE);
  if (!(yield* fs.exists(file)))
    return { ok: false, message: `there is no ${REVIEW_FILE} to post` };
  const target = run.record.inputs.target ?? "";
  const mr = parseMrTarget(target);
  if (!mr) return { ok: false, message: `${target || "this run"} is not a merge request` };

  // `--repo` is what lets this work from a directory that is not that checkout.
  const note = yield* shell(
    "glab",
    ["mr", "note", mr.iid, ...repoArgs(mr.project), "--message", yield* fs.readFileString(file)],
    run.record.cwd,
  );
  const where = mr.project ? `${mr.project}!${mr.iid}` : `!${mr.iid}`;
  return note.code === 0
    ? { ok: true, message: `posted the review to ${where}` }
    : { ok: false, message: `glab mr note ${where} failed (exit ${note.code})` };
});

/**
 * A child Run that acts on a finished one's outcome.
 *
 * A finished Run is immutable. There is no mode that reopens one, and nothing here writes
 * to the parent except its `children` list — the follow-up is a Run of its own, with its
 * own Driver, its own Intent and its own record, that happens to build on the same branch
 * and update the same merge request.
 *
 * The worktree guards are what keep that from being a lie about whose tree it is: the
 * checkout has to still be on the branch that Run built, nothing else may be working in
 * it, and it has to be clean unless the human said otherwise. Each refusal names which
 * condition failed, because "cannot" is not a thing anybody can act on.
 */
export const followUp = Effect.fn("operations.followUp")(function* (
  env: PluginEnv,
  parent: Run,
  text: string,
  requestId: string,
  options: { readonly allowDirty?: boolean } = {},
) {
  const status = yield* runStatus(parent);
  if (!runSettled(status))
    return err(
      "invalid_state",
      `Run "${parent.id}" is ${status}; a follow-up is for one that has finished.`,
      {
        run: parent.id,
      },
    );

  const worktree = parent.record.worktree;
  const cwd = worktree?.path ?? parent.record.cwd;
  if (worktree !== null) {
    const refusal = yield* worktreeRefusal(env, worktree, options.allowDirty === true);
    if (refusal !== null) return err("invalid_state", refusal, { run: parent.id });
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reports = yield* readDrift(parent.dir).pipe(Effect.catch(() => Effect.succeed([])));
  const open = openReports(reports);

  // The steps `implement` has, not a copy: a workflow that later gains or loses one would
  // give the follow-up a status, cards and a board row naming steps nobody ran.
  const prepared = yield* prepareWorkflow(env, "implement");
  if (!prepared.ok) return prepared;

  const child = yield* new RunStore(env.stateDir).create({
    workflow: "implement",
    cwd,
    session: env.socketPath,
    workspace: parent.record.workspace,
    task: parent.record.task,
    workspaceLabel: parent.record.workspace_label,
    workspaceWorktree: parent.record.workspace_worktree,
    worktree,
    inputs: { plan: `followup:${parent.id}`, plan_kind: "followup" },
    inputSources: { plan: `follow-up of ${parent.id}` },
    definition: prepared.workflow,
    approvedVerifications: yield* approvedFrom({ cwd: env.cwd, configDir: env.configDir }),
    stepIds: prepared.workflow.steps.map((step) => step.id),
    stepSummaries: stepSummaries(prepared.workflow),
    maxIterations: parent.record.max_iterations,
    namedAfter: parent.record.named_after ?? parent.record.slug,
    parent: parent.id,
  });

  // The spec the child builds from: what the human said, and what was still open. Written
  // into the child's own plan directory, because a finished Run's is not ours to write.
  yield* fs.makeDirectory(path.join(child.dir, "plan", "issues"), { recursive: true });
  yield* fs.writeFileString(
    path.join(child.dir, "plan", "SPEC.md"),
    [
      `# Follow-up to ${parent.id}`,
      "",
      text,
      "",
      ...(open.length === 0
        ? ["No drift was left open; this follow-up is what the human asked for and nothing else."]
        : [
            "## Still open when that run finished",
            "",
            ...open.map(
              (report) =>
                `- ${report.constraint} (${report.severity}): ${report.evidence
                  .map((ref) => ref.path ?? ref.excerpt ?? ref.kind)
                  .join(", ")}`,
            ),
          ]),
      "",
    ].join("\n"),
  );

  const intent = yield* readIntent(parent.dir).pipe(Effect.catch(() => Effect.succeed(null)));
  if (intent !== null)
    yield* writeIntent(
      child.dir,
      propagate(
        intent,
        seedIntent(child.id, { runVerification: child.record.approved_verifications }),
      ).intent,
    );

  // The one write to a finished Run: without it the follow-up is invisible from the thing
  // it follows up, which is where anybody looking for it would start.
  parent.record.children.push(child.id);
  yield* parent.save();
  yield* child.log(`follow-up of ${parent.id}`);

  const undriven = yield* handOver({ ...env, cwd }, child);
  if (undriven) return undriven.result;
  return ok(
    { runId: child.id, parent: parent.id },
    `Started ${child.id} as a follow-up to ${parent.id}.`,
  );
});

/** Why this checkout cannot be reused, or null. Each answer names its own condition. */
const worktreeRefusal = Effect.fn("operations.worktreeRefusal")(function* (
  env: PluginEnv,
  worktree: WorktreeRecord,
  allowDirty: boolean,
) {
  const branch = yield* shell("git", ["rev-parse", "--abbrev-ref", "HEAD"], worktree.path);
  if (branch.code !== 0) return `${worktree.path} is not a checkout any more`;
  if (branch.stdout.trim() !== worktree.branch)
    return `${worktree.path} is on ${branch.stdout.trim()}, not ${worktree.branch}`;

  const live = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
  const busy = live.some((agent) => agent.paneId === worktree.root_pane_id);
  if (busy) return `an agent is still working in ${worktree.path}`;

  if (allowDirty) return null;
  const dirty = yield* shell("git", ["status", "--porcelain"], worktree.path);
  return dirty.stdout.trim() === ""
    ? null
    : `${worktree.path} has uncommitted changes; pass --allow-dirty to build on them anyway`;
});

// ---------------------------------------------------------------------------
// What a confirmed action actually does
// ---------------------------------------------------------------------------

/**
 * The action kinds this module owns, registered at import time. Registering them here
 * rather than in the proposal machinery is what keeps `executors.ts` empty of stubs: an
 * action kind exists as something that happens, or it does not exist at all.
 *
 * Each one goes through the same operation a human's own command goes through, so a
 * confirmed proposal and a typed command are the same act with the same records.
 */
export const registerRunExecutors = Effect.fn("operations.registerRunExecutors")(function* (
  env: PluginEnv,
  /**
   * What a board does about a `navigate`: put the target on screen. Supplied by the
   * Control Plane and by nothing else, because `navigate` is a Selection change and a
   * CLI has no Selection — a `confirm` there names the target and stops (SPEC §7.6).
   * Nothing here focuses a pane: only a pending question does that.
   */
  opts: { readonly navigate?: (target: { run: string; agent?: string }) => void } = {},
) {
  // Once per process. A front door calls this before it looks an executor up, and two
  // calls in one process would be the same module claiming an action kind twice.
  if (registeredKinds().length > 0) return;
  const store = new RunStore(env.stateDir);
  const load = (id: string) => store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
  const failed = (note: string): ExecutionResult => ({ state: "failed", note });
  const settled = (result: OpResult | Failure): ExecutionResult =>
    result.ok ? { state: "applied", note: result.human } : failed(result.error.message);

  const onRun = (
    id: string,
    what: (
      run: Run,
      requestId: string,
    ) => Effect.Effect<OpResult | Failure, CollieError, BunServices>,
  ) =>
    Effect.gen(function* () {
      const run = yield* load(id);
      if (run === null) return failed(`no Run "${id}"`);
      const requestId = yield* newRequestId();
      return settled(yield* what(run, requestId));
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause)))));

  registerExecutor("stop", (action) =>
    onRun(action.run, (run, id) => stopRun(env.stateDir, new Herdr(env), run, id)),
  );
  registerExecutor("resume", (action) => onRun(action.run, (run, id) => resumeRun(env, run, id)));
  registerExecutor("answer", (action) =>
    onRun(action.run, (run, id) => answerRun(run, action.answer, id, action.choiceId)),
  );
  registerExecutor("hold", (action) =>
    onRun(action.run, (run, id) =>
      Effect.gen(function* () {
        const until =
          action.until === undefined
            ? null
            : untilFrom(action.until, yield* Clock.currentTimeMillis);
        return yield* holdRun(run, "steered", id, until);
      }),
    ),
  );
  registerExecutor("release", (action) =>
    onRun(action.run, (run, id) => releaseRun(run, "steered", id)),
  );
  registerExecutor("clear_override", (action, by) =>
    onRun(action.run, (run) => clearOverride(env.stateDir, new Herdr(env), run, action.agent, by)),
  );
  registerExecutor("deliver", (action) =>
    Effect.gen(function* () {
      const run = yield* load(action.run);
      if (run === null) return failed(`no Run "${action.run}"`);
      const herdr = new Herdr(env);
      const live = yield* herdr.agentList().pipe(Effect.catch(() => Effect.succeed([])));
      const incarnation = live.find((a) => a.name === action.agent)?.terminalId ?? null;
      if (incarnation === null)
        return failed(`herdr has no live agent "${action.agent}" to address`);
      const requestId = yield* newRequestId();
      const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
      const intentVersion = intent?.version ?? 0;
      const cause = { kind: "steer" as const, ref: requestId };

      // `now` and `interrupt` go into the pane from here: herdr types them, the
      // Dispatcher's ledger lock keeps the Driver's own sends out of the way, and the
      // ledger line is what `collie_receipts` reads. Waiting for the Driver's poll bought
      // nothing but the wait. Only a boundary delivery is the Driver's — it is composed
      // into a prompt only the Driver builds.
      const step = run.record.steps.find((s) => s.variants.some((v) => v.agent === action.agent));
      const variant = step?.variants.find((v) => v.agent === action.agent);
      if (action.mode !== "boundary" && step && variant) {
        const deps = {
          stateDir: env.stateDir,
          herdr,
          log: (line: string) => run.log(line).pipe(Effect.ignore),
        };
        const { entry, reason } = yield* entryFromLive(deps, {
          role: step.id,
          agent: action.agent,
          paneId: variant.paneId,
          workspaceId: null,
          runId: run.id,
          workflow: run.record.workflow,
        });
        if (entry === null) return failed(reason);
        const draft = {
          run: run.id,
          harness: variant.harness,
          cause,
          mode: action.mode,
          intentVersion,
          attempt: 1,
          requestId,
        };
        const outcome = yield* transaction(deps, entry, (channel) =>
          action.mode === "interrupt"
            ? interrupt(
                {
                  ...deps,
                  status: (agent) =>
                    herdr.agentStatus(agent).pipe(Effect.catch(() => Effect.succeed("unknown"))),
                },
                channel,
                entry,
                action.text,
                draft,
              )
            : channel.submit(action.text, draft),
        ).pipe(
          Effect.catchTag("NotDeliverable", (cause) =>
            Effect.succeed({
              ok: false as const,
              id: null,
              reason: "failed",
              detail: cause.reason,
            }),
          ),
        );
        if (outcome.ok)
          return {
            state: "applied" as const,
            note: `sent to ${action.agent} now (${outcome.submission}); see collie_receipts`,
          };
        // A harness never shown to take a message mid-turn gets it the one way every
        // harness does — in front of its next prompt — rather than losing the steer.
        if (!outcome.detail.startsWith("capability_unproven"))
          return failed(`${outcome.reason}: ${outcome.detail}`);
        yield* run.log(`${action.mode} delivery ${requestId}: ${outcome.detail}, queued instead`);
      }

      yield* writeInbox(run.dir, {
        type: "deliver",
        requestId,
        deliver: {
          deliveryId: requestId,
          incarnation,
          agent: action.agent,
          text: action.text,
          mode: "boundary",
          cause,
          intentVersion,
          attempt: 1,
        },
      });
      return {
        state: "applied" as const,
        note: `queued for ${run.id}'s Driver to put in front of ${action.agent}'s next prompt`,
      };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("navigate", (action) =>
    Effect.sync(() => {
      opts.navigate?.({ run: action.run, agent: action.agent });
      const where = [action.run, action.agent].filter((part) => part !== undefined).join(" · ");
      return { state: "applied" as const, note: where };
    }),
  );
  registerExecutor("update_intent", (action, by) =>
    Effect.gen(function* () {
      const run = yield* load(action.run);
      if (run === null) return failed(`no Run "${action.run}"`);
      const requestId = yield* newRequestId();
      // The version check and the write under one lock: read outside it, two
      // confirmations both pass the check and the later rename erases the earlier.
      const next = yield* withRunLock(
        run.dir,
        Effect.gen(function* () {
          const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
          if (intent === null)
            return { ok: false, why: `Run "${action.run}" has no Intent to amend` } as const;
          if (intent.version !== action.base_version)
            return {
              ok: false,
              why: `the Intent is v${intent.version}, not v${action.base_version}`,
            } as const;
          // A constraint is taken in the human's own words — a `semantic` one, because
          // nothing a model writes is a rule Collie can check by itself. The other two
          // amendments take the patch as the goal, and as the constraint's id.
          const amended = amendIntent(
            intent,
            action.change === "set-goal"
              ? { kind: "set-goal", goal: action.patch }
              : action.change === "remove-constraint"
                ? { kind: "remove-constraint", id: action.patch }
                : {
                    kind: "add-constraint",
                    constraint: {
                      id: constraintId(action.patch),
                      kind: "semantic",
                      text: action.patch,
                      severity: "warn",
                      source: "human",
                    },
                  },
            by,
            yield* nowIso(),
          );
          yield* writeIntentHeld(run.dir, amended);
          return { ok: true, amended } as const;
        }),
      );
      if (!next.ok) return failed(next.why);
      const { amended } = next;
      yield* writeInbox(run.dir, { type: "intent_changed", requestId, version: amended.version });
      return { state: "applied" as const, note: `intent v${amended.version}` };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("followup", (action) =>
    onRun(action.run, (run, id) => followUp(env, run, action.text, id)),
  );
  // Through the same two steps `run start` takes, so a confirmed proposal and a typed
  // command settle Inputs the same way. An Input the action did not name is refused
  // rather than guessed: nobody is here to be asked, and a Run started on an inferred
  // work source is a Run about something the human never said.
  registerExecutor("start", (action) =>
    Effect.gen(function* () {
      // Where the work is. A launch that named a workspace roots in that workspace's
      // checkout; one that named none roots where the caller is, as `run start` does.
      // Never the Home's directory, which is Collie's namespace and nobody's repository.
      const where = yield* workspaceNamed(env, action.workspace);
      if (where !== null && "error" in where) return failed(where.error);
      const rooted =
        where === null
          ? env
          : { ...env, cwd: where.found.cwd, workspaceId: where.found.workspaceId };
      const prepared = yield* prepareWorkflow(rooted, action.workflow);
      if (!prepared.ok) return failed(prepared.error.message);
      const given = yield* settleGiven(rooted, prepared, {
        inputs: action.inputs,
        decide: Object.entries(action.decisions ?? {}).map(([step, title]) => `${step}=${title}`),
      });
      if (!given.ok) return failed(given.error.message);
      const started = yield* startRun(rooted, {
        workflow: prepared.workflow,
        resolutions: prepared.resolutions,
        decisions: given.decisions,
        workspace: where === null ? null : where.found,
        note: "started by a request",
      });
      if (started._tag === "Rejected") return failed(started.result.error.message);
      return {
        state: "applied" as const,
        note: `${started.run.id} on ${started.checkout.branch ?? started.run.record.cwd}`,
      };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  // One workspace's standing constraints. Explicit requests update these defaults;
  // worker output does not change what future Runs are held to.
  registerExecutor("update_defaults", (action) =>
    Effect.gen(function* () {
      // The named workspace's scope, never this process's. A Run reads its defaults under
      // the workspace it was started in; the board confirming a proposal is in the Home,
      // and writing there would be writing a file no Run opens.
      const where = yield* workspaceNamed(env, action.workspace);
      if (where === null) return failed("update_defaults has to name a workspace");
      if ("error" in where) return failed(where.error);
      const scope = {
        session: env.socketPath,
        workspaceId: where.found.workspaceId,
        cwd: where.found.cwd,
      };
      const file = yield* defaultsPath(env.stateDir, scopeKey(scope));
      const current = (yield* readDefaults(file)) ?? EMPTY_DEFAULTS;
      if (action.change === "remove-constraint") {
        // By id, and refused when nothing has it: ids are a hash of the text, so a
        // constraint named in prose matches none — and reporting that as applied would
        // tell the human a standing constraint was dropped that is still there.
        if (!current.constraints.some((c) => c.id === action.text))
          return failed(
            `no default constraint "${action.text}" in ${where.found.workspaceId}; remove one by the id \`collie_installation\` lists`,
          );
        const next = {
          ...current,
          constraints: current.constraints.filter((c) => c.id !== action.text),
        };
        yield* writeDefaults(file, next);
        return { state: "applied" as const, note: describeDefaults(next) };
      }
      const parsed = parseConstraint(action.text, "warn");
      if ("error" in parsed) return failed(parsed.error);
      // Filed as what it is: a default, not something a human typed for one Run.
      const constraint = { ...parsed, source: "workspace-default" as const, since: 1 };
      const next = {
        ...current,
        constraints: [...current.constraints.filter((c) => c.id !== constraint.id), constraint],
      };
      yield* writeDefaults(file, next);
      return { state: "applied" as const, note: describeDefaults(next) };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("fork_definition", (action) =>
    Effect.gen(function* () {
      const layer = action.layer ?? "user";
      const available = yield* layers(env);
      const defs = yield* loadDefinitions(available);
      const wf = action.what === "workflow" ? defs.workflows.get(action.name) : undefined;
      const found = wf ?? (action.what === "persona" ? defs.personas.get(action.name) : undefined);
      if (!found) return failed(`No ${action.what} "${action.name}".`);
      const result = yield* forkResolvedDefinition(
        {
          path: found.path,
          kind: action.what === "workflow" ? "workflows" : "personas",
          steps: wf?.steps.map((step) => step.id) ?? [],
          body: found.body,
        },
        available[layer].dir,
        // A persona is one body, so it is always taken whole; a workflow follows its
        // parent unless the request said to copy it.
        { name: action.as, full: action.what === "persona" || action.mode === "copy" },
      );
      return result.ok
        ? { state: "applied" as const, note: `forked to ${result.path}` }
        : failed(result.message);
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("home_cleanup", () =>
    Effect.gen(function* () {
      const herdr = new Herdr(env);
      const panes = yield* herdr.paneList();
      // Only the panes that are Collie's alone: a legacy pane sharing a tab with
      // something else is left, because taking somebody's window away is not cleanup.
      const { close, listed } = closable(panes);
      for (const paneId of close)
        yield* herdr.paneClose(paneId).pipe(Effect.catch(() => Effect.void));
      return {
        state: "applied" as const,
        note: `closed ${close.length}, left ${listed.length} sharing a tab`,
      };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("upgrade", () =>
    upgrade(env).pipe(
      Effect.map(settled),
      Effect.catch((cause) => Effect.succeed(failed(String(cause)))),
    ),
  );
  yield* Effect.void;
});
