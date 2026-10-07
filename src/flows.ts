// What each plugin action does. Actions have no tty, so they only open a pane; the
// interactive work happens in the pane entrypoints. Every question a human answers goes
// through `InputPrompts`, so the same flow draws in a popup pane and inline in the tab.

import {
  Cause,
  Clock,
  Config,
  Console,
  type Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { EXCLUSIVE_STRATEGIES, strategyMeaning } from "./strategies";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "./projects";
import { insideCheckout } from "./agent-start";
import { placeableUnder, placedByUrl, routed, routerDeps } from "./route";
import { offerFields, offerInput, StepResult, type RunDetail } from "./board-model";
import { loadDefaults, setSetting } from "./config";
import { parseSetting, settingText } from "./settings";
import { herdOf } from "./steering";
import { chatHarnessOf, ensureChatFor } from "./chat";
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
import { isStale, layers, loadDefinitions, type Definitions, type Provenance } from "./definitions";
import { selfCommand, type PluginEnv } from "./env";
import { Herdr, type AgentInfo, type WorkspaceInfo } from "./herdr";
import { inferInput, type InputPrompts, type PickItem } from "./inputs";
import type { Found } from "./discovery";
import {
  answerRun,
  boardSnapshot,
  confirmProposed,
  controlRun,
  declineProposed,
  disposeRun,
  followBoard,
  followUpRun,
  followRunDetail,
  runDetailNow,
  type DetailKey,
  invokeOffer,
  type BoardRead,
  offersOf,
  resumeRun,
  savedModules,
  startRun,
  steerAbout,
  steerRun,
} from "./lifecycle";
import { releaseKeyboard, startKeyboard, takeKey } from "./keys";
import { forkResolvedDefinition, type DefinitionKind } from "./fork";
import { COLLIE_TAB, reason, runTitle, shellQuote } from "./naming";
import { listRuns, settled, type RunFacts } from "./runs";
import { everyRegistered, type AgentEntry } from "./registry";
import { reportedWorktrees } from "./worktree";
import { scopeFor, type RegistryScope } from "./registry";
import type { CompactionSettings } from "./compaction";
import { statusLine } from "./disposition";
import { selectionPath, writeSelection } from "./selection";
import { everyViewerPaints } from "./outer";
import { listTasks, taskOfWorkspace, type TaskChoice, type TaskRecord } from "./task";
import { newRequestId } from "./operations";
import { typedPaths } from "./attachments";
import {
  answerFor,
  openingFilter,
  rereads,
  runIdOf,
  type AppState,
  type Command,
} from "./ui/state";
import type { Focus } from "./ui/bridge";
import { buildHistory, buildSettings, buildWorkflows } from "./views";
import { nowIso } from "./time";
import { repoArgs, shell } from "./mr";
import { parseMrTarget } from "./board-model";
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

/** The steps a confirm carried out, as the host answered them. */
const CarriedSteps = Schema.Struct({ results: Schema.Array(StepResult) });

/**
 * What a board is looking at: which workspace and repository, where the state is, and
 * the pane it can split off. Its own shape rather than a Run's, because a board outlives
 * every Run it draws.
 */
interface BoardSession extends RegistryScope {
  stateDir: string;
  /** The Control Plane's own pane, which is what a temporary pane splits off. */
  paneId?: string | null;
  userDir?: string;
  /** What this caller already knows about compaction; absent reads the config file. */
  compaction?: CompactionSettings;
}

export interface ControlSession extends BoardSession {
  herdr: Herdr;
  /** This installation, so the board can say when it is behind its remote. */
  pluginRoot: string;
  /** Where the board's Runs come from: the host's, unless a test hands over its own. */
  runsOf?: RunsOf;
  /** Where the board's Tasks come from: one read of the host's board, unless followed. */
  tasksOf?: () => Effect.Effect<BoardRead>;
  /** Where the drawer's details come from: one read of the host's, unless followed; null closes it. */
  detailOf?: (key: DetailKey | null) => Effect.Effect<RunDetail | null>;
  /** Where the defaults live. */
  userDir: string;
}

export type Mode = "pick" | "continue" | "resume" | "fork";

/**
 * Where a launch flow is being drawn. Only a popup can close itself, and the tab's
 * inline placement closing "the popup" closed whatever unrelated one the session had
 * open elsewhere.
 */
export type Placement = "popup" | "inline";

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
    yield* chatHarnessOf(env.userDir),
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
 * Whether this flow was opened from the Herd's Home (ADR-0009): Collie's own namespace
 * directory, which is no checkout, so a Run started there is placed rather than asked.
 */
const fromHome = Effect.fn("Flows.fromHome")(function* (env: PluginEnv) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  const home = key === null ? null : yield* readHome(yield* homePath(env.stateDir, key));
  return home !== null && home !== UNREADABLE && env.workspaceId === home.workspaceId;
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
  const task =
    here === null ? yield* pickTask(env, prompts) : ({ mode: "continue", task: here } as const);
  if (task === null) return 0;
  return yield* pickFlow(herdr, env, prompts, placement, task);
});

