import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Semaphore,
  flow,
  Result,
} from "effect";
import type { PlatformServices } from "./platform";
import type { Records } from "./records";
import { STOP } from "./controls";
import { RunRecords } from "./run-records";
import { readEnv } from "./env";
import { FrontDoor, mrLabel, sectionOf, Where, CleanupReport } from "./board-model";
import type { Section, TaskView, CleanupItem, CleanupKept } from "./board-model";
import { herdrFailureReason } from "./herdr";
import type { AgentInfo, AgentStatus, Herdr } from "./herdr";
import { isOpen, readTask, removeTask, withTaskLock, writeTask } from "./task";
import type { TaskRecord } from "./task";
import { appendJournal, readJournal } from "./journal";
import { mrIdIn, shell } from "./mr";
import type { AgentEntry } from "./registry";
import { settled } from "./runs";
import type { RunFacts } from "./runs";
import { epochMs, nowIso, took } from "./time";
import { isDestinationLock, isTheOneMade, judgeWorktrees, onBranch, PRUNE_FILE } from "./worktree";
import type { Landed, Settling } from "./worktree";
import { readForge, readMrStates } from "./merges";
import { latest, readDispositions } from "./disposition";
import { repositoryOf } from "./strategies";
import { forgetDeliveries, LEDGER_FILE, newestById, readLedger } from "./steering";
import { readQueue } from "./delivery-queue";
import { desktopVerdicts, trimUsage } from "./desktop";
import type { DesktopOwn } from "./desktop";
import { CONTROL_DIR, keptFor, putDownControl, readControl } from "./compaction";
import type { CompactionPorts } from "./compaction";
import type { Launched } from "./launches";
import { launchDir, launchesOf, readLaunches, stemOf } from "./launches";
import { endAgent, runLog } from "./agent-end";
import { COMPACTION_PORTS, transcriptOf } from "./compactors";
import { uploadsDir } from "./uploads";
import { finishedOnRecord } from "./cards";
import type { CheckProcessesApi, Leftover } from "./check-processes";
import { humanBytes } from "./bytes";
import { holderLives, lockHolder, withLock } from "./lock";
import { machineLockOf } from "./measurement";
import { once } from "./audit";

export interface Sweeper {
  readonly kind: string;
  readonly judge: Effect.Effect<
    {
      remove: ReadonlyArray<CleanupItem>;
      keep: ReadonlyArray<CleanupKept>;
      retry?: ReadonlyArray<CleanupItem>;
    },
    never,
    PlatformServices | Records
  >;
  readonly remove: (
    item: CleanupItem,
  ) => Effect.Effect<{ freed: number } | { kept: string }, never, PlatformServices | Records>;
}

export const sweepingWith = (fs: FileSystem.FileSystem) => (sweeper: Sweeper) => {
  const returned: Sweeper = {
    kind: sweeper.kind,
    judge: Effect.provideService(sweeper.judge, FileSystem.FileSystem, fs),
    remove: (item) => Effect.provideService(sweeper.remove(item), FileSystem.FileSystem, fs),
  };
  return returned;
};

const DAY_MS = 24 * 60 * 60_000;
const GENERATION_UNUSED_MS = 7 * DAY_MS;
const JOURNAL_KEEP_MS = 30 * DAY_MS;
const UPLOAD_KEEP_MS = 7 * DAY_MS;
export const JOURNAL = "cleanup.jsonl";

export const sizesOf = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sizes = new Map<string, number>();
    for (let at = 0; at < paths.length; at += 500) {
      const du = yield* shell("du", ["-sk", ...paths.slice(at, at + 500)], "/");
      for (const line of Str.split(du.stdout, "\n")) {
        const tab = Option.getOrElse(pipe(line, Str.indexOf("\t")), () => -1);
        if (tab > 0) {
          sizes.set(pipe(line, Str.slice(tab + 1)), Number.parseInt(line, 10) * 1024 || 0);
        }
      }
    }
    return Arr.map(paths, (path) => sizes.get(path) ?? 0);
  });

export const sizeOf = (path: string) => sizesOf([path]).pipe(Effect.map(([bytes]) => bytes ?? 0));

export const sweeping = Semaphore.makeUnsafe(1);

export const cleanupLines = (report: CleanupReport, applied: boolean) =>
  Arr.join(
    [
      ...Arr.map(report.remove, (item) =>
        Arr.join(
          [
            applied ? "removed" : "would remove",
            item.kind,
            item.target,
            humanBytes(item.bytes),
            item.reason,
          ],
          "\t",
        ),
      ),
      ...Arr.map(report.keep, (item) =>
        Arr.join(["kept", item.kind, item.target, item.reason], "\t"),
      ),
      `${applied ? "freed" : "would free"}\t${humanBytes(report.bytes)}`,
    ],
    "\n",
  );

const SLOW_CLEANUP_MS = 2000;

type Sweepers<E, R> = ReadonlyArray<Sweeper> | Effect.Effect<ReadonlyArray<Sweeper>, E, R>;

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
      const kinds = Arr.join(
        Arr.map(
          [...spent].sort(([, a], [, b]) => b - a),
          ([kind, ms]) => `${kind} ${ms} ms`,
        ),
        ", ",
      );
      const gatheringSaid = gathering === undefined ? "" : `gathering took ${gathering} ms; `;
      yield* Effect.logWarning(
        `the cleanup ${what} took ${total} ms; ${gatheringSaid}judging took ${kinds}`,
      );
    }
    return result;
  });

export const judge = <E = never, R = never>(sweepers: Sweepers<E, R>) =>
  timedJudging("listing", sweepers, (sweepers, judgeOf) =>
    Effect.gen(function* () {
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const sweeper of sweepers) {
        const judged = yield* judgeOf(sweeper);
        remove.push(...judged.remove);
        keep.push(...judged.keep);
      }
      const returned: CleanupReport = { remove, keep, bytes: total(remove) };
      return returned;
    }),
  );

const total = (items: ReadonlyArray<CleanupItem>) =>
  Arr.reduce(items, 0, (sum, item) => sum + item.bytes);

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
  bytes: Schema.Finite,
  reason: Schema.String,
});
const JournalJson = Schema.fromJsonString(JournalLine);

