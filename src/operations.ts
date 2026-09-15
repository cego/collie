// What starting, answering, stopping and resuming a Run actually does. Both the CLI
// and the Herdr adapters call these; neither owns the behaviour, so a pane and a
// command cannot drift apart. What stays with each of them is presentation: picking,
// prompting, rendering, and turning a result into text or JSON.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Config, Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { nowIso } from "./time";
import type { PluginEnv } from "./env";
import { Herdr, type AgentInfo, type PaneInfo, type WorkspaceInfo } from "./herdr";
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
import { readRegistry, registryPath, scopeKey, scopeOfRun } from "./registry";
import {
  amend as amendIntent,
  constraintId,
  propagate,
  defaultsPath,
  fromWorkSource,
  readDefaults,
  readIntent,
  seedIntent,
  writeIntent,
  writeIntentHeld,
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
import { MAX_DELIVERY_BYTES } from "./dispatcher";
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
  type WorktreeRecord,
} from "./run";
import { branchListed, checkoutFor, pruneWorktrees, runNames } from "./worktree";
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
) {
  const commandLine = yield* driverCommand(env);
  // A Run in its own worktree is in its own workspace, and the Driver has to open its
  // tabs there rather than in whatever workspace started it.
  const workspace: Record<string, string> = {};
  if (workspaceId) {
    workspace.HERDR_WORKSPACE_ID = workspaceId;
    workspace.HERDR_ACTIVE_WORKSPACE_ID = workspaceId;
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

/** `--decide step=title`, checked against the Workflow rather than taken on trust. */
type ParsedDecisions =
  | { ok: true; decisions: Record<string, string> }
  | { ok: false; error: Failure };

function parseDecide(values: ReadonlyArray<string>, wf: ResolvedWorkflow): ParsedDecisions {
  const decidable = wf.steps.filter((step) => (step.choices?.length ?? 0) > 0);
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
        schema: branchListed(workflow.name, workflow.inputs),
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
  },
) {
  const { workflow, resolutions, workspace } = options;
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
  // A mutating Workflow owns its checkout, keyed by the branch it is about to build,
  // so two of them never share a working tree — or a stash stack.
  const checkout = yield* checkoutFor(herdr, {
    cwd: env.cwd,
    stateDir: env.stateDir,
    workflow: workflow.name,
    name: named.short,
    inputs: inputValues(resolutions),
    sources: inputSources(resolutions),
    workspaceId: workspace?.workspaceId ?? env.workspaceId,
    workspaceLabel: workspace?.label ?? null,
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
  const run = yield* new RunStore(env.stateDir).create({
    workflow: workflow.name,
    cwd: checkout.cwd,
    session: env.socketPath,
    workspace: checkout.workspaceId,
    workspaceLabel: checkout.workspaceLabel,
    workspaceWorktree: checkout.worktree?.path ?? workspace?.worktree ?? null,
    activatedCwd: env.cwd,
    worktree: checkout.worktree,
    inputs: inputValues(resolutions),
    inputSources: inputSources(resolutions),
    decisions: options.decisions,
    definition: workflow,
    approvedVerifications: yield* approvedFrom({ cwd: checkout.cwd, configDir: env.configDir }),
    stepIds: workflow.steps.map((step) => step.id),
    maxIterations: workflow.maxIterations,
    ...runNames(checkout, named),
    parent: options.parent,
  });
  yield* run.log(`created from ${workflow.path} (${workflow.layer} layer)`);
  for (const line of pruned) yield* run.log(`worktrees: ${line}`);
  if (checkout.note) yield* run.log(checkout.note);
  if (options.note) yield* run.log(options.note);
  yield* seedRunIntent(env, run, resolutions, options.intent ?? {});
  const undriven = yield* handOver(env, run);
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
  const key = scopeKey(scopeOfRun(run.record));
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
    goal: named.goal ?? work.goal,
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
export const handOver = Effect.fn("operations.handOver")(function* (env: PluginEnv, run: Run) {
  // The workspace the Run belongs in, which is the one it was activated from unless
  // herdr opened one for its checkout. A Driver inherits the invoking pane's workspace
  // otherwise, and a `--workspace` run would open its tabs wherever it was typed.
  const workspaceId = run.record.workspace;
  const why = yield* spawnDriver(env, run.id, run.record.cwd, workspaceId).pipe(
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
) {
  if (runSettled(yield* runStatus(run)))
    return err("invalid_state", `Run "${run.id}" has already finished.`);
  yield* writeInbox(run.dir, { type: "hold", requestId, reason });
  return ok({ runId: run.id, reason }, `Holding ${run.id}: ${reason}.`);
});

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
  hash: string,
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

  const judged = yield* confirmProposal(file, proposalId, hash, actor, versions);
  if ("refused" in judged) return err("invalid_input", judged.detail, { reason: judged.refused });

  const results: Array<{ index: number; kind: string; state: string; note: string }> = [];
  for (const [index, action] of judged.actions.entries()) {
    const executor = executorFor(action.kind);
    if (!executor) {
      yield* stepSettled(file, proposalId, index, "skipped", "executor_missing");
      results.push({ index, kind: action.kind, state: "skipped", note: "executor_missing" });
      continue;
    }
    const refusal = yield* admissionFor(env, action, judged.proposal);
    if (refusal !== null) {
      yield* stepSettled(file, proposalId, index, "skipped", refusal);
      results.push({ index, kind: action.kind, state: "skipped", note: refusal });
      continue;
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
    // A sequence the human approved as a sequence: what follows a failure was approved on
    // the assumption that the failure did not happen.
    if (outcome.state === "failed") break;
  }
  return {
    ok: true as const,
    data: { proposal: proposalId, results },
    human: results
      .map((r) => `${r.index} ${r.kind}: ${r.state}${r.note ? ` — ${r.note}` : ""}`)
      .join("\n"),
  };
});

/** Everything the proposal assumed, asked again immediately before the action runs. */
const admissionFor = Effect.fn("operations.admissionFor")(function* (
  env: PluginEnv,
  action: Parameters<typeof admit>[0],
  proposal: ProposalRecord,
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
  const bound = proposal.card;
  const now =
    bound === undefined
      ? null
      : revisionOf(yield* fingerprint(run.record.worktree?.path ?? run.record.cwd));
  return admit(action, {
    run: { id: run.id, status: yield* runStatus(run) },
    driverLive: (yield* driverOwnership(run.dir)) === "live",
    pendingChoice: (yield* readChoice(run.dir))?.id ?? null,
    incarnation: agent === null ? null : (live.find((a) => a.name === agent)?.terminalId ?? null),
    proposedIncarnation: agent === null ? null : (proposal.incarnations?.[agent] ?? null),
    intentVersion: intent?.version ?? null,
    proposedIntentVersion: proposal.intent_versions[run.id] ?? null,
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
     * conversation shows and nothing about what the answer may do.
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
  if (target !== null && run === null)
    return err("run_not_found", `No Run "${target}".`, { run: target });

  const journal = yield* conversationPath(env.stateDir, deps.herdKey);
  const roots = (yield* store.list()).map((r) => r.dir);
  const said: NewTurn = { role: options.asked ?? "human", text: options.text };
  yield* append(journal, target === null ? said : { ...said, target }, roots);

  const from = options.from ?? null;
  const pack = yield* evidencePack(env, options.text, run, from, journal);

  // An Intent nobody can decode is not a Run with no constraints. Recorded as `{}`, the
  // proposal would skip the version gate at every later confirmation (SPEC §7.1). Read
  // before the call rather than after it: a Run whose Intent cannot be read is one no
  // proposal can be made about, and finding that out afterwards spends the money first.
  const intent =
    run === null
      ? null
      : yield* readIntent(run.dir).pipe(
          Effect.catch(() => Effect.succeed<Intent | "unreadable">("unreadable")),
        );
  if (intent === "unreadable")
    return err("invalid_state", `${run?.id}'s Intent cannot be read; nothing was proposed.`);

  // Written down as usage — the Herd's, and the Run's where there is one — before the
  // call and after it. Never refused over a count: usage is data, not a quota.
  const budget = yield* budgetPath(env.stateDir, deps.herdKey);
  const callId = yield* newRequestId();
  yield* reserve(budget, { id: callId, run: run?.id ?? null }, deps.limits);

  const asked = yield* evaluate(deps.evaluator, target === null ? "answer" : "proposal", pack);
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

  // Without a target this was a question, and a question gets an answer: read-only, no
  // proposal, nothing to confirm. A model that proposed a change anyway is refused rather
  // than having a target inferred for it from what the human typed.
  if (target === null || run === null) {
    const answer = asked.value;
    if (!("text" in answer))
      return err("invalid_input", "That would change something; name the Run with --target.", {
        code: "target_required",
      });
    yield* append(journal, { role: "collie", text: answer.text, evaluatorCall: callId }, roots);
    return ok({ answer, requestId: options.requestId }, answer.text);
  }

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
    // Nothing a conversation produced runs without the human: see the note above.
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

const evidencePack = Effect.fn("operations.evidencePack")(function* (
  env: PluginEnv,
  question: string,
  run: Run | null,
  card: string | null,
  journal: string,
) {
  const store = new RunStore(env.stateDir);
  const runs = yield* store.list();
  const listed = runs.slice(0, HERD_LINES);
  const lines = [
    "## The question",
    "",
    question,
    "",
    "## Runs in this Herd",
    "",
    ...(yield* Effect.forEach(listed, (item) =>
      Effect.gen(function* () {
        const status = yield* runStatus(item);
        const record = item.record;
        // The same facts the board shows, so Collie and the row a human is looking at
        // cannot tell different stories about one Run.
        const said = [
          `- run ${item.id}: ${record.workflow}, ${status}`,
          `agents ${runningAgents(record).join(", ") || "none"}`,
          `outcome ${record.outcome ?? "unspecified"}`,
        ];
        if (record.evidence_gaps.length > 0)
          said.push(`not proved: ${record.evidence_gaps.join("; ")}`);
        if (record.obstacle !== null) said.push(`in the way: ${record.obstacle}`);
        return said.join(", ");
      }),
    )),
    // Never silently a partial world: a model told about 40 of 200 Runs and not told so
    // would answer "that is all of them" in good faith.
    ...(runs.length > listed.length
      ? [`- (${runs.length - listed.length} more Run(s) not listed here)`]
      : []),
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
    const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
    lines.push(
      "",
      `## Run ${run.id}`,
      "",
      `Goal: ${intent?.goal ?? "(none recorded)"}`,
      `Intent version: ${intent?.version ?? "(none)"}`,
      ...(intent?.constraints ?? []).map(
        (c) => `- constraint ${c.id} (${c.severity}, ${c.source}): ${c.text}`,
      ),
      "",
      "### Steps",
      "",
      ...run.record.steps.map((step) => `- ${step.id}: ${step.status}`),
    );
    const cards = yield* readCards(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
    const recent = cards.slice(-3);
    if (recent.length > 0) {
      lines.push("", "### Cards", "");
      for (const entry of recent) {
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
    }
    if (card !== null) {
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
    workspaceLabel: parent.record.workspace_label,
    workspaceWorktree: parent.record.workspace_worktree,
    worktree,
    inputs: { plan: `followup:${parent.id}`, plan_kind: "followup" },
    inputSources: { plan: `follow-up of ${parent.id}` },
    definition: prepared.workflow,
    approvedVerifications: yield* approvedFrom({ cwd: env.cwd, configDir: env.configDir }),
    stepIds: prepared.workflow.steps.map((step) => step.id),
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
  registerExecutor("hold", (action) => onRun(action.run, (run, id) => holdRun(run, "steered", id)));
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
      const live = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
      const incarnation = live.find((a) => a.name === action.agent)?.terminalId ?? null;
      if (incarnation === null)
        return failed(`herdr has no live agent "${action.agent}" to address`);
      const requestId = yield* newRequestId();
      const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
      // Queued for the Run's own Driver, never sent from here: the Driver is what holds
      // it behind a compaction, composes it into the next work, and records the ack.
      yield* writeInbox(run.dir, {
        type: "deliver",
        requestId,
        deliver: {
          deliveryId: requestId,
          incarnation,
          agent: action.agent,
          text: action.text,
          mode: action.mode,
          cause: { kind: "steer", ref: requestId },
          intentVersion: intent?.version ?? 0,
          attempt: 1,
        },
      });
      return { state: "applied" as const, note: `queued for ${run.id}'s Driver` };
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
          // The patch is a constraint in the human's own words — a `semantic` one,
          // because nothing the evaluator writes is a rule Collie can check by itself.
          const amended = amendIntent(
            intent,
            {
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
      const prepared = yield* prepareWorkflow(env, action.workflow);
      if (!prepared.ok) return failed(prepared.error.message);
      const given = yield* settleGiven(env, prepared, {
        inputs: action.inputs,
        decide: Object.entries(action.decisions ?? {}).map(([step, title]) => `${step}=${title}`),
      });
      if (!given.ok) return failed(given.error.message);
      const started = yield* startRun(env, {
        workflow: prepared.workflow,
        resolutions: prepared.resolutions,
        decisions: given.decisions,
        workspace: null,
        note: "started by a confirmed proposal",
      });
      if (started._tag === "Rejected") return failed(started.result.error.message);
      return {
        state: "applied" as const,
        note: `${started.run.id} on ${started.checkout.branch ?? started.run.record.cwd}`,
      };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  yield* Effect.void;
});
