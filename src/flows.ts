import * as Arr from "effect/Array";
import { asksRun } from "./lifecycle";
import { withArtefacts } from "./artefact-client";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import { newerRelease, releasesOf, RELEASES } from "./releases";
import manifest from "../package.json";
import * as Result from "effect/Result";
import { withNotice } from "./redact";
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
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { EXCLUSIVE_STRATEGIES, strategyMeaning } from "./strategies";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "./projects";
import { insideCheckout } from "./agent-start";
import { placeableUnder, placedByUrl, routed, routerDeps } from "./route";
import { offerChoices, offerFields, offerInput, StepResult, type RunDetail } from "./board-model";
import { gitlabHostOf, loadDefaults, savedReach, setSetting } from "./config";
import { reachOf, savedFirst } from "./reach";
import { parseSetting, settingText } from "./settings";
import { herdDir, machineHerd } from "./steering";
import { liveFor, markedOf, type Ledgers } from "./live";
import { RunRecords } from "./run-records";
import { isStale, layers, loadDefinitions, type Definitions, type Provenance } from "./definitions";
import type { PluginEnv } from "./env";
import { Herdr } from "./herdr";
import { inferInput, type InputPrompts, type PickItem } from "./inputs";
import type { Found } from "./discovery";
import {
  answerRun,
  boardSnapshot,
  confirmProposed,
  controlRun,
  declineProposed,
  disposeRun,
  seeRun,
  followBoard,
  followUpRun,
  followRunDetail,
  runDetailNow,
  asks,
  hostTasks,
  type DetailKey,
  invokeOffer,
  launchProject,
  type BoardRead,
  offersOf,
  resumeRun,
  savedModules,
  startRun,
  steerAbout,
  steerRun,
  usageReadings,
  hostProposals,
  hostRegistered,
} from "./lifecycle";
import type { UsageReading } from "./usage-model";
import { keyboard } from "./keys";
import { forkResolvedDefinition, type DefinitionKind } from "./fork";
import { COLLIE_TAB, reason, runTitle } from "./naming";
import { listRuns, settled, type RunFacts } from "./runs";
import { type AgentEntry } from "./registry";
import { reportedWorktrees } from "./worktree";
import { scopeFor, type RegistryScope } from "./registry";
import type { CompactionSettings } from "./compaction";
import { statusLine } from "./disposition";
import { selectionPath, writeSelection } from "./selection";
import type { TaskChoice, TaskRecord } from "./task";
import { newRequestId } from "./operations";
import { typedPaths } from "./attachments";
import { answerFor, rereads, runIdOf, type AppState, type Command } from "./ui/state";
import type { Focus } from "./ui/bridge";
import { buildHistory, buildSettings, buildWorkflows } from "./views";
import { nowIso } from "./time";
import { shell } from "./mr";
import { forgeOf } from "./forge/forge";
import { forgeHttpLayer } from "./forge/http";
import { parseMrTarget, readMrRef } from "./board-model";
import type { ChildProcessSpawner } from "effect/process";
import {
  agentForKey,
  askingRun,
  buildView,
  renderWorkspace,
  type Asking,
  type RunRow,
  type WorkspaceView,
} from "./workspace";

const CarriedSteps = Schema.Struct({ results: Schema.Array(StepResult) });

interface BoardSession extends RegistryScope {
  stateDir: string;
  userDir?: string;
  compaction?: CompactionSettings;
}

export interface ControlSession extends BoardSession {
  herdr: Herdr;
  pluginRoot: string;
  releases?: string;
  runsOf?: RunsOf;
  recordsOf?: RecordsOf;
  ledgers?: Ledgers;
  tasksOf?: () => Effect.Effect<BoardRead>;
  detailOf?: (key: DetailKey | null) => Effect.Effect<RunDetail | null>;
  usageOf?: () => Effect.Effect<ReadonlyArray<UsageReading>>;
  userDir: string;
}

export type Mode = "pick" | "continue" | "resume" | "fork";

const fromBoard = Effect.fn("Flows.fromBoard")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  return key !== null && env.cwd === (yield* herdDir(env.stateDir, key));
});

