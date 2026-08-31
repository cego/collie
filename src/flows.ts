// What each plugin action does. Actions have no tty, so they only open a pane;
// the interactive work happens in the `picker` and `runner` pane entrypoints.

import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { nowIso, nowMillis } from "./time";
import { loadDefaults } from "./config";
import {
  bodySections,
  isStale,
  layers,
  loadDefinitions,
  resolveWorkflow,
  type Definitions,
  type Provenance,
} from "./definitions";
import { executeRun } from "./engine";
import type { PluginEnv } from "./env";
import type { AgentInfo, Herdr } from "./herdr";
import { confirmLine, resolveCandidates } from "./inputs";
import {
  ask,
  confirm,
  nextKey,
  pick,
  releaseKeyboard,
  startKeyboard,
  takeKey,
  type PickItem,
} from "./picker";
import { forkDefinition, type DefinitionKind } from "./fork";
import { reason, shellQuote } from "./naming";
import { Run, RunStore } from "./run";
import { sendReviewToImplementer, type Session } from "./handoff";
import {
  acquireDriver,
  clearPreviousDriver,
  stoppedBefore,
  appendProgress,
  driverAlive,
  filePrompts,
  releaseDriver,
  RUNNER_LOG,
} from "./driver";
import { scopeFor } from "./registry";
import {
  answerRun,
  newRequestId,
  prepareWorkflow,
  type ExpectedError,
  resumeRun,
  startRun,
  stopRun as stopRunOperation,
} from "./operations";
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
}

export type Mode = "pick" | "resume" | "fork";

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
 * The workspace a Run is started in, by name as well as by id: ids compact, so the
 * label is what tells a recycled id from the workspace the Run actually belongs to.
 */
const workspaceInfo = Effect.fn("Flows.workspaceInfo")(function* (herdr: Herdr, env: PluginEnv) {
  if (!env.workspaceId) return null;
  return yield* herdr.workspaceList().pipe(
    Effect.map((workspaces) => workspaces.find((w) => w.workspaceId === env.workspaceId) ?? null),
    // Without a label the Run is still scoped by session, workspace id and cwd.
    Effect.catch(() => Effect.succeed(null)),
  );
});

function banner(defs: Definitions): string | undefined {
  if (defs.errors.length === 0) return undefined;
  return ["Definitions with errors (skipped):", ...defs.errors.map((e) => `  ${e}`)].join("\n");
}