/** The picker's own id for keeping the work in the workspace it was opened from. */
const HERE = "here";

/**
 * Which Task, when this is not one's workspace — or this workspace itself, kept as the
 * work's Task rather than given a workspace of its own. Null is the human backing out.
 */
const pickTask = Effect.fn("Flows.pickTask")(function* (env: PluginEnv, prompts: FlowPrompts) {
  const tasks = yield* listTasks(env.stateDir);
  const kept =
    env.workspaceId === null
      ? []
      : [{ id: HERE, title: "This workspace", subtitle: "keep the work here, beside you" }];
  if (tasks.length === 0 && kept.length === 0) {
    yield* bail(prompts, "No tasks yet: starting a workflow makes one.");
    return null;
  }
  const chosen = yield* prompts.menu(
    [...kept, ...tasks.map((task) => ({ id: task.id, title: task.label, subtitle: task.cwd }))],
    {
      header: "Which task?",
      footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    },
  );
  if (chosen?.id === HERE) return { mode: "here" } as const;
  const task = tasks.find((one) => one.id === chosen?.id);
  return task === undefined ? null : ({ mode: "continue", task } as const);
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
  const task = opts.task ?? { mode: "new" };
  // A workflow saved as a module is started through the host, with the same claim and
  // the same rows `collie run start` uses — the Run is the same either way.
  const saved = yield* savedModules(env);
  const module = saved.entries.find((entry) => entry.id === opts.workflow);
  if (module) {
    const started = yield* startModule(herdr, env, prompts, { ...opts, task }, module);
    if (started === null || "line" in started) return started?.line ?? null;
    const plan = saved.entries.find(plansAGoal);
    if (plan === undefined) {
      yield* bail(
        prompts,
        "No workflow module takes a goal and fixes its outcome as a plan, so nothing can plan it instead.",
      );
      return null;
    }
    const planned = yield* startModule(
      herdr,
      env,
      prompts,
      { ...opts, task, given: {}, words: started.planInstead },
      plan,
    );
    return planned !== null && "line" in planned ? planned.line : null;
  }
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
 * A saved module from the name to a started Run (ADR-0033): one question for its launch
 * Input, everything else inferred, and what was inferred shown before the start. A start
 * still missing a required Input is refused with the reason, never asked again.
 */
const startModule = Effect.fn("Flows.startModule")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: {
    placement: Placement;
    given?: Record<string, string>;
    /** The human's words, already said, for the launch Input. */
    words?: string;
    parent?: RunFacts;
    task: TaskChoice;
  },
  module: Found,
) {
  const launchInput = module.inputs.find((field) =>
    EXCLUSIVE_STRATEGIES.includes(field.strategy ?? ""),
  );
  const home = yield* fromHome(env);
  const text = { ...opts.given };
  const inferred = new Map<string, string>();
  const strategy = launchInput?.strategy ?? "";
  let words = opts.words ?? "";
  if (
    launchInput !== undefined &&
    text[launchInput.name] === undefined &&
    opts.words === undefined
  ) {
    const answer = yield* prompts.ask(WHAT_DO_YOU_WANT);
    if (answer === null) return null;
    words = answer.trim();
  }
  let at = env;
  let rooted = false;
  if (home) {
    if (launchInput === undefined) {
      yield* bail(prompts, `${module.id} needs a checkout: start it from one.`);
      return null;
    }
    const root = (yield* projectsRoot(env)).path;
    const candidates = strategy === "goal" ? [] : yield* placeableUnder(root);
    const byUrl = placedByUrl(words, candidates);
    // A repository URL no checkout here has is cloned by the Run, as it always was.
    if (
      strategy === "goal" ||
      (byUrl === null && strategy === "gitlab-repository" && isUrl(words))
    ) {
      rooted = true;
      at = { ...env, cwd: root, workspaceId: null };
    } else {
      const placed = byUrl ?? (yield* routed(yield* routerDeps(env), words, candidates));
      if (placed === null) {
        const chosen = yield* prompts.menu(
          [{ id: PLAN_INSTEAD, title: "Plan it instead", subtitle: `a plan at ${root}` }],
          {
            header: "No one checkout under the Projects root is this",
            footer: "Enter plan · Esc cancel",
          },
        );
        return chosen === null ? null : { planInstead: words };
      }
      at = { ...env, cwd: placed.path, workspaceId: null };
      inferred.set(WORKSPACE, byUrl === null ? "your words" : `its remote, ${placed.project}`);
      if (strategy === "gitlab-repository" && byUrl !== null) {
        text[launchInput.name] = placed.path;
        inferred.set(launchInput.name, "the checkout its URL names");
      }
    }
  }
  if (launchInput !== undefined && text[launchInput.name] === undefined) {
    if (words !== "" && (yield* wordsAre(strategy, words, at.cwd))) text[launchInput.name] = words;
    else if (strategy === "gitlab-repository" && (yield* insideCheckout(at.cwd))) {
      text[launchInput.name] = at.cwd;
      inferred.set(
        launchInput.name,
        home ? "the checkout it was placed in" : "the checkout you are in",
      );
    }
  }
  for (const field of module.inputs) {
    if (text[field.name] !== undefined) continue;
    const found =
      field.strategy === null ? null : yield* infer(at, opts, field.name, field.strategy);
    if (found !== null) {
      text[field.name] = found.value;
      inferred.set(field.name, found.source);
      continue;
    }
    if (field.required) {
      const meaning = field.strategy === null ? "" : strategyMeaning(field.strategy);
      yield* bail(
        prompts,
        `${module.id} needs "${field.name}"${meaning === "" ? "" : ` (${meaning})`}, and nothing in ${at.cwd} gave one.`,
      );
      return null;
    }
  }
  if (inferred.size > 0) {
    const inputs = Object.entries(text).map(
      ([name, value]) =>
        `${name} = ${value} (${inferred.has(name) ? `inferred from ${inferred.get(name)}` : "given"})`,
    );
    const confirmed = yield* prompts.menu(
      [{ id: "start", title: `Starting in ${at.cwd}`, subtitle: inputs.join(" · ") }],
      { header: module.title, footer: "Enter start · Esc cancel" },
    );
    if (confirmed === null) return null;
  }
  const started = yield* startRun(at, {
    door: "board",
    id: module.id,
    request: yield* newRequestId(),
    input: { json: {}, text, inferred: [...inferred.keys()] },
    options: rooted
      ? { workspace: PROJECTS_ROOT_OPTION }
      : inferred.has(WORKSPACE)
        ? { workspace: at.cwd }
        : {},
    task: opts.task,
    parent: opts.parent?.id ?? null,
  });
  if (!started.ok) {
    yield* bail(prompts, started.error.message);
    return null;
  }
  if (opts.placement === "popup") yield* Effect.ignore(herdr.popupClose());
  const given = Object.entries(text).map(([name, value]) => `${name}=${value}`);
  return { line: `${module.id}: ${given.join("  ")} → ${started.runId}` };
});

