// What each plugin action does. Actions have no tty, so they only open a pane; the
// interactive work happens in the pane entrypoints. Every question a human answers goes
// through `InputPrompts`, so the same flow draws in a popup pane and inline in the tab.

import { Cause, Clock, Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { currentReports, readDrift } from "./drift";
import { buildBoard, type MrState, type TaskView } from "./board";
import { settleMerges } from "./merges";
import { nowIso } from "./time";
import {
  DENSITIES,
  isDensity,
  isQuestionMode,
  isScope,
  loadDefaults,
  QUESTION_MODES,
  SCOPES,
  writeConfigValue,
} from "./config";
import type { BunServices } from "@effect/platform-bun/BunServices";
import type { PlatformError } from "effect/PlatformError";
import type { SchemaError } from "effect/Schema";
import { COMPACTION_OFF, validThreshold } from "./compaction";
import { herdDir, herdOf, HerdrUnreachable } from "./steering";
import { chatHarnessOf, ensureChatFor } from "./chat";
import { append as appendNews, newsPath } from "./news";
import { eventsIn, readSaid, remember } from "./proactive";
import {
  ensureHomeFor,
  homePath,
  LEGACY_PANE_TOKEN,
  originPath,
  readHome,
  readOrigin,
  TOKEN_TTL_MS,
  writeOrigin,
  UNREADABLE,
} from "./home";
import { liveFor, type Live } from "./live";
import type { IntentUnreadable } from "./intent";
import { ProposalsBusy, type Actor } from "./proposals";
import {
  isStale,
  layers,
  loadDefinitions,
  resolveWorkflow,
  type Definitions,
  type Provenance,
} from "./definitions";
import { executeRun } from "./engine";
import type { PluginEnv } from "./env";
import {
  Herdr,
  type AgentInfo,
  type AgentsAlive,
  type AsksAgents,
  type WorkspaceInfo,
} from "./herdr";
import { confirmLine, resolveCandidates, settle, type InputPrompts, type PickItem } from "./inputs";
import { releaseKeyboard, startKeyboard, takeKey } from "./keys";
import { forkResolvedDefinition, type DefinitionKind } from "./fork";
import { notify } from "./notify";
import { COLLIE_TAB, collieOwns, reason, runLabel, shellQuote, tabLabelsFor } from "./naming";
import { markedFrom, RunStore, type Run, type RunRecord } from "./run";
import { readSnapshot, stepDifference, stepsDiffer } from "./snapshot";
import { pruneWorktrees } from "./worktree";
import { sendReview, sendReviewToImplementer, type Session } from "./handoff";
import {
  acquireDriver,
  clearPreviousDriver,
  stoppedBefore,
  appendProgress,
  driverAlive,
  filePrompts,
  releaseDriver,
  RUNNER_LOG,
  STOPPED,
} from "./driver";
import { scopeFor } from "./registry";
import { recordDisposition, statusLine } from "./disposition";
import { selectionPath, writeSelection } from "./selection";
import { everyViewerPaints } from "./outer";
import { actorName } from "./proposals";
import { listTasks, taskOfWorkspace, type TaskChoice } from "./task";
import {
  answerRun,
  newRequestId,
  prepareWorkflow,
  resolveWorkspace,
  settleExplicit,
  type ExpectedError,
  postReview,
  resumeRun,
  startRun,
  carryOutProposal,
  declineProposal,
  evaluationDeps,
  followUp,
  steer,
  registerRunExecutors,
  workspaceCwdFromPanes,
  runSettled,
  runStatus,
  stopRun as stopRunOperation,
} from "./operations";
import {
  answerFor,
  openingFilter,
  rereads,
  runIdOf,
  type AppState,
  type Command,
} from "./ui/state";
import type { Focus } from "./ui/bridge";
import {
  buildHistory,
  buildRunDetail,
  buildSettings,
  buildWorkflows,
  NUMERIC_DEFAULTS,
  type PlanPanel,
} from "./views";
import { isPermissionMode, PERMISSION_MODES } from "./harness";
import {
  mrDetails,
  mrTarget,
  parseMrTarget,
  parseMrUrl,
  repoArgs,
  shell,
  type MrPanel,
  type Runner,
} from "./mr";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  agentForKey,
  askingRun,
  buildView,
  buildWideView,
  renderRedirect,
  renderWorkspace,
  type Asking,
  type RunRow,
  type WorkspaceView,
} from "./workspace";

export interface ControlSession extends Omit<Session, "herdr"> {
  herdr: Herdr;
  /**
   * What this board last called each tab it reconciled, so a tick that learns nothing
   * new sends no rename. Per Session rather than per process: two boards computing the
   * same label is harmless, and a test's board must not inherit another's memory.
   */
  tabLabels?: Map<string, string>;
  /** This installation, so the board can say when it is behind its remote. */
  pluginRoot: string;
  /** Where the defaults live, so the board can read its own quiet threshold. */
  configDir: string;
  /**
   * What the last worktree sweep said, and whether one is out working right now. A
   * caller that keeps none — a test drawing one board, a view built to be rendered
   * once — sweeps nothing and shows nothing about worktrees.
   */
  pruned?: Pruned;
}

export type Mode = "pick" | "continue" | "resume" | "fork";

/**
 * Where a launch flow is being drawn. Only a popup can close itself, and the tab's
 * inline placement closing "the popup" closed whatever unrelated one the session had
 * open elsewhere.
 */
export type Placement = "popup" | "inline";

const ProblemDetails = Schema.Struct({ problems: Schema.Array(Schema.String) });

export interface AnswerKeyResult {
  asking: Asking;
  note?: string;
}

/** An action: open the popup that does the actual work. */
export const openPicker = Effect.fn("Flows.openPicker")(function* (
  herdr: Herdr,
  env: PluginEnv,
  mode: Mode,
) {
  yield* Console.log(`${mode}: opening the picker in ${env.cwd}`);
  yield* herdr.pluginPaneOpen({
    entrypoint: "picker",
    env: { COLLIE_MODE: mode, COLLIE_CWD: env.cwd },
    focus: true,
  });
  return 0;
});

/**
 * The workspace's Collie tab, from any pane: found or opened, moved to the front and
 * focused. `prefix+1` already lands on it because every run keeps it first, but that is
 * a position rather than a name — and a workspace whose runs all pre-date the tab, or
 * whose tab was closed, has nothing at position one.
 *
 * The finding and opening is the engine's own, not a second copy: two of those is how
 * one workspace ends up with two Collie tabs.
 */
export const boardFlow = Effect.fn("Flows.boardFlow")(function* (herdr: Herdr, env: PluginEnv) {
  const ensured = yield* ensureHomeFor(herdr, env, (line) => Console.error(line));
  if (ensured === null) return 1;
  if (ensured.kind === "ownership_unknown") {
    yield* Console.error(
      [
        `Collie cannot tell which workspace is this Herd's Home: ${ensured.why}.`,
        `Candidates: ${ensured.candidates.join(", ")}`,
        "`collie home reconcile --adopt <id>` or `--forget` settles it.",
      ].join("\n"),
    );
    return 1;
  }
  const home = ensured.record;
  // Where the shortcut was pressed, so the board opens narrowed to the work the human
  // came from. Pressed inside the Home it means the opposite — show me everything — so
  // that is what it records.
  const inHome = env.workspaceId !== null && env.workspaceId === home.workspaceId;
  yield* writeOrigin(yield* originPath(env.stateDir, yield* herdOf(env.socketPath)), {
    workspaceId: inHome ? null : env.workspaceId,
    cwd: env.cwd,
    filter: inHome ? "all" : null,
  });
  // The conversation beside the board, started or found. Reported and never fatal: a
  // harness that will not open costs the human their chat, not their control plane.
  const chat = yield* ensureChatFor(
    herdr,
    env,
    yield* herdOf(env.socketPath),
    home,
    yield* chatHarnessOf(env.configDir),
    (line) => Console.error(line),
  ).pipe(Effect.catch(() => Effect.succeed(null)));
  if (chat?.kind === "unavailable")
    yield* Console.error(`Collie has no native chat: ${chat.why}. The board is unaffected.`);

  // The Home may be another workspace entirely: one Herd has one board (ADR-0009), so
  // reaching it is a workspace switch as well as a tab focus. Neither is what the exit
  // status turns on — a tab that will not focus is still a tab the human can reach.
  yield* Effect.ignore(herdr.workspaceFocus(home.workspaceId));
  if (home.tabId !== null) yield* Effect.ignore(herdr.tabFocus(home.tabId));
  // Focused, so the next thing typed is a question: no mode to enter and no composer to
  // find. The board is reached with ordinary pane controls, as any other pane is.
  if (chat !== null && chat.kind !== "unavailable")
    yield* Effect.ignore(herdr.agentFocus(chat.record.agent));
  return 0;
});

/**
 * The environment a run is rooted in. The board is the Herd's one Home (ADR-0009), and
 * its own directory is Collie's namespace rather than a checkout — so a launch from
 * there asks which workspace the work is in, and roots the Run in that workspace's
 * directory. A launch from anywhere else is already in one.
 *
 * `null` is the human backing out, or being told why a workspace will not do.
 * `WorkspaceInfo` carries no directory of its own on every herdr, so it is resolved from
 * the workspace's worktree and then from its first pane's cwd — never invented.
 */