export const pickFlow = Effect.fn("Flows.pickFlow")(function* (herdr: Herdr, env: PluginEnv) {
  const layerList = yield* layers(env);
  const defs = yield* loadDefinitions(layerList);

  const items: PickItem[] = [...defs.workflows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wf) => ({ id: wf.name, title: wf.title, subtitle: layerOf(wf) }));

  if (items.length === 0) {
    return yield* bail(
      "No workflows found. Check the plugin's workflows/ directory.",
      banner(defs),
    );
  }

  const chosen = yield* pick(items, {
    header: `Workflows — ${env.cwd}`,
    footer: "↑↓ move · type to filter · Enter run · Esc cancel",
    banner: banner(defs),
  });
  if (!chosen) return 0;

  // Resolving, validating and inferring is what `collie run start` does too.
  const prepared = yield* prepareWorkflow(env, chosen.id);
  if (!prepared.ok) return yield* bail(whyNotRunnable(chosen.id, prepared.error));
  const resolved = prepared.workflow;
  const resolutions = prepared.resolutions;
  // An embedded workflow's inputs belong to the run that embeds it, which never asks.
  const embedded = new Set(resolved.embeddedInputs);
  for (const r of resolutions) {
    // An Input with candidates is chosen from what this repo offers, not typed blind.
    if (r.candidates && !embedded.has(r.name)) {
      if (!(yield* resolveCandidates(r, { menu: pick, ask }))) return 0;
      continue;
    }
    if (!r.needsAsking) continue;
    const answer = yield* ask(r.question);
    if (answer === null) return 0;
    r.value = answer.trim();
    r.source = "asked";
    if (r.value === "") return yield* bail(`${resolved.name} needs an input for "${r.name}".`);
  }

  const line = confirmLine(resolved.name, resolutions);
  if (!(yield* confirm(line))) return 0;

  const started = yield* startRun(env, {
    workflow: resolved,
    resolutions,
    workspace: yield* workspaceInfo(herdr, env),
    note: line,
  });
  if (!(started instanceof Run)) return yield* bail(started.error.message);
  // Only a popup can close itself; running the picker in a plain pane is fine..
  yield* Effect.ignore(herdr.popupClose());
  return 0;
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

export const forkFlow = Effect.fn("Flows.forkFlow")(function* (herdr: Herdr, env: PluginEnv) {
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

  if (items.length === 0) return yield* bail("Nothing to fork.", banner(defs));

  const chosen = yield* pick(items, {
    header: "Fork a definition",
    footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    banner: banner(defs),
  });
  if (!chosen) return 0;

  const layerDirs = layerList;
  const targets: PickItem[] = [
    { id: "user", title: "my layer", subtitle: layerDirs[1]!.dir },
    { id: "project", title: "this project", subtitle: layerDirs[2]!.dir },
  ];
  const target = yield* pick(targets, {
    header: `Fork ${chosen.title} into`,
    footer: "↑↓ move · Enter fork · Esc cancel",
  });
  if (!target) return 0;

  const source = sources.get(chosen.id)!;
  const how = yield* pick(
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
    const which = yield* pick(
      source.steps.map((id) => ({ id, title: id })),
      {
        header: `Which step of ${chosen.title}`,
        footer: "↑↓ move · Enter choose · Esc cancel",
      },
    );
    if (!which) return 0;
    step = which.id;
  }

  const dir = target.id === "user" ? layerDirs[1]!.dir : layerDirs[2]!.dir;
  const result = yield* forkDefinition(source.path, source.kind, dir, {
    full: how.id === "full",
    step,
    section: step ? bodySections(source.body).sections.get(step) : undefined,
  });
  return yield* notice(`${chosen.title}: ${result.message}`, result.ok ? 0 : 1);
});

/** The layer a definition came from, and whether a full copy has fallen behind. */
function layerOf(def: Provenance): string {
  const parts = [`[${def.layer}]`];
  if (def.extends) parts.push(`extends ${def.extends}`);
  // A full copy whose parent has moved on is not the fork you took.
  if (isStale(def)) parts.push("(stale — the original has changed since this copy)");
  return parts.join(" ");
}

export const resumeFlow = Effect.fn("Flows.resumeFlow")(function* (herdr: Herdr, env: PluginEnv) {
  const store = new RunStore(env.stateDir);
  // A run something is still driving is not a run to resume: a second driver would
  // fight the first over the same agents and the same run record.
  const runs = [];
  for (const run of yield* store.resumable()) {
    if (!(yield* driverAlive(run.dir))) runs.push(run);
  }
  if (runs.length === 0)
    return yield* bail("No runs with unfinished steps that nothing is already driving.");

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

  const chosen = yield* pick(items, {
    header: "Resume a run",
    footer: "↑↓ move · type to filter · Enter resume · Esc cancel",
  });
  if (!chosen) return 0;

  const run = yield* store.load(chosen.id);
  const resumed = yield* resumeRun(env, run, yield* newRequestId());
  if (!resumed.ok) return yield* bail(`${run.record.slug}: ${resumed.error.message}`);
  // Only a popup can close itself; running the picker in a plain pane is fine..
  yield* Effect.ignore(herdr.popupClose());
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
  const out = (line: string) => appendProgress(run.dir, line);

  /**
   * Installed before the ownership claim, not after it. A SIGTERM arriving between
   * the claim becoming visible to `collie run stop` and this handler being installed
   * landed on Node's default handler, which kills the process outright: no stopped
   * marker, run.json still `running`, and a stop that had already reported success.
   */
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

  // Atomic: acquiring is the check. A separate liveness test then a write would
  // let two resumes race past each other and drive the same run twice.
  if (!(yield* acquireDriver(run.dir))) {
    process.off("SIGTERM", earlySigterm);
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
    process.off("SIGTERM", earlySigterm);
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
    yield* fs.writeFileString(path.join(run.dir, "stopped"), `${stoppedAt}\n`);
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
        const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
        yield* out(`the driver stopped: ${detail.split("\n")[0]}`);
        yield* run.log(`driver failed: ${detail}`);
        run.record.status = "failed";
        run.record.finished_at = yield* nowIso();
        yield* run.save();
        // A missing toast must not be the last word.
        yield* Effect.ignore(
          herdr.notify(`${run.record.slug} failed`, `see ${RUNNER_LOG} in the run dir`, "request"),
        );
        return 1;
      }),
    ),
    Effect.ensuring(releaseDriver(run.dir).pipe(Effect.ignore)),
  );
});