export const sweep = <E = never, R = never>(
  sweepers: Sweepers<E, R>,
  stateDir: string,
  by: SweptBy,
) =>
  timedJudging("sweep", sweepers, (sweepers, judgeOf) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const journal = path.join(stateDir, JOURNAL);
      const removed: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const sweeper of sweepers) {
        const judged = yield* judgeOf(sweeper);
        const retried = new Set(Arr.map(judged.retry ?? [], (item) => item.target));
        keep.push(...Arr.filter(judged.keep, (one) => !retried.has(one.target)));
        for (const item of [...judged.remove, ...(judged.retry ?? [])]) {
          const outcome = yield* sweeper.remove(item);
          if ("kept" in outcome) {
            keep.push({ kind: item.kind, target: item.target, reason: outcome.kept });
            continue;
          }
          const gone = { ...item, bytes: outcome.freed };
          removed.push(gone);
          yield* appendJournal(journal, JournalJson, { at: yield* nowIso, by, ...gone }).pipe(
            Effect.ignore,
          );
        }
      }
      yield* trimJournal(journal);
      const returned: CleanupReport = { remove: removed, keep, bytes: total(removed) };
      return returned;
    }),
  );

// WARNING: once begun a sweep finishes and records its report even if its caller goes away.
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

const trimJournal = (file: string) =>
  Effect.gen(function* () {
    const lines = yield* readJournal(file, JournalJson);
    const since = (yield* Clock.currentTimeMillis) - JOURNAL_KEEP_MS;
    const kept = Arr.filter(lines, (line) => epochMs(line.at) >= since);
    if (kept.length === lines.length) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const encode = flow(Schema.encodeResult(JournalJson), Result.getOrThrow);
    const tmp = `${file}.${process.pid}.tmp`;
    yield* fs.writeFileString(
      tmp,
      Arr.join(
        Arr.map(kept, (line) => `${encode(line)}\n`),
        "",
      ),
    );
    yield* fs.rename(tmp, file);
  }).pipe(Effect.ignore);

export const collieCache = () =>
  `${Bun.env.XDG_CACHE_HOME || `${Bun.env.HOME ?? Bun.env.TMPDIR ?? "/tmp"}/.cache`}/collie`;

export const generationsDir = () => `${collieCache()}/entries/generations`;

export const generationsSweeper: (dir: string) => Sweeper = (dir) => {
  const kind = "generation";
  const unusedFor = (target: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(target).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") {
        return null;
      }
      const used = Option.getOrNull(info.value.mtime)?.getTime() ?? 0;
      return (yield* Clock.currentTimeMillis) - used;
    });
  const days = (ms: number) => Math.floor(ms / DAY_MS);
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const name of names) {
        const target = `${dir}/${name}`;
        const unused = yield* unusedFor(target);
        if (unused === null) {
          continue;
        }
        if (unused < GENERATION_UNUSED_MS) {
          keep.push({ kind, target, reason: `used ${days(unused)} day(s) ago` });
        } else {
          remove.push({ kind, target, bytes: 0, reason: `unused for ${days(unused)} days` });
        }
      }
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return { remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const unused = yield* unusedFor(item.target);
        if (unused === null) {
          return { kept: "already gone" };
        }
        if (unused < GENERATION_UNUSED_MS) {
          return { kept: "used again since it was judged" };
        }
        const bytes = yield* sizeOf(item.target);
        const fs = yield* FileSystem.FileSystem;
        const gone = yield* fs.remove(item.target, { recursive: true }).pipe(Effect.result);
        return gone._tag === "Success" ? { freed: bytes } : { kept: String(gone.failure) };
      }),
  };
};

export const settlingOf = (opts: {
  stateDir: string;
  runs: ReadonlyArray<RunFacts>;
  views: ReadonlyArray<TaskView> | null;
  tasks: ReadonlyArray<TaskRecord>;
  protect: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const states = yield* readMrStates(opts.stateDir);
    const forge = yield* readForge(opts.stateDir);
    const views =
      opts.views === null
        ? []
        : yield* (yield* Effect.promise(() => import("./board"))).buildBoard({
            env: readEnv({ COLLIE_STATE_DIR: opts.stateDir }),
            runs: opts.runs,
            tasks: opts.tasks,
            includeHistory: true,
            // WARNING: settlement needs work facts, not offers from this host's own socket.
            offers: () => Effect.succeed([]),
          });
    const viewOf = new Map(Arr.map([...views, ...(opts.views ?? [])], (view) => [view.id, view]));
    const landedAt = new Map<string, Landed>();
    const landedOn = new Map<string, Landed>();
    const openOn = new Map<string, string>();
    const owedAt = new Set<string>();
    const owedOn = new Set<string>();
    for (const run of opts.runs) {
      const label = run.mr === null ? null : mrLabel(run.mr);
      const id = run.mr === null ? null : yield* mrIdIn(run.mr, run.cwd, shell);
      const state = id === null ? undefined : states.get(id);
      const branch = run.branch ?? run.worktree?.branch ?? "";
      const view =
        viewOf.get(run.task ?? run.id) ??
        Arr.findFirst(views, (one) => Arr.some(one.children, (child) => child.run === run.id)).pipe(
          Option.getOrUndefined,
        );
      const item = Option.getOrUndefined(Arr.findFirst(view?.mrs ?? [], (one) => one.id === id));
      // WARNING: a Task keeps what it still owes, whatever its Run's line says.
      const owed = opts.views === null || (view !== undefined && !view.landed);
      const openLabel = state === "open" && branch !== "" ? label : null;
      if (owed) {
        if (run.worktree !== null) {
          owedAt.add(run.worktree.path);
        }
        if (branch !== "") {
          owedOn.add(onBranch(run.project, branch));
        }
        if (openLabel !== null) {
          openOn.set(onBranch(run.project, branch), openLabel);
        }
        continue;
      }
      const head = id === null ? null : (forge.get(id)?.head ?? null);
      // WARNING: only a merge's head is on the remote; a closed merge request's head never landed.
      const heads =
        head !== null && state !== undefined && state !== "open" && state !== "closed"
          ? [head]
          : [];
      const settledBy =
        item?.settled ??
        latest(yield* readDispositions(run.dir).pipe(Effect.orElseSucceed(() => [])))?.kind ??
        null;
      const landed: Landed | null =
        state !== undefined && state !== "open"
          ? { why: `${state === "closed" ? "closed" : "merged"} in ${label}`, heads }
          : settledBy === null
            ? null
            : { why: `${settledBy}, as recorded`, heads };
      if (landed === null) {
        if (openLabel !== null) {
          openOn.set(onBranch(run.project, branch), openLabel);
        }
        continue;
      }
      if (run.worktree !== null) {
        landedAt.set(run.worktree.path, landed);
      }
      if (branch !== "") {
        landedOn.set(onBranch(run.project, branch), landed);
      }
    }
    for (const path of owedAt) {
      landedAt.delete(path);
    }
    for (const key of owedOn) {
      landedOn.delete(key);
    }
    const taskHolds = new Map<string, string>();
    for (const path of owedAt) {
      taskHolds.set(path, "its Task still owes work");
    }
    for (const run of opts.runs) {
      if (run.worktree?.created_by_collie !== true || run.task === null) {
        continue;
      }
      const task = Option.getOrUndefined(Arr.findFirst(opts.tasks, (one) => one.id === run.task));
      if (task !== undefined && isOpen(task)) {
        taskHolds.set(run.worktree.path, "its Task is still open");
      }
    }
    const returned: Settling = {
      owedAt,
      owedOn,
      landedAt,
      landedOn,
      openOn,
      taskHolds,
      protect: new Set(opts.protect),
    };
    return returned;
  });

