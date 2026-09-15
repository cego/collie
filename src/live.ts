// What the Home board's Live region shows, and what a row's marks say: cards, drift,
// deliveries and the proposals waiting on an answer, read from the journals the rest of
// steering writes.
//
// Read-only, and that is the discipline. Nothing here writes, delivers, resolves or
// focuses anything: a card arriving must never move a human off what they are doing, and
// an undelivered report is shown as undelivered rather than being delivered by the act of
// looking at it. Nothing is inferred either — a Run no journal says anything about gets no
// marks, rather than the reassuring ones a "clean" default would invent.

import { Clock, Effect, Path, Schema } from "effect";
import { newest, readCards, type Card } from "./cards";
import type { Marks, RunMarks } from "./lines";
import { openReports, readDrift } from "./drift";
import { capabilitiesOf } from "./steering-caps";
import { DriftReportSchema, type DriftReport } from "./evaluator";
import { readIntent } from "./intent";
import { readJournal } from "./journal";
import {
  newsPath,
  pending as pendingNews,
  read as readNews,
  uncertain as uncertainNews,
} from "./news";
import {
  pendingFor,
  pendingHerdWide,
  proposalsPath,
  read as readProposals,
  type ProposalRecord,
} from "./proposals";
import {
  deliveriesOf,
  herdOf,
  herdDir,
  ledgerFiles,
  newestById,
  overrideActive,
  readLedger,
  type Delivery,
} from "./steering";

/** How many cards the region draws. Newest first, and a screen's worth is the point. */
const CARDS = 5;
/** Everything the Live region draws, for whatever the board is looking at. */
export interface Live {
  /** The Run this is about, or null for the Herd's newest cards. */
  run: string | null;
  cards: Card[];
  drift: DriftReport[];
  deliveries: Delivery[];
  /** Waiting on the human: the Selection's own, and the Herd's, which are about no Run. */
  proposals: ProposalRecord[];
  /**
   * Reports about a Run that had already finished when they were judged. Never written
   * to that Run's inbox — there is no consumer, and the Run is immutable — so the board
   * is where they are said out loud, as undelivered (SPEC §9.5).
   */
  pending: DriftReport[];
  /**
   * The Home's ownership question, when Collie has refused to settle one. Passed in
   * rather than read here: it is a herdr answer, not a journal.
   */
  ownership: { readonly why: string; readonly candidates: ReadonlyArray<string> } | null;
  /**
   * What Collie has noticed that has not reached the conversation: how many items are
   * waiting, and how many of those nobody can account for having sent. Drawn because a
   * chat that cannot be pushed to — Claude, on an installation without channels — leaves
   * news waiting for its next turn, and a human should be able to see that it is waiting
   * rather than discover it by asking.
   */
  news: { readonly waiting: number; readonly uncertain: number };
}

/** A Run, as little of it as the reads below need. */
export interface LiveRun {
  id: string;
  dir: string;
}

const DriftJson = Schema.fromJsonString(DriftReportSchema);

export const pendingReportsPath = Effect.fn("Live.pendingReportsPath")(function* (
  stateDir: string,
  herdKey: string,
  run: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, herdKey), "pending-reports", `${run}.jsonl`);
});

export const readPendingReports = Effect.fn("Live.readPendingReports")(function* (
  stateDir: string,
  herdKey: string,
  run: string,
) {
  return yield* readJournal(yield* pendingReportsPath(stateDir, herdKey, run), DriftJson);
});

/**
 * The Herd this state dir belongs to, or null when there is no herdr to ask. Null rather
 * than a failure: a board is worth drawing without the Herd-wide journals, and inventing
 * a key from a cwd is exactly what keys two sessions to one Herd.
 */
const herdOrNull = (socketPath: string | null) =>
  herdOf(socketPath).pipe(Effect.catch(() => Effect.succeed(null)));

/** What a row's marks are read from: the Run, and the two things its record says. */
export interface MarkedRun extends LiveRun {
  /** The Run's `awaiting`, which is what says it has been held. */
  awaiting: string | null;
  /** The harnesses this Run's agents are on: attribution is a per-harness capability. */
  harnesses: ReadonlyArray<string>;
}

export interface BoardLive {
  /** The Live region, or null where nothing on screen is drawing one. */
  readonly live: Live | null;
  /** One entry per Run there is something to say about, and none for the rest. */
  readonly marks: Marks;
}

/**
 * What the board knows right now: the Live region, and every row's marks.
 *
 * One answer rather than two, because the two are read from the same files. A tick used
 * to ask separately and so resolved the Herd twice, read the proposals journal twice, and
 * read each Run's cards twice — the marks for all of them, the region for the Herd-wide
 * cards — which is the cost the board's one shared run scan exists to avoid.
 *
 * The region is the Selection's own cards, drift and deliveries, or the Herd's newest
 * cards when nothing is selected: a board nobody has moved the cursor on still has to
 * say what has been happening. The marks are facts, not a verdict: a mark is what makes
 * a row worth selecting, so a Run nobody has found anything about must not carry one.
 */