function banner(defs: Definitions) {
  if (defs.errors.length === 0) return undefined;
  return Arr.join(
    ["Definitions with errors (skipped):", ...Arr.map(defs.errors, (e) => `  ${e}`)],
    "\n",
  );
}

export type FlowPrompts = InputPrompts;

export const continueFlow = Effect.fn("Flows.continueFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
) {
  const task = yield* pickTask(env, prompts);
  if (task === null) return 0;
  return yield* pickFlow(herdr, env, prompts, task);
});

const pickTask = Effect.fn("Flows.pickTask")(function* (env: PluginEnv, prompts: FlowPrompts) {
  const tasks = yield* hostTasks(env);
  if (tasks.length === 0) {
    yield* bail(prompts, "No tasks yet: starting a workflow makes one.");
    return null;
  }
  const chosen = yield* prompts.menu(
    Arr.map(tasks, (task) => ({ id: task.id, title: task.label, subtitle: task.cwd })),
    {
      header: "Which task?",
      footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    },
  );
  const task = Option.getOrUndefined(Arr.findFirst(tasks, (one) => one.id === chosen?.id));
  return task === undefined ? null : ({ mode: "continue", task } as const);
});

export const pickFlow = Effect.fn("Flows.pickFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
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
  const items: PickItem[] = [...offered.values()].sort((a, b) =>
    pipe_(a.id, Str.localeCompare(b.id)),
  );

  if (items.length === 0) {
    return yield* bail(prompts, "No workflows found. Check the plugin's workflows/ directory.");
  }

  const chosen = yield* prompts.menu(items, {
    header: headed(`Workflows — ${env.cwd}`),
    footer: "↑↓ move · type to filter · Enter run · Esc cancel",
  });
  if (!chosen) return 0;

  yield* startChosen(herdr, env, prompts, { workflow: chosen.id, task });
  return 0;
});

const startChosen = Effect.fn("Flows.startChosen")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: {
    workflow: string;
    given?: Record<string, string>;
    parent?: RunFacts;
    task?: TaskChoice;
  },
) {
  const task = opts.task ?? { mode: "new" };
  const saved = yield* savedModules(env);
  const module = Option.getOrUndefined(
    Arr.findFirst(saved.entries, (entry) => entry.id === opts.workflow),
  );
  if (module) {
    const started = yield* startModule(herdr, env, prompts, { ...opts, task }, module);
    if (started === null || "line" in started) return started?.line ?? null;
    const plan = Option.getOrUndefined(Arr.findFirst(saved.entries, plansAGoal));
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
  const broken = Option.getOrUndefined(
    Arr.findFirst(saved.problems, (problem) => problem.id === opts.workflow),
  );
  if (broken) {
    yield* bail(prompts, `${broken.path}: ${broken.message}`);
    return null;
  }
  yield* bail(
    prompts,
    `No workflow module is saved as "${opts.workflow}". \`collie workflow list\` is what this installation has.`,
  );
  return null;
});

