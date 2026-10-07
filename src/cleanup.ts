// Cleanup: what Collie removes once nothing needs it, and only what it made and can show it
// made (ADR-0045). Each kind of thing is a sweeper that judges what it would remove and
// keep, and removes one item only after judging it again. A listing is every judge; a
// sweep is every judge, then every removal, each written to `cleanup.jsonl`.

import { Clock, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import {
  FrontDoor,
  Where,
  type CleanupItem,
  type CleanupKept,
  type CleanupReport,
} from "./board-model";
import type { Herdr } from "./herdr";
import { appendJournal, readJournal } from "./journal";
import { shell } from "./mr";
import type { AgentEntry } from "./registry";
import type { RunFacts } from "./runs";
import { epochMs, nowIso } from "./time";
import { judgeWorktrees } from "./worktree";

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

/** Where module generations are staged, as the engine stages them. */
export const generationsDir = () => {
  const cache = Bun.env.XDG_CACHE_HOME || `${Bun.env.HOME ?? Bun.env.TMPDIR ?? "/tmp"}/.cache`;
  return `${cache}/collie/entries/generations`;
};

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
