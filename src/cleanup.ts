// Cleanup (ADR-0045): one sweeper per kind of thing Collie made. A listing is every judge; a
// sweep is every judge, then each removal judged again and written to `cleanup.jsonl`.

import { Clock, Duration, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import {
  FrontDoor,
  mrLabel,
  sectionOf,
  Where,
  type Section,
  type TaskView,
  type CleanupItem,
  type CleanupKept,
  CleanupReport,
} from "./board-model";
import {
  herdrFailureReason,
  type AgentInfo,
  type AgentStatus,
  type Herdr,
  type PaneInfo,
} from "./herdr";
import { removeTask, withTaskLock, type TaskRecord } from "./task";
import { appendJournal, readJournal } from "./journal";
import { shell } from "./mr";
import type { AgentEntry } from "./registry";
import { settled, type RunFacts } from "./runs";
import { epochMs, nowIso, took } from "./time";
import {
  isDestinationLock,
  judgeWorktrees,
  onBranch,
  PRUNE_FILE,
  type Landed,
  type Settling,
} from "./worktree";
import { readForge, readMrStates } from "./merges";
import { latest, readDispositions } from "./disposition";
import { repositoryOf } from "./strategies";
import { LEDGER_FILE, ledgerPath, newestById, readLedger } from "./steering";
import { desktopVerdicts, trimUsage, type DesktopOwn } from "./desktop";
import {
  CONTROL_DIR,
  keptFor,
  putDownControl,
  readControl,
  type CompactionPorts,
} from "./compaction";
import {
  AgentSession,
  launchDir,
  LAUNCH_SUFFIX,
  readLaunches,
  sameSession,
  stemOf,
  Launched,
} from "./launches";
import { endAgent, endedLine, runLog } from "./agent-end";
import { COMPACTION_PORTS, transcriptOf } from "./compactors";
import { uploadsDir } from "./uploads";
import { finishedOnRecord } from "./cards";
import type { CheckProcessesApi, Leftover } from "./check-processes";
import { humanBytes } from "./bytes";
import { once } from "./audit";

/** One kind of thing Collie cleans. */
export interface Sweeper {
  /** What `collie cleanup` calls each of its items. */
  readonly kind: string;
  readonly judge: Effect.Effect<
    {
      remove: ReadonlyArray<CleanupItem>;
      keep: ReadonlyArray<CleanupKept>;
      /** Kept for now, but a sweep still offers each to `remove`: a stop to try again. */
      retry?: ReadonlyArray<CleanupItem>;
    },
    never,
    BunServices
  >;
  /** Removes `item` if it still should go, answering with the bytes freed or why it stays. */
  readonly remove: (
    item: CleanupItem,
  ) => Effect.Effect<{ freed: number } | { kept: string }, never, BunServices>;
}

const DAY_MS = 24 * 60 * 60_000;
const GENERATION_UNUSED_MS = 7 * DAY_MS;
const JOURNAL_KEEP_MS = 30 * DAY_MS;
const UPLOAD_KEEP_MS = 7 * DAY_MS;
export const JOURNAL = "cleanup.jsonl";

/** What each of `paths` takes on disk, links not followed; 0 where one cannot be read. */
export const sizesOf = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sizes = new Map<string, number>();
    // ponytail: one `du` per 500 paths, so a cache of 100k entries is 200 processes.
    for (let at = 0; at < paths.length; at += 500) {
      const du = yield* shell("du", ["-sk", ...paths.slice(at, at + 500)], "/");
      for (const line of du.stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab > 0) sizes.set(line.slice(tab + 1), Number.parseInt(line, 10) * 1024 || 0);
      }
    }
    return paths.map((path) => sizes.get(path) ?? 0);
  });

/** What `path` takes on disk. */
export const sizeOf = (path: string) => sizesOf([path]).pipe(Effect.map(([bytes]) => bytes ?? 0));

/** One sweep at a time in this host, whichever door or schedule asked. */
export const sweeping = Semaphore.makeUnsafe(1);

/** One line per item, then the kept, then the total. */
export const cleanupLines = (report: CleanupReport, applied: boolean) =>
  [
    ...report.remove.map((item) =>
      [
        applied ? "removed" : "would remove",
        item.kind,
        item.target,
        humanBytes(item.bytes),
        item.reason,
      ].join("\t"),
    ),
    ...report.keep.map((item) => ["kept", item.kind, item.target, item.reason].join("\t")),
    `${applied ? "freed" : "would free"}\t${humanBytes(report.bytes)}`,
  ].join("\n");

/** How long a listing or sweep may take before the host log says where its time went. */
const SLOW_CLEANUP_MS = 2_000;

/** Sweepers already in hand, or how to gather them, which is then timed too. */
type Sweepers<E, R> = ReadonlyArray<Sweeper> | Effect.Effect<ReadonlyArray<Sweeper>, E, R>;

/** `body` over the sweepers, and over 2 s in all one warning naming where the time went. */
const timedJudging = <A, E, R, F, Q>(
  what: "listing" | "sweep",
  sweepers: Sweepers<F, Q>,
  body: (
    sweepers: ReadonlyArray<Sweeper>,
    judgeOf: (sweeper: Sweeper) => Sweeper["judge"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const spent = new Map<string, number>();
    const judgeOf = (sweeper: Sweeper) =>
      Effect.timed(sweeper.judge).pipe(
        Effect.map(([duration, judged]) => {
          spent.set(sweeper.kind, (spent.get(sweeper.kind) ?? 0) + Duration.toMillis(duration));
          return judged;
        }),
      );
    let gathering: number | undefined;
    const gathered = Effect.isEffect(sweepers)
      ? Effect.timed(sweepers).pipe(
          Effect.map(([duration, all]) => {
            gathering = Duration.toMillis(duration);
            return all;
          }),
        )
      : Effect.succeed(sweepers);
    const [duration, result] = yield* Effect.timed(
      Effect.flatMap(gathered, (all) => body(all, judgeOf)),
    );
    const total = Duration.toMillis(duration);
    if (total > SLOW_CLEANUP_MS) {
      const kinds = [...spent]
        .sort(([, a], [, b]) => b - a)
        .map(([kind, ms]) => `${kind} ${ms} ms`)
        .join(", ");
      const gatheringSaid = gathering === undefined ? "" : `gathering took ${gathering} ms; `;
      yield* Effect.logWarning(
        `the cleanup ${what} took ${total} ms; ${gatheringSaid}judging took ${kinds}`,
      );
    }
    return result;
  });

/** The listing: every sweeper's judgement, and what the removable items come to. */
export const judge = <E = never, R = never>(sweepers: Sweepers<E, R>) =>
  timedJudging("listing", sweepers, (sweepers, judgeOf) =>
    Effect.gen(function* () {
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const sweeper of sweepers) {
        const judged = yield* judgeOf(sweeper);
        remove.push(...judged.remove);
        keep.push(...judged.keep);
      }
      return { remove, keep, bytes: total(remove) } satisfies CleanupReport;
    }),
  );

const total = (items: ReadonlyArray<CleanupItem>) =>
  items.reduce((sum, item) => sum + item.bytes, 0);

/** Who asked for a sweep: a front door's Actor, or the host on its own schedule. */
export const SweptBy = Schema.Union([
  Schema.Literal("host"),
  Schema.Struct({
    origin: FrontDoor,
    request: Schema.String,
    from: Schema.optionalKey(Where),
    conversation: Schema.optionalKey(Schema.String),
    said: Schema.optionalKey(Schema.String),
  }),
]);
export type SweptBy = typeof SweptBy.Type;

const JournalLine = Schema.Struct({
  at: Schema.String,
  by: SweptBy,
  kind: Schema.String,
  target: Schema.String,
  bytes: Schema.Number,
  reason: Schema.String,
});
const JournalJson = Schema.fromJsonString(JournalLine);

