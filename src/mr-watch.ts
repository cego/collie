import * as Str from "effect/String";
import { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import type { MrDetails } from "./board-model";
import type { MrPanels } from "./merges";
import { judge } from "./mr-watch-model";
import type { MrReading, Observed, Woke } from "./mr-watch-model";
import type { WatchEvent } from "./watch-journal";
import { nowIso } from "./time";
import type { WatchRow } from "./store";

export interface Watches {
  readonly outstanding: Effect.Effect<ReadonlyArray<WatchRow>>;
  readonly still: (run: string, name: string) => Effect.Effect<boolean>;
  readonly observe: (run: string, name: string, observed: Observed) => Effect.Effect<void>;
  readonly wake: (run: string, name: string, woke: Woke) => Effect.Effect<boolean>;
  readonly unavailable: (run: string, name: string, reason: string) => Effect.Effect<void>;
}

export const readingOf: (panel: MrDetails) => MrReading = (panel) => {
  const state = Str.toLowerCase(panel.state);
  return {
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    head: panel.head ?? "",
    pipeline: panel.checks?.state ?? "unknown",
    comments: panel.comments ?? [],
  };
};

const sameObserved = (one: Observed | null, other: Observed) =>
  one !== null &&
  one.head === other.head &&
  one.since === other.since &&
  one.running === other.running;

export const settleWatches = Effect.fn("MrWatch.settle")(function* (opts: {
  readonly panels: MrPanels;
  readonly now: number;
  readonly rows: ReadonlyArray<WatchRow>;
  readonly watches: Watches;
  event?: (event: WatchEvent) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
}) {
  const event: (
    event: WatchEvent,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =
    opts.event ?? (() => Effect.void);
  const record = (row: WatchRow, woke: Woke) =>
    Effect.flatMap(nowIso, (at) =>
      event(
        woke._tag === "Ended"
          ? { _tag: "ended", at, mr: row.mr, run: row.run, name: row.name, why: woke.state }
          : {
              _tag: "woke",
              at,
              mr: row.mr,
              run: row.run,
              name: row.name,
              head: woke.change.head,
              previous: woke.change.previous,
              newHead: woke.change.newHead,
            },
      ),
    );
  for (const row of opts.rows) {
    // WARNING: an earlier round's or host's wake may not have reached the Run.
    if (row.woke !== null) {
      if (!(yield* opts.watches.still(row.run, row.name))) {
        continue;
      }
      if (yield* opts.watches.wake(row.run, row.name, row.woke)) {
        yield* record(row, row.woke);
      }
      continue;
    }
    const read = opts.panels.get(row.mr)?.panel;
    if (
      read?._tag === "Unavailable" &&
      read.transient &&
      (yield* opts.watches.still(row.run, row.name))
    ) {
      yield* opts.watches.unavailable(row.run, row.name, read.reason);
    }
    if (read?._tag !== "Details") {
      continue;
    }
    const { verdict, observed } = judge({
      cursor: row.cursor,
      run: row.run,
      observed: row.observed,
      reading: readingOf(read),
      now: opts.now,
    });
    const at = yield* nowIso;
    // WARNING: each write asks again: a Stop landing while an earlier row's answer was written beats this one.
    if (!sameObserved(row.observed, observed) && (yield* opts.watches.still(row.run, row.name))) {
      yield* opts.watches.observe(row.run, row.name, observed);
      yield* event({
        _tag: "observed",
        at,
        mr: row.mr,
        run: row.run,
        name: row.name,
        head: observed.head,
        since: observed.since,
      });
    }
    if (verdict._tag === "Changed" && (yield* opts.watches.wake(row.run, row.name, verdict))) {
      yield* record(row, verdict);
    }
    if (verdict._tag === "Ended" && (yield* opts.watches.wake(row.run, row.name, verdict))) {
      yield* record(row, verdict);
    }
  }
});
