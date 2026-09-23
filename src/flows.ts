// What each plugin action does. Actions have no tty, so they only open a pane; the
// interactive work happens in the pane entrypoints. Every question a human answers goes
// through `InputPrompts`, so the same flow draws in a popup pane and inline in the tab.

import { Cause, Clock, Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { currentReports, readDrift } from "./drift";
import { diffTargetOf } from "./strategies";
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
import { liveFor, markedOf, type Live } from "./live";
import type { IntentUnreadable } from "./intent";
import { ProposalsBusy, type Actor } from "./proposals";
import { isStale, layers, loadDefinitions, type Definitions, type Provenance } from "./definitions";
import type { PluginEnv } from "./env";
import { Herdr, type AgentInfo, type WorkspaceInfo } from "./herdr";
import { inferInput, type InputPrompts, type PickItem } from "./inputs";
import type { Declared, Found } from "./discovery";
import {
  answerNativeRun,
  controlNativeRun,
  invokeNativeOffer,
  recoverNativeRun,
  savedModules,
  startNativeRun,
} from "./lifecycle";
import { releaseKeyboard, startKeyboard, takeKey } from "./keys";
import { forkResolvedDefinition, type DefinitionKind } from "./fork";
import { COLLIE_TAB, reason, runTitle } from "./naming";
import { listRuns, settled, type RunFacts } from "./runs";
import { everyRegistered, type AgentEntry } from "./registry";
import { pruneWorktrees } from "./worktree";
import { scopeFor, type RegistryScope } from "./registry";
import type { CompactionSettings } from "./compaction";
import { recordDisposition, statusLine } from "./disposition";
import { selectionPath, writeSelection } from "./selection";
import { everyViewerPaints } from "./outer";
import { actorName } from "./proposals";
import { listTasks, taskOfWorkspace, type TaskChoice, type TaskRecord } from "./task";
import {
  carryOutAsked,
  carryOutProposal,
  declineProposal,
  evaluationDeps,
  newRequestId,
  registerRunExecutors,
  steer,
  workspaceCwdFromPanes,
  type ExpectedError,
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

/**
 * What a board is looking at: which workspace and repository, where the state is, and
 * the pane it can split off. Its own shape rather than a Run's, because a board outlives
 * every Run it draws.
 */
interface BoardSession extends RegistryScope {
  stateDir: string;
  /** The Control Plane's own pane, which is what a temporary pane splits off. */
  paneId?: string | null;
  configDir?: string;
  /** What this caller already knows about compaction; absent reads the config file. */
  compaction?: CompactionSettings;
}

export interface ControlSession extends BoardSession {
  herdr: Herdr;
  /** This installation, so the board can say when it is behind its remote. */
  pluginRoot: string;
  /** Where the board's Runs come from: the host's, unless a test hands over its own. */
  runsOf?: RunsOf;
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

/** A directory a Run could be rooted in, and what it would be picked from the list as. */
interface Rooting {
  id: string;
  title: string;
  subtitle: string;
  cwd: string;
  /** The herdr workspace this directory is already open in, where one is. */
  workspaceId: string | null;
  /** Why it will not do, or null when it will. */
  why: string | null;
}

/** The row that reaches a checkout no workspace is open on and no Task has used. */
const NEW_CHECKOUT = "new";

/**
 * The environment a run is rooted in. The board is the Herd's one Home (ADR-0009), and
 * its own directory is Collie's namespace rather than a checkout — so a launch from
 * there asks which checkout the work is in, and roots the Run there. A launch from
 * anywhere else is already in one.
 *
 * What is picked is the checkout, not the Run's workspace: a fresh Task opens a
 * workspace of its own named after the intent (`taskFor`), whatever it was launched
 * from. So the list is not what herdr happens to have open — a checkout an earlier Task
 * used is offered too, and any path can be typed. Those leave `workspaceId` null, which
 * is the truth: that Task's workspace does not exist yet.
 *
 * `null` is the human backing out, or being told why a directory will not do.
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

  const path = yield* Path.Path;
  const namespaceDir = key === null ? "" : yield* herdDir(env.stateDir, key);
  const workspaces = (yield* herdr
    .workspaceList()
    .pipe(Effect.catch(() => Effect.succeed([])))).filter(
    (workspace) => workspace.workspaceId !== home.workspaceId,
  );
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const candidates: Rooting[] = yield* Effect.forEach(workspaces, (workspace) =>
    Effect.gen(function* () {
      const cwd =
        workspace.cwd !== "" ? workspace.cwd : workspaceCwdFromPanes(workspace.workspaceId, panes);
      return {
        id: `ws:${workspace.workspaceId}`,
        title: workspace.label,
        subtitle: cwd,
        cwd,
        workspaceId: workspace.workspaceId,
        why: yield* whyNotRootable(cwd, namespaceDir),
      };
    }),
  );
  // Checkouts earlier Tasks were rooted in, for the repo nobody has a workspace open on
  // — which is most of them once a Task's own workspace has been closed. The Task record
  // already keeps the directory, so this needs no new state and no scan of the disk.
  const seen = new Set(candidates.map((entry) => entry.cwd));
  for (const task of yield* listTasks(env.stateDir)) {
    if (task.cwd === "" || seen.has(task.cwd)) continue;
    seen.add(task.cwd);
    // Silently, unlike a workspace row: a workspace with a bad directory is something
    // the human can see and close, and a checkout deleted last week is only a record.
    if ((yield* whyNotRootable(task.cwd, namespaceDir)) !== null) continue;
    candidates.push({
      id: `dir:${task.cwd}`,
      title: path.basename(task.cwd),
      subtitle: task.cwd,
      cwd: task.cwd,
      workspaceId: null,
      why: null,
    });
  }
  const chosen = yield* prompts.menu(
    [
      // First, and there however little else is: the rest of the list is whatever is
      // open or remembered, and this is the one row that reaches anything else. Without
      // it a Home with no workspaces open could start nothing at all.
      { id: NEW_CHECKOUT, title: "New checkout…", subtitle: "type the path to a project" },
      ...candidates.map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.why ?? entry.subtitle,
      })),
    ],
    {
      header: "Which checkout?",
      footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    },
  );
  if (!chosen) return null;
  const picked =
    chosen.id === NEW_CHECKOUT
      ? yield* typedCheckout(env, prompts, namespaceDir)
      : (candidates.find((entry) => entry.id === chosen.id) ?? null);
  if (picked === null) return null;
  if (picked.why !== null) {
    yield* bail(prompts, `${picked.title}: ${picked.why}`);
    return null;
  }
  // Confirmed on screen before a single Input is asked for: the directory a Run is
  // rooted in is the one thing nothing downstream can put right.
  yield* Console.log(`Starting in ${picked.cwd}`);
  return { ...env, workspaceId: picked.workspaceId, cwd: picked.cwd };
});

/** A checkout nothing has open and no Task has used: the path, as the human types it. */
const typedCheckout = Effect.fn("Flows.typedCheckout")(function* (
  env: PluginEnv,
  prompts: FlowPrompts,
  namespaceDir: string,
) {
  const answer = yield* prompts.ask("Which checkout? Type the path to the project.");
  if (answer === null) return null;
  const path = yield* Path.Path;
  const typed = answer.trim();
  if (typed === "") return null;
  // `~` is what a human types and nothing expanded it on the way here. Anything else
  // relative is refused rather than resolved: the process's directory is the Home's
  // namespace, so resolving against it would silently root the Run in the one place
  // that is never meant.
  const cwd = typed === "~" || typed.startsWith("~/") ? path.join(env.home, typed.slice(1)) : typed;
  const entry = { id: `dir:${cwd}`, title: cwd, subtitle: cwd, cwd, workspaceId: null };
  if (!path.isAbsolute(cwd)) return { ...entry, why: "give the whole path, from / or ~" };
  return { ...entry, why: yield* whyNotRootable(cwd, namespaceDir) };
});

/** Why a directory will not root a Run — open, remembered or typed — else null. */
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
  const offered = new Map<string, PickItem>();
  for (const entry of (yield* savedModules(env)).entries) {
    offered.set(entry.id, {
      id: entry.id,
      title: entry.title,
      subtitle: `[${entry.layer}] ${entry.path}`,
    });
  }
  const items: PickItem[] = [...offered.values()].sort((a, b) => a.id.localeCompare(b.id));

  if (items.length === 0) {
    return yield* bail(prompts, "No workflows found. Check the plugin's workflows/ directory.");
  }

  const chosen = yield* prompts.menu(items, {
    header: headed(`Workflows — ${env.cwd}`),
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
    parent?: RunFacts;
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
  // A workflow saved as a module is started through the host, with the same claim and
  // the same rows `collie run start` uses — the Run is the same either way.
  const saved = yield* savedModules(at);
  const module = saved.entries.find((entry) => entry.id === opts.workflow);
  if (module) return yield* startModule(herdr, at, prompts, { ...opts, task }, module);
  const broken = saved.problems.find((problem) => problem.id === opts.workflow);
  if (broken) {
    yield* bail(prompts, `${broken.path}: ${broken.message}`);
    return null;
  }
  // Nothing else runs work: an id with no module is one this installation does not have.
  yield* bail(
    prompts,
    `No workflow module is saved as "${opts.workflow}". \`collie workflow list\` is what this installation has.`,
  );
  return null;
});

/**
 * A saved module from the name to a started Run: what it declares it takes is what the
 * human is asked for, and nothing else. Typed values and inference belong to the schema
 * and are not guessed at here.
 */
const startModule = Effect.fn("Flows.startModule")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: {
    placement: Placement;
    given?: Record<string, string>;
    parent?: RunFacts;
    task: TaskChoice;
  },
  module: Found,
) {
  const text = { ...opts.given };
  for (const field of module.inputs) {
    if (text[field.name] !== undefined) continue;
    // A field the module attached a strategy to is worked out the way every other Run's
    // is — from this checkout, its Task and what finished here — and only asked for when
    // that comes up empty. The strategy is the module's; the field's name is its own.
    const strategy = field.strategy;
    const inferred = strategy === null ? null : yield* infer(env, opts, field.name, strategy);
    if (inferred !== null) {
      text[field.name] = inferred;
      continue;
    }
    // What it will take decides how it is asked for: a closed set is a menu, so nobody
    // types a value the schema is about to refuse.
    const answer = yield* offer(prompts, module, field);
    if (answer === null) return null;
    if (answer === "" && field.required) {
      yield* bail(prompts, `${module.id} needs an input for "${field.name}".`);
      return null;
    }
    // Absent, not empty: an optional input nobody answered is one the module never sees.
    if (answer !== "") text[field.name] = answer;
  }
  const started = yield* startNativeRun(env, {
    id: module.id,
    request: yield* newRequestId(),
    input: { json: {}, text },
    task: opts.task,
    parent: opts.parent?.id ?? null,
  });
  if (!started.ok) {
    yield* bail(prompts, started.error.message);
    return null;
  }
  if (opts.placement === "popup") yield* Effect.ignore(herdr.popupClose());
  const given = Object.entries(text).map(([name, value]) => `${name}=${value}`);
  return `${module.id}: ${given.join("  ")} → ${started.runId}`;
});

/** What the strategy a module attached to this field works out, or null for nothing. */
const infer = Effect.fn("Flows.infer")(function* (
  env: PluginEnv,
  opts: { task: TaskChoice },
  name: string,
  strategy: string,
) {
  const settled = yield* inferInput(name, strategy, {
    cwd: env.cwd,
    runs: yield* listRuns(env),
    task: opts.task.mode === "continue" ? opts.task.task.id : null,
  }).pipe(Effect.orElseSucceed(() => null));
  if (settled === null || settled.needsAsking || settled.value === "") return null;
  return settled.value;
});

/**
 * One Input, asked the way its own schema allows: a menu where the values are a closed
 * set, and the human's own words otherwise. Null is the human closing the picker; empty
 * is an answer they declined to give.
 */
const offer = Effect.fn("Flows.offer")(function* (
  prompts: FlowPrompts,
  module: Found,
  field: Declared,
) {
  const options = choicesOf(field);
  if (options === null) {
    const answer = yield* prompts.ask(`${module.title} — ${field.name}?`);
    return answer === null ? null : answer.trim();
  }
  const picked = yield* prompts.menu(
    options.map((value) => ({ id: value, title: value })),
    { header: `${module.title} — ${field.name}` },
  );
  return picked === null ? null : picked.id;
});

/** The values a field will take where they are a closed set, and null where they are not. */
function choicesOf(field: Declared): ReadonlyArray<string> | null {
  const drawn = field.schema;
  if (!isDrawing(drawn)) return null;
  if (drawn.type === "boolean") return ["true", "false"];
  const options = drawn.enum;
  return Array.isArray(options) ? options.map((one) => String(one)) : null;
}

const isDrawing = Schema.is(Schema.Record(Schema.String, Schema.Json));

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
  const runs = (yield* listRuns(env)).filter((run) => !run.imported && !settled(run));
  if (runs.length === 0) return yield* bail(prompts, "No runs are still going to pick back up.");

  const items: PickItem[] = runs.map((run) => ({
    id: run.id,
    title: runTitle(run),
    subtitle: `${run.state} · ${run.created.slice(0, 16).replace("T", " ")}`,
  }));

  const chosen = yield* prompts.menu(items, {
    header: "Resume a run",
    footer: "↑↓ move · type to filter · Enter resume · Esc cancel",
  });
  if (!chosen) return 0;

  const resumed = yield* recoverNativeRun(env, chosen.id);
  if (!resumed.ok) return yield* bail(prompts, `${chosen.id}: ${resumed.error.message}`);
  yield* controlNativeRun(env, { runId: chosen.id, control: "stop", set: false });
  // Only a popup can close itself; running the picker in a plain pane is fine..
  if (placement === "popup") yield* Effect.ignore(herdr.popupClose());
  return 0;
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
  const term = yield* Config.option(Config.String("TERM"));
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
const escalatedDrift = Effect.fn("Flows.escalatedDrift")(function* (runs: ReadonlyArray<RunFacts>) {
  const drifting = new Map<string, string>();
  for (const run of runs) {
    if (settled(run)) continue;
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
  runs: ReadonlyArray<RunFacts>,
) {
  if (!(yield* loadDefaults(env.configDir)).proactive) return;
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return;
  const dir = yield* herdDir(env.stateDir, key);
  const said = yield* readSaid(dir);
  const file = yield* newsPath(env.stateDir, key);
  for (const event of eventsIn(runs, yield* escalatedDrift(runs))) {
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
  const runsOf = session.runsOf ?? listRuns;
  const mrCache = new Map<string, { at: number; panel: MrPanel }>();
  /**
   * A finished Run's plan, kept between reads for the same reason the merge request is:
   * the panel is re-produced on every board tick, and a Run that has stopped cannot
   * change the plan it was built from. Cleared whenever something asked for a fresh
   * read, so `R` re-reads a plan the same way it re-reads the merge request.
   */
  const planCache = new Map<string, PlanPanel | null>();
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
    const scanned = reuse ? undefined : yield* scan(env, runsOf);
    const runs = scanned?.runs;
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
    const board = reuse ? reuse.state.board : yield* boardOf(session, scanned!, live);
    // Read only while the Runs view is showing it: a local board, and every other View,
    // must cost no group it is not going to draw.
    const widening = focus.filter.kind !== "workspace" && focus.view === "runs";
    const wide = widening
      ? reuse
        ? reuse.state.wide
        : yield* wideOf(session, scanned!, live)
      : null;
    // Before the Selection is resolved, because a History row is a row too: the board
    // keeps five finished runs and History keeps two hundred from every session that ran
    // here, so looking the Selection up in the board alone left every older row's panel
    // empty while its row carried the target all along.
    const history = reuse
      ? reuse.state.history
      : focus.shown.includes("history")
        ? yield* buildHistory({ cwd: env.cwd, runs: runs ?? (yield* runsOf(env)) })
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
        : ((runs ?? (yield* runsOf(env))).find((run) => run.id === runId) ?? null);
    const where =
      selected !== undefined
        ? { id: selected.id, dir: selected.dir }
        : selectedRun === null
          ? null
          : { id: selectedRun.id, dir: selectedRun.dir };
    // Read for the Selection and never for a list, and a badge is only ever filled from
    // what is in the cache. When to read past that cache is `rereads`' decision.
    const mr = yield* merge(
      mrAbout(selectedRun) ?? selected?.target ?? null,
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
    const recorded = new Map(
      (runs ?? []).map((run) => [run.id, markedOf(run, scanned?.registered ?? [])]),
    );
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
            // From the scan this read already made, never a second read per Run: the
            // facts are the only thing the marks need that a row does not carry.
            runs: dedupe(onBoard).map((row) => ({
              ...row,
              ...(recorded.get(row.id) ?? { held: false, harnesses: [] }),
            })),
            ownership,
            region: focus.view === "runs",
          });
    const defaults = yield* loadDefaults(env.configDir);
    const tasksBuilt = reuse
      ? reuse.state.tasks
      : yield* buildBoard({
          env,
          alive: live?.alive ?? [],
          runs,
          tasks: scanned?.tasks,
          registered: scanned?.registered,
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
            env,
            runId,
            runs: runs ?? (yield* runsOf(env)),
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
function mrAbout(run: RunFacts | null): string | null {
  const opened = run?.mr ? parseMrUrl(run.mr) : null;
  if (opened !== null) return mrTarget(opened.project, opened.iid);
  return run === null ? null : (diffTargetOf(run.settled)?.value ?? null);
}

/** One command, run against the Selection it names. The string becomes the footer note. */
export const runCommand = Effect.fn("Flows.runCommand")(function* (
  session: ControlSession,
  env: PluginEnv,
  command: Command,
  prompts: FlowPrompts,
) {
  const runOf = (runId: string) =>
    (session.runsOf ?? listRuns)(env).pipe(
      Effect.map((runs) => runs.find((run) => run.id === runId) ?? null),
    );
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
      // A run is where its newest agent is; one that has started none is only reachable
      // as the workspace it lives in.
      const agent = (yield* everyRegistered(env.stateDir)).findLast(
        (entry) => entry.runId === run.id,
      );
      if (agent) return yield* went(session.herdr.agentFocus(agent.agent));
      const workspace =
        run.workspace ??
        (run.task === null
          ? null
          : ((yield* listTasks(env.stateDir)).find((task) => task.id === run.task)?.workspace ??
            null));
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
      const stopped = yield* controlNativeRun(env, {
        runId: command.runId,
        control: "stop",
        set: true,
      });
      return stopped.ok ? stopped.human : stopped.error.message;
    }
    case "OpenLog":
      return "a Run keeps no log of its own: its agents' panes are the record";
    case "Answer": {
      const answered = yield* answerNativeRun(env, {
        runId: command.runId,
        decision: command.choiceId === "" ? null : command.choiceId,
        value: command.value,
        request: yield* newRequestId(),
      });
      return answered.ok ? `answered ${command.runId}` : answered.error.message;
    }
    case "SendReview":
      // What a finished Run offers to do next is its own declaration, and a review that
      // should reach an implementer is one of those offers. `run actions` is where they
      // are, on the board and everywhere else.
      return "a review reaches its implementer through the Run's own offers; press the action key";

    /**
     * One of the things the Run's own Workflow says it offers. Nothing here knows what
     * that is: the offer names the workflow, the facts decide whether it is still on the
     * table, and both are asked again now rather than taken from the card.
     */
    case "InvokeOffer": {
      const done = yield* invokeNativeOffer(env, {
        runId: command.runId,
        offer: command.offer,
        input: {},
        request: yield* newRequestId(),
      });
      return done.ok ? done.human : done.error.message;
    }

    case "RunWorkflow":
      return yield* launch(session, env, prompts, {
        workflow: command.workflow,
        inputs: {},
        note: `started from the Workflows view`,
      });

    case "PostReview":
      // A Run posts its own review where its workflow says to; the board does not do it
      // on the Run's behalf.
      return "a review is posted by the Run that wrote it";

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
        run?.cwd ?? env.cwd,
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
      const resumed = yield* recoverNativeRun(env, command.runId);
      if (!resumed.ok) return resumed.error.message;
      yield* controlNativeRun(env, { runId: command.runId, control: "stop", set: false });
      return resumed.human;
    }

    /** A finished plan, built: the same launch "Implement now" runs, from the card. */
    /**
     * A child Run on a finished one's outcome. What it should do is asked for here rather
     * than guessed from the parent: a follow-up with no words is a Run with no spec.
     */
    case "FollowUp": {
      const text = yield* prompts.ask(`What still needs doing on ${command.runId}?`);
      if (text === null || text.trim() === "") return null;
      const done = yield* carryOutAsked(
        env,
        [{ kind: "followup", run: command.runId, text: text.trim() }],
        { origin: "board", requestId: yield* newRequestId() },
      );
      return done.map((one) => `${one.state}: ${one.note}`).join("\n");
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
          return statusLine(run.state, line);
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
  opts: { workflow: string; inputs: Record<string, string>; note: string; parent?: RunFacts },
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
      env,
      quietMs: (yield* loadDefaults(env.configDir)).boardQuietMs,
    });
  });

  const steeringOf = Effect.fn("Flows.textBoard.steering")(function* (view: WorkspaceView) {
    const rows = [...view.active, ...view.recent];
    const live = yield* liveFor({
      stateDir: env.stateDir,
      socketPath: env.socketPath,
      run: null,
      runs: yield* Effect.gen(function* () {
        const { runs, registered } = yield* scan(env, session.runsOf);
        return rows.map((row) => {
          const run = runs.find((one) => one.id === row.id);
          return run === undefined
            ? { id: row.id, dir: row.dir, held: false, harnesses: [] }
            : markedOf(run, registered);
        });
      }),
      ownership: null,
      region: true,
    });
    return { ...live, tasks: yield* tasksOf() };
  });
  // Nothing to loop on: with no keyboard the board is a report, so it is printed once
  // and the entrypoint ends rather than spinning on a `takeKey` that can never answer.
  if (!process.stdin.isTTY) {
    const view = yield* boardOf(session, yield* scan(env, session.runsOf));
    const once = renderWorkspace(view, why, undefined, yield* steeringOf(view));
    process.stdout.write(`${once}\n`);
    return 0;
  }
  startKeyboard();
  let view = yield* boardOf(session, yield* scan(env, session.runsOf));
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
        const answered = yield* answerKey(env, waiting, asking, key);
        asking = answered.asking;
        note = answered.note ?? note;
      } else if (key === "q" || key === "\x03") {
        releaseKeyboard();
        return 0;
      } else {
        note = yield* act(session, env, view, key, open);
      }
      view = yield* boardOf(session, yield* scan(env, session.runsOf));
      read = yield* Clock.currentTimeMillis;
      continue;
    }
    if ((yield* Clock.currentTimeMillis) - read >= REFRESH_MS) {
      view = yield* boardOf(session, yield* scan(env, session.runsOf));
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
  env: PluginEnv,
  waiting: RunRow,
  asking: Asking,
  key: string,
) {
  const choice = waiting.choice;
  if (!choice) return { asking };
  const next = answerFor(choice, asking, key);
  if (next.value === null) return { asking: next.asking };
  const answered = yield* answerNativeRun(env, {
    runId: waiting.id,
    decision: choice.id === "" ? null : choice.id,
    value: next.value,
    request: yield* newRequestId(),
  });
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
  env: PluginEnv,
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
  // The text board acts on the newest run it drew rather than on a Selection, so this
  // is where "which run" is decided for it — the operations take the run itself.
  if (key === "l") {
    const row = view.active[0] ?? view.recent[0];
    if (!row) return "no run here to open a log for";
    return `${row.title} keeps no log of its own: its agents' panes are the record`;
  }
  if (key === "k") {
    const row = view.active[0];
    if (!row) return "nothing running here to stop";
    return yield* stopRun(env, row.id);
  }
  return null;
});