export const worktreesSweeper: (opts: {
  herdr: Herdr;
  stateDir: string;
  runs: ReadonlyArray<RunFacts>;
  registered: ReadonlyArray<AgentEntry>;
  cwd: string;
  // WARNING: read when judging, so a Task closed earlier in the same sweep counts as closed.
  settling?: Effect.Effect<Settling, never, PlatformServices | Records>;
}) => Sweeper = (opts) => {
  const kind = "worktree";
  return {
    kind,
    judge: Effect.gen(function* () {
      const settling = opts.settling === undefined ? undefined : yield* opts.settling;
      const round = yield* judgeWorktrees({ ...opts, settling, dryRun: true });
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      if (round.busy) {
        keep.push({ kind, target: opts.stateDir, reason: "another sweep is judging worktrees" });
      }
      for (const one of round.judged) {
        if (one.why !== undefined) {
          remove.push({
            kind,
            target: one.path,
            bytes: yield* sizeOf(one.path),
            reason: one.why,
          });
        } else {
          keep.push({ kind, target: one.path, reason: one.keep ?? "kept" });
        }
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const bytes = yield* sizeOf(item.target);
        const settling = opts.settling === undefined ? undefined : yield* opts.settling;
        const round = yield* judgeWorktrees({ ...opts, settling, only: item.target });
        const one = Option.getOrUndefined(
          Arr.findFirst(round.judged, (judged) => judged.path === item.target),
        );
        if (one?.removed === true) {
          return { freed: bytes };
        }
        return { kept: one?.keep ?? (round.busy ? "another sweep is removing it" : "gone") };
      }),
  };
};

const RECEIPT_KEEP_MS = 30 * DAY_MS;

const changedToday = (path: string) =>
  shell("find", [path, "-mmin", "-1440", "-print", "-quit"], "/").pipe(
    Effect.map((found) => found.code !== 0 || Str.trim(found.stdout) !== ""),
  );

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
  "check-output",
]);
const MARKER_KINDS = ["stop", "hold", "parked", "awaiting", "notified"];
const MARKER = new RegExp(`^(?:${Arr.join(MARKER_KINDS, "|")})\\.(.+)$`);
const DEAD = /^(?:events\..*\.log|plans)$/;

export const stateSweeper: (stateDir: string, rows: ReadonlySet<string>) => Sweeper = (
  stateDir,
  rows,
) => {
  const kind = "state";
  // WARNING: a child Run's files belong to its root Run.
  const owned = (run: string) => rows.has(run) || rows.has(Str.split(run, ".")[0] ?? run);
  const quiet = (target: string, why: string) =>
    Effect.map(changedToday(target), (changed) =>
      changed ? { keep: "changed in the last day" } : { remove: why },
    );
  const rowless = "no Run has a row for it";

  const verdict: (
    target: string,
  ) => Effect.Effect<{ remove: string } | { keep: string } | null, never, PlatformServices> = (
    target,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rel = Str.split(pipe(target, Str.slice(stateDir.length + 1)), "/");
      const [top, name = "", file] = rel;
      if (rel.length === 1) {
        if (
          KEPT_KINDS.has(top) ||
          pipe(top, Str.startsWith(`${PRUNE_FILE}.`)) ||
          isDestinationLock(top)
        ) {
          return null;
        }
        if (top === "runs" || top === "agents" || top === "evidence" || top === "requests") {
          return null;
        }
        if (top === "schedules") {
          return { keep: "the Schedules this host fires" };
        }
        if (pipe(top, Str.startsWith(`${JOURNAL}.`))) {
          return null;
        }
        if (DEAD.test(top)) {
          return yield* quiet(target, "nothing reads it any more");
        }
        const marker = MARKER.exec(top)?.[1];
        if (marker !== undefined) {
          return owned(marker) ? null : yield* quiet(target, rowless);
        }
        return { keep: "not a kind Collie knows" };
      }
      if (top === "requests") {
        if (file === undefined) {
          return null;
        }
        const info = yield* fs.stat(target).pipe(Effect.option);
        if (Option.isNone(info)) {
          return null;
        }
        const written = Option.getOrNull(info.value.mtime)?.getTime() ?? 0;
        return (yield* Clock.currentTimeMillis) - written > RECEIPT_KEEP_MS
          ? { remove: "a receipt over 30 days old" }
          : null;
      }
      if (rel.length !== 2) {
        return null;
      }
      if (top === "runs" && name === ".seq") {
        return yield* quiet(target, "nothing reads it any more");
      }
      if (owned(name)) {
        return null;
      }
      if (top === "agents") {
        if (pipe(name, Str.endsWith(".json")) || name === "deliveries.log") {
          return null;
        }
        const inside = yield* fs.readDirectory(target).pipe(
          Effect.orElseSucceed(() => {
            const returned: ReadonlyArray<string> = [];
            return returned;
          }),
        );
        // WARNING: imported into host.db; a later release deletes it, not this sweep.
        if (inside.includes(LEDGER_FILE)) {
          return null;
        }
      }
      return yield* quiet(target, rowless);
    });

  const entries = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const list = (dir: string) =>
      fs.readDirectory(dir).pipe(
        Effect.map((names) => Arr.map(names, (name) => `${dir}/${name}`)),
        Effect.orElseSucceed(() => {
          const returned: Array<string> = [];
          return returned;
        }),
      );
    const out = yield* list(stateDir);
    for (const dir of ["runs", "agents", "evidence"]) {
      out.push(...(yield* list(`${stateDir}/${dir}`)));
    }
    for (const op of yield* list(`${stateDir}/requests`)) {
      out.push(...(yield* list(op)));
    }
    return out;
  });

  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const target of yield* entries) {
        const judged = yield* verdict(target);
        if (judged === null) {
          continue;
        }
        if ("keep" in judged) {
          keep.push({ kind, target, reason: judged.keep });
        } else {
          remove.push({ kind, target, bytes: 0, reason: judged.remove });
        }
      }
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return { remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

// WARNING: an upload not asked for in a week; a Run given one holds its own copy.
export const uploadsSweeper: (stateDir: string) => Sweeper = (stateDir) => {
  const kind = "upload";
  const root = uploadsDir(stateDir);
  const verdict = (target: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(target).pipe(Effect.option);
      const at = Option.getOrNull(Option.flatMap(info, (one) => one.mtime));
      if (at === null) {
        return null;
      }
      return (yield* Clock.currentTimeMillis) - at.getTime() > UPLOAD_KEEP_MS
        ? { remove: "not asked for in a week" }
        : null;
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const remove: Array<CleanupItem> = [];
      for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
        if (!/^[0-9a-f]{64}$/.test(name)) {
          continue;
        }
        const target = `${root}/${name}`;
        const judged = yield* verdict(target);
        if (judged !== null) {
          remove.push({ kind, target, bytes: yield* sizeOf(target), reason: judged.remove });
        }
      }
      return { remove, keep: [] };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

const removeIf = (
  target: string,
  verdict: Effect.Effect<{ remove: string } | { keep: string } | null, never, PlatformServices>,
) =>
  Effect.gen(function* () {
    const now = yield* verdict;
    if (now === null) {
      return { kept: "nothing to remove any more" };
    }
    if ("keep" in now) {
      return { kept: now.keep };
    }
    const bytes = yield* sizeOf(target);
    const fs = yield* FileSystem.FileSystem;
    const gone = yield* fs.remove(target, { recursive: true }).pipe(Effect.result);
    return gone._tag === "Success" ? { freed: bytes } : { kept: String(gone.failure) };
  });

// WARNING: nothing is judged where core will not list its agents.
export const compactionSweeper: (
  stateDir: string,
  sessions: ReadonlyArray<Herdr>,
  ports?: CompactionPorts,
  stopMs?: number,
) => Sweeper = (stateDir, sessions, ports = COMPACTION_PORTS, stopMs?) => {
  const kind = "compaction";
  const root = `${stateDir}/${CONTROL_DIR}`;
  const listed = Effect.gen(function* () {
    const names = new Set<string>();
    for (const session of sessions) {
      const agents = yield* session.agentList().pipe(Effect.option);
      if (Option.isNone(agents)) {
        return null;
      }
      for (const agent of agents.value) {
        names.add(agent.name);
      }
    }
    return names;
  });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const live = yield* listed;
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      const retry: Array<CleanupItem> = [];
      for (const name of names) {
        const target = `${root}/${name}`;
        if (live === null) {
          keep.push({ kind, target, reason: "could not ask core what is live" });
        } else if (!live.has(name)) {
          const record = yield* readControl(stateDir, name).pipe(Effect.orElseSucceed(() => null));
          const kept = record === null ? null : yield* keptFor(record);
          if (kept !== null) {
            keep.push({ kind, target, reason: kept });
            retry.push({ kind, target, bytes: 0, reason: kept });
          } else {
            remove.push({ kind, target, bytes: 0, reason: "core no longer lists its agent" });
          }
        }
      }
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return {
        remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })),
        keep,
        retry,
      };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const live = yield* listed;
        const name = pipe(item.target, Str.slice(root.length + 1));
        if (live === null) {
          return { kept: "could not ask core what is live" };
        }
        if (live.has(name)) {
          return { kept: "core lists its agent again" };
        }
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