/** The one question a start asks: what the human wants, in their own words. */
const WHAT_DO_YOU_WANT = "What do you want?";

/** The row a start from the Home that no one checkout fits is offered instead. */
const PLAN_INSTEAD = "plan-instead";

/** A module that plans from a goal, by what it declares rather than what it is called. */
const plansAGoal = (found: Found) =>
  found.outcome === "plan" && found.inputs.some((field) => field.strategy === "goal");

/** The host option a placed start names its checkout with, recorded as inferred. */
const WORKSPACE = "workspace";

const isUrl = (words: string) => /^(https?:\/\/|git@)/.test(words);

/**
 * Whether a human's words are a value of the launch Input's kind, rather than words about
 * where the work is: any words are a goal or a work source, a merge request URL, an iid or
 * a ref here is a diff target, and a URL or an absolute path is a repository.
 */
const wordsAre = Effect.fn("Flows.wordsAre")(function* (
  strategy: string,
  words: string,
  cwd: string,
) {
  if (strategy === "goal" || strategy === "work-source") return true;
  if (strategy === "gitlab-repository") return /^(https?:\/\/|git@|\/)/.test(words);
  if (strategy !== "diff-target") return false;
  if (/\/-\/merge_requests\/\d+/.test(words) || /^!?\d+$/.test(words)) return true;
  if (/\s/.test(words)) return false;
  const ref = yield* shell("git", ["rev-parse", "--verify", "--quiet", `${words}^{commit}`], cwd);
  return ref.code === 0;
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
  return settled;
});

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
  const runs = (yield* listRuns(env)).filter((run) => !settled(run));
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

  const resumed = yield* resumeRun(env, {
    door: "board",
    runId: chosen.id,
    request: yield* newRequestId(),
  });
  if (!resumed.ok) return yield* bail(prompts, `${chosen.id}: ${resumed.error.message}`);
  // Only a popup can close itself; running the picker in a plain pane is fine..
  if (placement === "popup") yield* Effect.ignore(herdr.popupClose());
  return 0;
});