const startModule = Effect.fn("Flows.startModule")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: {
    given?: Record<string, string>;
    words?: string;
    parent?: RunFacts;
    task: TaskChoice;
  },
  module: Found,
) {
  const launchInput = Option.getOrUndefined(
    Arr.findFirst(module.inputs, (field) => EXCLUSIVE_STRATEGIES.includes(field.strategy ?? "")),
  );
  const home = yield* fromBoard(env);
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
    words = Str.trim(answer);
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
    if (strategy === "goal" || (byUrl === null && strategy === "repository" && isUrl(words))) {
      rooted = true;
      at = { ...env, cwd: root };
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
      at = { ...env, cwd: placed.path };
      inferred.set(WORKSPACE, byUrl === null ? "your words" : `its remote, ${placed.project}`);
      if (strategy === "repository" && byUrl !== null) {
        text[launchInput.name] = placed.path;
        inferred.set(launchInput.name, "the checkout its URL names");
      }
    }
  }
  if (launchInput !== undefined && text[launchInput.name] === undefined) {
    if (words !== "" && (yield* wordsAre(strategy, words, at.cwd))) text[launchInput.name] = words;
    else if (strategy === "repository" && (yield* insideCheckout(at.cwd))) {
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
  const inputs = Arr.map(
    Rec.toEntries(text),
    ([name, value]) =>
      `${name} = ${value} (${inferred.has(name) ? `inferred from ${inferred.get(name)}` : "given"})`,
  );
  const reach = reachOf(module.inputs);
  if (reach !== null && text[reach.name] === undefined) {
    const saved = yield* savedReach(
      env.userDir,
      module.id,
      yield* launchProject(at.cwd, rooted ? PROJECTS_ROOT_OPTION : undefined),
    );
    const chosen = yield* prompts.menu(
      Arr.map(savedFirst(reach, saved), (choice) => ({
        id: `${REACH_ROW}${choice.value}`,
        title: choice.title,
        subtitle: Arr.join([`Starting in ${at.cwd}`, ...inputs], " · "),
      })),
      { header: module.title, footer: "↑↓ how far it goes · Enter start · Esc cancel" },
    );
    if (chosen === null) return null;
    text[reach.name] = pipe_(chosen.id, Str.slice(REACH_ROW.length));
  } else if (inferred.size > 0) {
    const confirmed = yield* prompts.menu(
      [{ id: "start", title: `Starting in ${at.cwd}`, subtitle: Arr.join(inputs, " · ") }],
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
  const given = Arr.map(Rec.toEntries(text), ([name, value]) => `${name}=${value}`);
  return {
    line: withNotice(
      `${module.id}: ${Arr.join(given, "  ")} → ${started.runId}`,
      started.redacted,
      " — ",
    ),
  };
});

const WHAT_DO_YOU_WANT = "What do you want?";

const REACH_ROW = "reach:";

const PLAN_INSTEAD = "plan-instead";

const plansAGoal = (found: Found) =>
  found.outcome === "plan" && Arr.some(found.inputs, (field) => field.strategy === "goal");

const WORKSPACE = "workspace";

const isUrl = (words: string) => /^(https?:\/\/|git@)/.test(words);

const wordsAre = Effect.fn("Flows.wordsAre")(function* (
  strategy: string,
  words: string,
  cwd: string,
) {
  if (strategy === "goal" || strategy === "work-source") return true;
  if (strategy === "repository") return /^(https?:\/\/|git@|\/)/.test(words);
  if (strategy !== "diff-target") return false;
  if (readMrRef(words, { project: null }) !== null) return true;
  if (/\s/.test(words)) return false;
  const ref = yield* shell("git", ["rev-parse", "--verify", "--quiet", `${words}^{commit}`], cwd);
  return ref.code === 0;
});

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
    gitlabHost: yield* gitlabHostOf(env).pipe(Effect.orElseSucceed(() => undefined)),
  }).pipe(
    Effect.provide(forgeHttpLayer),
    Effect.orElseSucceed(() => null),
  );
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

  for (const persona of [...defs.personas.values()].sort((a, b) =>
    pipe_(a.name, Str.localeCompare(b.name)),
  )) {
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

  let step: string | undefined;
  if (how.id === "extends" && source.steps.length > 0) {
    const which = yield* prompts.menu(
      Arr.map(source.steps, (id) => ({ id, title: id })),
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

function layerOf(def: Provenance) {
  const parts = [`[${def.layer}]`];
  if (def.extends) parts.push(`extends ${def.extends}`);
  if (isStale(def)) parts.push("(stale — the original has changed since this copy)");
  return Arr.join(parts, " ");
}

export const resumeFlow = Effect.fn("Flows.resumeFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
) {
  const runs = Arr.filter(yield* listRuns(env), (run) => !settled(run));
  if (runs.length === 0) return yield* bail(prompts, "No runs are still going to pick back up.");

  const items: PickItem[] = Arr.map(runs, (run) => ({
    id: run.id,
    title: runTitle(run),
    subtitle: `${run.state} · ${pipe_(run.created, Str.slice(0, 16), Str.replace("T", " "))}`,
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
  return 0;
});

const offerArguments = Effect.fn("Flows.offerArguments")(function* (
  prompts: FlowPrompts,
  drawn: Schema.Json | null,
) {
  const typed: Record<string, string> = {};
  let asking = Arr.map(offerFields(drawn), (field) => ({
    field,
    question: field.required ? `${field.name}?` : `${field.name}? (optional)`,
  }));
  while (true) {
    for (const { field, question } of asking) {
      if (field.control.kind === "enum") {
        const choices = offerChoices(field);
        const chosen = yield* prompts.menu(
          Arr.map(choices, (one) => ({ id: one.key, title: one.label })),
          { header: question, footer: "↑↓ move · Enter choose · Esc cancel" },
        );
        if (chosen === null) return null;
        const entry = Option.getOrUndefined(
          Arr.findFirst(choices, (one) => one.key === chosen.id),
        )?.entry;
        if (entry === undefined) delete typed[field.name];
        else typed[field.name] = entry;
      } else {
        const answer = yield* prompts.ask(question);
        if (answer === null) return null;
        if (answer === "" && !field.required) delete typed[field.name];
        else typed[field.name] = answer;
      }
    }
    const read = offerInput(drawn, typed);
    if (read._tag === "Valid") return read.input;
    asking = Arr.filterMap(offerFields(drawn), (field) =>
      read.errors[field.name] === undefined
        ? Result.failVoid
        : Result.succeed({ field, question: `${read.errors[field.name]}. ${field.name}?` }),
    );
  }
});

const confirmed = Effect.fn("Flows.confirmed")(function* (
  prompts: FlowPrompts,
  offer: { readonly title: string; readonly confirm?: string },
) {
  if (offer.confirm === undefined) return true;
  const chosen = yield* prompts.menu(
    [
      { id: "take", title: offer.title, subtitle: offer.confirm },
      { id: "cancel", title: "Cancel", subtitle: "take nothing" },
    ],
    { header: offer.confirm, footer: "↑↓ move · Enter choose · Esc cancel" },
  );
  return chosen?.id === "take";
});

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
    attachments: Arr.map(paths, (one) => path.resolve(env.cwd, one)),
    request: yield* newRequestId(),
  });
  return done.ok ? done.human : done.error.message;
});

export const makeOffer = Effect.fn("Flows.makeOffer")(function* (
  env: PluginEnv,
  prompts: FlowPrompts,
  runId: string,
  chosen: string,
) {
  const listed = yield* offersOf(env, runId);
  if ("ok" in listed) return listed.error.message;
  const offer = Option.getOrUndefined(
    Arr.findFirst(listed, (one) => one.id === chosen && (one.run ?? runId) === runId),
  );
  if (offer === undefined) return `${runId} no longer offers ${chosen}`;
  if (offer.unavailable !== null) return `${offer.title}: ${offer.unavailable}`;
  const input = yield* offerArguments(prompts, offer.arguments);
  if (input === null || !(yield* confirmed(prompts, offer))) return null;
  const done = yield* invokeOffer(env, {
    door: "board",
    runId,
    offer: offer.id,
    input,
    request: yield* newRequestId(),
  });
  return done.ok ? done.human : done.error.message;
});

const REFRESH_MS = 1500;
const TICK_MS = 120;

const CLEAR = "\x1b[2J\x1b[H";

const WIDTH_FLOOR = 40;

const whyNoRenderer = Effect.fn("Flows.whyNoRenderer")(function* () {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return "no terminal on this pane";
  const term = yield* Config.option(Config.String("TERM"));
  if (term._tag === "Some" && term.value === "dumb") return "TERM is dumb";
  const width = process.stdout.columns ?? 0;
  if (width < WIDTH_FLOOR) return `the pane is ${width} columns, and the app needs ${WIDTH_FLOOR}`;
  return null;
});

export const replacedOnDisk = (file: string, every: Duration.Input = "2 seconds") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inode = fs.stat(file).pipe(
      Effect.map((info) => Option.getOrNull(info.ino)),
      Effect.orElseSucceed(() => null),
    );
    const start = yield* inode;
    if (start === null) return yield* Effect.succeed(Effect.never);
    return yield* Effect.succeed(
      inode.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(every),
          until: (now) => now !== null && now !== start,
        }),
        Effect.asVoid,
      ),
    );
  });

