// The three Views beyond the board: History, Workflows and Settings. Each is a plain
// projection of what is already on disk — run dirs, definition layers, config — with no
// state of its own, produced by Effect and handed to the app as data. Produced when the
// View is first shown, because loading every run's outputs at startup is what would make
// the tab slow the day it became useful.

import { Effect, FileSystem, Path, Stream } from "effect";
import { attentionFor } from "./attention";
import { loadDefaults, readConfig } from "./config";
import { readIntent } from "./intent";
import { savedModules } from "./discovery";
import { checkModule, readModule } from "./authoring";
import type { PluginEnv } from "./env";
import { runTitle } from "./naming";
import { REVIEW_FILE, findingsIn, openFindingsIn } from "./output";
import { findRun, settled, type RunFacts, type RunState } from "./runs";
import { diffTargetOf } from "./strategies";
import { isString } from "./schema";
import { took } from "./time";
import { claudeTrust } from "./trust";
import { isYamlMap, type YamlMap, type YamlValue } from "./yaml";
import { NO_OUTCOME, type RunRow } from "./workspace";
import { latest, readDispositions, type Disposition } from "./disposition";
import { metricsOf, readMetrics } from "./metrics";
import type { MrPanel, Panel, PlanPanel, PlanTicket, RunDetail } from "./board-model";
import { newest, readCards } from "./cards";
import { diffOf, planDirOf } from "./run-detail";
import { readVerifications } from "./verify";

/** Long enough to answer "what did I do here", short enough to stay one read. */
const HISTORY = 200;

/** How long the run took, where both ends of it were recorded. */
function ranFor(run: RunFacts): string | null {
  if (!run.finished) return null;
  const ms = Date.parse(run.finished) - Date.parse(run.created);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return took(ms);
}

/**
 * Every finished Run of this checkout, whatever session or workspace it came from —
 * which is exactly what separates History from the board: the Runs view is this
 * Session's live work, and this is the record of everything before it.
 */
export const buildHistory = Effect.fn("Views.buildHistory")(function* (opts: {
  cwd: string;
  runs: ReadonlyArray<RunFacts>;
}) {
  const runs = opts.runs.filter((r) => r.project === opts.cwd && settled(r)).slice(0, HISTORY);

  const rows: RunRow[] = [];
  for (const run of runs) {
    const parts: string[] = [run.state];
    const open = yield* openFindingsIn(run.dir);
    if (open > 0) parts.push(`${open} finding(s) open`);
    const duration = ranFor(run);
    if (duration) parts.push(duration);
    if (run.mr) parts.push(run.mr);
    rows.push({
      id: run.id,
      dir: run.dir,
      glyph: glyphOf(run.state),
      title: runTitle(run),
      detail: parts.join(" · "),
      at: run.finished ? Date.parse(run.finished) : 0,
      target: diffTargetOf(run.settled)?.value ?? null,
      // History never nests: each Run is a row of its own in the record of everything
      // before now.
      children: [],
      // The board's own rule, not a second copy of it: History and the Runs view both
      // decide from this whether to offer the action that starts a fix run.
      fixable: open > 0,
      choice: null,
      needsYou: false,
      // History is what happened, not what to do about it.
      ...NO_OUTCOME,
    });
  }
  return rows;
});

function glyphOf(state: RunState): string {
  return state === "succeeded" ? "✓" : state === "failed" ? "✗" : "⚠";
}

/** One Workflow as the Workflows view lists it. */
export interface DefinitionRow {
  name: string;
  title: string;
  layer: string;
  path: string;
  inputs: string[];
  /** What checking it says, so a module that will not run is visible without running it. */
  problems: string[];
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
  const saved = yield* savedModules(env);
  const described = yield* Effect.forEach(saved.entries, readModule);
  const checked = yield* Effect.forEach(saved.entries, (one) =>
    checkModule({ layer: one.layer, path: one.path }),
  );
  const problemsOf = new Map(checked.map((one) => [one.path, one.problems]));
  const workflows: DefinitionRow[] = described
    .map((one) => ({
      name: one.id,
      title: one.title,
      layer: one.layer,
      path: one.path,
      inputs: one.inputs.map((input) => input.name),
      problems: [...(problemsOf.get(one.path) ?? []), ...(one.broken === null ? [] : [one.broken])],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // A module that will not load at all is the view's problem too, not a silent gap.
  return {
    workflows,
    errors: saved.problems.map((one) => `${one.path}: ${one.message}`),
  };
});

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

/**
 * The plan behind a run, and `null` for one that has none.
 *
 * The spec is capped and paged exactly like the review: an agent wrote it, so it can be
 * any size at all, and `m` is how the rest of it is read.
 */
const buildPlan = Effect.fn("Views.buildPlan")(function* (run: RunFacts, cap: number) {
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
  run: RunFacts,
  cap: number,
  plans: Map<string, PlanPanel | null> | undefined,
) {
  if (!plans || !settled(run)) return yield* buildPlan(run, cap);
  const key = `${run.id}:${cap}`;
  if (plans.has(key)) return plans.get(key) ?? null;
  const plan = yield* buildPlan(run, cap);
  plans.set(key, plan);
  return plan;
});

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

/** What a Run kept beside its journals, which a drawer fetches one by one. */
const evidenceIn = Effect.fn("Views.evidenceIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kept = [];
  for (const name of (yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))).sort(
    (a, b) => a.localeCompare(b),
  )) {
    if (name.endsWith(".jsonl")) continue;
    const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "File")
      kept.push({ name, bytes: Number(info.value.size) });
  }
  return kept;
});

