// WARNING: produced when the View is first shown, never at startup, or every run's outputs load at once.
import * as Arr from "effect/Array";
import { branchMovement } from "./recovery";
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
import { checkModules, readModule } from "./authoring";
import type { PluginEnv } from "./env";
import { runTitle } from "./naming";
import { REVIEW_FILE, openFindingsIn } from "./output";
import { findingsWithStatus } from "./finding-status";
import { findRun, settled } from "./runs";
import type { RunFacts, RunState } from "./runs";
import { diffTargetOf } from "./strategies";
import { isString } from "./schema";
import { took, epochMs } from "./time";
import { claudeTrust } from "./trust";
import { isYamlMap } from "./yaml";
import type { YamlMap, YamlValue } from "./yaml";
import { NO_OUTCOME } from "./workspace";
import type { RunRow } from "./workspace";
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
import { CHANGE_LINE, orderedTickets, REPO_LINE } from "./plan";
import { workSourceOf } from "./strategies";
import { readVerifications } from "./verify";
import { readMeasurements } from "./measurement";
import { finalMeasurementLine } from "./measurement-model";
import type { Measurement } from "./measurement-model";
import { readLogTail } from "./run-log";
import { readAudit, startedBy } from "./audit";
import { onPath } from "./doctor-check";
import { HARNESSES } from "./harness";
import type { MachineOwn } from "./board-model";
import { isReachKey } from "./reach";
import type { Mutable } from "effect/Types";
import { stringifyJson } from "./json";

const HISTORY = 200;

function ranFor(run: RunFacts) {
  if (!run.finished) {
    const returned: string | null = null;
    return returned;
  }
  const ms = epochMs(run.finished) - epochMs(run.created);
  if (!Number.isFinite(ms) || ms <= 0) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null = took(ms);
  return returned;
}

export const buildHistory = Effect.fn("Views.buildHistory")(function* (opts: {
  cwd: string;
  runs: ReadonlyArray<RunFacts>;
}) {
  const runs = Arr.filter(opts.runs, (r) => r.project === opts.cwd && settled(r)).slice(0, HISTORY);

  const rows: Array<RunRow> = [];
  for (const run of runs) {
    const parts: Array<string> = [run.state];
    const open = yield* openFindingsIn(run.dir);
    if (open > 0) {
      parts.push(`${open} finding(s) open`);
    }
    const duration = ranFor(run);
    if (duration) {
      parts.push(duration);
    }
    if (run.mr) {
      parts.push(run.mr);
    }
    rows.push({
      id: run.id,
      dir: run.dir,
      glyph: glyphOf(run.state),
      title: runTitle(run),
      detail: Arr.join(parts, " · "),
      at: run.finished ? epochMs(run.finished) : 0,
      target: diffTargetOf(run.settled)?.value ?? null,
      children: [],
      fixable: open > 0,
      choice: null,
      needsYou: false,
      ...NO_OUTCOME,
    });
  }
  return rows;
});

function glyphOf(state: RunState) {
  return state === "succeeded" ? "✓" : state === "failed" ? "✗" : "⚠";
}

export interface DefinitionRow {
  name: string;
  title: string;
  layer: string;
  path: string;
  inputs: Array<string>;
  problems: Array<string>;
}

// WARNING: a module that fails validation keeps its row: errors are collected per row, not aborting the view.
export const buildWorkflows = Effect.fn("Views.buildWorkflows")(function* (env: PluginEnv) {
  const saved = yield* savedModules(env);
  const described = yield* Effect.forEach(saved.entries, readModule);
  const checked = yield* checkModules(
    Arr.map(saved.entries, (one) => ({ layer: one.layer, path: one.path })),
  );
  const problemsOf = new Map(Arr.map(checked, (one) => [one.path, one.problems]));
  const workflows: Array<DefinitionRow> = Arr.map(described, (one) => ({
    name: one.id,
    title: one.title,
    layer: one.layer,
    path: one.path,
    inputs: Arr.map(one.inputs, (input) => input.name),
    problems: [...(problemsOf.get(one.path) ?? []), ...(one.broken === null ? [] : [one.broken])],
  })).sort((a, b) => pipe(a.name, Str.localeCompare(b.name)));

  return {
    workflows,
    errors: Arr.map(saved.problems, (one) => `${one.path}: ${one.message}`),
  };
});

export function truncated(panel: Panel | null | undefined) {
  return panel?._tag === "Text" && panel.truncated;
}

const REVIEW_CAP = 64 * 1024;
const OUTPUT_CAP = 8 * 1024;
const TAIL_CAP = 8 * 1024;

