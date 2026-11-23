// WARNING: nothing here reads a workflow's name, so a fork renaming the shipped ones keeps the same offers.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { ActionFacts, OfferGiven, Ships } from "./sdk";
import { Schema, type Types } from "effect";
import type { ConnectionId } from "./connection-model";

export const SELF = "";

export interface Declared {
  readonly entry?: ((facts: ActionFacts) => string) | undefined;
  readonly connections?: ReadonlyArray<ConnectionId>;
  readonly id: string;
  readonly title: string;
  readonly workflow: string;
  readonly arguments: Schema.Json | null;
  readonly kind: "action" | "follow-up";
  readonly eligible: (facts: ActionFacts) => boolean;
  readonly inputs: Readonly<Record<string, Source>>;
  readonly given?: OfferGiven | undefined;
  readonly ships?: Ships | undefined;
  readonly confirm?: string | undefined;
}

export interface Offer {
  readonly textField?: string;
  readonly id: string;
  readonly title: string;
  readonly workflow: string;
  readonly arguments: Schema.Json | null;
  readonly kind: Declared["kind"];
  readonly inputs: Readonly<Record<string, Source>>;
  readonly given?: OfferGiven;
  readonly ships?: Ships;
  readonly confirm?: string;
  readonly primary: boolean;
  readonly unavailable: string | null;
}

export interface OfferOptions {
  readonly self?: string;
  readonly keepUnavailable?: boolean;
  readonly refused?: ReadonlyMap<string, string>;
}

export function offersFrom(
  declared: ReadonlyArray<Declared>,
  facts: ActionFacts,
  options: OfferOptions = {},
) {
  const offers: Offer[] = [];
  for (const one of declared) {
    const refused = options.refused?.get(one.id);
    if (
      one.kind === "follow-up" &&
      facts.disposed &&
      !(options.keepUnavailable === true && refused !== undefined)
    )
      continue;
    const unavailable = refused ?? refusal(one, facts);
    if (unavailable !== null && options.keepUnavailable !== true) continue;
    const offer: Types.Mutable<Offer> = {
      id: one.id,
      title: one.entry === undefined ? one.title : `${one.title} — ${one.entry(facts)}`,
      workflow: one.workflow === SELF ? (options.self ?? SELF) : one.workflow,
      arguments: one.arguments,
      kind: one.kind,
      inputs: one.inputs,
      primary: false,
      unavailable,
    };
    if (one.given !== undefined) offer.given = one.given;
    if (one.ships !== undefined) offer.ships = one.ships;
    if (one.confirm !== undefined) offer.confirm = one.confirm;
    offers.push(offer);
  }
  const first = Option.getOrElse(
    Arr.findFirstIndex(offers, (one) => one.unavailable === null),
    () => -1,
  );
  return Arr.map(offers, (one, at) => (at === first ? { ...one, primary: true } : one));
}

const asJsonRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const isNames = Schema.is(Schema.Array(Schema.String));

export function argumentsWithout(drawn: Schema.Json | null, names: ReadonlySet<string>) {
  const document = Option.getOrUndefined(asJsonRecord(drawn));
  const drawnProperties = Option.getOrUndefined(asJsonRecord(document?.properties));
  if (document === undefined || drawnProperties === undefined) return drawn;
  const properties = Rec.filter(drawnProperties, (_, name) => !names.has(name));
  if (Rec.isEmptyRecord(properties)) return null;
  const { required } = document;
  return isNames(required)
    ? { ...document, properties, required: Arr.filter(required, (name) => !names.has(name)) }
    : { ...document, properties };
}

