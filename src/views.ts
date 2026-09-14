// The three Views beyond the board: History, Workflows and Settings. Each is a plain
// projection of what is already on disk — run dirs, definition layers, config — with no
// state of its own, produced by Effect and handed to the app as data. Produced when the
// View is first shown, because loading every run's outputs at startup is what would make
// the tab slow the day it became useful.

import { Clock, Effect, FileSystem, Path, Stream } from "effect";
import { attentionFor, type Attention } from "./attention";
import type { AsksAgents } from "./herdr";
import { loadDefaults, readConfig } from "./config";
import {
  isStale,
  layers,
  loadDefinitions,
  resolveWorkflow,
  skillDirs,
  validateWorkflow,
  type LayerName,
  type ResolvedStep,
  type Provenance,
} from "./definitions";
import { RUNNER_LOG } from "./driver";
import type { PluginEnv } from "./env";
import { choiceHint } from "./engine";
import { displayName, reason, targetLabel } from "./naming";
import type { MrPanel } from "./mr";
import { REVIEW_FILE } from "./output";
import { RunStore, type Run, type RunRecord } from "./run";
import { isString } from "./schema";
import { stepDuration, took } from "./time";
import { claudeTrust } from "./trust";
import { isYamlMap, type YamlMap, type YamlValue } from "./yaml";
import { NO_OUTCOME, fixableRun, type RunRow } from "./workspace";
import { latest, readDispositions, type Disposition } from "./disposition";
import { metricsOf, readMetrics, type Metrics } from "./metrics";
import { branchListed } from "./worktree";

/** Long enough to answer "what did I do here", short enough to stay one read. */
const HISTORY = 200;

function title(record: RunRecord): string {
  const target = record.target_label ?? targetLabel(record.workflow, record.slug, record.inputs);
  const name = displayName(record.workflow);
  return target ? `${name} · ${target}` : name;
}

/** How long the run took, where both ends of it were recorded. */
function ranFor(record: RunRecord): string | null {
  if (!record.finished_at) return null;
  const ms = Date.parse(record.finished_at) - Date.parse(record.created_at);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // The same formatting a step's duration gets: History and the detail panel's Steps
  // list are on screen in one session, and one saying "12m" while the other says
  // "12 minutes" is one clock, said twice.
  return took(ms);
}

/**
 * Every finished Run of this checkout, whatever session or workspace it came from —
 * which is exactly what separates History from the board: the Runs view is this
 * Session's live work, and this is the record of everything before it.
 */
export const buildHistory = Effect.fn("Views.buildHistory")(function* (opts: {
  stateDir: string;
  cwd: string;
  /** The Runs already read, so a caller drawing two Views scans the dir once. */
  runs?: ReadonlyArray<Run>;
}) {
  const all = opts.runs ?? (yield* new RunStore(opts.stateDir).list());
  const runs = all
    .filter((r) => r.record.cwd === opts.cwd && r.record.status !== "running")
    .slice(0, HISTORY);

  const rows: RunRow[] = [];
  for (const run of runs) {
    const record = run.record;
    const parts: string[] = [record.status];
    if (record.outstanding.length > 0) parts.push(`${record.outstanding.length} finding(s) open`);
    if (record.fixed > 0) parts.push(`${record.fixed} fixed`);
    const duration = ranFor(record);
    if (duration) parts.push(duration);
    if (record.mr_url) parts.push(record.mr_url);
    rows.push({
      id: run.id,
      dir: run.dir,
      glyph: glyphOf(record.status),
      title: title(record),
      detail: parts.join(" · "),
      at: record.finished_at ? Date.parse(record.finished_at) : 0,
      target: record.inputs.target ?? null,
      // History never nests: a finished run's repository runs are finished too, and
      // each is a row of its own in the record of everything before now.
      children: [],
      // The board's own rule, not a second copy of it: History and the Runs view both
      // decide from this whether to offer the action that starts a fix run.
      fixable: yield* fixableRun(run),
      choice: null,
      needsYou: false,
      // History is what happened, not what to do about it: these rows are read, never
      // acted on, and a next action on one of them would point at a Run that has ended.
      ...NO_OUTCOME,
    });
  }
  return rows;
});