export const buildRunDetail = Effect.fn("Views.buildRunDetail")(function* (opts: {
  env: PluginEnv;
  runId: string;
  /** The Runs this read already has, so the selected one is not asked for twice. */
  runs?: ReadonlyArray<RunFacts>;
  mr: MrPanel | null;
  /** Whether the panel's log tail is showing; the log is only read while it is. */
  tail?: boolean;
  /** How many caps of the review to read, for one the panel has been asked to page. */
  pages?: number;
  /**
   * Where a finished Run's plan is kept between reads, owned by the caller the way the
   * merge request is. A Run's plan is fixed input once it has stopped, and the panel is
   * re-produced on every board tick. A Run still going is never cached: it may be
   * writing that plan as we read it.
   */
  plans?: Map<string, PlanPanel | null>;
}) {
  const path = yield* Path.Path;
  const run =
    opts.runs?.find((one) => one.id === opts.runId) ?? (yield* findRun(opts.env, opts.runId));
  // Gone, or never there: the panel shows the row's own facts instead.
  if (!run) return null;

  const cap = REVIEW_CAP * Math.max(1, opts.pages ?? 1);
  const review =
    (yield* capped(path.join(run.dir, REVIEW_FILE), cap)) ??
    ({ _tag: "None", reason: `this run wrote no ${REVIEW_FILE}` } satisfies Panel);

  const attention = yield* attentionFor(run);
  return {
    id: run.id,
    dir: run.dir,
    title: runTitle(run),
    status: run.state,
    inputs: Object.entries(run.settled.inputs).map(([name, value]) => ({
      name,
      value,
      source: run.settled.sources?.[name] ?? "",
    })),
    steps: [],
    handoffs: [],
    intent: yield* readIntent(run.dir).pipe(
      Effect.map((held) =>
        held === null
          ? null
          : { goal: held.goal, constraints: held.constraints.map((c) => c.text) },
      ),
      Effect.catch(() => Effect.succeed(null)),
    ),
    review,
    plan: yield* plannedFor(run, cap, opts.plans),
    outputs: [],
    attention,
    outcome: {
      kind: run.outcome === "unspecified" ? null : run.outcome,
      gaps: [],
      obstacle: run.state === "succeeded" ? null : run.note,
      // The first of the actions `attention` already worked out, rather than a second
      // opinion about what to do — one classification, however it is asked for.
      next: attention.actions[0] ?? null,
      delivered: dispositionOf(latest(yield* readDispositions(run.dir))),
      metrics: metricsOf(yield* readMetrics(run.evidence), run.created),
    },
    tail: opts.tail
      ? ((yield* tailed(path.join(run.dir, "log.txt"), TAIL_CAP)) ??
        ({ _tag: "None", reason: "this run wrote no log" } satisfies Panel))
      : null,
    finishedAt: run.finished ? Date.parse(run.finished) : 0,
    mr: opts.mr,
    findings: (yield* findingsIn(run.dir)).map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      file: finding.file ?? null,
      line: finding.line ?? null,
      detail: finding.detail ?? null,
    })),
    verifications: (yield* readVerifications(run.evidence).pipe(
      Effect.orElseSucceed(() => []),
    )).map(({ id, name, result, expect, exit, at, by }) => ({
      id,
      name,
      result,
      expect,
      exit,
      at,
      by,
    })),
    steering: newest(yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []))).map(
      (card) => ({
        id: card.id,
        kind: card.kind,
        at: card.at,
        readiness: card.readiness,
        significance: card.significance,
        narrative: card.narrative,
        missing: card.missing,
      }),
    ),
    evidence: yield* evidenceIn(run.evidence),
    diff: yield* diffOf(run),
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
  "density",
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
  const defaults = yield* loadDefaults(env.userDir);
  const raw = yield* readConfig(env.userDir);
  const state = yield* claudeTrust(env.home, env.stateDir)
    .state(env.cwd)
    .pipe(Effect.catch(() => Effect.succeed("unknown" as const)));

  return {
    configPath: path.join(env.userDir, "config.json"),
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
      { key: "density", value: defaults.density },
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
