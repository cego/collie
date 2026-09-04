// What each plugin action does. Actions have no tty, so they only open a pane; the
// interactive work happens in the pane entrypoints. Every question a human answers goes
// through `InputPrompts`, so the same flow draws in a popup pane and inline in the tab.

import { Cause, Clock, Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { nowIso } from "./time";
import { loadDefaults, writeConfigValue } from "./config";
import {
  isStale,
  layers,
  loadDefinitions,
  resolveWorkflow,
  type Definitions,
  type Provenance,
  type ResolvedStep,
  type ResolvedWorkflow,
} from "./definitions";
import { choiceHint, executeRun, unmetRequirementFor } from "./engine";
import type { PluginEnv } from "./env";
import { Herdr, type AgentInfo } from "./herdr";
import {
  confirmLine,
  inputValues,
  resolveCandidates,
  settle,
  type InputPrompts,
  type PickItem,
  type Resolution,
} from "./inputs";
import { releaseKeyboard, startKeyboard, takeKey } from "./keys";
import { forkResolvedDefinition, type DefinitionKind } from "./fork";
import { notify } from "./notify";
import { COLLIE_TAB, reason, shellQuote } from "./naming";
import { RunStore, type Run } from "./run";
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
  stopRun as stopRunOperation,
} from "./operations";
import { answerFor, rereads, runIdOf, type AppState, type Command } from "./ui/state";
import type { Focus } from "./ui/bridge";
import {
  buildHistory,
  buildRunDetail,
  buildSettings,
  buildWorkflows,
  NUMERIC_DEFAULTS,
} from "./views";
import { isPermissionMode, PERMISSION_MODES } from "./harness";
import {
  mrDetails,
  mrTarget,
  parseMrTarget,
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
  renderWorkspace,
  type Asking,
  type RunRow,
  type WorkspaceView,
} from "./workspace";

export interface ControlSession extends Omit<Session, "herdr"> {
  herdr: Herdr;
  /** This installation, so the board can say when it is behind its remote. */
  pluginRoot: string;
  /**
   * What the last worktree sweep said, and whether one is out working right now. A
   * caller that keeps none — a test drawing one board, a view built to be rendered
   * once — sweeps nothing and shows nothing about worktrees.
   */
  pruned?: Pruned;
}

export type Mode = "pick" | "resume" | "fork";

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

function banner(defs: Definitions): string | undefined {
  if (defs.errors.length === 0) return undefined;
  return ["Definitions with errors (skipped):", ...defs.errors.map((e) => `  ${e}`)].join("\n");
}

/**
 * How a flow asks. The popup and the tab hand in different implementations of the same
 * interface, and this is the only thing any of these flows knows about either.
 */
export type FlowPrompts = InputPrompts;

export const pickFlow = Effect.fn("Flows.pickFlow")(function* (
  herdr: Herdr,
  env: PluginEnv,
  prompts: FlowPrompts,
  placement: Placement = "popup",
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

  yield* startChosen(herdr, env, prompts, { workflow: chosen.id, placement });
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
  },
) {
  // Resolving, validating and inferring is what `collie run start` does too.
  const prepared = yield* prepareWorkflow(env, opts.workflow);
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
  yield* settleExplicit(env, resolutions, opts.given ?? {});
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

  // Every decision this run will reach, answered now: the point of walking away is
  // that nothing after this needs the human. `Ask me then` keeps today's behaviour,
  // one Enter each.
  const decisions: Record<string, string> = {};
  for (const { step, items } of yield* decidableSteps(resolved, env, resolutions)) {
    const answer = yield* prompts.menu(
      [
        { id: ASK_ME_THEN, title: "Ask me then", subtitle: "stop and ask when you get there" },
        ...items,
      ],
      {
        header: `${resolved.name} — ${step.id}`,
        footer: "↑↓ move · Enter choose · Esc cancel",
      },
    );
    if (!answer) return null;
    if (answer.id !== ASK_ME_THEN) decisions[step.id] = answer.id;
  }

  // No confirmation: the human picked the workflow, answered its Inputs and answered
  // its decisions, and Esc at any of those already cancelled. The line is the note.
  const line = confirmLine(resolved.name, resolutions);

  const started = yield* startRun(env, {
    workflow: resolved,
    resolutions,
    decisions,
    workspace: yield* resolveWorkspace(herdr, env).pipe(Effect.catch(() => Effect.succeed(null))),
    note: line,
    parent: opts.parent?.id,
  });
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
  return line;
});