function glyphOf(status: RunRecord["status"]): string {
  // Imported rather than re-derived would be circular; the board's own glyphFor reads a
  // whole record, and History has only the outcome.
  return status === "done" ? "✓" : status === "failed" ? "✗" : "⚠";
}

/** One Workflow as the Workflows view lists it. */
export interface DefinitionRow {
  name: string;
  title: string;
  layer: LayerName;
  /** `extends x`, `(stale …)`: where it came from and whether it has fallen behind. */
  provenance: string;
  path: string;
  inputs: string[];
  /** The steps it runs, one line each: what a definition's execution shape actually is. */
  steps: string[];
  /** Every Choice step and the decision titles it can be answered with. */
  decisions: Array<{ step: string; titles: string[]; hints: string[] }>;
  /** What `validateWorkflow` says, so a broken fork is visible without running it. */
  problems: string[];
}

/** One step as the panel lists it: who runs it, and what shape the step has. */
function stepLine(step: ResolvedStep): string {
  const who = [step.harness, step.model].filter((part) => part !== undefined).join("/");
  return [
    step.id,
    step.persona ?? "",
    who,
    step.parallel && step.parallel.length > 0 ? `${step.parallel.length} in parallel` : "",
    step.fanIn ? `fan-in ${step.fanIn}` : "",
    (step.choices ?? []).length > 0 ? "choice" : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

function provenanceOf(def: Provenance): string {
  const parts: string[] = [];
  if (def.extends) parts.push(`extends ${def.extends}`);
  if (isStale(def)) parts.push("stale — the original has changed since this copy");
  return parts.join(" · ");
}

/**
 * Every Workflow the layers offer, with the validation each would fail on. Validation is
 * the point: a fork that cannot run should be visible here rather than at launch, so the
 * errors are collected per row instead of aborting the view.
 *
 * Workflows only. A persona cannot be run, so the view stopped listing them, and there is
 * nothing here to build a row from — `fork` reads the personas it offers straight from
 * the definitions, and `collie persona list` has its own.
 */
export const buildWorkflows = Effect.fn("Views.buildWorkflows")(function* (env: PluginEnv) {
  const defs = yield* loadDefinitions(yield* layers(env));
  const defaults = yield* loadDefaults(env.configDir);
  const skills = yield* skillDirs(env);

  const workflows: DefinitionRow[] = [];
  for (const def of [...defs.workflows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    // Resolving is where an `extends:` or `use:` that points at nothing shows up, and it
    // throws rather than returning; a row that cannot resolve is still a row.
    const attempt = yield* Effect.try(() => resolveWorkflow(def.name, defs, defaults)).pipe(
      Effect.map((workflow) => ({ ok: true as const, workflow })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, why: reason(cause) })),
    );
    if (!attempt.ok) {
      workflows.push({
        name: def.name,
        title: def.title,
        layer: def.layer,
        provenance: provenanceOf(def),
        path: def.path,
        inputs: Object.keys(def.inputs),
        // Unresolved is exactly the case where the steps cannot be listed: that is what
        // the problem on this row says.
        steps: [],
        decisions: [],
        problems: [attempt.why],
      });
      continue;
    }
    const resolved = attempt.workflow;
    workflows.push({
      name: resolved.name,
      title: resolved.title,
      layer: resolved.layer,
      provenance: provenanceOf(def),
      path: resolved.path,
      inputs: Object.keys(branchListed(resolved.name, resolved.inputs)),
      steps: resolved.steps.map(stepLine),
      decisions: resolved.steps
        .filter((step) => (step.choices ?? []).length > 0)
        .map((step) => ({
          step: step.id,
          titles: (step.choices ?? []).map((c) => c.title),
          hints: (step.choices ?? []).map((c) => choiceHint(c)),
        })),
      problems: [...(yield* validateWorkflow(resolved, defs, defaults, skills))],
    });
  }

  // A layer that would not load at all is the view's problem too, not a silent gap.
  return { workflows, errors: defs.errors };
});

/** Text a panel read from a file, or why it has none. */
export type Panel =
  | { _tag: "None"; reason: string }
  | { _tag: "Text"; text: string; truncated: boolean };

/**
 * Whether a panel's text was cut short, which is the one thing a `Text` panel says
 * beyond its text — and the only thing `m` can act on. Takes an absent panel too,
 * because every caller is reading through a Selection that may not have one.
 */
export function truncated(panel: Panel | null | undefined): boolean {
  return panel?._tag === "Text" && panel.truncated;
}

/**
 * How much of a file the panel will read. A run dir can hold a 40 MB log and a review
 * long enough to stall a redraw; the panel is for reading, and what does not fit is
 * said to be cut rather than quietly dropped.
 */
const REVIEW_CAP = 64 * 1024;
const OUTPUT_CAP = 8 * 1024;
/** And how much of the log the tail shows: the end of it is the part worth reading. */
const TAIL_CAP = 8 * 1024;

const capped = Effect.fn("Views.capped")(function* (file: string, cap: number) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(null)));
  if (info === null) return null;
  // Read the cap, rather than read the file and then slice it to the cap: an agent
  // writes these, so a review or an Output can be any size at all, and every selection
  // and every refresh after it would pull the whole of one into the tab's memory.
  const text = yield* fs.stream(file, { bytesToRead: cap }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.catch(() => Effect.succeed(null)),
  );
  if (text === null) return null;
  return { _tag: "Text" as const, text, truncated: Number(info.size) > cap };
});