export const runnersSweeper: (dir: string, running: string) => Sweeper = (dir, running) => {
  const kind = "runner";
  const versionOf = (name: string) => /^collie-(.+)$/.exec(name)?.[1] ?? null;
  const verdicts = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = Arr.filter(
      yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [])),
      (name) => Bun.semver.satisfies(versionOf(name) ?? "", "*"),
    );
    const versions = Arr.map(names, (name) => versionOf(name)!);
    const newest = Arr.reduce<string, string | null>(versions, null, (best, v) =>
      best === null || Bun.semver.order(v, best) > 0 ? v : best,
    );
    return Arr.map(names, (name) => {
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
      const remove = Arr.flatMap(all, (one) =>
        "remove" in one ? [{ kind, target: one.target, bytes: 0, reason: one.remove! }] : [],
      );
      const keep = Arr.flatMap(all, (one) =>
        "keep" in one ? [{ kind, target: one.target, reason: one.keep! }] : [],
      );
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return { remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) =>
      removeIf(
        item.target,
        Effect.map(verdicts, (all) => {
          const one = Option.getOrUndefined(
            Arr.findFirst(all, (each) => each.target === item.target),
          );
          return one === undefined
            ? null
            : "remove" in one
              ? { remove: one.remove! }
              : { keep: one.keep };
        }),
      ),
  };
};

const FINISHED_GRACE_MS = 60 * 60_000;
const SECTION_SAID: Record<Section, string> = {
  "needs-you": "needs you",
  "ready-to-ship": "ready to ship",
  waiting: "waiting on you",
  working: "working",
  finished: "Finished",
};

// WARNING: a host restart only delays a close; the first-seen times are kept across sweeps, not persisted.
export const tasksSweeper: (opts: {
  tasks: ReadonlyArray<TaskRecord>;
  views: ReadonlyArray<TaskView>;
  seen: Map<string, number>;
}) => Sweeper = (opts) => {
  const kind = "workspace";

  const finishedFor: (
    task: TaskRecord,
  ) => Effect.Effect<{ keep: string } | { ms: number; said: string } | null> = (task) =>
    Effect.gen(function* () {
      const view = Option.getOrUndefined(Arr.findFirst(opts.views, (one) => one.id === task.id));
      if (view === undefined) {
        return null;
      }
      const now = yield* Clock.currentTimeMillis;
      const section = sectionOf(view);
      if (section !== "finished") {
        opts.seen.delete(task.id);
        return { keep: SECTION_SAID[section] };
      }
      const since = opts.seen.get(task.id) ?? now;
      opts.seen.set(task.id, since);
      return { ms: now - since, said: `Finished ${Math.floor((now - since) / 60_000)} min ago` };
    });

  const closing = (task: TaskRecord) =>
    Effect.gen(function* () {
      if (task.closed_at !== undefined) {
        return null;
      }
      const finished = yield* finishedFor(task);
      if (finished === null || "keep" in finished) {
        return finished;
      }
      if (finished.ms < FINISHED_GRACE_MS) {
        return { keep: finished.said };
      }
      return { remove: finished.said };
    });

  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const task of opts.tasks) {
        const judged = yield* closing(task);
        if (judged === null) {
          continue;
        }
        if ("keep" in judged) {
          keep.push({ kind, target: task.id, reason: judged.keep });
        } else {
          remove.push({ kind, target: task.id, bytes: 0, reason: judged.remove });
        }
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const task = Option.getOrUndefined(
          Arr.findFirst(opts.tasks, (one) => one.id === item.target),
        );
        if (task === undefined) {
          return { kept: "no Task names it any more" };
        }
        const judged = yield* closing(task);
        if (judged === null) {
          return { kept: "already closed" };
        }
        if ("keep" in judged) {
          return { kept: judged.keep };
        }
        const closed = yield* withTaskLock(
          task.id,
          Effect.gen(function* () {
            const now = yield* readTask(task.id);
            if (now !== null) {
              yield* writeTask({ ...now, closed_at: yield* nowIso });
            }
          }),
        ).pipe(Effect.result);
        return closed._tag === "Failure" ? { kept: "its Task is busy" } : { freed: 0 };
      }),
  };
};