/**
 * Stops a run. A run used to stop when you closed its pane; the driver has no pane now,
 * so this replaces that. Its agents are left where they are: their panes are the
 * transcript of what happened.
 */
export const stopRun = Effect.fn("Flows.stopRun")(function* (env: PluginEnv, runId: string) {
  const stopped = yield* controlNativeRun(env, { runId, control: "stop", set: true });
  return stopped.ok ? stopped.human : stopped.error.message;
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
const sweep = Effect.fn("Flows.sweep")(function* (session: ControlSession, scanned: Scanned) {
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
        runs: scanned.runs,
        registered: scanned.registered,
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

/** Every Run, every Task and every registered agent, read once for all the Views of a load. */
interface Scanned {
  readonly runs: ReadonlyArray<RunFacts>;
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly registered: ReadonlyArray<AgentEntry>;
}

/** Where a board's Runs are read from. */
type RunsOf = (
  env: PluginEnv,
) => Effect.Effect<
  ReadonlyArray<RunFacts>,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
>;

const scan = Effect.fn("Flows.scan")(function* (env: PluginEnv, runsOf: RunsOf = listRuns) {
  return {
    runs: yield* runsOf(env),
    tasks: yield* listTasks(env.stateDir).pipe(Effect.catch(() => Effect.succeed([]))),
    registered: yield* everyRegistered(env.stateDir),
  } satisfies Scanned;
});

const boardOf = Effect.fn("Flows.boardOf")(function* (
  session: ControlSession,
  scanned: Scanned,
  seen?: SessionNow,
) {
  yield* sweep(session, scanned);
  const live = seen ?? (yield* liveOf(session));
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
    ...scanned,
  });
  return view;
});

/**
 * The whole herdr session as groups, from one `workspace list`, one `agent list` and
 * the run scan the local board has already done: a wide board costs one call more than
 * a local one, whatever is in the session.
 */
const wideOf = Effect.fn("Flows.wideOf")(function* (
  session: ControlSession,
  scanned: Scanned,
  seen?: SessionNow,
) {
  const live = seen ?? (yield* liveOf(session));
  return yield* buildWideView({
    session: session.session,
    stateDir: session.stateDir,
    workspaces: live.workspaces,
    alive: live.alive,
    ...scanned,
    quietMs: yield* boardQuietMs(session.configDir),
  });
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