/** A sweep: every judge, then every removal, each journaled with who asked. */
export const sweep = <E = never, R = never>(
  sweepers: Sweepers<E, R>,
  stateDir: string,
  by: SweptBy,
) =>
  timedJudging("sweep", sweepers, (sweepers, judgeOf) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const journal = path.join(stateDir, JOURNAL);
      const removed: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const sweeper of sweepers) {
        const judged = yield* judgeOf(sweeper);
        const retried = new Set((judged.retry ?? []).map((item) => item.target));
        keep.push(...judged.keep.filter((one) => !retried.has(one.target)));
        for (const item of [...judged.remove, ...(judged.retry ?? [])]) {
          const outcome = yield* sweeper.remove(item);
          if ("kept" in outcome) {
            keep.push({ kind: item.kind, target: item.target, reason: outcome.kept });
            continue;
          }
          const gone = { ...item, bytes: outcome.freed };
          removed.push(gone);
          yield* appendJournal(journal, JournalJson, { at: yield* nowIso(), by, ...gone }).pipe(
            Effect.ignore,
          );
        }
      }
      yield* trimJournal(journal);
      return { remove: removed, keep, bytes: total(removed) } satisfies CleanupReport;
    }),
  );

/**
 * A front door's sweep, once per request: asked again, even while it runs, it answers with its
 * report. Once begun it finishes and records its report even if its caller goes away.
 */
export const sweepAsked = <E, R>(
  trail: string,
  line: Omit<Parameters<typeof once>[1], "result">,
  sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>,
  stateDir: string,
  by: SweptBy,
) =>
  sweeping.withPermit(
    Effect.uninterruptible(
      once(trail, { ...line, result: CleanupReport }, sweep(sweepers, stateDir, by)),
    ),
  );

/** Drops journal lines older than 30 days, rewriting it only when something went. */
const trimJournal = (file: string) =>
  Effect.gen(function* () {
    const lines = yield* readJournal(file, JournalJson);
    const since = (yield* Clock.currentTimeMillis) - JOURNAL_KEEP_MS;
    const kept = lines.filter((line) => epochMs(line.at) >= since);
    if (kept.length === lines.length) return;
    const fs = yield* FileSystem.FileSystem;
    const encode = Schema.encodeSync(JournalJson);
    const tmp = `${file}.${process.pid}.tmp`;
    yield* fs.writeFileString(tmp, kept.map((line) => `${encode(line)}\n`).join(""));
    yield* fs.rename(tmp, file);
  }).pipe(Effect.ignore);

/** Collie's own cache directory, `~/.cache/collie`. */
export const collieCache = () =>
  `${Bun.env.XDG_CACHE_HOME || `${Bun.env.HOME ?? Bun.env.TMPDIR ?? "/tmp"}/.cache`}/collie`;

/** Where module generations are staged, as the engine stages them. */
export const generationsDir = () => `${collieCache()}/entries/generations`;

/**
 * Staged module generations, each gone 7 days after it was last used: a cache hit touches
 * it, and one that is needed again is staged again.
 */
export const generationsSweeper = (dir: string): Sweeper => {
  const kind = "generation";
  /** How long ago `target` was last used, or null where it is gone. */
  const unusedFor = (target: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(target).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") return null;
      const used = Option.getOrNull(info.value.mtime)?.getTime() ?? 0;
      return (yield* Clock.currentTimeMillis) - used;
    });
  const days = (ms: number) => Math.floor(ms / DAY_MS);
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const name of names) {
        const target = `${dir}/${name}`;
        const unused = yield* unusedFor(target);
        if (unused === null) continue;
        if (unused < GENERATION_UNUSED_MS)
          keep.push({ kind, target, reason: `used ${days(unused)} day(s) ago` });
        else remove.push({ kind, target, bytes: 0, reason: `unused for ${days(unused)} days` });
      }
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return { remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const unused = yield* unusedFor(item.target);
        if (unused === null) return { kept: "already gone" };
        if (unused < GENERATION_UNUSED_MS) return { kept: "used again since it was judged" };
        const bytes = yield* sizeOf(item.target);
        const fs = yield* FileSystem.FileSystem;
        const gone = yield* fs.remove(item.target, { recursive: true }).pipe(Effect.result);
        return gone._tag === "Success" ? { freed: bytes } : { kept: String(gone.failure) };
      }),
  };
};

/**
 * What the settled rule reads beside the checkout: whose work has landed, by the merge
 * watch's answers or a Disposition; which branch's merge request is still open; and which
 * checkouts' Tasks still have their workspace open.
 */
export const settlingOf = (opts: {
  stateDir: string;
  runs: ReadonlyArray<RunFacts>;
  tasks: ReadonlyArray<TaskRecord>;
  sessions: ReadonlyArray<Herdr>;
  protect: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const states = yield* readMrStates(opts.stateDir);
    const forge = yield* readForge(opts.stateDir);
    const landedAt = new Map<string, Landed>();
    const landedOn = new Map<string, Landed>();
    const openOn = new Map<string, string>();
    for (const run of opts.runs) {
      const disposed = latest(
        yield* readDispositions(run.dir).pipe(Effect.orElseSucceed(() => [])),
      );
      const label = run.mr === null ? null : mrLabel(run.mr);
      const state = label === null ? undefined : states.get(label);
      const head = label === null ? null : (forge.get(label)?.head ?? null);
      // Only a merge's head is on the remote: a closed merge request's never landed.
      const heads =
        head !== null && state !== undefined && state !== "open" && state !== "closed"
          ? [head]
          : [];
      const landed: Landed | null =
        disposed !== null
          ? { why: `${disposed.kind}, as recorded`, heads }
          : state === undefined || state === "open"
            ? null
            : { why: `${state === "closed" ? "closed" : "merged"} in ${label}`, heads };
      const branch = run.branch ?? run.worktree?.branch ?? "";
      if (landed === null) {
        if (state === "open" && branch !== "" && label !== null)
          openOn.set(onBranch(run.project, branch), label);
        continue;
      }
      if (run.worktree !== null) landedAt.set(run.worktree.path, landed);
      if (branch !== "") landedOn.set(onBranch(run.project, branch), landed);
    }
    const open = new Set<string>();
    let unknown = false;
    for (const session of opts.sessions) {
      const listed = yield* session.workspaceList().pipe(Effect.option);
      if (Option.isNone(listed)) unknown = true;
      else for (const one of listed.value) open.add(one.workspaceId);
    }
    const workspaceHolds = new Map<string, string>();
    for (const run of opts.runs) {
      if (run.worktree?.created_by_collie !== true || run.task === null) continue;
      const task = opts.tasks.find((one) => one.id === run.task);
      if (task === undefined) continue;
      if (unknown)
        workspaceHolds.set(run.worktree.path, "could not ask herdr which workspaces are open");
      else if (open.has(task.workspace))
        workspaceHolds.set(run.worktree.path, "its Task's workspace is still open");
    }
    return {
      landedAt,
      landedOn,
      openOn,
      workspaceHolds,
      protect: new Set(opts.protect),
    } satisfies Settling;
  });