/**
 * The end of a file, for a file only the end of which is interesting. Read from an
 * offset rather than read and sliced: a run dir can hold a 40 MB log, and the panel
 * asking for one is not a reason to hold it in memory.
 */
const tailed = Effect.fn("Views.tailed")(function* (file: string, cap: number) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(null)));
  if (info === null) return null;
  const from = Math.max(0, Number(info.size) - cap);
  const text = yield* fs.stream(file, { offset: from }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  );
  // Starting mid-line reads as corruption, so the partial first line goes.
  return from === 0
    ? { _tag: "Text" as const, text, truncated: false }
    : { _tag: "Text" as const, text: text.slice(text.indexOf("\n") + 1), truncated: true };
});

/** One ticket of a run's plan, as the panel lists it. */
export interface PlanTicket {
  /** Its file name inside `plan/issues/`, which is what orders the list. */
  file: string;
  title: string;
  /** Whether every checkbox in it is checked. No boxes at all is not done. */
  done: boolean;
}

/** The plan a run is building from: its spec, and the tickets under it. */
export interface PlanPanel {
  spec: Panel;
  tickets: PlanTicket[];
}

const CHECKBOX = /^\s*[-*]\s*\[( |x|X)\]/;

/**
 * One ticket as the panel lists it. Pure, and deliberately shallow: the first heading is
 * the title because that is what every workflow's ticket template writes, and a file
 * with none is named by its file rather than by a guess at its first sentence.
 */
export function planTicket(file: string, text: string): PlanTicket {
  const lines = text.split("\n");
  const heading = (lines.find((line) => line.startsWith("#")) ?? "").replace(/^#+\s*/, "").trim();
  // The mark inside each checkbox, in one pass: a line that is not one contributes none.
  const marks = lines.flatMap((line) => CHECKBOX.exec(line)?.[1] ?? []);
  return {
    file,
    title: heading === "" ? file : heading,
    // A ticket nobody has marked up is open, not finished: `every` over nothing is true,
    // which would have called every prose-only ticket done.
    done: marks.length > 0 && marks.every((mark) => mark !== " "),
  };
}

/** One step's Output: what it was asked for, and what is actually there. */
export interface OutputPanel {
  step: string;
  /** Where it was asked for, relative to the run dir, so the path is readable. */
  where: string;
  /** `recorded`, `missing`, or `unreadable` — the states `src/output.ts` already models. */
  state: "recorded" | "missing" | "unreadable";
  text: string;
}

/** What a Run's own plan directory is called inside it (ADR-0002). */
const PLAN_DIR = "plan";

/** Which directory holds this run's plan, or `null` when it has none behind it. */
const planDirOf = Effect.fn("Views.planDirOf")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Its own copy first: a run that wrote a plan is building from that one.
  const own = path.join(run.dir, PLAN_DIR);
  if (yield* fs.exists(own)) return own;
  // Then the directory it was started from, which is how an `implement` run reaches the
  // spec a `plan` run wrote for it.
  if (run.record.inputs.plan_kind !== "plan-dir") return null;
  const started = run.record.inputs.plan ?? "";
  return started !== "" && (yield* fs.exists(started)) ? started : null;
});

