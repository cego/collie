// Cleanup: what Collie removes once nothing needs it, and only what it made and can show it
// made (ADR-0045). Each kind of thing is a sweeper that judges what it would remove and
// keep, and removes one item only after judging it again. A listing is every judge; a
// sweep is every judge, then every removal, each written to `cleanup.jsonl`.

import { Clock, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import {
  FrontDoor,
  sectionOf,
  Where,
  type Section,
  type TaskView,
  type CleanupItem,
  type CleanupKept,
  type CleanupReport,
} from "./board-model";
import { herdrFailureReason, type Herdr } from "./herdr";
import type { TaskRecord } from "./task";
import { appendJournal, readJournal } from "./journal";
import { shell } from "./mr";
import type { AgentEntry } from "./registry";
import type { RunFacts } from "./runs";
import { epochMs, nowIso } from "./time";
import { judgeWorktrees } from "./worktree";
import { CONTROL_DIR, putDownControl } from "./compaction";

/** One kind of thing Collie cleans. */
export interface Sweeper {
  readonly judge: Effect.Effect<
    { remove: ReadonlyArray<CleanupItem>; keep: ReadonlyArray<CleanupKept> },
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

/** `1.2 GiB`, for a human. */
export const humanBytes = (bytes: number) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

/** One sweep at a time in this host, whichever door or schedule asked. */
export const sweeping = Semaphore.makeUnsafe(1);

/** The listing: every sweeper's judgement, and what the removable items come to. */
export const judge = (sweepers: ReadonlyArray<Sweeper>) =>
  Effect.gen(function* () {
    const remove: CleanupItem[] = [];
    const keep: CleanupKept[] = [];
    for (const sweeper of sweepers) {
      const judged = yield* sweeper.judge;
      remove.push(...judged.remove);
      keep.push(...judged.keep);
    }
    return { remove, keep, bytes: total(remove) } satisfies CleanupReport;
  });

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
export const sweep = (sweepers: ReadonlyArray<Sweeper>, stateDir: string, by: SweptBy) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const journal = path.join(stateDir, JOURNAL);
    const removed: CleanupItem[] = [];
    const keep: CleanupKept[] = [];
    for (const sweeper of sweepers) {
      const judged = yield* sweeper.judge;
      keep.push(...judged.keep);
      for (const item of judged.remove) {
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
  });

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

/** Worktrees Collie made, judged by the settled rule in `worktree.ts`. */
export const worktreesSweeper = (opts: {
  herdr: Herdr;
  sessions: ReadonlyArray<Herdr>;
  stateDir: string;
  runs: ReadonlyArray<RunFacts>;
  registered: ReadonlyArray<AgentEntry>;
  cwd: string;
}): Sweeper => {
  const kind = "worktree";
  return {
    judge: Effect.gen(function* () {
      const round = yield* judgeWorktrees({ ...opts, dryRun: true });
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
        const round = yield* judgeWorktrees({ ...opts, only: item.target });
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
  "installation",
  "installation.new",
  "worktrees.json",
  "worktrees.json.lock",
  JOURNAL,
  "cleanup",
  "settings",
  "tasks",
  "herd",
  "board",
  "steering",
  "compaction",
  "compaction-locks",
  "generations",
  "renovate-repositories",
  "claude.json.bak",
]);
const MARKER = /^(?:stop|hold|parked|notified)\.(.+)$/;
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
        if (KEPT_KINDS.has(top) || /^worktree-[0-9a-f]+\.lock$/.test(top)) return null;
        if (top === "runs" || top === "agents" || top === "evidence" || top === "requests")
          return null;
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
        const ledger = `${target}/deliveries.jsonl`;
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
 * Compaction controls of agents no herdr session lists: their endpoint stopped and their
 * state removed. Nothing is judged where herdr will not list its agents.
 */
export const compactionSweeper = (stateDir: string, sessions: ReadonlyArray<Herdr>): Sweeper => {
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
    judge: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
      const live = yield* listed;
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const name of names) {
        const target = `${root}/${name}`;
        if (live === null) keep.push({ kind, target, reason: "could not ask herdr what is live" });
        else if (!live.has(name))
          remove.push({ kind, target, bytes: 0, reason: "herdr no longer lists its agent" });
      }
      const sizes = yield* sizesOf(remove.map((item) => item.target));
      return { remove: remove.map((item, at) => ({ ...item, bytes: sizes[at] ?? 0 })), keep };
    }),
    remove: (item) =>
      Effect.gen(function* () {
        const live = yield* listed;
        const name = item.target.slice(root.length + 1);
        if (live === null) return { kept: "could not ask herdr what is live" };
        if (live.has(name)) return { kept: "herdr lists its agent again" };
        const bytes = yield* sizeOf(item.target);
        const done = yield* putDownControl(
          { stateDir, log: () => Effect.void },
          name,
          Effect.map(listed, (now) => now === null || now.has(name)),
        ).pipe(Effect.orElseSucceed(() => false));
        return done ? { freed: bytes } : { kept: "its controls are in use" };
      }),
  };
};