/** Worktrees Collie made, judged by the settled rule in `worktree.ts`. */
export const worktreesSweeper = (opts: {
  herdr: Herdr;
  sessions: ReadonlyArray<Herdr>;
  stateDir: string;
  runs: ReadonlyArray<RunFacts>;
  registered: ReadonlyArray<AgentEntry>;
  cwd: string;
  /** Read when it judges, so a workspace closed earlier in the same sweep counts as closed. */
  settling?: Effect.Effect<Settling, never, BunServices>;
}): Sweeper => {
  const kind = "worktree";
  return {
    kind,
    judge: Effect.gen(function* () {
      const settling = opts.settling === undefined ? undefined : yield* opts.settling;
      const round = yield* judgeWorktrees({ ...opts, settling, dryRun: true });
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      if (round.busy)
        keep.push({ kind, target: opts.stateDir, reason: "another sweep is judging worktrees" });
      for (const one of round.judged) {
        if (one.why !== undefined)
          remove.push({
            kind,
            target: one.path,
            bytes: yield* sizeOf(one.path),
            reason: one.why,
          });
        else keep.push({ kind, target: one.path, reason: one.keep ?? "kept" });
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const bytes = yield* sizeOf(item.target);
        const settling = opts.settling === undefined ? undefined : yield* opts.settling;
        const round = yield* judgeWorktrees({ ...opts, settling, only: item.target });
        const one = round.judged.find((judged) => judged.path === item.target);
        if (one?.removed === true) return { freed: bytes };
        return { kept: one?.keep ?? (round.busy ? "another sweep is removing it" : "gone") };
      }),
  };
};

const RECEIPT_KEEP_MS = 30 * DAY_MS;

/** Whether anything at or under `path` changed in the last day; true where it cannot tell. */
const changedToday = (path: string) =>
  shell("find", [path, "-mmin", "-1440", "-print", "-quit"], "/").pipe(
    Effect.map((found) => found.code !== 0 || found.stdout.trim() !== ""),
  );

/** What the state directory holds that is the host's own and never a sweeper's. */
const KEPT_KINDS = new Set([
  "host.db",
  "host.db-wal",
  "host.db-shm",
  "host.db-journal",
  "host.lock",
  "host.sock",
  "host.out",
  "host.out.1",
  "installation",
  "installation.new",
  PRUNE_FILE,
  JOURNAL,
  "cleanup",
  "settings",
  "tasks",
  "herd",
  "board",
  "steering",
  CONTROL_DIR,
  "compaction-locks",
  "generations",
  "renovate-repositories",
  "measurements",
  "uploads",
  "files",
  "claude.json.bak",
  "running-checks",
]);
const MARKER_KINDS = ["stop", "hold", "parked", "awaiting", "notified"];
const MARKER = new RegExp(`^(?:${MARKER_KINDS.join("|")})\\.(.+)$`);
/** Nothing reads these any more ([ADR-0027](../docs/adr/0027-one-engine-and-a-hard-cutover.md)). */
const DEAD = /^(?:events\..*\.log|plans)$/;

/**
 * The state directory's own leftovers: whatever no `collie_runs` row owns, once it has not
 * changed for a day, and CLI receipts 30 days on. An entry of a kind Collie does not know
 * is kept and said.
 */
export const stateSweeper = (stateDir: string, rows: ReadonlySet<string>): Sweeper => {
  const kind = "state";
  /** A child's files are its root Run's as well. */
  const owned = (run: string) => rows.has(run) || rows.has(run.split(".")[0] ?? run);
  /** Gone once quiet for a day, for `why`. */
  const quiet = (target: string, why: string) =>
    Effect.map(changedToday(target), (changed) =>
      changed ? { keep: "changed in the last day" } : { remove: why },
    );
  const rowless = "no Run has a row for it";

  /** What becomes of one entry, or null where it is not this sweeper's to judge. */
  const verdict = (
    target: string,
  ): Effect.Effect<{ remove: string } | { keep: string } | null, never, BunServices> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rel = target.slice(stateDir.length + 1).split("/");
      const [top = "", name = "", file] = rel;
      if (rel.length === 1) {
        if (KEPT_KINDS.has(top) || top.startsWith(`${PRUNE_FILE}.`) || isDestinationLock(top))
          return null;
        if (top === "runs" || top === "agents" || top === "evidence" || top === "requests")
          return null;
        if (top === "schedules") return { keep: "the Schedules this host fires" };
        if (top.startsWith(`${JOURNAL}.`)) return null;
        if (DEAD.test(top)) return yield* quiet(target, "nothing reads it any more");
        const marker = MARKER.exec(top)?.[1];
        if (marker !== undefined) return owned(marker) ? null : yield* quiet(target, rowless);
        return { keep: "not a kind Collie knows" };
      }
      if (top === "requests") {
        if (file === undefined) return null;
        const info = yield* fs.stat(target).pipe(Effect.option);
        if (Option.isNone(info)) return null;
        const written = Option.getOrNull(info.value.mtime)?.getTime() ?? 0;
        return (yield* Clock.currentTimeMillis) - written > RECEIPT_KEEP_MS
          ? { remove: "a receipt over 30 days old" }
          : null;
      }
      if (rel.length !== 2) return null;
      if (top === "runs" && name === ".seq")
        return yield* quiet(target, "nothing reads it any more");
      if (top === "agents") {
        if (name.endsWith(".json") || name === "deliveries.log") return null;
        const ledger = `${target}/${LEDGER_FILE}`;
        if (yield* fs.exists(ledger).pipe(Effect.orElseSucceed(() => false))) {
          const runs = yield* readJournal(ledger, LedgerRuns);
          return runs.some((line) => owned(line.run))
            ? null
            : yield* quiet(target, "a ledger of Runs none of which has a row");
        }
      }
      return owned(name) ? null : yield* quiet(target, rowless);
    });

  /** Every entry this sweeper might judge. */
  const entries = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const list = (dir: string) =>
      fs.readDirectory(dir).pipe(
        Effect.map((names) => names.map((name) => `${dir}/${name}`)),
        Effect.orElseSucceed((): Array<string> => []),
      );
    const out = yield* list(stateDir);
    for (const dir of ["runs", "agents", "evidence"])
      out.push(...(yield* list(`${stateDir}/${dir}`)));
    for (const op of yield* list(`${stateDir}/requests`)) out.push(...(yield* list(op)));
    return out;
  });

  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const target of yield* entries) {
        const judged = yield* verdict(target);
        if (judged === null) continue;
        if ("keep" in judged) keep.push({ kind, target, reason: judged.keep });
        else remove.push({ kind, target, bytes: 0, reason: judged.remove });
      }
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return { remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

/** Uploads not asked for in a week: a Run given one holds its own copy (ADR-0046). */
export const uploadsSweeper = (stateDir: string): Sweeper => {
  const kind = "upload";
  const root = uploadsDir(stateDir);
  const verdict = (target: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(target).pipe(Effect.option);
      const at = Option.getOrNull(Option.flatMap(info, (one) => one.mtime));
      if (at === null) return null;
      return (yield* Clock.currentTimeMillis) - at.getTime() > UPLOAD_KEEP_MS
        ? { remove: "not asked for in a week" }
        : null;
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const remove: CleanupItem[] = [];
      for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
        if (!/^[0-9a-f]{64}$/.test(name)) continue;
        const target = `${root}/${name}`;
        const judged = yield* verdict(target);
        if (judged !== null)
          remove.push({ kind, target, bytes: yield* sizeOf(target), reason: judged.remove });
      }
      return { remove, keep: [] };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

const LedgerRuns = Schema.fromJsonString(Schema.Struct({ run: Schema.String }));

/** Removes `target` where `verdict`, asked now, still says it goes. */
const removeIf = (
  target: string,
  verdict: Effect.Effect<{ remove: string } | { keep: string } | null, never, BunServices>,
) =>
  Effect.gen(function* () {
    const now = yield* verdict;
    if (now === null) return { kept: "nothing to remove any more" };
    if ("keep" in now) return { kept: now.keep };
    const bytes = yield* sizeOf(target);
    const fs = yield* FileSystem.FileSystem;
    const gone = yield* fs.remove(target, { recursive: true }).pipe(Effect.result);
    return gone._tag === "Success" ? { freed: bytes } : { kept: String(gone.failure) };
  });

/**
 * Compaction controls of agents no herdr session lists: their server stopped and their
 * state removed, or kept with why while it is not Quiet, to be stopped again next sweep.
 * Nothing is judged where herdr will not list its agents.
 */
export const compactionSweeper = (
  stateDir: string,
  sessions: ReadonlyArray<Herdr>,
  ports: CompactionPorts = COMPACTION_PORTS,
  stopMs?: number,
): Sweeper => {
  const kind = "compaction";
  const root = `${stateDir}/${CONTROL_DIR}`;
  /** Every agent any session lists, or null where one would not say. */
  const listed = Effect.gen(function* () {
    const names = new Set<string>();
    for (const session of sessions) {
      const agents = yield* session.agentList().pipe(Effect.option);
      if (Option.isNone(agents)) return null;
      for (const agent of agents.value) names.add(agent.name);
    }
    return names;
  });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const live = yield* listed;
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      const retry: CleanupItem[] = [];
      for (const name of names) {
        const target = `${root}/${name}`;
        if (live === null) keep.push({ kind, target, reason: "could not ask herdr what is live" });
        else if (!live.has(name)) {
          const record = yield* readControl(stateDir, name).pipe(Effect.orElseSucceed(() => null));
          const kept = record === null ? null : yield* keptFor(record);
          if (kept !== null) {
            keep.push({ kind, target, reason: kept });
            retry.push({ kind, target, bytes: 0, reason: kept });
          } else remove.push({ kind, target, bytes: 0, reason: "herdr no longer lists its agent" });
        }
      }
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return {
        remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })),
        keep,
        retry,
      };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const live = yield* listed;
        const name = item.target.slice(root.length + 1);
        if (live === null) return { kept: "could not ask herdr what is live" };
        if (live.has(name)) return { kept: "herdr lists its agent again" };
        const bytes = yield* sizeOf(item.target);
        const kept = yield* putDownControl(
          { stateDir, ports, stopMs, log: () => Effect.void },
          name,
          Effect.map(listed, (now) => now === null || now.has(name)),
        ).pipe(Effect.orElseSucceed(() => "its controls are in use"));
        return kept === null ? { freed: bytes } : { kept };
      }),
  };
};