export type IdleSince = Map<string, number>;

const IDLE: ReadonlySet<string | null> = new Set<AgentStatus>(["idle", "done"]);

export type FinishedSince = Map<string, number>;

export const noteIdle = (
  idle: IdleSince,
  agents: ReadonlyArray<{ terminalId: string | null; status: string | null }>,
  now: number,
) => {
  for (const { terminalId, status } of agents) {
    if (terminalId === null) {
      continue;
    }
    if (!IDLE.has(status)) {
      idle.delete(terminalId);
    } else if (!idle.has(terminalId)) {
      idle.set(terminalId, now);
    }
  }
};

export const forgetGone = (idle: IdleSince, terminals: ReadonlySet<string>) => {
  for (const key of idle.keys()) {
    if (!terminals.has(key)) {
      idle.delete(key);
    }
  }
};

const FINISHED: ReadonlySet<RunFacts["state"]> = new Set(["succeeded", "failed", "stopped"]);

const QUEUED: ReadonlySet<string> = new Set(["reserved", "deferred"]);

export const idleAgentsSweeper: (opts: {
  stateDir: string;
  sessions: ReadonlyArray<{ readonly herd: string | null; readonly herdr: Herdr }>;
  runs: ReadonlyArray<RunFacts>;
  idle: IdleSince;
  finishedSince: FinishedSince;
  idleCloseMs: number;
  ports?: CompactionPorts;
  stopMs?: number;
  // WARNING: core cannot yet prove no one is viewing; by default every agent is kept.
  unattended?: (at: AgentInfo) => Effect.Effect<boolean>;
}) => Sweeper = (opts) => {
  const kind = "idle-agent";
  const unattended = opts.unattended ?? (() => Effect.succeed(false));
  const targetOf = (agent: string, runId: string) => `${agent} of ${runId}`;
  const minutes = (ms: number) => Math.floor(ms / 60_000);

  const candidates = Effect.gen(function* () {
    const live = new Set<string>();
    const named: Array<{ run: RunFacts; launched: Launched }> = [];
    const now = yield* Clock.currentTimeMillis;
    for (const run of opts.runs) {
      if (!FINISHED.has(run.state)) {
        opts.finishedSince.delete(run.id);
      } else if (!opts.finishedSince.has(run.id)) {
        opts.finishedSince.set(run.id, now);
      }
    }
    for (const run of opts.runs) {
      for (const launched of yield* readLaunches(run.id)) {
        if (FINISHED.has(run.state)) {
          named.push({ run, launched });
        } else if (launched.terminalId !== undefined) {
          live.add(launched.terminalId);
        }
      }
    }
    const listings = yield* Effect.forEach(opts.sessions, (session) =>
      Effect.option(session.herdr.agentList()).pipe(
        Effect.map((agents) => ({
          session,
          live: Option.getOrElse(agents, () => []),
          listed: Option.isSome(agents),
        })),
      ),
    );
    const seen = Arr.flatMap(listings, (one) => one.live);
    noteIdle(opts.idle, seen, now);
    if (Arr.every(listings, (one) => one.listed)) {
      forgetGone(opts.idle, new Set(Arr.map(seen, (one) => one.terminalId)));
    }

    const found: Array<{
      run: RunFacts;
      launched: Launched;
      at: AgentInfo;
      session: (typeof opts.sessions)[number];
    }> = [];
    for (const { run, launched } of named) {
      for (const { session, live: here } of listings) {
        const at = Option.getOrUndefined(
          Arr.findFirst(
            here,
            (one) => one.name === launched.agent && one.terminalId === launched.terminalId,
          ),
        );
        if (at === undefined || live.has(at.terminalId)) {
          continue;
        }
        if (Arr.some(found, (one) => one.at.terminalId === at.terminalId)) {
          continue;
        }
        found.push({ run, launched, at, session });
      }
    }
    return found;
  });

  // WARNING: a Run that resumed and ended again between sweeps counts from its latest end.
  const lastFinished = (run: RunFacts, now: number) =>
    Effect.gen(function* () {
      const card = yield* finishedOnRecord(run.dir).pipe(Effect.orElseSucceed(() => null));
      const stop = yield* RunRecords.use((records) => records.control(STOP, run.id));
      const stopped = stop === null || stop === "" ? 0 : epochMs(stop);
      return Math.max(
        opts.finishedSince.get(run.id) ?? now,
        card === null ? 0 : epochMs(card),
        Number.isFinite(stopped) ? stopped : 0,
      );
    });

  type Candidate = Effect.Success<typeof candidates>[number];

  const verdict: (
    one: Candidate,
  ) => Effect.Effect<{ keep: string } | { idleFor: number }, never, PlatformServices | Records> = (
    one,
  ) =>
    Effect.gen(function* () {
      if (!IDLE.has(one.at.status)) {
        return { keep: one.at.status ?? "unknown" };
      }
      const now = yield* Clock.currentTimeMillis;
      const since = opts.idle.get(one.at.terminalId) ?? now;
      const finished =
        one.run.finished === null ? yield* lastFinished(one.run, now) : epochMs(one.run.finished);
      const idleFor = now - Math.max(since, finished);
      if (idleFor < opts.idleCloseMs) {
        return { keep: `idle ${minutes(idleFor)} of ${minutes(opts.idleCloseMs)} min` };
      }
      const ledger = yield* readLedger(one.at.terminalId);
      if (Arr.some([...newestById(ledger).values()], (delivery) => QUEUED.has(delivery.state))) {
        return { keep: "a Delivery to it is queued" };
      }
      const queued = yield* readQueue(launchDir(opts.stateDir, one.run.id)).pipe(Effect.option);
      if (Option.isNone(queued)) {
        return { keep: "its delivery queue could not be read" };
      }
      if (Arr.some(queued.value, (delivery) => delivery.result === null)) {
        return { keep: "a Delivery to it is queued" };
      }
      const stems = Arr.map(
        Arr.filter(
          yield* readLaunches(one.run.id),
          (launched) => launched.agent === one.launched.agent,
        ),
        (launched) => `ask-${stemOf(launched)}-`,
      );
      if (
        Arr.some(one.run.asking, (asked) =>
          Arr.some(stems, (stem) => pipe(asked.name, Str.startsWith(stem))),
        )
      ) {
        return { keep: "a question it asked is open" };
      }
      if (
        Arr.some(
          ledger,
          (line) => "kind" in line && line.kind === "manual_override" && epochMs(line.at) >= since,
        )
      ) {
        return { keep: "typed into since it went idle" };
      }
      if (!(yield* unattended(one.at))) {
        return { keep: "core cannot say whether a person is viewing or typing into it" };
      }
      return { idleFor };
    });

  return {
    kind,
    judge: Effect.gen(function* () {
      const found = yield* candidates;
      if (opts.idleCloseMs <= 0) {
        return { remove: [], keep: [] };
      }
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const one of found) {
        const target = targetOf(one.launched.agent, one.run.id);
        const judged = yield* verdict(one);
        if ("keep" in judged) {
          keep.push({ kind, target, reason: judged.keep });
        } else {
          remove.push({
            kind,
            target,
            bytes: 0,
            reason: `idle for ${minutes(judged.idleFor)} min`,
          });
        }
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        if (opts.idleCloseMs <= 0) {
          return { kept: "idle agents are never closed" };
        }
        const one = Option.getOrUndefined(
          Arr.findFirst(
            yield* candidates,
            (candidate) => targetOf(candidate.launched.agent, candidate.run.id) === item.target,
          ),
        );
        if (one === undefined) {
          return { kept: "already gone" };
        }
        const judged = yield* verdict(one);
        if ("keep" in judged) {
          return { kept: judged.keep };
        }
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
            stopMs: opts.stopMs,
            log: runLog(opts.stateDir, one.run.id),
          },
          one.launched,
          why,
          "close",
        ).pipe(
          Effect.catchTags({
            AgentsUnlisted: () => Effect.succeed({ kept: "could not ask core what is open" }),
            PaneOpen: (failure) => Effect.succeed({ kept: herdrFailureReason(failure.cause) }),
          }),
        );
        if ("kept" in ended) {
          return ended;
        }
        if (ended._tag === "Closed") {
          return ended.ended ? { freed: 0 } : { kept: "already gone" };
        }
        return { kept: ended.reason };
      }),
  };
};