const BOARD_USAGE_EVERY = "15 seconds";

export const workspaceFlow = Effect.fn("Flows.workspaceFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  const platform = yield* Effect.context<
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >();
  const changes = yield* Queue.sliding<void>(1);
  yield* Effect.addFinalizer(() => Queue.shutdown(changes));
  const changed = () => {
    Queue.offerUnsafe(changes, undefined);
  };
  const usageNow = yield* Effect.cachedWithTTL(
    usageReadings(env, "board").pipe(
      Effect.map((read) => (read.ok ? read.value : [])),
      Effect.provideContext(platform),
    ),
    BOARD_USAGE_EVERY,
  );
  const session: ControlSession = {
    herdr,
    ...scopeFor(env.cwd),
    stateDir: env.stateDir,
    pluginRoot: env.pluginRoot,
    releases: releasesOf(env.raw),
    userDir: env.userDir,
    compaction: { waitMs: 0 },
    tasksOf: yield* followBoard(env, changed),
    detailOf: yield* followRunDetail(env, changed),
    usageOf: () => usageNow,
  };
  const why =
    (yield* whyNoRenderer()) ??
    (yield* Effect.gen(function* () {
      const { runApp } = yield* Effect.promise(() => import("./ui/bridge"));
      const app = appState(session, env);
      const records = yield* RunRecords;
      let dispatch: ((command: Command) => void) | null = null;
      const navigate = (run: string) =>
        dispatch?.({ _tag: "SetFilter", filter: { kind: "run", id: run } });
      yield* runApp({
        changes: Stream.fromQueue(changes),
        onReady: (own) => {
          dispatch = own;
        },
        stateDir: env.stateDir,
        filter: { kind: "all" },
        origin: null,
        load: (focus) => app.load(focus).pipe(Effect.provideService(RunRecords, records)),
        act: (command, prompts) => runCommand(session, env, command, prompts, navigate),
        selected:
          key === null
            ? undefined
            : (on) =>
                Effect.flatMap(selectionPath(env.stateDir, key), (file) =>
                  writeSelection(file, on),
                ),
      }).pipe(Effect.raceFirst(Effect.flatten(replacedOnDisk(process.execPath))));
      return null;
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.succeed(Str.split(reason(cause), "\n")[0]!),
      ),
    ));
  if (why === null) return 0;
  return yield* textBoard(session, env, why);
}, Effect.scoped);