/** Runner copies under `~/.cache/collie/runners`, but the running version's and the newest. */
export const runnersSweeper = (dir: string, running: string): Sweeper => {
  const kind = "runner";
  const versionOf = (name: string) => /^collie-(.+)$/.exec(name)?.[1] ?? null;
  const verdicts = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))).filter(
      (name) => Bun.semver.satisfies(versionOf(name) ?? "", "*"),
    );
    const versions = names.map((name) => versionOf(name)!);
    const newest = versions.reduce<string | null>(
      (best, v) => (best === null || Bun.semver.order(v, best) > 0 ? v : best),
      null,
    );
    return names.map((name) => {
      const version = versionOf(name)!;
      const target = `${dir}/${name}`;
      return version === running
        ? { target, keep: "the running version" }
        : version === newest
          ? { target, keep: "the newest" }
          : { target, remove: "neither the running version nor the newest" };
    });
  });
  return {
    kind,
    judge: Effect.gen(function* () {
      const all = yield* verdicts;
      const remove = all.flatMap((one) =>
        "remove" in one ? [{ kind, target: one.target, bytes: 0, reason: one.remove! }] : [],
      );
      const keep = all.flatMap((one) =>
        "keep" in one ? [{ kind, target: one.target, reason: one.keep! }] : [],
      );
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return { remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) =>
      removeIf(
        item.target,
        Effect.map(verdicts, (all) => {
          const one = all.find((each) => each.target === item.target);
          return one === undefined
            ? null
            : "remove" in one
              ? { remove: one.remove! }
              : { keep: one.keep! };
        }),
      ),
  };
};

const FINISHED_GRACE_MS = 60 * 60_000;
const SECTION_SAID: Record<Section, string> = {
  "needs-you": "needs you",
  waiting: "waiting on you",
  working: "working",
  finished: "Finished",
};

const LaunchedPane = Schema.fromJsonString(
  Schema.Struct({
    terminalId: Schema.optionalKey(Schema.String),
    agentSession: Schema.optionalKey(AgentSession),
  }),
);

/** What proves a pane is one of some Runs' agents, from their launch records. */
export interface LaunchedPanes {
  readonly terminals: ReadonlySet<string>;
  readonly sessions: ReadonlyArray<AgentSession>;
}

/** The terminal and the harness session of every agent `runs` launched. */
export const launchedPanes = (stateDir: string, runs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const terminals = new Set<string>();
    const sessions: AgentSession[] = [];
    for (const run of runs) {
      const dir = `${stateDir}/agents/${run}`;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names.filter((one) => one.endsWith(".launch.json"))) {
        const text = yield* fs
          .readFileString(`${dir}/${name}`)
          .pipe(Effect.orElseSucceed(() => ""));
        const launched = Schema.decodeUnknownOption(LaunchedPane)(text);
        if (Option.isNone(launched)) continue;
        if (launched.value.terminalId !== undefined) terminals.add(launched.value.terminalId);
        if (launched.value.agentSession !== undefined) sessions.push(launched.value.agentSession);
      }
    }
    return { terminals, sessions } satisfies LaunchedPanes;
  });

/** A pane is a launched agent by its terminal, or by the harness session herdr restored in it. */
export const isLaunched = (
  launched: LaunchedPanes,
  pane: Pick<PaneInfo, "terminalId" | "agentSession">,
) =>
  (pane.terminalId !== null && launched.terminals.has(pane.terminalId)) ||
  launched.sessions.some((session) => sameSession(session, pane.agentSession));

export const paneNotOwned = (
  task: Pick<TaskRecord, "workspace" | "root_pane">,
  panes: ReadonlyArray<PaneInfo>,
  launched: LaunchedPanes,
) =>
  panes.find(
    (pane) =>
      pane.workspaceId === task.workspace &&
      pane.paneId !== task.root_pane &&
      !isLaunched(launched, pane),
  );

/**
 * Task workspaces, each closed an hour after its Task became Finished, unless herdr has it in
 * focus or it holds a pane Collie did not open (ADR-0045 D3). `seen` is when each Task was
 * first seen Finished, kept by the host across sweeps; a host restart only delays a close.
 */