export const liveFor = Effect.fn("Live.for")(function* (opts: {
  stateDir: string;
  socketPath: string | null;
  /** The Selection's Run, where one is selected. */
  run: LiveRun | null;
  /** Every Run on the board: what the marks are for, and the Herd-wide cards. */
  runs: ReadonlyArray<MarkedRun>;
  ownership: Live["ownership"];
  /** Whether the Live region is on screen. The marks are read either way. */
  region: boolean;
}) {
  const now = yield* Clock.currentTimeMillis;
  const key = yield* herdOrNull(opts.socketPath);
  const proposalFile = key === null ? null : yield* proposalsPath(opts.stateDir, key);
  const lines = proposalFile === null ? [] : yield* readProposals(proposalFile);
  const overridden = yield* runsUnderOverride(opts.stateDir);

  // One read of each Run's own journals, kept for whichever of the two wants it.
  const cardsOf = new Map<string, Card[]>();
  const marks: Record<string, RunMarks> = {};
  for (const run of opts.runs) {
    const cards = yield* readCards(run.dir);
    cardsOf.set(run.id, cards);
    const mark: RunMarks = {
      // The newest card's own significance, decided by rules when it was written: the
      // board does not re-rank what a card already says about itself.
      tryIt: newest(cards).at(-1)?.significance === "try-it",
      drift: openReports(yield* readDrift(run.dir)).length > 0,
      held: run.awaiting === "hold",
      override: overridden.has(run.id),
      unattributed: yield* unattributed(run),
      proposal: pendingFor(lines, run.id, now).length > 0,
    };
    if (Object.values(mark).some((set) => set)) marks[run.id] = mark;
  }
  // The region is drawn by the app's Runs view and the text board, and by nothing else:
  // a View that will not look at it is not worth the Herd's journals.
  let live: Live | null = null;
  if (opts.region) {
    const newsLines = key === null ? [] : yield* readNews(yield* newsPath(opts.stateDir, key));
    const news = {
      waiting: pendingNews(newsLines).items.length,
      uncertain: uncertainNews(newsLines).length,
    };
    // Waiting on the human and about no Run: an upgrade, a cleanup, a fork, a change to a
    // workspace's defaults. Drawn whatever the Selection is, because there is no row they
    // would otherwise appear under, and a proposal nothing draws expires unseen.
    const herdWide = pendingHerdWide(lines, now);
    const one = opts.run;
    if (one === null) {
      const cards: Card[] = [];
      for (const run of opts.runs) cards.push(...(cardsOf.get(run.id) ?? []));
      live = {
        news,
        run: null,
        cards: newest(cards).slice(-CARDS).reverse(),
        drift: [],
        deliveries: [],
        proposals: herdWide,
        pending: [],
        ownership: opts.ownership,
      };
    } else {
      // The Selection may be a History row, off the board and so without marks of its own.
      const own = cardsOf.get(one.id) ?? (yield* readCards(one.dir));
      live = {
        news,
        run: one.id,
        cards: newest(own).slice(-CARDS).reverse(),
        drift: openReports(yield* readDrift(one.dir)),
        deliveries: (yield* deliveriesOf(opts.stateDir, one.id)).map((found) => found.delivery),
        proposals: [...pendingFor(lines, one.id, now), ...herdWide],
        pending: key === null ? [] : yield* readPendingReports(opts.stateDir, key, one.id),
        ownership: opts.ownership,
      };
    }
  }
  return { live, marks } satisfies BoardLive;
});

/**
 * Whether this Run's rows must carry the attribution disclosure: `auto_correct` is
 * granted, `exclusive_steering` is what makes it honourable at all, and one of its agents
 * is on a harness where an external submission is invisible. Permanent while all three
 * hold — it is what SPEC §7.5 pairs with correcting a Run nobody can prove they own.
 */
const unattributed = Effect.fn("Live.unattributed")(function* (run: MarkedRun) {
  if (run.harnesses.length === 0) return false;
  const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
  if (intent === null) return false;
  const { auto_correct, exclusive_steering } = intent.authority;
  if (!auto_correct || !exclusive_steering) return false;
  // A harness Collie has no row for is one nothing has been shown about, which is the
  // same answer as `unproven` and never a reason to say nothing.
  return run.harnesses.some((harness) => capabilitiesOf(harness)?.attribution?.status !== "proven");
});

/**
 * The Runs a human has typed at behind Collie's back. An override is recorded against an
 * incarnation, so which Runs it is about is what that incarnation was delivered for —
 * which is the ledger's own answer rather than a second index of it.
 */
const runsUnderOverride = Effect.fn("Live.runsUnderOverride")(function* (stateDir: string) {
  const runs = new Set<string>();
  for (const file of yield* ledgerFiles(stateDir)) {
    const lines = yield* readLedger(file);
    if (!overrideActive(lines)) continue;
    for (const delivery of newestById(lines).values()) runs.add(delivery.run);
  }
  return runs;
});