const detailRead = (session: ControlSession, env: PluginEnv, key: DetailKey) =>
  session.detailOf?.(key) ?? runDetailNow(env, key);

const boardRead = (session: ControlSession, env: PluginEnv) =>
  session.tasksOf?.() ??
  boardSnapshot(env).pipe(
    Effect.map((read) => {
      const returned: BoardRead = read.ok
        ? { tasks: read.value.tasks, unreadable: null }
        : { tasks: [], unreadable: read.error.message };
      return returned;
    }),
  );

export function appState(session: ControlSession, env: PluginEnv) {
  const runsOf = session.runsOf ?? listRuns;
  let last: { focus: Focus; state: AppState } | null = null;
  const load = Effect.fn("Flows.appState.load")(function* (focus: Focus) {
    const again = rereads(last?.focus ?? null, focus);
    const reuse = again.reuse ? last : null;
    const history = reuse
      ? reuse.state.history
      : focus.shown.includes("history")
        ? yield* buildHistory({ cwd: env.cwd, runs: yield* runsOf(env) })
        : null;
    const runId = runIdOf(focus.selected);
    const detail = runId
      ? yield* detailRead(session, env, {
          runId,
          tail: focus.tail,
          pages: focus.reviewPages,
          refreshMr: again.forceMr,
        })
      : yield* session.detailOf?.(null) ?? Effect.succeed(null);
    const found =
      focus.view !== "runs"
        ? null
        : yield* liveFor({
            stateDir: env.stateDir,
            herd: yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null)),
            ledgers: session.ledgers ?? ledgersOf(env),
            run: detail === null ? null : { id: detail.id, dir: detail.dir },
            runs: [],
            region: true,
          });
    const defaults = yield* loadDefaults(env.userDir);
    const read = reuse ? null : yield* boardRead(session, env);
    const tasksBuilt = read === null ? reuse!.state.tasks : read.tasks;
    const artefacts =
      runId !== null && focus.artefacts === true
        ? yield* asksRun(
            env,
            runId,
            (client) => withArtefacts(client.board(), client.artefacts({ runId })),
            "board",
          )
        : null;
    const state = {
      view: focus.view,
      filter: focus.filter,
      tasks: tasksBuilt,
      now: yield* Clock.currentTimeMillis,
      density: defaults.density,
      newer: reuse ? reuse.state.newer : yield* boardRelease(session),
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
      usage: reuse ? reuse.state.usage : yield* session.usageOf?.() ?? Effect.succeed([]),
      previewing: focus.previewing,
      live: found?.live ?? null,
      stopping: [],
      detail,
      artefacts: artefacts?.ok === true ? artefacts.value : null,
      artefactsError: artefacts?.ok === false ? artefacts.error.message : null,
    } satisfies AppState;
    last = { focus, state };
    return state;
  });

  return { load };
}