export const taskWorkspacesSweeper = (opts: {
  stateDir: string;
  sessions: ReadonlyArray<{ readonly herd: string | null; readonly herdr: Herdr }>;
  tasks: ReadonlyArray<TaskRecord>;
  views: ReadonlyArray<TaskView>;
  runs: ReadonlyArray<RunFacts>;
  seen: Map<string, number>;
  ports?: CompactionPorts;
  stopMs?: number;
}): Sweeper => {
  const kind = "workspace";
  /** Each agent a Task's Runs launched, as its latest launch recorded it. */
  const launchesOf = (task: TaskRecord) =>
    Effect.forEach(
      opts.runs.filter((run) => run.task === task.id),
      (run) => readLaunches(opts.stateDir, run.id),
    ).pipe(Effect.map((all) => [...new Map(all.flat().map((one) => [one.agent, one])).values()]));
  const agentsOf = (task: TaskRecord) =>
    Effect.map(launchesOf(task), (all) => all.map((one) => one.agent));
  /** Why one of them may still be writing after an earlier stop, or null. */
  const stillWriting = (task: TaskRecord) =>
    Effect.gen(function* () {
      for (const agent of yield* agentsOf(task)) {
        const record = yield* readControl(opts.stateDir, agent).pipe(
          Effect.orElseSucceed(() => null),
        );
        const kept = record === null ? null : yield* keptFor(record);
        if (kept !== null) return kept;
      }
      return null;
    });
  const named = new Map<string, number>();
  for (const task of opts.tasks) named.set(task.workspace, (named.get(task.workspace) ?? 0) + 1);

  /** The session a Task's workspace is in: its recorded Herd's, else this host's own. */
  const sessionOf = (task: TaskRecord) =>
    task.herd === undefined || task.herd === null
      ? opts.sessions[0]
      : opts.sessions.find((one) => one.herd === task.herd);

  /** What becomes of one Task's workspace now, or null where it has none open to close. */
  const verdict = (
    task: TaskRecord,
  ): Effect.Effect<
    | { keep: string }
    | {
        remove: string;
        launched: LaunchedPanes;
        panes: ReadonlyArray<PaneInfo>;
        writing: string | null;
      }
    | null,
    never,
    BunServices
  > =>
    Effect.gen(function* () {
      const session = sessionOf(task);
      if (session === undefined) return null;
      const view = opts.views.find((one) => one.id === task.id);
      if (view === undefined) return null;
      const now = yield* Clock.currentTimeMillis;
      const section = sectionOf(view);
      if (section !== "finished") {
        opts.seen.delete(task.id);
        return { keep: SECTION_SAID[section] };
      }
      const since = opts.seen.get(task.id) ?? now;
      opts.seen.set(task.id, since);
      const workspaces = yield* session.herdr.workspaceList().pipe(Effect.option);
      const panes = yield* session.herdr.paneList().pipe(Effect.option);
      if (Option.isNone(workspaces) || Option.isNone(panes))
        return { keep: "could not ask herdr what is open" };
      const open = workspaces.value.find((one) => one.workspaceId === task.workspace);
      if (open === undefined) return null;
      if ((named.get(task.workspace) ?? 0) > 1) return { keep: "another Task names it too" };
      if ("collie_home" in open.tokens) return { keep: "it is the Home" };
      const minutes = Math.floor((now - since) / 60_000);
      if (now - since < FINISHED_GRACE_MS) return { keep: `Finished ${minutes} min ago` };
      if (open.focused) return { keep: "in focus" };
      const launched = yield* launchedPanes(
        opts.stateDir,
        opts.runs.filter((run) => run.task === task.id).map((run) => run.id),
      );
      const foreign = paneNotOwned(task, panes.value, launched);
      if (foreign !== undefined)
        return { keep: `holds a pane Collie did not open (${foreign.paneId})` };
      // Kept in a listing, while a sweep stops it again.
      const writing = yield* stillWriting(task);
      return { remove: `Finished ${minutes} min ago`, launched, panes: panes.value, writing };
    });

  const taskAt = (target: string) => opts.tasks.find((task) => task.workspace === target);

  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      const retry: CleanupItem[] = [];
      for (const task of opts.tasks) {
        const judged = yield* verdict(task);
        if (judged === null) continue;
        if ("keep" in judged) keep.push({ kind, target: task.workspace, reason: judged.keep });
        else if (judged.writing !== null) {
          keep.push({ kind, target: task.workspace, reason: judged.writing });
          retry.push({ kind, target: task.workspace, bytes: 0, reason: judged.writing });
        } else remove.push({ kind, target: task.workspace, bytes: 0, reason: judged.remove });
      }
      return { remove, keep, retry };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const task = taskAt(item.target);
        const session = task === undefined ? undefined : sessionOf(task);
        if (task === undefined || session === undefined)
          return { kept: "no Task names it any more" };
        const judged = yield* verdict(task);
        if (judged === null) return { kept: "already closed" };
        if ("keep" in judged) return { kept: judged.keep };
        // Every agent ends where its work runs before any pane of theirs closes.
        const launches = yield* launchesOf(task);
        const listed = yield* session.herdr.agentList().pipe(Effect.option);
        if (Option.isNone(listed)) return { kept: "could not ask herdr what is open" };
        const inside = new Set(
          judged.panes
            .filter((pane) => pane.workspaceId === task.workspace)
            .map((pane) => pane.paneId),
        );
        const stranger = listed.value.find(
          (agent) =>
            inside.has(agent.paneId) &&
            !launches.some(
              (one) =>
                (one.agent === agent.name && one.terminalId === agent.terminalId) ||
                sameSession(one.agentSession, agent.agentSession),
            ),
        );
        if (stranger !== undefined)
          return { kept: `${stranger.name} runs in it, and is not this Task's` };
        const why = "its Task's workspace closed";
        const ended: Array<(typeof launches)[number]> = [];
        for (const launched of launches) {
          const end = yield* endAgent(
            {
              herdr: session.herdr,
              ports: opts.ports ?? COMPACTION_PORTS,
              stateDir: opts.stateDir,
              cwd: task.cwd,
              stopMs: opts.stopMs,
              log: runLog(opts.stateDir, launched.runId),
            },
            launched,
            why,
            "caller",
            listed.value,
          ).pipe(Effect.orElseSucceed(() => null));
          if (end === null) return { kept: "could not ask herdr what is open" };
          if (end._tag === "Unprovable" || end._tag === "Replaced") return { kept: end.reason };
          if (end._tag === "NotQuiet")
            return {
              kept:
                end.locked === undefined
                  ? `its Codex turn has not stopped: ${end.reason}`
                  : "its agents' controls are in use",
            };
          if (end.ended) ended.push(launched);
        }
        const closed = yield* session.herdr.workspaceClose(task.workspace).pipe(Effect.result);
        if (closed._tag === "Failure") return { kept: herdrFailureReason(closed.failure) };
        // Its agents left in another workspace go with it, matched as a stop does.
        const gone = new Set<string>();
        for (const other of opts.sessions) {
          const panes = yield* other.herdr.paneList().pipe(Effect.orElseSucceed(() => []));
          for (const pane of panes)
            if (pane.terminalId !== null && isLaunched(judged.launched, pane)) {
              const shut = yield* other.herdr.paneClose(pane.paneId).pipe(Effect.result);
              if (shut._tag === "Success") gone.add(pane.terminalId);
            }
        }
        for (const { agent, runId, terminalId } of ended) {
          const at = listed.value.find((one) => one.name === agent);
          if (at === undefined || inside.has(at.paneId) || gone.has(terminalId ?? ""))
            yield* runLog(opts.stateDir, runId)(endedLine(agent, why)).pipe(Effect.ignore);
        }
        return { freed: 0 };
      }),
  };
};

/** When this host first saw each agent `idle` or `done` without a break since, by terminal. */
export type IdleSince = Map<string, number>;

const IDLE: ReadonlySet<string | null> = new Set<AgentStatus>(["idle", "done"]);

/** When this host first saw each Run finished, for a Run that records no finish of its own. */
export type FinishedSince = Map<string, number>;

/** Notes what herdr says of `agents`: any status but idle or done clears its time. */
export const noteIdle = (
  idle: IdleSince,
  agents: ReadonlyArray<{ terminalId: string | null; status: string | null }>,
  now: number,
) => {
  for (const { terminalId, status } of agents) {
    if (terminalId === null) continue;
    if (!IDLE.has(status)) idle.delete(terminalId);
    else if (!idle.has(terminalId)) idle.set(terminalId, now);
  }
};

/** Clears the time of every terminal herdr no longer has. */
export const forgetGone = (idle: IdleSince, terminals: ReadonlySet<string>) => {
  for (const key of idle.keys()) if (!terminals.has(key)) idle.delete(key);
};

const FINISHED: ReadonlySet<RunFacts["state"]> = new Set(["succeeded", "failed", "stopped"]);

/** An agent herdr has now: a named one, or a pane it restored without the name. */
interface Live {
  readonly name: string | null;
  readonly paneId: string;
  readonly workspaceId: string | null;
  readonly terminalId: string | null;
  readonly agentSession: AgentSession | null;
  readonly status: string | null;
}

const LaunchedJson = Schema.fromJsonString(Launched);
const QUEUED: ReadonlySet<string> = new Set(["reserved", "deferred"]);

/**
 * A finished Run's agents, each closed once herdr has reported it idle for `idleCloseMs`
 * since the Run finished, unless something still needs it
 * (ADR-draft-a-finished-runs-idle-agent-is-closed).
 */
