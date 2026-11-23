import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Schema } from "effect";
import { Significance, mrWords, readMrRef } from "./board-model";
import { forgeOf } from "./forge/forge";
import { appendRunJournal, lastRunJournal, readRunJournal, runJournal } from "./journal";
import { redact } from "./redact";
import { RunRecords, runOfDir } from "./run-records";
import { sameTree, type Verification } from "./verify";
import { ProducerReport, reportFields } from "./narrative-model";

const RevisionSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  fingerprint: Schema.String,
  dirty: Schema.Boolean,
});

export const CardSchema = Schema.Struct({
  ...ProducerReport.fields,
  id: Schema.String,
  run: Schema.String,
  kind: Schema.Literals(["slice", "review", "fix-round", "mr", "final", "followup", "hold"]),
  at: Schema.String,
  step: Schema.String,
  iteration: Schema.Int,
  intent_version: Schema.Int,
  revision: RevisionSchema,
  changes: Schema.Struct({
    files: Schema.Array(Schema.String),
    commits: Schema.Array(Schema.String),
  }),
  requested: Schema.Struct({
    goal: Schema.NullOr(Schema.String),
    constraints: Schema.Array(Schema.String),
    tickets: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ file: Schema.String, title: Schema.String, done: Schema.Boolean }),
      ),
    ),
  }),
  readiness: Schema.Literals(["claimed", "inspect-ready", "verified"]),
  verifications: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      result: Schema.Literals(["pass", "fail", "unstable", "stale"]),
      ref: Schema.String,
    }),
  ),
  claims: Schema.Array(Schema.Struct({ text: Schema.String, ref: Schema.String })),
  missing: Schema.Array(Schema.String),
  inspect: Schema.Array(
    Schema.Struct({ what: Schema.String, how: Schema.String, note: Schema.String }),
  ),
  links: Schema.Struct({
    mr: Schema.optionalKey(Schema.String),
    review_md: Schema.optionalKey(Schema.String),
    plan_dir: Schema.optionalKey(Schema.String),
    artifacts: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  drift: Schema.Array(Schema.String),
  deliveries: Schema.Array(Schema.String),
  narrative: Schema.NullOr(Schema.String),
  aligned: Schema.Literals(["true", "false", "unverified"]),
  cross_run: Schema.Literals(["evaluated", "pending", "none"]),
  significance: Significance,
});
export type Card = Schema.Schema.Type<typeof CardSchema>;
const CardJson = Schema.fromJsonString(CardSchema);

export const cardsPath = (runDir: string) => runJournal(runDir, "steering/cards.jsonl");

export const appendCard = Effect.fn("Cards.append")(function* (runDir: string, card: Card) {
  yield* appendRunJournal(cardsPath(runDir), CardJson, card);
});

export const readCards = Effect.fn("Cards.read")(function* (runDir: string) {
  return yield* readRunJournal(cardsPath(runDir), CardJson);
});

export const readFinalCard = Effect.fn("Cards.final")(function* (runDir: string) {
  return yield* lastRunJournal(cardsPath(runDir), CardJson, ["final"]);
});

// WARNING: read from the final card the finish writes, which the host records without the Run's module; null where stopped.
export const finishedOnRecord = Effect.fn("Cards.finishedOnRecord")(function* (runDir: string) {
  return Option.getOrUndefined(yield* readFinalCard(runDir))?.at ?? null;
});

export function newest(cards: ReadonlyArray<Card>) {
  const latest = new Map<string, Card>();
  for (const card of cards) latest.set(`${card.step}#${card.iteration}#${card.kind}`, card);
  return [...latest.values()];
}

// WARNING: decided by the step's role, never its name; review-the-docs done by an implementer is not a review.
export const REVIEW_ROLE = "reviewer";

export function kindForRole(role: string | null | undefined) {
  return role === REVIEW_ROLE ? "review" : "slice";
}

export interface ReadinessFacts {
  readonly claimed: boolean;
  readonly changed: boolean;
  readonly verifiedHere: boolean;
}

// WARNING: a verification on another revision does not verify this card; that is what stale is for.
export function readiness(facts: ReadinessFacts) {
  if (facts.verifiedHere && facts.changed) return "verified";
  if (facts.changed && facts.claimed) return "inspect-ready";
  return "claimed";
}

export interface SignificanceFacts {
  readonly readiness: Card["readiness"];
  readonly mrTouched: boolean;
  readonly pendingChoice: boolean;
  readonly driftUnresolved: boolean;
  readonly pendingProposal: boolean;
  readonly correctionUnacknowledged: boolean;
  readonly blockingDrift: boolean;
  readonly correctionSent: boolean;
  readonly intentChanged: boolean;
  readonly ended: "failed" | "stopped" | null;
}

// WARNING: decided by rules over facts, never model text; decision outranks consequential because the human is being waited on.
export function significance(facts: SignificanceFacts) {
  if (
    facts.pendingChoice ||
    facts.driftUnresolved ||
    facts.pendingProposal ||
    facts.correctionUnacknowledged
  )
    return "decision";
  if (facts.blockingDrift || facts.correctionSent || facts.intentChanged || facts.ended !== null)
    return "consequential";
  if (facts.readiness !== "claimed" || facts.mrTouched) return "try-it";
  return "routine";
}