const capped = Effect.fn("Views.capped")(function* (file: string, cap: number) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
  if (info === null) {
    return null;
  }
  // WARNING: read to the cap, never the whole file: an agent's output can be any size.
  const text = yield* fs.stream(file, { bytesToRead: cap }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => null),
  );
  if (text === null) {
    return null;
  }
  return { _tag: "Text" as const, text, truncated: Number(info.size) > cap };
});

export const tailed = Effect.fn("Views.tailed")(function* (file: string, cap: number) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
  if (info === null) {
    return null;
  }
  const from = Math.max(0, Number(info.size) - cap);
  const text = yield* fs.stream(file, { offset: from }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  );
  // WARNING: a tail starts mid-line, so the partial first line is dropped.
  return from === 0
    ? { _tag: "Text" as const, text, truncated: false }
    : {
        _tag: "Text" as const,
        text: pipe(text, Str.slice(Option.getOrElse(pipe(text, Str.indexOf("\n")), () => -1) + 1)),
        truncated: true,
      };
});

const CHECKBOX = /^\s*[-*]\s*\[( |x|X)\]/;

export function planTicket(file: string, text: string) {
  const lines = Str.split(text, "\n");
  const heading = Str.trim(
    pipe(
      Option.getOrUndefined(Arr.findFirst(lines, (line) => pipe(line, Str.startsWith("#")))) ?? "",
      Str.replace(/^#+\s*/, ""),
    ),
  );
  const marks = Arr.flatMap(lines, (line) => Arr.ensure(CHECKBOX.exec(line)?.[1] ?? []));
  const returned: PlanTicket = {
    file,
    title: heading === "" ? file : heading,
    // WARNING: a ticket with no checkboxes is open: every() over nothing is true.
    done: marks.length > 0 && Arr.every(marks, (mark) => mark !== " "),
  };
  return returned;
}

const buildPlan = Effect.fn("Views.buildPlan")(function* (
  run: RunFacts,
  cap: number,
  finished: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* planDirOf(run);
  if (dir === null) {
    return null;
  }

  const spec =
    (yield* capped(path.join(dir, "SPEC.md"), cap)) ??
    ({ _tag: "None", reason: "this plan has no SPEC.md" } satisfies Panel);

  const issues = path.join(dir, "issues");
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".md")),
  ).sort();
  const tickets: Array<PlanTicket> = [];
  for (const file of files) {
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

const stampOf = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)).pipe(
    Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime() ?? ""}`),
    Effect.orElseSucceed(() => ""),
  );

const finishedTickets = Effect.fn("Views.finishedTickets")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
) {
  const path = yield* Path.Path;
  const finished = new Set<string>();
  const dir = yield* planDirOf(run);
  if (dir === null) {
    return finished;
  }
  const issues = path.join(dir, "issues");
  const isPlan = (other: string | null | undefined) =>
    other != null && path.resolve(other) === path.resolve(dir);
  let tickets: Array<{ file: string; text: string | null }> | undefined;
  for (const one of runs) {
    if (one.state !== "succeeded") {
      continue;
    }
    const mayShare =
      isPlan(path.join(one.dir, PLAN_DIR)) || isPlan(workSourceOf(one.settled)?.value);
    if (!mayShare || !isPlan(yield* planDirOf(one).pipe(Effect.orElseSucceed(() => null)))) {
      continue;
    }
    for (const { checkpoint } of yield* readCheckpoints(one.dir)) {
      if (checkpoint.status === "done") {
        finished.add(checkpoint.ticket);
      }
    }
    const launches = yield* readLaunches(one.id);
    if (launches.length === 0) {
      continue;
    }
    tickets ??= yield* ticketRepoLines(issues);
    const known = one.repo ? Arr.filter(tickets, (t) => t.text !== null) : tickets;
    const mine = Arr.map(
      orderedTickets(
        Arr.map(known, (t) => ({ file: t.file, text: t.text ?? "" })),
        one.repo ?? undefined,
        one.change ?? "",
      ),
      (t) => t.file,
    );
    for (const launch of launches) {
      const output = yield* writtenAt(launch.output);
      if (output === undefined) {
        continue;
      }
      if (mine.includes(launch.operation)) {
        finished.add(launch.operation);
      }
      if (launch.operation !== "build") {
        continue;
      }
      for (const file of mine) {
        const written = yield* writtenAt(path.join(issues, file));
        if (written !== undefined && written <= output) {
          finished.add(file);
        }
      }
    }
  }
  return finished;
});

const repoLines = new Map<
  string,
  { readonly stamp: string; readonly line: string | null; readonly change: string }
>();

const REPO_SCAN_CAP = 1024 * 1024;

// WARNING: an empty Repo value can run on to a later line, so an unread tail could change it.
function repoLineIn(text: string, truncated: boolean) {
  const whole = truncated
    ? pipe(text, Str.slice(0, Option.getOrElse(pipe(text, Str.lastIndexOf("\n")), () => -1) + 1))
    : text;
  const found = REPO_LINE.exec(whole);
  if (!truncated) {
    const returned: string | null = found?.[0] ?? "";
    return returned;
  }
  const returned: string | null = found && found[1] !== "" ? found[0] : null;
  return returned;
}

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
      kept = {
        stamp,
        line: read === null ? "" : repoLineIn(read.text, read.truncated),
        change: read === null ? "" : (CHANGE_LINE.exec(read.text)?.[0] ?? ""),
      };
      repoLines.set(at, kept);
    }
    tickets.push({ file, text: kept.line === null ? null : `${kept.line}\n${kept.change}` });
  }
  return tickets;
});

const writtenAt = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)).pipe(
    Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
    Effect.orElseSucceed(() => undefined),
  );

const planStamps = Effect.fn("Views.planStamps")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* planDirOf(run);
  if (dir === null) {
    return "";
  }
  const issues = path.join(dir, "issues");
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".md")),
  ).sort();
  const stamps = [`SPEC.md=${yield* stampOf(path.join(dir, "SPEC.md"))}`];
  for (const file of files) {
    stamps.push(`${file}=${yield* stampOf(path.join(issues, file))}`);
  }
  return Arr.join(stamps, "\n");
});

export type PlanCache = Map<string, { readonly stamps: string; readonly plan: PlanPanel | null }>;

// WARNING: keyed by cap too: a further page reads further into a spec that was cut short.
const plannedFor = Effect.fn("Views.plannedFor")(function* (
  run: RunFacts,
  cap: number,
  plans: PlanCache | undefined,
  runs: ReadonlyArray<RunFacts>,
) {
  const finished = yield* finishedTickets(run, runs);
  if (!plans || !settled(run)) {
    return yield* buildPlan(run, cap, finished);
  }
  const key = `${run.id}:${cap}`;
  const stamps = `${yield* planStamps(run)}\nfinished=${Arr.join([...finished].sort(), ",")}`;
  const kept = plans.get(key);
  if (kept?.stamps === stamps) {
    return kept.plan;
  }
  const plan = yield* buildPlan(run, cap, finished);
  plans.set(key, { stamps, plan });
  return plan;
});

export const NO_RUN_OUTCOME: RunDetail["outcome"] = {
  kind: null,
  gaps: [],
  obstacle: null,
  next: null,
  delivered: null,
  measurement: null,
  metrics: metricsOf([], ""),
};

function dispositionOf(line: Disposition | null) {
  if (line === null) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null = line.ref === "" ? line.kind : `${line.kind} ${line.ref}`;
  return returned;
}

const evidenceIn = Effect.fn("Views.evidenceIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kept = [];
  for (const name of (yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))).sort(
    (a, b) => pipe(a, Str.localeCompare(b)),
  )) {
    if (pipe(name, Str.endsWith(".jsonl"))) {
      continue;
    }
    const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "File") {
      kept.push({ name, bytes: Number(info.value.size) });
    }
  }
  return kept;
});

export const textsOf = Effect.fn("Views.textsOf")(function* (opts: {
  readonly env: PluginEnv;
  readonly run: RunFacts;
  readonly runs: ReadonlyArray<RunFacts>;
  readonly pages?: number;
  readonly plans?: PlanCache;
}) {
  const path = yield* Path.Path;
  const cap = REVIEW_CAP * Math.max(1, opts.pages ?? 1);
  return {
    review:
      (yield* capped(path.join(opts.run.dir, REVIEW_FILE), cap)) ??
      ({ _tag: "None", reason: `this run wrote no ${REVIEW_FILE}` } satisfies Panel),
    plan: yield* plannedFor(opts.run, cap, opts.plans, opts.runs),
  };
});

export const tailOf = Effect.fn("Views.tailOf")(function* (run: RunFacts) {
  const log = yield* readLogTail(run.dir, TAIL_CAP).pipe(Effect.orElseSucceed(() => null));
  return {
    tail: log?.panel ?? ({ _tag: "None", reason: "this run wrote no log" } satisfies Panel),
    logStart: log?.firstLine,
  };
});

export const buildRunDetail = Effect.fn("Views.buildRunDetail")(function* (opts: {
  env: PluginEnv;
  runId: string;
  runs?: ReadonlyArray<RunFacts>;
  mr: MrPanel | null;
  tail?: boolean;
  pages?: number;
  // WARNING: a Run still going is never cached: it may be writing its plan as it is read.
  plans?: PlanCache;
  flow?: Flow | null;
  parts?: boolean;
}) {
  const run =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(opts.runs), (present) =>
        Option.getOrUndefined(Arr.findFirst(present, (one) => one.id === opts.runId)),
      ),
    ) ?? (yield* findRun(opts.env, opts.runId));
  if (!run) {
    return null;
  }

  const parts = opts.parts ?? true;
  const texts = parts
    ? yield* textsOf({ ...opts, run, runs: opts.runs ?? [run] })
    : { review: { _tag: "None", reason: "" } satisfies Panel, plan: null };
  const attention = yield* attentionFor(run);
  const log = parts && opts.tail ? yield* tailOf(run) : null;
  const progress = yield* branchMovement(run);
  const detail: RunDetail = {
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
    ...texts,
    outputs: [],
    attention,
    outcome: {
      kind: run.outcome === "unspecified" ? null : run.outcome,
      gaps: [],
      obstacle: run.state === "succeeded" ? null : run.note,
      next: attention.actions[0] ?? null,
      delivered: dispositionOf(latest(yield* readDispositions(run.dir))),
      measurement:
        run.outcome === "performance"
          ? finalMeasurementLine(
              yield* readMeasurements(run.evidence).pipe(
                Effect.orElseSucceed(() => {
                  const returned: ReadonlyArray<Measurement> = [];
                  return returned;
                }),
              ),
            )
          : null,
      metrics: metricsOf(yield* readMetrics(run.evidence), run.created),
    },
    tail: log?.tail ?? null,
    logStart: log?.logStart,
    finishedAt: run.finished ? epochMs(run.finished) : 0,
    mr: opts.mr,
    findings: yield* findingsWithStatus(run.dir),
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
    agents: yield* runAgents(run.id),
    diff: parts ? yield* diffOf(run) : null,
    flow: opts.flow ?? undefined,
  };
  let shown = detail;
  if (run.narratives !== undefined) {
    shown = { ...shown, narratives: run.narratives };
  }
  if (run.park !== undefined) {
    shown = { ...shown, park: run.park };
  }
  if (run.recovery !== undefined) {
    shown = { ...shown, recovery: run.recovery };
  }
  if (progress !== null) {
    shown = { ...shown, branchProgress: progress };
  }
  return shown;
});

export interface SettingsView {
  configPath: string;
  defaults: Array<{ key: string; value: string; multiline: boolean }>;
  remembered: Array<{ key: string; value: string }>;
  trust: { cwd: string; state: string };
  flock: string | null;
}

function flatten(raw: YamlMap, prefix = "") {
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Rec.toEntries(raw)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    if (isYamlMap(value)) {
      out.push(...flatten(value, dotted));
    } else {
      out.push({ key: dotted, value: scalar(value) });
    }
  }
  const returned: Array<{ key: string; value: string }> = out;
  return returned;
}

function scalar(value: YamlValue | undefined) {
  if (value === null || value === undefined) {
    const returned: string = "";
    return returned;
  }
  if (Arr.isArray<typeof value>(value)) {
    const returned: string = Arr.join(Arr.map(value, scalar), ", ");
    return returned;
  }
  if (isYamlMap(value)) {
    const returned: string = "";
    return returned;
  }
  // WARNING: serialised with JSON, not String: a map-like value would show as [object Object].
  const returned: string = isString(value) ? value : stringifyJson(value);
  return returned;
}

export const buildSettings = Effect.fn("Views.buildSettings")(function* (env: PluginEnv) {
  const path = yield* Path.Path;
  const raw = yield* readConfig(env.userDir);
  const state = yield* claudeTrust(env.home, env.stateDir)
    .state(env.cwd)
    .pipe(Effect.orElseSucceed(() => "unknown" as const));

  const returned: SettingsView = {
    configPath: path.join(env.userDir, "config.json"),
    defaults: Arr.map(SETTINGS, ({ key, kind, fallback }) => {
      const written = configValue(raw, key);
      return {
        key,
        value: written === undefined ? fallback : scalar(written),
        multiline: kind === "json",
      };
    }),
    remembered: Arr.filter(flatten(raw), (entry) => settingOf(entry.key) === undefined),
    trust: { cwd: env.cwd, state },
    flock: (yield* readSettingsSet(env.userDir)).flock?.by ?? null,
  };
  return returned;
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
        !isReachKey(key) &&
        !Arr.some(
          SETTINGS,
          (setting) => key === setting.key || pipe(key, Str.startsWith(`${setting.key}.`)),
        ),
    ),
  };
  if (isString(root)) {
    own.projectsRoot = root;
  }
  if (isString(chat)) {
    own.chatHarness = chat;
  }
  return own;
});