export const idleAgentsSweeper = (opts: {
  stateDir: string;
  sessions: ReadonlyArray<{ readonly herd: string | null; readonly herdr: Herdr }>;
  runs: ReadonlyArray<RunFacts>;
  idle: IdleSince;
  finishedSince: FinishedSince;
  /** 0 closes nothing. */
  idleCloseMs: number;
  ports?: CompactionPorts;
  stopMs?: number;
}): Sweeper => {
  const kind = "idle-agent";
  const targetOf = (agent: string, runId: string) => `${agent} of ${runId}`;
  const minutes = (ms: number) => Math.floor(ms / 60_000);

  /**
   * Each agent a finished Run launched that herdr has on its recorded terminal, or in a
   * pane resuming its recorded harness session, and nothing a live Run names.
   */
  const candidates = Effect.gen(function* () {
    const sessions: AgentSession[] = [];
    const live = { terminals: new Set<string>(), sessions };
    const named: Array<{ run: RunFacts; launched: Launched }> = [];
    const going: Launched[] = [];
    const now = yield* Clock.currentTimeMillis;
    for (const run of opts.runs)
      if (!FINISHED.has(run.state)) opts.finishedSince.delete(run.id);
      else if (!opts.finishedSince.has(run.id)) opts.finishedSince.set(run.id, now);
    for (const run of opts.runs)
      for (const launched of yield* readLaunches(opts.stateDir, run.id)) {
        if (FINISHED.has(run.state)) named.push({ run, launched });
        else {
          going.push(launched);
          if (launched.terminalId !== undefined) live.terminals.add(launched.terminalId);
          if (launched.agentSession !== undefined) sessions.push(launched.agentSession);
        }
      }
    const listings = yield* Effect.forEach(opts.sessions, (session) =>
      Effect.all({
        agents: Effect.option(session.herdr.agentList()),
        panes: Effect.option(session.herdr.paneList()),
      }).pipe(
        Effect.map(({ agents, panes }) => {
          const named = Option.getOrElse(agents, (): ReadonlyArray<AgentInfo> => []);
          // A pane no named agent stands for: a restored one that lost its name.
          const unnamed = Option.getOrElse(panes, (): ReadonlyArray<PaneInfo> => []).filter(
            (pane) => !named.some((agent) => agent.paneId === pane.paneId),
          );
          return {
            session,
            live: [
              ...named.map((agent): Live => ({ ...agent, status: agent.status })),
              ...unnamed.map((pane): Live => ({
                ...pane,
                name: null,
                status: pane.agentStatus ?? null,
              })),
            ],
            listed: Option.isSome(agents) && Option.isSome(panes),
          };
        }),
      ),
    );
    const seen = listings.flatMap((one) => one.live);
    /** The agent herdr has on `launched`'s own terminal, whose session is recorded. */
    const onOwnTerminal = (launched: Launched, here: ReadonlyArray<Live>) =>
      Effect.gen(function* () {
        const own = here.find(
          (one) =>
            one.name === launched.agent &&
            one.terminalId !== null &&
            one.terminalId === launched.terminalId,
        );
        if (own !== undefined && !sameSession(own.agentSession, launched.agentSession))
          yield* recordSession(launched, own.agentSession);
        return own;
      });
    for (const launched of going) {
      const own = yield* onOwnTerminal(launched, seen);
      if (own?.agentSession != null) sessions.push(own.agentSession);
    }
    noteIdle(opts.idle, seen, now);
    if (listings.every((one) => one.listed))
      forgetGone(opts.idle, new Set(seen.flatMap((one) => one.terminalId ?? [])));

    const found: Array<{
      run: RunFacts;
      launched: Launched;
      at: Live & { terminalId: string };
      session: (typeof opts.sessions)[number];
    }> = [];
    for (const { run, launched } of named)
      for (const { session, live: here } of listings) {
        const own = yield* onOwnTerminal(launched, here);
        const at = own ?? here.find((one) => sameSession(one.agentSession, launched.agentSession));
        if (at === undefined || at.terminalId === null) continue;
        const terminalId = at.terminalId;
        if (isLaunched(live, { terminalId, agentSession: launched.agentSession ?? null })) continue;
        if (found.some((one) => one.at.terminalId === terminalId)) continue;
        found.push({ run, launched, at: { ...at, terminalId }, session });
      }
    return found;
  });

  /**
   * Records the session herdr reports for an agent still on its launch's terminal, so a
   * pane herdr restores later is proved by it.
   */
  const recordSession = (launched: Launched, agentSession: AgentSession | null) =>
    Effect.gen(function* () {
      if (agentSession === null) return;
      const fs = yield* FileSystem.FileSystem;
      const file = `${launchDir(opts.stateDir, launched.runId)}/${stemOf(launched)}${LAUNCH_SUFFIX}`;
      const now = yield* Schema.decodeUnknownEffect(LaunchedJson)(yield* fs.readFileString(file));
      if (now.terminalId !== launched.terminalId) return;
      yield* fs.writeFileString(
        file,
        yield* Schema.encodeEffect(LaunchedJson)({ ...now, agentSession }),
      );
    }).pipe(Effect.ignore);

  /**
   * The newest of the Run's final card, its stop, and when this host first saw it finished:
   * a Run that resumed and ended again between sweeps counts from that end.
   */
  const lastFinished = (run: RunFacts, now: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const card = yield* finishedOnRecord(run.dir).pipe(Effect.orElseSucceed(() => null));
      // engine.ts's `controlPath(dir, STOP, runId)`.
      const stop = yield* fs.stat(`${opts.stateDir}/stop.${run.id}`).pipe(
        Effect.map((info) => Option.getOrNull(info.mtime)?.getTime() ?? null),
        Effect.orElseSucceed(() => null),
      );
      return Math.max(
        opts.finishedSince.get(run.id) ?? now,
        card === null ? 0 : epochMs(card),
        stop ?? 0,
      );
    });

  type Candidate = Effect.Success<typeof candidates>[number];

  /** Why `one` stays, or how long it has been idle since its Run finished. */
  const verdict = (
    one: Candidate,
  ): Effect.Effect<{ keep: string } | { idleFor: number }, never, BunServices> =>
    Effect.gen(function* () {
      if (!IDLE.has(one.at.status)) return { keep: one.at.status ?? "unknown" };
      const now = yield* Clock.currentTimeMillis;
      const since = opts.idle.get(one.at.terminalId) ?? now;
      const finished =
        one.run.finished === null ? yield* lastFinished(one.run, now) : epochMs(one.run.finished);
      const idleFor = now - Math.max(since, finished);
      if (idleFor < opts.idleCloseMs)
        return { keep: `idle ${minutes(idleFor)} of ${minutes(opts.idleCloseMs)} min` };
      const ledger = yield* readLedger(yield* ledgerPath(opts.stateDir, one.at.terminalId)).pipe(
        Effect.orElseSucceed(() => []),
      );
      if ([...newestById(ledger).values()].some((delivery) => QUEUED.has(delivery.state)))
        return { keep: "a Delivery to it is queued" };
      const stems = (yield* readLaunches(opts.stateDir, one.run.id))
        .filter((launched) => launched.agent === one.launched.agent)
        .map((launched) => `ask-${stemOf(launched)}-`);
      if (one.run.asking.some((asked) => stems.some((stem) => asked.name.startsWith(stem))))
        return { keep: "a question it asked is open" };
      const workspaces = yield* one.session.herdr.workspaceList().pipe(Effect.option);
      const panes = yield* one.session.herdr.paneList().pipe(Effect.option);
      if (Option.isNone(workspaces) || Option.isNone(panes))
        return { keep: "could not ask herdr what is open" };
      const workspace =
        one.at.workspaceId ??
        panes.value.find((pane) => pane.paneId === one.at.paneId)?.workspaceId;
      if (workspaces.value.some((at) => at.workspaceId === workspace && at.focused))
        return { keep: "in focus" };
      if (
        ledger.some(
          (line) => "kind" in line && line.kind === "manual_override" && epochMs(line.at) >= since,
        )
      )
        return { keep: "typed into since it went idle" };
      return { idleFor };
    });

  return {
    kind,
    judge: Effect.gen(function* () {
      // Run even when closing is off: it records the sessions herdr reports.
      const found = yield* candidates;
      if (opts.idleCloseMs <= 0) return { remove: [], keep: [] };
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const one of found) {
        const target = targetOf(one.launched.agent, one.run.id);
        const judged = yield* verdict(one);
        if ("keep" in judged) keep.push({ kind, target, reason: judged.keep });
        else
          remove.push({
            kind,
            target,
            bytes: 0,
            reason: `idle for ${minutes(judged.idleFor)} min`,
          });
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        if (opts.idleCloseMs <= 0) return { kept: "idle agents are never closed" };
        const one = (yield* candidates).find(
          (candidate) => targetOf(candidate.launched.agent, candidate.run.id) === item.target,
        );
        if (one === undefined) return { kept: "already gone" };
        const judged = yield* verdict(one);
        if ("keep" in judged) return { kept: judged.keep };
        // Read before the end, which lets the record be put down.
        const transcript = yield* transcriptOf(opts.stateDir, one.launched.agent);
        const why = `idle for ${minutes(judged.idleFor)} min; ${
          transcript === null
            ? "its harness reported no transcript"
            : `its transcript is at ${transcript}`
        }`;
        const ended = yield* endAgent(
          {
            herdr: one.session.herdr,
            ports: opts.ports ?? COMPACTION_PORTS,
            stateDir: opts.stateDir,
            cwd: one.run.cwd,
            stopMs: opts.stopMs,
            log: runLog(opts.stateDir, one.run.id),
          },
          one.launched,
          why,
          "close",
        ).pipe(
          Effect.catchTags({
            AgentsUnlisted: () => Effect.succeed({ kept: "could not ask herdr what is open" }),
            PaneOpen: (failure) => Effect.succeed({ kept: herdrFailureReason(failure.cause) }),
          }),
        );
        if ("kept" in ended) return ended;
        if (ended._tag === "Closed") return ended.ended ? { freed: 0 } : { kept: "already gone" };
        return { kept: ended.reason };
      }),
  };
};