const rootedWhere = Effect.fn("Flows.rootedWhere")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  const home = key === null ? null : yield* readHome(yield* homePath(env.stateDir, key));
  if (home === null || home === UNREADABLE || env.workspaceId !== home.workspaceId) return env;

  const namespaceDir = key === null ? "" : yield* herdDir(env.stateDir, key);
  const workspaces = (yield* herdr
    .workspaceList()
    .pipe(Effect.catch(() => Effect.succeed([])))).filter(
    (workspace) => workspace.workspaceId !== home.workspaceId,
  );
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const candidates = yield* Effect.forEach(workspaces, (workspace) =>
    Effect.gen(function* () {
      const cwd =
        workspace.cwd !== "" ? workspace.cwd : workspaceCwdFromPanes(workspace.workspaceId, panes);
      return { workspace, cwd, why: yield* whyNotRootable(cwd, namespaceDir) };
    }),
  );
  if (candidates.length === 0) {
    yield* bail(prompts, "No workspace to start a run in: open one on a checkout first.");
    return null;
  }
  const chosen = yield* prompts.menu(
    candidates.map((entry) => ({
      id: entry.workspace.workspaceId,
      title: entry.workspace.label,
      subtitle: entry.why ?? entry.cwd,
    })),
    {
      header: "Which workspace?",
      footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    },
  );
  if (!chosen) return null;
  const picked = candidates.find((entry) => entry.workspace.workspaceId === chosen.id);
  if (!picked) return null;
  if (picked.why !== null) {
    yield* bail(prompts, `${picked.workspace.label}: ${picked.why}`);
    return null;
  }
  // Confirmed on screen before a single Input is asked for: the directory a Run is
  // rooted in is the one thing nothing downstream can put right.
  yield* Console.log(`Starting in ${picked.cwd}`);
  return { ...env, workspaceId: picked.workspace.workspaceId, cwd: picked.cwd };
});

/** Why a workspace's directory will not root a Run, or null when it will. */
const whyNotRootable = Effect.fn("Flows.whyNotRootable")(function* (
  cwd: string,
  namespaceDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (cwd === "") return "herdr names no directory for it";
  if (namespaceDir !== "" && cwd === namespaceDir) return "that is Collie's own namespace";
  return (yield* fs.exists(cwd)) ? null : "its directory is not on disk";
});

function banner(defs: Definitions): string | undefined {
  if (defs.errors.length === 0) return undefined;
  return ["Definitions with errors (skipped):", ...defs.errors.map((e) => `  ${e}`)].join("\n");
}

/**
 * How a flow asks. The popup and the tab hand in different implementations of the same
 * interface, and this is the only thing any of these flows knows about either.
 */
export type FlowPrompts = InputPrompts;

/**
 * Continue a Task: another Workflow, or another go at the same one, inside the Task
 * that work already belongs to. Explicit, because a fresh start is what everything
 * else is — inside a Task's own workspace that Task is meant, and from anywhere else
 * the human says which, because no label can say it for them.
 */
export const continueFlow = Effect.fn("Flows.continueFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  placement: Placement = "popup",
) {
  const here = yield* taskOfWorkspace(env.stateDir, env.workspaceId);
  const task = here ?? (yield* pickTask(env, prompts));
  if (task === null) return 0;
  return yield* pickFlow(herdr, env, prompts, placement, { mode: "continue", task });
});

/** Which Task, when this is not one's workspace. Null is the human backing out. */
const pickTask = Effect.fn("Flows.pickTask")(function* (env: PluginEnv, prompts: FlowPrompts) {
  const tasks = yield* listTasks(env.stateDir);
  if (tasks.length === 0) {
    yield* bail(prompts, "No tasks yet: starting a workflow makes one.");
    return null;
  }
  const chosen = yield* prompts.menu(
    tasks.map((task) => ({ id: task.id, title: task.label, subtitle: task.cwd })),
    {
      header: "Which task?",
      footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    },
  );
  return tasks.find((task) => task.id === chosen?.id) ?? null;
});

export const pickFlow = Effect.fn("Flows.pickFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  placement: Placement = "popup",
  task: TaskChoice = { mode: "new" },
) {
  const layerList = yield* layers(env);
  const defs = yield* loadDefinitions(layerList);

  const items: PickItem[] = [...defs.workflows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wf) => ({ id: wf.name, title: wf.title, subtitle: layerOf(wf) }));

  if (items.length === 0) {
    return yield* bail(
      prompts,
      "No workflows found. Check the plugin's workflows/ directory.",
      banner(defs),
    );
  }

  const chosen = yield* prompts.menu(items, {
    header: headed(`Workflows — ${env.cwd}`, banner(defs)),
    footer: "↑↓ move · type to filter · Enter run · Esc cancel",
  });
  if (!chosen) return 0;

  yield* startChosen(herdr, env, prompts, { workflow: chosen.id, placement, task });
  return 0;
});

/**
 * A Workflow that has already been named, from its Inputs to a started Run. The half of
 * the launch flow after the name, because there are two ways to arrive here: the picker,
 * which asks which Workflow first, and a row action in the tab, which named one by being
 * clicked. That second one used to hand off to the picker pane, so it asked for a
 * Workflow again — and could start a different one from the row that was clicked.
 *
 * Returns the line to show, or `null` where the human backed out or was told why not.
 */
const startChosen = Effect.fn("Flows.startChosen")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: {
    workflow: string;
    placement: Placement;
    /** Inputs the caller has already settled, which are not asked for again. */
    given?: Record<string, string>;
    parent?: Run;
    /** The Task this start belongs to; a fresh one unless the caller named it. */
    task?: TaskChoice;
  },
) {
  // A run starts in a checkout, and the Home has none: it is Collie's own namespace
  // directory, so a Run rooted there would have nothing to work on. Asked once, before
  // anything else, because every Input after it is resolved against the answer.
  const at = yield* rootedWhere(herdr, env, prompts);
  if (at === null) return null;
  const task = opts.task ?? { mode: "new" };
  // Resolving, validating and inferring is what `collie run start` does too.
  const prepared = yield* prepareWorkflow(
    at,
    opts.workflow,
    task.mode === "continue" ? task.task : null,
  );
  if (!prepared.ok) {
    yield* bail(prompts, whyNotRunnable(opts.workflow, prepared.error));
    return null;
  }
  const resolved = prepared.workflow;
  const resolutions = prepared.resolutions;
  // What the caller already knows is not a question: a fix round arrives with its plan
  // directory settled, and re-asking for it would let the human contradict the row. The
  // operation layer's own settler, because a given value owes the prompts its kind —
  // `implement` branches on `plan_kind`, and a hand-rolled settle here recorded none.
  yield* settleExplicit(at, resolutions, opts.given ?? {});
  // An embedded workflow's inputs belong to the run that embeds it, which never asks.
  const embedded = new Set(resolved.embeddedInputs);
  for (const r of resolutions) {
    // An Input with candidates is chosen from what this repo offers, not typed blind.
    if (r.candidates && !embedded.has(r.name)) {
      if (!(yield* resolveCandidates(r, prompts))) return null;
      continue;
    }
    if (!r.needsAsking) continue;
    const answer = yield* prompts.ask(r.question);
    if (answer === null) return null;
    const value = answer.trim();
    if (value === "") {
      yield* bail(prompts, `${resolved.name} needs an input for "${r.name}".`);
      return null;
    }
    settle(r, { value, source: "asked" });
  }

  // No decision menu here: a Choice is asked when the run reaches it, with the work it
  // decides about in front of the human. `run start --decide` is the one pre-answer,
  // for a Run nobody is going to be there for.
  //
  // No confirmation either: the human picked the workflow and answered its Inputs, and
  // Esc at any of those already cancelled. The line is the note.
  const line = confirmLine(resolved.name, resolutions);

  const start = {
    workflow: resolved,
    resolutions,
    workspace: yield* resolveWorkspace(herdr, at).pipe(Effect.catch(() => Effect.succeed(null))),
    note: line,
    parent: opts.parent?.id,
    task,
  };
  const started = yield* startRun(at, start);
  if (started._tag === "Rejected") {
    yield* bail(prompts, started.result.error.message);
    return null;
  }
  const parent = opts.parent;
  if (parent) {
    parent.record.children.push(started.run.id);
    yield* parent.save();
  }
  // Only a popup can close itself; running the picker in a plain pane is fine..
  if (opts.placement === "popup") yield* Effect.ignore(herdr.popupClose());
  // The branch is settled by starting, so the line the human is shown says it — a
  // derived branch is a decision they did not make and would otherwise not see.
  return confirmLine(resolved.name, resolutions, {
    name: started.checkout.branch,
    source: started.checkout.branchSource,
  });
});

/**
 * The same failure the CLI reports as one line plus `details`, as the several lines a
 * pane has room for. Validation problems are the only detail worth spelling out.
 */
function whyNotRunnable(workflow: string, error: ExpectedError): string {
  const detail = Schema.decodeUnknownOption(ProblemDetails)(error.details);
  if (Option.isNone(detail)) return error.message;
  return [`${workflow} is not runnable:`, ...detail.value.problems.map((p) => `  ${p}`)].join("\n");
}