export const renovateClonesSweeper: (stateDir: string, runs: ReadonlyArray<RunFacts>) => Sweeper = (
  stateDir,
  runs,
) => {
  const kind = "renovate-clone";
  const root = `${stateDir}/renovate-repositories`;
  const used = new Set(
    Arr.flatMap(runs, (run) => {
      const repository = repositoryOf(run.settled)?.value ?? "";
      return repository === "" ? [] : [Bun.hash(repository).toString(16)];
    }),
  );
  const verdict: (
    target: string,
  ) => Effect.Effect<{ remove: string } | { keep: string } | null, never, PlatformServices> = (
    target,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
        return null;
      }
      if (used.has(pipe(target, Str.slice(root.length + 1)))) {
        return { keep: "a Run with a row cut a checkout from it" };
      }
      const listed = yield* shell("git", ["worktree", "list", "--porcelain"], target);
      if (listed.code !== 0) {
        return { keep: "git could not list its checkouts" };
      }
      const checkouts = Arr.filter(
        Arr.map(
          Arr.filter(Str.split(listed.stdout, "\n"), (line) =>
            pipe(line, Str.startsWith("worktree ")),
          ),
          (line) => pipe(line, Str.slice("worktree ".length)),
        ),
        (path) => path !== target,
      );
      for (const path of checkouts) {
        if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => true))) {
          return { keep: `a checkout cut from it is still on disk (${path})` };
        }
      }
      return { remove: "no Run uses it and no checkout of it is left" };
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const name of names) {
        const target = `${root}/${name}`;
        const judged = yield* verdict(target);
        if (judged === null) {
          continue;
        }
        if ("keep" in judged) {
          keep.push({ kind, target, reason: judged.keep });
        } else {
          remove.push({ kind, target, bytes: 0, reason: judged.remove });
        }
      }
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return { remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

export const measurementTreesSweeper: (
  stateDir: string,
  runs: ReadonlyArray<RunFacts>,
) => Sweeper = (stateDir, runs) => {
  const kind = "measurement-tree";
  const root = `${stateDir}/measurements/trees`;
  const lock = machineLockOf(stateDir);
  const MEASURING = "a Measurement is running on this Machine";
  const live = new Set(
    Arr.map(
      Arr.filter(runs, (run) => !settled(run)),
      (run) => run.id,
    ),
  );
  const verdict: (
    target: string,
  ) => Effect.Effect<{ remove: string } | { keep: string } | null, never, PlatformServices> = (
    target,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
        return null;
      }
      const run = Str.split(pipe(target, Str.slice(root.length + 1)), "/")[0] ?? "";
      return live.has(run)
        ? { keep: `${run} may measure on it again` }
        : { remove: `${run} has ended, so nothing measures on it` };
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const holder = yield* lockHolder(lock);
      const measuring = holder !== null && (yield* holderLives(holder));
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const run of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
        for (const tree of yield* fs
          .readDirectory(`${root}/${run}`)
          .pipe(Effect.orElseSucceed(() => []))) {
          const target = `${root}/${run}/${tree}`;
          const judged = yield* verdict(target);
          if (judged === null) {
            continue;
          }
          if (measuring) {
            keep.push({ kind, target, reason: MEASURING });
          } else if ("keep" in judged) {
            keep.push({ kind, target, reason: judged.keep });
          } else {
            remove.push({ kind, target, bytes: 0, reason: judged.remove });
          }
        }
      }
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return { remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    // WARNING: a Measurement holds the lock from before its tree is made until it ends.
    remove: (item) =>
      withLock(
        lock,
        Effect.succeed({ kept: MEASURING }),
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const common = yield* shell(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            item.target,
          );
          const freed = yield* removeIf(item.target, verdict(item.target));
          if (common.code === 0) {
            yield* shell("git", ["--git-dir", Str.trim(common.stdout), "worktree", "prune"], "/");
          }
          const parent = pipe(
            item.target,
            Str.slice(
              0,
              Option.getOrElse(pipe(item.target, Str.lastIndexOf("/")), () => -1),
            ),
          );
          if (
            (yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => ["?"]))).length === 0
          ) {
            yield* fs.remove(parent, { recursive: true }).pipe(Effect.ignore);
          }
          return freed;
        }),
        0,
      ).pipe(Effect.catch((error) => Effect.succeed({ kept: String(error) }))),
  };
};