/**
 * Renovate's clones in the state directory, each removed once no Run with a row cut a
 * checkout from it and no checkout cut from it is left on disk.
 */
export const renovateClonesSweeper = (stateDir: string, runs: ReadonlyArray<RunFacts>): Sweeper => {
  const kind = "renovate-clone";
  const root = `${stateDir}/renovate-repositories`;
  const used = new Set(
    runs.flatMap((run) => {
      const repository = repositoryOf(run.settled)?.value ?? "";
      return repository === "" ? [] : [Bun.hash(repository).toString(16)];
    }),
  );
  const verdict = (
    target: string,
  ): Effect.Effect<{ remove: string } | { keep: string } | null, never, BunServices> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) return null;
      if (used.has(target.slice(root.length + 1)))
        return { keep: "a Run with a row cut a checkout from it" };
      const listed = yield* shell("git", ["worktree", "list", "--porcelain"], target);
      if (listed.code !== 0) return { keep: "git could not list its checkouts" };
      const checkouts = listed.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((path) => path !== target);
      for (const path of checkouts)
        if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => true)))
          return { keep: `a checkout cut from it is still on disk (${path})` };
      return { remove: "no Run uses it and no checkout of it is left" };
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const name of names) {
        const target = `${root}/${name}`;
        const judged = yield* verdict(target);
        if (judged === null) continue;
        if ("keep" in judged) keep.push({ kind, target, reason: judged.keep });
        else remove.push({ kind, target, bytes: 0, reason: judged.remove });
      }
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return { remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

/**
 * The base trees a Run's Measurements were taken on, each removed with git's record of it
 * once its Run has ended or has no row.
 */
export const measurementTreesSweeper = (
  stateDir: string,
  runs: ReadonlyArray<RunFacts>,
): Sweeper => {
  const kind = "measurement-tree";
  const root = `${stateDir}/measurements/trees`;
  const live = new Set(runs.filter((run) => !settled(run)).map((run) => run.id));
  const verdict = (
    target: string,
  ): Effect.Effect<{ remove: string } | { keep: string } | null, never, BunServices> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) return null;
      const run = target.slice(root.length + 1).split("/")[0] ?? "";
      return live.has(run)
        ? { keep: `${run} may measure on it again` }
        : { remove: `${run} has ended, so nothing measures on it` };
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const run of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [])))
        for (const tree of yield* fs
          .readDirectory(`${root}/${run}`)
          .pipe(Effect.orElseSucceed(() => []))) {
          const target = `${root}/${run}/${tree}`;
          const judged = yield* verdict(target);
          if (judged === null) continue;
          if ("keep" in judged) keep.push({ kind, target, reason: judged.keep });
          else remove.push({ kind, target, bytes: 0, reason: judged.remove });
        }
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return { remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const common = yield* shell(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          item.target,
        );
        const freed = yield* removeIf(item.target, verdict(item.target));
        if (common.code === 0)
          yield* shell("git", ["--git-dir", common.stdout.trim(), "worktree", "prune"], "/");
        const parent = item.target.slice(0, item.target.lastIndexOf("/"));
        if ((yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => ["?"]))).length === 0)
          yield* fs.remove(parent, { recursive: true }).pipe(Effect.ignore);
        return freed;
      }),
  };
};

const RETAIN_MS = 30 * DAY_MS;

/** What retention judges a Task against, read again before each removal. */
export interface RetentionFacts {
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly views: ReadonlyArray<TaskView>;
  readonly runs: ReadonlyArray<RunFacts>;
}

/**
 * Tasks, each forgotten with every one of its Runs once nothing can need them and its last
 * Run ended 30 days ago (ADR-0045 D5): the rows in one transaction through `retire`, then
 * the files, which a failure between leaves for the state sweeper's no-row rule.
 */