/**
 * The plan behind a run, and `null` for one that has none.
 *
 * The spec is capped and paged exactly like the review: an agent wrote it, so it can be
 * any size at all, and `m` is how the rest of it is read.
 */
const buildPlan = Effect.fn("Views.buildPlan")(function* (run: Run, cap: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* planDirOf(run);
  if (dir === null) return null;

  const spec =
    (yield* capped(path.join(dir, "SPEC.md"), cap)) ??
    ({ _tag: "None", reason: "this plan has no SPEC.md" } satisfies Panel);

  const issues = path.join(dir, "issues");
  const files = (yield* fs.readDirectory(issues).pipe(Effect.catch(() => Effect.succeed([]))))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const tickets: PlanTicket[] = [];
  for (const file of files) {
    // Capped like everything else the panel reads: a ticket is prose an agent wrote.
    const text = yield* capped(path.join(issues, file), OUTPUT_CAP);
    tickets.push(planTicket(file, text?.text ?? ""));
  }
  return { spec, tickets };
});

/**
 * The plan behind a Run, from the caller's cache where it can be. Keyed by the cap as
 * well as the Run, because `m` asking for another page has to read further into a spec
 * that was cut short.
 */
const plannedFor = Effect.fn("Views.plannedFor")(function* (
  run: Run,
  cap: number,
  plans: Map<string, PlanPanel | null> | undefined,
) {
  if (!plans || run.record.status === "running") return yield* buildPlan(run, cap);
  const key = `${run.id}:${cap}`;
  if (plans.has(key)) return plans.get(key) ?? null;
  const plan = yield* buildPlan(run, cap);
  plans.set(key, plan);
  return plan;
});

/** Everything the detail panel shows for the selected Run. */
export interface RunDetail {
  id: string;
  dir: string;
  title: string;
  status: string;
  inputs: Array<{ name: string; value: string; source: string }>;
  /** `took` is how long a finished step took, or how long a running one has been going. */
  steps: Array<{ id: string; status: string; note: string; took: string | null; agents: string[] }>;
  /** One line each, as the record wrote them. */
  handoffs: string[];
  /** The rendered review — the thing the panel exists for. */
  review: Panel;
  /**
   * The plan this Run is building from, so the work can be judged against its intent
   * without leaving the tab. `null` for a Run that has no plan behind it.
   */
  plan: PlanPanel | null;
  outputs: OutputPanel[];
  /** The end of the run's log while the panel's tail is toggled on; `null` while it is off. */
  tail: Panel | null;
  /**
   * Why the Run is where it is, and what is safe to do about it — the same value the
   * CLI's `run show` and attention wait return. One classification, so the board and an
   * agent driving the CLI cannot tell a human two different stories about one Run.
   */
  attention: Attention;
  /**
   * What this Run has to prove, what it has not proved yet, what is in its way, what to
   * do next, and what became of its work. The panel used to say only why a Run stopped;
   * these say what it was for and whether it got there.
   */
  outcome: {
    kind: string | null;
    gaps: ReadonlyArray<string>;
    obstacle: string | null;
    next: string | null;
    delivered: string | null;
    metrics: Metrics;
  };
  /** When this Run finished, so the merge-request panel can say what moved since. */
  finishedAt: number;
  /** Filled by the bridge for a Run whose target is a merge request; never here. */
  mr: MrPanel | null;
}

/**
 * The selected Run, read from its own directory. Files, so this is state produced by an
 * Effect fiber and never a read inside a component — that is what would make the app
 * stutter, and untestable before that.
 *
 * The merge request is passed in rather than fetched: it is cached per ref with a TTL by
 * the caller, because a list must never fetch and a re-selection must cost nothing.
 */
