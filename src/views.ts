// The three Views beyond the board: History, Workflows and Settings. Each is a plain
// projection of what is already on disk — run dirs, definition layers, config — with no
// state of its own, produced by Effect and handed to the app as data. Produced when the
// View is first shown, because loading every run's outputs at startup is what would make
// the tab slow the day it became useful.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import { Effect, FileSystem, Option, Path, Stream, Struct } from "effect";
import { attachmentsDir, listAttachments } from "./attachments";
import { handoffsIn } from "./handoffs";
import { readReplies } from "./replies";
import { attentionFor } from "./attention";
import { configValue, readConfig, readSettingsSet } from "./config";
import { settingOf, SETTINGS } from "./settings";
import { readIntent } from "./intent";
import { savedModules } from "./discovery";
import { checkModule, readModule } from "./authoring";
import type { PluginEnv } from "./env";
import { runTitle } from "./naming";
import { REVIEW_FILE, findingsIn, openFindingsIn } from "./output";
import { findRun, settled, type RunFacts, type RunState } from "./runs";
import { diffTargetOf } from "./strategies";
import { isString } from "./schema";
import { took, epochMs } from "./time";
import { claudeTrust } from "./trust";
import { isYamlMap, type YamlMap, type YamlValue } from "./yaml";
import { NO_OUTCOME, type RunRow } from "./workspace";
import { latest, readDispositions } from "./disposition";
import { readLaunches, runAgents } from "./launches";
import { metricsOf, readMetrics } from "./metrics";
import type {
  Disposition,
  Flow,
  MrPanel,
  Panel,
  PlanPanel,
  PlanTicket,
  RunDetail,
} from "./board-model";
import { newest, readCards, readCheckpoints } from "./cards";
import { diffOf, PLAN_DIR, planDirOf } from "./run-detail";
import { orderedTickets, REPO_LINE } from "./plan";
import { workSourceOf } from "./strategies";
import { readVerifications } from "./verify";
import { readMeasurements } from "./measurement";
import { finalMeasurementLine, type Measurement } from "./measurement-model";
import { readLogTail } from "./run-log";
import { readAudit, startedBy } from "./audit";
import { onPath } from "./doctor-check";
import { HARNESSES } from "./harness";
import type { MachineOwn } from "./board-model";
import type { Mutable } from "effect/Types";

/** Long enough to answer "what did I do here", short enough to stay one read. */
const HISTORY = 200;

/** How long the run took, where both ends of it were recorded. */
function ranFor(run: RunFacts): string | null {
  if (!run.finished) return null;
  const ms = epochMs(run.finished) - epochMs(run.created);
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
  const runs = Arr.filter(opts.runs, (r) => r.project === opts.cwd && settled(r)).slice(0, HISTORY);

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
      detail: Arr.join(parts, " · "),
      at: run.finished ? epochMs(run.finished) : 0,
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
  const problemsOf = new Map(Arr.map(checked, (one) => [one.path, one.problems]));
  const workflows: DefinitionRow[] = Arr.map(described, (one) => ({
    name: one.id,
    title: one.title,
    layer: one.layer,
    path: one.path,
    inputs: Arr.map(one.inputs, (input) => input.name),
    problems: [...(problemsOf.get(one.path) ?? []), ...(one.broken === null ? [] : [one.broken])],
  })).sort((a, b) => pipe(a.name, Str.localeCompare(b.name)));

  // A module that will not load at all is the view's problem too, not a silent gap.
  return {
    workflows,
    errors: Arr.map(saved.problems, (one) => `${one.path}: ${one.message}`),
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
  const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
  if (info === null) return null;
  // Read the cap, rather than read the file and then slice it to the cap: an agent
  // writes these, so a review or an Output can be any size at all, and every selection
  // and every refresh after it would pull the whole of one into the tab's memory.
  const text = yield* fs.stream(file, { bytesToRead: cap }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => null),
  );
  if (text === null) return null;
  return { _tag: "Text" as const, text, truncated: Number(info.size) > cap };
});