export const retentionSweeper = (opts: {
  stateDir: string;
  sessions: ReadonlyArray<Herdr>;
  /** Read for every judgement, so a Run started since the last one is seen. */
  facts: Effect.Effect<RetentionFacts, never, BunServices>;
  retire: (runs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, never, BunServices>;
}): Sweeper => {
  const kind = "task";
  const filesOf = (ids: ReadonlyArray<string>) =>
    ids.flatMap((id) =>
      ["runs", "agents", "evidence"].map((dir) => `${opts.stateDir}/${dir}/${id}`),
    );

  /** When its last Run ended: the board's own reading, else the newest of its files. */
  const endedAt = (view: TaskView, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (view.ended !== null) return view.ended;
      const fs = yield* FileSystem.FileSystem;
      let newest = 0;
      for (const dir of filesOf(ids)) {
        const names = yield* fs
          .readDirectory(dir, { recursive: true })
          .pipe(Effect.orElseSucceed(() => []));
        for (const path of [dir, ...names.map((name) => `${dir}/${name}`)]) {
          const info = yield* fs.stat(path).pipe(Effect.option);
          if (Option.isSome(info))
            newest = Math.max(newest, Option.getOrNull(info.value.mtime)?.getTime() ?? 0);
        }
      }
      // No time to go by: as good as just ended, so nothing is forgotten on a guess.
      return newest === 0 ? yield* Clock.currentTimeMillis : newest;
    });

  /** Every session's workspaces and panes, or null where one could not be asked. */
  const openNow = Effect.gen(function* () {
    const workspaces: string[] = [];
    const panes: PaneInfo[] = [];
    for (const session of opts.sessions) {
      const listed = yield* session.workspaceList().pipe(Effect.option);
      const listedPanes = yield* session.paneList().pipe(Effect.option);
      if (Option.isNone(listed) || Option.isNone(listedPanes)) return null;
      workspaces.push(...listed.value.map((one) => one.workspaceId));
      panes.push(...listedPanes.value);
    }
    return { workspaces, panes };
  });

  const verdict = (
    task: TaskRecord,
    facts: RetentionFacts,
    open: typeof openNow,
  ): Effect.Effect<
    { keep: string } | { remove: string; ids: ReadonlyArray<string> } | null,
    never,
    BunServices
  > =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const view = facts.views.find((one) => one.id === task.id);
      if (view === undefined) return null;
      const section = sectionOf(view);
      if (section !== "finished") return { keep: SECTION_SAID[section] };
      const seen = yield* open;
      if (seen === null) return { keep: "could not ask herdr what is open" };
      if (seen.workspaces.includes(task.workspace)) return { keep: "its workspace is open" };
      const mine = facts.runs.filter((run) => run.task === task.id);
      const ids = mine.map((run) => run.id);
      const launched = yield* launchedPanes(opts.stateDir, ids);
      if (seen.panes.some((pane) => isLaunched(launched, pane)))
        return { keep: "an agent of it is alive" };
      for (const run of mine)
        if (
          run.worktree?.created_by_collie === true &&
          (yield* fs.exists(run.worktree.path).pipe(Effect.orElseSucceed(() => true)))
        )
          return { keep: `a checkout it made is on disk (${run.worktree.path})` };
      const dirs = ids.map((id) => `${opts.stateDir}/runs/${id}`);
      const pointing = facts.runs.find(
        (run) =>
          run.task !== task.id &&
          ((run.parent !== null && ids.includes(run.parent)) ||
            Object.values(run.settled.inputs).some((value) =>
              dirs.some((dir) => value === dir || value.startsWith(`${dir}/`)),
            )),
      );
      if (pointing !== undefined) return { keep: `${pointing.id} still points into it` };
      const since = (yield* Clock.currentTimeMillis) - (yield* endedAt(view, ids));
      const days = Math.floor(since / DAY_MS);
      if (since < RETAIN_MS) return { keep: `its last Run ended ${days} day(s) ago` };
      return { remove: `its last Run ended ${days} days ago`, ids };
    });

  /** The steering ledgers whose every line is about one of `gone`. */
  const ledgersOf = (gone: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = `${opts.stateDir}/agents`;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const found: string[] = [];
      for (const name of names) {
        const ledger = `${root}/${name}/${LEDGER_FILE}`;
        if (!(yield* fs.exists(ledger).pipe(Effect.orElseSucceed(() => false)))) continue;
        const lines = yield* readJournal(ledger, LedgerRuns);
        if (lines.length > 0 && lines.every((line) => gone.has(line.run)))
          found.push(`${root}/${name}`);
      }
      return found;
    });

  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      const facts = yield* opts.facts;
      const open = yield* Effect.cached(openNow);
      for (const task of facts.tasks) {
        const judged = yield* verdict(task, facts, open);
        if (judged === null) continue;
        if ("keep" in judged) {
          keep.push({ kind, target: task.id, reason: judged.keep });
          continue;
        }
        const sizes = yield* sizesOf(filesOf(judged.ids));
        remove.push({
          kind,
          target: task.id,
          bytes: sizes.reduce((sum, one) => sum + one, 0),
          reason: judged.remove,
        });
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        return yield* withTaskLock(
          opts.stateDir,
          item.target,
          Effect.gen(function* () {
            const facts = yield* opts.facts;
            const task = facts.tasks.find((one) => one.id === item.target);
            if (task === undefined) return { kept: "no such Task any more" };
            const judged = yield* verdict(task, facts, openNow);
            if (judged === null) return { kept: "nothing to forget any more" };
            if ("keep" in judged) return { kept: judged.keep };
            const fs = yield* FileSystem.FileSystem;
            const freed = (yield* sizesOf(filesOf(judged.ids))).reduce((sum, one) => sum + one, 0);
            // Rows first: a file left behind without its row is the no-row rule's next sweep.
            const gone = yield* opts.retire(judged.ids);
            const goneSet = new Set(gone);
            const markers = gone.flatMap((id) =>
              MARKER_KINDS.map((one) => `${opts.stateDir}/${one}.${id}`),
            );
            for (const path of [...filesOf(gone), ...markers, ...(yield* ledgersOf(goneSet))])
              yield* fs.remove(path, { recursive: true, force: true }).pipe(Effect.ignore);
            if (gone.length < judged.ids.length)
              return { kept: "a Run of it was never accepted by the engine" };
            yield* removeTask(opts.stateDir, task.id).pipe(Effect.ignore);
            return { freed };
          }),
        ).pipe(Effect.orElseSucceed(() => ({ kept: "its Task is in use" })));
      }),
  };
};

const DesktopInstalled = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, hash: Schema.optionalKey(Schema.String) }),
);

/**
 * Desktop's own files on this computer, by the rule Desktop applies at its start; none where
 * Desktop has no data folder here. A tar is kept wherever the running bundle is not known.
 */
export const desktopSweeper = (root: string, state: string, installedPath: string): Sweeper => {
  const kind = "desktop";
  const own = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed = yield* fs
      .readFileString(installedPath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DesktopInstalled)), Effect.option);
    return {
      root,
      state,
      hash: Option.match(installed, { onNone: () => null, onSome: (one) => one.hash ?? null }),
      version: Option.match(installed, { onNone: () => null, onSome: (one) => one.version }),
    } satisfies DesktopOwn;
  });
  const verdicts = Effect.flatMap(own, desktopVerdicts).pipe(
    Effect.orElseSucceed(() => ({ remove: [], keep: [], usage: null })),
  );
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false))))
        return { remove: [], keep: [] };
      const found = yield* verdicts;
      const sizes = yield* sizesOf(found.remove.map((one) => one.target));
      const remove = found.remove.map((one, at) => ({ kind, ...one, bytes: sizes[at] ?? 0 }));
      if (found.usage !== null)
        remove.push({
          kind,
          target: found.usage.target,
          bytes: 0,
          reason: `${found.usage.dropped} usage line(s) over 30 days old`,
        });
      return { remove, keep: found.keep.map((one) => ({ kind, ...one })) };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const found = yield* verdicts;
        const fs = yield* FileSystem.FileSystem;
        if (found.usage !== null && found.usage.target === item.target) {
          const before = yield* sizeOf(item.target);
          yield* trimUsage(found.usage);
          return { freed: Math.max(0, before - (yield* sizeOf(item.target))) };
        }
        const now = found.remove.find((one) => one.target === item.target);
        if (now === undefined) return { kept: "Desktop keeps it now" };
        return yield* removeIf(item.target, Effect.succeed({ remove: now.reason }));
      }),
  };
};

/** Check processes no host is collecting (ADR-draft-a-check-ends-with-the-host-that-runs-it D7). */
export const checksSweeper = (checks: CheckProcessesApi): Sweeper => {
  const kind = "check";
  const collecting = "this host is collecting it";
  const reasonOf = (leftover: Leftover) =>
    Effect.gen(function* () {
      const named = `${leftover.run}'s check ${leftover.name === null ? leftover.id : `"${leftover.name}"`}${leftover.pass === null ? "" : ` (${leftover.pass})`}, pid ${leftover.leader.pid}`;
      if (!(yield* checks.stillRuns(leftover))) return `${named}; already gone`;
      const ran = (yield* Clock.currentTimeMillis) - leftover.started;
      return `${named}, running ${took(ran)}; no host is collecting it`;
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const remove = yield* Effect.forEach(yield* checks.left, (leftover) =>
        Effect.map(reasonOf(leftover), (reason) => ({
          kind,
          target: leftover.id,
          bytes: 0,
          reason,
        })),
      );
      const keep = (yield* checks.collecting).map((target) => ({
        kind,
        target,
        reason: collecting,
      }));
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        if ((yield* checks.collecting).includes(item.target)) return { kept: collecting };
        const leftover = (yield* checks.left).find((one) => one.id === item.target);
        if (leftover === undefined) return { freed: 0 };
        return (yield* checks.endLeftover(leftover)) === "still running"
          ? { kept: "still running after SIGKILL" }
          : { freed: 0 };
      }),
  };
};