// WARNING: a throwing eligibility takes only its own offer off the card.
function refusal(offer: Declared, facts: ActionFacts) {
  try {
    return offer.eligible(facts) ? null : "its conditions are not met";
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

// WARNING: a closed list on purpose: an offer names a fact and nothing here reads an expression.
export const NEEDS = {
  findings: "a finding it left open for somebody to fix",
  "diff-target": "something it was pointed at",
  branch: "a branch of its own",
  "merge-request": "a merge request it opened or was given",
  plan: "tickets it wrote",
  succeeded: "having finished the work",
} as const;
export type Need = keyof typeof NEEDS;
export const SOURCES = {
  "run-id": "the Run making the offer",
  "run-dir": "the Run's own directory, which holds what it wrote",
  "plan-dir": "the plan directory inside it, where its tickets are",
  "diff-target": "what this Run was pointed at",
  branch: "the branch its checkout is on",
  "merge-request": "the merge request it opened or was given",
  "started-with": "what the Run was started with for the same input",
} as const;
export type Source = keyof typeof SOURCES;
export const SOURCE_NAMES: ReadonlyArray<Source> = [
  "run-id",
  "run-dir",
  "plan-dir",
  "diff-target",
  "branch",
  "merge-request",
  "started-with",
];
export const isSource = (value: string): value is Source => value in SOURCES;

export interface OfferDef {
  id: string;
  title: string;
  workflow: string;
  kind: Declared["kind"];
  needs: ReadonlyArray<Need>;
  inputs: Readonly<Record<string, Source>>;
}

export type OfferFacts = ActionFacts;

// WARNING: a caller with no record of a fact answers no: an offer is made on what is known.
const met = (need: Need, facts: ActionFacts) => {
  switch (need) {
    case "findings":
      return facts.openFindings > 0;
    case "diff-target":
      return facts.diffTarget !== null;
    case "branch":
      return facts.branch !== null;
    case "merge-request":
      return facts.mrUrl !== null;
    case "plan":
      return facts.planIssues > 0;
    case "succeeded":
      return facts.succeeded;
  }
};

export function declaredIn(offers: ReadonlyArray<OfferDef>) {
  const returned: Declared[] = Arr.map(offers, (one) => ({
    id: one.id,
    title: one.title,
    workflow: one.workflow,
    arguments: null,
    kind: one.kind,
    inputs: one.inputs,
    eligible: (facts) => Arr.every(one.needs, (need) => met(need, facts)),
  }));
  return returned;
}

export function inputsFor(
  offer: {
    readonly inputs: Readonly<Record<string, Source>>;
    readonly given?: OfferGiven | undefined;
  },
  from: {
    readonly runId: string;
    readonly runDir: string;
    readonly facts: OfferFacts;
    readonly input: Readonly<Record<string, Schema.Json>>;
  },
) {
  // WARNING: undefined means nothing to pass; a null the Run was started with is a value.
  const value = (source: Source, name: string) => {
    switch (source) {
      case "run-id":
        return from.runId;
      case "run-dir":
        return from.runDir;
      case "plan-dir":
        return `${from.runDir}/plan`;
      case "diff-target":
        return from.facts.diffTarget ?? undefined;
      case "branch":
        return from.facts.branch ?? undefined;
      case "merge-request":
        return from.facts.mrUrl ?? undefined;
      case "started-with":
        return from.input[name];
    }
  };
  const given: Record<string, Schema.Json> = {};
  for (const [name, source] of Rec.toEntries(offer.inputs)) {
    const filled = value(source, name);
    if (filled !== undefined) given[name] = filled;
  }
  return { ...given, ...offer.given };
}

export function taskOffers<
  O extends {
    readonly primary: boolean;
    readonly unavailable: string | null;
    readonly title: string;
  },
>(
  asked: string,
  own: ReadonlyArray<O>,
  owned: ReadonlyArray<{
    readonly run: string;
    readonly named: string;
    readonly offers: ReadonlyArray<O>;
  }>,
) {
  const listed: Array<O & { readonly run?: string }> = [
    ...(Arr.some(owned, (one) => one.run === asked) ? [] : own),
    ...Arr.flatMap(owned, ({ run, named, offers }) =>
      Arr.map(offers, (offer) => {
        const titled = { ...offer, title: `${offer.title} ${named}` };
        return run === asked ? titled : { ...titled, run };
      }),
    ),
  ];
  const first = Arr.findFirstIndex(listed, (one) => one.unavailable === null);
  return Arr.map(listed, (one, at) => ({
    ...one,
    primary: Option.isSome(first) && at === first.value,
  }));
}