/** Runner copies under `~/.cache/collie/runners`, but the running version's and the newest. */
export const runnersSweeper = (dir: string, running: string): Sweeper => {
  const kind = "runner";
  const versionOf = (name: string) => /^collie-(.+)$/.exec(name)?.[1] ?? null;
  const newer = (a: string, b: string) => {
    const [x, y] = [a, b].map((v) =>
      v.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0),
    );
    for (let at = 0; at < Math.max(x!.length, y!.length); at++)
      if ((x![at] ?? 0) !== (y![at] ?? 0)) return (x![at] ?? 0) > (y![at] ?? 0);
    return false;
  };
  const verdicts = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))).filter(
      (name) => versionOf(name) !== null,
    );
    const versions = names.map((name) => versionOf(name)!);
    const newest = versions.reduce<string | null>(
      (best, v) => (best === null || newer(v, best) ? v : best),
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

const LaunchedTerminal = Schema.fromJsonString(
  Schema.Struct({ terminalId: Schema.optionalKey(Schema.String) }),
);

/** The terminals of every agent `runs` launched, from their launch records. */
const launchedTerminals = (stateDir: string, runs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const terminals = new Set<string>();
    for (const run of runs) {
      const dir = `${stateDir}/agents/${run}`;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names.filter((one) => one.endsWith(".launch.json"))) {
        const text = yield* fs
          .readFileString(`${dir}/${name}`)
          .pipe(Effect.orElseSucceed(() => ""));
        const launched = Schema.decodeUnknownOption(LaunchedTerminal)(text);
        if (Option.isSome(launched) && launched.value.terminalId !== undefined)
          terminals.add(launched.value.terminalId);
      }
    }
    return terminals;
  });

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
}): Sweeper => {
  const kind = "workspace";
  const named = new Map<string, number>();
  for (const task of opts.tasks) named.set(task.workspace, (named.get(task.workspace) ?? 0) + 1);

  /** The session a Task's workspace is in: its recorded Herd's, else the first. */
  const sessionOf = (task: TaskRecord) =>
    opts.sessions.find((one) => one.herd !== null && one.herd === task.herd) ?? opts.sessions[0];

  /** What becomes of one Task's workspace now, or null where it has none open to close. */
  const verdict = (
    task: TaskRecord,
  ): Effect.Effect<
    { keep: string } | { remove: string; terminals: ReadonlySet<string> } | null,
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
      const terminals = yield* launchedTerminals(
        opts.stateDir,
        opts.runs.filter((run) => run.task === task.id).map((run) => run.id),
      );
      const foreign = panes.value.find(
        (pane) =>
          pane.workspaceId === task.workspace &&
          pane.paneId !== task.root_pane &&
          (pane.terminalId === null || !terminals.has(pane.terminalId)),
      );
      if (foreign !== undefined)
        return { keep: `holds a pane Collie did not open (${foreign.paneId})` };
      return { remove: `Finished ${minutes} min ago`, terminals };
    });

  const taskAt = (target: string) => opts.tasks.find((task) => task.workspace === target);

  return {
    judge: Effect.gen(function* () {
      const remove: CleanupItem[] = [];
      const keep: CleanupKept[] = [];
      for (const task of opts.tasks) {
        const judged = yield* verdict(task);
        if (judged === null) continue;
        if ("keep" in judged) keep.push({ kind, target: task.workspace, reason: judged.keep });
        else remove.push({ kind, target: task.workspace, bytes: 0, reason: judged.remove });
      }
      return { remove, keep };
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
        const closed = yield* session.herdr.workspaceClose(task.workspace).pipe(Effect.result);
        if (closed._tag === "Failure") return { kept: herdrFailureReason(closed.failure) };
        // Its agents left in another workspace go with it, matched by terminal as a stop does.
        for (const other of opts.sessions) {
          const panes = yield* other.herdr.paneList().pipe(Effect.orElseSucceed(() => []));
          for (const pane of panes)
            if (pane.terminalId !== null && judged.terminals.has(pane.terminalId))
              yield* other.herdr.paneClose(pane.paneId).pipe(Effect.ignore);
        }
        return { freed: 0 };
      }),
  };
};