export function verificationOn(
  verification: Verification,
  revision: { readonly head_sha: string; readonly fingerprint: string },
) {
  const here = sameTree(verification.end, revision);
  const returned: Card["verifications"][number] = {
    id: verification.id,
    name: verification.name,
    result: here ? verification.result : "stale",
    ref: verification.id,
  };
  return returned;
}

// WARNING: text for a human's own shell, never executed; a card that ran it would change what it describes.
export function inspectFor(options: {
  readonly worktree: string | null;
  readonly base: string;
  readonly mr: string | null;
}) {
  const entries: Array<Card["inspect"][number]> = [];
  if (options.worktree !== null)
    entries.push({
      what: "what changed",
      how: `git -C ${options.worktree} diff ${options.base}..HEAD`,
      note: "the whole change, as it stands",
    });
  const mr = options.mr === null ? null : readMrRef(options.mr);
  if (mr !== null)
    entries.push({
      what: `the ${mrWords(mr).noun}`,
      how: forgeOf(mr).review(mr).view,
      note: "what the reviewers will read",
    });
  return entries;
}

export function clean(card: Card) {
  return {
    ...card,
    claims: Arr.map(card.claims, (claim) => ({ ...claim, text: redact(claim.text) })),
    missing: Arr.map(card.missing, redact),
    narrative: card.narrative === null ? null : redact(card.narrative),
  };
}

export interface CardSources {
  readonly summary?: string;
  readonly blocker?: string;
  readonly next_action?: string;
  readonly report?: Card["report"];
  readonly run: string;
  readonly kind: Card["kind"];
  readonly step: string;
  readonly iteration: number;
  readonly at: string;
  readonly intentVersion: number;
  readonly revision: Card["revision"];
  readonly changes: Card["changes"];
  readonly requested: Card["requested"];
  readonly verifications: ReadonlyArray<Verification>;
  readonly claims: Card["claims"];
  readonly missing: ReadonlyArray<string>;
  readonly inspect: Card["inspect"];
  readonly links: Card["links"];
  readonly drift: ReadonlyArray<string>;
  readonly deliveries: ReadonlyArray<string>;
  readonly aligned: Card["aligned"];
  readonly crossRun: Card["cross_run"];
  readonly significance: SignificanceFacts;
  readonly narrative: string | null;
}

// WARNING: readiness and significance are computed here, so a caller cannot hand in a card that says verified.
export function buildCard(sources: CardSources) {
  const verifications = Arr.map(sources.verifications, (entry) =>
    verificationOn(entry, sources.revision),
  );
  const ready = readiness({
    claimed: sources.claims.length > 0,
    changed: sources.changes.files.length > 0 || sources.revision.dirty,
    verifiedHere: Arr.some(verifications, (entry) => entry.result === "pass"),
  });
  return clean({
    ...reportFields(sources),
    id: `card-${Bun.hash(`${sources.run}${sources.step}${sources.iteration}${sources.kind}${sources.at}`).toString(16)}`,
    run: sources.run,
    kind: sources.kind,
    at: sources.at,
    step: sources.step,
    iteration: sources.iteration,
    intent_version: sources.intentVersion,
    revision: sources.revision,
    changes: sources.changes,
    requested: sources.requested,
    readiness: ready,
    verifications,
    claims: [...sources.claims],
    missing: [...sources.missing],
    inspect: [...sources.inspect],
    links: sources.links,
    drift: [...sources.drift],
    deliveries: [...sources.deliveries],
    narrative: sources.narrative,
    aligned: sources.aligned,
    cross_run: sources.crossRun,
    significance: significance({ ...sources.significance, readiness: ready }),
  });
}

const CheckpointSchema = Schema.Struct({
  ticket: Schema.String,
  status: Schema.Literals(["started", "done"]),
  claims: Schema.Array(Schema.String),
  at: Schema.String,
});
export type Checkpoint = Schema.Schema.Type<typeof CheckpointSchema>;
const CheckpointJson = Schema.fromJsonString(CheckpointSchema);

const PROGRESS = "steering/progress/";

export const readCheckpoints = Effect.fn("Cards.readCheckpoints")(function* (runDir: string) {
  const rows = yield* RunRecords.use((records) => records.factsUnder(runOfDir(runDir), PROGRESS));
  return Arr.flatMap(rows, (row) =>
    pipe_(
      Schema.decodeOption(CheckpointJson)(row.data),
      Option.match({
        onNone: () => [],
        onSome: (checkpoint) => [{ file: `${runDir}/${row.name}`, checkpoint }],
      }),
    ),
  );
});

export const writeCheckpoint = (runDir: string, checkpoint: Checkpoint) =>
  Schema.encodeEffect(CheckpointJson)(checkpoint).pipe(
    Effect.orDie,
    Effect.flatMap((text) =>
      RunRecords.use((records) =>
        records.put(
          runOfDir(runDir),
          `${PROGRESS}${pipe_(checkpoint.ticket, Str.replace(/\.md$/, ""))}.json`,
          text,
        ),
      ),
    ),
  );