export const runCommand = Effect.fn("Flows.runCommand")(function* (
  session: ControlSession,
  env: PluginEnv,
  command: Command,
  prompts: FlowPrompts,
  navigate: (runId: string) => void = () => {},
) {
  const runOf = (runId: string) =>
    (session.runsOf ?? listRuns)(env).pipe(
      Effect.map(
        (runs) => Option.getOrUndefined(Arr.findFirst(runs, (run) => run.id === runId)) ?? null,
      ),
    );
  switch (command._tag) {
    case "Jump": {
      const jump = command.jump;
      if (jump.kind === "agent") return attachLine(jump.agent);
      if (jump.kind !== "run") return `${jump.label} — nothing to jump to`;
      const run = yield* runOf(jump.runId);
      if (!run) return `${jump.label} has gone`;
      const agent = Option.getOrUndefined(
        Arr.findLast(
          yield* hostRegistered(env).pipe(Effect.orElseSucceed(() => [])),
          (entry) => entry.runId === run.id,
        ),
      );
      return agent ? attachLine(agent.agent) : `${jump.label} has no agent to attach to`;
    }
    case "FocusAgent":
      return attachLine(command.agent);
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
      return `follow its check with: collie run checks ${run.id} --follow`;
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
      return "a review reaches its implementer through the Run's own offers; press the action key";

    case "InvokeOffer":
      return yield* makeOffer(env, prompts, command.runId, command.offer);

    case "ChooseOffer": {
      const listed = yield* offersOf(env, command.runId);
      if ("ok" in listed) return listed.error.message;
      const open = Arr.filter(listed, (one) => one.unavailable === null);
      if (open.length === 0) return `${command.runId} offers nothing now`;
      const chosen = yield* prompts.menu(
        Arr.map(open, (one, at) => ({ id: String(at), title: one.title, subtitle: one.workflow })),
        { header: `What next for ${command.runId}?` },
      );
      if (chosen === null) return null;
      const offer = open[Number(chosen.id)]!;
      return yield* makeOffer(env, prompts, offer.run ?? command.runId, offer.id);
    }

    case "RunWorkflow":
      return yield* launch(session, env, prompts, {
        workflow: command.workflow,
        inputs: {},
        note: `started from the Workflows view`,
      });

    case "PostReview":
      return "a review is posted by the Run that wrote it";

    case "ConfirmProposal": {
      const done = yield* confirmProposed(env, {
        door: "board",
        proposal: command.id,
        hash: command.hash,
        request: yield* newRequestId(),
      });
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
      const run = command.runId === null ? null : yield* runOf(command.runId);
      const forge = forgeOf(ref);
      const opened = yield* forge.open(ref, run?.cwd ?? env.cwd, shell);
      return opened.code === 0
        ? `opened ${command.target} in a browser`
        : `${forge.display} could not open ${command.target} (exit ${opened.code})`;
    }

    case "SetDefault": {
      const parsed = parseSetting(command.key, command.value);
      if ("refused" in parsed) return parsed.refused;
      return yield* setSetting(env.userDir, command.key, parsed.value, yield* nowIso).pipe(
        Effect.as(`${command.key} is now ${settingText(parsed.value) || "unset"}`),
        Effect.catch((cause) => Effect.succeed(`${command.key}: ${reason(cause)}`)),
      );
    }

    case "OpenMode":
      switch (command.mode) {
        case "pick":
          return yield* pickFlow(session.herdr, env, prompts).pipe(Effect.as(null));
        case "continue":
          return yield* continueFlow(session.herdr, env, prompts).pipe(Effect.as(null));
        case "resume":
          return yield* resumeFlow(session.herdr, env, prompts).pipe(Effect.as(null));
        case "fork":
          return yield* forkFlow(session.herdr, env, prompts).pipe(Effect.as(null));
      }

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

    case "FollowUp": {
      const text = yield* prompts.ask(`What still needs doing on ${command.runId}?`);
      if (text === null || Str.trim(text) === "") return null;
      const done = yield* followUpRun(env, {
        door: "board",
        runId: command.runId,
        text: Str.trim(text),
        request: yield* newRequestId(),
      });
      return done.ok ? done.human : done.error.message;
    }

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

    case "Acknowledge": {
      const done = yield* seeRun(env, {
        door: "board",
        runId: command.runId,
        request: yield* newRequestId(),
      });
      return done.ok ? `${command.runId} seen` : done.error.message;
    }
    case "SeeArtefact": {
      const request = yield* newRequestId();
      const done = yield* asksRun(
        env,
        command.runId,
        (client) =>
          withArtefacts(
            client.board(),
            client.artefactSeen({
              runId: command.runId,
              id: command.id,
              revision: command.revision,
              request,
            }),
          ),
        "board",
      );
      return done.ok
        ? `${command.id}: ${done.value.seen?.revision ?? "unseen"}`
        : done.error.message;
    }

    case "EditSetting":
    case "NextQuestion":
    case "ChooseMr":
    case "CopyLink":
    case "OpenRecord":
    case "OpenSteer":
    case "ShowView":
    case "ShowOlder":
    case "ToggleFilter":
    case "SetFilter":
    case "Preview":
    case "ToggleTail":
    case "ToggleArtefacts":
    case "MoreReview":
    case "Select":
    case "Refresh":
    case "UndoStop":
    case "Quit":
      return null;
  }
});