/** How often the tab re-reads the files and asks herdr what is still alive. */
const REFRESH_MS = 1500;
/** How long a keypress may wait; the tab has to feel like a TUI, not a report. */
const TICK_MS = 120;

const CLEAR = "\x1b[2J\x1b[H";

/**
 * The Control Plane tab: the Session's control surface. It watches the run dirs
 * and the register and draws them; the quick actions are the plugin's own
 * actions and one hand-off. It drives no run and holds no engine state, so
 * closing it loses nothing.
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
  };
  startKeyboard();
  let view = yield* load(session);
  const open = (mode: Mode) => openMode(herdr, env, mode);
  let note: string | null = null;
  let drawn = "";
  let read = yield* nowMillis();
  let asking: Asking = { index: 0, typed: "" };
  let answering: string | null = null;

  for (;;) {
    const waiting = askingRun(view);
    // A new question starts from the top, with nothing typed.
    if (waiting && waiting.id !== answering) {
      asking = { index: 0, typed: "" };
      answering = waiting.id;
      yield* announce(herdr, env, waiting);
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
      view = yield* load(session);
      read = yield* nowMillis();
      continue;
    }
    if ((yield* nowMillis()) - read >= REFRESH_MS) {
      view = yield* load(session);
      read = yield* nowMillis();
    }
    yield* Effect.sleep(TICK_MS);
  }
});

/**
 * A question nobody sees is a run that has silently stopped, so the board says it
 * twice: a toast, and this tab brought to the front.
 */
const announce = Effect.fn("Flows.announce")(function* (
  herdr: Herdr,
  env: PluginEnv,
  waiting: RunRow,
) {
  // A missing toast must not stop the question being asked.
  yield* Effect.ignore(
    herdr.notify(
      `${waiting.title} needs you`,
      `${waiting.choice?.step}: pick what happens next`,
      "request",
    ),
  );
  if (!env.tabId) return;
  // A tab that will not focus is still a tab the human can reach.
  yield* Effect.ignore(herdr.tabFocus(env.tabId));
});

/** One keypress against a pending question; the answer goes back to the run dir. */
export const answerKey = Effect.fn("Flows.answerKey")(function* (
  waiting: RunRow,
  asking: Asking,
  key: string,
) {
  const choice = waiting.choice;
  if (!choice) return { asking };
  let value: string | null = null;

  if (key === "\x1b" || key === "\x03") value = "";
  if (key === "\r" || key === "\n") {
    if (choice.kind === "ask") value = asking.typed;
    const picked = choice.items[asking.index];
    if (value === null) value = picked?.id ?? null;
  }
  if (value !== null) {
    const answered = yield* answerRun(waiting, value, yield* newRequestId());
    return {
      asking: { index: 0, typed: "" },
      note: answered.ok
        ? `answered ${waiting.title}`
        : `${waiting.title}: ${answered.error.message}`,
    };
  }
  if (choice.kind === "ask") {
    if (key === "\x7f" || key === "\b")
      return { asking: { ...asking, typed: asking.typed.slice(0, -1) } };
    if (/^[\x20-\x7e]$/.test(key)) return { asking: { ...asking, typed: asking.typed + key } };
    return { asking };
  }
  if (key === "\x1b[A") return { asking: { ...asking, index: Math.max(0, asking.index - 1) } };
  if (key === "\x1b[B") {
    return { asking: { ...asking, index: Math.min(choice.items.length - 1, asking.index + 1) } };
  }
  return { asking };
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
  view: WorkspaceView,
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

const load = Effect.fn("Flows.load")(function* (session: ControlSession) {
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
  });
});

const bail = Effect.fn("Flows.bail")(function* (message: string, extra?: string) {
  return yield* notice(message, 1, extra);
});

const notice = Effect.fn("Flows.notice")(function* (message: string, code: number, extra?: string) {
  process.stdout.write(
    `\x1b[2J\x1b[H${extra ? `${extra}\n\n` : ""}${message}\n\nPress any key to close.\n`,
  );
  yield* anyKey();
  return code;
});

const anyKey = Effect.fn("Flows.anyKey")(function* () {
  if (!process.stdin.isTTY) return;
  yield* nextKey();
  releaseKeyboard();
});
