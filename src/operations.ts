// What starting, answering, stopping and resuming a Run actually does. Both the CLI
// and the Herdr adapters call these; neither owns the behaviour, so a pane and a
// command cannot drift apart. What stays with each of them is presentation: picking,
// prompting, rendering, and turning a result into text or JSON.

import { Config, Crypto, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { nowIso } from "./time";
import type { PluginEnv } from "./env";
import { Herdr, type PaneInfo, type WorkspaceInfo } from "./herdr";
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
import {
  CHOICE,
  driverAlive,
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
import { readRegistry, registryPath, scopeOfRun } from "./registry";
import { currentPid, withLock } from "./lock";
import { REVIEW_FILE } from "./output";
import { fanoutRepos, fanoutUnfinished, Run, RunStore } from "./run";
import { branchListed, BRANCH_INPUT, checkoutFor, pruneWorktrees } from "./worktree";
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
  "target_exists",
  "needs_input",
  "timeout",
  "invalid_state",
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

  yield* settleExplicit(env, resolutions, given.inputs);

  // Nobody is here to be asked; an unsettled Input is the caller's to give.
  const unresolved = resolutions.filter((item) => item.needsAsking || item.candidates);
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
    workflow: workflow.name,
    name: named.short,
    inputs: inputValues(resolutions),
    sources: inputSources(resolutions),
    workspaceId: workspace?.workspaceId ?? env.workspaceId,
    workspaceLabel: workspace?.label ?? null,
    explicit: options.branch,
  });
  // Nothing has been created yet, so a Run that must not share a checkout is simply
  // not started, and the caller is told which branch could not be given one. A refusal
  // the caller could settle — a branch nothing named — comes back in the same shape as
  // any missing Input, so a retry with the same request id and `--input branch=` starts
  // the Run rather than repeating the refusal.
  if (checkout.refused) {
    const { why, ask } = checkout.refused;
    if (!ask) {
      return {
        _tag: "Rejected" as const,
        ask: null,
        result: err("operation_failed", `${workflow.name} could not be given a checkout.`, {
          cause: why,
        }),
      };
    }
    return {
      _tag: "Rejected" as const,
      // The question beside the envelope that carries it: a front door with a human to
      // hand puts it to them rather than digging it back out of the error details.
      ask,
      result: err(
        "needs_input",
        `${workflow.name} needs input.`,
        Schema.decodeUnknownSync(YamlMapSchema)({
          inputs: [{ name: BRANCH_INPUT, candidates: [], question: ask }],
          schema: branchListed(workflow.name, workflow.inputs),
        }),
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
    stepIds: workflow.steps.map((step) => step.id),
    maxIterations: workflow.maxIterations,
    // The branch already resolves what this Run is about, and resolves it without
    // clipping; the Run is named the same way so its slug and its checkout agree.
    namedAfter: checkout.branch ?? named.value,
    slugFrom: checkout.branch ?? named.short,
    parent: options.parent,
  });
  yield* run.log(`created from ${workflow.path} (${workflow.layer} layer)`);
  for (const line of pruned) yield* run.log(`worktrees: ${line}`);
  if (checkout.note) yield* run.log(checkout.note);
  if (options.note) yield* run.log(options.note);
  const undriven = yield* handOver(env, run);
  return undriven
    ? { _tag: "Rejected" as const, ask: null, result: undriven.result }
    : // The checkout as well as the Run: the branch is decided here, and the line that
      // tells the operator what was started is the only place they see it.
      { _tag: "Started" as const, run, checkout };
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
export const answerRun = Effect.fn("operations.answerRun")(function* (
  run: { readonly id: string; readonly dir: string },
  answer: string,
  requestId: string,
) {
  const choice = yield* readChoice(run.dir);
  if (!choice) return err("run_not_waiting", `Run "${run.id}" is not waiting for a Choice.`);
  if ((yield* answeredChoices(run.dir)).has(choice.id))
    return err("choice_already_answered", `Choice "${choice.id}" already has an answer.`);
  // An empty answer is how a menu is dismissed; it leaves the Run open for a resume.
  if (choice.kind === "menu" && answer !== "" && !choice.items.some((item) => item.id === answer)) {
    return err("invalid_answer", `"${answer}" is not a valid answer.`, {
      answers: choice.items.map((item) => item.id),
    });
  }
  yield* writeInbox(run.dir, { type: "answer", requestId, choiceId: choice.id, answer });
  return ok({ runId: run.id, answer }, `Answered ${run.id}: ${answer}.`);
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
export const resumeRun = Effect.fn("operations.resumeRun")(function* (
  env: PluginEnv,
  run: Run,
  requestId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // driverAlive is a look, not a claim. Two resumes could both find no owner, both
  // reset the Steps and save `running`, and the loser's snapshot could then land on
  // top of a Run the winner had already begun advancing. This lock is what makes the
  // look and the reset one decision.
  const lock = path.join(run.dir, "resume.lock");
  return yield* withLock(
    lock,
    Effect.fail(new Error(`another resume of run "${run.id}" is in progress`)),
    Effect.gen(function* () {
      if (yield* driverAlive(run.dir))
        return err("run_already_active", `Run "${run.id}" is already active.`);
      if ((yield* runStatus(run)) === "succeeded" && !stillFanningOut(run))
        return err("invalid_state", `Run "${run.id}" has already succeeded.`);
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