export const forkFlow = Effect.fn("Flows.forkFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
) {
  const layerList = yield* layers(env);
  const defs = yield* loadDefinitions(layerList);
  const sources = new Map<
    string,
    { kind: DefinitionKind; path: string; steps: string[]; body: string }
  >();
  const items: PickItem[] = [];

  for (const wf of [...defs.workflows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    sources.set(`workflow:${wf.name}`, {
      kind: "workflows",
      path: wf.path,
      steps: wf.steps.map((step) => step.id),
      body: wf.body,
    });
    items.push({ id: `workflow:${wf.name}`, title: `workflow ${wf.name}`, subtitle: layerOf(wf) });
  }
  for (const persona of [...defs.personas.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    sources.set(`persona:${persona.name}`, {
      kind: "personas",
      path: persona.path,
      steps: [],
      body: persona.body,
    });
    items.push({
      id: `persona:${persona.name}`,
      title: `persona ${persona.name}`,
      subtitle: layerOf(persona),
    });
  }

  if (items.length === 0) return yield* bail(prompts, "Nothing to fork.", banner(defs));

  const chosen = yield* prompts.menu(items, {
    header: headed("Fork a definition", banner(defs)),
    footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
  });
  if (!chosen) return 0;

  const targets: PickItem[] = [
    { id: "user", title: "my layer", subtitle: layerList.user.dir },
    { id: "project", title: "this project", subtitle: layerList.project.dir },
  ];
  const target = yield* prompts.menu(targets, {
    header: `Fork ${chosen.title} into`,
    footer: "↑↓ move · Enter fork · Esc cancel",
  });
  if (!target) return 0;

  const source = sources.get(chosen.id)!;
  const how = yield* prompts.menu(
    [
      {
        id: "extends",
        title: "change one part",
        subtitle: "extends the original; everything else follows it",
      },
      { id: "full", title: "a full copy", subtitle: "stops following the original" },
    ],
    { header: `Fork ${chosen.title} how`, footer: "↑↓ move · Enter fork · Esc cancel" },
  );
  if (!how) return 0;

  // A stub needs to name something, or there is nothing in the file to edit.
  let step: string | undefined;
  if (how.id === "extends" && source.steps.length > 0) {
    const which = yield* prompts.menu(
      source.steps.map((id) => ({ id, title: id })),
      {
        header: `Which step of ${chosen.title}`,
        footer: "↑↓ move · Enter choose · Esc cancel",
      },
    );
    if (!which) return 0;
    step = which.id;
  }

  const dir = target.id === "user" ? layerList.user.dir : layerList.project.dir;
  const result = yield* forkResolvedDefinition(source, dir, {
    full: how.id === "full",
    step,
  });
  return yield* notice(prompts, `${chosen.title}: ${result.message}`, result.ok ? 0 : 1);
});

/** The layer a definition came from, and whether a full copy has fallen behind. */
function layerOf(def: Provenance): string {
  const parts = [`[${def.layer}]`];
  if (def.extends) parts.push(`extends ${def.extends}`);
  // A full copy whose parent has moved on is not the fork you took.
  if (isStale(def)) parts.push("(stale — the original has changed since this copy)");
  return parts.join(" ");
}

export const resumeFlow = Effect.fn("Flows.resumeFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  placement: Placement = "popup",
) {
  const store = new RunStore(env.stateDir);
  // A run something is still driving is not a run to resume: a second driver would
  // fight the first over the same agents and the same run record.
  const runs = [];
  for (const run of yield* store.resumable()) {
    if (!(yield* driverAlive(run.dir))) runs.push(run);
  }
  if (runs.length === 0)
    return yield* bail(prompts, "No runs with unfinished steps that nothing is already driving.");

  const items: PickItem[] = runs.map((run) => {
    const left = run
      .unfinished()
      .map((s) => s.id)
      .join(", ");
    return {
      id: run.id,
      title: run.record.slug,
      subtitle: `${run.record.status} · left: ${left} · ${run.record.created_at.slice(0, 16).replace("T", " ")}`,
    };
  });

  const chosen = yield* prompts.menu(items, {
    header: "Resume a run",
    footer: "↑↓ move · type to filter · Enter resume · Esc cancel",
  });
  if (!chosen) return 0;

  const run = yield* store.load(chosen.id);
  const resumed = yield* resumeRun(env, run, yield* newRequestId());
  if (!resumed.ok) return yield* bail(prompts, `${run.record.slug}: ${resumed.error.message}`);
  // Only a popup can close itself; running the picker in a plain pane is fine..
  if (placement === "popup") yield* Effect.ignore(herdr.popupClose());
  return 0;
});

/**
 * The run driver. No terminal, no pane: it writes what it is doing into the run
 * dir and asks its questions there, and the Control Plane is what renders both.
 * Everything it can say about a failure goes into `runner.log`.
 */
export const driveFlow = Effect.fn("Flows.driveFlow")(function* (herdr: Herdr, env: PluginEnv) {
  const maybeRunId = yield* Config.option(Config.string("COLLIE_RUN"));
  if (maybeRunId._tag === "None") {
    yield* Console.error("COLLIE_RUN is not set; a driver is started by the picker.");
    return 2;
  }
  const runId = maybeRunId.value;
  const store = new RunStore(env.stateDir);
  const run = yield* store.load(runId);
  // The record, not the caller: a detached Driver inherits the invoking pane's
  // workspace and directory, so a `--workspace` run would otherwise open its tabs,
  // register its agents and root its work wherever the command was typed.
  env = {
    ...env,
    cwd: run.record.cwd,
    workspaceId: run.record.workspace ?? env.workspaceId,
  };
  herdr = new Herdr(env);
  const out = (line: string) => appendProgress(run.dir, line);

  const drive = Effect.gen(function* () {
    // Atomic: acquiring is the check. A separate liveness test then a write would
    // let two resumes race past each other and drive the same run twice.
    if (!(yield* acquireDriver(run.dir))) {
      yield* out("a driver is already running this run; this one is stopping");
      return 1;
    }
    /**
     * A stop that landed before this Driver claimed the Run. `stopRun` writes its inbox
     * command, sees no owner in the window between the spawn and the claim, and records
     * the stop itself — so it has already reported success and closed the panes. Driving
     * on would overwrite that with `running` and start agents nobody is expecting, and
     * clearing the inbox below would remove the other half of the request too.
     */
    if (yield* stoppedBefore(run.dir)) {
      yield* releaseDriver(run.dir);
      yield* out("stopped before this driver started; nothing was run");
      return 0;
    }
    // This Driver owns the Run now, so nothing the last one left in the run dir is
    // addressed to it — except the resume that asked for it, which it records.
    const resumedBy = yield* clearPreviousDriver(run.dir);
    if (resumedBy) yield* out(`resumed by request ${resumedBy}`);

    /**
     * `collie run stop` sends SIGTERM, and the runtime's `runMain` answers it by
     * interrupting this fibre. Racing a native SIGTERM handler against the run lost
     * that race every time the marking had anything to await: the interruption tore
     * the race down first, and only the finalisers ran — claim released, record still
     * `running`, and the board calling a stopped run abandoned. So the marking is a
     * finaliser too. A finished or failed run has already left `running` by the time
     * it runs, so only an interruption reaches the write.
     */
    const markStoppedIfInterrupted = Effect.gen(function* () {
      if (run.record.status !== "running") return;
      const stoppedAt = yield* nowIso();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(run.dir, STOPPED), `${stoppedAt}\n`);
      run.record.status = "blocked";
      run.record.finished_at = stoppedAt;
      yield* run.save();
      yield* out("stopped");
    }).pipe(Effect.ignore);

    // Effect.catch and Effect.ensuring, not try/catch/finally: a typed failure out of
    // executeRun unwinds past both without entering either, which left the Run marked
    // `running` with no Driver, nothing in the log, and `collie run wait` blocking to
    // its timeout — with the ownership claim never given back.
    return yield* Effect.gen(function* () {
      const defs = yield* loadDefinitions(yield* layers({ ...env, cwd: run.record.cwd }));
      const defaults = yield* loadDefaults(env.configDir);
      // The definition this Run was started with, not the one the files say now: a
      // Driver is resuming a piece of work somebody authorised, and a workflow edited
      // since would silently change what it does — or crash it, where the record has no
      // step by the new name. A Run recorded before snapshots existed has none, and
      // resolves from the layers as it always did, under the guard below.
      const frozen = yield* readSnapshot(run.dir, run.record.definition);
      const wf = frozen ?? resolveWorkflow(run.record.workflow, defs, defaults);
      if (frozen === null) {
        const recorded = run.record.steps.map((step) => step.id);
        const now = wf.steps.map((step) => step.id);
        if (stepsDiffer(recorded, now)) {
          const note = `definition_changed: ${wf.path} ${stepDifference(recorded, now)}; this Run has no frozen definition, so its steps cannot be matched to it`;
          yield* run.log(note);
          yield* out(note);
          run.record.halt = "definition_changed";
          run.record.status = "blocked";
          run.record.finished_at = yield* nowIso();
          yield* run.save();
          return 1;
        }
        yield* run.log(`no snapshot recorded; resolved ${wf.name} from the ${wf.layer} layer`);
      }
      yield* out(`${wf.title}`);
      const prompts = filePrompts({
        dir: run.dir,
        run: run.id,
        step: () => run.record.steps.find((st) => st.status === "running")?.id ?? "",
        timeoutMs: defaults.handoffTimeoutMs,
      });

      const status = yield* executeRun({
        herdr,
        defs,
        defaults,
        wf,
        run,
        env,
        out,
        handoffTimeoutMs: defaults.handoffTimeoutMs,
        // Every question this run asks goes through the run dir to the Control Plane.
        prompts,
      });
      return status === "done" ? 0 : 1;
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // Nobody is watching a pane for this, so the only useful place is the log.
          const detail = reason(cause);
          yield* out(`the driver stopped: ${detail.split("\n")[0]}`);
          yield* run.log(`driver failed: ${detail}`);
          run.record.status = "failed";
          run.record.finished_at = yield* nowIso();
          yield* run.save();
          // A missing toast must not be the last word — and a kind the human turned
          // off in config stays off here too, so the settings mean what they say.
          const settings = (yield* loadDefaults(env.configDir)).notifications;
          yield* notify(herdr, run, {
            kind: "run-failed",
            body: `${detail.split("\n")[0]} — see ${RUNNER_LOG} in the run dir`,
            settings,
          });
          return 1;
        }),
      ),
      // Marker before claim: a reader must never find "no owner, no marker, running".
      Effect.ensuring(markStoppedIfInterrupted),
      Effect.ensuring(releaseDriver(run.dir).pipe(Effect.ignore)),
    );
  });

  return yield* drive;
});

/** How often the tab re-reads the files and asks herdr what is still alive. */
const REFRESH_MS = 1500;
/** How long a keypress may wait; the tab has to feel like a TUI, not a report. */
const TICK_MS = 120;

const CLEAR = "\x1b[2J\x1b[H";

/**
 * The narrowest pane the app is worth starting in. Below it the regions have no room
 * and the one-screen text view says more.
 */
const WIDTH_FLOOR = 40;

/** Why the app cannot run here, or nothing when it can. */
const whyNoRenderer = Effect.fn("Flows.whyNoRenderer")(function* () {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return "no terminal on this pane";
  const term = yield* Config.option(Config.string("TERM"));
  if (term._tag === "Some" && term.value === "dumb") return "TERM is dumb";
  const width = process.stdout.columns ?? 0;
  if (width < WIDTH_FLOOR) return `the pane is ${width} columns, and the app needs ${WIDTH_FLOOR}`;
  return null;
});