/** A detail with nothing to say about its outcome: fixtures, and a Run that proved none. */
export const NO_RUN_OUTCOME: RunDetail["outcome"] = {
  kind: null,
  gaps: [],
  obstacle: null,
  next: null,
  delivered: null,
  metrics: metricsOf([], ""),
};

/** What became of the work, as one phrase, or nothing where nobody has said. */
function dispositionOf(line: Disposition | null): string | null {
  if (line === null) return null;
  return line.ref === "" ? line.kind : `${line.kind} ${line.ref}`;
}

export const buildRunDetail = Effect.fn("Views.buildRunDetail")(function* (opts: {
  stateDir: string;
  runId: string;
  /** Asked whether the agents a stopped Run still records are actually there. */
  agents: AsksAgents;
  mr: MrPanel | null;
  /** Whether the panel's log tail is showing; the log is only read while it is. */
  tail?: boolean;
  /** How many caps of the review to read, for one the panel has been asked to page. */
  pages?: number;
  /**
   * Where a finished Run's plan is kept between reads, owned by the caller the way the
   * merge request is. A Run's plan is fixed input once it has stopped, and the panel is
   * re-produced on every board tick — so re-reading SPEC.md, the issues directory and
   * every ticket every three seconds was work for an answer that cannot change. A Run
   * still running is never cached: it may be writing that plan as we read it.
   */
  plans?: Map<string, PlanPanel | null>;
}) {
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const run = yield* new RunStore(opts.stateDir)
    .load(opts.runId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  // Gone, half-written, or never there: the panel shows the row's own facts instead.
  if (!run) return null;
  const record = run.record;
  /**
   * Where an unfinished step's clock stops. A run killed by a SIGTERM, or one whose
   * driver died, records its own end without ever finishing the step it was on — and a
   * step with no end of its own is otherwise read as still running, so reopening a run
   * that died last week showed its last step as having taken a week.
   */
  const stoppedAt = record.finished_at ? Date.parse(record.finished_at) : now;

  const cap = REVIEW_CAP * Math.max(1, opts.pages ?? 1);
  const review =
    (yield* capped(path.join(run.dir, REVIEW_FILE), cap)) ??
    ({ _tag: "None", reason: `this run wrote no ${REVIEW_FILE}` } satisfies Panel);

  const outputs: OutputPanel[] = [];
  for (const step of record.steps) {
    for (const variant of step.variants) {
      if (!variant.output) continue;
      const text = yield* capped(path.join(run.dir, variant.output), OUTPUT_CAP);
      outputs.push({
        step: step.id,
        where: variant.output,
        // An Output the agent never wrote, or wrote as prose, is what the variant's own
        // error already says; the panel repeats it rather than deciding again.
        state: text === null ? "missing" : variant.error ? "unreadable" : "recorded",
        text: text === null ? (variant.error ?? "nothing was written here") : text.text.trim(),
      });
    }
  }

  const attention = yield* attentionFor(run, opts.agents);
  return {
    id: run.id,
    dir: run.dir,
    title: title(record),
    status: record.status,
    inputs: Object.entries(record.inputs).map(([name, value]) => ({
      name,
      value,
      source: record.input_sources[name] ?? "",
    })),
    steps: record.steps.map((step) => ({
      id: step.id,
      status: step.status,
      note: step.note ?? "",
      took: stepDuration(step, stoppedAt),
      agents: step.variants.map((v) => v.agent),
    })),
    handoffs: record.handoffs.map(
      (h) => `${h.direction} ${h.role} (${h.agent}) · run ${h.run}${h.note ? ` · ${h.note}` : ""}`,
    ),
    review,
    plan: yield* plannedFor(run, cap, opts.plans),
    outputs,
    attention,
    outcome: {
      kind: record.outcome,
      gaps: record.evidence_gaps,
      obstacle: record.obstacle,
      // The first of the actions `attention` already worked out, rather than a second
      // opinion about what to do — one classification, however it is asked for.
      next: attention.actions[0] ?? null,
      delivered: dispositionOf(latest(yield* readDispositions(run.dir))),
      metrics: metricsOf(yield* readMetrics(run.dir), record.created_at),
    },
    tail: opts.tail
      ? ((yield* tailed(path.join(run.dir, RUNNER_LOG), TAIL_CAP)) ??
        ({ _tag: "None", reason: `this run wrote no ${RUNNER_LOG}` } satisfies Panel))
      : null,
    finishedAt: record.finished_at ? Date.parse(record.finished_at) : 0,
    mr: opts.mr,
  } satisfies RunDetail;
});

/** What Settings shows and can write back. No new store: `config.json` and the harness. */
export interface SettingsView {
  configPath: string;
  /** The defaults a Run uses, resolved through the config file and the fallbacks. */
  defaults: Array<{ key: string; value: string }>;
  /** Values a Run remembered for next time, `linear.team` and its kind. */
  remembered: Array<{ key: string; value: string }>;
  /** Whether the harness will work in this directory without stopping to ask. */
  trust: { cwd: string; state: string };
}

/** Every leaf of the config file as a dotted key, so a nested value still has a name. */
function flatten(raw: YamlMap, prefix = ""): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(raw)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    if (isYamlMap(value)) out.push(...flatten(value, dotted));
    else out.push({ key: dotted, value: scalar(value) });
  }
  return out;
}