/** Each field an offer takes, asked for in turn; null on cancel. */
const offerArguments = Effect.fn("Flows.offerArguments")(function* (
  prompts: FlowPrompts,
  drawn: Schema.Json | null,
) {
  const typed: Record<string, string> = {};
  for (const { name, required } of offerFields(drawn)) {
    const answer = yield* prompts.ask(required ? `${name}?` : `${name}? (optional)`);
    if (answer === null) return null;
    typed[name] = answer;
  }
  return offerInput(drawn, typed);
});

/**
 * Files handed to the Run's newest live agent: the steer `run steer --attach` makes, with
 * no words of its own. The note for the footer, or null where nothing was typed.
 */
export const attachFiles = Effect.fn("Flows.attachFiles")(function* (
  env: PluginEnv,
  prompts: FlowPrompts,
  runId: string,
) {
  const typed = yield* prompts.ask(`Which files go to ${runId}? Paths, separated by spaces`);
  const paths = typedPaths(typed ?? "");
  if (paths.length === 0) return null;
  const path = yield* Path.Path;
  const done = yield* steerRun(env, {
    door: "board",
    runId,
    text: "",
    attachments: paths.map((one) => path.resolve(env.cwd, one)),
    request: yield* newRequestId(),
  });
  return done.ok ? done.human : done.error.message;
});

/**
 * One offer of the Run's module, as it stands now, asked for what it takes and then made.
 * The note for the footer, or null where the human cancelled the asking.
 */
export const makeOffer = Effect.fn("Flows.makeOffer")(function* (
  env: PluginEnv,
  prompts: FlowPrompts,
  runId: string,
  chosen: string,
) {
  const listed = yield* offersOf(env, runId);
  if ("ok" in listed) return listed.error.message;
  const offer = listed.find((one) => one.id === chosen);
  if (offer === undefined) return `${runId} no longer offers ${chosen}`;
  if (offer.unavailable !== null) return `${offer.title}: ${offer.unavailable}`;
  const input = yield* offerArguments(prompts, offer.arguments);
  if (input === null) return null;
  const done = yield* invokeOffer(env, {
    door: "board",
    runId,
    offer: offer.id,
    input,
    request: yield* newRequestId(),
  });
  return done.ok ? done.human : done.error.message;
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
/** The board's exit when its binary was rebuilt: the pane's command starts the new one. */
export const RELAUNCH = 75;

/**
 * Reads `file` now, and gives back what completes once it is a different file than it was:
 * a build renames a new binary over the old one, so an upgrade is a new inode under the
 * same path. That never completes where the file cannot be read, as under `bun src/main.ts`.
 */
export const replacedOnDisk = (
  file: string,
  every: Duration.Input = "2 seconds",
): Effect.Effect<Effect.Effect<void>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inode = fs.stat(file).pipe(
      Effect.map((info) => Option.getOrNull(info.ino)),
      Effect.orElseSucceed(() => null),
    );
    const start = yield* inode;
    if (start === null) return Effect.never;
    return inode.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(every),
        until: (now) => now !== null && now !== start,
      }),
      Effect.asVoid,
    );
  });