/**
 * The Collie tab: the Session's control surface, as an application. It watches the run
 * dirs and the register and renders them; the actions are the plugin's own actions, one
 * hand-off, and whatever the Selection can be asked for. It drives no run and holds no
 * engine state, so closing it loses nothing.
 *
 * OpenTUI arrives through a dynamic import, so the `collie` CLI — `--json`, the receipts
 * path, CI — neither loads the native renderer nor depends on it being there.
 */
export const workspaceFlow = Effect.fn("Flows.workspaceFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
) {
  const session: ControlSession = {
    herdr,
    ...scopeFor(env, env.cwd),
    stateDir: env.stateDir,
    paneId: env.paneId,
    pluginRoot: env.pluginRoot,
    configDir: env.configDir,
    // The Control Plane runs its actions on one fiber, one at a time, so a hand-off to
    // an agent over the threshold must not hold that queue while a compaction runs. It
    // asks, and reports that the compaction is in the air; the human presses the key
    // again when the pane says it has finished. No work is sent either way.
    compaction: { waitMs: 0 },
    pruned: { at: 0, lines: [], running: false },
  };
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  const home = key === null ? null : yield* readHome(yield* homePath(env.stateDir, key));
  // A board outside the Home is a board this Herd no longer has: one Home per Herd, so
  // two of them would be two boards disagreeing about the same Runs (ADR-0009). It is
  // marked as legacy — which is the only thing `home cleanup` will close — and it says
  // where Collie went rather than drawing a second board.
  if (
    home !== null &&
    home !== UNREADABLE &&
    env.workspaceId !== null &&
    env.workspaceId !== home.workspaceId
  ) {
    if (env.paneId !== null) {
      yield* Effect.ignore(
        herdr.paneReportMetadata(env.paneId, { [LEGACY_PANE_TOKEN]: "legacy" }, TOKEN_TTL_MS),
      );
    }
    return yield* redirectBoard(herdr, env);
  }
  /**
   * Where the shortcut was pressed, which is what `g` narrows to and what the board
   * opens on. `env.workspaceId` is the fallback for a board nobody arrived at through
   * the shortcut — its own workspace is then the only origin there is.
   */
  const noted = key === null ? null : yield* readOrigin(yield* originPath(env.stateDir, key));
  const origin = noted?.workspaceId ?? env.workspaceId;
  /** `all` when the shortcut was pressed inside the Home, which means "show me everything". */
  const opening =
    noted?.filter === "all"
      ? ({ kind: "all" } as const)
      : openingFilter((yield* loadDefaults(env.configDir)).scope, origin);
  const why =
    (yield* whyNoRenderer()) ??
    (yield* Effect.gen(function* () {
      const { runApp } = yield* Effect.promise(() => import("./ui/bridge"));
      const app = appState(session, env);
      /**
       * The board's own dispatch, once it is running. A confirmed `navigate` puts its
       * target on screen through this and through nothing else: the board never calls a
       * herdr focus method to show a human something (ADR-0008).
       */
      let dispatch: ((command: Command) => void) | null = null;
      yield* registerRunExecutors(env, {
        navigate: (target) =>
          dispatch?.({ _tag: "SetFilter", filter: { kind: "run", id: target.run } }),
      });
      yield* runApp({
        onReady: (own) => {
          dispatch = own;
        },
        stateDir: env.stateDir,
        // Which of the Herd's work the board opens on, read once: `g` and a group row
        // are what change it after that.
        filter: opening,
        origin,
        load: (focus) => app.load(focus),
        act: (command, prompts) => runCommand(session, env, command, prompts),
        // A picture only where every human attached can see one; otherwise no mark.
        logo: (yield* everyViewerPaints())
          ? `${env.pluginRoot}/assets/brand/logos/collie-horizontal-light-512.png`
          : undefined,
        // What the board has open, where the other half of the Home can read it. Nothing
        // to write it to without a Herd, which is a board running outside herdr.
        selected:
          key === null
            ? undefined
            : (on) =>
                Effect.flatMap(selectionPath(env.stateDir, key), (file) =>
                  writeSelection(file, on),
                ),
      });
      return null;
    }).pipe(
      // A renderer that will not start must not take the tab down with it: say why and
      // fall through to the text view, which is what that view is kept for. An interrupt
      // is not that — the pane is closing, and a key loop started on the way out would
      // hang it — so it is re-raised rather than fallen back from.
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.succeed(reason(cause).split("\n")[0]!),
      ),
    ));
  if (why === null) return 0;
  return yield* textBoard(session, herdr, env, why);
});

/**
 * A pane left over from when every workspace had its own Collie tab. One line saying
 * where the board went, and the key that goes there — no board and no chat, because two
 * boards disagreeing about one Herd's Runs is what one Home exists to prevent.
 *
 * Old binaries already running are not touched: this is what a pane shows the next time
 * it is drawn, and `collie home cleanup --confirm` is what closes one.
 */
const redirectBoard = Effect.fn("Flows.redirectBoard")(function* (herdr: Herdr, env: PluginEnv) {
  const text = renderRedirect();
  if (!process.stdin.isTTY) {
    process.stdout.write(`${text}\n`);
    return 0;
  }
  startKeyboard();
  process.stdout.write(`${CLEAR}${text.replace(/\n/g, "\r\n")}\r\n`);
  for (;;) {
    const key = takeKey();
    if (key === "q" || key === "\x03") {
      releaseKeyboard();
      return 0;
    }
    if (key === "o") {
      releaseKeyboard();
      return yield* boardFlow(herdr, env);
    }
    yield* Effect.sleep(TICK_MS);
  }
});

/** How long a merge request read stays good for. Re-selecting inside it costs nothing. */
const MR_TTL_MS = 60_000;

/**
 * How long an answer about a Run's agents stays good for. The panel of a stopped Run is
 * re-produced on every board tick, and asking herdr means a subprocess per agent — so
 * without this, sitting and looking at a broken Run costs one every three seconds. Short,
 * because it is advice about what is safe: `run resume` and the resume flow ask again
 * with no cache, and that is what actually decides.
 */
const AGENTS_TTL_MS = 15_000;

/**
 * A `herdr` that remembers what it was told about a set of agents. Held by the reader,
 * beside the merge-request and plan caches, for the same reason they are: a redraw must
 * cost nothing a redraw cannot change.
 */
function remembersAgents(herdr: Herdr): AsksAgents {
  const answers = new Map<string, { at: number; alive: AgentsAlive }>();
  return {
    agentsAlive: (names) =>
      Effect.gen(function* () {
        const key = names.join("\u0000");
        const now = yield* Clock.currentTimeMillis;
        const cached = answers.get(key);
        if (cached && now - cached.at < AGENTS_TTL_MS) return cached.alive;
        const alive = yield* herdr.agentsAlive(names);
        answers.set(key, { at: now, alive });
        return alive;
      }),
  };
}

/**
 * Everything the app draws, for whatever it is looking at. One closure, because the
 * merge-request cache belongs with the reads it saves: a History of 40 merge-request
 * Runs must make no `glab` call to draw, one selection makes exactly one, and
 * re-selecting the same Run inside the TTL makes none.
 */
/**
 * The next meaningful thing that happened, asked about once. One turn per tick at most,
 * and one per event ever: several Runs ending together is one thing that happened, and a
 * board that fired five turns at once would be the notification storm this replaces.
 *
 * Read-only where it can be: the turn is a question about a Run, and what may then be
 * *done* about it goes through the same `validate` path a typed message does. Who started
 * the turn is not an input to what is permitted.
 */
/**
 * The Runs still going whose drift was escalated to the human, by constraint. Only the
 * unfinished ones are read: a finished Run's drift is history, and its ending is the event.
 */
