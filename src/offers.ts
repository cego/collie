// What a finished Run offers to do next.
//
// Every offer is the workflow's own declaration, and every answer about whether to show
// one comes from facts the Run left behind: a branch, a merge request, tickets, how it
// ended, and whether anybody has said what became of it. Nothing here reads a workflow's
// name, so a fork that renames the shipped ones keeps what its Runs offer and a workflow
// nobody shipped earns the same offers on the same facts.
//
// Eligibility is the author's own function and is called here rather than remembered: an
// offer is decided again at the moment it is invoked, because the facts move and so does
// the code that declared it.

import type { ActionFacts } from "./sdk";
import type { Schema } from "effect";

/** A workflow an offer starts that is the one declaring it, whatever that is called. */
export const SELF = "";

/** What a workflow declares it offers, whichever kind of workflow declared it. */
export interface Declared {
  readonly id: string;
  readonly title: string;
  /** The workflow it starts, by public id; `SELF` is the one that declared it. */
  readonly workflow: string;
  /** What it passes, drawn for a front door to ask for. Null where it takes nothing. */
  readonly arguments: Schema.Json | null;
  /** A follow-up is hidden once somebody has said what became of the work; an action is not. */
  readonly kind: "action" | "follow-up";
  readonly eligible: (facts: ActionFacts) => boolean;
  /** The inputs Collie fills from the Run: input name to the fact it comes from. */
  readonly inputs: Readonly<Record<string, Source>>;
}

/** One offer as a front door shows it. */
export interface Offer {
  readonly id: string;
  readonly title: string;
  readonly workflow: string;
  readonly arguments: Schema.Json | null;
  readonly kind: Declared["kind"];
  /** What Collie fills in from the Run, so a front door asks only for the rest. */
  readonly inputs: Readonly<Record<string, Source>>;
  /** The first eligible one, which a front door may present as the obvious thing to do. */
  readonly primary: boolean;
  /** Why this offer cannot be made, where it is listed at all. */
  readonly unavailable: string | null;
}

export interface OfferOptions {
  /** The workflow that declared these, for an offer that starts the same one again. */
  readonly self?: string;
  /** Keep the ones that cannot be offered, with the reason, rather than leaving them out. */
  readonly keepUnavailable?: boolean;
  /** Why an offer cannot be made for a reason its facts do not carry, by offer id. */
  readonly refused?: ReadonlyMap<string, string>;
}

/**
 * What this Run offers now. A disposition hides the follow-ups — work somebody has
 * already said what became of is not work to carry on from — and leaves the actions to
 * their own facts, which are given the disposition too.
 */
export function offersFrom(
  declared: ReadonlyArray<Declared>,
  facts: ActionFacts,
  options: OfferOptions = {},
): Offer[] {
  const offers: Offer[] = [];
  for (const one of declared) {
    if (one.kind === "follow-up" && facts.disposed) continue;
    const unavailable = refusal(one, facts) ?? options.refused?.get(one.id) ?? null;
    if (unavailable !== null && options.keepUnavailable !== true) continue;
    offers.push({
      id: one.id,
      title: one.title,
      workflow: one.workflow === SELF ? (options.self ?? SELF) : one.workflow,
      arguments: one.arguments,
      kind: one.kind,
      inputs: one.inputs,
      primary: false,
      unavailable,
    });
  }
  const first = offers.findIndex((one) => one.unavailable === null);
  return offers.map((one, at) => (at === first ? { ...one, primary: true } : one));
}

/**
 * Why this offer cannot be made, or null when it can. An eligibility function is the
 * author's code: one that throws takes its own offer off the card rather than the whole
 * card off the board.
 */
function refusal(offer: Declared, facts: ActionFacts): string | null {
  try {
    return offer.eligible(facts) ? null : "its conditions are not met";
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * The facts a declared offer may require, and what each one means. A closed list on
 * purpose: an offer says which fact it needs, and nothing here reads an expression.
 */
export const NEEDS = {
  findings: "a finding it left open for somebody to fix",
  "diff-target": "something it was pointed at",
  branch: "a branch of its own",
  "merge-request": "a merge request it opened or was given",
  plan: "tickets it wrote",
  succeeded: "having finished the work",
} as const;
export type Need = keyof typeof NEEDS;
/**
 * What an offer passes to the workflow it starts, by where the value comes from. Also a
 * closed list: Collie fills these from the Run, and anything else is the caller's to give.
 */
export const SOURCES = {
  "run-dir": "the Run's own directory, which holds what it wrote",
  "plan-dir": "the plan directory inside it, where its tickets are",
  "diff-target": "what this Run was pointed at",
  branch: "the branch its checkout is on",
  "merge-request": "the merge request it opened or was given",
  "started-with": "what the Run was started with for the same input",
} as const;
export type Source = keyof typeof SOURCES;
export const SOURCE_NAMES: ReadonlyArray<Source> = [
  "run-dir",
  "plan-dir",
  "diff-target",
  "branch",
  "merge-request",
  "started-with",
];
export const isSource = (value: string): value is Source => value in SOURCES;

/** One offer as a workflow declares it, in the words a definition writes. */
export interface OfferDef {
  id: string;
  title: string;
  /** A public workflow id, or `self` for the one declaring it. */
  workflow: string;
  kind: Declared["kind"];
  /** Every fact this offer needs; all of them, or it is not offered. */
  needs: ReadonlyArray<Need>;
  /** The inputs Collie fills from the Run: input name to the fact it comes from. */
  inputs: Readonly<Record<string, Source>>;
}

/**
 * The facts an offer is decided from. The same facts a module's own action reads: what a
 * declared `needs:` asks about and what an author's `eligible` is given are one list, so
 * a definition and a module offer on the same evidence.
 */
export type OfferFacts = ActionFacts;

/**
 * Whether one fact is there. A caller that has no record of a fact at all answers no to
 * it: an offer is made on what is known, never on what is missing.
 */
const met = (need: Need, facts: ActionFacts): boolean => {
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

/** A definition's declared offers, as offers. The needs are the eligibility. */
export function declaredIn(offers: ReadonlyArray<OfferDef>): Declared[] {
  return offers.map((one) => ({
    id: one.id,
    title: one.title,
    workflow: one.workflow,
    arguments: null,
    kind: one.kind,
    inputs: one.inputs,
    eligible: (facts) => one.needs.every((need) => met(need, facts)),
  }));
}

/** What an offer passes, filled from the Run it is being made about. */
export function inputsFor(
  offer: { readonly inputs: Readonly<Record<string, Source>> },
  from: {
    readonly runDir: string;
    readonly facts: OfferFacts;
    readonly input: Readonly<Record<string, Schema.Json>>;
  },
) {
  /** Undefined where there is nothing to pass; a null the Run was started with is a value. */
  const value = (source: Source, name: string): Schema.Json | undefined => {
    switch (source) {
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
  for (const [name, source] of Object.entries(offer.inputs)) {
    const filled = value(source, name);
    if (filled !== undefined) given[name] = filled;
  }
  return given;
}