const CACHE_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";

export const buildCachesSweeper: (
  runs: Effect.Effect<ReadonlyArray<RunFacts>, never, PlatformServices>,
) => Sweeper = (runs) => {
  const kind = "build-cache";
  const checkouts = Effect.gen(function* () {
    const all = yield* runs;
    const liveIn = new Map<string, string>();
    for (const run of Arr.filter(all, (one) => !settled(one))) {
      for (const path of [run.cwd, run.worktree?.path]) {
        if (path !== undefined && !liveIn.has(path)) {
          liveIn.set(path, run.id);
        }
      }
    }
    const made = new Set<string>();
    for (const run of all) {
      if (run.worktree !== null && (yield* isTheOneMade(run.worktree.path, run.worktree))) {
        made.add(run.worktree.path);
      }
    }
    return Arr.map([...made], (path) => ({ path, live: liveIn.get(path) }));
  });
  const cachesIn = (checkout: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const listed = yield* shell(
        "git",
        ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
        checkout,
      );
      if (listed.code !== 0) {
        return [];
      }
      const caches: Array<string> = [];
      for (const entry of Str.split(listed.stdout, "\0")) {
        if (pipe(entry, Str.endsWith("/"))) {
          const dir = `${checkout}/${pipe(entry, Str.slice(0, -1))}`;
          const tag = yield* fs
            .readFileString(`${dir}/CACHEDIR.TAG`)
            .pipe(Effect.orElseSucceed(() => ""));
          if (pipe(tag, Str.startsWith(CACHE_SIGNATURE))) {
            caches.push(dir);
          }
        }
      }
      return caches;
    });
  const reasonOf: (live: string | undefined) => { remove: string } | { keep: string } = (live) =>
    live === undefined
      ? { remove: "no live Run works in this checkout" }
      : { keep: `${live} still works in this checkout` };
  const verdict = (target: string) =>
    Effect.gen(function* () {
      const checkout = Option.getOrUndefined(
        Arr.findFirst(yield* checkouts, (one) => pipe(target, Str.startsWith(`${one.path}/`))),
      );
      if (checkout === undefined || !(yield* cachesIn(checkout.path)).includes(target)) {
        return null;
      }
      return reasonOf(checkout.live);
    });
  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      for (const checkout of yield* checkouts) {
        for (const target of yield* cachesIn(checkout.path)) {
          const judged = reasonOf(checkout.live);
          if ("keep" in judged) {
            keep.push({ kind, target, reason: judged.keep });
          } else {
            remove.push({ kind, target, bytes: 0, reason: judged.remove });
          }
        }
      }
      const sizes = yield* sizesOf(Arr.map(remove, (item) => item.target));
      return { remove: Arr.map(remove, (item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) => removeIf(item.target, verdict(item.target)),
  };
};

const RETAIN_MS = 30 * DAY_MS;

export interface RetentionFacts {
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly views: ReadonlyArray<TaskView>;
  readonly runs: ReadonlyArray<RunFacts>;
}