const escalatedDrift = Effect.fn("Flows.escalatedDrift")(function* (runs: ReadonlyArray<Run>) {
  const drifting = new Map<string, string>();
  for (const run of runs) {
    if (run.record.status === "done" || run.record.status === "failed") continue;
    const lines = yield* readDrift(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
    const stuck = currentReports(lines).find((report) => report.resolution === "escalated");
    if (stuck) drifting.set(run.id, stuck.constraint);
  }
  return drifting;
});

/**
 * What the board noticed, written down for the conversation to pick up.
 *
 * No model is called here, and that is the whole change: a meaningful transition becomes
 * a **fact** in this Herd's news, built from the Run's own record. An unchanged Herd
 * produces no events, so nothing is appended and nothing wakes anything — the board
 * redrawing every three seconds costs nothing at all.
 *
 * Every event the board finds is written, not just the first: a burst becomes a batch the
 * conversation is given together, rather than one turn per Run ending.
 */
const sayWhatHappened = Effect.fn("Flows.sayWhatHappened")(function* (
  env: PluginEnv,
  runs: ReadonlyArray<Run>,
) {
  if (!(yield* loadDefaults(env.configDir)).proactive) return;
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return;
  const dir = yield* herdDir(env.stateDir, key);
  const said = yield* readSaid(dir);
  const file = yield* newsPath(env.stateDir, key);
  for (const event of eventsIn(
    runs.map((run) => run.record),
    yield* escalatedDrift(runs),
  )) {
    if (said.has(event.key)) continue;
    // Remembered only once it is in the journal. The journal deduplicates by unread key,
    // so a failed write costs a retry on the next tick — where remembering first would
    // cost the news itself, and nobody would be told that Run halted.
    const queued = yield* appendNews(file, {
      key: event.key,
      run: event.run,
      text: event.text,
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (queued !== null) yield* remember(dir, event.key, yield* nowIso());
  }
});

export function appState(
  session: ControlSession,
  env: PluginEnv,
  /**
   * A parameter for the same reason inference takes one: a test should watch it run.
   * The default ignores stderr, because what this reads is JSON: glab writes non-fatal
   * notices there while still exiting 0, and one of those folded into the output made
   * `mrDetails` report a merge request it had just read successfully as "not a merge
   * request" — and cached that answer for the whole TTL. `"say"` is for the calls whose
   * output a human reads, like `OpenMr`.
   */
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
  /**
   * The Home's ownership question, when there is one nobody has settled. Decided once at
   * startup rather than per tick: it is a herdr answer, `collie home reconcile` is what
   * clears it, and re-asking every three seconds would be two calls a tick for a fact
   * only a human changes.
   */
  ownership: Live["ownership"] = null,
) {
  const mrCache = new Map<string, { at: number; panel: MrPanel }>();
  /**
   * A finished Run's plan, kept between reads for the same reason the merge request is:
   * the panel is re-produced on every board tick, and a Run that has stopped cannot
   * change the plan it was built from. Cleared whenever something asked for a fresh
   * read, so `R` re-reads a plan the same way it re-reads the merge request.
   */
  const planCache = new Map<string, PlanPanel | null>();
  const asksAgents = remembersAgents(session.herdr);
  /**
   * What GitLab last said about each merge request the board waits on, and when it was
   * asked. Asked in the background after a load, never on the load's own path: ten open
   * merge requests must not cost ten `glab` calls per redraw.
   */
  const mrStates = new Map<string, MrState>();
  const mrChecked = new Map<string, number>();
  let settling = false;
  const settleInBackground = (views: ReadonlyArray<TaskView>, now: number) =>
    Effect.gen(function* () {
      if (settling) return;
      settling = true;
      yield* Effect.forkDetach(
        settleMerges({
          stateDir: env.stateDir,
          cwd: env.cwd,
          run,
          views,
          now,
          checked: mrChecked,
          states: mrStates,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              settling = false;
            }),
          ),
          Effect.ignore,
        ),
      );
    });

  const merge = Effect.fn("Flows.mergeRequestFor")(function* (
    target: string | null,
    cwd: string,
    force: boolean,
  ) {
    const ref = target ? parseMrTarget(target) : null;
    if (!ref) return null;
    const key = mrTarget(ref.project, ref.iid);
    const now = yield* Clock.currentTimeMillis;
    const cached = mrCache.get(key);
    if (cached && !force && now - cached.at < MR_TTL_MS) return cached.panel;
    const panel = yield* mrDetails(ref, cwd, run);
    mrCache.set(key, { at: now, panel });
    return panel;
  });

  /** The board from the last read, for whatever `rereads` says may be taken from it. */
  let last: { focus: Focus; state: AppState } | null = null;
  /**
   * Whether a turn Collie started is still being answered. At most one in flight: the
   * next tick does not start a second while the evaluator is still thinking about the
   * first, and — the reason it is a flag and not an await — the board never waits for it.
   */
  let speaking = false;

  /** One row per Run: a Run on the local board is on the wide one too. */
  const dedupe = (rows: ReadonlyArray<{ id: string; dir: string }>) => [
    ...new Map(rows.map((row) => [row.id, { id: row.id, dir: row.dir }])).values(),
  ];

  const load = Effect.fn("Flows.appState.load")(function* (focus: Focus) {
    const again = rereads(last?.focus ?? null, focus);
    const reuse = again.reuse ? last : null;
    // One scan of the run dirs per read, shared by the board and History: they are two
    // Views over the same directory, and reading it twice doubles the cost of a refresh.
    const runs = reuse ? undefined : yield* new RunStore(env.stateDir).list();
    // One read of the register and the workspace list for both boards: a wide tick
    // costs the local board's calls plus nothing, and the two boards cannot reconcile
    // a tab label from two different answers about the same agent.
    // A meaningful change in what this read already looked at, said out loud. Never a
    // second scan and never a timer: the board recomputes this to draw it, and a
    // transition in it is the whole trigger. Best effort — a Herd nobody can talk to
    // still has a board. No model is called: what this does is write a fact down, so a
    // board that redraws over unchanged state finds no events and does nothing at all.
    if (runs !== undefined && !speaking) {
      speaking = true;
      yield* Effect.forkDetach(
        sayWhatHappened(env, runs).pipe(
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              speaking = false;
            }),
          ),
        ),
      );
    }
    const live = reuse ? undefined : yield* liveOf(session);
    const board = reuse ? reuse.state.board : yield* boardOf(session, runs, live);
    // Read only while the Runs view is showing it: a local board, and every other View,
    // must cost no group it is not going to draw.
    const widening = focus.filter.kind !== "workspace" && focus.view === "runs";
    const wide = widening ? (reuse ? reuse.state.wide : yield* wideOf(session, runs, live)) : null;
    // Before the Selection is resolved, because a History row is a row too: the board
    // keeps five finished runs and History keeps two hundred from every session that ran
    // here, so looking the Selection up in the board alone left every older row's panel
    // empty while its row carried the target all along.
    const history = reuse
      ? reuse.state.history
      : focus.shown.includes("history")
        ? yield* buildHistory({ stateDir: env.stateDir, cwd: env.cwd, runs })
        : null;
    const runId = runIdOf(focus.selected);
    // The wide groups too: a row the human is on may belong to another workspace, and
    // looking only at this one left its panel empty while its row carried the target.
    const selected = runId
      ? [
          ...board.active,
          ...board.recent,
          ...(wide?.groups.flatMap((g) => [...g.active, ...g.recent]) ?? []),
          ...(history ?? []),
        ].find((r) => r.id === runId)
      : undefined;
    // The Run itself, not the row: what a card is about is on the record, and a row
    // carries only what its list needed. One record, for the one Run selected.
    const selectedRun =
      runId === null
        ? null
        : ((runs ?? []).find((run) => run.id === runId) ??
          (yield* new RunStore(env.stateDir)
            .load(runId)
            .pipe(Effect.catch(() => Effect.succeed(null)))));
    const where =
      selected !== undefined
        ? { id: selected.id, dir: selected.dir }
        : selectedRun === null
          ? null
          : { id: selectedRun.id, dir: selectedRun.dir };
    // Read for the Selection and never for a list, and a badge is only ever filled from
    // what is in the cache. When to read past that cache is `rereads`' decision.
    const mr = yield* merge(
      mrAbout(selectedRun?.record ?? null) ?? selected?.target ?? null,
      env.cwd,
      again.forceMr,
    );
    if (again.forceMr) planCache.clear();
    /**
     * Every Run on whichever board is showing, for the marks and for the Herd-wide
     * cards. From the boards rather than from the store's whole list: History keeps two
     * hundred finished Runs, and reading each one's journals per tick to mark rows
     * nobody is looking at is the cost this used to pay for nothing.
     */
    const onBoard = [
      ...board.active,
      ...board.recent,
      ...(wide?.groups.flatMap((g) => [...g.active, ...g.recent]) ?? []),
    ];
    /** What each Run's record says about it that a row does not carry. */
    const recorded = new Map((runs ?? []).map((run) => [run.id, markedFrom(run.record)]));
    /**
     * The Live region and every row's marks, from one pass over the same journals. The
     * region is the Runs view's alone — nothing else draws it, and the journals of every
     * Run on the board are not worth reading to fill a field Settings will not look at —
     * but the marks are on a History row too, so a reuse tick outside the Runs view is
     * the one that keeps the marks it already had.
     */
    const found =
      reuse && focus.view !== "runs"
        ? null
        : yield* liveFor({
            stateDir: env.stateDir,
            socketPath: env.socketPath,
            run: where === null ? null : { id: where.id, dir: where.dir },
            // From the scan this read already made, never a second load per Run: the
            // record is the only thing the marks need that a row does not carry, and
            // re-reading every `run.json` per tick is what a shared scan exists to avoid.
            runs: dedupe(onBoard).map((row) => ({
              ...row,
              ...(recorded.get(row.id) ?? markedFrom(null)),
            })),
            ownership,
            region: focus.view === "runs",
          });
    const defaults = yield* loadDefaults(env.configDir);
    const tasksBuilt = reuse
      ? reuse.state.tasks
      : yield* buildBoard({
          stateDir: env.stateDir,
          socketPath: env.socketPath,
          alive: live?.alive ?? [],
          runs,
          quietMs: defaults.boardQuietMs,
          mrStates,
        });
    if (!reuse) yield* settleInBackground(tasksBuilt, yield* Clock.currentTimeMillis);
    const state = {
      view: focus.view,
      filter: focus.filter,
      // The board's own model, Herd-wide: a workspace is a filter over one board, never
      // a board of its own (ADR-0009). From the scan this read already made.
      tasks: tasksBuilt,
      now: yield* Clock.currentTimeMillis,
      density: defaults.density,
      wide,
      board,
      note: null,
      history,
      definitions: reuse
        ? reuse.state.definitions
        : focus.shown.includes("workflows")
          ? yield* buildWorkflows(env)
          : null,
      settings: reuse
        ? reuse.state.settings
        : focus.shown.includes("settings")
          ? yield* buildSettings(env)
          : null,
      marks: found?.marks ?? reuse?.state.marks ?? {},
      previewing: focus.previewing,
      live: found?.live ?? null,
      // Always re-read: this is the one thing a moved Selection actually changes.
      // The bridge's own, and it overlays what it is holding onto every load.
      stopping: [],
      detail: runId
        ? yield* buildRunDetail({
            stateDir: env.stateDir,
            runId,
            agents: asksAgents,
            mr,
            tail: focus.tail,
            pages: focus.reviewPages,
            plans: planCache,
          })
        : null,
    } satisfies AppState;
    last = { focus, state };
    return state;
  });

  return { load };
}

/**
 * The merge request a Run is about: the one it opened, else the one it was pointed at.
 * Both, because `implement` produces one and `review` is given one — reading only the
 * second left every merge request a Run built without a state, a pipeline or approvals.
 */
function mrAbout(record: RunRecord | null): string | null {
  const opened = record?.mr_url ? parseMrUrl(record.mr_url) : null;
  if (opened !== null) return mrTarget(opened.project, opened.iid);
  return record?.inputs.target ?? null;
}