export const workspaceFlow = Effect.fn("Flows.workspaceFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
) {
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
  const session: ControlSession = {
    herdr,
    ...scopeFor(env, env.cwd),
    stateDir: env.stateDir,
    paneId: env.paneId,
    pluginRoot: env.pluginRoot,
    userDir: env.userDir,
    // The Control Plane runs its actions on one fiber, one at a time, so a hand-off to
    // an agent over the threshold must not hold that queue while a compaction runs. It
    // asks, and reports that the compaction is in the air; the human presses the key
    // again when the pane says it has finished. No work is sent either way.
    compaction: { waitMs: 0 },
    tasksOf: yield* followBoard(env),
    detailOf: yield* followRunDetail(env),
  };
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
      : openingFilter((yield* loadDefaults(env.userDir)).scope, origin);
  // An upgrade that leaves this board drawing the old build is an upgrade the human
  // believes happened and did not, so a rebuilt binary closes it for the new one.
  let replaced = false;
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
      const navigate = (run: string) =>
        dispatch?.({ _tag: "SetFilter", filter: { kind: "run", id: run } });
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
        act: (command, prompts) => runCommand(session, env, command, prompts, navigate),
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
      }).pipe(
        Effect.raceFirst(
          Effect.flatten(replacedOnDisk(process.execPath)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                replaced = true;
              }),
            ),
          ),
        ),
      );
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
  if (why === null) return replaced ? RELAUNCH : 0;
  return yield* textBoard(session, herdr, env, why);
}, Effect.scoped);

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

/** One Run's details from the host, as this session reads them. */
const detailRead = (session: ControlSession, env: PluginEnv, key: DetailKey) =>
  session.detailOf?.(key) ?? runDetailNow(env, key);

/** The host's board, as this session reads it. */
const boardRead = (session: ControlSession, env: PluginEnv) =>
  session.tasksOf?.() ??
  boardSnapshot(env).pipe(
    Effect.map((read): BoardRead =>
      read.ok
        ? { tasks: read.value.tasks, unreadable: null }
        : { tasks: [], unreadable: read.error.message },
    ),
  );

/** Everything the app draws, for whatever it is looking at. */
export function appState(
  session: ControlSession,
  env: PluginEnv,
  /**
   * The Home's ownership question, when there is one nobody has settled. Decided once at
   * startup rather than per tick: it is a herdr answer, `collie home reconcile` is what
   * clears it, and re-asking every three seconds would be two calls a tick for a fact
   * only a human changes.
   */
  ownership: Live["ownership"] = null,
) {
  const runsOf = session.runsOf ?? listRuns;
  /** The board from the last read, for whatever `rereads` says may be taken from it. */
  let last: { focus: Focus; state: AppState } | null = null;
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
    const defaults = yield* loadDefaults(env.userDir);
    const read = reuse ? null : yield* boardRead(session, env);
    const tasksBuilt = read === null ? reuse!.state.tasks : read.tasks;
    const state = {
      view: focus.view,
      filter: focus.filter,
      // The host's board, Herd-wide: a workspace is a filter over one board, never a board
      // of its own (ADR-0009).
      tasks: tasksBuilt,
      now: yield* Clock.currentTimeMillis,
      density: defaults.density,
      wide,
      board,
      // A reuse read the board not at all, so what it said last still holds.
      note: read === null ? reuse!.state.note : read.unreadable,
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
      // The host's, followed while the drawer is open; `R` asks its merge watch again.
      detail: runId
        ? yield* detailRead(session, env, {
            runId,
            tail: focus.tail,
            pages: focus.reviewPages,
            refreshMr: again.forceMr,
          })
        : yield* session.detailOf?.(null) ?? Effect.succeed(null),
    } satisfies AppState;
    last = { focus, state };
    return state;
  });

  return { load };
}