/** One config value as a line of text. A nested map has no one line, so it has none. */
function scalar(value: YamlValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(scalar).join(", ");
  if (isYamlMap(value)) return "";
  // Serialised rather than stringified: a value the checker still reads as map-like
  // would otherwise reach Settings as "[object Object]".
  return isString(value) ? value : (JSON.stringify(value) ?? "");
}

/**
 * The config keys `loadDefaults` actually reads, which are the only ones worth offering
 * to change. They are snake_case on disk and camelCase on `Defaults`, and Settings used
 * to name the camelCase ones — so editing "maxIterations" reported success, wrote a key
 * nothing reads, and left the effective default exactly where it was.
 */
const DEFAULT_KEYS = [
  "harness",
  "model",
  "effort",
  "trust",
  "permissions",
  "scope",
  "questions",
  "max_iterations",
  "handoff_timeout_ms",
  "quiet_ms",
  "board_quiet_ms",
  "compact_at_tokens",
] as const;

/** The ones `loadDefaults` reads with `isNumber`: a string there is ignored. */
export const NUMERIC_DEFAULTS: ReadonlyArray<string> = [
  "max_iterations",
  "handoff_timeout_ms",
  "quiet_ms",
  "board_quiet_ms",
  "compact_at_tokens",
];

export const buildSettings = Effect.fn("Views.buildSettings")(function* (env: PluginEnv) {
  const path = yield* Path.Path;
  const defaults = yield* loadDefaults(env.configDir);
  const raw = yield* readConfig(env.configDir);
  const state = yield* claudeTrust(env.home, env.stateDir)
    .state(env.cwd)
    .pipe(Effect.catch(() => Effect.succeed("unknown" as const)));

  return {
    configPath: path.join(env.configDir, "config.json"),
    // Named one by one rather than looked up: these are the keys Settings writes back
    // through `config.ts`, and a dictionary would let one drift out of `Defaults`.
    defaults: [
      { key: "harness", value: defaults.harness },
      { key: "model", value: defaults.model },
      { key: "effort", value: defaults.effort ?? "" },
      { key: "trust", value: defaults.trust },
      { key: "permissions", value: defaults.permissions },
      { key: "scope", value: defaults.scope },
      { key: "questions", value: defaults.questions },
      { key: "max_iterations", value: String(defaults.maxIterations) },
      { key: "handoff_timeout_ms", value: String(defaults.handoffTimeoutMs) },
      { key: "quiet_ms", value: String(defaults.quietMs) },
      { key: "board_quiet_ms", value: String(defaults.boardQuietMs) },
      { key: "compact_at_tokens", value: String(defaults.compactAtTokens) },
    ],
    // Everything else the file holds: remembered answers, per-harness model lists, the
    // notification kinds someone turned off. Shown as written rather than interpreted.
    remembered: flatten(raw).filter(
      (entry) => !DEFAULT_KEYS.some((key) => entry.key === String(key)),
    ),
    trust: { cwd: env.cwd, state },
  } satisfies SettingsView;
});