/** One command, run against the Selection it names. The string becomes the footer note. */
export const runCommand = Effect.fn("Flows.runCommand")(function* (
  session: ControlSession,
  env: PluginEnv,
  command: Command,
  prompts: FlowPrompts,
) {
  const runOf = (runId: string) => loadRun(session.stateDir, runId);
  switch (command._tag) {
    /**
     * Enter, as one call. Everything is resolved here rather than when the row was
     * drawn: herdr compacts tab ids, and one cached at render time jumps into whatever
     * has taken its place. The board never focuses anything to inspect it, because
     * focusing collapses herdr's `done` badge to `idle`.
     */
    case "Jump": {
      const jump = command.jump;
      // Where you went, in the words the row used; the ids stay inside this call.
      const went = <E, R>(call: Effect.Effect<void, E, R>) =>
        call.pipe(
          Effect.as(`went to ${jump.label}`),
          Effect.catch((cause) => Effect.succeed(`${jump.label}: ${reason(cause)}`)),
        );
      if (jump.kind === "none") return `${jump.label} — nothing to jump to`;
      if (jump.kind === "workspace") {
        return yield* went(session.herdr.workspaceFocus(jump.workspaceId));
      }
      if (jump.kind === "agent") return yield* went(session.herdr.agentFocus(jump.agent));
      const run = yield* runOf(jump.runId);
      if (!run) return `${jump.label} has gone`;
      // A run's tab is the tab of its newest agent; one that has opened none is only
      // reachable as the workspace it was recorded against.
      const tabId = run.record.steps
        .flatMap((step) => step.variants)
        .map((variant) => variant.tabId)
        .filter((id): id is string => id !== null)
        .at(-1);
      if (tabId) return yield* went(session.herdr.tabFocus(tabId));
      const workspace = run.record.workspace;
      if (!workspace) return `${jump.label} has no tab to jump to`;
      return yield* went(session.herdr.workspaceFocus(workspace));
    }
    case "FocusAgent":
      return yield* session.herdr.agentFocus(command.agent).pipe(
        Effect.as(`focused ${command.agent}`),
        Effect.catch((cause) => Effect.succeed(`${command.agent}: ${reason(cause)}`)),
      );
    // The Run itself, not the row the human pressed the key on: what these three need
    // is a run directory, and looking the row up again meant asking which of the board,
    // History and every workspace's group it was on — three views built to answer a
    // question the run directory answers on its own.
    case "StopRun": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      // A Run that ended by itself while the board held the stop is not stopped: the
      // grace is for the human to change their mind, not a window to kill a finished Run
      // in. Read from its directory rather than from the board, which may be seconds old.
      if (runSettled(yield* runStatus(run))) return `${runLabel(run.record)} finished on its own`;
      return yield* stopRun(session, run);
    }
    case "OpenLog": {
      const run = yield* runOf(command.runId);
      return run ? yield* openLog(session, run) : `${command.runId} has gone`;
    }
    case "Answer": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const name = runLabel(run.record);
      const answered = yield* answerRun(
        run,
        command.value,
        yield* newRequestId(),
        command.choiceId,
      );
      return answered.ok ? `answered ${name}` : `${name}: ${answered.error.message}`;
    }
    case "SendReview": {
      // The Selection names the review to send, and a Selection with no Run behind it —
      // a Settings or Workflows row, and `s` is on the footer in every View — names
      // nothing. Handing off "the newest review" there is a fix round for a review
      // nobody chose, so it says what to select instead.
      if (command.runId === null) return "select the run whose review should be sent";
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      return (yield* sendReview(session, run)).message;
    }

    /**
     * A run that stopped with findings, as the next run's work source. `implement`
     * already reads a run directory with a review in it as the spec and its findings as
     * the tickets, so the whole action is one settled Input.
     */
    case "FixFindings": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      return yield* launch(session, env, prompts, {
        workflow: "implement",
        inputs: { plan: run.dir },
        note: `fixing what ${run.id} left open`,
        parent: run,
      });
    }

    case "ReviewAgain":
      return yield* launch(session, env, prompts, {
        workflow: "review",
        inputs: { target: command.target },
        note: `reviewing ${command.target} again`,
      });

    case "RunWorkflow":
      return yield* launch(session, env, prompts, {
        workflow: command.workflow,
        inputs: {},
        note: `started from the Workflows view`,
      });

    case "PostReview": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      return (yield* postReview(run)).message;
    }

    case "ConfirmProposal":
      return yield* fromBoard(env, (actor) =>
        carryOutProposal(env, command.id, command.hash, actor).pipe(
          Effect.map((done) => (done.ok ? done.human : done.error.message)),
        ),
      );

    case "DeclineProposal":
      return yield* fromBoard(env, (actor) =>
        declineProposal(env, command.id, actor).pipe(
          Effect.map((done) => (done.ok ? done.human : done.error.message)),
        ),
      );

    case "OpenMr": {
      const ref = parseMrTarget(command.target);
      if (!ref) return `${command.target} is not a merge request`;
      // The run's own checkout, where it has one: `repoArgs` carries a qualified
      // target, but an unqualified `mr:42` — every older run has one — is resolved by
      // glab from the directory it runs in, so from a board of every workspace this
      // used to open *this* repository's !42.
      const run = command.runId === null ? null : yield* runOf(command.runId);
      const opened = yield* shell(
        "glab",
        ["mr", "view", ref.iid, ...repoArgs(ref.project), "--web"],
        run?.record.cwd ?? env.cwd,
        "say",
      );
      return opened.code === 0
        ? `opened ${command.target} in a browser`
        : `glab could not open ${command.target} (exit ${opened.code})`;
    }

    case "SetDefault": {
      // Three ways this used to write a default no Run could use: an empty string, which
      // `loadDefaults` reads as configured rather than unset; a string on one of the two
      // keys it reads with `isNumber`, which every Run then ignores; and a value written
      // with the whitespace around it, so `codex ` displayed as `codex` and then failed
      // harness validation. Hence: trim, then unset on empty, then reject a non-number.
      const typed = command.value.trim();
      const numeric = NUMERIC_DEFAULTS.includes(command.key);
      if (typed !== "" && numeric && !/^\d+$/.test(typed)) {
        return `${command.key} has to be a whole number, not "${command.value}"`;
      }
      // The one key `loadDefaults` fails on rather than falling back: written wrong, it
      // would break every later run — and the Settings view used to put it right.
      if (typed !== "" && command.key === "permissions" && !isPermissionMode(typed)) {
        return `permissions has to be one of ${PERMISSION_MODES.join(", ")}, not "${command.value}"`;
      }
      // The board has to open on one of the two, so a typo is refused here rather
      // than silently opening local for ever after.
      if (typed !== "" && command.key === "scope" && !isScope(typed)) {
        return `scope has to be one of ${SCOPES.join(", ")}, not "${command.value}"`;
      }
      // Same reason as `scope`: the board draws two cards across or three, so a typo
      // is refused here rather than quietly leaving it on the wider one.
      if (typed !== "" && command.key === "density" && !isDensity(typed)) {
        return `density has to be one of ${DENSITIES.join(", ")}, not "${command.value}"`;
      }
      // Same reason as `scope`: a Driver has to either take focus or not, so a typo
      // is refused here rather than quietly leaving every question stealing focus.
      if (typed !== "" && command.key === "questions" && !isQuestionMode(typed)) {
        return `questions has to be one of ${QUESTION_MODES.join(", ")}, not "${command.value}"`;
      }
      // A threshold no Run can use fails every step that would launch an agent, so
      // it is refused where it is written rather than at the next launch.
      if (typed !== "" && command.key === "compact_at_tokens" && !validThreshold(Number(typed))) {
        return `compact_at_tokens has to be a whole number of tokens above zero, or ${COMPACTION_OFF} to turn compaction off, not "${command.value}"`;
      }
      const value = typed === "" ? null : numeric ? Number(typed) : typed;
      return yield* writeConfigValue(env.configDir, command.key, value).pipe(
        // What was written, so the note cannot disagree with the file.
        Effect.as(`${command.key} is now ${value ?? "unset"}`),
        Effect.catch((cause) => Effect.succeed(`${command.key}: ${reason(cause)}`)),
      );
    }

    /**
     * The launch flow, inline. A popup landed on whatever pane herdr had focused, which
     * is rarely the workspace the board is for — and it is the same flow either way, so
     * the tab draws it itself and the popup stays the herdr action's front door.
     */
    case "OpenMode":
      switch (command.mode) {
        case "pick":
          return yield* pickFlow(session.herdr, env, prompts, "inline").pipe(Effect.as(null));
        case "continue":
          return yield* continueFlow(session.herdr, env, prompts, "inline").pipe(Effect.as(null));
        case "resume":
          return yield* resumeFlow(session.herdr, env, prompts, "inline").pipe(Effect.as(null));
        case "fork":
          return yield* forkFlow(session.herdr, env, prompts).pipe(Effect.as(null));
      }

    /**
     * A Run nothing is driving, taken up again where it stopped. `resumeRun` re-checks
     * that for itself: the card it was asked from is minutes old, and a second Driver is
     * not something to start on a guess.
     */
    case "ResumeRun": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const resumed = yield* resumeRun(env, run, yield* newRequestId());
      return resumed.ok ? resumed.human : resumed.error.message;
    }

    /** A finished plan, built: the same launch "Implement now" runs, from the card. */
    case "ImplementNow": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const path = yield* Path.Path;
      return yield* launch(session, env, prompts, {
        workflow: "implement",
        inputs: { plan: path.join(run.dir, "plan") },
        note: `implementing ${runLabel(run.record)}'s plan`,
        parent: run,
      });
    }

    /**
     * A child Run on a finished one's outcome. What it should do is asked for here rather
     * than guessed from the parent: a follow-up with no words is a Run with no spec.
     */
    case "FollowUp": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const text = yield* prompts.ask(`What still needs doing on ${runLabel(run.record)}?`);
      if (text === null || text.trim() === "") return null;
      const started = yield* followUp(env, run, text.trim(), yield* newRequestId());
      return started.ok ? started.human : started.error.message;
    }

    /**
     * One thing said to Collie about one Run. It carries nothing out on its own: the
     * evaluator answers with a proposal, which arrives as that Task's decision card.
     */
    case "Steer": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const said = yield* steer(env, yield* evaluationDeps(env), {
        text: command.text,
        target: run.id,
        requestId: yield* newRequestId(),
      });
      return said.ok ? said.human : said.error.message;
    }

    /**
     * What became of the work. Beside the Run's status, never over it: a Run that failed
     * and was then finished by hand is both facts at once.
     */
    case "RecordDisposition": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      return yield* fromBoard(env, (actor) =>
        Effect.gen(function* () {
          const line = {
            at: yield* nowIso(),
            by: actorName(actor),
            kind: command.kind,
            ref: command.ref,
            note: null,
          };
          yield* recordDisposition(run.dir, line);
          return statusLine(run.record.status, line);
        }),
      );
    }

    case "EditSetting":
    case "NextQuestion":
    case "OpenRecord":
    case "OpenSteer":
    case "ShowView":
    case "ShowOlder":
    case "ToggleFilter":
    case "SetFilter":
    case "Preview":
    case "ToggleTail":
    case "MoreReview":
    case "Select":
    case "Refresh":
    case "UndoStop":
    case "Quit":
      // The app and the bridge act on these themselves; they never reach a handler.
      // `EditSetting` opens the app's own editor, and the value it gathers comes back
      // as a `SetDefault` that carries one; `NextQuestion` moves the Selection and
      // drops a filter; `OpenRecord` and `OpenSteer` open the drawer. None of those is
      // anything out here owns.
      return null;
  }
});