const ASK_ME_THEN = "\u0000ask-me-then";

/**
 * The Choice steps this Run will actually reach, and what each may be decided as. A
 * step this environment cannot meet is skipped rather than asked about: a question
 * about a step that will not run is worse than silence. (A `standalone:` step needs no
 * check here — `resolveWorkflow` drops those when a workflow is embedded, and this
 * only ever sees the one being launched.)
 */
export const decidableSteps = Effect.fn("Flows.decidableSteps")(function* (
  wf: ResolvedWorkflow,
  env: PluginEnv,
  resolutions: Resolution[],
) {
  const where = { cwd: env.cwd, inputs: inputValues(resolutions) };
  const steps: Array<{ step: ResolvedStep; items: PickItem[] }> = [];
  for (const step of wf.steps) {
    if (!step.choices || step.choices.length === 0) continue;
    if (step.requires && (yield* unmetRequirementFor(where, step.requires))) continue;
    const items = yield* decisionItems(step, where);
    // Everything this step could have offered is out of reach here, so there is
    // nothing to decide and nothing to ask about.
    if (items.length > 0) steps.push({ step, items });
  }
  return steps;
});

/**
 * A step's choices as decisions: by distinct title, in declaration order, and only
 * the ones this environment could carry out. A choice whose own `requires` cannot be
 * met here — posting to a merge request with no GitLab, or for a target that is not
 * one — would be decided and then not offered, and the unattended run it was decided
 * for would stop to ask after all.
 *
 * Liveness is deliberately not filtered: who is live at launch says nothing about who
 * will be live an hour later, which is why a hand-off and its twin share one title.
 */