// WARNING: rows go first; files left by a failure in between are the state sweeper's no-row rule's job.
export const retentionSweeper: (opts: {
  stateDir: string;
  sessions: ReadonlyArray<Herdr>;
  facts: Effect.Effect<RetentionFacts, never, PlatformServices>;
  retire: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, never, PlatformServices>;
}) => Sweeper = (opts) => {
  const kind = "task";
  const filesOf = (ids: ReadonlyArray<string>) =>
    Arr.flatMap(ids, (id) =>
      Arr.map(["runs", "agents", "evidence"], (dir) => `${opts.stateDir}/${dir}/${id}`),
    );

  const endedAt = (view: TaskView, ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (view.ended !== null) {
        return view.ended;
      }
      const fs = yield* FileSystem.FileSystem;
      let newest = 0;
      for (const dir of filesOf(ids)) {
        const names = yield* fs
          .readDirectory(dir, { recursive: true })
          .pipe(Effect.orElseSucceed(() => []));
        for (const path of [dir, ...Arr.map(names, (name) => `${dir}/${name}`)]) {
          const info = yield* fs.stat(path).pipe(Effect.option);
          if (Option.isSome(info)) {
            newest = Math.max(newest, Option.getOrNull(info.value.mtime)?.getTime() ?? 0);
          }
        }
      }
      // WARNING: no time to go by counts as just ended, so nothing is forgotten on a guess.
      return newest === 0 ? yield* Clock.currentTimeMillis : newest;
    });

  const openNow = Effect.gen(function* () {
    const terminals = new Set<string>();
    for (const session of opts.sessions) {
      const listed = yield* session.agentList().pipe(Effect.option);
      if (Option.isNone(listed)) {
        return null;
      }
      for (const one of listed.value) {
        terminals.add(one.terminalId);
      }
    }
    return terminals;
  });

  const verdict: (
    task: TaskRecord,
    facts: RetentionFacts,
    open: typeof openNow,
  ) => Effect.Effect<
    { keep: string } | { remove: string; ids: ReadonlyArray<string> } | null,
    never,
    PlatformServices | Records
  > = (task, facts, open) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const view = Option.getOrUndefined(Arr.findFirst(facts.views, (one) => one.id === task.id));
      if (view === undefined) {
        return null;
      }
      const section = sectionOf(view);
      if (section !== "finished") {
        return { keep: SECTION_SAID[section] };
      }
      const seen = yield* open;
      if (seen === null) {
        return { keep: "could not ask core what is open" };
      }
      const mine = Arr.filter(facts.runs, (run) => run.task === task.id);
      const ids = Arr.map(mine, (run) => run.id);
      const launched = [...(yield* launchesOf(ids)).values()].flat();
      if (Arr.some(launched, (one) => one.terminalId !== undefined && seen.has(one.terminalId))) {
        return { keep: "an agent of it is alive" };
      }
      for (const run of mine) {
        if (
          run.worktree?.created_by_collie === true &&
          (yield* fs.exists(run.worktree.path).pipe(Effect.orElseSucceed(() => true)))
        ) {
          return { keep: `a checkout it made is on disk (${run.worktree.path})` };
        }
      }
      const dirs = Arr.map(ids, (id) => `${opts.stateDir}/runs/${id}`);
      const pointing = Option.getOrUndefined(
        Arr.findFirst(
          facts.runs,
          (run) =>
            run.task !== task.id &&
            ((run.parent !== null && ids.includes(run.parent)) ||
              Arr.some(Rec.values(run.settled.inputs), (value) =>
                Arr.some(dirs, (dir) => value === dir || pipe(value, Str.startsWith(`${dir}/`))),
              )),
        ),
      );
      if (pointing !== undefined) {
        return { keep: `${pointing.id} still points into it` };
      }
      const since = (yield* Clock.currentTimeMillis) - (yield* endedAt(view, ids));
      const days = Math.floor(since / DAY_MS);
      if (since < RETAIN_MS) {
        return { keep: `its last Run ended ${days} day(s) ago` };
      }
      return { remove: `its last Run ended ${days} days ago`, ids };
    });

  return {
    kind,
    judge: Effect.gen(function* () {
      const remove: Array<CleanupItem> = [];
      const keep: Array<CleanupKept> = [];
      const facts = yield* opts.facts;
      const open = yield* Effect.cached(openNow);
      for (const task of facts.tasks) {
        const judged = yield* verdict(task, facts, open);
        if (judged === null) {
          continue;
        }
        if ("keep" in judged) {
          keep.push({ kind, target: task.id, reason: judged.keep });
          continue;
        }
        const sizes = yield* sizesOf(filesOf(judged.ids));
        remove.push({
          kind,
          target: task.id,
          bytes: Arr.reduce(sizes, 0, (sum, one) => sum + one),
          reason: judged.remove,
        });
      }
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.suspend(() =>
        withTaskLock(
          item.target,
          Effect.gen(function* () {
            const facts = yield* opts.facts;
            const task = Option.getOrUndefined(
              Arr.findFirst(facts.tasks, (one) => one.id === item.target),
            );
            if (task === undefined) {
              return {
                kept: "no such Task any more",
              };
            }
            const judged = yield* verdict(task, facts, openNow);
            if (judged === null) {
              return {
                kept: "nothing to forget any more",
              };
            }
            if ("keep" in judged) {
              return {
                kept: judged.keep,
              };
            }
            const fs = yield* FileSystem.FileSystem;
            const freed = Arr.reduce(
              yield* sizesOf(filesOf(judged.ids)),
              0,
              (sum, one) => sum + one,
            );
            const gone = yield* opts.retire(judged.ids);
            yield* forgetDeliveries(gone);
            const markers = Arr.flatMap(gone, (id) =>
              Arr.map(MARKER_KINDS, (one) => `${opts.stateDir}/${one}.${id}`),
            );
            for (const path of [...filesOf(gone), ...markers]) {
              yield* fs
                .remove(path, {
                  recursive: true,
                  force: true,
                })
                .pipe(Effect.ignore);
            }
            if (gone.length < judged.ids.length) {
              return {
                kept: "a Run of it was never accepted by the engine",
              };
            }
            yield* removeTask(task.id).pipe(Effect.ignore);
            return {
              freed,
            };
          }),
        ).pipe(
          Effect.orElseSucceed(() => ({
            kept: "its Task is in use",
          })),
        ),
      ),
  };
};

const DesktopInstalled = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, hash: Schema.optionalKey(Schema.String) }),
);

// WARNING: a tar is kept wherever the running bundle is not known.
export const desktopSweeper: (root: string, state: string, installedPath: string) => Sweeper = (
  root,
  state,
  installedPath,
) => {
  const kind = "desktop";
  const own = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed = yield* fs
      .readFileString(installedPath)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DesktopInstalled)), Effect.option);
    const returned: DesktopOwn = {
      root,
      state,
      hash: Option.match(installed, { onNone: () => null, onSome: (one) => one.hash ?? null }),
      version: Option.match(installed, { onNone: () => null, onSome: (one) => one.version }),
    };
    return returned;
  });
  const verdicts = Effect.flatMap(own, desktopVerdicts).pipe(
    Effect.orElseSucceed(() => ({ remove: [], keep: [], usage: null })),
  );
  return {
    kind,
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false)))) {
        return { remove: [], keep: [] };
      }
      const found = yield* verdicts;
      const sizes = yield* sizesOf(Arr.map(found.remove, (one) => one.target));
      const remove = Arr.map(found.remove, (one, at) => ({ kind, ...one, bytes: sizes[at] ?? 0 }));
      if (found.usage !== null) {
        remove.push({
          kind,
          target: found.usage.target,
          bytes: 0,
          reason: `${found.usage.dropped} usage line(s) over 30 days old`,
        });
      }
      return { remove, keep: Arr.map(found.keep, (one) => ({ kind, ...one })) };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const found = yield* verdicts;
        if (found.usage !== null && found.usage.target === item.target) {
          const before = yield* sizeOf(item.target);
          yield* trimUsage(found.usage);
          return { freed: Math.max(0, before - (yield* sizeOf(item.target))) };
        }
        const now = Option.getOrUndefined(
          Arr.findFirst(found.remove, (one) => one.target === item.target),
        );
        if (now === undefined) {
          return { kept: "Desktop keeps it now" };
        }
        return yield* removeIf(item.target, Effect.succeed({ remove: now.reason }));
      }),
  };
};

export const checksSweeper: (checks: CheckProcessesApi) => Sweeper = (checks) => {
  const kind = "check";
  const collecting = "this host is collecting it";
  const reasonOf = (leftover: Leftover) =>
    Effect.gen(function* () {
      const named = `${leftover.run}'s check ${leftover.name === null ? leftover.id : `"${leftover.name}"`}${leftover.pass === null ? "" : ` (${leftover.pass})`}, pid ${leftover.leader.pid}`;
      if (!(yield* checks.stillRuns(leftover))) {
        return `${named}; already gone`;
      }
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
      const keep = Arr.map(yield* checks.collecting, (target) => ({
        kind,
        target,
        reason: collecting,
      }));
      return { remove, keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        if ((yield* checks.collecting).includes(item.target)) {
          return { kept: collecting };
        }
        const leftover = Option.getOrUndefined(
          Arr.findFirst(yield* checks.left, (one) => one.id === item.target),
        );
        if (leftover === undefined) {
          return { freed: 0 };
        }
        return (yield* checks.endLeftover(leftover)) === "still running"
          ? { kept: "still running after SIGKILL" }
          : { freed: 0 };
      }),
  };
};