const launch = Effect.fn("Flows.launch")(function* (
  session: ControlSession,
  env: PluginEnv,
  prompts: FlowPrompts,
  opts: { workflow: string; inputs: Record<string, string>; note: string; parent?: RunFacts },
) {
  const line = yield* startChosen(session.herdr, env, prompts, {
    workflow: opts.workflow,
    given: opts.inputs,
    parent: opts.parent,
  });
  return line ?? `${opts.workflow} was not started`;
});

const textBoard = Effect.fn("Flows.textBoard")(function* (
  session: ControlSession,
  env: PluginEnv,
  why: string,
) {
  yield* Console.error(`${COLLIE_TAB}: ${why}; showing the text view.`);
  let unreadable: string | null = null;
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
      herd: yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null)),
      ledgers: session.ledgers ?? ledgersOf(env),
      run: null,
      runs: yield* Effect.gen(function* () {
        const { runs, registered } = yield* scan(env, session);
        return Arr.map(rows, (row) => {
          const run = Option.getOrUndefined(Arr.findFirst(runs, (one) => one.id === row.id));
          return run === undefined
            ? { id: row.id, dir: row.dir, held: false, harnesses: [] }
            : markedOf(run, registered);
        });
      }),
      region: true,
    });
    return { ...live, tasks: yield* tasksOf() };
  });
  if (!process.stdin.isTTY) {
    const view = yield* boardOf(session, yield* scan(env, session));
    const steering = yield* steeringOf(view);
    const once = renderWorkspace(view, unreadable ?? why, undefined, steering);
    process.stdout.write(`${once}\n`);
    return 0;
  }
  const keys = yield* keyboard();
  let view = yield* boardOf(session, yield* scan(env, session));
  let note: string | null = why;
  let drawn = "";
  let read = yield* Clock.currentTimeMillis;
  let asking: Asking = { index: 0, typed: "" };
  let answering: string | null = null;

  for (;;) {
    const waiting = askingRun(view);
    if (waiting && waiting.id !== answering) {
      asking = { index: 0, typed: "" };
      answering = waiting.id;
    }
    if (!waiting) answering = null;

    const steering = yield* steeringOf(view);
    const text = renderWorkspace(view, unreadable ?? note ?? undefined, asking, steering);
    if (text !== drawn) {
      process.stdout.write(`${CLEAR}${pipe_(text, Str.replace(/\n/g, "\r\n"))}\r\n`);
      drawn = text;
    }
    const key = Option.getOrNull(yield* Queue.take(keys).pipe(Effect.timeoutOption(TICK_MS)));
    if (key !== null) {
      if (waiting) {
        const answered = yield* answerKey(env, waiting, asking, key);
        asking = answered.asking;
        note = answered.note ?? note;
      } else if (key === "q" || key === "\x03") {
        return 0;
      } else {
        note = yield* act(session, env, view, key);
      }
      view = yield* boardOf(session, yield* scan(env, session));
      read = yield* Clock.currentTimeMillis;
      continue;
    }
    if ((yield* Clock.currentTimeMillis) - read >= REFRESH_MS) {
      view = yield* boardOf(session, yield* scan(env, session));
      read = yield* Clock.currentTimeMillis;
    }
  }
}, Effect.scoped);

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