/** One command, run against the Selection it names. The string becomes the footer note. */
export const runCommand = Effect.fn("Flows.runCommand")(function* (
  session: ControlSession,
  env: PluginEnv,
  command: Command,
  prompts: FlowPrompts,
  /** Puts a Run on the board's screen, for a confirmed `navigate`. */
  navigate: (runId: string) => void = () => {},
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
      const stopped = yield* controlRun(env, {
        door: "board",
        runId: command.runId,
        control: "stop",
        set: true,
        request: yield* newRequestId(),
      });
      return stopped.ok ? stopped.human : stopped.error.message;
    }
    case "HoldRun": {
      const held = yield* controlRun(env, {
        door: "board",
        runId: command.runId,
        control: "hold",
        set: command.set,
        request: yield* newRequestId(),
      });
      if (!held.ok) return held.error.message;
      return `${command.set ? "Held" : "Released"} ${command.runId}`;
    }
    case "OpenLog":
      return "a Run keeps no log of its own: its agents' panes are the record";
    case "OpenCheckOutput": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const workspace =
        run.workspace ??
        (run.task === null
          ? null
          : ((yield* listTasks(env.stateDir)).find((task) => task.id === run.task)?.workspace ??
            null));
      // The same state directory as this board's, whatever the pane's shell would default to.
      const follow = [
        "env",
        `HERDR_PLUGIN_STATE_DIR=${env.stateDir}`,
        ...selfCommand(),
        "run",
        "checks",
        run.id,
        "--follow",
      ]
        .map(shellQuote)
        .join(" ");
      return yield* session.herdr
        .tabCreate({ label: "check output", cwd: run.cwd, focus: true, workspace })
        .pipe(
          Effect.flatMap((tab) => session.herdr.paneRun(tab.paneId, follow)),
          Effect.as(`following ${run.id}'s check`),
          Effect.catch((cause) => Effect.succeed(`${run.id}'s check output: ${reason(cause)}`)),
        );
    }
    case "Answer": {
      const answered = yield* answerRun(env, {
        door: "board",
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
    case "InvokeOffer":
      return yield* makeOffer(env, prompts, command.runId, command.offer);

    /** What the Run's module offers now, the one chosen asked for what it takes, then made. */
    case "ChooseOffer": {
      const listed = yield* offersOf(env, command.runId);
      if ("ok" in listed) return listed.error.message;
      const open = listed.filter((one) => one.unavailable === null);
      if (open.length === 0) return `${command.runId} offers nothing now`;
      const chosen = yield* prompts.menu(
        open.map((one) => ({ id: one.id, title: one.title, subtitle: one.workflow })),
        { header: `What next for ${command.runId}?` },
      );
      if (chosen === null) return null;
      return yield* makeOffer(env, prompts, command.runId, chosen.id);
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

    case "ConfirmProposal": {
      const done = yield* confirmProposed(env, {
        door: "board",
        proposal: command.id,
        hash: command.hash,
        request: yield* newRequestId(),
      });
      // A confirmed `navigate` puts its target on screen here: the host has no screen.
      // Even where a later action failed: an applied one did happen.
      const carried = Schema.decodeUnknownOption(CarriedSteps)(
        done.ok ? done.data : done.error.details,
      );
      for (const step of Option.getOrElse(carried, () => ({ results: [] })).results)
        if (step.kind === "navigate" && step.state === "applied" && step.run !== null)
          navigate(step.run);
      return done.ok ? done.human : done.error.message;
    }

    case "DeclineProposal": {
      const done = yield* declineProposed(env, {
        door: "board",
        proposal: command.id,
        hash: command.hash,
        request: yield* newRequestId(),
      });
      return done.ok ? done.human : done.error.message;
    }

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
      const parsed = parseSetting(command.key, command.value);
      if ("refused" in parsed) return parsed.refused;
      return yield* setSetting(env.userDir, command.key, parsed.value, yield* nowIso()).pipe(
        // What was written, so the note cannot disagree with the file.
        Effect.as(`${command.key} is now ${settingText(parsed.value) || "unset"}`),
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

    /** A Run taken up again where it stopped, as every door resumes one. */
    case "ResumeRun": {
      const resumed = yield* resumeRun(env, {
        door: "board",
        runId: command.runId,
        request: yield* newRequestId(),
      });
      return resumed.ok ? resumed.human : resumed.error.message;
    }

    case "AttachFiles":
      return yield* attachFiles(env, prompts, command.runId);

    /** A finished plan, built: the same launch "Implement now" runs, from the card. */
    /**
     * A child Run on a finished one's outcome. What it should do is asked for here rather
     * than guessed from the parent: a follow-up with no words is a Run with no spec.
     */
    case "FollowUp": {
      const text = yield* prompts.ask(`What still needs doing on ${command.runId}?`);
      if (text === null || text.trim() === "") return null;
      const done = yield* followUpRun(env, {
        door: "board",
        runId: command.runId,
        text: text.trim(),
        request: yield* newRequestId(),
      });
      return done.ok ? done.human : done.error.message;
    }

    /**
     * One thing said to Collie about one Run. It carries nothing out on its own: the
     * evaluator answers with a proposal, which arrives as that Task's decision card.
     */
    case "Steer": {
      const run = yield* runOf(command.runId);
      if (!run) return `${command.runId} has gone`;
      const said = yield* steerAbout(env, {
        door: "board",
        runId: run.id,
        text: command.text,
        from: null,
        dryRun: false,
        request: yield* newRequestId(),
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
      const done = yield* disposeRun(env, {
        door: "board",
        runId: run.id,
        kind: command.kind,
        ref: command.ref,
        note: null,
        request: yield* newRequestId(),
      });
      return done.ok ? statusLine(run.state, done.value) : done.error.message;
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
  let unreadable: string | null = null;
  /** The board's own Tasks, so the text view and the pane draw the same sections. */
  const tasksOf = () =>
    boardRead(session, env).pipe(
      Effect.map((read) => {
        unreadable = read.unreadable;
        return read.tasks;
      }),
    );

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
    const steering = yield* steeringOf(view);
    const once = renderWorkspace(view, unreadable ?? why, undefined, steering);
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
      yield* announce(herdr, env, session.userDir);
    }
    if (!waiting) answering = null;

    const steering = yield* steeringOf(view);
    const text = renderWorkspace(view, unreadable ?? note ?? undefined, asking, steering);
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
  userDir: string,
) {
  // Same opt-out as the Driver's: `questions: notify` leaves the question on the
  // board and in the toast, and only stops it moving the human here.
  if ((yield* loadDefaults(userDir)).questions === "notify") return;
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
  const answered = yield* answerRun(env, {
    door: "board",
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
  const stopped = yield* controlRun(env, {
    door: "board",
    runId,
    control: "stop",
    set: true,
    request: yield* newRequestId(),
  });
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
 * How long the board's own quiet threshold stands before `config.json` is read again.
 * The board redraws every three seconds and on every filesystem event, and this value
 * changes only when a human writes it in Settings — so re-parsing the file per redraw
 * was thousands of reads an hour for one open pane. The same reasoning, and the same
 * shape, as the `behindRemote` count in `src/doctor.ts`.
 */
const QUIET_FOR_MS = 30_000;
const quietSeen = new Map<string, { at: number; quietMs: number }>();

const boardQuietMs = Effect.fn("Flows.boardQuietMs")(function* (userDir: string) {
  const now = yield* Clock.currentTimeMillis;
  const seen = quietSeen.get(userDir);
  if (seen && now - seen.at < QUIET_FOR_MS) return seen.quietMs;
  const quietMs = (yield* loadDefaults(userDir)).boardQuietMs;
  quietSeen.set(userDir, { at: now, quietMs });
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
  const live = seen ?? (yield* liveOf(session));
  const view = yield* buildView({
    ...session,
    stateDir: session.stateDir,
    // The live label is how a run recorded against a since-recycled workspace id is
    // kept out; without it the board falls back to the id alone.
    workspaceLabel:
      live.workspaces.find((w) => w.workspaceId === session.workspaceId)?.label ?? null,
    alive: live.alive,
    worktrees: yield* reportedWorktrees(session.stateDir),
    pluginRoot: session.pluginRoot,
    quietMs: yield* boardQuietMs(session.userDir),
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
    quietMs: yield* boardQuietMs(session.userDir),
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
