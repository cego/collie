// One slice of work, as a human would want it handed to them: what was asked for, what
// changed, what backs that up, and what nobody checked.
//
// The discipline is in `readiness` and `significance`. Readiness says how far the evidence
// goes — an agent's claim, a change you could look at, or a verification bound to this
// exact tree — and never further than it goes. Significance says whether this is worth
// interrupting a human for, and it is decided by **rules over facts**: a card is not more
// important because the narrative sounds urgent, and there is no path here by which a
// model raises its own priority.
//
// Nothing in this file focuses anything. A card arriving must never move a human off what
// they are doing; the only thing that still takes focus is a pending question.

import { Effect, FileSystem, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";
import { redact } from "./conversation";
import type { Verification } from "./verify";

const RevisionSchema = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  fingerprint: Schema.String,
  dirty: Schema.Boolean,
});

const CardSchema = Schema.Struct({
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
  /** What an agent said. Always here, never among the verifications. */
  claims: Schema.Array(Schema.Struct({ text: Schema.String, ref: Schema.String })),
  /** What nobody checked. The half of a card that is usually missing from a report. */
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
  significance: Schema.Literals(["routine", "try-it", "decision", "consequential"]),
});
export type Card = Schema.Schema.Type<typeof CardSchema>;
const CardJson = Schema.fromJsonString(CardSchema);

export const cardsPath = Effect.fn("Cards.path")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, "steering", "cards.jsonl");
});

export const appendCard = Effect.fn("Cards.append")(function* (runDir: string, card: Card) {
  yield* appendJournal(yield* cardsPath(runDir), CardJson, card);
});

export const readCards = Effect.fn("Cards.read")(function* (runDir: string) {
  return yield* readJournal(yield* cardsPath(runDir), CardJson);
});

/** The newest card per slice of work: a re-written card replaces the one it re-writes. */
export function newest(cards: ReadonlyArray<Card>): Card[] {
  const latest = new Map<string, Card>();
  for (const card of cards) latest.set(`${card.step}#${card.iteration}#${card.kind}`, card);
  return [...latest.values()];
}

/**
 * The role whose work is a review. A workflow declares its steps' roles, and that is the
 * domain fact a card is built from: a step called anything at all is a review when a
 * reviewer did it, and one called `review-the-docs` done by an implementer is not.
 */
export const REVIEW_ROLE = "reviewer";

/** Which card the work of this role writes. */
export function kindForRole(role: string | null | undefined): Card["kind"] {
  return role === REVIEW_ROLE ? "review" : "slice";
}

export interface ReadinessFacts {
  /** An agent said something is done: a progress checkpoint, or an Output claim. */
  readonly claimed: boolean;
  /** There is something to look at, at the revision this card records. */
  readonly changed: boolean;
  /** A passing verification whose end snapshot is this card's revision. */
  readonly verifiedHere: boolean;
}

/**
 * How far the evidence goes, and no further. `claimed` is an agent's word for it;
 * `inspect-ready` means there is something a human could look at; `verified` means a
 * command Collie watched passed on *this* tree. A verification from a different revision
 * does not make this card verified — that is what `stale` is for.
 */
export function readiness(facts: ReadinessFacts): Card["readiness"] {
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

/**
 * Whether this is worth a human's attention, decided by rules over facts. There is no
 * input here a model writes: a narrative that sounds urgent changes nothing, which is the
 * point — significance is what decides whether something interrupts somebody.
 *
 * `decision` outranks `consequential` because a decision is the human being *waited on*,
 * and `consequential` is the human being told.
 */
export function significance(facts: SignificanceFacts): Card["significance"] {
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

/** How a verification stands against *this* card's revision. */
export function verificationOn(
  verification: Verification,
  revision: { readonly head_sha: string; readonly fingerprint: string },
): Card["verifications"][number] {
  const here =
    verification.end.head_sha === revision.head_sha &&
    verification.end.fingerprint === revision.fingerprint;
  return {
    id: verification.id,
    name: verification.name,
    result: here ? verification.result : "stale",
    ref: verification.id,
  };
}

/**
 * What to look at, and how — as text, never as something Collie will run. An `inspect`
 * entry is a suggestion for a human's own shell; a card that executed its own suggestions
 * would be a card that changed what it was describing.
 */
export function inspectFor(options: {
  readonly worktree: string | null;
  readonly base: string;
  readonly mr: string | null;
}): Card["inspect"] {
  const entries: Card["inspect"][number][] = [];
  if (options.worktree !== null)
    entries.push({
      what: "what changed",
      how: `git -C ${options.worktree} diff ${options.base}..HEAD`,
      note: "the whole change, as it stands",
    });
  if (options.mr !== null)
    entries.push({
      what: "the merge request",
      how: `glab mr view ${options.mr}`,
      note: "what the reviewers will read",
    });
  return entries;
}

/** A card's own text, with anything credential-shaped taken out before it is written. */
export function clean(card: Card): Card {
  return {
    ...card,
    claims: card.claims.map((claim) => ({ ...claim, text: redact(claim.text) })),
    missing: card.missing.map(redact),
    narrative: card.narrative === null ? null : redact(card.narrative),
  };
}

/**
 * The facts a card is built from, gathered from the Run's own records and its tree.
 * Everything here is something already written down: a card is a view of the evidence, so
 * anything it says that nothing else recorded would be a claim nobody can check.
 */
export interface CardSources {
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

/**
 * One card. Assembled rather than described: `readiness` and `significance` are computed
 * from the facts above, so a caller cannot hand in a card that says it is verified when
 * nothing verified it.
 */
export function buildCard(sources: CardSources): Card {
  const verifications = sources.verifications.map((entry) =>
    verificationOn(entry, sources.revision),
  );
  const ready = readiness({
    claimed: sources.claims.length > 0,
    changed: sources.changes.files.length > 0 || sources.revision.dirty,
    verifiedHere: verifications.some((entry) => entry.result === "pass"),
  });
  return clean({
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

/**
 * What an implementer says it has done, mid-step. Its own claims, labelled as claims: the
 * point of a checkpoint is that a human sees a slice land before the whole step is over,
 * and the point of the label is that seeing it is not the same as it being true.
 */
const CheckpointSchema = Schema.Struct({
  ticket: Schema.String,
  status: Schema.Literals(["started", "done"]),
  claims: Schema.Array(Schema.String),
  at: Schema.String,
});
export type Checkpoint = Schema.Schema.Type<typeof CheckpointSchema>;
const CheckpointJson = Schema.fromJsonString(CheckpointSchema);
/** The file as the engine writes one for a slice, in the shape an agent's own is read in. */
export const encodeCheckpoint = Schema.encodeSync(CheckpointJson);

export const readCheckpoints = Effect.fn("Cards.readCheckpoints")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(runDir, "steering", "progress");
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
  const found: Array<{ file: string; checkpoint: Checkpoint }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
    const decoded = Schema.decodeUnknownOption(CheckpointJson)(raw);
    if (decoded._tag === "Some") found.push({ file, checkpoint: decoded.value });
  }
  return found;
});
