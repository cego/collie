// The Runs waiting on a merge request, judged on each round of the merge watch from what it
// read, and woken by it: no read of their own.

import * as Str from "effect/String";
import { Effect } from "effect";
import type { MrDetails } from "./board-model";
import type { MrPanels } from "./merges";
import { judge, type MrReading, type Observed, type Woke } from "./mr-watch-model";
import type { WatchRow } from "./store";

/** What a watch round reads and writes, the host's. */
export interface Watches {
  readonly list: (mrs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<WatchRow>>;
  readonly observe: (run: string, name: string, observed: Observed) => Effect.Effect<void>;
  readonly wake: (run: string, name: string, woke: Woke) => Effect.Effect<void>;
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

/** One round over the watches of the merge requests the merge watch has read. */
export const settleWatches = Effect.fn("MrWatch.settle")(function* (opts: {
  readonly panels: MrPanels;
  readonly now: number;
  readonly watches: Watches;
}) {
  for (const row of yield* opts.watches.list([...opts.panels.keys()])) {
    // Woken by an earlier round or host whose wake may not have reached the Run.
    if (row.woke !== null) {
      yield* opts.watches.wake(row.run, row.name, row.woke);
      continue;
    }
    const read = opts.panels.get(row.mr)?.panel;
    if (read?._tag !== "Details") continue;
    const { verdict, observed } = judge({
      cursor: row.cursor,
      observed: row.observed,
      reading: readingOf(read),
      now: opts.now,
    });
    if (!sameObserved(row.observed, observed))
      yield* opts.watches.observe(row.run, row.name, observed);
    if (verdict._tag === "Changed" || verdict._tag === "Ended")
      yield* opts.watches.wake(row.run, row.name, verdict);
  }
});