/**
 * Start a Workflow from a row action. An Input nobody could infer is not guessed at: the
 * picker opens instead, which is the one place a human can answer, and the note says so.
 */
const launch = Effect.fn("Flows.launch")(function* (
  session: ControlSession,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: { workflow: string; inputs: Record<string, string>; note: string; parent?: Run },
) {
  // The same launch flow the picker runs, for the Workflow the row named and inline in
  // the tab the row was clicked in. It used to start the Run itself whenever every Input
  // could be inferred, which skipped the Decisions — so a Workflow with a Choice step
  // started with none of them answered and stopped at that Choice hours later, which is
  // the opposite of what deciding upfront is for.
  const line = yield* startChosen(session.herdr, env, prompts, {
    workflow: opts.workflow,
    placement: "inline",
    given: opts.inputs,
    parent: opts.parent,
  });
  return line ?? `${opts.workflow} was not started`;
});

/**
 * The board as one screen of text, with the key loop it always had. This is what a pane
 * with no terminal, a dumb TERM or no renderer gets, and it is the escape hatch if
 * OpenTUI ever becomes a problem on a supported platform — so it stays alive and tested
 * rather than decorative.
 */
const textBoard = Effect.fn("Flows.textBoard")(function* (
  session: ControlSession,
  herdr: Herdr,
  env: PluginEnv,
  why: string,
) {
  yield* Console.error(`${COLLIE_TAB}: ${why}; showing the text view.`);
  /**
   * What steering has found about the Runs on the board, and what has been happening.
   * The same reads the app makes, so this view says no less about a Run than the app
   * does — a pane too narrow for the renderer must not be a quieter board.
   */
  /** The board's own Tasks, so the text view and the pane draw the same three sections. */
  const tasksOf = Effect.fn("Flows.textBoard.tasks")(function* () {
    return yield* buildBoard({
      stateDir: env.stateDir,
      socketPath: env.socketPath,
      quietMs: (yield* loadDefaults(env.configDir)).boardQuietMs,
    });
  });

  const steeringOf = Effect.fn("Flows.textBoard.steering")(function* (view: WorkspaceView) {
    const rows = [...view.active, ...view.recent];
    const live = yield* liveFor({
      stateDir: env.stateDir,
      socketPath: env.socketPath,
      run: null,
      runs: yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const run = yield* loadRun(env.stateDir, row.id);
          return { id: row.id, dir: row.dir, ...markedFrom(run?.record ?? null) };
        }),
      ),
      ownership: null,
      region: true,
    });
    return { ...live, tasks: yield* tasksOf() };
  });
  // Nothing to loop on: with no keyboard the board is a report, so it is printed once
  // and the entrypoint ends rather than spinning on a `takeKey` that can never answer.
  if (!process.stdin.isTTY) {
    const view = yield* boardOf(session);
    const once = renderWorkspace(view, why, undefined, yield* steeringOf(view));
    process.stdout.write(`${once}\n`);
    return 0;
  }
  startKeyboard();
  let view = yield* boardOf(session);
  const open = (mode: Mode) => openMode(herdr, env, mode);
  let note: string | null = why;
  let drawn = "";
  let read = yield* Clock.currentTimeMillis;
  let asking: Asking = { index: 0, typed: "" };
  let answering: string | null = null;

  for (;;) {
    const waiting = askingRun(view);
    // A new question starts from the top, with nothing typed.
    if (waiting && waiting.id !== answering) {
      asking = { index: 0, typed: "" };
      answering = waiting.id;
      yield* announce(herdr, env, session.configDir);
    }
    if (!waiting) answering = null;

    const text = renderWorkspace(view, note ?? undefined, asking, yield* steeringOf(view));
    if (text !== drawn) {
      process.stdout.write(`${CLEAR}${text.replace(/\n/g, "\r\n")}\r\n`);
      drawn = text;
    }
    const key = takeKey();
    if (key !== null) {
      // While a run is asking, every key belongs to that question.
      if (waiting) {
        const answered = yield* answerKey(waiting, asking, key);
        asking = answered.asking;
        note = answered.note ?? note;
      } else if (key === "q" || key === "\x03") {
        releaseKeyboard();
        return 0;
      } else {
        note = yield* act(session, view, key, open);
      }
      view = yield* boardOf(session);
      read = yield* Clock.currentTimeMillis;
      continue;
    }
    if ((yield* Clock.currentTimeMillis) - read >= REFRESH_MS) {
      view = yield* boardOf(session);
      read = yield* Clock.currentTimeMillis;
    }
    yield* Effect.sleep(TICK_MS);
  }
});

/**
 * A question nobody sees is a run that has silently stopped, so the board brings this
 * tab to the front when one arrives. The toast is the Driver's — it raises `needs-you`
 * for the step before it waits, once per `(run, kind, step)` and recorded on the run,
 * so announcing it here as well would interrupt twice for one question and again
 * whenever the board is reopened.
 */
const announce = Effect.fn("Flows.announce")(function* (
  herdr: Herdr,
  env: PluginEnv,
  configDir: string,
) {
  // Same opt-out as the Driver's: `questions: notify` leaves the question on the
  // board and in the toast, and only stops it moving the human here.
  if ((yield* loadDefaults(configDir)).questions === "notify") return;
  if (!env.tabId) return;
  // A tab that will not focus is still a tab the human can reach.
  yield* Effect.ignore(herdr.tabFocus(env.tabId));
});

/**
 * One keypress against a pending question; the answer goes back to the run dir. The
 * keystroke itself is `answerFor` in `src/ui/state.ts`, so the app and this fallback
 * answer a question the same way rather than each having their own idea of Esc.
 */
export const answerKey = Effect.fn("Flows.answerKey")(function* (
  waiting: RunRow,
  asking: Asking,
  key: string,
) {
  const choice = waiting.choice;
  if (!choice) return { asking };
  const next = answerFor(choice, asking, key);
  if (next.value === null) return { asking: next.asking };
  const answered = yield* answerRun(waiting, next.value, yield* newRequestId());
  return {
    asking: next.asking,
    note: answered.ok ? `answered ${waiting.title}` : `${waiting.title}: ${answered.error.message}`,
  };
});

/**
 * The picker, opened in the board's own pane rather than as a popup: a popup lands
 * on whatever pane herdr has focused, which is rarely the workspace this board is
 * for, and the mode and cwd have to be this board's.
 */
const openMode = Effect.fn("Flows.openMode")(function* (herdr: Herdr, env: PluginEnv, mode: Mode) {
  yield* herdr.pluginPaneOpen({
    entrypoint: "picker",
    placement: "split",
    targetPaneId: env.paneId ?? undefined,
    direction: "down",
    cwd: env.cwd,
    env: { COLLIE_MODE: mode, COLLIE_CWD: env.cwd },
    focus: true,
  });
});

/** What one keypress does. Returns the line to show under the lists, if any. */
const act = Effect.fn("Flows.act")(function* (
  session: ControlSession,
  view: WorkspaceView,
  key: string,
  open: (mode: Mode) => ReturnType<typeof openMode>,
) {
  if (/^[1-9]$/.test(key)) {
    const agent = agentForKey(view, key);
    if (!agent) return null;
    return yield* session.herdr.agentFocus(agent.agent).pipe(
      Effect.as(`focused ${agent.name} (${agent.agent})`),
      Effect.catch((cause) => Effect.succeed(`${agent.agent}: ${reason(cause)}`)),
    );
  }
  const mode =
    key === "p"
      ? "pick"
      : key === "C"
        ? "continue"
        : key === "u"
          ? "resume"
          : key === "f"
            ? "fork"
            : null;
  if (mode) {
    return yield* open(mode).pipe(
      Effect.as(null),
      Effect.catch((cause) => Effect.succeed(`${mode}: ${reason(cause)}`)),
    );
  }
  if (key === "s") return (yield* sendReviewToImplementer(session)).message;
  // The text board acts on the newest run it drew rather than on a Selection, so this
  // is where "which run" is decided for it — the operations take the run itself.
  if (key === "l") {
    const row = view.active[0] ?? view.recent[0];
    if (!row) return "no run here to open a log for";
    const run = yield* loadRun(session.stateDir, row.id);
    return run ? yield* openLog(session, run) : `${row.title} has gone`;
  }
  if (key === "k") {
    const row = view.active[0];
    if (!row) return "nothing running here to stop";
    const run = yield* loadRun(session.stateDir, row.id);
    return run ? yield* stopRun(session, run) : `${row.title} has gone`;
  }
  return null;
});

/**
 * The Run behind an id, or `null` for one whose directory has gone since the row that
 * names it was drawn. This is the whole of "which run did the human mean": a row is a
 * projection of a run directory, and every board that can show a row — this Session's,
 * History, another workspace's group — is showing a directory this reads directly.
 */
export const loadRun = Effect.fn("Flows.loadRun")(function* (stateDir: string, runId: string) {
  return yield* new RunStore(stateDir).load(runId).pipe(Effect.catch(() => Effect.succeed(null)));
});

/**
 * Stops a run. A run used to stop when you closed its pane; the driver has no pane now,
 * so this replaces that. Its agents are left where they are: their panes are the
 * transcript of what happened.
 */