const decisionItems = Effect.fn("Flows.decisionItems")(function* (
  step: ResolvedStep,
  where: { cwd: string; inputs: Record<string, string> },
) {
  const items: PickItem[] = [];
  for (const choice of step.choices ?? []) {
    if (items.some((item) => item.id === choice.title)) continue;
    if (choice.requires && (yield* unmetRequirementFor(where, choice.requires))) continue;
    items.push({ id: choice.title, title: choice.title, subtitle: choiceHint(choice) });
  }
  return items;
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

  /**
   * Installed before the ownership claim, not after it. A SIGTERM arriving between
   * the claim becoming visible to `collie run stop` and this handler being installed
   * landed on Node's default handler, which kills the process outright: no stopped
   * marker, run.json still `running`, and a stop that had already reported success.
   */
  // Signals have no Effect v4 API — the runtime installs its own handlers but exposes
  // none — so a Driver that has to notice SIGTERM before its ownership claim is
  // visible registers for it natively.
  let signalled = false;
  const earlySigterm = () => {
    signalled = true;
  };
  process.once("SIGTERM", earlySigterm);
  const sigterm = Effect.callback<void>((resume) => {
    // Hands over from the early handler here, and honours a signal it already caught.
    process.off("SIGTERM", earlySigterm);
    if (signalled) {
      resume(Effect.void);
      return Effect.void;
    }
    const stop = () => resume(Effect.void);
    process.once("SIGTERM", stop);
    return Effect.sync(() => process.off("SIGTERM", stop));
  });

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

    const markStopped = Effect.gen(function* () {
      const stoppedAt = yield* nowIso();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(run.dir, STOPPED), `${stoppedAt}\n`);
      run.record.status = "blocked";
      run.record.finished_at = stoppedAt;
      yield* run.save();
      return 0;
    });

    // Effect.catch and Effect.ensuring, not try/catch/finally: a typed failure out of
    // executeRun unwinds past both without entering either, which left the Run marked
    // `running` with no Driver, nothing in the log, and `collie run wait` blocking to
    // its timeout — with the ownership claim never given back.
    return yield* Effect.raceFirst(
      Effect.gen(function* () {
        const defs = yield* loadDefinitions(yield* layers({ ...env, cwd: run.record.cwd }));
        const defaults = yield* loadDefaults(env.configDir);
        const wf = resolveWorkflow(run.record.workflow, defs, defaults);
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
      }),
      sigterm.pipe(Effect.andThen(markStopped)),
    ).pipe(
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
      Effect.ensuring(releaseDriver(run.dir).pipe(Effect.ignore)),
    );
  });

  return yield* drive.pipe(
    Effect.ensuring(Effect.sync(() => process.off("SIGTERM", earlySigterm))),
  );
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
    pruned: { at: 0, lines: [], running: false },
  };
  const why =
    (yield* whyNoRenderer()) ??
    (yield* Effect.gen(function* () {
      const { runApp } = yield* Effect.promise(() => import("./ui/bridge"));
      const app = appState(session, env);
      yield* runApp({
        stateDir: env.stateDir,
        load: (focus) => app.load(focus),
        act: (command, prompts) => runCommand(session, env, command, prompts),
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

/** How long a merge request read stays good for. Re-selecting inside it costs nothing. */
const MR_TTL_MS = 60_000;

/**
 * Everything the app draws, for whatever it is looking at. One closure, because the
 * merge-request cache belongs with the reads it saves: a History of 40 merge-request
 * Runs must make no `glab` call to draw, one selection makes exactly one, and
 * re-selecting the same Run inside the TTL makes none.
 */
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
) {
  const mrCache = new Map<string, { at: number; panel: MrPanel }>();

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

  const load = Effect.fn("Flows.appState.load")(function* (focus: Focus) {
    const again = rereads(last?.focus ?? null, focus);
    const reuse = again.reuse ? last : null;
    // One scan of the run dirs per read, shared by the board and History: they are two
    // Views over the same directory, and reading it twice doubles the cost of a refresh.
    const runs = reuse ? undefined : yield* new RunStore(env.stateDir).list();
    const board = reuse ? reuse.state.board : yield* boardOf(session, runs);
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
    const selected = runId
      ? [...board.active, ...board.recent, ...(history ?? [])].find((r) => r.id === runId)
      : undefined;
    // Read for the Selection and never for a list: `target` is on the row already, and a
    // badge is only ever filled from what is in the cache. When to read past that cache
    // is `rereads`' decision, not a second copy of it here.
    const mr = yield* merge(selected?.target ?? null, env.cwd, again.forceMr);
    const state = {
      view: focus.view,
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
      // Always re-read: this is the one thing a moved Selection actually changes.
      detail: runId
        ? yield* buildRunDetail({
            stateDir: env.stateDir,
            runId,
            mr,
            tail: focus.tail,
            pages: focus.reviewPages,
          })
        : null,
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
) {
  /**
   * The row a command names, from the board or from History. Both, because the board
   * keeps five finished runs and History keeps two hundred from every session that ran
   * here: `l` is offered on every History row, and looking only at the board answered
   * "has gone" for a run whose directory and log were both still there.
   */
  const rowOf = Effect.fn("Flows.rowOf")(function* (runId: string) {
    // One scan for both, the same way `appState.load` shares it.
    const runs = yield* new RunStore(session.stateDir).list();
    const view = yield* boardOf(session, runs);
    const onBoard = [...view.active, ...view.recent].find((r) => r.id === runId);
    if (onBoard) return onBoard;
    const history = yield* buildHistory({
      stateDir: session.stateDir,
      cwd: session.cwd,
      runs,
    });
    return history.find((r) => r.id === runId) ?? null;
  });
  /** The Run a command names, or `null` for one whose directory has gone since. */
  const runOf = Effect.fn("Flows.runOf")(function* (runId: string) {
    return yield* new RunStore(session.stateDir)
      .load(runId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
  });
  switch (command._tag) {
    case "FocusAgent":
      return yield* session.herdr.agentFocus(command.agent).pipe(
        Effect.as(`focused ${command.agent}`),
        Effect.catch((cause) => Effect.succeed(`${command.agent}: ${reason(cause)}`)),
      );
    // The Selection as a one-row board: `stopRun` and `openLog` are the board's own,
    // and the text fallback still hands them its whole view, so the row goes in rather
    // than the functions learning about a Selection they have no other use for.
    case "StopRun": {
      const row = yield* rowOf(command.runId);
      return row ? yield* stopRun(session, { active: [row] }) : `${command.runId} has gone`;
    }
    case "OpenLog": {
      const row = yield* rowOf(command.runId);
      return row
        ? yield* openLog(session, { active: [row], recent: [] })
        : `${command.runId} has gone`;
    }
    case "Answer": {
      const row = yield* rowOf(command.runId);
      if (!row) return `${command.runId} has gone`;
      const answered = yield* answerRun(row, command.value, yield* newRequestId());
      return answered.ok ? `answered ${row.title}` : `${row.title}: ${answered.error.message}`;
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

    case "OpenMr": {
      const ref = parseMrTarget(command.target);
      if (!ref) return `${command.target} is not a merge request`;
      const opened = yield* shell(
        "glab",
        ["mr", "view", ref.iid, ...repoArgs(ref.project), "--web"],
        env.cwd,
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
        case "resume":
          return yield* resumeFlow(session.herdr, env, prompts, "inline").pipe(Effect.as(null));
        case "fork":
          return yield* forkFlow(session.herdr, env, prompts).pipe(Effect.as(null));
      }

    case "EditSetting":
    case "ShowView":
    case "ToggleTail":
    case "MoreReview":
    case "Select":
    case "Refresh":
    case "Quit":
      // The app and the bridge act on these themselves; they never reach a handler.
      // `EditSetting` opens the app's own editor, and the value it gathers comes back
      // as a `SetDefault` that carries one.
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
  // Nothing to loop on: with no keyboard the board is a report, so it is printed once
  // and the entrypoint ends rather than spinning on a `takeKey` that can never answer.
  if (!process.stdin.isTTY) {
    const once = renderWorkspace(yield* boardOf(session), why);
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
      yield* announce(herdr, env);
    }
    if (!waiting) answering = null;

    const text = renderWorkspace(view, note ?? undefined, asking);
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
const announce = Effect.fn("Flows.announce")(function* (herdr: Herdr, env: PluginEnv) {
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
  const mode = key === "p" ? "pick" : key === "u" ? "resume" : key === "f" ? "fork" : null;
  if (mode) {
    return yield* open(mode).pipe(
      Effect.as(null),
      Effect.catch((cause) => Effect.succeed(`${mode}: ${reason(cause)}`)),
    );
  }
  if (key === "s") return (yield* sendReviewToImplementer(session)).message;
  if (key === "l") return yield* openLog(session, view);
  if (key === "k") return yield* stopRun(session, view);
  return null;
});

/**
 * Stops the newest run. A run used to stop when you closed its pane; the driver has
 * no pane now, so this replaces that. Its agents are left where they are: their
 * panes are the transcript of what happened.
 */
export const stopRun = Effect.fn("Flows.stopRun")(function* (
  session: ControlSession,
  view: Pick<WorkspaceView, "active">,
) {
  const row = view.active[0];
  if (!row) return "nothing running here to stop";
  const run = yield* new RunStore(session.stateDir).load(row.id);
  const stopped = yield* stopRunOperation(
    session.stateDir,
    session.herdr,
    run,
    session,
    yield* newRequestId(),
  );
  return stopped.ok ? `stopped ${row.title}` : `${row.title}: ${stopped.error.message}`;
});

/**
 * The newest run's `runner.log` in a pane of its own. The driver has no pane, so
 * this is the only place its detail can be read, and a temporary pane is the
 * cheapest way to read it without leaving the board.
 */
export const openLog = Effect.fn("Flows.openLog")(function* (
  session: ControlSession,
  view: Pick<WorkspaceView, "active" | "recent">,
) {
  const run = view.active[0] ?? view.recent[0];
  if (!run) return "no run here to open a log for";
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
    return `opened ${run.title}'s log`;
  }).pipe(Effect.catch((cause) => Effect.succeed(`${path}: ${reason(cause)}`)));
});

interface LiveWorkspace {
  alive: AgentInfo[];
  label: string | null;
}

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

const boardOf = Effect.fn("Flows.boardOf")(function* (
  session: ControlSession,
  runs?: ReadonlyArray<Run>,
) {
  yield* sweep(session);
  const live = yield* Effect.all(
    { alive: session.herdr.agentList(), workspaces: session.herdr.workspaceList() },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ alive, workspaces }) => ({
      alive,
      // The live label is how a run recorded against a since-recycled workspace id
      // is kept out; without it the board falls back to the id alone.
      label: workspaces.find((w) => w.workspaceId === session.workspaceId)?.label ?? null,
    })),
    // A herdr that will not answer means "nothing verified live", not a crash.
    Effect.catch(() => Effect.succeed<LiveWorkspace>({ alive: [], label: null })),
  );
  return yield* buildView({
    ...session,
    stateDir: session.stateDir,
    workspaceLabel: live.label,
    alive: live.alive,
    worktrees: session.pruned?.lines ?? [],
    pluginRoot: session.pluginRoot,
    runs,
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
