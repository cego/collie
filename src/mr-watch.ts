// The Runs waiting on a merge request, judged on each round of the merge watch from what it
// read, and woken by it: no read of their own.

import * as Str from "effect/String";
import { Effect, type FileSystem, type Path } from "effect";
import type { MrDetails } from "./board-model";
import type { MrPanels } from "./merges";
import { judge, type MrReading, type Observed, type Woke } from "./mr-watch-model";
import type { WatchEvent } from "./watch-journal";
import { nowIso } from "./time";
import type { WatchRow } from "./store";

/** What a watch round reads and writes, the host's. */
export interface Watches {
  /** Every watch a Run is still waiting on, whatever a board shows of its Task. */
  readonly outstanding: Effect.Effect<ReadonlyArray<WatchRow>>;
  readonly observe: (run: string, name: string, observed: Observed) => Effect.Effect<void>;
  readonly wake: (run: string, name: string, woke: Woke) => Effect.Effect<void>;
  readonly unavailable: (run: string, reason: string) => Effect.Effect<void>;
}

/** What the merge watch read of a merge request, as a watch judges it. */
export const readingOf = (panel: MrDetails): MrReading => {
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

/** One round over the watches a Run is still waiting on. */
export const settleWatches = Effect.fn("MrWatch.settle")(function* (opts: {
  readonly panels: MrPanels;
  readonly now: number;
  /** The watches still demanding their merge request, which Hold and Stop take away. */
  readonly rows: ReadonlyArray<WatchRow>;
  readonly watches: Watches;
  /** Where each sighting, wake and ending is written down for a replay. */
  event?: (event: WatchEvent) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
}) {
  const event: (
    event: WatchEvent,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =
    opts.event ?? (() => Effect.void);
  for (const row of opts.rows) {
    // Woken by an earlier round or host whose wake may not have reached the Run.
    if (row.woke !== null) {
      yield* opts.watches.wake(row.run, row.name, row.woke);
      continue;
    }
    const read = opts.panels.get(row.mr)?.panel;
    if (read?._tag === "Unavailable" && read.transient)
      yield* opts.watches.unavailable(row.run, read.reason);
    if (read?._tag !== "Details") continue;
    const { verdict, observed } = judge({
      cursor: row.cursor,
      run: row.run,
      observed: row.observed,
      reading: readingOf(read),
      now: opts.now,
    });
    const at = yield* nowIso;
    if (!sameObserved(row.observed, observed)) {
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
    if (verdict._tag === "Changed") {
      yield* event({
        _tag: "woke",
        at,
        mr: row.mr,
        run: row.run,
        name: row.name,
        head: verdict.change.head,
        previous: verdict.change.previous,
        newHead: verdict.change.newHead,
      });
      yield* opts.watches.wake(row.run, row.name, verdict);
    }
    if (verdict._tag === "Ended") {
      yield* event({
        _tag: "ended",
        at,
        mr: row.mr,
        run: row.run,
        name: row.name,
        why: verdict.state,
      });
      yield* opts.watches.wake(row.run, row.name, verdict);
    }
  }
});
