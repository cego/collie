import * as Str from "effect/String";
import { Effect } from "effect";
import type { MrDetails } from "./board-model";
import type { MrPanels } from "./merges";
import { judge, type MrReading, type Observed, type Woke } from "./mr-watch-model";
import type { WatchRow } from "./store";

export interface Watches {
  readonly list: (mrs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<WatchRow>>;
  readonly observe: (run: string, name: string, observed: Observed) => Effect.Effect<void>;
  readonly wake: (run: string, name: string, woke: Woke) => Effect.Effect<void>;
  readonly unavailable: (run: string, reason: string) => Effect.Effect<void>;
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
  readonly watches: Watches;
}) {
  for (const row of yield* opts.watches.list([...opts.panels.keys()])) {
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
    if (!sameObserved(row.observed, observed))
      yield* opts.watches.observe(row.run, row.name, observed);
    if (verdict._tag === "Changed" || verdict._tag === "Ended")
      yield* opts.watches.wake(row.run, row.name, verdict);
  }
});