const act = Effect.fn("Flows.act")(function* (
  session: ControlSession,
  env: PluginEnv,
  view: WorkspaceView,
  key: string,
) {
  if (/^[1-9]$/.test(key)) {
    const agent = agentForKey(view, key);
    if (!agent) return null;
    return attachLine(agent.agent);
  }
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

const attachLine = (agent: string) => `attach to ${agent} with: hc attach ${agent}`;

const ledgersOf: (env: PluginEnv) => Ledgers = (env) => ({
  overridden: asks(env, (client) => client.overridden()).pipe(
    Effect.map((read) => new Set(read.ok ? read.value : [])),
  ),
  deliveriesOf: (run) =>
    asks(env, (client) => client.deliveries({ runId: run })).pipe(
      Effect.map((read) => (read.ok ? (read.value ?? []) : [])),
    ),
  proposals: (herd) => hostProposals(env, herd).pipe(Effect.orElseSucceed(() => [])),
});

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

interface Scanned {
  readonly runs: ReadonlyArray<RunFacts>;
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly registered: ReadonlyArray<AgentEntry>;
}

type RunsOf = (
  env: PluginEnv,
) => Effect.Effect<
  ReadonlyArray<RunFacts>,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
>;

type RecordsOf = (env: PluginEnv) => ReturnType<typeof hostRecordsOf>;

const hostRecordsOf = (env: PluginEnv) =>
  Effect.all({
    tasks: hostTasks(env).pipe(Effect.orElseSucceed(() => [])),
    registered: hostRegistered(env).pipe(Effect.orElseSucceed(() => [])),
  });

const scan = Effect.fn("Flows.scan")(function* (
  env: PluginEnv,
  from: Pick<ControlSession, "runsOf" | "recordsOf">,
) {
  const returned: Scanned = {
    runs: yield* (from.runsOf ?? listRuns)(env),
    ...(yield* (from.recordsOf ?? hostRecordsOf)(env)),
  };
  return returned;
});

const boardOf = Effect.fn("Flows.boardOf")(function* (session: ControlSession, scanned: Scanned) {
  const view = yield* buildView({
    ...session,
    stateDir: session.stateDir,
    workspaceLabel: null,
    alive: yield* session.herdr.agentList().pipe(Effect.orElseSucceed(() => [])),
    worktrees: yield* reportedWorktrees(session.stateDir),
    pluginRoot: session.pluginRoot,
    ...(session.releases && { releases: session.releases }),
    quietMs: yield* boardQuietMs(session.userDir),
    ...scanned,
  });
  return view;
});

const boardRelease = Effect.fn("Flows.boardRelease")(function* (session: ControlSession) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(`${session.pluginRoot}/.git`)) return null;
  return yield* newerRelease(
    session.releases ?? RELEASES,
    manifest.version,
    yield* Clock.currentTimeMillis,
  );
});

function headed(header: string, banner?: string) {
  return banner ? `${banner}\n\n${header}` : header;
}

const bail = Effect.fn("Flows.bail")(function* (
  prompts: FlowPrompts,
  message: string,
  extra?: string,
) {
  return yield* notice(prompts, message, 1, extra);
});

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