/**
 * The end of a file, for a file only the end of which is interesting. Read from an
 * offset rather than read and sliced: a run dir can hold a 40 MB log, and the panel
 * asking for one is not a reason to hold it in memory.
 */
export const tailed = Effect.fn("Views.tailed")(function* (file: string, cap: number) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
  if (info === null) return null;
  const from = Math.max(0, Number(info.size) - cap);
  const text = yield* fs.stream(file, { offset: from }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  );
  // Starting mid-line reads as corruption, so the partial first line goes.
  return from === 0
    ? { _tag: "Text" as const, text, truncated: false }
    : {
        _tag: "Text" as const,
        text: pipe(text, Str.slice(Option.getOrElse(pipe(text, Str.indexOf("\n")), () => -1) + 1)),
        truncated: true,
      };
});

const CHECKBOX = /^\s*[-*]\s*\[( |x|X)\]/;

/**
 * One ticket as the panel lists it. Pure, and deliberately shallow: the first heading is
 * the title because that is what every workflow's ticket template writes, and a file
 * with none is named by its file rather than by a guess at its first sentence.
 */
export function planTicket(file: string, text: string): PlanTicket {
  const lines = Str.split(text, "\n");
  const heading = Str.trim(
    pipe(
      Option.getOrUndefined(Arr.findFirst(lines, (line) => pipe(line, Str.startsWith("#")))) ?? "",
      Str.replace(/^#+\s*/, ""),
    ),
  );
  // The mark inside each checkbox, in one pass: a line that is not one contributes none.
  const marks = Arr.flatMap(lines, (line) => Arr.ensure(CHECKBOX.exec(line)?.[1] ?? []));
  return {
    file,
    title: heading === "" ? file : heading,
    // A ticket nobody has marked up is open, not finished: `every` over nothing is true,
    // which would have called every prose-only ticket done.
    done: marks.length > 0 && Arr.every(marks, (mark) => mark !== " "),
  };
}

/**
 * The plan behind a run, and `null` for one that has none.
 *
 * The spec is capped and paged exactly like the review: an agent wrote it, so it can be
 * any size at all, and `m` is how the rest of it is read.
 */
const buildPlan = Effect.fn("Views.buildPlan")(function* (
  run: RunFacts,
  cap: number,
  finished: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* planDirOf(run);
  if (dir === null) return null;

  const spec =
    (yield* capped(path.join(dir, "SPEC.md"), cap)) ??
    ({ _tag: "None", reason: "this plan has no SPEC.md" } satisfies Panel);

  const issues = path.join(dir, "issues");
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".md")),
  ).sort();
  const tickets: PlanTicket[] = [];
  for (const file of files) {
    // Capped like everything else the panel reads: a ticket is prose an agent wrote.
    const text = yield* capped(path.join(issues, file), OUTPUT_CAP);
    const ticket = planTicket(file, text?.text ?? "");
    tickets.push({
      ...ticket,
      done: ticket.done || finished.has(file),
      stamp: yield* stampOf(path.join(issues, file)),
    });
  }
  return { spec, specStamp: yield* stampOf(path.join(dir, "SPEC.md")), tickets };
});