export const stopRun = Effect.fn("Flows.stopRun")(function* (session: ControlSession, run: Run) {
  const name = runLabel(run.record);
  const stopped = yield* stopRunOperation(
    session.stateDir,
    session.herdr,
    run,
    yield* newRequestId(),
  );
  return stopped.ok ? `stopped ${name}` : `${name}: ${stopped.error.message}`;
});

/**
 * A run's `runner.log` in a pane of its own. The driver has no pane, so this is the
 * only place its detail can be read, and a temporary pane is the cheapest way to read
 * it without leaving the board.
 */
export const openLog = Effect.fn("Flows.openLog")(function* (session: ControlSession, run: Run) {
  const path = `${run.dir}/${RUNNER_LOG}`;
  return yield* Effect.gen(function* () {
    const pane = yield* session.herdr.paneSplit({
      paneId: session.paneId ?? "",
      direction: "down",
      ratio: 0.6,
    });
    // The pane is a shell, so the path is quoted: spaces and metacharacters in a
    // state dir are path characters here, not syntax.
    yield* session.herdr.paneRun(pane, `less +G ${shellQuote(path)}`);
    return `opened ${runLabel(run.record)}'s log`;
  }).pipe(Effect.catch((cause) => Effect.succeed(`${path}: ${reason(cause)}`)));
});

/** What herdr answers about the session right now: every agent, and every workspace. */
interface SessionNow {
  alive: AgentInfo[];
  workspaces: WorkspaceInfo[];
}

/**
 * One read of both, per board load: the local board is built from it for its own
 * workspace's label and its agents and the wide board for every group, and two reads of
 * the register can disagree — which had the two boards reconciling one tab's label from
 * two different answers about the same agent.
 */
const liveOf = Effect.fn("Flows.liveOf")(function* (session: ControlSession) {
  return yield* Effect.all(
    { alive: session.herdr.agentList(), workspaces: session.herdr.workspaceList() },
    { concurrency: "unbounded" },
  ).pipe(
    // A herdr that will not answer means "nothing verified live", not a crash.
    Effect.catch(() => Effect.succeed<SessionNow>({ alive: [], workspaces: [] })),
  );
});

/**
 * How often the board prunes. Loading the board happens on every keypress and every
 * 1.5-second refresh; pruning lists runs, asks herdr and writes its own state, so
 * doing it per redraw put a subprocess and a disk write behind every keystroke. The
 * lines it last answered with are what the board shows in between.
 */
const PRUNE_MS = 3 * 60_000;

/** The last sweep's lines, and whether one is out working right now. */
interface Pruned {
  at: number;
  lines: string[];
  running: boolean;
}

/**
 * Prunes in the background, never in the way. A sweep walks every due checkout with
 * git and glab, and the board is a screen that has to redraw on a keypress — so the
 * sweep is forked and the frame goes out with whatever the last one said. One at a
 * time, and the clock starts when it finishes, so a slow sweep does not queue more.
 */
const sweep = Effect.fn("Flows.sweep")(function* (session: ControlSession) {
  const pruned = session.pruned;
  if (!pruned || pruned.running) return;
  const now = yield* Clock.currentTimeMillis;
  if (pruned.at !== 0 && now - pruned.at < PRUNE_MS) return;
  pruned.running = true;
  yield* Effect.forkDetach(
    Effect.gen(function* () {
      const lines = yield* pruneWorktrees({
        herdr: session.herdr,
        stateDir: session.stateDir,
        cwd: session.cwd,
      });
      pruned.lines = lines;
      pruned.at = yield* Clock.currentTimeMillis;
      pruned.running = false;
    }),
  );
});

/**
 * How long the board's own quiet threshold stands before `config.json` is read again.
 * The board redraws every three seconds and on every filesystem event, and this value
 * changes only when a human writes it in Settings — so re-parsing the file per redraw
 * was thousands of reads an hour for one open pane. The same reasoning, and the same
 * shape, as the `behindRemote` count in `src/doctor.ts`.
 */
const QUIET_FOR_MS = 30_000;
const quietSeen = new Map<string, { at: number; quietMs: number }>();

const boardQuietMs = Effect.fn("Flows.boardQuietMs")(function* (configDir: string) {
  const now = yield* Clock.currentTimeMillis;
  const seen = quietSeen.get(configDir);
  if (seen && now - seen.at < QUIET_FOR_MS) return seen.quietMs;
  const quietMs = (yield* loadDefaults(configDir)).boardQuietMs;
  quietSeen.set(configDir, { at: now, quietMs });
  return quietMs;
});

/**
 * Every tab the board can see, called what the run in it is doing. The Control Plane is
 * the second half of the glyph reconcile: the Driver keeps its own run's tabs true while
 * it lives, and this keeps them true for as long as a board is open — which is what
 * makes a review handed back to a live implementer, or a finished agent prompted from
 * here, go back to ⚙ without anyone renaming anything.
 *
 * Only tabs herdr still has an agent in, and only where the label changed. A finished
 * run's tab is usually closed, and renaming one tab per finished run on every open of
 * the board would be a burst of herdr calls that told nobody anything.
 */
const reconcileTabs = Effect.fn("Flows.reconcileTabs")(function* (
  session: ControlSession,
  runs: ReadonlyArray<Run>,
  alive: ReadonlyArray<AgentInfo>,
  rows: ReadonlyArray<RunRow>,
) {
  const live = new Map(alive.map((agent) => [agent.name, agent.status]));
  const written = (session.tabLabels ??= new Map());
  // What herdr calls each of these tabs now, so a tab a human renamed keeps their name
  // rather than being put back by the next board tick.
  const now = new Map(
    (yield* session.herdr.tabList().pipe(Effect.catch(() => Effect.succeed([])))).map((tab) => [
      tab.tabId,
      tab.label,
    ]),
  );
  for (const row of rows) {
    const run = runs.find((r) => r.id === row.id);
    if (!run) continue;
    const inhabited = new Set(
      run.record.steps
        .flatMap((step) => step.variants)
        .filter((variant) => live.has(variant.agent))
        .map((variant) => variant.tabId),
    );
    const labels = tabLabelsFor(run.record, (agent) => live.get(agent), row.choice !== null);
    for (const [tabId, label] of labels) {
      if (!inhabited.has(tabId) || written.get(tabId) === label) continue;
      if (!collieOwns(now.get(tabId), run.record)) continue;
      written.set(tabId, label);
      // A tab that will not rename — closed since the read — is not worth a note, and
      // not worth trying again on every tick either.
      yield* Effect.ignore(session.herdr.tabRename(tabId, label));
    }
  }
});

const boardOf = Effect.fn("Flows.boardOf")(function* (
  session: ControlSession,
  scanned?: ReadonlyArray<Run>,
  seen?: SessionNow,
) {
  yield* sweep(session);
  const live = seen ?? (yield* liveOf(session));
  const runs = scanned ?? (yield* new RunStore(session.stateDir).list());
  const view = yield* buildView({
    ...session,
    stateDir: session.stateDir,
    // The live label is how a run recorded against a since-recycled workspace id is
    // kept out; without it the board falls back to the id alone.
    workspaceLabel:
      live.workspaces.find((w) => w.workspaceId === session.workspaceId)?.label ?? null,
    alive: live.alive,
    worktrees: session.pruned?.lines ?? [],
    pluginRoot: session.pluginRoot,
    quietMs: yield* boardQuietMs(session.configDir),
    runs,
  });
  yield* reconcileTabs(session, runs, live.alive, [...view.active, ...view.recent]);
  return view;
});

/**
 * The whole herdr session as groups, from one `workspace list`, one `agent list` and
 * the run scan the local board has already done: a wide board costs one call more than
 * a local one, whatever is in the session.
 */
const wideOf = Effect.fn("Flows.wideOf")(function* (
  session: ControlSession,
  scanned?: ReadonlyArray<Run>,
  seen?: SessionNow,
) {
  const live = seen ?? (yield* liveOf(session));
  const runs = scanned ?? (yield* new RunStore(session.stateDir).list());
  const wide = yield* buildWideView({
    session: session.session,
    stateDir: session.stateDir,
    workspaces: live.workspaces,
    alive: live.alive,
    runs,
    quietMs: yield* boardQuietMs(session.configDir),
  });
  // Every tab the wide board can see, not just this workspace's: the reconcile is what
  // keeps a glyph true, and a board of the session is watching the whole session.
  yield* reconcileTabs(
    session,
    runs,
    live.alive,
    wide.groups.flatMap((g) => [...g.active, ...g.recent]),
  );
  return wide;
});

/** A banner above a question: definition load errors, above the list they were skipped from. */
function headed(header: string, banner?: string): string {
  return banner ? `${banner}\n\n${header}` : header;
}

const bail = Effect.fn("Flows.bail")(function* (
  prompts: FlowPrompts,
  message: string,
  extra?: string,
) {
  return yield* notice(prompts, message, 1, extra);
});

/**
 * Something the human has to see before the pane goes. A menu of one, because a flow
 * that printed and exited would close the popup over its own message — and because a
 * thing you acknowledge is a thing you can click.
 */
const notice = Effect.fn("Flows.notice")(function* (
  prompts: FlowPrompts,
  message: string,
  code: number,
  extra?: string,
) {
  yield* prompts.menu([{ id: "ok", title: "OK" }], {
    header: headed(message, extra),
    footer: "Enter or Esc closes this",
  });
  return code;
});

/**
 * The board's own front door. A keypress on it is a person acting, so it stamps `board`
 * — the one origin besides a controlling terminal that counts as human, and the reason
 * `confirm` from here is allowed at all.
 */
const fromBoard = Effect.fn("Flows.fromBoard")(function* (
  env: PluginEnv,
  what: (
    actor: Actor,
  ) => Effect.Effect<
    string,
    HerdrUnreachable | IntentUnreadable | PlatformError | ProposalsBusy | SchemaError,
    BunServices
  >,
) {
  const actor: Actor = { origin: "board", requestId: yield* newRequestId() };
  return yield* what(actor).pipe(Effect.catch((cause) => Effect.succeed(reason(cause))));
});