/** A file's size and modification time, read without reading the file; empty where it is gone. */
const stampOf = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)).pipe(
    Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime() ?? ""}`),
    Effect.orElseSucceed(() => ""),
  );

/** The tickets of this Run's plan that a succeeded Run built from it finished. */
const finishedTickets = Effect.fn("Views.finishedTickets")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  stateDir: string,
) {
  const path = yield* Path.Path;
  const finished = new Set<string>();
  const dir = yield* planDirOf(run);
  if (dir === null) return finished;
  const issues = path.join(dir, "issues");
  const isPlan = (other: string | null | undefined) =>
    other != null && path.resolve(other) === path.resolve(dir);
  let tickets: Array<{ file: string; text: string | null }> | undefined;
  for (const one of runs) {
    if (one.state !== "succeeded") continue;
    const mayShare =
      isPlan(path.join(one.dir, PLAN_DIR)) || isPlan(workSourceOf(one.settled)?.value);
    if (!mayShare || !isPlan(yield* planDirOf(one).pipe(Effect.orElseSucceed(() => null))))
      continue;
    for (const { checkpoint } of yield* readCheckpoints(one.dir))
      if (checkpoint.status === "done") finished.add(checkpoint.ticket);
    const launches = yield* readLaunches(stateDir, one.id);
    if (launches.length === 0) continue;
    tickets ??= yield* ticketRepoLines(issues);
    const known = one.repo ? Arr.filter(tickets, (t) => t.text !== null) : tickets;
    const mine = Arr.map(
      orderedTickets(
        Arr.map(known, (t) => ({ file: t.file, text: t.text ?? "" })),
        one.repo ?? undefined,
      ),
      (t) => t.file,
    );
    for (const launch of launches) {
      const output = yield* writtenAt(launch.output);
      if (output === undefined) continue;
      if (mine.includes(launch.operation)) finished.add(launch.operation);
      if (launch.operation !== "build") continue;
      for (const file of mine) {
        const written = yield* writtenAt(path.join(issues, file));
        if (written !== undefined && written <= output) finished.add(file);
      }
    }
  }
  return finished;
});

// ponytail: never evicted; a few bytes per ticket file ever seen.
const repoLines = new Map<string, { readonly stamp: string; readonly line: string | null }>();

/** How far into a ticket its `**Repo:**` line is looked for: past the panel's cap, but bounded. */
const REPO_SCAN_CAP = 1024 * 1024;

/**
 * A ticket's `**Repo:**` match, or null where the part of the file not read could change it:
 * an empty value can still run on to a later line.
 */
function repoLineIn(text: string, truncated: boolean): string | null {
  const whole = truncated
    ? pipe(text, Str.slice(0, Option.getOrElse(pipe(text, Str.lastIndexOf("\n")), () => -1) + 1))
    : text;
  const found = REPO_LINE.exec(whole);
  if (!truncated) return found?.[0] ?? "";
  return found && found[1] !== "" ? found[0] : null;
}

/** Each ticket's `**Repo:**` match, null where it is unknown, read only when the ticket has changed. */
const ticketRepoLines = Effect.fn("Views.ticketRepoLines")(function* (issues: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".md")),
  ).sort();
  const tickets: Array<{ file: string; text: string | null }> = [];
  for (const file of files) {
    const at = path.join(issues, file);
    const stamp = yield* stampOf(at);
    let kept = repoLines.get(at);
    if (kept?.stamp !== stamp) {
      const read = yield* capped(at, REPO_SCAN_CAP);
      kept = { stamp, line: read === null ? "" : repoLineIn(read.text, read.truncated) };
      repoLines.set(at, kept);
    }
    tickets.push({ file, text: kept.line });
  }
  return tickets;
});

const writtenAt = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)).pipe(
    Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
    Effect.orElseSucceed(() => undefined),
  );

/** Every plan file's stamp, which changes whenever one of them is written. */
const planStamps = Effect.fn("Views.planStamps")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* planDirOf(run);
  if (dir === null) return "";
  const issues = path.join(dir, "issues");
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".md")),
  ).sort();
  const stamps = [`SPEC.md=${yield* stampOf(path.join(dir, "SPEC.md"))}`];
  for (const file of files) stamps.push(`${file}=${yield* stampOf(path.join(issues, file))}`);
  return Arr.join(stamps, "\n");
});

/** A finished Run's plan, by Run and cap, with the stamps it was read at. */
export type PlanCache = Map<string, { readonly stamps: string; readonly plan: PlanPanel | null }>;

/**
 * The plan behind a Run, from the caller's cache while none of its files has changed.
 * Keyed by the cap as well as the Run, because `m` asking for another page has to read
 * further into a spec that was cut short.
 */
const plannedFor = Effect.fn("Views.plannedFor")(function* (
  run: RunFacts,
  cap: number,
  plans: PlanCache | undefined,
  runs: ReadonlyArray<RunFacts>,
  stateDir: string,
) {
  const finished = yield* finishedTickets(run, runs, stateDir);
  if (!plans || !settled(run)) return yield* buildPlan(run, cap, finished);
  const key = `${run.id}:${cap}`;
  const stamps = `${yield* planStamps(run)}\nfinished=${Arr.join([...finished].sort(), ",")}`;
  const kept = plans.get(key);
  if (kept?.stamps === stamps) return kept.plan;
  const plan = yield* buildPlan(run, cap, finished);
  plans.set(key, { stamps, plan });
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
  measurement: null,
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
    (a, b) => pipe(a, Str.localeCompare(b)),
  )) {
    if (pipe(name, Str.endsWith(".jsonl"))) continue;
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
   * merge request is, because the panel is re-produced on every board tick. A finished
   * Run's agent can still rewrite it, so it is kept only while its files are unchanged. A
   * Run still going is never cached: it may be writing that plan as we read it.
   */
  plans?: PlanCache;
  /** Its Task's Flow, as the board builds it. */
  flow?: Flow | null;
}) {
  const path = yield* Path.Path;
  const run =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(opts.runs), (present) =>
        Option.getOrUndefined(Arr.findFirst(present, (one) => one.id === opts.runId)),
      ),
    ) ?? (yield* findRun(opts.env, opts.runId));
  // Gone, or never there: the panel shows the row's own facts instead.
  if (!run) return null;

  const cap = REVIEW_CAP * Math.max(1, opts.pages ?? 1);
  const review =
    (yield* capped(path.join(run.dir, REVIEW_FILE), cap)) ??
    ({ _tag: "None", reason: `this run wrote no ${REVIEW_FILE}` } satisfies Panel);

  const attention = yield* attentionFor(run);
  const log = opts.tail
    ? yield* readLogTail(run.dir, TAIL_CAP).pipe(Effect.orElseSucceed(() => null))
    : null;
  return {
    id: run.id,
    requestedBy: run.requestedBy,
    startedBy: startedBy(yield* readAudit(run.dir).pipe(Effect.orElseSucceed(() => [])), run),
    report: run.report,
    dir: run.dir,
    title: runTitle(run),
    status: run.state,
    inputs: Arr.map(Rec.toEntries(run.settled.inputs), ([name, value]) => ({
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
          : { goal: held.goal, constraints: Arr.map(held.constraints, (c) => c.text) },
      ),
      Effect.orElseSucceed(() => null),
    ),
    review,
    plan: yield* plannedFor(run, cap, opts.plans, opts.runs ?? [run], opts.env.stateDir),
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
      measurement:
        run.outcome === "performance"
          ? finalMeasurementLine(
              yield* readMeasurements(run.evidence).pipe(
                Effect.orElseSucceed((): ReadonlyArray<Measurement> => []),
              ),
            )
          : null,
      metrics: metricsOf(yield* readMetrics(run.evidence), run.created),
    },
    tail: opts.tail
      ? (log?.panel ?? ({ _tag: "None", reason: "this run wrote no log" } satisfies Panel))
      : null,
    logStart: log?.firstLine,
    finishedAt: run.finished ? epochMs(run.finished) : 0,
    mr: opts.mr,
    findings: Arr.map(yield* findingsIn(run.dir), (finding) => ({
      severity: finding.severity,
      title: finding.title,
      file: finding.file ?? null,
      line: finding.line ?? null,
      detail: finding.detail ?? null,
    })),
    verifications: Arr.map(
      yield* readVerifications(run.evidence).pipe(Effect.orElseSucceed(() => [])),
      ({ id, name, result, expect, exit, at, by, step, place }) => ({
        id,
        name,
        result,
        expect,
        exit,
        at,
        by,
        step,
        place,
      }),
    ),
    steering: Arr.map(
      newest(yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []))),
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
    handoffFiles: yield* handoffsIn(run.dir),
    replies: yield* readReplies(run.dir).pipe(Effect.orElseSucceed(() => [])),
    attachments: Arr.map(
      yield* listAttachments(attachmentsDir(run.dir)),
      ({ name, size, mediaType }) => ({ name, size, mediaType }),
    ),
    agents: yield* runAgents(opts.env.stateDir, run.id),
    diff: yield* diffOf(run),
    flow: opts.flow ?? undefined,
  } satisfies RunDetail;
});

/** What Settings shows and can write back. No new store: `config.json` and the harness. */
export interface SettingsView {
  configPath: string;
  /** The defaults a Run uses, resolved through the config file and the fallbacks. */
  defaults: Array<{ key: string; value: string; multiline: boolean }>;
  /** Values a Run remembered for next time, `linear.team` and its kind. */
  remembered: Array<{ key: string; value: string }>;
  /** Whether the harness will work in this directory without stopping to ask. */
  trust: { cwd: string; state: string };
  /** The Desktop that shares the defaults with its Flock, where one does. */
  flock: string | null;
}

/** Every leaf of the config file as a dotted key, so a nested value still has a name. */
function flatten(raw: YamlMap, prefix = ""): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Rec.toEntries(raw)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    if (isYamlMap(value)) out.push(...flatten(value, dotted));
    else out.push({ key: dotted, value: scalar(value) });
  }
  return out;
}

/** One config value as a line of text. A nested map has no one line, so it has none. */
function scalar(value: YamlValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Arr.isArray<typeof value>(value)) return Arr.join(Arr.map(value, scalar), ", ");
  if (isYamlMap(value)) return "";
  // Serialised rather than stringified: a value the checker still reads as map-like
  // would otherwise reach Settings as "[object Object]".
  return isString(value) ? value : (JSON.stringify(value) ?? "");
}

export const buildSettings = Effect.fn("Views.buildSettings")(function* (env: PluginEnv) {
  const path = yield* Path.Path;
  const raw = yield* readConfig(env.userDir);
  const state = yield* claudeTrust(env.home, env.stateDir)
    .state(env.cwd)
    .pipe(Effect.orElseSucceed(() => "unknown" as const));

  return {
    configPath: path.join(env.userDir, "config.json"),
    // As written where it is set, so a hand-edited value that loadDefaults would
    // coerce is shown here, where it is put right.
    defaults: Arr.map(SETTINGS, ({ key, kind, fallback }) => {
      const written = configValue(raw, key);
      return {
        key,
        value: written === undefined ? fallback : scalar(written),
        multiline: kind === "json",
      };
    }),
    // Everything else the file holds: remembered answers, per-harness model lists, the
    // notification kinds someone turned off. Shown as written rather than interpreted.
    remembered: Arr.filter(flatten(raw), (entry) => settingOf(entry.key) === undefined),
    trust: { cwd: env.cwd, state },
    flock: (yield* readSettingsSet(env.userDir)).flock?.by ?? null,
  } satisfies SettingsView;
});

export const buildMachineOwn = Effect.fn("Views.buildMachineOwn")(function* (env: PluginEnv) {
  const raw = yield* readConfig(env.userDir);
  const root = configValue(raw, "projects.root");
  const chat = configValue(raw, "chat_harness");
  const found = yield* Effect.filter(Struct.keys(HARNESSES), (harness) =>
    Effect.map(onPath(env.raw["PATH"] ?? "", harness), (dir) => dir !== null),
  );
  const own: Mutable<MachineOwn> = {
    harnesses: found,
    remembered: Arr.filter(
      flatten(raw),
      ({ key }) =>
        key !== "projects.root" &&
        key !== "chat_harness" &&
        !Arr.some(
          SETTINGS,
          (setting) => key === setting.key || pipe(key, Str.startsWith(`${setting.key}.`)),
        ),
    ),
  };
  if (isString(root)) own.projectsRoot = root;
  if (isString(chat)) own.chatHarness = chat;
  return own;
});
